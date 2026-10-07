/* =====================================================================
   PROJECT EXPENSE MONITORING
   Single-file React app. Runs in two modes:
   - Demo mode (no Supabase keys): sample data only, resets on reload.
   - Live mode: fill CONFIG below with your Supabase URL and anon key,
     and run supabase_schema.sql in your Supabase project first.
   ===================================================================== */
import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, createContext, useContext } from "react";
import { createClient } from "@supabase/supabase-js";

/* ---------------------------------------------------------------------
   1. CONFIG
   The anon key is safe in the browser: every table is protected by Row
   Level Security and every request change runs through checked SQL
   functions. Never put the service_role key here.
   --------------------------------------------------------------------- */
const CONFIG = {
  // Filled from .env by src/env.js (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ...).
  // The values here are only the defaults used when nothing is set.
  supabaseUrl: "",       // e.g. "https://abcdxyz.supabase.co"
  supabaseAnonKey: "",   // Supabase → Project Settings → API → anon public key
  // Optional company email domain, e.g. "example.com.ph". When set, people sign in
  // with just their username (the part before @); a full email always works too.
  usernameDomain: "",
  // Offer "Try the demo" on the sign-in page beside the live sign-in form.
  demoEnabled: true,
  // Cloudflare Turnstile site key. Empty until captcha is switched on in Supabase (Auth → Attack protection).
  captchaSiteKey: "",
  vapidPublicKey: "", // public push key (VITE_VAPID_PUBLIC_KEY); empty = notifications are not offered
  // Excel export (loaded only when someone exports). Pinned version with an integrity
  // check: the browser refuses the file if it ever differs from this exact release.
  excelJsUrl: "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
  excelJsIntegrity: "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz",
  ...(typeof globalThis !== "undefined" && globalThis.OE_CONFIG ? globalThis.OE_CONFIG : {}),
};
const LIVE = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
// Without keys the demo is the only mode; with keys it is an option on the sign-in page unless switched off.
const DEMO_ENABLED = !LIVE || CONFIG.demoEnabled !== false;
const INITIAL_HASH = typeof window !== "undefined" ? window.location.hash : "";
const NEEDS_PASSWORD = /type=(invite|recovery)/.test(INITIAL_HASH);
/** The set-password page's own address. Invite emails return here (vercel.json rewrites it to the app). */
const INVITE_PATH = "/invite/set-password";
const INITIAL_PATH = typeof window !== "undefined" ? window.location.pathname : "/";
/** The choose-a-new-password page ("Forgot password?"). Reset emails return here (vercel.json rewrites it to the app). */
const RESET_PATH = "/reset-password";
const RESET_FLOW = /type=recovery/.test(INITIAL_HASH) || INITIAL_PATH === RESET_PATH;
/** The sign-in page's address. Each module has its own address too (see NAV). */
const SIGNIN_PATH = "/sign-in";
/* This tab is only here to set a password. Its session is kept in memory and never written to the browser's
   storage, so it cannot replace or sign out an administrator who is signed in on the same computer. When it is
   finished it reloads the sign-in page, which uses the normal, persistent session again. */
const INVITE_TAB = INITIAL_PATH === INVITE_PATH || INITIAL_PATH === RESET_PATH || NEEDS_PASSWORD; // the invite or reset tab
const NOTICE_KEY = "oe-signin-notice"; // sessionStorage (this tab only): message for the sign-in page after a reload
const handoffToSignIn = (notice) => {
  try {
    if (notice) sessionStorage.setItem(NOTICE_KEY, JSON.stringify(notice));
  } catch (e) {
    /* storage blocked: the sign-in page simply shows no message */
  }
  window.location.replace(SIGNIN_PATH + window.location.search);
};
const takeSignInNotice = () => {
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY);
    if (raw) sessionStorage.removeItem(NOTICE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};
// Supabase returns here with #error=...&error_code=otp_expired when an invite link is opened a second time or too late.
const LINK_ERROR = /(^#|&)error=/.test(INITIAL_HASH) ? ((INITIAL_HASH.match(/error_code=([^&]*)/) || [])[1] || "error") : "";

/* ---------------------------------------------------------------------
   2. CONSTANTS
   --------------------------------------------------------------------- */
/** Only these roles may record a fund return, whatever the permission settings say (the database checks the same). */
const RETURN_ROLES = ["admin", "tm", "accounting"];

const PERMISSIONS = [
  { key: "report.view", label: "Project report", group: "Monitoring" },
  { key: "thresholds.view", label: "See limits and balances while filing", group: "Monitoring" },
  { key: "projects.view", label: "View project listing", group: "Projects" },
  { key: "projects.edit", label: "Add and edit projects", group: "Projects" },
  { key: "allocations.edit", label: "Set project allocations", group: "Projects" },
  { key: "requests.create", label: "File new requests", group: "Requests" },
  { key: "requests.view_own", label: "Request list: own requests", group: "Requests" },
  { key: "requests.view_all", label: "Request list: all requests", group: "Requests" },
  { key: "requests.approve", label: "Approve or reject requests", group: "Workflow" },
  { key: "requests.erp_ref", label: "Enter ERP reference", group: "Workflow" },
  { key: "requests.disburse", label: "Mark fund as disbursed", group: "Workflow" },
  { key: "requests.pay", label: "Mark lines as paid to client", group: "Workflow" },
  { key: "requests.verify_acct", label: "Verify paid lines as accounting", group: "Workflow" },
  { key: "requests.verify_tm", label: "Verify paid lines as top management", group: "Workflow" },
  { key: "requests.reclassify", label: "Reclassify lines from internal projects", group: "Workflow" },
  { key: "requests.return", label: "Record fund returns on disbursed lines", group: "Workflow", roles: RETURN_ROLES },
  { key: "analysis.view", label: "Analysis (e.g. days from disbursement to client)", group: "Monitoring" },
  { key: "settings.expenses", label: "Expense categories, types and rates", group: "Settings" },
  { key: "settings.users", label: "Users, access rights and system settings", group: "Settings" },
];
const ALL_PERMS = PERMISSIONS.map((p) => p.key);

const STATUS = {
  on_hold: { label: "For approval", tone: "amber", hint: "Waiting for top management approval" },
  open: { label: "Open", tone: "teal", hint: "Approved; to be filed in Acumatica" },
  partially_paid: { label: "Partially paid", tone: "leaf", hint: "Some lines already given to the client, others not yet" },
  disbursed: { label: "Disbursed", tone: "blue", hint: "Fund released by accounting" },
  paid: { label: "Paid", tone: "green", hint: "Fund given to client" },
  closed: { label: "Closed", tone: "slate", hint: "Verified by top management and accounting" },
  reclassified: { label: "Reclassified", tone: "violet", hint: "Closed; the amount filed under an internal project has been split to specific projects" },
  rejected: { label: "Rejected", tone: "red", hint: "Not approved" },
  cancelled: { label: "Withdrawn", tone: "muted", hint: "Withdrawn by the liaison" },
  declined: { label: "Not approved", tone: "muted", hint: "Line set to zero at approval" },
  part_paid: { label: "Partly paid", tone: "leaf", hint: "Part given to the client; accounting records the return of the rest" },
  returned: { label: "Returned", tone: "muted", hint: "Fund returned after disbursement; no longer counted in the project report" },
};

const CALC_METHODS = {
  manual: "Manual amount",
  contract_pct: "% of contract value",
  collection_pct: "% of net collection",
};

const STATUS_GROUPS = ["Ongoing", "Completed / Closeout", "Suspended", "Not yet awarded / Bidding", "Internal"];

const DEFAULT_SETTINGS = {
  ref_prefix: "REQ",
  close_policy: "either",
  near_limit_pct: 90,
  idle_minutes: 30,
  form_title: "Special Request Payment Form",
};

/* ---------------------------------------------------------------------
   3. UTILITIES
   --------------------------------------------------------------------- */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
const norm = (s) => (s == null ? "" : String(s)).trim().toLowerCase();
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

const money = (n) =>
  n == null || isNaN(Number(n))
    ? "—"
    : (Number(n) < -0.004 ? "−₱" : "₱") + Math.abs(Number(n)).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const compact = (n) => {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  const s = v < -0.004 ? "−₱" : "₱";
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : 2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return s + Math.round(a).toLocaleString("en-PH");
};

const pct = (n, d = 0) => (n == null || !isFinite(n) ? "—" : (n * 100).toFixed(d) + "%");

const toDate = (d) => (!d ? null : new Date(String(d).length === 10 ? d + "T00:00:00" : d));
const fmtDate = (d) =>
  !d ? "—" : toDate(d).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
const fmtDateTime = (d) =>
  !d
    ? "—"
    : toDate(d).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const daysAgoISO = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  } catch (e) {
    /* fall through */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  return Promise.resolve();
}

/** Demo mode only: each demo password is the username followed by 123 (e.g. patrick123). */
const demoPassword = (username) => `${username}123`;

/** Username → sign-in email. "paolo" becomes "paolo@<usernameDomain>"; a full email is used as typed. */
function loginEmail(id) {
  const v = String(id || "").trim().toLowerCase();
  if (!v) return "";
  if (v.includes("@")) return v;
  const domain = String(CONFIG.usernameDomain || "").trim().replace(/^@/, "");
  return domain ? `${v}@${domain}` : "";
}

/* Supporting documents: PDF and images, so approvers can view them in the browser. */
const DOC_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const DOC_ACCEPT = DOC_TYPES.join(",");
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const fmtSize = (n) => (n == null ? "" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function checkDocFile(file) {
  if (!DOC_TYPES.includes(file.type)) return `${file.name}: use a PDF, JPG, PNG or WebP file.`;
  if (file.size > DOC_MAX_BYTES) return `${file.name} is over 10 MB.`;
  return null;
}
/** Demo only: a simple image standing in for a scanned supporting document. */
function sampleDocUrl(title, lines) {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const body = lines.map((t, i) => `<text x="60" y="${250 + i * 44}" font-size="26" fill="#334">${esc(t)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1100" viewBox="0 0 850 1100"><rect width="850" height="1100" fill="#fff"/><rect x="40" y="40" width="770" height="1020" fill="none" stroke="#9aa" stroke-width="2"/><text x="60" y="130" font-size="40" font-weight="700" fill="#002c46">${esc(title)}</text><text x="60" y="180" font-size="22" fill="#789">Sample document for the demo</text>${body}</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/** data: URL → Blob without a network fetch (the Content Security Policy doesn't allow fetching data: URLs). */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = meta.split(";")[0] || "application/octet-stream";
  if (/;base64$/i.test(meta)) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("That file couldn't be read."));
    r.readAsDataURL(file);
  });
}

async function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = "\ufeff" + rows.map((r) => r.map(esc).join(",")).join("\n");
  await saveFile(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

/** Hands a generated file to the browser (or, inside a published claude.ai page, to the viewer's save prompt). */
async function saveFile(filename, blob) {
  const host = typeof window !== "undefined" && window.claude && typeof window.claude.use === "function" ? window.claude : null;
  if (host) {
    const dl = await host.use("downloads").catch(() => null);
    if (dl) {
      try {
        await dl.save({ filename, data: blob });
      } catch (e) {
        if (e && e.code === "declined") return; // the viewer said no
        throw new Error("The file couldn't be saved here. Try again, or open the app in its own tab.");
      }
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Loads the Excel library on first use (about 1 MB, so not part of the app itself). */
let excelJsPromise = null;
function loadExcelJS() {
  if (typeof window !== "undefined" && window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!excelJsPromise)
    excelJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = CONFIG.excelJsUrl;
      if (CONFIG.excelJsIntegrity) {
        s.integrity = CONFIG.excelJsIntegrity;
        s.crossOrigin = "anonymous";
      }
      s.async = true;
      s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("The Excel exporter didn't start. Reload the page and try again.")));
      s.onerror = () => {
        excelJsPromise = null;
        s.remove();
        reject(new Error("The Excel exporter couldn't be loaded. Check the internet connection and try again."));
      };
      document.head.appendChild(s);
    });
  return excelJsPromise;
}

/* ---------------------------------------------------------------------
   4. DOMAIN LOGIC
   --------------------------------------------------------------------- */
const contractBase = (p) =>
  Number((p && (p.contract_value || p.revised_contract || p.bid_amount || p.abc_amount)) || 0);

function buildIndex(data) {
  const byId = (arr) => new Map(arr.map((x) => [x.id, x]));
  const categories = [...data.categories].sort((a, b) => a.sort_order - b.sort_order);
  const types = [...data.types].sort((a, b) => a.sort_order - b.sort_order);
  const typesByCat = new Map(categories.map((c) => [c.id, []]));
  for (const t of types) (typesByCat.get(t.category_id) || typesByCat.set(t.category_id, []).get(t.category_id)).push(t);
  return {
    closePolicy: (data.settings && data.settings.close_policy) || "either",
    categories,
    types,
    typesByCat,
    projects: byId(data.projects),
    cats: byId(data.categories),
    typesById: byId(data.types),
    acuById: byId(data.acumaticaItems || []),
    profiles: byId(data.profiles),
    rateMap: new Map(data.districtRates.map((r) => [norm(r.district) + "|" + r.type_id, Number(r.rate)])),
    allocMap: new Map(data.allocations.map((a) => [a.project_id + "|" + a.type_id, Number(a.amount)])),
    usageMap: new Map(data.usage.map((u) => [u.project_id + "|" + u.type_id, u])),
    districts: [...new Set(data.projects.map((p) => p.district).filter(Boolean))].sort(),
    years: [...new Set(data.projects.map((p) => p.year).filter(Boolean))].sort((a, b) => b - a),
  };
}

function effectiveRate(project, type, idx) {
  if (!project || !type) return null;
  const dr = project.district ? idx.rateMap.get(norm(project.district) + "|" + type.id) : undefined;
  if (dr != null) return dr;
  return type.rate != null ? Number(type.rate) : null;
}

/** Default allocation (ignores the project override). */
function defaultAllocation(project, type, idx) {
  if (!project || !type || project.is_internal) return { amount: 0, source: "none" };
  const rate = effectiveRate(project, type, idx);
  const base = contractBase(project);
  if (rate && base) return { amount: round2((base * rate) / 100), source: "rate", rate };
  if (type.alloc_fixed) return { amount: Number(type.alloc_fixed), source: "fixed" };
  return { amount: 0, source: "none" };
}

function allocationFor(project, type, idx) {
  if (!project || !type) return { amount: 0, source: "none" };
  const key = project.id + "|" + type.id;
  if (idx.allocMap.has(key)) return { amount: idx.allocMap.get(key), source: "override" };
  return defaultAllocation(project, type, idx);
}

function allocationHint(a) {
  if (a.source === "override") return "Set for this project";
  if (a.source === "rate") return `${a.rate}% of contract`;
  if (a.source === "fixed") return "Default fixed amount";
  return "No allocation set";
}

const EMPTY_USAGE = { pending: 0, open: 0, disbursed: 0, paid: 0, closed: 0 };
const usageFor = (projectId, typeId, idx) => idx.usageMap.get(projectId + "|" + typeId) || EMPTY_USAGE;
const usedOf = (u) => Number(u.open) + Number(u.disbursed) + Number(u.paid) + Number(u.closed);

/** Client-side aggregation; the live database does the same in oe_usage_summary(). */
function aggregateUsage(requests) {
  const m = new Map();
  const add = (projectId, typeId, bucket, amount) => {
    const key = projectId + "|" + typeId;
    let u = m.get(key);
    if (!u) m.set(key, (u = { project_id: projectId, type_id: typeId, pending: 0, open: 0, disbursed: 0, paid: 0, closed: 0 }));
    u[bucket] += amount;
  };
  for (const r of requests)
    for (const l of r.lines) {
      if (l.status === "on_hold") {
        add(l.project_id, l.type_id, "pending", Number(l.amount));
        continue;
      }
      if (!["open", "disbursed", "part_paid", "paid", "closed"].includes(l.status)) continue;
      // returned money is not counted; a partly paid line's paid part is "paid", the rest is still "disbursed"
      const bucket = l.status === "part_paid" ? "paid" : l.status;
      if (l.status === "part_paid") {
        add(l.project_id, l.type_id, "paid", linePaid(l));
        add(l.project_id, l.type_id, "disbursed", round2(lineNet(l) - linePaid(l)));
      } else add(l.project_id, l.type_id, bucket, lineNet(l));
      // reclassified parts count on the specific project and come off the internal one
      for (const x of l.reclass || []) {
        add(x.project_id, l.type_id, bucket, Number(x.amount));
        add(l.project_id, l.type_id, bucket, -Number(x.amount));
      }
    }
  return [...m.values()];
}

/* Money on a line once approved: paid to the client + returned + still with the liaison. */
const lineApproved = (l) => Number(l.approved_amount ?? l.amount);
const lineReturned = (l) => Number(l.returned_amount || 0);
/** What counts in the project report: returned money doesn't. */
const lineNet = (l) => round2(lineApproved(l) - lineReturned(l));
const linePaid = (l) => (l.paid_amount != null ? Number(l.paid_amount) : ["paid", "closed"].includes(l.status) ? lineNet(l) : 0);
/** Still in the liaison's hands (to give to the client, or to return). */
const lineWithLiaison = (l) => (["disbursed", "part_paid"].includes(l.status) ? round2(lineNet(l) - linePaid(l)) : 0);

/** A request as it stood before an edit, kept on the "edited" history entry so approvers can see what changed
 *  (the database's oe_request_snapshot() builds the same shape). */
const requestSnapshot = (r) => ({
  request_date: r.request_date, date_needed: r.date_needed, remarks: r.remarks,
  approved_by_name: r.approved_by_name, approved_at: r.approved_at, approval_remarks: r.approval_remarks, erp_ref: r.erp_ref,
  lines: r.lines.map((l) => ({
    id: l.id, line_no: l.line_no, project_id: l.project_id, type_id: l.type_id, description: l.description, payee: l.payee, detail: l.detail,
    basis_amount: l.basis_amount, basis_pct: l.basis_pct, rate: l.rate, amount: l.amount, approved_amount: l.approved_amount,
    documents: (l.documents || []).map((d) => ({ id: d.id, file_name: d.file_name })),
  })),
});

/** Amount of a line still on the project it was filed under (after any reclassification). */
const reclassRemaining = (l) => round2(lineNet(l) - (l.reclass || []).reduce((a, x) => a + Number(x.amount), 0));

function classify(alloc, after, nearPct) {
  if (alloc <= 0) return after > 0 ? "none" : "ok";
  if (after > alloc + 0.004) return "over";
  if (after >= (alloc * nearPct) / 100) return "near";
  return "ok";
}

const LIMIT_LABEL = { ok: "Within limit", near: "Near limit", over: "Exceeds limit", none: "No allocation" };
const LIMIT_TONE = { ok: "teal", near: "amber", over: "red", none: "amber" };

/**
 * Threshold check for a set of request lines. Lines with the same project and
 * type are counted cumulatively. `ownPending` removes this request's own
 * on-hold amounts from the "other pending" figure during approval.
 */
function checkLines(lines, idx, settings, ownPending = false, exclude = null) {
  const running = new Map();
  const selfPending = new Map();
  // exclude: the original lines of a request being edited, so they aren't counted twice
  // ({used: true} = counted as approved to date, otherwise as pending approval)
  const selfUsed = new Map();
  for (const x of exclude || []) {
    const k = x.project_id + "|" + x.type_id;
    const m = x.used ? selfUsed : selfPending;
    m.set(k, (m.get(k) || 0) + (Number(x.amount) || 0));
  }
  if (ownPending)
    for (const l of lines)
      if (l.project_id && l.type_id) {
        const k = l.project_id + "|" + l.type_id;
        selfPending.set(k, (selfPending.get(k) || 0) + (Number(l.requested) || 0));
      }
  return lines.map((l) => {
    const project = idx.projects.get(l.project_id);
    const type = idx.typesById.get(l.type_id);
    if (!project || !type) return null;
    const key = project.id + "|" + type.id;
    const alloc = allocationFor(project, type, idx);
    const u = usageFor(project.id, type.id, idx);
    const used = Math.max(0, usedOf(u) - (selfUsed.get(key) || 0));
    const otherPending = Math.max(0, Number(u.pending) - (selfPending.get(key) || 0));
    const prior = running.get(key) || 0;
    const amount = Number(l.amount) || 0;
    // committed = approved to date + other requests still waiting for approval + earlier lines of this request
    const after = used + otherPending + prior + amount;
    running.set(key, prior + amount);
    return {
      alloc,
      used,
      otherPending,
      prior,
      after,
      balanceAfter: alloc.amount - after,
      state: classify(alloc.amount, after, Number(settings.near_limit_pct) || 90),
    };
  });
}

/** Totals per category and type for one project. */
function projectSummary(project, idx) {
  const byType = new Map();
  const byCat = new Map();
  const total = { alloc: 0, used: 0, pending: 0 };
  for (const c of idx.categories) {
    const cs = { alloc: 0, used: 0, pending: 0, open: 0, disbursed: 0, paid: 0, closed: 0 };
    for (const t of idx.typesByCat.get(c.id) || []) {
      const alloc = allocationFor(project, t, idx);
      const u = usageFor(project.id, t.id, idx);
      const used = usedOf(u);
      byType.set(t.id, { alloc, u, used, pending: Number(u.pending) });
      cs.alloc += alloc.amount;
      cs.used += used;
      cs.pending += Number(u.pending);
      for (const k of ["open", "disbursed", "paid", "closed"]) cs[k] += Number(u[k]);
    }
    byCat.set(c.id, cs);
    total.alloc += cs.alloc;
    total.used += cs.used;
    total.pending += cs.pending;
  }
  return { byType, byCat, total };
}

const reqTotal = (r) =>
  r.lines.reduce(
    (s, l) =>
      s +
      (["on_hold", "rejected", "cancelled"].includes(l.status)
        ? Number(l.amount)
        : l.status === "declined" || (l.status === "returned" && r.status !== "returned")
          ? 0
          : l.status === "returned"
            ? lineApproved(l) // a request that came back in full shows what was returned
            : lineNet(l)),
    0
  );
const reqRequested = (r) => r.lines.reduce((s, l) => s + Number(l.amount), 0);
const liveLines = (r) => r.lines.filter((l) => !["declined", "rejected", "cancelled", "returned"].includes(l.status));

/** What happens next, and whether the signed-in user is the one to do it. */
/** For a request with lines filed under an internal project (FOR-ASSIGNMENT, ADVANCES):
    how much of those lines is still unassigned. Null when there are none. */
function reclassState(r, idx) {
  if (!idx) return null;
  const lines = r.lines.filter((l) => ["disbursed", "part_paid", "paid", "closed"].includes(l.status) && (idx.projects.get(l.project_id) || {}).is_internal);
  if (!lines.length) return null;
  const total = lines.reduce((a, l) => a + lineNet(l), 0);
  const assigned = lines.reduce((a, l) => a + (l.reclass || []).reduce((b, x) => b + Number(x.amount), 0), 0);
  const remaining = round2(total - assigned);
  return { total, assigned, remaining, hasSplit: assigned > 0.004, complete: remaining <= 0.004 };
}

/** Status shown to people: a closed request whose internal-project amount has been split reads "Reclassified". */
function displayStatus(r, idx) {
  if (r.status === "disbursed") {
    // some lines already given to the client, others not yet
    const lines = liveLines(r);
    const given = lines.filter((l) => ["part_paid", "paid", "closed"].includes(l.status)).length;
    const done = lines.filter((l) => l.status === "paid" || l.status === "closed").length;
    return given > 0 && done < lines.length ? "partially_paid" : "disbursed";
  }
  if (r.status !== "closed") return r.status;
  const st = reclassState(r, idx);
  return st && st.hasSplit ? "reclassified" : "closed";
}

/** Date the request entered the status it shows now (resets with every status change).
    Final statuses (closed, rejected, withdrawn) don't count days. */
function statusSince(r, shown) {
  const lines = liveLines(r);
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  const pick = (values, first) => {
    const xs = values.filter(Boolean).sort();
    return xs.length ? (first ? xs[0] : xs[xs.length - 1]) : null;
  };
  switch (shown) {
    case "on_hold":
      return day(r.created_at) || r.request_date;
    case "open":
      return day(r.approved_at);
    case "disbursed":
      return r.disbursed_date || day(r.disbursed_at);
    case "partially_paid": // first line given to the client
      return pick(lines.map((l) => l.paid_date), true);
    case "paid": // last line given to the client
      return pick(lines.map((l) => l.paid_date), false);
    case "reclassified":
      return pick(lines.flatMap((l) => (l.reclass || []).map((x) => day(x.created_at))), true);
    default:
      return null;
  }
}

/** Whole days since a YYYY-MM-DD date, never negative. */
const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.parse(todayISO() + "T00:00:00") - Date.parse(String(iso).slice(0, 10) + "T00:00:00")) / 86400000)) : null);
const daysLabel = (n) => (n == null ? "" : n === 0 ? "today" : `${n} ${n === 1 ? "day" : "days"}`);

function nextStep(r, me, can, idx = null) {
  const own = r.liaison_id === me.id;
  const lines = liveLines(r);
  const toPay = lines.filter((l) => l.status === "disbursed").length;
  const paidish = lines.filter((l) => l.status === "paid" || l.status === "closed").length;
  const needAcct = lines.some((l) => l.status === "paid" && !l.acct_verified_at);
  const needTm = lines.some((l) => l.status === "paid" && !l.tm_verified_at);
  // One verification (default): top management verifies, accounting is only the backup.
  const tmOnly = !idx || idx.closePolicy !== "both";
  const verifyMine = tmOnly ? can("requests.verify_tm") && needTm : (can("requests.verify_acct") && needAcct) || (can("requests.verify_tm") && needTm);
  const waitText = tmOnly ? "Waiting for top management verification" : "Waiting for verification";
  switch (r.status) {
    case "on_hold": {
      // approvers can't approve their own request, except administrators
      const mine = can("requests.approve") && (!own || me.role === "admin");
      return { text: mine ? "Review for approval" : "Waiting for approval", mine };
    }
    case "open":
      if (!r.erp_ref) return { text: "Enter ERP reference", mine: can("requests.erp_ref") && own };
      return { text: "Waiting for disbursement", mine: can("requests.disburse") };
    case "disbursed": {
      const payMine = can("requests.pay") && own && toPay > 0;
      const progress = `(${paidish} of ${lines.length} paid)`;
      // partly paid lines: the rest must come back to accounting
      const toReturn = round2(lines.filter((l) => l.status === "part_paid").reduce((a, l) => a + lineWithLiaison(l), 0));
      const returnMine = toReturn > 0 && can("requests.return") && RETURN_ROLES.includes(me.role) && (!own || me.role === "admin");
      if (payMine) return { text: `Give fund to client ${progress}`, mine: true };
      if (returnMine) return { text: `Record the return of ${compact(toReturn)}`, mine: true };
      if (verifyMine) return { text: `Verify paid lines ${progress}`, mine: true };
      if (toPay) return { text: `Give fund to client ${progress}`, mine: false };
      if (toReturn > 0) return { text: `Waiting for ${compact(toReturn)} to be returned`, mine: false };
      return { text: waitText, mine: false };
    }
    case "paid":
      return { text: waitText, mine: verifyMine };
    case "closed": {
      const st = reclassState(r, idx);
      if (!st) return { text: "Complete", mine: false };
      if (st.complete) return { text: "Complete reclassification", mine: false };
      const mine = can("requests.reclassify");
      if (!st.hasSplit) return { text: "For reclassification", mine };
      return { text: `Partially reclassified (${compact(st.remaining)} remaining)`, mine };
    }
    default:
      return { text: "No further action", mine: false };
  }
}

/* ---------------------------------------------------------------------
   5. DATA LAYER
   Both adapters expose the same async API so the UI does not care
   whether it is running on demo data or on Supabase.
   --------------------------------------------------------------------- */
function buildDemoDB() {
  const cats = ["Bidding", "Collection", "Support", "Inspection", "Testing"].map((name, i) => ({
    id: "c" + (i + 1),
    name,
    sort_order: i + 1,
    require_document: name === "Collection",
    is_active: true,
  }));
  const SOP = "6204 Representation Expenses - SOP";
  const typeRows = [
    ["t-bo", "c1", "Buy-out", "BO", "contract_pct", 2, null, "6033 Bidding Buy-Out", null],
    ["t-ppb", "c1", "Pre & Post Bidding", "PPB", "contract_pct", 2, null, "6032 Bidding Expense", null],
    ["t-pln", "c1", "Planning", "PLN", "contract_pct", 1, null, "6032 Bidding Expense", null],
    ["t-bd", "c1", "Bid Documents", "BD", "manual", null, 25000, "6031 Bidding Documents", null],
    ["t-de", "c2", "DE Share", "DE", "collection_pct", 3, null, SOP, null],
    ["t-cs", "c2", "Construction Share", "CS", "collection_pct", 1, null, SOP, null],
    ["t-ry", "c2", "Royalty", "RY", "manual", null, null, SOP, null],
    ["t-ab", "c3", "As-Built", "AB", "manual", null, null, SOP, null],
    ["t-as", "c3", "As-Stake", "AS", "manual", null, null, SOP, null],
    ["t-alw", "c3", "Allowance", "ALW", "manual", null, null, SOP, null],
    ["t-ins", "c3", "Insurance", "INS", "manual", null, null, "6100 Insurance/Bonds Expense", "Type of insurance"],
    ["t-cpes", "c3", "CPES", "CPES", "manual", null, null, SOP, null],
    ["t-dole", "c3", "DOLE", "DOLE", "manual", null, null, SOP, null],
    ["t-dit", "c3", "DIT", "DIT", "manual", null, null, SOP, null],
    ["t-bb", "c3", "Billboard", "BB", "manual", null, null, SOP, null],
    ["t-oth", "c3", "Others", "OTH", "manual", null, null, SOP, "Specify"],
    ["t-qau", "c4", "QAU", "QAU", "manual", null, null, SOP, null],
    ["t-mqc", "c5", "MQC", "MQC", "manual", null, null, SOP, null],
  ];
  const acumaticaItems = [
    ["OPGAE0031", "Coordination – Material Testing Fees"], ["OPGAE0025", "Coordination - External Agencies"],
    ["OPGAE0026", "Coordination - Local Offices"], ["OPGAE0027", "Coordination - Operation (External)"],
    ["OPGAE0028", "Coordination - Operation (Local)"], ["OPGAE0029", "Coordination – Planning Phase"],
    ["OPGAE0030", "Coordination – Construction Phase"], ["OPGAE0032", "Coordination – Project Initiation Phase"],
    ["OPGAE0033", "Coordination – Settlement Fees"], ["OPPRE0009", "Royalty Expense"], ["OPPRE0008", "Bidding Buy-Out"],
    ["OPPRE0007", "Bidding Expense"], ["OPPRE0006", "Bidding Documents"], ["OPGAE0007", "Insurance/Bonds Expense"],
  ].map(([inv_id, description], i) => ({ id: "acu-" + inv_id, inv_id, description, sort_order: i + 1 }));
  const acuMap = {
    "t-bo": "acu-OPPRE0008", "t-ppb": "acu-OPPRE0007", "t-pln": "acu-OPGAE0029", "t-bd": "acu-OPPRE0006",
    // test mappings until management confirms the rest (Settings, Expense categories and types)
    "t-de": "acu-OPGAE0025",
    "t-cs": "acu-OPGAE0030",
    "t-ry": "acu-OPPRE0009",
    "t-ab": "acu-OPGAE0033",
    "t-as": "acu-OPGAE0032",
    "t-alw": "acu-OPGAE0028",
    "t-ins": "acu-OPGAE0007",
    "t-cpes": "acu-OPGAE0027",
    "t-dole": "acu-OPGAE0025",
    "t-dit": "acu-OPGAE0025",
    "t-bb": "acu-OPGAE0030",
    "t-oth": "acu-OPGAE0028",
    "t-qau": "acu-OPGAE0031",
    "t-mqc": "acu-OPGAE0031",
  };
  const types = typeRows.map(([id, category_id, name, code, calc_method, rate, alloc_fixed, erp_account, detail_label], i) => ({
    id, category_id, name, code, calc_method, rate, alloc_fixed, erp_account, detail_label, sort_order: i + 1, is_active: true,
    acumatica_item_id: acuMap[id] || null,
  }));
  const districtRates = ["Cebu 1st", "Cebu 2nd", "Cebu City", "Region VII"].map((d, i) => ({
    id: "dr" + i, district: d, type_id: "t-ppb", rate: 1,
  }));
  const roles = [
    { role: "admin", label: "Administrator", permissions: [...ALL_PERMS], sort_order: 1 },
    { role: "tm", label: "Top management", sort_order: 2,
      permissions: ["projects.view", "allocations.edit", "report.view", "thresholds.view", "requests.view_all", "requests.approve", "requests.verify_tm", "requests.reclassify", "requests.return", "analysis.view"] },
    { role: "accounting", label: "Accounting", sort_order: 3,
      permissions: ["projects.view", "report.view", "thresholds.view", "requests.view_all", "requests.disburse", "requests.verify_acct", "requests.reclassify", "requests.return", "analysis.view"] },
    { role: "liaison", label: "Liaison", sort_order: 4, permissions: ["requests.create", "requests.view_own", "requests.erp_ref", "requests.pay"] },
    { role: "viewer", label: "Auditor (read only)", sort_order: 5, permissions: ["projects.view", "report.view", "requests.view_all"] },
  ];
  const profiles = [
    ["u-admin", "Patrick", "patrick@example.com", "admin"],
    ["u-tm", "Aljumer", "aljumer@example.com", "tm"],
    ["u-acct", "Jane", "jane@example.com", "accounting"],
    ["u-l1", "Mae", "mae@example.com", "liaison"],
  ].map(([id, full_name, email, role]) => ({ id, full_name, email, role, is_active: true }));

  const P = (id, code, year, district, name, location, category, contractor, cv, status, status_group, acc, extra = {}) => ({
    id, code, year, district, name, location, category, contractor,
    abc_amount: cv ? round2(cv * 1.012) : null, bid_amount: cv, revised_contract: null, contract_value: cv,
    duration_days: cv ? 180 : null, bidding_date: cv ? daysAgoISO(300) : null, ntp_date: cv ? daysAgoISO(240) : null,
    original_expiry: cv ? daysAgoISO(60) : null, suspension_notes: null, site_engineer: "Engr. Sample", checker: "Sample Checker",
    status, status_group, accomplishment: acc, is_internal: false, ...extra,
  });
  const projects = [
    P("p1", "26HO0101", 2026, "Cebu 7th", "Drainage System, Brgy. Poblacion, Moalboal", "Moalboal", "Drainage", "ADC/QM JV", 24500000, "Ongoing", "Ongoing", 0.62),
    P("p2", "26HO0114", 2026, "Cebu 7th", "Road Concreting, Brgy. Tapon, Dumanjug", "Dumanjug", "Roads", "QM Builders", 48200000, "Ongoing", "Ongoing", 0.35),
    P("p3", "26HH0120", 2026, "Cebu City", "Revetment along Pardo River, Cebu City", "Cebu City", "Flood Control", "ADC/QM JV", 38000000, "Ongoing", "Ongoing", 0.58),
    P("p4", "26HE0092", 2026, "Cebu 2nd", "Multi-Purpose Building, Argao", "Argao", "Building", "ADC", 19600000, "Completed (for retention)", "Completed / Closeout", 1),
    P("p5", "26HN0033", 2026, "Cebu 6th", "Coastal Road Phase 1, Lapu-Lapu City", "Lapu-Lapu City", "Roads", "QM Builders", 93500000, "Ongoing", "Ongoing", 0.12),
    P("p6", "26HD0045", 2025, "Cebu 4th", "Flood Control Structure, Bogo City", "Bogo City", "Flood Control", "ADC", 14650000, "Suspended (ROW)", "Suspended", 0.21),
    P("p7", "26H00011", 2026, "Region VII", "Office Building Annex, SRP", "SRP, Cebu City", "Building", "ADC", null, "For bidding", "Not yet awarded / Bidding", null),
    P("p-adv", "ADVANCES", null, null, "Advances (not yet charged to a project)", null, null, null, null, "Internal", "Internal", null, { is_internal: true }),
    P("p-asg", "FOR-ASSIGNMENT", null, null, "For assignment (project to be identified)", null, null, null, null, "Internal", "Internal", null, { is_internal: true }),
  ];
  const allocations = [
    { id: "a1", project_id: "p1", type_id: "t-qau", amount: 60000 },
    { id: "a2", project_id: "p1", type_id: "t-mqc", amount: 80000 },
    { id: "a3", project_id: "p4", type_id: "t-ab", amount: 120000 },
    { id: "a4", project_id: "p2", type_id: "t-ins", amount: 150000 },
    { id: "a5", project_id: "p2", type_id: "t-mqc", amount: 90000 },
  ];

  const typesById = new Map(types.map((t) => [t.id, t]));
  const name = (id) => profiles.find((p) => p.id === id).full_name;
  const year = new Date().getFullYear();
  const requests = [];
  const events = [];
  let ev = 0;
  const E = (request_id, line_id, action, actor, date, note = null) =>
    events.push({ id: ++ev, request_id, line_id, action, note, actor_id: actor, actor_name: name(actor), created_at: date + "T09:30:00" });

  // stage: on_hold | open | erp | disbursed | rejected ; per-line: paid / acct / tm flags
  const R = (seq, liaison, dAgo, project_id, stage, lines, extra = {}) => {
    const id = "r" + seq;
    // days after filing: approval (+apv), ERP reference (+erpd after approval), disbursement (+disb after ERP)
    const aAgo = dAgo - (extra.apv ?? 1);
    const eAgo = aAgo - (extra.erpd ?? 1);
    const dsAgo = eAgo - (extra.disb ?? 2);
    const date = daysAgoISO(dAgo);
    const approved = !["on_hold", "rejected"].includes(stage);
    const disbursed = stage === "disbursed";
    const ls = lines.map((l, i) => {
      const lid = id + "-" + (i + 1);
      const appr = approved ? l.appr ?? l.a : null;
      let status = stage === "on_hold" ? "on_hold" : stage === "rejected" ? "rejected" : appr === 0 ? "declined" : disbursed ? "disbursed" : "open";
      const line = {
        id: lid, request_id: id, line_no: i + 1, project_id: l.p || project_id, category_id: typesById.get(l.t).category_id,
        type_id: l.t, description: l.d || null, payee: l.payee || "Client representative", detail: l.detail || ((types.find((x) => x.id === l.t) || {}).detail_label ? "As per attached" : null),
        basis_amount: l.basis ?? null, basis_pct: l.bpct ?? null, rate: l.rate ?? null, amount: l.a, approved_amount: appr,
        status, paid_date: null, paid_by_name: null, acct_verified_at: null, acct_verified_by_name: null,
        tm_verified_at: null, tm_verified_by_name: null, closed_at: null, reclass: [],
        documents: (l.docs || []).map((d, k) => ({
          id: `${lid}-doc${k}`, line_id: lid, request_id: id, path: `demo/${lid}/${d.file}`, file_name: d.file, mime: "image/svg+xml",
          size_bytes: 48000, uploaded_by: liaison, uploaded_by_name: name(liaison), created_at: date + "T09:00:00", url: sampleDocUrl(d.title, d.lines || []),
        })),
      };
      if (disbursed && status === "disbursed" && l.paid) {
        const pAgo = dsAgo - (l.paidAfter ?? 2); // paid l.paidAfter days after disbursement
        line.status = "paid";
        line.paid_date = daysAgoISO(pAgo);
        line.paid_by_name = name(liaison);
        E(id, lid, "paid", liaison, line.paid_date);
        if (l.acct) {
          line.acct_verified_at = daysAgoISO(pAgo - 2) + "T10:00:00";
          line.acct_verified_by_name = name("u-acct");
          E(id, lid, "verified_acct", "u-acct", daysAgoISO(pAgo - 2));
        }
        if (l.tm) {
          line.tm_verified_at = daysAgoISO(pAgo - 3) + "T10:00:00";
          line.tm_verified_by_name = name("u-tm");
          E(id, lid, "verified_tm", "u-tm", daysAgoISO(pAgo - 3));
        }
        if (DEFAULT_SETTINGS.close_policy === "either" ? l.acct || l.tm : l.acct && l.tm) {
          line.status = "closed";
          line.closed_at = [line.tm_verified_at, line.acct_verified_at].filter(Boolean).sort()[0] || null;
        }
      }
      return line;
    });
    const r = {
      id, ref_no: `REQ-${year}-${String(seq).padStart(4, "0")}`, request_date: date, date_needed: extra.date_needed || daysAgoISO(dAgo - 7),
      project_id, liaison_id: liaison, liaison_name: name(liaison), remarks: extra.remarks || lines.map((x) => x.d).filter(Boolean).join("; ") || "Project expenses", status: "on_hold",
      approved_by: null, approved_by_name: null, approved_at: null, approval_remarks: null,
      erp_ref: null, erp_ref_at: null, erp_ref_by_name: null, disbursed_date: null, disbursed_by_name: null, disbursement_remarks: null,
      created_at: date + "T09:00:00", lines: ls,
    };
    E(id, null, "created", liaison, date);
    if (stage === "rejected") {
      Object.assign(r, { status: "rejected", approved_by: "u-tm", approved_by_name: name("u-tm"), approved_at: daysAgoISO(aAgo) + "T11:00:00", approval_remarks: extra.reason });
      E(id, null, "rejected", "u-tm", daysAgoISO(aAgo), extra.reason);
    } else if (approved) {
      Object.assign(r, { status: "open", approved_by: "u-tm", approved_by_name: name("u-tm"), approved_at: daysAgoISO(aAgo) + "T11:00:00", approval_remarks: extra.approval_remarks || null });
      E(id, null, "approved", "u-tm", daysAgoISO(aAgo), extra.approval_remarks);
      if (stage !== "open") {
        Object.assign(r, { erp_ref: extra.erp, erp_ref_at: daysAgoISO(eAgo) + "T14:00:00", erp_ref_by_name: name(liaison) });
        E(id, null, "erp_ref", liaison, daysAgoISO(eAgo), extra.erp);
      }
      if (disbursed) {
        Object.assign(r, { status: "disbursed", disbursed_date: daysAgoISO(dsAgo), disbursed_by_name: name("u-acct") });
        E(id, null, "disbursed", "u-acct", daysAgoISO(dsAgo));
        const live = ls.filter((l) => l.status !== "declined");
        if (live.every((l) => l.status === "closed")) r.status = "closed";
        else if (live.every((l) => l.status === "paid" || l.status === "closed")) r.status = "paid";
      }
    }
    requests.push(r);
  };

  R(1, "u-l1", 70, "p1", "disbursed", [
    { t: "t-bo", a: 490000, basis: 24500000, rate: 2, d: "2% buy-out, BAC share", paid: true, acct: true, tm: true, paidAfter: 1 },
    { t: "t-pln", a: 245000, basis: 24500000, rate: 1, d: "Planning share", paid: true, acct: true, tm: true, paidAfter: 3 },
  ], { erp: "CF-000812", apv: 2, erpd: 1, disb: 3 });
  R(2, "u-l1", 40, "p3", "disbursed", [
    { t: "t-de", a: 342000, basis: 11400000, bpct: 30, rate: 3, d: "DE share, 30% billing", payee: "District Engineer", paid: true, acct: true, paidAfter: 4,
      docs: [{ file: "collection-receipt-30pct.svg", title: "Collection receipt, 30% billing", lines: ["Project: 26HH0120", "Billing: 30% progress billing", "Net collection: PHP 11,400,000.00", "DE share (3%): PHP 342,000.00"] }] },
    { t: "t-cs", a: 114000, basis: 11400000, bpct: 30, rate: 1, d: "Construction share, 30% billing", payee: "Construction Section", paid: true, paidAfter: 11,
      docs: [{ file: "collection-receipt-30pct.svg", title: "Collection receipt, 30% billing", lines: ["Project: 26HH0120", "Billing: 30% progress billing", "Net collection: PHP 11,400,000.00", "Construction share (1%): PHP 114,000.00"] }] },
  ], { erp: "CF-000857", apv: 1, erpd: 3, disb: 2 });
  R(3, "u-l1", 22, "p2", "disbursed", [
    { t: "t-pln", a: 482000, basis: 48200000, rate: 1, d: "Planning share" },
    { t: "t-qau", p: "p1", a: 15000, d: "QA inspection, 2nd billing", payee: "QA Unit", paid: true, paidAfter: 2 },
    { t: "t-ins", a: 128500, d: "Performance bond", detail: "Performance bond", payee: "Surety provider" },
  ], { erp: "CF-000901" });
  R(4, "u-l1", 12, "p4", "erp", [
    { t: "t-ab", a: 117200, d: "As-built plan preparation", payee: "Planning Section" },
  ], { erp: "CF-000934" });
  R(5, "u-l1", 8, "p1", "open", [
    { t: "t-mqc", a: 45000, d: "Monthly materials report, 3 months", payee: "Materials Engineer" },
    { t: "t-qau", a: 20000, appr: 15000, d: "QA inspection, final", payee: "QA Unit" },
  ], { approval_remarks: "QAU reduced to 15,000 per rate card" });
  R(6, "u-l1", 3, "p5", "on_hold", [
    { t: "t-ppb", a: 1870000, basis: 93500000, rate: 2, d: "Post-bidding share" },
    { t: "t-bo", a: 1900000, d: "Buy-out, full" },
  ], { remarks: "Needed before contract signing", date_needed: daysAgoISO(-4) });
  R(7, "u-l1", 1, "p2", "on_hold", [
    { t: "t-mqc", a: 30000, d: "Material testing, batch 2", payee: "DPWH testing lab" },
    { t: "t-ins", a: 36000, d: "CARI renewal", detail: "Contractor's all risk",
      docs: [{ file: "CARI-renewal-quotation.svg", title: "CARI renewal quotation", lines: ["Insurer: Sample Surety Co.", "Coverage: Contractor's all risk", "Premium: PHP 36,000.00", "Valid until: 30 days"] }] },
    { t: "t-alw", p: "p-adv", a: 12000, d: "Monthly allowance, site coordination",
      docs: [{ file: "allowance-memo.svg", title: "Allowance memo", lines: ["Site coordination allowance", "Amount: PHP 12,000.00", "Period: this month"] }] },
  ]);
  R(8, "u-l1", 30, "p6", "rejected", [{ t: "t-bb", a: 25000, d: "Project billboard" }], { reason: "Project is suspended; hold billboard until resumption" });
  R(9, "u-l1", 45, "p-asg", "disbursed", [
    { t: "t-oth", a: 1000000, d: "Fund released ahead of project assignment", payee: "Client representative", detail: "Advance fund", paid: true, acct: true, tm: true, paidAfter: 6 },
  ], { erp: "CF-000880", remarks: "Projects to be identified", apv: 3, erpd: 2, disb: 5 });

  // REQ-0007 was approved, then the liaison raised material testing and added the allowance line: back for reapproval
  {
    const r7 = requests.find((x) => x.id === "r7");
    const was = requestSnapshot(r7);
    const approvedAt = daysAgoISO(1) + "T11:00:00";
    Object.assign(was, { remarks: "Material testing, batch 2; CARI renewal", approved_by_name: name("u-tm"), approved_at: approvedAt });
    was.lines = was.lines.slice(0, 2).map((l) => ({ ...l, approved_amount: l.amount }));
    Object.assign(was.lines[0], { amount: 25000, approved_amount: 25000 });
    events.push({ id: ++ev, request_id: "r7", line_id: null, action: "approved", note: null, actor_id: "u-tm", actor_name: name("u-tm"), created_at: approvedAt });
    events.push({
      id: ++ev, request_id: "r7", line_id: null, action: "edited", note: "2 → 3 lines; total 61,000.00 → 78,000.00; back to approval",
      changes: { reapproval: true, before: was }, actor_id: "u-l1", actor_name: name("u-l1"), created_at: daysAgoISO(1) + "T15:20:00",
    });
  }

  return {
    categories: cats, types, acumaticaItems, districtRates, roles, profiles, projects, allocations, requests, events,
    settings: { ...DEFAULT_SETTINGS }, counters: { [`REQ-${year}`]: 9 },
  };
}

function createDemoApi() {
  const docStore = new Map(); // demo: uploaded files kept in memory (path -> data URL)
  const db = buildDemoDB();
  let me = null;
  const listeners = new Set();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const wait = () => new Promise((r) => setTimeout(r, 90));
  const profile = () => db.profiles.find((p) => p.id === (me && me.id));
  const has = (perm) => {
    const p = profile();
    if (!p || !p.is_active) return false;
    if (p.role === "admin") return true;
    const role = db.roles.find((r) => r.role === p.role);
    return Boolean(role && role.permissions.includes(perm));
  };
  const need = (perm) => {
    if (!has(perm)) throw new Error(`Access denied: your role does not allow "${perm}".`);
  };
  const myName = () => (profile() || {}).full_name || "Unknown user";
  let evSeq = db.events.length + 100;
  const log = (request_id, line_id, action, note, changes = null) =>
    db.events.push({ id: ++evSeq, request_id, line_id, action, note: note ? String(note).trim() || null : null, changes, actor_id: me.id, actor_name: myName(), created_at: new Date().toISOString() });
  const getReq = (id) => {
    const r = db.requests.find((x) => x.id === id);
    if (!r) throw new Error("Request not found.");
    return r;
  };
  const refresh = (r) => {
    if (!["disbursed", "paid", "closed"].includes(r.status)) return;
    // same rule as oe_refresh_status: a partly paid line keeps the request open
    const live = r.lines.filter((l) => ["disbursed", "part_paid", "paid", "closed"].includes(l.status));
    if (!live.length && r.lines.some((l) => l.status === "returned")) {
      r.status = "returned"; // every disbursed line came back
      return;
    }
    r.status = live.length && live.every((l) => l.status === "closed") ? "closed" : live.length && live.every((l) => ["paid", "closed"].includes(l.status)) ? "paid" : "disbursed";
  };
  const emit = () => listeners.forEach((fn) => fn());
  const mutate = async (fn) => {
    await wait();
    const out = fn();
    emit();
    return out;
  };
  const upsert = (arr, row) => {
    const i = arr.findIndex((x) => x.id === row.id);
    if (i >= 0) arr[i] = { ...arr[i], ...row };
    else arr.push({ ...row, id: row.id || uid() });
    return i >= 0 ? arr[i] : arr[arr.length - 1];
  };

  return {
    mode: "demo",
    demoAccounts: () =>
      db.profiles
        .filter((p) => p.is_active)
        .map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, username: p.email.split("@")[0], roleLabel: (db.roles.find((r) => r.role === p.role) || {}).label })),
    async init() { return null; },
    onAuthChange() { return () => {}; },
    async signIn(identifier, password) {
      await wait();
      const v = String(identifier || "").trim().toLowerCase();
      const p = db.profiles.find((x) => x.is_active && (x.email.toLowerCase() === v || x.email.toLowerCase().split("@")[0] === v));
      if (!p || password !== demoPassword(p.email.split("@")[0].toLowerCase())) throw new Error("Invalid login credentials");
      me = { id: p.id };
      return { id: p.id };
    },
    async signOut() { me = null; },
    async resetPassword() { throw new Error("The demo has no passwords to reset."); },
    async savePushSubscription() {}, async removePushSubscription() {}, async pushTest() {},
    async updatePassword() {},
    async getProfile() { return clone(profile() || null); },
    async getRoleLabel(role) { const r = db.roles.find((x) => x.role === role); return r ? r.label : role; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async loadAll() {
      await wait();
      const seeAll = has("requests.view_all") || has("requests.approve");
      const seeLimits = has("report.view") || has("thresholds.view") || has("requests.approve") || has("allocations.edit");
      const requests = db.requests.filter((r) => seeAll || r.liaison_id === me.id);
      return clone({
        projects: db.projects, categories: db.categories, types: db.types, acumaticaItems: db.acumaticaItems, districtRates: db.districtRates,
        allocations: seeLimits ? db.allocations : [],
        usage: has("report.view") || has("thresholds.view") || has("requests.approve") ? aggregateUsage(db.requests) : [],
        requests: [...requests].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        profiles: db.profiles, roles: db.roles, settings: db.settings,
      });
    },
    async loadEvents(requestId) { await wait(); return clone(db.events.filter((e) => e.request_id === requestId)); },

    saveProject: (p) => mutate(() => {
      need("projects.edit");
      if (!p.code || !String(p.code).trim()) throw new Error("Project ID is required.");
      if (db.projects.some((x) => norm(x.code) === norm(p.code) && x.id !== p.id)) throw new Error(`Project ID ${p.code} already exists.`);
      return clone(upsert(db.projects, { ...p, code: String(p.code).trim() }));
    }),
    deleteProject: (id) => mutate(() => {
      need("projects.edit");
      if (db.requests.some((r) => r.project_id === id || r.lines.some((l) => l.project_id === id))) throw new Error("This project has requests, so it can't be deleted. Mark its status instead.");
      db.projects = db.projects.filter((p) => p.id !== id);
    }),
    saveAllocations: (projectId, entries) => mutate(() => {
      need("allocations.edit");
      for (const e of entries) {
        db.allocations = db.allocations.filter((a) => !(a.project_id === projectId && a.type_id === e.type_id));
        if (e.amount != null) db.allocations.push({ id: uid(), project_id: projectId, type_id: e.type_id, amount: round2(e.amount) });
      }
    }),
    saveCategory: (c) => mutate(() => {
      need("settings.expenses");
      if (db.categories.some((x) => norm(x.name) === norm(c.name) && x.id !== c.id)) throw new Error("A category with that name already exists.");
      return upsert(db.categories, c);
    }),
    saveType: (t) => mutate(() => {
      need("settings.expenses");
      if (db.types.some((x) => x.category_id === t.category_id && norm(x.name) === norm(t.name) && x.id !== t.id)) throw new Error("That type already exists in this category.");
      return upsert(db.types, t);
    }),
    saveAcumaticaItem: (item) => mutate(() => {
      need("settings.expenses");
      const inv_id = String(item.inv_id || "").trim();
      const description = String(item.description || "").trim();
      if (!inv_id) throw new Error("Enter the INV ID.");
      if (!description) throw new Error("Enter the description.");
      if (db.acumaticaItems.some((x) => norm(x.inv_id) === norm(inv_id) && x.id !== item.id)) throw new Error(`${inv_id} is already in the list.`);
      const row = { ...item, inv_id, description, sort_order: item.sort_order ?? db.acumaticaItems.length + 1 };
      return upsert(db.acumaticaItems, row);
    }),
    deleteAcumaticaItem: (id) => mutate(() => {
      need("settings.expenses");
      const used = db.types.filter((t) => t.acumatica_item_id === id);
      if (used.length) throw new Error(`It is mapped to ${used.map((t) => t.name).join(", ")}. Map ${used.length === 1 ? "that type" : "those types"} to another item first.`);
      db.acumaticaItems = db.acumaticaItems.filter((x) => x.id !== id);
    }),
    saveDistrictRates: (changes) => mutate(() => {
      need("settings.expenses");
      for (const c of changes) {
        db.districtRates = db.districtRates.filter((r) => !(norm(r.district) === norm(c.district) && r.type_id === c.type_id));
        if (c.rate != null) db.districtRates.push({ id: uid(), district: c.district, type_id: c.type_id, rate: c.rate });
      }
    }),

    createRequest: (req) => mutate(() => {
      need("requests.create");
      if (!req.date_needed) throw new Error("Enter the date needed.");
      if (!String(req.remarks || "").trim()) throw new Error("Enter a description.");
      if (!req.lines || !req.lines.length) throw new Error("Add at least one request line.");
      req.lines.forEach((l, i) => {
        const t = db.types.find((x) => x.id === l.type_id && x.is_active);
        if (!t) throw new Error(`Line ${i + 1}: choose an active expense type.`);
        if (!l.project_id) throw new Error(`Line ${i + 1}: choose a project.`);
        if (!(Number(l.amount) > 0)) throw new Error(`Line ${i + 1}: amount must be greater than zero.`);
        if (!String(l.payee || "").trim()) throw new Error(`Line ${i + 1}: enter the payee or recipient.`);
        if (t.detail_label && !String(l.detail || "").trim()) throw new Error(`Line ${i + 1}: fill in "${t.detail_label}".`);
        const cat = db.categories.find((c) => c.id === t.category_id);
        if (cat && cat.require_document && !(l.documents || []).length) throw new Error(`Line ${i + 1}: attach a supporting document.`);
      });
      const prefix = (db.settings.ref_prefix || "REQ").trim();
      const year = (req.request_date || todayISO()).slice(0, 4);
      const scope = `${prefix}-${year}`;
      db.counters[scope] = (db.counters[scope] || 0) + 1;
      const ref_no = `${scope}-${String(db.counters[scope]).padStart(4, "0")}`;
      const id = uid();
      db.requests.push({
        id, ref_no, request_date: req.request_date || todayISO(), date_needed: req.date_needed || null, project_id: req.project_id || null,
        liaison_id: me.id, liaison_name: myName(), remarks: req.remarks || null, status: "on_hold",
        approved_by: null, approved_by_name: null, approved_at: null, approval_remarks: null, erp_ref: null, erp_ref_at: null,
        erp_ref_by_name: null, disbursed_date: null, disbursed_by_name: null, disbursement_remarks: null, created_at: new Date().toISOString(),
        lines: req.lines.map((l, i) => ({
          id: uid(), request_id: id, line_no: i + 1, project_id: l.project_id, category_id: db.types.find((t) => t.id === l.type_id).category_id,
          type_id: l.type_id, description: l.description || null, payee: l.payee || null, detail: l.detail || null,
          basis_amount: l.basis_amount ?? null, basis_pct: l.basis_pct ?? null, rate: l.rate ?? null, amount: round2(l.amount),
          approved_amount: null, status: "on_hold", paid_date: null, paid_by_name: null, acct_verified_at: null, acct_verified_by_name: null, reclass: [],
          documents: (l.documents || []).map((d) => ({ id: uid(), path: d.path, file_name: d.file_name, mime: d.mime, size_bytes: d.size, uploaded_by: me.id, uploaded_by_name: myName(), created_at: new Date().toISOString() })),
          tm_verified_at: null, tm_verified_by_name: null, closed_at: null,
        })),
      });
      log(id, null, "created");
      return ref_no;
    }),
    updateRequest: (id, req) => mutate(() => {
      need("requests.create");
      const r = getReq(id);
      if (!["on_hold", "open"].includes(r.status)) throw new Error(`${r.ref_no} has already been disbursed or closed, so it can't be edited.`);
      const wasApproved = r.status === "open";
      const oldErp = r.erp_ref;
      const before = requestSnapshot(r);
      if (r.liaison_id !== me.id && profile().role !== "admin") throw new Error("You can only edit your own requests.");
      if (!req.date_needed) throw new Error("Enter the date needed.");
      if (req.date_needed < (req.request_date || r.request_date)) throw new Error("The date needed can't be before the request date.");
      if (!String(req.remarks || "").trim()) throw new Error("Enter a description.");
      if (!req.lines || !req.lines.length) throw new Error("Keep at least one request line.");
      const now = new Date().toISOString();
      const oldN = r.lines.length;
      const oldTotal = r.lines.reduce((a, l) => a + Number(l.amount), 0);
      const next = req.lines.map((l, i) => {
        const t = db.types.find((x) => x.id === l.type_id && x.is_active);
        if (!t) throw new Error(`Line ${i + 1}: choose an active expense type.`);
        if (!l.project_id) throw new Error(`Line ${i + 1}: choose a project.`);
        if (!(Number(l.amount) > 0)) throw new Error(`Line ${i + 1}: amount must be greater than zero.`);
        if (!String(l.payee || "").trim()) throw new Error(`Line ${i + 1}: enter the payee or recipient.`);
        if (t.detail_label && !String(l.detail || "").trim()) throw new Error(`Line ${i + 1}: fill in "${t.detail_label}".`);
        const old = l.id ? r.lines.find((x) => x.id === l.id) : null;
        if (l.id && !old) throw new Error("A line does not belong to this request.");
        const kept = old ? (old.documents || []).filter((d) => (l.keep_documents || []).includes(d.id)) : [];
        const added = (l.documents || []).map((d) => ({ id: uid(), path: d.path, file_name: d.file_name, mime: d.mime, size_bytes: d.size, uploaded_by: me.id, uploaded_by_name: myName(), created_at: now }));
        const cat = db.categories.find((c) => c.id === t.category_id);
        if (cat && cat.require_document && !kept.length && !added.length) throw new Error(`Line ${i + 1}: attach a supporting document.`);
        return {
          ...(old || { id: uid(), request_id: r.id, approved_amount: null, status: "on_hold", paid_date: null, paid_by_name: null, acct_verified_at: null, acct_verified_by_name: null, tm_verified_at: null, tm_verified_by_name: null, closed_at: null, reclass: [] }),
          line_no: i + 1, project_id: l.project_id, category_id: t.category_id, type_id: l.type_id,
          description: l.description || null, payee: l.payee || null, detail: l.detail || null,
          basis_amount: l.basis_amount ?? null, basis_pct: l.basis_pct ?? null, rate: l.rate ?? null, amount: round2(l.amount),
          documents: [...kept, ...added],
        };
      });
      const projects = [...new Set(next.map((l) => l.project_id))];
      Object.assign(r, { request_date: req.request_date || r.request_date, date_needed: req.date_needed, remarks: String(req.remarks).trim(), project_id: projects.length === 1 ? projects[0] : null, updated_at: now, lines: next });
      if (wasApproved) {
        // edited after approval: back to top management; the approval and ERP reference no longer apply
        next.forEach((l) => Object.assign(l, { status: "on_hold", approved_amount: null }));
        Object.assign(r, { status: "on_hold", approved_by: null, approved_by_name: null, approved_at: null, approval_remarks: null, erp_ref: null, erp_ref_at: null, erp_ref_by_name: null });
      }
      const fmt = (n) => Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const newTotal = next.reduce((a, l) => a + Number(l.amount), 0);
      log(r.id, null, "edited", `${oldN !== next.length ? `${oldN} → ${next.length} lines; ` : ""}total ${fmt(oldTotal)} → ${fmt(newTotal)}${wasApproved ? `; back to approval${oldErp ? `, ERP reference ${oldErp} cleared` : ""}` : ""}`, { reapproval: wasApproved, before });
      return r.ref_no;
    }),
    withdrawRequest: (id, remarks) => mutate(() => {
      const r = getReq(id);
      if (r.liaison_id !== me.id && profile().role !== "admin") throw new Error(`Only the liaison who filed ${r.ref_no} can withdraw it.`);
      if (!["on_hold", "open"].includes(r.status)) throw new Error(`${r.ref_no} has already been disbursed or closed, so it can't be withdrawn.`);
      r.status = "cancelled";
      r.updated_at = new Date().toISOString();
      r.lines.forEach((l) => (l.status = "cancelled"));
      log(id, null, "withdrawn", [String(remarks || "").trim(), r.erp_ref ? `ERP reference ${r.erp_ref} to be voided in Acumatica` : ""].filter(Boolean).join("; ") || null);
    }),
    approveRequest: (id, lineAmounts, remarks) => mutate(() => {
      need("requests.approve");
      const r = getReq(id);
      if (r.status !== "on_hold") throw new Error(`${r.ref_no} is no longer waiting for approval.`);
      if (r.liaison_id === me.id && profile().role !== "admin") throw new Error("You cannot approve your own request.");
      const next = r.lines.map((l) => {
        const a = lineAmounts && lineAmounts[l.id] != null ? round2(lineAmounts[l.id]) : Number(l.amount);
        if (a < 0 || a > Number(l.amount)) throw new Error(`Line ${l.line_no}: approved amount must be between 0 and the requested amount.`);
        return a;
      });
      if (!next.some((a) => a > 0)) throw new Error("Approve at least one line, or reject the request instead.");
      r.lines.forEach((l, i) => { l.approved_amount = next[i]; l.status = next[i] > 0 ? "open" : "declined"; });
      Object.assign(r, { status: "open", approved_by: me.id, approved_by_name: myName(), approved_at: new Date().toISOString(), approval_remarks: remarks || null });
      log(id, null, "approved", remarks);
    }),
    rejectRequest: (id, remarks) => mutate(() => {
      need("requests.approve");
      if (!remarks || !remarks.trim()) throw new Error("Add a reason for rejecting.");
      const r = getReq(id);
      if (r.status !== "on_hold") throw new Error(`${r.ref_no} is no longer waiting for approval.`);
      r.lines.forEach((l) => (l.status = "rejected"));
      Object.assign(r, { status: "rejected", approved_by: me.id, approved_by_name: myName(), approved_at: new Date().toISOString(), approval_remarks: remarks.trim() });
      log(id, null, "rejected", remarks);
    }),
    setErpRef: (id, ref) => mutate(() => {
      need("requests.erp_ref");
      if (!ref || !ref.trim()) throw new Error("Enter the ERP reference number.");
      const r = getReq(id);
      if (r.liaison_id !== me.id && !has("requests.view_all")) throw new Error("You can only update your own requests.");
      if (r.status !== "open") throw new Error(`The ERP reference can only be set while ${r.ref_no} is open.`);
      const prev = r.erp_ref;
      Object.assign(r, { erp_ref: ref.trim(), erp_ref_at: new Date().toISOString(), erp_ref_by_name: myName() });
      log(id, null, "erp_ref", prev ? `${ref.trim()} (was ${prev})` : ref.trim());
    }),
    disburseRequest: (id, date, remarks) => mutate(() => {
      need("requests.disburse");
      if (!date) throw new Error("Enter the disbursement date.");
      const r = getReq(id);
      if (r.status !== "open") throw new Error(`${r.ref_no} is not open for disbursement.`);
      if (!r.erp_ref) throw new Error(`The liaison has not entered the ERP reference for ${r.ref_no} yet.`);
      r.lines.forEach((l) => { if (l.status === "open") l.status = "disbursed"; });
      Object.assign(r, { status: "disbursed", disbursed_date: date, disbursed_by_name: myName(), disbursement_remarks: remarks || null });
      log(id, null, "disbursed", remarks || fmtDate(date));
    }),
    markPaid: (items, date, remarks) => mutate(() => {
      // items = [{ id, amount }]; one payment per line, same checks as oe_mark_paid
      need("requests.pay");
      if (!date) throw new Error("Enter the date the fund was given.");
      if (date > todayISO()) throw new Error("The date given can't be in the future.");
      if (!items || !items.length) throw new Error("Select at least one line.");
      if (new Set(items.map((x) => x.id)).size !== items.length) throw new Error("Each line can be listed only once.");
      const plan = items.map((it) => {
        let r = null;
        let l = null;
        for (const rr of db.requests) for (const ll of rr.lines) if (ll.id === it.id) { r = rr; l = ll; }
        if (!l) throw new Error("Request line not found.");
        if (r.liaison_id !== me.id && !has("requests.view_all")) throw new Error("You can only update your own requests.");
        if (l.status === "part_paid") throw new Error(`Line ${l.line_no} of ${r.ref_no} is already partly paid; accounting records the return of the rest.`);
        if (l.status !== "disbursed") throw new Error(`Line ${l.line_no} of ${r.ref_no} is not waiting for payment.`);
        if (r.disbursed_date && date < r.disbursed_date) throw new Error(`The date given can't be before the disbursement (${fmtDate(r.disbursed_date)}).`);
        const out = lineWithLiaison(l);
        const amt = round2(it.amount == null || it.amount === "" ? out : it.amount);
        if (!(amt > 0)) throw new Error(`Line ${l.line_no} of ${r.ref_no}: the amount given must be more than zero.`);
        if (amt > out + 0.004) throw new Error(`Line ${l.line_no} of ${r.ref_no}: only ${money(out)} is with the liaison.`);
        return { r, l, out, amt };
      });
      const touched = new Set();
      for (const { r, l, out, amt } of plan) {
        const full = amt >= out - 0.004;
        Object.assign(l, { status: full ? "paid" : "part_paid", paid_amount: amt, paid_date: date, paid_by_name: myName(), paid_at: new Date().toISOString() });
        log(r.id, l.id, "paid", [full ? `${money(amt)} given to the client` : `${money(amt)} of ${money(out)} given to the client; ${money(round2(out - amt))} to be returned`, String(remarks || "").trim()].filter(Boolean).join("; "));
        touched.add(r);
      }
      touched.forEach(refresh);
    }),
    returnLine: (lineId, ret) => mutate(() => {
      need("requests.return");
      if (!RETURN_ROLES.includes(profile().role)) throw new Error("Only accounting, top management or an administrator can record a fund return.");
      let r = null;
      let l = null;
      for (const rr of db.requests) for (const ll of rr.lines) if (ll.id === lineId) { r = rr; l = ll; }
      if (!l) throw new Error("Request line not found.");
      if (r.liaison_id === me.id && profile().role !== "admin") throw new Error(`You filed ${r.ref_no}, so someone else must record its fund return.`);
      if (!["disbursed", "part_paid"].includes(l.status))
        throw new Error(`Nothing on line ${l.line_no} of ${r.ref_no} can be returned; it is ${l.status === "paid" ? "already fully accounted for" : l.status === "closed" ? "closed" : l.status === "returned" ? "already returned in full" : "not disbursed"}.`);
      const out = lineWithLiaison(l);
      const amt = round2(ret && ret.amount);
      if (!(amt > 0)) throw new Error("Enter the amount returned.");
      if (amt > out + 0.004) throw new Error(`Only ${money(out)} of line ${l.line_no} is still with the liaison.`);
      const split = (l.reclass || []).reduce((a, x) => a + Number(x.amount), 0);
      if (lineNet(l) - amt < split - 0.004) throw new Error(`${money(split)} of this line is reclassified to projects; reduce the split before recording this return.`);
      const date = ret && ret.return_date;
      if (!date) throw new Error("Enter the date the fund was returned.");
      if (date > todayISO()) throw new Error("The return date can't be in the future.");
      if (r.disbursed_date && date < r.disbursed_date) throw new Error(`The return date can't be before the disbursement (${fmtDate(r.disbursed_date)}).`);
      const ref = String((ret && ret.return_ref) || "").trim();
      const reason = String((ret && ret.return_reason) || "").trim();
      if (!ref) throw new Error("Enter the receipt or reference number for the returned fund.");
      if (!reason) throw new Error("Enter the reason for the return.");
      const left = round2(out - amt);
      l.returns = [...(l.returns || []), { id: uid(), line_id: l.id, request_id: r.id, amount: amt, return_date: date, ref, reason, created_at: new Date().toISOString(), created_by: me.id, created_by_name: myName() }];
      l.returned_amount = round2(lineReturned(l) + amt);
      l.status = left > 0.004 ? l.status : linePaid(l) > 0 ? "paid" : "returned";
      refresh(r);
      log(r.id, l.id, "returned", `${money(amt)}${left > 0.004 ? " (partial)" : ""} returned ${fmtDate(date)}, ref ${ref}: ${reason}${left > 0.004 ? `; ${money(left)} still with the liaison` : ""}`);
    }),
    async uploadDocument(file) {
      const bad = checkDocFile(file);
      if (bad) throw new Error(bad);
      const url = await readAsDataUrl(file);
      const path = `${me ? me.id : "demo"}/${uid()}/${file.name}`;
      docStore.set(path, url);
      return { path, file_name: file.name, mime: file.type, size: file.size };
    },
    async documentUrl(doc) {
      return doc.url || docStore.get(doc.path) || null;
    },
    addLineDocuments: (lineId, docs) => mutate(() => {
      need("requests.create");
      let r = null;
      let l = null;
      for (const rr of db.requests) for (const ll of rr.lines) if (ll.id === lineId) { r = rr; l = ll; }
      if (!l) throw new Error("Request line not found.");
      if (r.status !== "on_hold") throw new Error(`Documents can only be added while ${r.ref_no} is waiting for approval.`);
      if (r.liaison_id !== me.id && profile().role !== "admin") throw new Error("You can only add documents to your own requests.");
      if (!docs || !docs.length) throw new Error("Choose a file to attach.");
      const now = new Date().toISOString();
      l.documents = [
        ...(l.documents || []),
        ...docs.map((d) => ({ id: uid(), line_id: l.id, request_id: r.id, path: d.path, file_name: d.file_name, mime: d.mime, size_bytes: d.size, uploaded_by: me.id, uploaded_by_name: myName(), created_at: now })),
      ];
      log(r.id, l.id, "documents_added", docs.map((d) => d.file_name).join(", "));
    }),
    removeLineDocument: (docId) => mutate(() => {
      need("requests.create");
      let r = null;
      let l = null;
      let doc = null;
      for (const rr of db.requests) for (const ll of rr.lines) for (const d of ll.documents || []) if (d.id === docId) { r = rr; l = ll; doc = d; }
      if (!doc) throw new Error("Document not found.");
      if (r.status !== "on_hold") throw new Error(`Documents can only be removed while ${r.ref_no} is waiting for approval.`);
      if (profile().role !== "admin" && (r.liaison_id !== me.id || doc.uploaded_by !== me.id)) throw new Error("You can only remove documents you attached to your own request.");
      const cat = db.categories.find((c) => c.id === l.category_id);
      if (cat && cat.require_document && l.documents.length <= 1) throw new Error("This line needs at least one supporting document. Attach the new one first, then remove this one.");
      l.documents = l.documents.filter((d) => d.id !== docId);
      log(r.id, l.id, "document_removed", doc.file_name);
    }),
    reclassifyLine: (lineId, parts) => mutate(() => {
      need("requests.reclassify");
      let r = null;
      let l = null;
      for (const rr of db.requests) for (const ll of rr.lines) if (ll.id === lineId) { r = rr; l = ll; }
      if (!l) throw new Error("Request line not found.");
      const src = db.projects.find((p) => p.id === l.project_id);
      if (!src || !src.is_internal) throw new Error("Only lines filed under an internal project (such as FOR-ASSIGNMENT) can be reclassified.");
      if (!["disbursed", "part_paid", "paid", "closed"].includes(l.status)) throw new Error("A line can be reclassified once its fund has been disbursed.");
      const base = lineNet(l); // returned money can't be split
      const fmt = (n) => Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const seen = new Set();
      const out = [];
      let total = 0;
      for (const p of parts) {
        if (!p.project_id) throw new Error("Choose a project for every row.");
        const amount = round2(Number(p.amount) || 0);
        if (!(amount > 0)) throw new Error("Every amount must be greater than zero.");
        if (seen.has(p.project_id)) throw new Error("Each project can appear only once in a split.");
        const proj = db.projects.find((x) => x.id === p.project_id);
        if (!proj || proj.is_internal) throw new Error("Reclassify to a specific project, not an internal one.");
        seen.add(p.project_id);
        total = round2(total + amount);
        out.push({ id: uid(), line_id: l.id, request_id: r.id, project_id: p.project_id, amount, remarks: String(p.remarks || "").trim() || null, created_at: new Date().toISOString(), created_by_name: myName() });
      }
      if (total > base + 0.004) throw new Error(`The split (${fmt(total)}) is more than the line amount after returns (${fmt(base)}).`);
      l.reclass = out;
      const note = out.map((x) => `${db.projects.find((p) => p.id === x.project_id).code} ${fmt(x.amount)}`).join("; ");
      log(r.id, l.id, "reclassified", out.length ? note + (total < base - 0.004 ? `; ${fmt(base - total)} remains on ${src.code}` : "") : `Split removed; back on ${src.code}`);
    }),
    verifyLines: (lineIds, side) => mutate(() => {
      need(side === "acct" ? "requests.verify_acct" : "requests.verify_tm");
      if (!lineIds.length) throw new Error("Select at least one line.");
      const policy = db.settings.close_policy || "either";
      const touched = new Set();
      for (const r of db.requests)
        for (const l of r.lines)
          if (lineIds.includes(l.id)) {
            if (l.status !== "paid") throw new Error(`Line ${l.line_no} must be marked paid before it can be verified.`);
            const now = new Date().toISOString();
            if (side === "acct" && !l.acct_verified_at) {
              Object.assign(l, { acct_verified_at: now, acct_verified_by_name: myName() });
              log(r.id, l.id, "verified_acct");
            }
            if (side === "tm" && !l.tm_verified_at) {
              Object.assign(l, { tm_verified_at: now, tm_verified_by_name: myName() });
              log(r.id, l.id, "verified_tm");
            }
            const done = policy === "either" ? l.acct_verified_at || l.tm_verified_at : l.acct_verified_at && l.tm_verified_at;
            if (done) Object.assign(l, { status: "closed", closed_at: now });
            touched.add(r);
          }
      touched.forEach(refresh);
    }),

    saveProfile: (p) => mutate(() => {
      need("settings.users");
      const cur = db.profiles.find((x) => x.id === p.id);
      if (p.id === me.id && (p.role !== cur.role || p.is_active !== cur.is_active)) throw new Error("You cannot change your own role or access. Ask another administrator.");
      if (profile().role !== "admin" && (cur.role === "admin" || p.role === "admin") && (p.role !== cur.role || p.is_active !== cur.is_active))
        throw new Error("Only an administrator can give, change or remove administrator access.");
      Object.assign(cur, p);
    }),
    inviteUser: ({ email, full_name, role }) => mutate(() => {
      need("settings.users");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "")) throw new Error("Enter a valid email address.");
      if (db.profiles.some((p) => !p.deleted_at && norm(p.email) === norm(email))) throw new Error("That email already has an account. Change its role or access in the Users list instead.");
      if (role === "admin" && profile().role !== "admin") throw new Error("Only an administrator can invite an administrator.");
      db.profiles.push({ id: uid(), email: email.trim().toLowerCase(), full_name: full_name || email.split("@")[0], role, is_active: true, invited_at: new Date().toISOString(), accepted_at: null });
    }),
    async userActivity(id) {
      need("settings.users");
      await wait();
      const filed = db.requests.filter((r) => r.liaison_id === id);
      const approved = db.requests.filter((r) => r.approved_by === id);
      const recent = [...filed.map((r) => ({ ...r, rel: "filed" })), ...approved.map((r) => ({ ...r, rel: "approved" }))]
        .sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
        .slice(0, 8)
        .map((r) => ({ ref_no: r.ref_no, status: r.status, request_date: r.request_date, role: r.rel }));
      return {
        requests: filed.length,
        requests_in_progress: filed.filter((r) => ["on_hold", "open", "disbursed", "paid"].includes(r.status)).length,
        approvals: approved.length,
        events: db.events.filter((e) => e.actor_id === id).length,
        documents: 0, returns: 0, reclass: 0, devices: 0,
        recent,
      };
    },
    deleteUser: (id) => mutate(() => {
      need("settings.users");
      const u = db.profiles.find((x) => x.id === id);
      if (!u) throw new Error("That user no longer exists.");
      if (id === me.id) throw new Error("You can't delete your own account. Ask another administrator.");
      if (u.role === "admin" && profile().role !== "admin") throw new Error("Only an administrator can delete an administrator.");
      const kept = db.requests.some((r) => r.liaison_id === id || r.approved_by === id) || db.events.some((e) => e.actor_id === id);
      if (kept) Object.assign(u, { is_active: false, deleted_at: new Date().toISOString(), deleted_by_name: myName() });
      else db.profiles.splice(db.profiles.indexOf(u), 1);
      return { ok: true, kept, email: u.email };
    }),
    saveRole: (r) => mutate(() => {
      need("settings.users");
      if (r.role === "admin") throw new Error("The administrator role always has every permission.");
      if (profile().role !== "admin" && r.role === profile().role) throw new Error("You can't change your own role's rights. Ask an administrator.");
      const row = { role: r.role, label: r.label, permissions: [...r.permissions], sort_order: r.sort_order || 99 };
      const i = db.roles.findIndex((x) => x.role === r.role);
      if (i >= 0) db.roles[i] = row;
      else db.roles.push(row);
    }),
    deleteRole: (role) => mutate(() => {
      need("settings.users");
      if (role === "admin") throw new Error("The administrator role can't be removed.");
      if (db.profiles.some((p) => p.role === role)) throw new Error("Move users off this role before removing it.");
      db.roles = db.roles.filter((r) => r.role !== role);
    }),
    saveSettings: (s) => mutate(() => {
      need("settings.users");
      db.settings = { ...db.settings, ...s };
    }),
  };
}

let _sbPromise = null;
// supabase-js is bundled by Vite from the npm package, so nothing is fetched from a CDN at runtime.
function loadSupabase() {
  if (!_sbPromise)
    _sbPromise = Promise.resolve(
      createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
        // The set-password tab keeps its session in memory only (see INVITE_TAB).
        auth: { persistSession: !INVITE_TAB, autoRefreshToken: true, detectSessionInUrl: true },
      })
    );
  return _sbPromise;
}

function createSupabaseApi() {
  const ok = async (p) => {
    const { data, error } = await p;
    if (error) throw new Error(error.message || "Request failed");
    return data;
  };
  const sb = () => loadSupabase();
  let userId = null;
  // Push notifications go out through the oe-push function; a failure there never fails the action that caused it.
  const notify = async (event, requestId) => {
    try {
      const c = await sb();
      const { data, error } = await c.functions.invoke("oe-push", { body: { event, request_id: requestId || null }, timeout: 30_000 });
      // visible in the browser console (F12) when checking who was reached: recipients, sent, failed, removed
      if (error) console.warn("oe-push", event, error.message);
      else console.info("oe-push", event, data);
    } catch (e) {
      console.warn("oe-push", event, e && e.message);
    }
  };

  return {
    mode: "live",
    async init() {
      const client = await sb();
      const { data } = await client.auth.getSession();
      userId = data.session ? data.session.user.id : null;
      return data.session ? data.session.user : null;
    },
    onAuthChange(cb) {
      let sub = null;
      let off = false; // cleanup may run before the client promise resolves (React StrictMode)
      sb().then((client) => {
        sub = client.auth.onAuthStateChange((event, session) => {
          userId = session ? session.user.id : null;
          cb(event, session ? session.user : null);
        }).data.subscription;
        if (off) sub.unsubscribe();
      });
      return () => {
        off = true;
        if (sub) sub.unsubscribe();
      };
    },
    async signIn(identifier, password, captchaToken) {
      const email = loginEmail(identifier);
      if (!email) throw new Error("Enter your full email address as the username.");
      const client = await sb();
      // captchaToken is only present once Turnstile is configured (CONFIG.captchaSiteKey + Supabase Attack protection).
      const data = await ok(client.auth.signInWithPassword({ email, password, ...(captchaToken ? { options: { captchaToken } } : {}) }));
      userId = data.user.id;
      return data.user;
    },
    async signOut() {
      const client = await sb();
      await client.auth.signOut();
      userId = null;
    },
    // Forgot password: Supabase emails a link that returns to RESET_PATH. The answer is the same whether or not
    // the address has an account, so the sign-in page gives nothing away.
    async resetPassword(email, captchaToken) {
      const client = await sb();
      await ok(client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + RESET_PATH, ...(captchaToken ? { captchaToken } : {}) }));
    },
    async updatePassword(password) {
      const client = await sb();
      await ok(client.auth.updateUser({ password }));
      // Shows "Accepted" in Settings → Users. The password is already saved, so a failure here is not an error for the person.
      try { await client.rpc("oe_accept_invite"); } catch (e) { /* status only */ }
    },
    async getProfile() {
      const client = await sb();
      return ok(client.from("oe_profiles").select("*").eq("id", userId).maybeSingle());
    },
    // the only setting readable before sign-in: whether the sign-in page offers the demo
    async getPublicSettings() {
      const client = await sb();
      return ok(client.rpc("oe_public_settings"));
    },
    async getRoleLabel(role) {
      const client = await sb();
      const { data } = await client.from("oe_role_permissions").select("label").eq("role", role).maybeSingle();
      return (data && data.label) || role;
    },
    subscribe(fn) {
      let channel = null;
      let timer = null;
      const debounced = () => {
        clearTimeout(timer);
        timer = setTimeout(fn, 700);
      };
      let off = false;
      sb().then((client) => {
        if (off) return;
        channel = client
          .channel("oe-requests")
          .on("postgres_changes", { event: "*", schema: "public", table: "oe_requests" }, debounced)
          // insert/update only: delete events aren't row-filtered by RLS, and an edit always touches the header too
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "oe_request_lines" }, debounced)
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "oe_request_lines" }, debounced)
          .subscribe();
      });
      return () => {
        off = true;
        clearTimeout(timer);
        if (channel) sb().then((c) => c.removeChannel(channel));
      };
    },

    async loadAll() {
      const c = await sb();
      const [projects, categories, types, districtRates, allocations, requests, profiles, roles, settingsRow, usage, acumaticaItems] = await Promise.all([
        ok(c.from("oe_projects").select("*").order("code")),
        ok(c.from("oe_expense_categories").select("*").order("sort_order")),
        ok(c.from("oe_expense_types").select("*").order("sort_order")),
        ok(c.from("oe_district_rates").select("*")),
        ok(c.from("oe_project_allocations").select("*")),
        ok(c.from("oe_requests").select("*, lines:oe_request_lines(*, reclass:oe_line_reclass(*), documents:oe_line_documents(*), returns:oe_line_returns(*))").order("created_at", { ascending: false }).limit(5000)),
        ok(c.from("oe_profiles").select("*").order("full_name")),
        ok(c.from("oe_role_permissions").select("*").order("sort_order")),
        ok(c.from("oe_settings").select("*").eq("id", 1).maybeSingle()),
        ok(c.rpc("oe_usage_summary")),
        ok(c.from("oe_acumatica_items").select("*").order("sort_order")),
      ]);
      for (const r of requests) {
        r.lines = (r.lines || []).sort((a, b) => a.line_no - b.line_no);
        for (const l of r.lines) {
          l.reclass = (l.reclass || []).map((x) => ({ ...x, amount: Number(x.amount) }));
          l.documents = l.documents || [];
        }
      }
      return {
        projects, categories, types, acumaticaItems, districtRates, allocations, requests, profiles, roles,
        usage: (usage || []).map((u) => ({ ...u, pending: +u.pending, open: +u.open, disbursed: +u.disbursed, paid: +u.paid, closed: +u.closed })),
        settings: { ...DEFAULT_SETTINGS, ...((settingsRow && settingsRow.data) || {}) },
      };
    },
    // Supporting documents live in the private "oe-documents" bucket, under the uploader's own folder.
    async uploadDocument(file) {
      const bad = checkDocFile(file);
      if (bad) throw new Error(bad);
      const c = await sb();
      const { data } = await c.auth.getUser();
      const userId = data && data.user ? data.user.id : null;
      if (!userId) throw new Error("Your session has ended. Sign in again.");
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "document";
      const path = `${userId}/${crypto.randomUUID()}/${safe}`;
      const { error } = await c.storage.from("oe-documents").upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(`${file.name}: ${error.message}`);
      return { path, file_name: file.name, mime: file.type, size: file.size };
    },
    async documentUrl(doc) {
      const c = await sb();
      const { data, error } = await c.storage.from("oe-documents").createSignedUrl(doc.path, 600);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
    async addLineDocuments(lineId, docs) {
      const c = await sb();
      await ok(c.rpc("oe_add_line_documents", { p_line_id: lineId, p_docs: docs }));
    },
    async removeLineDocument(docId) {
      const c = await sb();
      await ok(c.rpc("oe_remove_line_document", { p_doc_id: docId }));
    },
    async reclassifyLine(lineId, parts) {
      const c = await sb();
      await ok(c.rpc("oe_reclassify_line", { p_line_id: lineId, p_parts: parts.map((p) => ({ project_id: p.project_id, amount: p.amount, remarks: p.remarks || null })) }));
    },
    async loadEvents(requestId) {
      const c = await sb();
      return ok(c.from("oe_request_events").select("*").eq("request_id", requestId).order("created_at"));
    },

    async saveProject(p) {
      const c = await sb();
      const { id, created_at, updated_at, ...row } = p;
      if (id) return ok(c.from("oe_projects").update(row).eq("id", id).select().single());
      return ok(c.from("oe_projects").insert(row).select().single());
    },
    async deleteProject(id) {
      const c = await sb();
      const { error } = await c.from("oe_projects").delete().eq("id", id);
      if (error) throw new Error(/foreign key/i.test(error.message) ? "This project has requests, so it can't be deleted. Mark its status instead." : error.message);
    },
    async saveAllocations(projectId, entries) {
      const c = await sb();
      const set = entries.filter((e) => e.amount != null).map((e) => ({ project_id: projectId, type_id: e.type_id, amount: round2(e.amount), updated_at: new Date().toISOString() }));
      const clear = entries.filter((e) => e.amount == null).map((e) => e.type_id);
      if (set.length) await ok(c.from("oe_project_allocations").upsert(set, { onConflict: "project_id,type_id" }));
      if (clear.length) await ok(c.from("oe_project_allocations").delete().eq("project_id", projectId).in("type_id", clear));
    },
    async saveCategory(cat) {
      const c = await sb();
      const { id, ...row } = cat;
      return id ? ok(c.from("oe_expense_categories").update(row).eq("id", id)) : ok(c.from("oe_expense_categories").insert(row));
    },
    async saveType(t) {
      const c = await sb();
      const { id, ...row } = t;
      return id ? ok(c.from("oe_expense_types").update(row).eq("id", id)) : ok(c.from("oe_expense_types").insert(row));
    },
    async saveAcumaticaItem(item) {
      const c = await sb();
      const { id, ...row } = { ...item, inv_id: String(item.inv_id || "").trim(), description: String(item.description || "").trim() };
      if (!row.inv_id) throw new Error("Enter the INV ID.");
      if (!row.description) throw new Error("Enter the description.");
      try {
        return id ? await ok(c.from("oe_acumatica_items").update(row).eq("id", id)) : await ok(c.from("oe_acumatica_items").insert(row));
      } catch (e) {
        if (/duplicate|unique/i.test(String(e && e.message))) throw new Error(`${row.inv_id} is already in the list.`);
        throw e;
      }
    },
    async deleteAcumaticaItem(id) {
      const c = await sb();
      try {
        await ok(c.from("oe_acumatica_items").delete().eq("id", id));
      } catch (e) {
        if (/foreign key|violates/i.test(String(e && e.message))) throw new Error("It is still mapped to an expense type. Map that type to another item first.");
        throw e;
      }
    },
    async saveDistrictRates(changes) {
      const c = await sb();
      for (const ch of changes) {
        if (ch.rate == null) await ok(c.from("oe_district_rates").delete().eq("district", ch.district).eq("type_id", ch.type_id));
        else await ok(c.from("oe_district_rates").upsert({ district: ch.district, type_id: ch.type_id, rate: ch.rate }, { onConflict: "district,type_id" }));
      }
    },

    async createRequest(r) {
      const c = await sb();
      const ref = await ok(c.rpc("oe_create_request", {
        p_request_date: r.request_date || null, p_project_id: r.project_id || null, p_date_needed: r.date_needed || null,
        p_remarks: r.remarks || null, p_lines: r.lines,
      }));
      // tell the approvers (the function wants the id; the database returned the reference number)
      const { data: row } = await c.from("oe_requests").select("id").eq("ref_no", ref).maybeSingle();
      if (row) notify("submitted", row.id);
      return ref;
    },
    async updateRequest(id, r) {
      const c = await sb();
      await ok(c.rpc("oe_update_request", {
        p_id: id, p_request_date: r.request_date || null, p_date_needed: r.date_needed || null, p_remarks: r.remarks || null, p_lines: r.lines,
      }));
      notify("submitted", id); // an edit sends the request back for approval; the function checks that
      return null;
    },
    async withdrawRequest(id, remarks) { const c = await sb(); await ok(c.rpc("oe_withdraw_request", { p_id: id, p_remarks: remarks || null })); },
    async approveRequest(id, lineAmounts, remarks, seen) {
      const c = await sb();
      // "amount" is the requested amount the approver saw; the database refuses the approval if it changed meanwhile.
      const p_lines = Object.entries(lineAmounts || {}).map(([lid, amt]) => ({ id: lid, approved_amount: amt, ...(seen && seen[lid] != null ? { amount: seen[lid] } : {}) }));
      await ok(c.rpc("oe_approve_request", { p_id: id, p_lines, p_remarks: remarks || null }));
      notify("approved", id);
    },
    async rejectRequest(id, remarks) {
      const c = await sb();
      await ok(c.rpc("oe_reject_request", { p_id: id, p_remarks: remarks }));
      notify("rejected", id);
    },
    async savePushSubscription(sub) {
      const c = await sb();
      await ok(
        c.from("oe_push_subscriptions").upsert(
          { user_id: userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, user_agent: sub.user_agent || null, last_seen_at: new Date().toISOString() },
          { onConflict: "endpoint" }
        )
      );
    },
    async removePushSubscription(endpoint) {
      const c = await sb();
      await c.from("oe_push_subscriptions").delete().eq("endpoint", endpoint);
    },
    // unlike notify(), this one reports what went wrong, so the person is not told "on" when it isn't
    async pushTest() {
      const c = await sb();
      // 25 s: longer than the function's own 15 s limit per push service, so a slow service is reported, not waited on
      const { data, error } = await c.functions.invoke("oe-push", { body: { event: "test" }, timeout: 25_000 });
      if (error) {
        let msg = error.message;
        if (error.name === "FunctionsFetchError") msg = "no answer from the server";
        else try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep generic */ }
        throw new Error(msg);
      }
      if (data && data.error) throw new Error(data.error);
      return data; // { sent, failed, removed }
    },
    async setErpRef(id, ref) { const c = await sb(); await ok(c.rpc("oe_set_erp_ref", { p_id: id, p_erp_ref: ref })); },
    async disburseRequest(id, date, remarks) { const c = await sb(); await ok(c.rpc("oe_disburse_request", { p_id: id, p_date: date, p_remarks: remarks || null })); },
    async markPaid(items, date, remarks) {
      const c = await sb();
      await ok(c.rpc("oe_mark_paid", { p_lines: items.map((x) => ({ id: x.id, amount: x.amount })), p_date: date, p_remarks: remarks || null }));
    },
    async returnLine(lineId, ret) {
      const c = await sb();
      await ok(c.rpc("oe_return_line", { p_line_id: lineId, p_amount: ret.amount, p_return_date: ret.return_date || null, p_ref: ret.return_ref || null, p_reason: ret.return_reason || null }));
    },
    async verifyLines(lineIds, side) { const c = await sb(); await ok(c.rpc("oe_verify_lines", { p_line_ids: lineIds, p_side: side })); },

    async saveProfile(p) {
      const c = await sb();
      await ok(c.from("oe_profiles").update({ full_name: p.full_name, role: p.role, is_active: p.is_active }).eq("id", p.id));
    },
    async userActivity(id) {
      const c = await sb();
      return ok(c.rpc("oe_user_activity", { p_id: id }));
    },
    async deleteUser(id) {
      const c = await sb();
      const { data, error } = await c.functions.invoke("oe-delete-user", { body: { id } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep generic */ }
        throw new Error(msg);
      }
      if (data && data.error) throw new Error(data.error);
      return data;
    },
    async inviteUser(body) {
      const c = await sb();
      const { data, error } = await c.functions.invoke("oe-invite-user", {
        body: { ...body, redirect_to: window.location.origin + INVITE_PATH },
      });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep generic */ }
        throw new Error(msg);
      }
      if (data && data.error) throw new Error(data.error);
    },
    async saveRole(r) {
      const c = await sb();
      await ok(c.from("oe_role_permissions").upsert({ role: r.role, label: r.label, permissions: r.permissions, sort_order: r.sort_order || 99 }));
    },
    async deleteRole(role) {
      const c = await sb();
      const { error } = await c.from("oe_role_permissions").delete().eq("role", role);
      if (error) throw new Error(/foreign key/i.test(error.message) ? "Move users off this role before removing it." : error.message);
    },
    async saveSettings(s) {
      const c = await sb();
      await ok(c.from("oe_settings").upsert({ id: 1, data: s, updated_at: new Date().toISOString() }));
    },
  };
}

/* ---------------------------------------------------------------------
   6. STYLES
   Palette from huemint gradient-3: #002c46 → #0b4338 → #277876
   --------------------------------------------------------------------- */
const CSS = `
.oe{--navy:#002c46;--forest:#0b4338;--teal:#277876;--teal-d:#1d5f5d;--teal-50:#e4f0ee;--teal-100:#cde3e0;
--bg:#eef3f2;--surface:#fff;--sunk:#f5f8f8;--line:#d7e1df;--line-2:#bccbc8;--ink:#002c46;--body:#27414d;--muted:#5d7480;--faint:#8b9ea6;
--amber:#935d00;--amber-bg:#fcf0d6;--red:#b42318;--red-bg:#fdebe9;--blue:#1d4f7a;--blue-bg:#e3ecf5;--violet:#5b3d8f;--violet-bg:#eee8f7;--leaf:#4a6a12;--leaf-bg:#edf5dd;--green:#15603b;--green-bg:#e0f0e7;--slate:#3d5360;--slate-bg:#e6edef;
--grad:linear-gradient(162deg,#002c46 0%,#0b4338 56%,#277876 100%);--r:10px;--r-sm:7px;--teal-h:#1d5f5d;--field:#fff;--hover:#f4f8f7;--grp:#f1f6f5;--track:#e1eae8;--row:#e7eeec;--count:#e6eeec;--note-warn:#6d4500;--note-bad:#8a1c12;--note-info:#154b49;--chip-muted:#eef1f2;--chip-muted-t:#6b7e87;--danger-solid:#b42318;--danger-solid-h:#94190f;color-scheme:light;
font-family:Poppins,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;color:var(--body);background:var(--bg);-webkit-font-smoothing:antialiased;min-height:100vh}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .oe{--bg:#0b1517;--surface:#12201f;--sunk:#0f1b1c;--line:#223736;--line-2:#34504e;--ink:#e4efed;--body:#c2d2d0;--muted:#8ea4a3;--faint:#6a8281;--teal:#2a827e;--teal-h:#33938f;--teal-d:#6cc3bd;--teal-50:#16302e;--teal-100:#1e3f3c;--amber:#e8b65a;--amber-bg:#35290f;--red:#f08378;--red-bg:#3a1714;--blue:#8cb9e1;--blue-bg:#15293b;--violet:#c3adec;--violet-bg:#271f3b;--leaf:#b6d67a;--leaf-bg:#232f13;--green:#7ccf9c;--green-bg:#11301f;--slate:#b0c2c6;--slate-bg:#1c2c2f;--field:#0e1a1b;--hover:#172928;--grp:#142524;--track:#243938;--row:#1c302f;--count:#1e3432;--note-warn:#f0c77a;--note-bad:#f5a197;--note-info:#9fdad4;--chip-muted:#1c2a2c;--chip-muted-t:#9aabad;--danger-solid:#c2412f;--danger-solid-h:#d25444;color-scheme:dark}}
:root[data-theme=dark] .oe{--bg:#0b1517;--surface:#12201f;--sunk:#0f1b1c;--line:#223736;--line-2:#34504e;--ink:#e4efed;--body:#c2d2d0;--muted:#8ea4a3;--faint:#6a8281;--teal:#2a827e;--teal-h:#33938f;--teal-d:#6cc3bd;--teal-50:#16302e;--teal-100:#1e3f3c;--amber:#e8b65a;--amber-bg:#35290f;--red:#f08378;--red-bg:#3a1714;--blue:#8cb9e1;--blue-bg:#15293b;--violet:#c3adec;--violet-bg:#271f3b;--leaf:#b6d67a;--leaf-bg:#232f13;--green:#7ccf9c;--green-bg:#11301f;--slate:#b0c2c6;--slate-bg:#1c2c2f;--field:#0e1a1b;--hover:#172928;--grp:#142524;--track:#243938;--row:#1c302f;--count:#1e3432;--note-warn:#f0c77a;--note-bad:#f5a197;--note-info:#9fdad4;--chip-muted:#1c2a2c;--chip-muted-t:#9aabad;--danger-solid:#c2412f;--danger-solid-h:#d25444;color-scheme:dark}
.oe *,.oe *::before,.oe *::after{box-sizing:border-box}
.oe h1,.oe h2,.oe h3{color:var(--ink);margin:0;font-weight:600;letter-spacing:-.01em}
.oe h1{font-size:22px;line-height:1.25}.oe h2{font-size:16px;line-height:1.35}.oe h3{font-size:14px}
.oe p{margin:0}.oe .muted{color:var(--muted)}.oe .small{font-size:12.5px}.oe .num{font-variant-numeric:tabular-nums}
.oe button,.oe input,.oe select,.oe textarea{font:inherit;color:inherit}
.oe{-webkit-tap-highlight-color:transparent}
.oe :focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.oe a{color:var(--teal-d)}
.oe-shell{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.oe-side{background:var(--grad);color:#fff;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;padding:24px 14px 16px}
.oe-brand{padding:0 10px 24px}.oe-brand b{display:block;font-size:17px;font-weight:600;line-height:1.25;letter-spacing:-.01em}
.oe-brand span{display:block;font-size:12px;color:rgba(255,255,255,.62);margin-top:3px}
.oe-nav{display:flex;flex-direction:column;gap:2px;flex:1;overflow:auto}
.oe-nav button{display:flex;align-items:center;gap:11px;width:100%;border:0;background:transparent;color:rgba(255,255,255,.76);padding:9px 10px;border-radius:8px;cursor:pointer;text-align:left;font-size:14px}
.oe-nav button:hover{background:rgba(255,255,255,.08);color:#fff}
.oe-nav button[aria-current=page]{background:rgba(255,255,255,.15);color:#fff;font-weight:500;box-shadow:inset 3px 0 0 #a6dcd4}
.oe-nav .badge{margin-left:auto;background:#fff;color:var(--navy);font-size:11px;font-weight:600;border-radius:999px;padding:0 7px;min-width:20px;text-align:center;line-height:19px}
.oe-me{border-top:1px solid rgba(255,255,255,.15);padding:14px 10px 0;font-size:13px}
.oe-me b{display:block;font-weight:500;color:#fff}.oe-me small{display:block;color:rgba(255,255,255,.64);font-size:12px}
.oe-me button{margin-top:10px;display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:7px;padding:5px 10px;cursor:pointer;font-size:12.5px}
.oe-me button:hover{background:rgba(255,255,255,.18)}
.oe-me-row{display:flex;flex-wrap:wrap;gap:0 8px}
.oe-conf{display:flex;gap:7px;align-items:center;font-size:11.5px;color:rgba(255,255,255,.58);margin-top:14px}
.oe-shell{transition:grid-template-columns .18s ease}
.oe-side-toggle{display:flex;align-items:center;gap:9px;width:100%;margin-top:12px;border:0;border-top:1px solid rgba(255,255,255,.15);background:transparent;color:rgba(255,255,255,.7);padding:12px 10px 2px;cursor:pointer;font-size:12.5px;text-align:left}
.oe-side-toggle:hover{color:#fff}
.oe-brand .short{display:none}
.oe-side-x{display:none}
@media (min-width:768px){
.oe-shell.collapsed{grid-template-columns:72px minmax(0,1fr)}
.oe-shell.collapsed .oe-page{max-width:none}
.collapsed .oe-side{padding-left:10px;padding-right:10px}
.collapsed .oe-brand{padding:0 0 24px;text-align:center}.collapsed .oe-brand .full{display:none}.collapsed .oe-brand .short{display:block;font-size:15px}
.collapsed .oe-nav{overflow-x:hidden}
.collapsed .oe-nav button{position:relative;justify-content:center;padding:10px 0}
.collapsed .oe-nav .lbl{display:none}
.collapsed .oe-nav .badge{position:absolute;top:2px;right:4px;margin:0;font-size:10px;line-height:16px;min-width:16px;padding:0 4px}
.collapsed .oe-me{padding:14px 0 0;text-align:center}
.collapsed .oe-me b,.collapsed .oe-me small,.collapsed .oe-me .lbl{display:none}
.collapsed .oe-me button{padding:7px 9px}
.collapsed .oe-me-row{flex-direction:column;align-items:center;gap:0}
.collapsed .oe-conf{justify-content:center}
.collapsed .oe-side-toggle{justify-content:center;padding:12px 0 2px}.collapsed .oe-side-toggle .lbl{display:none}
}
.oe-main{min-width:0;display:flex;flex-direction:column}
.oe-topbar{display:none}
.oe-demo{background:var(--amber-bg);color:var(--amber);font-size:13px;padding:8px 28px;border-bottom:1px solid var(--line)}
.oe-push{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 28px;background:var(--teal-50);border-bottom:1px solid var(--teal-100);color:var(--note-info);font-size:13.5px}
.oe-push>div:not(.oe-actions){flex:1 1 280px;min-width:0}.oe-push b{display:block;color:var(--ink);font-weight:500}.oe-push p{margin-top:2px;font-size:12.5px}.oe-push>svg{flex:none;color:var(--teal-d)}
.oe-page{padding:28px 28px 56px;width:100%;max-width:1480px}
.oe-page.narrow{max-width:1360px}
.oe-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.oe-head p{color:var(--muted);margin-top:4px;max-width:72ch}
.oe-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.oe-panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.oe-panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.oe-panel-b{padding:16px 18px}
.oe-stack{display:flex;flex-direction:column;gap:16px}
.oe-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;padding:0 14px;border-radius:8px;border:1px solid transparent;font-weight:500;font-size:13.5px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s;text-decoration:none}
.oe-btn:disabled{opacity:.5;cursor:not-allowed}
.oe-btn.primary{background:var(--teal);color:#fff}.oe-btn.primary:hover:not(:disabled){background:var(--teal-h)}
.oe-btn.secondary{background:var(--surface);border-color:var(--line-2);color:var(--ink)}.oe-btn.secondary:hover:not(:disabled){background:var(--sunk);border-color:var(--faint)}
.oe-btn.ghost{background:transparent;color:var(--teal-d)}.oe-btn.ghost:hover:not(:disabled){background:var(--teal-50)}
.oe-btn.danger{background:var(--surface);border-color:#e6b3ad;color:var(--red)}.oe-btn.danger:hover:not(:disabled){background:var(--red-bg)}
.oe-btn.danger.solid{background:var(--danger-solid);border-color:var(--danger-solid);color:#fff}.oe-btn.danger.solid:hover:not(:disabled){background:var(--danger-solid-h);border-color:var(--danger-solid-h)}
.oe-btn.sm{height:30px;padding:0 10px;font-size:13px}.oe-btn.icon{width:36px;padding:0}.oe-btn.sm.icon{width:30px}
.oe-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.oe-label{font-size:12.5px;font-weight:500;color:var(--slate)}
.oe-field .hint{font-size:12px;color:var(--muted)}.oe-field .err{font-size:12px;color:var(--red)}
.oe-input,.oe-select,.oe-textarea{width:100%;height:36px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--field);padding:0 10px;transition:border-color .15s,box-shadow .15s}
.oe-textarea{height:auto;min-height:70px;padding:8px 10px;resize:vertical}
.oe-input:focus,.oe-select:focus,.oe-textarea:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(39,120,118,.18)}
.oe-input[readonly]{background:var(--sunk);color:var(--muted)}
.oe-input.num{text-align:right;font-variant-numeric:tabular-nums}
.oe-input.bad,.oe-select.bad,.oe-textarea.bad{border-color:var(--red)}
.oe-select{appearance:none;-webkit-appearance:none;padding-right:30px;background:var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235d7480' stroke-width='2.4' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center}
.oe-grid{display:grid;gap:14px 16px;grid-template-columns:repeat(12,minmax(0,1fr))}
.span-2{grid-column:span 2}.span-3{grid-column:span 3}.span-4{grid-column:span 4}.span-5{grid-column:span 5}.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}.span-9{grid-column:span 9}.span-10{grid-column:span 10}.span-12{grid-column:span 12}
.oe-sect{grid-column:span 12;font-size:13px;font-weight:600;color:var(--ink);padding-top:8px;border-top:1px solid var(--line);margin-top:4px}
.oe-sect:first-child{border-top:0;padding-top:0;margin-top:0}
.oe-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px}
.oe input[type=checkbox],.oe input[type=radio]{accent-color:var(--teal);width:16px;height:16px;margin:0;cursor:pointer}
.oe-filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px}
.oe-filters .oe-select,.oe-filters .oe-input{width:auto;min-width:130px}
.oe-search{position:relative;flex:1 1 240px;max-width:360px}.oe-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--faint)}
.oe-search .oe-input{padding-left:33px;width:100%}
.oe-tablewrap{overflow:auto;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);max-width:100%}
.oe-scrollx{overflow-x:auto}
.oe-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px}
.oe-table th{position:sticky;top:0;background:var(--sunk);color:var(--muted);font-weight:500;font-size:12.5px;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;z-index:1}
.oe-table td{padding:11px 12px;border-bottom:1px solid var(--row);vertical-align:top}
.oe-table tbody tr:last-child td{border-bottom:0}
.oe-table tr.click{cursor:pointer}.oe-table tr.click:hover td{background:var(--hover)}
.oe-table .r{text-align:right}.oe-table td.r{font-variant-numeric:tabular-nums;white-space:nowrap}
.oe-table .c{text-align:center}
.oe-table tfoot td{background:var(--sunk);font-weight:600;color:var(--ink);border-top:1px solid var(--line);border-bottom:0}
.oe-table .sub{display:block;color:var(--muted);font-size:12.5px;margin-top:1px}
.oe-table tr.grp td{background:var(--grp);font-weight:600;color:var(--ink)}
.oe-table tr.sel td{background:var(--hover)}
.oe-table tr.muted-row td{color:var(--faint)}
.oe-table tr.focus td{background:var(--amber-bg)}.oe-table tr.focus td:first-child{box-shadow:inset 3px 0 0 var(--amber)}
.oe-linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--teal-d);cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.oe-linkbtn:hover{color:var(--ink)}
.oe-table.tight td{padding:8px 10px}.oe-table.tight th{padding:8px 10px}
.oe-code{font-weight:600;color:var(--ink);white-space:nowrap}
.oe-clip{display:block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oe-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.oe-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85}
.oe-chip.plain::before{display:none}
.oe-chip.status{width:112px;justify-content:flex-start}
.oe-since{margin-top:3px;padding-left:10px;font-size:12px}
.tone-amber{background:var(--amber-bg);color:var(--amber)}.tone-teal{background:var(--teal-50);color:var(--teal-d)}
.tone-blue{background:var(--blue-bg);color:var(--blue)}.tone-violet{background:var(--violet-bg);color:var(--violet)}.tone-leaf{background:var(--leaf-bg);color:var(--leaf)}.tone-green{background:var(--green-bg);color:var(--green)}
.tone-slate{background:var(--slate-bg);color:var(--slate)}.tone-red{background:var(--red-bg);color:var(--red)}
.tone-muted{background:var(--chip-muted);color:var(--chip-muted-t)}
.oe-meter{position:relative;height:8px;border-radius:999px;background:var(--track);min-width:72px}
.oe-meter .used{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--teal)}
.oe-meter .pend{position:absolute;top:0;bottom:0;border-radius:0 999px 999px 0;background:repeating-linear-gradient(135deg,rgba(39,120,118,.5) 0 3px,rgba(39,120,118,.14) 3px 6px)}
.oe-meter.near .used{background:#c3880f}.oe-meter.over .used{background:var(--red)}
.oe-meter .tick{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--navy);border-radius:2px}
.oe-meter.lg{height:12px}
.oe-usage{display:grid;gap:5px;min-width:112px}
.oe-usage-t{display:flex;justify-content:space-between;gap:8px;font-size:13px;white-space:nowrap}
.oe-usage-t b{font-weight:600;color:var(--ink)}.oe-usage-t span{color:var(--muted);font-size:12px}
.oe-usage .note{font-size:11.5px;color:var(--muted);white-space:nowrap}.oe-usage .note.over{color:var(--red);font-weight:500}
.oe-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--r);margin-bottom:18px}
.oe-strip>div{padding:14px 18px;border-left:1px solid var(--line)}.oe-strip>div:first-child{border-left:0}
.oe-strip dt{font-size:12.5px;color:var(--muted)}.oe-strip dd{margin:3px 0 0;font-size:19px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.oe-strip dd.bad{color:var(--red)}
.oe-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px 20px;margin:0}
.oe-kv dt{font-size:12px;color:var(--muted)}.oe-kv dd{margin:2px 0 0;color:var(--ink);font-weight:500;overflow-wrap:anywhere}
.oe-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:18px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.oe-hint{position:relative;display:inline-block;max-width:100%}.oe-meter-wrap{display:block}
.oe-tip{position:absolute;left:0;top:calc(100% + 6px);z-index:40;background:var(--navy);color:#fff;font-size:12px;font-weight:400;line-height:1.4;padding:6px 9px;border-radius:7px;min-width:160px;max-width:260px;white-space:normal;box-shadow:0 8px 20px rgba(0,30,45,.25)}
.oe-lf{display:contents}.oe-lf-t{display:none}.oe.oe .oe-phone-only{display:none}
.oe-fold{margin-bottom:14px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
.oe-fold>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:0 14px;font-weight:500;color:var(--ink)}
.oe-fold>summary::-webkit-details-marker{display:none}
.oe-fold>summary::after{content:"";width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg);margin:0 4px 4px 0}
.oe-fold[open]>summary::after{transform:rotate(-135deg);margin:4px 4px 0 0}
.oe-fold .oe-filters{padding:4px 14px 14px;margin-bottom:0!important}
.oe-fold .oe-filters>*{flex:1 1 100%;width:auto!important;max-width:none}
.oe-fold .oe-filters .oe-select,.oe-fold .oe-filters .oe-input,.oe-fold .oe-search{width:100%;max-width:none}
.oe-fold .oe-filters .oe-check{justify-content:space-between}
.oe-kpi-more{justify-content:center;align-items:center;color:var(--teal-d);font-weight:500;font-size:13.5px}.oe-kpi-more::before{display:none}
.oe-update{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:95;background:var(--navy);color:#fff;padding:10px 10px 10px 14px;border-radius:12px;display:flex;gap:10px;align-items:center;font-size:13.5px;box-shadow:0 12px 32px rgba(0,30,45,.28);width:max-content;max-width:calc(100vw - 24px);animation:oe-pop .2s ease-out}
.oe-update>svg{flex:none;opacity:.85}
.oe-update-t{display:grid;gap:1px;min-width:0;margin-right:4px}.oe-update-t b{font-weight:600}.oe-update-t span{font-size:12px;opacity:.78}
.oe-update button{background:#fff;color:var(--navy);border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;min-height:36px;white-space:nowrap}
.oe-update button.later{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.32);font-weight:500}
.oe-update button:disabled{opacity:.7;cursor:default}
.oe-install{margin-top:12px;display:grid;gap:4px;font-size:12.5px;line-height:1.4;color:rgba(255,255,255,.8)}
.oe-install button{margin-top:4px;justify-self:start}
.collapsed .oe-install{display:none}
.oe-tabs button{border:0;background:none;padding:9px 12px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer;white-space:nowrap;display:inline-flex;gap:7px;align-items:center}
.oe-tabs button:hover{color:var(--ink)}.oe-tabs button[aria-selected=true]{color:var(--ink);border-color:var(--teal)}
.oe-tabs .count{font-size:11.5px;background:var(--count);color:var(--slate);border-radius:999px;padding:0 7px;line-height:18px}
.oe-tabs button[aria-selected=true] .count{background:var(--teal);color:#fff}
.oe-overlay{position:fixed;inset:0;background:rgba(0,28,44,.44);z-index:50;display:flex}
.oe-modal{margin:auto;background:var(--surface);border-radius:14px;width:min(var(--w,560px),calc(100vw - 24px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,30,45,.3);animation:oe-pop .18s ease-out}
.oe-modal:focus{outline:none}
.oe-modal-h{padding:18px 20px 12px 22px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.oe-modal-h p{color:var(--muted);margin-top:3px;font-size:13px}
.oe-modal-b{padding:4px 22px 20px;overflow:auto}
.oe-modal.roomy .oe-modal-b{min-height:min(58vh,520px)}
.oe-modal-f{padding:14px 22px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;align-items:center}
.oe-drawer{margin-left:auto;background:var(--bg);padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);width:min(var(--w,780px),100vw);height:100%;display:flex;flex-direction:column;box-shadow:-18px 0 50px rgba(0,30,45,.22);animation:oe-slide .22s ease-out}
.oe-drawer:focus{outline:none}
.oe-drawer-h{background:var(--surface);border-bottom:1px solid var(--line);padding:18px 20px 16px 22px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.oe-drawer-h p{color:var(--muted);font-size:13px;margin-top:3px}
.oe-drawer-b .oe-tabs{margin-bottom:0}
.oe-drawer-b>*{flex-shrink:0}
.oe-drawer-b{overflow:auto;padding:18px 22px 36px;display:flex;flex-direction:column;gap:16px;flex:1}
@keyframes oe-slide{from{transform:translateX(28px);opacity:.3}to{transform:none;opacity:1}}
@keyframes oe-pop{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}
@keyframes oe-nudge-m{0%{transform:scale(1)}35%{transform:scale(1.018)}100%{transform:scale(1)}}
@keyframes oe-nudge-d{0%{transform:translateX(0)}30%{transform:translateX(-8px)}100%{transform:translateX(0)}}
.oe-modal.nudge{animation:oe-nudge-m .28s ease-out;box-shadow:0 0 0 3px rgba(39,120,118,.45),0 24px 64px rgba(0,30,45,.3)}
.oe-drawer.nudge{animation:oe-nudge-d .28s ease-out;box-shadow:0 0 0 3px rgba(39,120,118,.45),-18px 0 50px rgba(0,30,45,.22)}
.oe-toasts{position:fixed;right:20px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:90;display:flex;flex-direction:column;gap:8px;max-width:min(440px,calc(100vw - 40px))}
.oe-toast{border:1px solid rgba(255,255,255,.12);background:var(--navy);color:#fff;padding:11px 14px;border-radius:10px;font-size:13.5px;box-shadow:0 12px 32px rgba(0,30,45,.28);display:flex;gap:10px;align-items:flex-start;animation:oe-pop .2s ease-out}
.oe-toast.err{background:#7d1c14}
.oe-empty{padding:40px 20px;text-align:center;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:10px}
.oe-empty h3{color:var(--ink);font-size:15px}
.oe-note{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:8px;font-size:13px;background:var(--sunk);color:var(--body)}
.oe-note.warn{background:var(--amber-bg);color:var(--note-warn)}.oe-note.bad{background:var(--red-bg);color:var(--note-bad)}.oe-note.info{background:var(--teal-50);color:var(--note-info)}
.oe-note svg{flex:none;margin-top:1px}
.oe-split{display:grid;grid-template-columns:290px minmax(0,1fr);gap:18px;align-items:start}
.oe-split>*{min-width:0}
.oe-queue{display:flex;flex-direction:column;gap:8px;position:sticky;top:16px;max-height:calc(100vh - 120px);overflow:auto;padding:2px}
.oe-qitem{text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;cursor:pointer;display:grid;gap:4px;width:100%}
.oe-qitem:hover{border-color:var(--line-2)}.oe-qitem[aria-current=true]{border-color:var(--teal);box-shadow:0 0 0 1px var(--teal)}
.oe-qitem .row{display:flex;justify-content:space-between;gap:8px;align-items:center}
.oe-qopen{font-size:12.5px;color:var(--teal-d);font-weight:500}
.oe-line{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;display:grid;grid-template-columns:30px minmax(0,1fr);gap:14px}
.oe-line.bad{border-color:#e6b3ad}
.oe-line-no{width:28px;height:28px;border-radius:50%;background:var(--teal-50);color:var(--teal-d);font-weight:600;display:grid;place-items:center;font-size:13px}
.oe-limit{border-radius:8px;background:var(--sunk);padding:10px 12px;font-size:13px;display:grid;gap:7px;grid-column:span 12}
.oe-limit .row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.oe-rq-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) minmax(0,1fr);gap:14px}
.oe-rq-box{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 18px;display:flex;flex-direction:column}
.oe-rq-row{display:grid;grid-template-columns:130px minmax(0,1fr);align-items:center;gap:12px;min-height:44px}
.oe-rq-row.top{align-items:start;padding-top:6px}.oe-rq-row.top .oe-rq-label{padding-top:8px}
.oe-rq-label{color:var(--slate);font-size:13.5px}
.oe-req{color:var(--red)}
.oe-rq-value{color:var(--ink);font-weight:500;border-bottom:1px solid var(--row);padding:8px 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oe-rq-sum{background:var(--teal-50);border-color:var(--teal-100)}
.oe-rq-sum .oe-rq-row{min-height:36px;border-bottom:1px solid var(--teal-100);grid-template-columns:minmax(0,1fr) auto}
.oe-rq-sum .oe-rq-amt{color:var(--ink);font-weight:500;text-align:right}
.oe-rq-sum .oe-rq-row.total{border-bottom:0;border-top:2px solid var(--teal);margin-top:2px;min-height:44px}
.oe-rq-sum .oe-rq-row.total .oe-rq-label{color:var(--ink);font-weight:600}
.oe-rq-sum .oe-rq-row.total .oe-rq-amt{font-size:18px;font-weight:600}
.oe-rq-value.wrap{white-space:normal;overflow-wrap:anywhere;font-weight:400;line-height:1.45}
.oe-rq-head.compact{gap:12px}
.oe-rq-head.compact .oe-rq-box{padding:10px 14px}
.oe-rq-head.compact .oe-rq-row{grid-template-columns:96px minmax(0,1fr);gap:8px;min-height:38px}
.oe-rq-head.compact .oe-rq-label{font-size:12.5px}
.oe-rq-head.compact .oe-rq-value{padding:6px 0;font-size:13.5px}
.oe-rq-head.compact .oe-rq-sum .oe-rq-row{grid-template-columns:minmax(0,1fr) auto;min-height:32px}
.oe-rq-head.compact .oe-rq-sum .oe-rq-row.total .oe-rq-amt{font-size:16px}
.oe-drawer .oe-rq-head.compact{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr) minmax(0,1fr)}
.oe-drawer .oe-rq-head.compact .oe-rq-sum{grid-column:auto}
@media (max-width:900px){.oe-drawer .oe-rq-head.compact{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.oe-drawer .oe-rq-head.compact .oe-rq-sum{grid-column:span 2}}
@media (max-width:560px){.oe-drawer .oe-rq-head.compact{grid-template-columns:minmax(0,1fr)}.oe-drawer .oe-rq-head.compact .oe-rq-sum{grid-column:auto}}
@media (max-width:1280px){.oe-rq-head{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.oe-rq-sum{grid-column:span 2}}
@media (max-width:700px){.oe-rq-head{grid-template-columns:minmax(0,1fr)}.oe-rq-sum{grid-column:auto}.oe-rq-row{grid-template-columns:110px minmax(0,1fr)}}
.oe-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:16px}
.oe-kpi{position:relative;overflow:hidden;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px 12px 17px;cursor:pointer;display:flex;flex-direction:column;justify-content:space-between;gap:2px;transition:border-color .15s,box-shadow .15s}
.oe-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--kpi,var(--line-2))}
.oe-kpi:hover{border-color:var(--line-2)}
.oe-kpi[aria-pressed=true]{border-color:var(--teal);box-shadow:0 0 0 1px var(--teal)}
.oe-kpi.action{background:var(--teal-50);border-color:var(--teal-100)}
.oe-kpi .k-label{font-size:12.5px;color:var(--muted);line-height:1.3}
.oe-kpi .k-nums{display:flex;flex-direction:column;margin-top:4px}
.oe-kpi .k-count{font-size:24px;font-weight:600;color:var(--ink);line-height:1.2}
.oe-kpi .k-amt{font-size:12px;color:var(--muted)}
.oe-select.empty{color:var(--faint)}.oe-select.empty option{color:var(--ink)}
.oe-reclass{margin-top:6px;padding:6px 10px;border-left:3px solid var(--violet);background:var(--violet-bg);border-radius:0 6px 6px 0;display:flex;flex-direction:column;gap:1px;font-size:12.5px}
.oe-reclass-t{font-weight:600;color:var(--violet);font-size:12px}
.oe-reclass-row{color:var(--body)}
.oe-reclass-sub td{border-top:0!important;padding-top:0!important}
.oe-reclass-sum{display:flex;gap:28px;margin:0}
.oe-reclass-src{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px 18px;margin:0;padding:12px 16px;background:var(--sunk);border:1px solid var(--line);border-radius:var(--r)}
.oe-reclass-src dt{font-size:12px;color:var(--muted)}.oe-reclass-src dd{margin:2px 0 0;font-weight:600;color:var(--ink)}
@media (max-width:760px){.oe-reclass-src{grid-template-columns:repeat(2,minmax(0,1fr))}}
.oe-reclass-sum dt{font-size:12px;color:var(--muted)}.oe-reclass-sum dd{margin:0;font-weight:600;color:var(--ink);text-align:right}
.oe-an-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
@media (max-width:1000px){.oe-an-grid{grid-template-columns:minmax(0,1fr)}}
.oe-bars{display:flex;flex-direction:column;gap:10px}
.oe-bar-row{display:grid;grid-template-columns:130px minmax(0,1fr) 150px;gap:12px;align-items:center;font-size:13px}
.oe-bar-lbl{color:var(--slate)}
.oe-bar-track{height:12px;background:var(--track);border-radius:999px;overflow:hidden}
.oe-bar-fill{height:100%;border-radius:999px;min-width:2px}
.oe-bar-val{text-align:right;white-space:nowrap}.oe-bar-val b{color:var(--ink)}
.oe-bar-btn{background:none;border:0;padding:4px 6px;margin:-4px -6px;border-radius:8px;cursor:pointer;text-align:left;width:calc(100% + 12px);font:inherit;color:inherit}
.oe-bar-btn:hover{background:var(--hover)}.oe-bar-btn.on{background:var(--teal-50);box-shadow:inset 0 0 0 1px var(--teal-100)}
.oe-bar-btn .oe-bar-lbl{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oe-dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:middle;flex:none}
.oe-bar-btn .oe-dot{margin-right:0}
.oe-months{display:flex;align-items:flex-end;gap:10px;height:200px;overflow-x:auto;padding-top:6px}
.oe-month{flex:1 0 44px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-width:44px}
.oe-month-bar{width:70%;max-width:44px;display:flex;flex-direction:column-reverse;border-radius:6px 6px 2px 2px;overflow:hidden}
.oe-month-amt{font-size:11.5px;color:var(--muted)}.oe-month-lbl{font-size:11.5px;color:var(--slate);white-space:nowrap}
.oe-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:12.5px;color:var(--slate)}
.oe-share{display:grid;grid-template-columns:minmax(0,1fr) 52px;gap:10px;align-items:center}.oe-share .num{text-align:right;font-size:12.5px}
.oe-table tr.oe-core td:first-child{box-shadow:inset 3px 0 0 var(--teal)}

.oe-step-row{grid-template-columns:130px minmax(0,1fr) 190px}
.oe-file{display:inline-flex;align-items:center;gap:6px;max-width:260px;padding:3px 6px 3px 9px;border:1px solid var(--line-2);border-radius:999px;background:var(--surface);font-size:12.5px}
.oe-file .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.oe-file button{border:0;background:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0 3px;border-radius:50%}
.oe-file button:hover{color:var(--red)}
.oe-doclinks{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.oe-doclink{display:inline-flex;align-items:center;gap:5px;max-width:240px;padding:3px 10px;border-radius:999px;border:1px solid var(--teal-100);background:var(--teal-50);color:var(--teal-d);font-size:12.5px;cursor:pointer;font-weight:500}
.oe-doclink:hover{border-color:var(--teal)}.oe-doclink span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oe-btn.bad-btn{border-color:var(--red);color:var(--red)}
.oe-choice{display:grid;gap:10px}
.oe-choice-opt{display:grid;grid-template-columns:44px minmax(0,1fr);gap:14px;align-items:center;text-align:left;padding:16px 18px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);cursor:pointer;font:inherit;color:inherit}
.oe-choice-opt:hover{border-color:var(--teal);box-shadow:0 0 0 1px var(--teal)}
.oe-choice-opt b{display:block;color:var(--ink);font-size:15px;margin-bottom:2px}
.oe-choice-ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--teal-50);color:var(--teal-d)}
.oe-choice-opt.danger:hover{border-color:var(--red);box-shadow:0 0 0 1px var(--red)}
.oe-choice-opt.danger .oe-choice-ic{background:var(--red-bg);color:var(--red)}
.oe-money{display:grid;gap:4px;min-width:220px;padding:10px 12px;border-radius:10px;background:var(--sunk);border:1px solid var(--line)}
.oe-money div{display:flex;justify-content:space-between;gap:16px;font-size:13px;color:var(--muted)}
.oe-money div.strong{color:var(--ink);font-weight:600;border-top:1px solid var(--line);padding-top:4px;margin-top:2px}
.oe-return-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}
.oe-return-head .sub{display:block;margin-top:4px}
.oe-table td.oe-particulars{min-width:140px;max-width:260px;white-space:normal;overflow-wrap:anywhere}
.oe-returned{margin-top:6px;padding:8px 10px;border-radius:8px;background:var(--sunk);border:1px dashed var(--line);display:grid;gap:2px;font-size:12.5px}
.oe-returned b{color:var(--ink)}
.oe-docwrap{display:inline-flex;align-items:center;gap:2px}
.oe-docx{border:0;background:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:2px 5px;border-radius:50%}
.oe-docx:hover{color:var(--red);background:var(--red-bg)}
.oe-docmissing{display:inline-flex;align-items:center;gap:5px;margin-top:6px;font-size:12.5px;color:var(--red);font-weight:500}
.oe-viewer{display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;min-height:min(70vh,760px)}
.oe-viewer-list{display:flex;flex-direction:column;gap:6px;overflow:auto}
.oe-viewer-list button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);cursor:pointer;font:inherit}
.oe-viewer-list button[aria-current=true]{border-color:var(--teal);box-shadow:0 0 0 1px var(--teal)}
.oe-viewer-list .nm{font-weight:500;color:var(--ink);font-size:13px;word-break:break-all}
.oe-viewer-stage{border:1px solid var(--line);border-radius:var(--r);background:var(--sunk);display:flex;align-items:center;justify-content:center;overflow:auto;min-height:min(70vh,760px)}
.oe-viewer-stage img{max-width:100%;max-height:min(70vh,760px);object-fit:contain;background:#fff}
.oe-viewer-stage iframe,.oe-viewer-stage object{width:100%;height:min(70vh,760px);border:0;background:#fff}
@media (max-width:760px){.oe-viewer{grid-template-columns:1fr}.oe-viewer-list{flex-direction:row;overflow-x:auto}}
.oe-lines{overflow:visible}
.oe-lgrid{display:grid;grid-template-columns:28px minmax(110px,.9fr) minmax(110px,.85fr) minmax(140px,1.15fr) minmax(120px,.9fr) minmax(120px,1fr) minmax(160px,1.8fr) 96px;gap:8px;align-items:center}
.oe-lines-h{padding:9px 14px;background:var(--sunk);border-bottom:1px solid var(--line);border-radius:var(--r) var(--r) 0 0;font-size:12.5px;font-weight:500;color:var(--muted)}
.oe-lines-h .r{text-align:right}
.oe-lrow{padding:10px 14px;border-bottom:1px solid var(--row)}
.oe-lrow.bad{box-shadow:inset 3px 0 0 var(--red)}
.oe-lrow .oe-line-no{width:26px;height:26px;font-size:12.5px}
.oe-lrow-act{display:flex;gap:2px;justify-content:flex-end}
.oe-lsub{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin:8px 0 0 36px;font-size:13px}
.oe-lsub-item{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.oe-lsub .oe-input{height:32px}
.oe-lcheck{gap:8px}
.oe-calc-gap{margin-left:8px}.oe-calc-eq{margin-left:4px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.oe-lerr{color:var(--red);font-weight:500}
.oe-lines-f{padding:10px 14px}
.oe-combo{position:relative;min-width:0}
.oe-combo .oe-input{padding-right:28px;font-variant-numeric:tabular-nums}
.oe-filters .oe-combo .oe-input{width:100%;min-width:0}
.oe-combo-caret{position:absolute;right:9px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;display:flex}
.oe-combo-list{position:absolute;left:0;top:calc(100% + 4px);z-index:95;overscroll-behavior:contain;min-width:max(100%,170px);max-height:260px;overflow:auto;margin:0;padding:4px;list-style:none;background:var(--surface);border:1px solid var(--line-2);border-radius:8px;box-shadow:0 12px 28px rgba(0,30,45,.18)}
.oe-combo-list li{padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.oe-combo-list li.on{background:var(--teal-50);color:var(--teal-d)}
.oe-combo-list li.picked{font-weight:600}
.oe-combo-list li.none{color:var(--muted);cursor:default;white-space:normal}
.oe-combo-list li.all{color:var(--muted);border-bottom:1px solid var(--row);border-radius:6px 6px 0 0;margin-bottom:2px}
@media (max-width:1060px){
.oe-lines-h{display:none}
.oe-lgrid{grid-template-columns:28px repeat(3,minmax(0,1fr))}
.oe-lgrid>.oe-line-no{grid-row:span 3}
.oe-lgrid>.oe-lf:nth-last-child(2)>*{grid-column:span 2}
.oe-lsub{margin-left:36px}
}
.oe-total{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px;position:sticky;bottom:calc(12px + env(safe-area-inset-bottom,0px));box-shadow:0 8px 24px rgba(0,30,45,.08)}
.oe-total b{font-size:20px;color:var(--ink);font-variant-numeric:tabular-nums}
.oe-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.oe-timeline li{display:grid;grid-template-columns:14px 1fr;gap:12px;padding-bottom:14px;position:relative}
.oe-timeline li::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--teal);margin-top:6px;margin-left:2px}
.oe-timeline li::after{content:"";position:absolute;left:6px;top:18px;bottom:0;width:1px;background:var(--line)}
.oe-timeline li:last-child::after{display:none}
.oe-timeline b{color:var(--ink);font-weight:500}.oe-timeline small{display:block;color:var(--muted);font-size:12px}
.oe-signin{position:relative;isolation:isolate;min-height:100vh;display:grid;grid-template-columns:minmax(0,440px);justify-content:center;align-content:center;padding:48px 24px 88px;overflow:hidden;background:radial-gradient(110% 90% at 24% 38%,#0b4338 0%,#002c46 52%,#011f31 100%)}
.oe-topo{position:absolute;inset:0;width:100%;height:100%;z-index:-1;animation:oe-topo-in 1.6s cubic-bezier(.2,.7,.2,1) both}
.oe-topo .minor{fill:none;stroke:#8fd6cc;stroke-opacity:.17;stroke-width:1;stroke-linecap:round}
.oe-topo .major{fill:none;stroke:#b5e8e1;stroke-opacity:.36;stroke-width:1.7;stroke-linecap:round}
.oe-topo .bm path,.oe-topo .bm circle{fill:none;stroke:#d6f2ee;stroke-opacity:.6;stroke-width:1.5}
.oe-topo .bm circle{fill:#d6f2ee;fill-opacity:.6}
@keyframes oe-topo-in{from{opacity:0;transform:scale(1.035)}to{opacity:1;transform:none}}
.oe-signin-card{grid-column:1;position:relative;background:var(--surface);color:var(--body);border-radius:20px;padding:34px 34px 30px;box-shadow:0 32px 80px rgba(0,12,22,.5),0 0 0 1px rgba(255,255,255,.07);animation:oe-pop .5s .2s ease-out both}
.oe-signin-card .oe-login-card{display:flex;flex-direction:column;gap:16px}
.oe-login-or{display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.oe-login-or::before,.oe-login-or::after{content:"";flex:1;height:1px;background:var(--line)}
.oe-captcha{min-height:65px;display:flex;justify-content:center}
.oe-captcha:empty{display:none}
.oe-signin-card h2{font-size:24px;letter-spacing:-.015em}
.oe-signin-mark{display:block;margin-bottom:20px}
.oe-signin-mark rect{fill:var(--teal-50)}
.oe-signin-mark g{fill:none;stroke:var(--teal-d);stroke-width:1.6}
.oe-signin-foot{position:absolute;left:0;right:0;bottom:calc(26px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;justify-content:center;gap:8px;color:rgba(214,242,238,.66);font-size:13px}
.oe-label-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.oe .oe-forgot{background:none;border:0;padding:4px 0;font:inherit;font-size:12.5px;font-weight:500;color:var(--blue);cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.oe .oe-forgot:hover{color:var(--ink)}
.oe-pass{position:relative}.oe-pass .oe-input{padding-right:68px}
.oe-invite-who{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--sunk)}
.oe-pass button{position:absolute;right:5px;top:50%;transform:translateY(-50%);height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--teal-d);font-size:12.5px;font-weight:500;cursor:pointer}
.oe-pass button:hover{background:var(--teal-50)}
.oe-demo-users{display:grid;gap:8px}
.oe-demo-users button{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;cursor:pointer;text-align:left}
.oe-demo-users button:hover{border-color:var(--teal)}
.oe-center{min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center}
.oe-scrim{display:none}
.oe-matrix td.c,.oe-matrix th.c{text-align:center}
.oe-print-preview{border:1px solid var(--line);border-radius:8px;padding:28px;background:#fff;overflow:auto}
.oe-print-root{display:none}
.oe-form{font-family:Poppins,Arial,sans-serif;color:#111;font-size:11.5px;line-height:1.4;min-width:640px}
.oe-form .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #002c46;padding-bottom:10px;margin-bottom:12px}
.oe-form .ttl{font-size:15px;font-weight:700;color:#002c46}
.oe-form .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 18px;margin-bottom:12px}
.oe-form .meta span{color:#555;display:block;font-size:10.5px}.oe-form .meta b{font-weight:600}
.oe-form table{width:100%;border-collapse:collapse;margin-bottom:14px}
.oe-form th,.oe-form td{border:1px solid #9aa9ae;padding:5px 6px;text-align:left;vertical-align:top}
.oe-form th{background:#e9f0ef;font-weight:600;font-size:10.5px}.oe-form td.r,.oe-form th.r{text-align:right}
.oe-form .appr{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:18px}
.oe-form .appr div{border:1px solid #c9d3d5;border-radius:4px;padding:8px 10px}
.oe-form .appr span{display:block;color:#555;font-size:10.5px}.oe-form .appr b{display:block;font-size:12.5px;margin:2px 0}
.oe-form .foot{margin-top:18px;font-size:10px;color:#666;display:flex;justify-content:space-between}
@media print{body>*:not(.oe-print-root){display:none!important}.oe-print-root{display:block!important}@page{size:A4 portrait;margin:12mm}}
@media (max-width:1100px){.oe-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.oe-split{grid-template-columns:1fr}.oe-queue{position:static;max-height:none}}
@media (max-width:767px){
.oe-shell{grid-template-columns:1fr}
.oe-side{position:fixed;inset:0 auto 0 0;width:min(300px,86vw);z-index:60;padding-top:calc(24px + env(safe-area-inset-top,0px));padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-102%);transition:transform .2s ease}
.oe-side.open{transform:none}
.oe-side-toggle{display:none}
.oe-scrim{display:block;position:fixed;inset:0;background:rgba(0,20,30,.4);z-index:55}
.oe-topbar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--navy);color:#fff;position:sticky;top:env(safe-area-inset-top,0px);z-index:40}
.oe-topbar button{background:transparent;border:0;color:#fff;display:grid;place-items:center;width:36px;height:36px;border-radius:8px;cursor:pointer}
.oe-page{padding:20px 16px 48px}.oe-demo{padding:8px 16px}
.oe-signin{grid-template-columns:minmax(0,1fr);justify-items:center;align-content:center;gap:22px;padding:28px 16px calc(24px + env(safe-area-inset-bottom,0px))}.oe-signin-card{grid-column:1;width:100%;max-width:440px;padding:28px 22px 24px}.oe-signin-foot{position:static}
/* phones: finger-sized controls, 16px fields (no iPhone zoom), notch and home-bar spacing */
.oe-page{padding:20px max(16px,env(safe-area-inset-right,0px)) calc(48px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}
.oe-push{padding:12px 16px}.oe-push .oe-actions{width:100%}.oe-push .oe-actions .oe-btn{flex:1 1 auto}
/* phones: the update notice sits at the top, clear of the bottom action bars */
.oe-update{top:calc(8px + env(safe-area-inset-top,0px));bottom:auto;left:8px;right:8px;transform:none;width:auto;max-width:none}
.oe-update-t{flex:1 1 auto}.oe-update button{min-height:40px}
.oe-side-x{display:grid;place-items:center;position:absolute;top:calc(10px + env(safe-area-inset-top,0px));right:8px;width:44px;height:44px;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer}
.oe .oe-input,.oe .oe-select,.oe .oe-textarea{font-size:16px;height:44px}
.oe .oe-textarea{height:auto;min-height:88px}
.oe-lsub .oe-input{height:44px}
.oe .oe-btn{height:44px;font-size:14px}.oe .oe-btn.sm{height:40px}.oe-btn.icon{width:44px}.oe-btn.sm.icon{width:40px}
.oe-doclink,.oe-file{min-height:40px;padding-top:4px;padding-bottom:4px}
.oe-head .oe-actions{width:100%}.oe-head .oe-actions .oe-btn{flex:1 1 auto}
.oe-tabs{flex-wrap:wrap;overflow:visible;gap:0 2px}
.oe-tabs button{min-height:44px;padding:10px 12px}
.oe input[type=checkbox],.oe input[type=radio]{width:22px;height:22px}
.oe-check{min-height:44px}
.oe-nav button{padding:12px 10px;font-size:15px}
.oe-me button{padding:10px 14px;font-size:14px}
.oe-topbar button{width:44px;height:44px}
.oe-pass button{height:36px;padding:0 12px}.oe-pass .oe-input{padding-right:76px}
.oe-file button,.oe-docx{min-width:36px;min-height:36px;display:inline-grid;place-items:center}
.oe-demo-users button{min-height:56px}
.oe-kpi{min-height:48px}
.oe-combo-list li{padding:11px 10px;font-size:15px}
.oe-bar-btn{padding:8px 6px;margin:-8px -6px}
.oe-viewer-list button{min-height:44px}
/* drawers and dialogs: close button top right, full width */
.oe-drawer{width:100vw}
.oe-drawer-h{flex-wrap:wrap;padding:10px 12px 12px 16px;gap:6px 8px}
.oe-drawer-h>div:first-child{flex:1 1 100%;order:2}
.oe-drawer-h .oe-actions{order:1;width:100%;justify-content:flex-end;flex-wrap:nowrap}
.oe-drawer-b{padding:14px 16px 32px}
.oe-modal{width:calc(100vw - 16px);max-height:calc(100vh - 16px)}
.oe-modal-h{padding:16px 14px 10px 18px}.oe-modal-b{padding:4px 18px 16px}.oe-modal-f{padding:12px 14px}
.oe-modal-f .oe-btn{flex:1 1 auto}
/* tables: a pinned first column and scroll shadows; .cards tables become stacked cards */
.oe-tablewrap,.oe-scrollx{overflow-x:auto;-webkit-overflow-scrolling:touch;background:linear-gradient(90deg,var(--surface) 30%,rgba(255,255,255,0)),linear-gradient(90deg,rgba(255,255,255,0),var(--surface) 70%) 100% 0,radial-gradient(farthest-side at 0 50%,rgba(0,30,45,.2),rgba(0,30,45,0)),radial-gradient(farthest-side at 100% 50%,rgba(0,30,45,.2),rgba(0,30,45,0)) 100% 0;background-color:var(--surface);background-repeat:no-repeat;background-size:40px 100%,40px 100%,14px 100%,14px 100%;background-attachment:local,local,scroll,scroll}
.oe-tablewrap{max-height:none!important}
.oe-table:not(.cards) th:first-child,.oe-table:not(.cards) td:first-child{position:sticky;left:0;z-index:2;background:var(--surface);box-shadow:1px 0 0 var(--line)}
.oe-table:not(.cards) th:first-child{z-index:3;background:var(--sunk)}
.oe-table:not(.cards) tfoot td:first-child{background:var(--sunk)}
.oe-table:not(.cards) tr.grp td:first-child{background:var(--grp)}
.oe-table:not(.cards) tr.sel td:first-child{background:var(--hover)}
.oe-table:not(.cards) tr.focus td:first-child{background:var(--amber-bg)}
.oe-table.cards,.oe-table.cards tbody,.oe-table.cards tfoot,.oe-table.cards tr{display:block}
.oe-table.cards thead{display:none}
.oe-table.cards tr{padding:10px 14px 12px;border-bottom:1px solid var(--line)}
.oe-table.cards tbody tr:last-child{border-bottom:0}
.oe-table.cards td{display:grid;grid-template-columns:minmax(92px,36%) minmax(0,1fr);gap:4px 10px;padding:5px 0;border:0;text-align:left;white-space:normal;min-width:0!important;max-width:none}
.oe-table.cards td::before{content:attr(data-th);color:var(--muted);font-size:12.5px;line-height:1.5;padding-top:1px}
.oe-table.cards td.lead{display:block;padding:0 0 6px}
.oe-table.cards td.lead::before{display:none}
.oe-table.cards td.none,.oe-table.cards td:empty{display:none}
.oe-table.cards td.r,.oe-table.cards td.c{text-align:left}
.oe-table.cards tr.grp td{display:block}
.oe-table.cards tr.focus td{background:transparent}.oe-table.cards tr.focus{background:var(--amber-bg)}
.oe-table.cards tfoot tr{background:var(--sunk);border-top:1px solid var(--line)}
.oe-table.cards tfoot td{font-weight:600;color:var(--ink)}
.oe-table.cards .oe-chip.status{width:auto}
.oe-table.cards .oe-usage{min-width:0}
.oe-table.cards .oe-clip{max-width:none;white-space:normal}
.oe-table.cards td .oe-input{max-width:220px}
/* approvals: approve and reject stay in reach; new request: labelled line fields and a bottom bar */
.oe-approve-bar{position:sticky;bottom:0;z-index:3;background:var(--surface);margin:0 -18px -16px;padding:10px 18px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line)}
.oe-approve-bar .oe-btn{flex:1 1 auto}
.oe-approve-float{display:flex;gap:8px;margin:0 -16px -32px;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}
.oe-lgrid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 8px}
.oe-lgrid>.oe-line-no{grid-column:1;grid-row:1}
.oe-lgrid>.oe-lrow-act{grid-column:2;grid-row:1;justify-content:flex-end}
.oe-lgrid>.oe-lf:nth-child(2),.oe-lgrid>.oe-lf:nth-child(7){grid-column:span 2}
.oe-lf{display:flex;flex-direction:column;gap:4px;min-width:0}
.oe-lf-t{display:block;font-size:12.5px;font-weight:500;color:var(--slate)}
.oe-lsub{margin-left:0}
.oe.oe .oe-phone-only{display:flex}
.oe-total{padding:12px 16px}.oe-total .oe-btn{flex:1 1 auto}
}
@media (max-width:760px){.oe-grid>*{grid-column:span 12!important}.oe-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.oe-strip>div:nth-child(odd){border-left:0}.oe-search{max-width:none}}
@media (prefers-reduced-motion:reduce){.oe-drawer,.oe-modal,.oe-toast,.oe-modal.nudge,.oe-drawer.nudge,.oe-topo,.oe-signin-card{animation:none}.oe *{transition:none!important}}
`;

/* ---------------------------------------------------------------------
   7. UI PRIMITIVES
   --------------------------------------------------------------------- */
const ICONS = {
  report: <path d="M4 20V11M10 20V5M16 20v-6M21 20H3" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  sliders: (
    <>
      <path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2" />
      <circle cx="14" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </>
  ),
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  bell: <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />,
  collapse: <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />,
  expand: <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  print: <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  up: <path d="m18 15-6-6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  alert: <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  dup: <path d="M8 8h11v11H8zM5 16V5h11" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  back: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  clip: <path d="M20.5 12.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

/* Screen sizes. PHONE_QUERY is the phone layout in the stylesheet (slide-out menu, stacked tables, 16px fields);
   TABLET_QUERY is the band where the side panel is always the icon strip. */
const PHONE_QUERY = "(max-width:767px)";
const TABLET_QUERY = "(min-width:768px) and (max-width:960px)";
function useMediaQuery(query) {
  const read = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (!(typeof window !== "undefined" && window.matchMedia)) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, [query]);
  return matches;
}
const useIsPhone = () => useMediaQuery(PHONE_QUERY);

/** Text a mouse shows on hover; a tap shows it under the element, since touch screens have no hover. */
function TapHint({ hint, children, className = "" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => setOpen(false), 4000);
    return () => clearTimeout(t);
  }, [open]);
  if (!hint) return <span className={className}>{children}</span>;
  return (
    <span className={`oe-hint ${className}`} title={hint} onClick={() => setOpen((v) => !v)}>
      {children}
      {open && (
        <span className="oe-tip" role="status">
          {hint}
        </span>
      )}
    </span>
  );
}

/** Filter row. On a phone it folds behind a "Filters" bar so the list starts near the top of the screen. */
function Filters({ children, style }) {
  const phone = useIsPhone();
  const row = (
    <div className={"oe-filters"} style={style}>
      {children}
    </div>
  );
  if (!phone) return row;
  return (
    <details className="oe-fold">
      <summary>Filters and search</summary>
      {row}
    </details>
  );
}

function Button({ variant = "secondary", size = "", icon, children, className = "", busy, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={busy || rest.disabled}
      className={`oe-btn ${variant} ${size} ${children ? "" : "icon"} ${className}`}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {busy ? "Working…" : children}
    </button>
  );
}

function Field({ label, hint, error, span = 12, children, as = "label" }) {
  const Tag = as;
  return (
    <Tag className={`oe-field span-${span}`}>
      {label && <span className="oe-label">{label}</span>}
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </Tag>
  );
}

function MoneyInput({ value, onChange, className = "", ...rest }) {
  const [focus, setFocus] = useState(false);
  const [draft, setDraft] = useState("");
  const shown = focus
    ? draft
    : value == null || value === ""
    ? ""
    : Number(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <input name="shown"
      {...rest}
      className={`oe-input num ${className}`}
      inputMode="decimal"
      value={shown}
      onFocus={(e) => {
        // keep the text exactly as shown so the browser's own selection (e.g. after Tab) survives;
        // commas are ignored when the amount is read
        setFocus(true);
        setDraft(e.target.value);
        rest.onFocus && rest.onFocus(e);
      }}
      onBlur={(e) => {
        setFocus(false);
        rest.onBlur && rest.onBlur(e);
      }}
      onChange={(e) => {
        const typed = e.target.value.replace(/[^0-9.,]/g, "");
        let raw = typed.replace(/,/g, "");
        const dot = raw.indexOf(".");
        if (dot >= 0) raw = raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, "");
        setDraft(typed);
        onChange(raw === "" || raw === "." ? null : Number(raw));
      }}
    />
  );
}

function Chip({ tone = "muted", children, plain, className = "", title }) {
  return <span className={`oe-chip tone-${tone} ${plain ? "plain" : ""} ${className}`} title={title}>{children}</span>;
}

function StatusChip({ status }) {
  const s = STATUS[status] || { label: status, tone: "muted" };
  return (
    <TapHint hint={s.hint}>
      <Chip tone={s.tone} className="status">
        {s.label}
      </Chip>
    </TapHint>
  );
}

function LimitChip({ state, over }) {
  if (!state) return null;
  const text = state === "over" && over > 0 ? `Exceeds by ${compact(over)}` : LIMIT_LABEL[state];
  return <Chip tone={LIMIT_TONE[state]}>{text}</Chip>;
}

function Note({ tone = "", icon = "info", children }) {
  return (
    <div className={`oe-note ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon} size={16} />
      <div>{children}</div>
    </div>
  );
}

/** The allocation meter: solid = approved to date, hatched = in approval, tick = limit when exceeded. */
function Meter({ alloc, used, pending = 0, near = 90, size = "" }) {
  const scale = Math.max(alloc, used + pending, 1);
  const usedW = Math.min(100, (used / scale) * 100);
  const pendW = Math.max(0, Math.min(100 - usedW, (pending / scale) * 100));
  const state = alloc <= 0 ? (used > 0 ? "over" : "") : used > alloc + 0.004 ? "over" : used >= (alloc * near) / 100 ? "near" : "";
  const label = alloc > 0 ? `${money(used)} of ${money(alloc)} used${pending ? `, ${money(pending)} in approval` : ""}` : `${money(used)} used, no allocation`;
  return (
    <TapHint hint={label} className="oe-meter-wrap">
      <div className={`oe-meter ${state} ${size}`} role="img" aria-label={label}>
        <div className="used" style={{ width: usedW + "%" }} />
        {pendW > 0 && <div className="pend" style={{ left: usedW + "%", width: pendW + "%" }} />}
        {alloc > 0 && used + pending > alloc + 0.004 && <div className="tick" style={{ left: `calc(${(alloc / scale) * 100}% - 1px)` }} />}
      </div>
    </TapHint>
  );
}

function UsageCell({ alloc, used, pending, near }) {
  if (alloc <= 0 && used <= 0 && !(pending > 0)) return <span className="muted">—</span>;
  const over = used - alloc;
  return (
    <div className="oe-usage">
      <div className="oe-usage-t">
        <b className="num">{compact(used)}</b>
        <span className="num">of {alloc > 0 ? compact(alloc) : "no limit"}</span>
      </div>
      <Meter alloc={alloc} used={used} pending={pending} near={near} />
      {alloc > 0 && over > 0.004 ? (
        <span className="note over">Over by {compact(over)}</span>
      ) : alloc <= 0 && used > 0 ? (
        <span className="note over">Spent without allocation</span>
      ) : pending > 0 ? (
        <span className="note">{compact(pending)} in approval</span>
      ) : null}
    </div>
  );
}

const layerStack = [];
function useLayer(onClose, ref, focusFirst = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const id = uid();
    layerStack.push(id);
    const prev = document.activeElement;
    const el = ref.current;
    const first = el && el.querySelector(focusFirst ? "[data-autofocus], input:not([type=hidden]):not([disabled]):not([readonly]), select, textarea" : "[data-autofocus]");
    (first || el) && (first || el).focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === "Escape" && layerStack[layerStack.length - 1] === id) {
        e.stopPropagation();
        closeRef.current && closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = layerStack.indexOf(id);
      if (i >= 0) layerStack.splice(i, 1);
      if (prev && prev.focus) prev.focus({ preventScroll: true });
    };
  }, [ref]);
}

/** Clicking the backdrop never closes a window (typed data would be lost);
    it only nudges the window. Close with X, Cancel or Esc. */
function useNudge() {
  const [on, setOn] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onBackdrop = (e) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault(); // keep focus in the field being edited
    setOn(false);
    requestAnimationFrame(() => setOn(true));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 400);
  };
  return [on ? "nudge" : "", onBackdrop];
}

const DISCARD_NEW = "Anything entered here will be lost.";
const DISCARD_EDIT = "Your changes here will be lost.";

/** Closing a window with unsaved input asks first, like the ordering system. */
function useGuardedClose(onClose, dirty, discardTitle, discardBody) {
  const ui = useUI();
  const asking = useRef(false);
  return useCallback(async () => {
    if (!dirty || !ui) return onClose && onClose();
    if (asking.current) return;
    asking.current = true;
    const a = await ui.confirm({
      title: discardTitle || "Discard your changes?",
      body: discardBody || DISCARD_NEW,
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "danger",
      focusCancel: true,
      width: 420,
    });
    asking.current = false;
    if (a !== null && onClose) onClose();
  }, [dirty, onClose, ui, discardTitle, discardBody]);
}

/** footer may be a function: it receives the guarded close for the Cancel button. */
function Modal({ title, subtitle, onClose, children, footer, width = 560, dirty = false, discardTitle, discardBody, className = "" }) {
  const ref = useRef(null);
  const requestClose = useGuardedClose(onClose, dirty, discardTitle, discardBody);
  useLayer(requestClose, ref);
  const [nudge, onBackdrop] = useNudge();
  const foot = typeof footer === "function" ? footer(requestClose) : footer;
  return (
    <div className="oe-overlay" onMouseDown={onBackdrop}>
      <div className={`oe-modal ${nudge} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} style={{ "--w": typeof width === "number" ? width + "px" : width }}>
        <div className="oe-modal-h">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Button variant="ghost" icon="x" aria-label="Close" onClick={requestClose} />
        </div>
        <div className="oe-modal-b">{children}</div>
        {foot && <div className="oe-modal-f">{foot}</div>}
      </div>
    </div>
  );
}

function Drawer({ title, subtitle, onClose, children, actions, width = 800, dirty = false, discardTitle, discardBody }) {
  const ref = useRef(null);
  const requestClose = useGuardedClose(onClose, dirty, discardTitle, discardBody);
  useLayer(requestClose, ref, false);
  const [nudge, onBackdrop] = useNudge();
  return (
    <div className="oe-overlay" onMouseDown={onBackdrop}>
      <aside className={`oe-drawer ${nudge}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"} ref={ref} tabIndex={-1} style={{ "--w": typeof width === "number" ? width + "px" : width }}>
        <div className="oe-drawer-h">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="oe-actions">
            {actions}
            <Button variant="ghost" icon="x" aria-label="Close" onClick={requestClose} />
          </div>
        </div>
        <div className="oe-drawer-b">{children}</div>
      </aside>
    </div>
  );
}

function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="oe-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

function Empty({ title, body, action }) {
  return (
    <div className="oe-empty">
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

function PageHead({ title, desc, children }) {
  return (
    <div className="oe-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="oe-actions">{children}</div>}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="oe-search">
      <Icon name="search" size={16} />
      <input name="search" className="oe-input" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  );
}

function Pager({ page, pages, onPage, total }) {
  if (pages <= 1) return null;
  return (
    <div className="oe-actions" style={{ justifyContent: "space-between", marginTop: 12 }}>
      <span className="muted small">
        Page {page} of {pages}, {total} total
      </span>
      <div className="oe-actions">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/* Toasts and confirm dialogs */
const UICtx = createContext(null);
const useUI = () => useContext(UICtx);

function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dlg, setDlg] = useState(null);
  const [answer, setAnswer] = useState("");
  const push = useCallback((kind, text) => {
    const id = uid();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 7000 : 3600);
  }, []);
  const confirm = useCallback((opts) => {
    setAnswer("");
    return new Promise((resolve) => setDlg({ ...opts, resolve }));
  }, []);
  const value = useMemo(() => ({ ok: (t) => push("ok", t), err: (t) => push("err", t), confirm }), [push, confirm]);
  const close = (v) => {
    dlg.resolve(v);
    setDlg(null);
  };
  const needs = dlg && dlg.input && dlg.input.required && !answer.trim();
  return (
    <UICtx.Provider value={value}>
      {children}
      {dlg && (
        <Modal
          title={dlg.title}
          onClose={() => close(null)}
          width={dlg.width || 480}
          footer={
            <>
              <Button onClick={() => close(null)} data-autofocus={dlg.focusCancel ? true : undefined}>
                {dlg.cancelLabel || "Cancel"}
              </Button>
              <Button variant={dlg.tone === "danger" ? "danger solid" : "primary"} disabled={needs} onClick={() => close(answer.trim())} data-autofocus={dlg.input || dlg.focusCancel ? undefined : true}>
                {dlg.confirmLabel || "Confirm"}
              </Button>
            </>
          }
        >
          <div className="oe-stack">
            {dlg.body && <div>{dlg.body}</div>}
            {dlg.input && (
              <Field label={dlg.input.label} hint={dlg.input.required ? "Required" : "Optional"}>
                <textarea name="answer" className="oe-textarea" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={dlg.input.placeholder} />
              </Field>
            )}
          </div>
        </Modal>
      )}
      <div className="oe-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`oe-toast ${t.kind === "err" ? "err" : ""}`} role={t.kind === "err" ? "alert" : "status"}>
            <Icon name={t.kind === "err" ? "alert" : "check"} size={16} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </UICtx.Provider>
  );
}

/* ---------------------------------------------------------------------
   8. APP CONTEXT + SHARED PIECES
   --------------------------------------------------------------------- */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

const amt = (n) => (Math.abs(Number(n) || 0) < 0.005 ? "—" : (Number(n) < 0 ? "−" : "") + Math.abs(Number(n)).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const shortName = (s, n = 64) => (!s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s);

function ProjectOptions({ projects }) {
  const groups = useMemo(() => {
    const m = new Map();
    const sorted = [...projects].sort((a, b) => Number(a.is_internal) - Number(b.is_internal) || String(a.code).localeCompare(String(b.code)));
    for (const p of sorted) {
      const g = p.is_internal ? "Internal" : p.district || "No district";
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(p);
    }
    return [...m.entries()];
  }, [projects]);
  return groups.map(([g, ps]) => (
    <optgroup key={g} label={g}>
      {ps.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code}: {shortName(p.name)}
        </option>
      ))}
    </optgroup>
  ));
}

/** Pages with unsaved input ask before the user navigates away, signs out or closes the tab. */
/** The unsaved-changes guard of the open page, if any; read by UpdateBanner before it reloads the app. */
let activeLeaveGuard = null;
function useLeaveGuard(dirty, title, body) {
  const { setLeaveGuard } = useApp();
  useEffect(() => {
    setLeaveGuard(dirty ? { title, body } : null);
    return () => setLeaveGuard(null);
  }, [dirty, title, body, setLeaveGuard]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      if (window.__oeUpdating) return; // the person already chose to update and discard
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

const allocInitial = (idx, projectId) => {
  const o = {};
  for (const t of idx.types) {
    const k = projectId + "|" + t.id;
    o[t.id] = idx.allocMap.has(k) ? idx.allocMap.get(k) : null;
  }
  return o;
};

const setter = (setF) => (k) => (e) =>
  setF((x) => ({ ...x, [k]: e && e.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e }));

/* ---------------------------------------------------------------------
   9. PROJECT REPORT
   --------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Project report to Excel: 1 Records (every line), 2 Summary (as on screen),
   3 By expense type. Summary figures are SUMIFS formulas over Records, so any
   amount can be traced back to its lines.
   --------------------------------------------------------------------- */
const XL = {
  navy: "FF002C46", teal: "FF277876", tealD: "FF1D5F5D", tealBg: "FFE4F0EE", tealMid: "FFCDE3E0", line: "FFD7E1DF",
  muted: "FF5D7480", red: "FFB42318", redBg: "FFFDE7E4", amber: "FF8A5A00", amberBg: "FFFFF1D6", white: "FFFFFFFF",
};
const XL_PESO = '"₱"#,##0.00;[Red]-"₱"#,##0.00;"–"';
const XL_PCT = '0%;[Red]-0%;"–"';
const XL_DATE = "d mmm yyyy";
const COUNT_APPROVED = "Approved to date";
const COUNT_PENDING = "In approval";
const COUNT_NONE = "Not counted";
const xlDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(localDate(iso)).split("-").map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
};
const xlCol = (n) => {
  let out = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};
const xlStr = (v) => `"${String(v).replace(/"/g, '""')}"`; // a text value inside a formula

/** One row per request line on the report's projects; a reclassified line also gets a row per project it was split to. */
function reportRecords(projectIds, data, idx) {
  const out = [];
  for (const r of data.requests) {
    const reqStatus = (STATUS[displayStatus(r, idx)] || {}).label || r.status;
    for (const l of r.lines) {
      const t = idx.typesById.get(l.type_id) || {};
      const c = idx.cats.get(l.category_id || t.category_id) || {};
      const counts = l.status === "on_hold" ? COUNT_PENDING : ["open", "disbursed", "part_paid", "paid", "closed"].includes(l.status) ? COUNT_APPROVED : COUNT_NONE;
      const full = counts === COUNT_PENDING ? Number(l.amount) : counts === COUNT_APPROVED ? lineNet(l) : 0;
      const parts = l.reclass || [];
      const moved = counts === COUNT_NONE ? 0 : parts.reduce((a, x) => a + Number(x.amount), 0);
      const home = idx.projects.get(l.project_id) || { code: "", name: "" };
      const base = {
        ref: r.ref_no, line_no: l.line_no, request_date: r.request_date, requested_by: r.liaison_name || "", category: c.name || "", type: t.name || "",
        payee: l.payee || "", remarks: l.description || "", line_status: (STATUS[l.status] || {}).label || l.status, counts,
        request_status: reqStatus, approved_by: r.approved_by_name || "", approved_on: r.approved_at, erp: r.erp_ref || "",
        disbursed_on: r.disbursed_date, paid_on: l.paid_date,
      };
      if (projectIds.has(l.project_id))
        out.push({
          ...base, project: home, requested: Number(l.amount),
          approved: counts === COUNT_PENDING || l.approved_amount == null ? null : Number(l.approved_amount),
          paid: linePaid(l) > 0 ? linePaid(l) : null,
          returned: lineReturned(l) > 0 ? lineReturned(l) : null,
          counted: round2(full - moved),
          note: [
            ...[...(l.returns || [])]
              .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
              .map((x) => `${money(x.amount)} returned ${fmtDate(x.return_date)}, ref ${x.ref}: ${x.reason}${x.created_by_name ? ` (recorded by ${x.created_by_name})` : ""}`),
            l.status === "part_paid" && `${money(lineWithLiaison(l))} still with the liaison, to be returned`,
            parts.length && "Reclassified to " + parts.map((x) => `${(idx.projects.get(x.project_id) || {}).code} (${money(x.amount)})`).join(", "),
          ]
            .filter(Boolean)
            .join(". "),
        });
      for (const x of parts)
        if (projectIds.has(x.project_id))
          out.push({
            ...base, project: idx.projects.get(x.project_id) || { code: "", name: "" }, requested: null, approved: null, paid: null, returned: null,
            counted: counts === COUNT_NONE ? 0 : Number(x.amount), note: `Reclassified from ${home.code}, line ${l.line_no}`,
          });
    }
  }
  return out.sort(
    (a, b) =>
      Number(!!a.project.is_internal) - Number(!!b.project.is_internal) ||
      String(a.project.code).localeCompare(String(b.project.code)) ||
      String(a.request_date).localeCompare(String(b.request_date)) ||
      String(a.ref).localeCompare(String(b.ref)) ||
      a.line_no - b.line_no
  );
}

async function exportReportWorkbook({ rows, data, idx, near, me, filterText }) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  const L = xlCol;
  const nearFrac = (Number(near) || 90) / 100;
  const recs = reportRecords(new Set(rows.map((x) => x.p.id)), data, idx);
  const stamp = `Exported ${fmtDateTime(new Date().toISOString())} by ${me.full_name || me.email}. ${filterText}`;
  const cats = idx.categories.filter((c) => c.is_active);
  const sumRecs = (code, cat, type, counts) =>
    round2(recs.reduce((a, x) => (x.project.code === code && x.category === cat && (type == null || x.type === type) && x.counts === counts ? a + x.counted : a), 0));

  const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const thin = { style: "thin", color: { argb: XL.line } };
  const intro = (ws, title, sub) => {
    ws.getCell("A1").value = title;
    ws.getCell("A1").font = { bold: true, size: 16, color: { argb: XL.navy } };
    ws.getCell("A2").value = sub;
    ws.getCell("A3").value = stamp;
    for (const a of ["A2", "A3"]) ws.getCell(a).font = { size: 10, color: { argb: XL.muted } };
  };
  const head = (cell, text, fill = XL.navy, color = XL.white) => {
    cell.value = text;
    cell.font = { bold: true, color: { argb: color } };
    cell.fill = solid(fill);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { top: thin, bottom: thin, left: thin, right: thin };
  };
  const usedRules = (ws, ref, first) => {
    // bar = share of the allocation used; amber from the "near limit" level, red once over
    ws.addConditionalFormatting({
      ref,
      rules: [
        { type: "expression", priority: 1, formulae: [`AND(ISNUMBER(${first}),${first}>1)`], style: { font: { bold: true, color: { argb: XL.red } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: XL.redBg } } } },
        { type: "expression", priority: 2, formulae: [`AND(ISNUMBER(${first}),${first}>=${nearFrac})`], style: { font: { bold: true, color: { argb: XL.amber } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: XL.amberBg } } } },
        { type: "dataBar", priority: 3, gradient: false, cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }], color: { argb: "FF6FB3AE" } },
      ],
    });
  };
  const print = (ws, titles) => {
    ws.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: titles, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
  };

  /* ---- 1. Records ---- */
  const R = wb.addWorksheet("Records", { views: [{ state: "frozen", xSplit: 1, ySplit: 5 }], properties: { tabColor: { argb: XL.teal } } });
  intro(R, "Records", 'Every request line on the projects in the report. "Counts as" shows where each amount lands on the Summary and By expense type sheets.');
  const RC = [
    ["Project ID", 17], ["Project name", 40], ["District", 12], ["Year", 7], ["Reference", 16], ["Request date", 13, XL_DATE], ["Requested by", 15],
    ["Category", 12], ["Expense type", 20], ["Payee", 24], ["Remarks", 30], ["Requested", 16, XL_PESO], ["Approved", 16, XL_PESO],
    ["Paid to client", 16, XL_PESO], ["Returned", 15, XL_PESO], ["Line status", 14],
    ["Counts as", 17], ["Amount counted", 17, XL_PESO], ["Request status", 15], ["Approved by", 15], ["Approved on", 13, XL_DATE], ["ERP reference", 15],
    ["Disbursed on", 13, XL_DATE], ["Paid on", 13, XL_DATE], ["Note", 46],
  ];
  const RH = 5;
  // Records columns by name (the Summary and By expense type formulas point at these)
  const rc = (name) => {
    const i = RC.findIndex(([h]) => h === name);
    if (i < 0) throw new Error(`Records has no "${name}" column`);
    return i + 1;
  };
  const rref = (name) => `Records!$${L(rc(name))}:$${L(rc(name))}`;
  const R_PROJECT = rref("Project ID");
  const R_CAT = rref("Category");
  const R_TYPE = rref("Expense type");
  const R_COUNTS = rref("Counts as");
  const R_AMOUNT = rref("Amount counted");
  RC.forEach(([h, w, fmt], i) => {
    R.getColumn(i + 1).width = w;
    if (fmt) R.getColumn(i + 1).numFmt = fmt;
    head(R.getCell(RH, i + 1), h);
  });
  R.getRow(RH).height = 30;
  recs.forEach((x, i) => {
    const row = R.getRow(RH + 1 + i);
    const vals = [
      x.project.code, x.project.name, x.project.district || null, x.project.year || null, x.ref, xlDate(x.request_date), x.requested_by, x.category, x.type,
      x.payee, x.remarks, x.requested, x.approved, x.paid, x.returned, x.line_status, x.counts, x.counted, x.request_status, x.approved_by, xlDate(x.approved_on), x.erp,
      xlDate(x.disbursed_on), xlDate(x.paid_on), x.note,
    ];
    vals.forEach((v, j) => {
      if (v != null && v !== "") row.getCell(j + 1).value = v;
    });
    if (x.counts === COUNT_NONE) row.font = { color: { argb: XL.muted } };
  });
  const RL = RH + Math.max(recs.length, 1);
  R.autoFilter = { from: { row: RH, column: 1 }, to: { row: RL, column: RC.length } };
  const RT = RL + 2;
  R.getCell(RT, 1).value = "Total of rows shown";
  for (const [name, key] of [["Requested", "requested"], ["Approved", "approved"], ["Paid to client", "paid"], ["Returned", "returned"], ["Amount counted", "counted"]]) {
    const col = rc(name);
    R.getCell(RT, col).value = { formula: `SUBTOTAL(109,${L(col)}${RH + 1}:${L(col)}${RL})`, result: round2(recs.reduce((a, x) => a + (Number(x[key]) || 0), 0)) };
  }
  R.getRow(RT).font = { bold: true, color: { argb: XL.navy } };
  R.getRow(RT).border = { top: { style: "thin", color: { argb: XL.navy } } };
  print(R, `${RH}:${RH}`);

  /* ---- 2. Summary (as on screen) ---- */
  const S = wb.addWorksheet("Summary", { views: [{ state: "frozen", xSplit: 2, ySplit: 9 }], properties: { tabColor: { argb: XL.navy } } });
  intro(S, "Project report", "Each project's allocation against approved and pending requests, per expense category.");
  const P = 6;
  const catAt = (k) => P + 1 + k * 4; // Approved, In approval, Allocation, Used
  const totAt = P + 1 + cats.length * 4; // Approved, In approval, Allocation, Balance, Used
  const limAt = totAt + 5;
  [17, 40, 12, 7, 25, 16].forEach((w, i) => (S.getColumn(i + 1).width = w));
  cats.forEach((c, k) => [15, 14, 15, 11].forEach((w, j) => (S.getColumn(catAt(k) + j).width = w)));
  [16, 15, 16, 16, 11, 11].forEach((w, j) => (S.getColumn(totAt + j).width = w));
  const G = 8;
  const H = 9;
  const first = H + 1;
  const last = H + rows.length;
  const TR = last + 1;
  S.mergeCells(G, 1, G, P);
  head(S.getCell(G, 1), "Project");
  cats.forEach((c, k) => {
    S.mergeCells(G, catAt(k), G, catAt(k) + 3);
    head(S.getCell(G, catAt(k)), c.name, k % 2 ? XL.teal : XL.tealD);
  });
  S.mergeCells(G, totAt, G, totAt + 4);
  head(S.getCell(G, totAt), "Total");
  S.mergeCells(G, limAt, H, limAt);
  head(S.getCell(G, limAt), "Limits exceeded");
  ["Project ID", "Project name", "District", "Year", "Status", "Contract value"].forEach((h, i) => head(S.getCell(H, i + 1), h, XL.tealBg, XL.navy));
  cats.forEach((c, k) => ["Approved to date", "In approval", "Allocation", "Used"].forEach((h, j) => head(S.getCell(H, catAt(k) + j), h, XL.tealBg, XL.navy)));
  ["Approved to date", "In approval", "Allocation", "Balance", "Used"].forEach((h, j) => head(S.getCell(H, totAt + j), h, XL.tealBg, XL.navy));
  S.getRow(H).height = 30;

  const totals = { alloc: 0, used: 0, pending: 0, flagged: 0 };
  rows.forEach(({ p, s }, i) => {
    const r = first + i;
    const row = S.getRow(r);
    [p.code, p.name, p.district || null, p.year || null, p.status || null, contractBase(p) || null].forEach((v, j) => v != null && (row.getCell(j + 1).value = v));
    row.getCell(6).numFmt = XL_PESO;
    let pa = 0;
    let pp = 0;
    let pl = 0;
    cats.forEach((c, k) => {
      const col = catAt(k);
      const crit = `${R_PROJECT},$A${r},${R_CAT},${xlStr(c.name)},${R_COUNTS}`;
      const a = sumRecs(p.code, c.name, null, COUNT_APPROVED);
      const pend = sumRecs(p.code, c.name, null, COUNT_PENDING);
      const alloc = round2((s.byCat.get(c.id) || {}).alloc || 0);
      pa += a;
      pp += pend;
      pl += alloc;
      row.getCell(col).value = { formula: `SUMIFS(${R_AMOUNT},${crit},${xlStr(COUNT_APPROVED)})`, result: a };
      row.getCell(col + 1).value = { formula: `SUMIFS(${R_AMOUNT},${crit},${xlStr(COUNT_PENDING)})`, result: pend };
      row.getCell(col + 2).value = alloc;
      row.getCell(col + 3).value = { formula: `IF(${L(col + 2)}${r}>0,${L(col)}${r}/${L(col + 2)}${r},"")`, result: alloc > 0 ? a / alloc : "" };
      [0, 1, 2].forEach((j) => (row.getCell(col + j).numFmt = XL_PESO));
      row.getCell(col + 3).numFmt = XL_PCT;
    });
    const sumOf = (j) => cats.map((c, k) => `${L(catAt(k) + j)}${r}`).join("+");
    row.getCell(totAt).value = { formula: sumOf(0), result: round2(pa) };
    row.getCell(totAt + 1).value = { formula: sumOf(1), result: round2(pp) };
    row.getCell(totAt + 2).value = { formula: sumOf(2), result: round2(pl) };
    row.getCell(totAt + 3).value = { formula: `${L(totAt + 2)}${r}-${L(totAt)}${r}`, result: round2(pl - pa) };
    row.getCell(totAt + 4).value = { formula: `IF(${L(totAt + 2)}${r}>0,${L(totAt)}${r}/${L(totAt + 2)}${r},"")`, result: pl > 0 ? pa / pl : "" };
    [0, 1, 2, 3].forEach((j) => (row.getCell(totAt + j).numFmt = XL_PESO));
    row.getCell(totAt + 4).numFmt = XL_PCT;
    // expense types over their allocation (or used without one), across all categories
    let flags = 0;
    s.byType.forEach((v) => {
      if ((v.alloc.amount > 0 && v.used > v.alloc.amount + 0.004) || (v.alloc.amount <= 0 && v.used > 0)) flags++;
    });
    if (flags) row.getCell(limAt).value = flags;
    row.getCell(limAt).alignment = { horizontal: "center" };
    row.getCell(2).alignment = { wrapText: false };
    totals.alloc += pl;
    totals.used += pa;
    totals.pending += pp;
    if (flags) totals.flagged++;
    if (i % 2) for (let j = 1; j <= limAt; j++) row.getCell(j).fill = solid("FFF7FAF9");
  });

  // totals row
  const trow = S.getRow(TR);
  trow.getCell(1).value = `${rows.length} ${rows.length === 1 ? "project" : "projects"}`;
  const colSum = (col) => ({ formula: `SUM(${L(col)}${first}:${L(col)}${last})`, result: 0 });
  trow.getCell(6).value = { formula: `SUM(F${first}:F${last})`, result: round2(rows.reduce((a, { p }) => a + contractBase(p), 0)) };
  trow.getCell(6).numFmt = XL_PESO;
  const colTotal = (col) => {
    let v = 0;
    for (let r = first; r <= last; r++) {
      const c = S.getCell(r, col).value;
      v += Number(c && typeof c === "object" ? c.result : c) || 0;
    }
    return round2(v);
  };
  const usedCols = [];
  cats.forEach((c, k) => {
    const col = catAt(k);
    for (const j of [0, 1, 2]) {
      trow.getCell(col + j).value = { ...colSum(col + j), result: colTotal(col + j) };
      trow.getCell(col + j).numFmt = XL_PESO;
    }
    const a = colTotal(col);
    const al = colTotal(col + 2);
    trow.getCell(col + 3).value = { formula: `IF(${L(col + 2)}${TR}>0,${L(col)}${TR}/${L(col + 2)}${TR},"")`, result: al > 0 ? a / al : "" };
    trow.getCell(col + 3).numFmt = XL_PCT;
    usedCols.push(col + 3);
  });
  for (const j of [0, 1, 2, 3]) {
    trow.getCell(totAt + j).value = { ...colSum(totAt + j), result: colTotal(totAt + j) };
    trow.getCell(totAt + j).numFmt = XL_PESO;
  }
  trow.getCell(totAt + 4).value = { formula: `IF(${L(totAt + 2)}${TR}>0,${L(totAt)}${TR}/${L(totAt + 2)}${TR},"")`, result: totals.alloc > 0 ? totals.used / totals.alloc : "" };
  trow.getCell(totAt + 4).numFmt = XL_PCT;
  usedCols.push(totAt + 4);
  trow.getCell(limAt).value = { formula: `COUNTIF(${L(limAt)}${first}:${L(limAt)}${last},">0")`, result: totals.flagged };
  trow.getCell(limAt).alignment = { horizontal: "center" };
  trow.font = { bold: true, color: { argb: XL.navy } };
  for (let j = 1; j <= limAt; j++) {
    trow.getCell(j).border = { top: { style: "medium", color: { argb: XL.navy } } };
    trow.getCell(j).fill = solid(XL.tealBg);
  }
  for (const col of usedCols) usedRules(S, `${L(col)}${first}:${L(col)}${TR}`, `${L(col)}${first}`);
  S.addConditionalFormatting({
    ref: `${L(limAt)}${first}:${L(limAt)}${TR}`,
    rules: [{ type: "expression", priority: 1, formulae: [`AND(ISNUMBER(${L(limAt)}${first}),${L(limAt)}${first}>0)`], style: { font: { bold: true, color: { argb: XL.red } } } }],
  });

  // KPI cards, as on screen: values point at the totals row
  const cards = [
    ["Allocation", [1, 2], `${L(totAt + 2)}${TR}`, totals.alloc, XL_PESO],
    ["Approved to date", [3, 5], `${L(totAt)}${TR}`, totals.used, XL_PESO],
    ["In approval", [6, 7], `${L(totAt + 1)}${TR}`, totals.pending, XL_PESO],
    ["Balance", [8, 9], `${L(totAt + 3)}${TR}`, totals.alloc - totals.used, XL_PESO],
    ["Projects over a limit", [10, 11], `${L(limAt)}${TR}`, totals.flagged, "0"],
  ];
  for (const [label, [a, b], ref, val, fmt] of cards) {
    S.mergeCells(5, a, 5, b);
    S.mergeCells(6, a, 6, b);
    const lc = S.getCell(5, a);
    const vc = S.getCell(6, a);
    lc.value = label;
    lc.font = { size: 10, color: { argb: XL.muted } };
    vc.value = { formula: ref, result: round2(val) };
    vc.numFmt = fmt;
    vc.font = { bold: true, size: 15, color: { argb: label === "Projects over a limit" && val > 0 ? XL.red : XL.navy } };
    vc.alignment = { horizontal: "left" };
    for (let j = a; j <= b; j++) {
      S.getCell(5, j).fill = solid(XL.tealBg);
      S.getCell(6, j).fill = solid(XL.tealBg);
      S.getCell(5, j).border = { top: thin, left: j === a ? thin : undefined, right: j === b ? thin : undefined };
      S.getCell(6, j).border = { bottom: thin, left: j === a ? thin : undefined, right: j === b ? thin : undefined };
    }
  }
  S.getRow(6).height = 24;
  const noteRow = TR + 2;
  S.getCell(noteRow, 1).value =
    `Approved to date: open, disbursed, paid and closed lines. In approval: waiting for top management. Used: approved to date against the allocation; amber from ${Math.round(nearFrac * 100)}%, red once over. Limits exceeded: expense types over their allocation (details on the By expense type sheet). Every amount adds up the Records sheet.`;
  S.getCell(noteRow, 1).font = { size: 9, italic: true, color: { argb: XL.muted } };
  print(S, `${G}:${H}`);

  /* ---- 3. By expense type ---- */
  const T = wb.addWorksheet("By expense type", { views: [{ state: "frozen", xSplit: 2, ySplit: 5 }], properties: { tabColor: { argb: XL.tealD } } });
  intro(T, "By expense type", "Allocation against approved and pending requests for each expense type on each project. Filter any column; the total row follows the filter.");
  const TC = [
    ["Project ID", 17], ["Project name", 40], ["District", 12], ["Year", 7], ["Category", 12], ["Expense type", 20], ["Allocation", 16, XL_PESO], ["Allocation basis", 20],
    ["Approved to date", 16, XL_PESO], ["In approval", 15, XL_PESO], ["Balance", 16, XL_PESO], ["Used", 11, XL_PCT], ["Limit status", 15],
  ];
  const TH = 5;
  TC.forEach(([h, w, fmt], i) => {
    T.getColumn(i + 1).width = w;
    if (fmt) T.getColumn(i + 1).numFmt = fmt;
    head(T.getCell(TH, i + 1), h);
  });
  T.getRow(TH).height = 30;
  let tr = TH;
  for (const { p, s } of rows)
    for (const c of idx.categories)
      for (const t of idx.typesByCat.get(c.id) || []) {
        const v = s.byType.get(t.id);
        if (!v || (v.alloc.amount <= 0 && v.used <= 0 && v.pending <= 0)) continue;
        tr++;
        const row = T.getRow(tr);
        const alloc = round2(v.alloc.amount);
        const a = sumRecs(p.code, c.name, t.name, COUNT_APPROVED);
        const pend = sumRecs(p.code, c.name, t.name, COUNT_PENDING);
        const crit = `${R_PROJECT},$A${tr},${R_CAT},$E${tr},${R_TYPE},$F${tr},${R_COUNTS}`;
        [p.code, p.name, p.district || null, p.year || null, c.name, t.name, alloc, allocationHint(v.alloc)].forEach((x, j) => x != null && (row.getCell(j + 1).value = x));
        row.getCell(9).value = { formula: `SUMIFS(${R_AMOUNT},${crit},${xlStr(COUNT_APPROVED)})`, result: a };
        row.getCell(10).value = { formula: `SUMIFS(${R_AMOUNT},${crit},${xlStr(COUNT_PENDING)})`, result: pend };
        row.getCell(11).value = { formula: `G${tr}-I${tr}`, result: round2(alloc - a) };
        row.getCell(12).value = { formula: `IF(G${tr}>0,I${tr}/G${tr},"")`, result: alloc > 0 ? a / alloc : "" };
        const status = alloc <= 0 ? (a > 0 ? "No allocation" : "") : a > alloc + 0.004 ? "Exceeds limit" : a >= alloc * nearFrac ? "Near limit" : "Within limit";
        row.getCell(13).value = {
          formula: `IF(G${tr}<=0,IF(I${tr}>0,"No allocation",""),IF(I${tr}>G${tr}+0.004,"Exceeds limit",IF(I${tr}>=G${tr}*${nearFrac},"Near limit","Within limit")))`,
          result: status,
        };
      }
  const TL = Math.max(tr, TH + 1);
  T.autoFilter = { from: { row: TH, column: 1 }, to: { row: TL, column: TC.length } };
  const TT = TL + 2;
  T.getCell(TT, 1).value = "Total of rows shown";
  const tsum = (col) => {
    let v = 0;
    for (let r = TH + 1; r <= tr; r++) {
      const c = T.getCell(r, col).value;
      v += Number(c && typeof c === "object" ? c.result : c) || 0;
    }
    return round2(v);
  };
  for (const col of [7, 9, 10, 11]) T.getCell(TT, col).value = { formula: `SUBTOTAL(109,${L(col)}${TH + 1}:${L(col)}${TL})`, result: tsum(col) };
  T.getCell(TT, 12).value = { formula: `IF(G${TT}>0,I${TT}/G${TT},"")`, result: tsum(7) > 0 ? tsum(9) / tsum(7) : "" };
  T.getRow(TT).font = { bold: true, color: { argb: XL.navy } };
  for (let j = 1; j <= TC.length; j++) T.getCell(TT, j).border = { top: { style: "medium", color: { argb: XL.navy } } };
  usedRules(T, `L${TH + 1}:L${TT}`, `L${TH + 1}`);
  T.addConditionalFormatting({
    ref: `M${TH + 1}:M${TL}`,
    rules: [
      { type: "expression", priority: 1, formulae: [`$M${TH + 1}="Exceeds limit"`], style: { font: { bold: true, color: { argb: XL.red } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: XL.redBg } } } },
      { type: "expression", priority: 2, formulae: [`OR($M${TH + 1}="Near limit",$M${TH + 1}="No allocation")`], style: { font: { bold: true, color: { argb: XL.amber } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: XL.amberBg } } } },
    ],
  });
  print(T, `${TH}:${TH}`);

  // finishing: one font throughout, centred years, a little air after right-aligned amounts and dates
  const tidy = (ws, fromRow, lastRow, yearCol, indentCols) => {
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: "Calibri", size: 11, ...(cell.font || {}) };
      })
    );
    for (let r = fromRow; r <= lastRow; r++) {
      if (yearCol) ws.getCell(r, yearCol).alignment = { horizontal: "center" };
      for (const c of indentCols) ws.getCell(r, c).alignment = { horizontal: "left", indent: 1 };
    }
  };
  tidy(R, RH + 1, RL, 4, [rc("Requested by"), rc("Line status"), rc("Request status")]);
  tidy(S, first, last, 4, [5]);
  tidy(T, TH + 1, TL, 4, [8, 13]);

  const buf = await wb.xlsx.writeBuffer();
  await saveFile(`project-report-${todayISO()}.xlsx`, new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  return recs.length;
}

function ReportPage() {
  const { data, idx, settings, me, ui } = useApp();
  const near = Number(settings.near_limit_pct) || 90;
  const [f, setF] = useState({ q: "", year: "", district: "", group: "", view: "cat", show: "", sort: "code" });
  const set = setter(setF);
  const [openId, setOpenId] = useState(null);

  const scopeCat = f.view === "cat" ? null : f.view;
  const all = useMemo(
    () =>
      data.projects.map((p) => {
        const s = projectSummary(p, idx);
        let over = 0;
        let unbudgeted = 0;
        s.byType.forEach((v, typeId) => {
          if (scopeCat && (idx.typesById.get(typeId) || {}).category_id !== scopeCat) return;
          if (v.alloc.amount > 0 && v.used > v.alloc.amount + 0.004) over++;
          else if (v.alloc.amount <= 0 && v.used > 0) unbudgeted++;
        });
        const t = scopeCat ? s.byCat.get(scopeCat) || { alloc: 0, used: 0, pending: 0 } : s.total;
        return { p, s, t, over, unbudgeted };
      }),
    [data.projects, idx, scopeCat]
  );

  const rows = useMemo(() => {
    const q = norm(f.q);
    let r = all.filter(
      ({ p, s }) =>
        (!p.is_internal || s.total.used + s.total.pending > 0) &&
        (!f.year || String(p.year) === f.year) &&
        (!f.district || p.district === f.district) &&
        (!f.group || p.status_group === f.group) &&
        (!q || norm(p.code).includes(q) || norm(p.name).includes(q) || norm(p.location).includes(q))
    );
    if (f.show === "flagged") r = r.filter((x) => x.over + x.unbudgeted > 0);
    if (f.show === "active") r = r.filter((x) => x.t.used + x.t.pending > 0);
    const util = (x) => (x.t.alloc > 0 ? x.t.used / x.t.alloc : x.t.used > 0 ? 99 : 0);
    if (f.sort === "usage") return [...r].sort((a, b) => util(b) - util(a));
    if (f.sort === "flags") return [...r].sort((a, b) => b.over + b.unbudgeted - (a.over + a.unbudgeted) || util(b) - util(a));
    return [...r].sort((a, b) => Number(a.p.is_internal) - Number(b.p.is_internal) || String(a.p.code).localeCompare(String(b.p.code)));
  }, [all, f]);

  const cols = useMemo(
    () =>
      f.view === "cat"
        ? idx.categories.filter((c) => c.is_active).map((c) => ({ id: c.id, label: c.name, get: (s) => s.byCat.get(c.id) }))
        : (idx.typesByCat.get(f.view) || [])
            .filter((t) => t.is_active)
            .map((t) => ({
              id: t.id,
              label: t.name,
              get: (s) => {
                const v = s.byType.get(t.id);
                return { alloc: v.alloc.amount, used: v.used, pending: v.pending };
              },
            })),
    [f.view, idx]
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, { t, over, unbudgeted }) => ({
          alloc: a.alloc + t.alloc,
          used: a.used + t.used,
          pending: a.pending + t.pending,
          flagged: a.flagged + (over + unbudgeted > 0 ? 1 : 0),
        }),
        { alloc: 0, used: 0, pending: 0, flagged: 0 }
      ),
    [rows]
  );
  const colTotals = useMemo(
    () =>
      cols.map((c) =>
        rows.reduce(
          (a, { s }) => {
            const v = c.get(s);
            return { alloc: a.alloc + v.alloc, used: a.used + v.used, pending: a.pending + v.pending };
          },
          { alloc: 0, used: 0, pending: 0 }
        )
      ),
    [cols, rows]
  );

  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    const filterText =
      "Filters: " +
      [
        f.year || "all years",
        f.district || "all districts",
        f.group || "all statuses",
        f.show === "active" ? "projects with requests" : f.show === "flagged" ? "projects over a limit" : "all projects",
        f.q.trim() ? `search "${f.q.trim()}"` : null,
      ]
        .filter(Boolean)
        .join(", ") +
      ".";
    try {
      await exportReportWorkbook({ rows, data, idx, near, me, filterText });
    } catch (e) {
      ui.err((e && e.message) || "The Excel file couldn't be created. Try again.");
    }
    setExporting(false);
  };

  const balance = totals.alloc - totals.used;
  return (
    <div className="oe-page">
      <PageHead title="Project report" desc="Each project's allocation against approved and pending requests. Check a project here before approving a request.">
        <Button icon="download" onClick={exportExcel} busy={exporting} disabled={rows.length === 0} title="Records, a summary like this page, and a breakdown by expense type">
          Export to Excel
        </Button>
      </PageHead>
      <dl className="oe-strip">
        <div>
          <dt>Allocation</dt>
          <dd>{compact(totals.alloc)}</dd>
        </div>
        <div>
          <dt>Approved to date</dt>
          <dd>{compact(totals.used)}</dd>
        </div>
        <div>
          <dt>In approval</dt>
          <dd>{compact(totals.pending)}</dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd className={balance < 0 ? "bad" : ""}>{compact(balance)}</dd>
        </div>
        <div>
          <dt>{scopeCat ? `Over a ${(idx.cats.get(scopeCat) || {}).name} limit` : "Projects over a limit"}</dt>
          <dd className={totals.flagged ? "bad" : ""}>{totals.flagged}</dd>
        </div>
      </dl>
      <Filters>
        <SearchBox value={f.q} onChange={set("q")} placeholder="Search project ID, name or location" />
        <select name="year" className="oe-select" value={f.year} onChange={set("year")} aria-label="Year">
          <option value="">All years</option>
          {idx.years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <select name="district" className="oe-select" value={f.district} onChange={set("district")} aria-label="District">
          <option value="">All districts</option>
          {idx.districts.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select name="group" className="oe-select" value={f.group} onChange={set("group")} aria-label="Status group">
          <option value="">All statuses</option>
          {STATUS_GROUPS.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <select name="view" className="oe-select" value={f.view} onChange={set("view")} aria-label="Columns">
          <option value="cat">Columns: categories</option>
          {idx.categories
            .filter((c) => c.is_active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                Columns: {c.name} types
              </option>
            ))}
        </select>
        <select name="show" className="oe-select" value={f.show} onChange={set("show")} aria-label="Show">
          <option value="">All projects</option>
          <option value="active">With requests</option>
          <option value="flagged">Over a limit</option>
        </select>
        <select name="sort" className="oe-select" value={f.sort} onChange={set("sort")} aria-label="Sort">
          <option value="code">Sort by project ID</option>
          <option value="usage">Highest usage first</option>
          <option value="flags">Most limits exceeded</option>
        </select>
      </Filters>
      {rows.length === 0 ? (
        <div className="oe-panel">
          <Empty title="No projects match these filters" body="Clear a filter or search for a different project ID." />
        </div>
      ) : (
        <div className="oe-tablewrap" style={{ maxHeight: "calc(100vh - 290px)" }}>
          <table className="oe-table cards">
            <thead>
              <tr>
                <th>Project</th>
                <th className="r">Contract value</th>
                {cols.map((c) => (
                  <th key={c.id}>{c.label}</th>
                ))}
                <th>{scopeCat ? `${(idx.cats.get(scopeCat) || {}).name} total` : "Total"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, s, t, over, unbudgeted }) => (
                <tr key={p.id} className="click" tabIndex={0} onClick={() => setOpenId(p.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(p.id)}>
                  <td className="lead">
                    <span className="oe-code">{p.code}</span>
                    <span className="sub oe-clip" title={p.name}>
                      {p.name}
                    </span>
                    <span className="sub">
                      {[p.district, p.year, p.status].filter(Boolean).join(", ")}
                      {over + unbudgeted > 0 && (
                        <>
                          {" "}
                          <Chip tone="red" plain>
                            {over + unbudgeted} over
                          </Chip>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="r" data-th="Contract value">{contractBase(p) ? compact(contractBase(p)) : "—"}</td>
                  {cols.map((c) => {
                    const v = c.get(s);
                    return (
                      <td key={c.id} data-th={c.label}>
                        <UsageCell alloc={v.alloc} used={v.used} pending={v.pending} near={near} />
                      </td>
                    );
                  })}
                  <td data-th={scopeCat ? `${(idx.cats.get(scopeCat) || {}).name} total` : "Total"}>
                    <UsageCell alloc={t.alloc} used={t.used} pending={t.pending} near={near} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="lead">{rows.length} projects</td>
                <td className="r" data-th="Contract value">{compact(rows.reduce((a, { p }) => a + contractBase(p), 0))}</td>
                {colTotals.map((v, i) => (
                  <td key={cols[i].id} data-th={cols[i].label}>
                    <UsageCell alloc={v.alloc} used={v.used} pending={v.pending} near={near} />
                  </td>
                ))}
                <td data-th="Total">
                  <UsageCell alloc={totals.alloc} used={totals.used} pending={totals.pending} near={near} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Solid bar: approved to date (open, disbursed, paid, closed). Striped: waiting for approval. A dark tick marks the limit once it is passed.
      </p>
      {openId && <ProjectDrawer projectId={openId} initialTab="breakdown" onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ProjectBreakdown({ project, focus }) {
  const { idx, data, settings } = useApp();
  const focusRow = useRef(null);
  useEffect(() => {
    if (focus && focusRow.current) focusRow.current.scrollIntoView({ block: "center" });
  }, [focus]);
  const near = Number(settings.near_limit_pct) || 90;
  const s = useMemo(() => projectSummary(project, idx), [project, idx]);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [reqId, setReqId] = useState(null);
  const lines = useMemo(() => {
    const out = [];
    for (const r of data.requests)
      for (const l of r.lines) {
        if (l.project_id === project.id) out.push({ r, l, key: l.id });
        for (const x of l.reclass || []) if (x.project_id === project.id) out.push({ r, l, part: x, key: x.id });
      }
    return out.slice(0, 50);
  }, [data.requests, project.id]);
  const base = contractBase(project);

  return (
    <>
      <div className="oe-panel">
        <div className="oe-panel-h">
          <div>
            <h2>Allocation and usage</h2>
            <p className="muted small">
              {base ? `Allocation base ${money(base)} (${project.district || "no district"})` : "No contract value; allocations must be set for this project."}
            </p>
          </div>
          <label className="oe-check">
            <input name="hideempty" type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide empty lines
          </label>
        </div>
        <div className="oe-panel-b" style={{ display: "grid", gap: 8 }}>
          <div className="oe-usage-t">
            <span>
              <b className="num">{money(s.total.used)}</b> approved of <b className="num">{money(s.total.alloc)}</b>
            </span>
            <span className="num">{s.total.alloc > 0 ? pct(s.total.used / s.total.alloc, 1) + " used" : "No allocation"}</span>
          </div>
          <Meter alloc={s.total.alloc} used={s.total.used} pending={s.total.pending} near={near} size="lg" />
          {s.total.pending > 0 && <span className="muted small">{money(s.total.pending)} waiting for approval</span>}
        </div>
        <div className="oe-scrollx" style={{ borderTop: "1px solid var(--line)" }}>
          <table className="oe-table tight">
            <thead>
              <tr>
                <th>Expense</th>
                <th className="r">Allocation</th>
                <th className="r">In approval</th>
                <th className="r">Open</th>
                <th className="r">Disbursed</th>
                <th className="r">Paid</th>
                <th className="r">Closed</th>
                <th className="r">Balance</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody>
              {idx.categories.map((c) => {
                const cs = s.byCat.get(c.id);
                const types = (idx.typesByCat.get(c.id) || []).filter((t) => {
                  const v = s.byType.get(t.id);
                  return !hideEmpty || (focus && focus.typeId === t.id) || v.alloc.amount > 0 || v.used > 0 || v.pending > 0;
                });
                if (hideEmpty && !types.length) return null;
                return (
                  <React.Fragment key={c.id}>
                    <tr className="grp">
                      <td>{c.name}</td>
                      <td className="r">{amt(cs.alloc)}</td>
                      <td className="r">{amt(cs.pending)}</td>
                      <td className="r">{amt(cs.open)}</td>
                      <td className="r">{amt(cs.disbursed)}</td>
                      <td className="r">{amt(cs.paid)}</td>
                      <td className="r">{amt(cs.closed)}</td>
                      <td className="r" style={{ color: cs.alloc - cs.used < 0 ? "var(--red)" : undefined }}>{amt(cs.alloc - cs.used)}</td>
                      <td style={{ minWidth: 110, verticalAlign: "middle" }}>
                        <Meter alloc={cs.alloc} used={cs.used} pending={cs.pending} near={near} />
                      </td>
                    </tr>
                    {types.map((t) => {
                      const v = s.byType.get(t.id);
                      const bal = v.alloc.amount - v.used;
                      return (
                        <tr key={t.id} className={focus && focus.typeId === t.id ? "focus" : ""} ref={focus && focus.typeId === t.id ? focusRow : null}>
                          <td style={{ paddingLeft: 22 }}>
                            {t.name}
                            {focus && focus.typeId === t.id && (
                              <>
                                {" "}
                                <Chip tone="amber" plain>
                                  This line
                                </Chip>
                              </>
                            )}
                            <span className="sub">{allocationHint(v.alloc)}</span>
                          </td>
                          <td className="r">{amt(v.alloc.amount)}</td>
                          <td className="r">{amt(v.pending)}</td>
                          <td className="r">{amt(v.u.open)}</td>
                          <td className="r">{amt(v.u.disbursed)}</td>
                          <td className="r">{amt(v.u.paid)}</td>
                          <td className="r">{amt(v.u.closed)}</td>
                          <td className="r" style={{ color: bal < -0.004 ? "var(--red)" : undefined, fontWeight: bal < -0.004 ? 600 : undefined }}>
                            {amt(bal)}
                          </td>
                          <td style={{ minWidth: 110, verticalAlign: "middle" }}>
                            <Meter alloc={v.alloc.amount} used={v.used} pending={v.pending} near={near} />
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="oe-panel">
        <div className="oe-panel-h">
          <h2>Request lines for this project</h2>
          <span className="muted small">{lines.length ? `Latest ${lines.length}` : ""}</span>
        </div>
        {lines.length === 0 ? (
          <Empty title="No request lines yet" body="Lines filed against this project will appear here." />
        ) : (
          <div className="oe-scrollx">
            <table className="oe-table tight">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Date</th>
                  <th>Expense</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(({ r, l, part, key }) => {
                  const t = idx.typesById.get(l.type_id);
                  const from = part ? idx.projects.get(l.project_id) : null;
                  return (
                    <tr key={key} className="click" tabIndex={0} onClick={() => setReqId(r.id)} onKeyDown={(e) => e.key === "Enter" && setReqId(r.id)}>
                      <td>
                        <span className="oe-code">{r.ref_no}</span>
                        <span className="sub">Line {l.line_no}</span>
                      </td>
                      <td>{fmtDate(r.request_date)}</td>
                      <td>
                        {t ? t.name : "—"}
                        {part ? (
                          <span className="sub">Reclassified from {from ? from.code : "an internal project"}{part.remarks ? ` · ${part.remarks}` : ""}</span>
                        ) : (
                          l.description && <span className="sub oe-clip">{l.description}</span>
                        )}
                      </td>
                      <td className="r">{money(part ? part.amount : l.status === "on_hold" ? l.amount : lineNet(l))}</td>
                      <td>
                        <StatusChip status={l.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {reqId && <RequestDrawer requestId={reqId} onClose={() => setReqId(null)} />}
    </>
  );
}

/* ---------------------------------------------------------------------
   10. PROJECT LISTING
   --------------------------------------------------------------------- */
function ProjectsPage() {
  const { data, idx, can } = useApp();
  const [f, setF] = useState({ q: "", year: "", district: "", group: "" });
  const set = setter(setF);
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [page, setPage] = useState(1);
  const PER = 40;

  const rows = useMemo(() => {
    const q = norm(f.q);
    return data.projects
      .filter(
        (p) =>
          (!f.year || String(p.year) === f.year) &&
          (!f.district || p.district === f.district) &&
          (!f.group || p.status_group === f.group) &&
          (!q || [p.code, p.name, p.location, p.contractor, p.site_engineer].some((v) => norm(v).includes(q)))
      )
      .sort((a, b) => Number(a.is_internal) - Number(b.is_internal) || (b.year || 0) - (a.year || 0) || String(a.code).localeCompare(String(b.code)));
  }, [data.projects, f]);
  useEffect(() => setPage(1), [f]);
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const shown = rows.slice((page - 1) * PER, page * PER);

  const exportCSV = () =>
    downloadCSV(`project-listing-${todayISO()}.csv`, [
      ["Year", "District", "Project ID", "Project Name", "Location", "Category", "Contractor / JV", "ABC Amount", "Bid Amount", "Revised Contract", "Contract Value", "Duration (days)", "Bidding Date", "NTP Date", "Original Expiry", "Suspension / Revised Expiry Notes", "Site Engineer", "Checker", "Status", "Status Group", "Accomp. %"],
      ...rows.map((p) => [p.year, p.district, p.code, p.name, p.location, p.category, p.contractor, p.abc_amount, p.bid_amount, p.revised_contract, p.contract_value, p.duration_days, p.bidding_date, p.ntp_date, p.original_expiry, p.suspension_notes, p.site_engineer, p.checker, p.status, p.status_group, p.accomplishment != null ? round2(p.accomplishment * 100) : ""]),
    ]);

  return (
    <div className="oe-page">
      <PageHead title="Project listing" desc="Contract details for every project. The contract value is the base for default expense allocations.">
        <Button icon="download" onClick={exportCSV}>
          Export CSV
        </Button>
        {can("projects.edit") && (
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add project
          </Button>
        )}
      </PageHead>
      <Filters>
        <SearchBox value={f.q} onChange={set("q")} placeholder="Search ID, name, location, engineer" />
        <select name="year" className="oe-select" value={f.year} onChange={set("year")} aria-label="Year">
          <option value="">All years</option>
          {idx.years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <select name="district" className="oe-select" value={f.district} onChange={set("district")} aria-label="District">
          <option value="">All districts</option>
          {idx.districts.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select name="group" className="oe-select" value={f.group} onChange={set("group")} aria-label="Status group">
          <option value="">All statuses</option>
          {STATUS_GROUPS.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <span className="muted small">{rows.length} projects</span>
      </Filters>
      {rows.length === 0 ? (
        <div className="oe-panel">
          <Empty
            title={data.projects.length ? "No projects match these filters" : "No projects yet"}
            body={data.projects.length ? "Clear a filter to see more." : "Add your first project, or load them with the SQL seed."}
            action={can("projects.edit") && !data.projects.length && <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add project</Button>}
          />
        </div>
      ) : (
        <>
          <div className="oe-tablewrap">
            <table className="oe-table cards">
              <thead>
                <tr>
                  <th>Project ID</th>
                  <th>Project name</th>
                  <th>District</th>
                  <th>Category</th>
                  <th>Contractor / JV</th>
                  <th className="r">Contract value</th>
                  <th>NTP date</th>
                  <th>Status</th>
                  <th className="r">Accomp.</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="click" tabIndex={0} onClick={() => setOpenId(p.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(p.id)}>
                    <td className="lead">
                      <span className="oe-code">{p.code}</span>
                      <span className="sub">{p.year || ""}</span>
                    </td>
                    <td data-th="Project name">
                      <span className="oe-clip" title={p.name}>
                        {p.name}
                      </span>
                      <span className="sub">{p.location}</span>
                    </td>
                    <td data-th="District">{p.district || "—"}</td>
                    <td data-th="Category">{p.category || "—"}</td>
                    <td data-th="Contractor / JV">{p.contractor || "—"}</td>
                    <td className="r" data-th="Contract value">{contractBase(p) ? money(contractBase(p)) : "—"}</td>
                    <td data-th="NTP date">{fmtDate(p.ntp_date)}</td>
                    <td data-th="Status">
                      {p.status || "—"}
                      {p.status_group && p.status_group !== p.status && <span className="sub">{p.status_group}</span>}
                    </td>
                    <td className="r" data-th="Accomplishment">{p.accomplishment != null ? pct(p.accomplishment) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} onPage={setPage} total={rows.length} />
        </>
      )}
      {openId && <ProjectDrawer projectId={openId} onClose={() => setOpenId(null)} />}
      {adding && <ProjectForm onClose={() => setAdding(false)} />}
    </div>
  );
}

function ProjectDrawer({ projectId, initialTab = "details", onClose, focus = null }) {
  const { data, idx, can, run, api, ui } = useApp();
  const project = data.projects.find((p) => p.id === projectId);
  const [allocDraft, setAllocDraft] = useState(null);
  const allocInit = useMemo(() => allocInitial(idx, projectId), [idx, projectId]);
  const allocDirty = !!allocDraft && idx.types.some((t) => (allocDraft[t.id] ?? null) !== (allocInit[t.id] ?? null));
  const canBreakdown = can("report.view") || can("thresholds.view") || can("requests.approve");
  const tabs = [
    canBreakdown && { id: "breakdown", label: "Expense breakdown" },
    { id: "details", label: "Details" },
    (can("allocations.edit") || canBreakdown) && { id: "alloc", label: "Allocations" },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0].id);
  const [editing, setEditing] = useState(false);
  if (!project)
    return (
      <Drawer title="Project not found" onClose={onClose}>
        <Empty title="This project is no longer in the listing." />
      </Drawer>
    );
  const del = async () => {
    const a = await ui.confirm({
      title: `Delete ${project.code}?`,
      body: "This removes the project and its allocations. Projects that already have requests can't be deleted.",
      confirmLabel: "Delete project",
      tone: "danger",
    });
    if (a === null) return;
    if (await run(() => api.deleteProject(project.id), `${project.code} deleted`)) onClose();
  };
  return (
    <Drawer
      width={920}
      title={project.code}
      subtitle={project.name}
      onClose={onClose}
      dirty={allocDirty}
      discardTitle="Discard allocation changes?"
      discardBody="The limits you changed will be lost."
      actions={
        can("projects.edit") && (
          <>
            <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="danger" icon="trash" aria-label="Delete project" title="Delete project" onClick={del} />
          </>
        )
      }
    >
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Project sections" />
      {tab === "details" && <ProjectDetails project={project} />}
      {tab === "alloc" && <AllocationEditor project={project} initial={allocInit} draft={allocDraft || allocInit} setDraft={setAllocDraft} />}
      {tab === "breakdown" && focus && focus.note && <Note tone="warn" icon="info">{focus.note}</Note>}
      {tab === "breakdown" && <ProjectBreakdown project={project} focus={focus} />}
      {editing && <ProjectForm project={project} onClose={() => setEditing(false)} />}
    </Drawer>
  );
}

function ProjectDetails({ project: p }) {
  const m = (v) => (v != null && v !== "" ? money(v) : null);
  const items = [
    ["Project ID", p.code], ["Year", p.year], ["District", p.district], ["Location", p.location],
    ["Category", p.category], ["Contractor / JV", p.contractor], ["ABC amount", m(p.abc_amount)], ["Bid amount", m(p.bid_amount)],
    ["Revised contract", m(p.revised_contract)], ["Contract value", m(p.contract_value)], ["Duration", p.duration_days ? `${p.duration_days} days` : null],
    ["Bidding date", p.bidding_date && fmtDate(p.bidding_date)], ["NTP date", p.ntp_date && fmtDate(p.ntp_date)],
    ["Original expiry", p.original_expiry && fmtDate(p.original_expiry)], ["Site engineer", p.site_engineer], ["Checker", p.checker],
    ["Status", p.status], ["Status group", p.status_group], ["Accomplishment", p.accomplishment != null ? pct(p.accomplishment, 1) : null],
  ];
  return (
    <div className="oe-panel">
      <div className="oe-panel-b oe-stack">
        <dl className="oe-kv">
          {items.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v == null || v === "" ? "—" : v}</dd>
            </div>
          ))}
        </dl>
        {p.suspension_notes && (
          <div>
            <div className="oe-label">Suspension / revised expiry notes</div>
            <p>{p.suspension_notes}</p>
          </div>
        )}
        {p.is_internal && <Note>Internal bucket with no contract. Set allocations manually if you want a limit.</Note>}
      </div>
    </div>
  );
}

const BLANK_PROJECT = {
  code: "", year: new Date().getFullYear(), district: "", name: "", location: "", category: "", contractor: "",
  abc_amount: null, bid_amount: null, revised_contract: null, contract_value: null, duration_days: "", bidding_date: "",
  ntp_date: "", original_expiry: "", suspension_notes: "", site_engineer: "", checker: "", status: "", status_group: "Ongoing",
  accomplishment: null, is_internal: false,
};

function ProjectForm({ project, onClose }) {
  const { api, run, data, idx } = useApp();
  const init = project || BLANK_PROJECT;
  const [f0] = useState(() => ({ ...init, accomplishment: init.accomplishment != null ? round2(init.accomplishment * 100) : "" }));
  const [f, setF] = useState(f0);
  const dirty = JSON.stringify(f) !== JSON.stringify(f0);
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const set = setter(setF);
  const uniq = (k) => [...new Set(data.projects.map((p) => p[k]).filter(Boolean))].sort();

  const save = async () => {
    const e = {};
    if (!String(f.code || "").trim()) e.code = "Enter the project ID";
    if (!String(f.name || "").trim()) e.name = "Enter the project name";
    const acc = f.accomplishment === "" || f.accomplishment == null ? null : Number(f.accomplishment);
    if (acc != null && (isNaN(acc) || acc < 0 || acc > 100)) e.accomplishment = "Enter a value from 0 to 100";
    setErr(e);
    if (Object.keys(e).length) return;
    const row = {
      ...f,
      code: f.code.trim(),
      name: f.name.trim(),
      year: num(f.year),
      duration_days: num(f.duration_days),
      accomplishment: acc == null ? null : acc / 100,
      bidding_date: f.bidding_date || null,
      ntp_date: f.ntp_date || null,
      original_expiry: f.original_expiry || null,
    };
    for (const k of ["district", "location", "category", "contractor", "suspension_notes", "site_engineer", "checker", "status", "status_group"])
      row[k] = row[k] ? String(row[k]).trim() || null : null;
    setBusy(true);
    const ok = await run(() => api.saveProject(row), project ? `${row.code} updated` : `${row.code} added`);
    setBusy(false);
    if (ok) onClose();
  };

  const T = (k, label, span = 4, extra = {}) => (
    <Field label={label} span={span} error={err[k]}>
      <input name={k} className={`oe-input ${err[k] ? "bad" : ""}`} value={f[k] ?? ""} onChange={set(k)} {...extra} />
    </Field>
  );
  const D = (k, label) => (
    <Field label={label} span={3}>
      <input name={k} className="oe-input" type="date" value={f[k] || ""} onChange={set(k)} />
    </Field>
  );
  const M = (k, label, hint) => (
    <Field label={label} span={3} hint={hint}>
      <MoneyInput value={f[k]} onChange={set(k)} />
    </Field>
  );

  return (
    <Modal
      title={project ? `Edit ${project.code}` : "Add project"}
      subtitle="Fields follow the Project Listing sheet."
      onClose={onClose}
      width={880}
      dirty={dirty}
      discardTitle={project ? "Discard your changes?" : "Discard this project?"}
      discardBody={project ? DISCARD_EDIT : DISCARD_NEW}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>
            {project ? "Save changes" : "Add project"}
          </Button>
        </>
      )}
    >
      <div className="oe-grid">
        <div className="oe-sect">Project</div>
        {T("code", "Project ID", 3, { placeholder: "25HO0172", "data-autofocus": true })}
        {T("year", "Year", 2, { inputMode: "numeric" })}
        {T("district", "District", 3, { list: "oe-dl-district", placeholder: "Cebu 7th" })}
        {T("category", "Category", 4, { list: "oe-dl-category", placeholder: "Roads" })}
        {T("name", "Project name", 8)}
        {T("contractor", "Contractor / JV", 4, { list: "oe-dl-contractor" })}
        {T("location", "Location", 6)}
        <Field label="Internal bucket" span={6} as="div" hint="For Advances or For assignment. No contract; allocations are set by hand.">
          <label className="oe-check" style={{ height: 36 }}>
            <input name="is_internal" type="checkbox" checked={Boolean(f.is_internal)} onChange={set("is_internal")} /> Not a contract project
          </label>
        </Field>
        <div className="oe-sect">Amounts</div>
        {M("abc_amount", "ABC amount (₱)")}
        {M("bid_amount", "Bid amount (₱)")}
        {M("revised_contract", "Revised contract (₱)")}
        {M("contract_value", "Contract value (₱)", "Base for allocations")}
        <div className="oe-sect">Schedule</div>
        {T("duration_days", "Duration (days)", 3, { inputMode: "numeric" })}
        {D("bidding_date", "Bidding date")}
        {D("ntp_date", "NTP date")}
        {D("original_expiry", "Original expiry")}
        <Field label="Suspension / revised expiry notes" span={12}>
          <textarea name="suspension_notes" className="oe-textarea" value={f.suspension_notes || ""} onChange={set("suspension_notes")} />
        </Field>
        <div className="oe-sect">People and status</div>
        {T("site_engineer", "Site engineer", 3)}
        {T("checker", "Checker", 3)}
        {T("status", "Status", 3, { placeholder: "Ongoing" })}
        <Field label="Status group" span={3}>
          <select name="status_group" className="oe-select" value={f.status_group || ""} onChange={set("status_group")}>
            <option value="">None</option>
            {STATUS_GROUPS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        {T("accomplishment", "Accomplishment (%)", 3, { inputMode: "decimal", placeholder: "0 to 100" })}
      </div>
      <datalist id="oe-dl-district">{[...new Set([...idx.districts, "Cebu 1st", "Cebu 2nd", "Cebu 4th", "Cebu 6th", "Cebu 7th", "Cebu City", "Region VII"])].map((d) => <option key={d} value={d} />)}</datalist>
      <datalist id="oe-dl-category">{uniq("category").map((d) => <option key={d} value={d} />)}</datalist>
      <datalist id="oe-dl-contractor">{uniq("contractor").map((d) => <option key={d} value={d} />)}</datalist>
    </Modal>
  );
}

function AllocationEditor({ project, initial, draft, setDraft }) {
  const { idx, can, api, run } = useApp();
  const editable = can("allocations.edit");
  const [busy, setBusy] = useState(false);
  const dirty = idx.types.filter((t) => (draft[t.id] ?? null) !== (initial[t.id] ?? null));
  const effective = (t) => (draft[t.id] != null ? Number(draft[t.id]) : defaultAllocation(project, t, idx).amount);
  const total = idx.types.reduce((a, t) => a + effective(t), 0);
  const save = async () => {
    setBusy(true);
    const ok = await run(() => api.saveAllocations(project.id, dirty.map((t) => ({ type_id: t.id, amount: draft[t.id] ?? null }))), "Allocations saved");
    setBusy(false);
    if (ok) setDraft(null);
  };

  return (
    <div className="oe-panel">
      <div className="oe-panel-h">
        <div>
          <h2>Allocations</h2>
          <p className="muted small">
            Defaults come from the contract value ({contractBase(project) ? money(contractBase(project)) : "none"}) and the rates in Settings. Enter an amount to set a different limit for this project.
          </p>
        </div>
        {editable && (
          <div className="oe-actions">
            {dirty.length > 0 && (
              <Button size="sm" onClick={() => setDraft(null)}>
                Discard
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!dirty.length} busy={busy} onClick={save}>
              Save allocations
            </Button>
          </div>
        )}
      </div>
      <div className="oe-scrollx">
        <table className="oe-table tight">
          <thead>
            <tr>
              <th>Expense type</th>
              <th className="r">Default</th>
              <th style={{ width: 200 }}>Project limit</th>
              <th className="r">Limit used</th>
            </tr>
          </thead>
          <tbody>
            {idx.categories.map((c) => {
              const types = (idx.typesByCat.get(c.id) || []).filter((t) => t.is_active || initial[t.id] != null);
              if (!types.length) return null;
              return (
                <React.Fragment key={c.id}>
                  <tr className="grp">
                    <td colSpan={3}>{c.name}</td>
                    <td className="r">{amt(types.reduce((a, t) => a + effective(t), 0))}</td>
                  </tr>
                  {types.map((t) => {
                    const d = defaultAllocation(project, t, idx);
                    return (
                      <tr key={t.id}>
                        <td style={{ paddingLeft: 22 }}>
                          {t.name}
                          <span className="sub">{allocationHint(d)}</span>
                        </td>
                        <td className="r">{amt(d.amount)}</td>
                        <td>
                          {editable ? (
                            <MoneyInput value={draft[t.id]} onChange={(v) => setDraft((x) => ({ ...(x || initial), [t.id]: v }))} placeholder="Use default" aria-label={`${t.name} limit`} />
                          ) : draft[t.id] != null ? (
                            money(draft[t.id])
                          ) : (
                            <span className="muted">Default</span>
                          )}
                        </td>
                        <td className="r" style={{ fontWeight: draft[t.id] != null ? 600 : undefined }}>
                          {amt(effective(t))}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total allocation</td>
              <td className="r">{money(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   10b. ANALYSIS
   --------------------------------------------------------------------- */
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / 86400000);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmtDays = (n) => (n == null ? "—" : `${Math.round(n * 10) / 10} ${Math.round(n * 10) / 10 === 1 ? "day" : "days"}`);

function Bars({ items, tone = "var(--teal)", unit = "line" }) {
  const max = Math.max(1, ...items.map((b) => b.count));
  return (
    <div className="oe-bars">
      {items.map((b) => (
        <div className="oe-bar-row" key={b.label}>
          <span className="oe-bar-lbl">{b.label}</span>
          <div className="oe-bar-track">
            <div className="oe-bar-fill" style={{ width: `${(b.count / max) * 100}%`, background: b.color || tone }} />
          </div>
          <span className="oe-bar-val num">
            <b>{b.count}</b> {b.count === 1 ? unit : unit + "s"}
            <span className="muted"> · {compact(b.amount)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function AnalysisPage() {
  const tabs = [
    { id: "disbdays", label: "Request to disbursement" },
    { id: "paydays", label: "Disbursed to paid" },
    { id: "expenses", label: "Expenses" },
  ];
  const [tab, setTab] = useState("disbdays");
  return (
    <div className="oe-page">
      <PageHead title="Analysis" desc="Monitoring figures for top management. More analyses can be added here." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Analyses" />
      {tab === "disbdays" && <DisbDaysAnalysis />}
      {tab === "paydays" && <PayDaysAnalysis />}
      {tab === "expenses" && <ExpenseAnalysis />}
    </div>
  );
}

/** How many days liaisons take to give disbursed funds to the client (disbursement date → paid date, per line). */
function PayDaysAnalysis() {
  const { data, idx } = useApp();
  const [f, setF] = useState({ from: "", to: "", liaison: "", target: 7 });
  const set = setter(setF);
  const [openId, setOpenId] = useState(null);
  const today = todayISO();
  const target = Math.max(0, Number(f.target) || 0);

  const rows = useMemo(() => {
    const out = [];
    for (const r of data.requests) {
      if (!r.disbursed_date) continue;
      if (f.from && r.disbursed_date < f.from) continue;
      if (f.to && r.disbursed_date > f.to) continue;
      if (f.liaison && r.liaison_id !== f.liaison) continue;
      for (const l of r.lines) {
        if (!["disbursed", "part_paid", "paid", "closed"].includes(l.status)) continue;
        const paid = !!l.paid_date;
        const days = Math.max(0, daysBetween(r.disbursed_date, paid ? l.paid_date : today));
        out.push({ r, l, paid, days, amount: paid ? linePaid(l) : lineWithLiaison(l) });
      }
    }
    return out;
  }, [data.requests, f.from, f.to, f.liaison, today]);

  const paid = rows.filter((x) => x.paid);
  const unpaid = rows.filter((x) => !x.paid).sort((a, b) => b.days - a.days);
  const avg = paid.length ? paid.reduce((a, x) => a + x.days, 0) / paid.length : null;
  const within = paid.length ? paid.filter((x) => x.days <= target).length / paid.length : null;
  const oldest = unpaid.length ? unpaid[0].days : null;
  const unpaidAmt = unpaid.reduce((a, x) => a + x.amount, 0);

  const bucket = (list, defs) =>
    defs.map(([label, lo, hi, color]) => {
      const inb = list.filter((x) => x.days >= lo && x.days <= hi);
      return { label, count: inb.length, amount: inb.reduce((a, x) => a + x.amount, 0), color };
    });
  const paidBuckets = bucket(paid, [
    ["Same day to 1 day", 0, 1, "var(--green)"],
    ["2 to 3 days", 2, 3, "var(--teal)"],
    ["4 to 7 days", 4, 7, "#c3880f"],
    ["8 to 14 days", 8, 14, "var(--red)"],
    ["15 days or more", 15, Infinity, "var(--red)"],
  ]);
  const waitBuckets = bucket(unpaid, [
    ["0 to 3 days", 0, 3, "var(--teal)"],
    ["4 to 7 days", 4, 7, "#c3880f"],
    ["8 to 14 days", 8, 14, "var(--red)"],
    ["15 to 30 days", 15, 30, "var(--red)"],
    ["Over 30 days", 31, Infinity, "var(--red)"],
  ]);

  const byLiaison = useMemo(() => {
    const m = new Map();
    for (const x of rows) {
      const k = x.r.liaison_id;
      if (!m.has(k)) m.set(k, { id: k, name: x.r.liaison_name, paid: [], unpaid: [] });
      m.get(k)[x.paid ? "paid" : "unpaid"].push(x);
    }
    return [...m.values()]
      .map((g) => ({
        ...g,
        avg: g.paid.length ? g.paid.reduce((a, x) => a + x.days, 0) / g.paid.length : null,
        med: median(g.paid.map((x) => x.days)),
        max: g.paid.length ? Math.max(...g.paid.map((x) => x.days)) : null,
        within: g.paid.length ? g.paid.filter((x) => x.days <= target).length / g.paid.length : null,
        unpaidAmt: g.unpaid.reduce((a, x) => a + x.amount, 0),
        oldest: g.unpaid.length ? Math.max(...g.unpaid.map((x) => x.days)) : null,
      }))
      .sort((a, b) => (b.oldest ?? -1) - (a.oldest ?? -1) || (b.avg ?? 0) - (a.avg ?? 0));
  }, [rows, target]);

  const liaisons = useMemo(
    () => [...new Map(data.requests.filter((r) => r.disbursed_date).map((r) => [r.liaison_id, r.liaison_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [data.requests]
  );

  const exportCSV = () =>
    downloadCSV(`disbursed-to-paid-${today}.csv`, [
      ["Reference", "Line", "Liaison", "Project ID", "Expense type", "Amount", "Disbursed", "Given to client", "Days", "Status"],
      ...[...unpaid, ...paid].map((x) => [
        x.r.ref_no, x.l.line_no, x.r.liaison_name, (idx.projects.get(x.l.project_id) || {}).code, (idx.typesById.get(x.l.type_id) || {}).name,
        x.amount, x.r.disbursed_date, x.l.paid_date || "", x.days, x.paid ? "Given to client" : "Not yet given",
      ]),
    ]);

  const daysCell = (d) => (
    <b className="num" style={{ color: d > target ? "var(--red)" : "var(--ink)" }}>
      {d} {d === 1 ? "day" : "days"}
    </b>
  );

  return (
    <div className="oe-stack">
      <p className="muted" style={{ maxWidth: "80ch" }}>
        Days from the date accounting disbursed the fund to the date the liaison marked the line as given to the client. Lines not yet given are counted up to today.
      </p>
      <Filters style={{ marginBottom: 0 }}>
        <label className="oe-check small">
          Disbursed from <input name="from" className="oe-input" type="date" value={f.from} onChange={set("from")} style={{ width: 150 }} />
        </label>
        <label className="oe-check small">
          to <input name="to" className="oe-input" type="date" value={f.to} onChange={set("to")} style={{ width: 150 }} />
        </label>
        <select name="liaison" className="oe-select" value={f.liaison} onChange={set("liaison")} aria-label="Liaison">
          <option value="">All liaisons</option>
          {liaisons.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label className="oe-check small" title="Lines given to the client within this many days count as on time">
          Target <input name="target" className="oe-input num" inputMode="numeric" value={f.target} onChange={set("target")} style={{ width: 64 }} /> days
        </label>
        <span style={{ flex: 1 }} />
        <Button icon="download" onClick={exportCSV} disabled={!rows.length}>
          Export CSV
        </Button>
      </Filters>

      <dl className="oe-strip" style={{ marginBottom: 0 }}>
        <div>
          <dt>Average days to give to client</dt>
          <dd>{fmtDays(avg)}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd>{fmtDays(median(paid.map((x) => x.days)))}</dd>
        </div>
        <div>
          <dt>Given within {target} {target === 1 ? "day" : "days"}</dt>
          <dd className={within != null && within < 0.8 ? "bad" : ""}>{within == null ? "—" : pct(within)}</dd>
        </div>
        <div>
          <dt>Not yet given to client</dt>
          <dd className={unpaid.length ? "bad" : ""}>
            {unpaid.length} <span className="small muted" style={{ fontWeight: 500 }}>{unpaid.length ? compact(unpaidAmt) : ""}</span>
          </dd>
        </div>
        <div>
          <dt>Longest waiting now</dt>
          <dd className={oldest != null && oldest > target ? "bad" : ""}>{fmtDays(oldest)}</dd>
        </div>
      </dl>

      {rows.length === 0 ? (
        <div className="oe-panel">
          <Empty title="No disbursed requests in this period" body="Change the dates or liaison to see results." />
        </div>
      ) : (
        <>
          <div className="oe-an-grid">
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>Days taken to give to client</h2>
                  <p className="muted small">Lines already given ({paid.length})</p>
                </div>
              </div>
              <div className="oe-panel-b">{paid.length ? <Bars items={paidBuckets} /> : <span className="muted">No lines given to clients yet.</span>}</div>
            </div>
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>Waiting to be given to client</h2>
                  <p className="muted small">Disbursed, not yet given ({unpaid.length})</p>
                </div>
              </div>
              <div className="oe-panel-b">{unpaid.length ? <Bars items={waitBuckets} /> : <span className="muted">Every disbursed line has been given to the client.</span>}</div>
            </div>
          </div>

          <div className="oe-panel">
            <div className="oe-panel-h">
              <div>
                <h2>By liaison</h2>
                <p className="muted small">Sorted by the longest wait still open</p>
              </div>
            </div>
            <div className="oe-scrollx">
              <table className="oe-table">
                <thead>
                  <tr>
                    <th>Liaison</th>
                    <th className="r">Lines given</th>
                    <th className="r">Average</th>
                    <th className="r">Median</th>
                    <th className="r">Longest</th>
                    <th className="r">Within target</th>
                    <th className="r">Not yet given</th>
                    <th className="r">Longest waiting now</th>
                  </tr>
                </thead>
                <tbody>
                  {byLiaison.map((g) => (
                    <tr key={g.id} className="click" tabIndex={0} onClick={() => setF((x) => ({ ...x, liaison: g.id }))} onKeyDown={(e) => e.key === "Enter" && setF((x) => ({ ...x, liaison: g.id }))} title="Show only this liaison">
                      <td style={{ fontWeight: 500, color: "var(--ink)" }}>{g.name}</td>
                      <td className="r">{g.paid.length}</td>
                      <td className="r">{fmtDays(g.avg)}</td>
                      <td className="r">{fmtDays(g.med)}</td>
                      <td className="r">{fmtDays(g.max)}</td>
                      <td className="r" style={{ color: g.within != null && g.within < 0.8 ? "var(--red)" : undefined }}>{g.within == null ? "—" : pct(g.within)}</td>
                      <td className="r">
                        {g.unpaid.length}
                        {g.unpaid.length > 0 && <span className="sub">{compact(g.unpaidAmt)}</span>}
                      </td>
                      <td className="r">{g.oldest == null ? "—" : daysCell(g.oldest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="oe-panel">
            <div className="oe-panel-h">
              <div>
                <h2>Not yet given to client</h2>
                <p className="muted small">Oldest first. Days over the target are in red.</p>
              </div>
            </div>
            {unpaid.length === 0 ? (
              <Empty title="Nothing waiting" body="Every disbursed line in this period has been given to the client." />
            ) : (
              <div className="oe-scrollx">
                <table className="oe-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Liaison</th>
                      <th>Project and expense</th>
                      <th className="r">Amount</th>
                      <th>Disbursed</th>
                      <th className="r">Waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unpaid.map((x) => (
                      <tr key={x.l.id} className="click" tabIndex={0} onClick={() => setOpenId(x.r.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(x.r.id)}>
                        <td>
                          <span className="oe-code">{x.r.ref_no}</span>
                          <span className="sub">Line {x.l.line_no}</span>
                        </td>
                        <td>{x.r.liaison_name}</td>
                        <td>
                          <span className="oe-code">{(idx.projects.get(x.l.project_id) || {}).code}</span> {(idx.typesById.get(x.l.type_id) || {}).name}
                          {x.l.payee && <span className="sub">Payee: {x.l.payee}</span>}
                        </td>
                        <td className="r">{money(x.amount)}</td>
                        <td>{fmtDate(x.r.disbursed_date)}</td>
                        <td className="r">{daysCell(x.days)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {openId && <RequestDrawer requestId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Local calendar date of a timestamp (so a morning approval in Manila isn't counted as the previous day). */
const localDate = (ts) => {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (isNaN(d)) return String(ts).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const stepDays = (a, b) => (a && b ? Math.max(0, daysBetween(a, b)) : null);
const avgOf = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
};

const DISB_STEPS = [
  { id: "approval", label: "Approval", owner: "Top management", waiting: "For approval" },
  { id: "erp", label: "ERP reference", owner: "Liaison", waiting: "Waiting for ERP reference" },
  { id: "disburse", label: "Disbursement", owner: "Accounting", waiting: "Waiting for disbursement" },
];

/** How many days from filing a request until accounting disburses it, split by step. */
function DisbDaysAnalysis() {
  const { data, idx } = useApp();
  const [f, setF] = useState({ from: "", to: "", liaison: "", target: 7 });
  const set = setter(setF);
  const [openId, setOpenId] = useState(null);
  const today = todayISO();
  const target = Math.max(0, Number(f.target) || 0);

  const { done, pending } = useMemo(() => {
    const done = [];
    const pending = [];
    for (const r of data.requests) {
      if (f.from && r.request_date < f.from) continue;
      if (f.to && r.request_date > f.to) continue;
      if (f.liaison && r.liaison_id !== f.liaison) continue;
      const filed = r.request_date;
      const appr = localDate(r.approved_at);
      const erp = localDate(r.erp_ref_at);
      if (r.disbursed_date) {
        done.push({
          r, amount: reqTotal(r),
          total: stepDays(filed, r.disbursed_date),
          steps: { approval: stepDays(filed, appr), erp: stepDays(appr, erp), disburse: stepDays(erp, r.disbursed_date) },
        });
      } else if (r.status === "on_hold" || r.status === "open") {
        const step = r.status === "on_hold" ? "approval" : r.erp_ref ? "disburse" : "erp";
        const since = step === "approval" ? filed : step === "erp" ? appr : erp;
        pending.push({
          r, step, amount: r.status === "on_hold" ? reqRequested(r) : reqTotal(r),
          total: stepDays(filed, today), inStep: stepDays(since || filed, today),
        });
      }
    }
    pending.sort((a, b) => b.total - a.total);
    return { done, pending };
  }, [data.requests, f.from, f.to, f.liaison, today]);

  const totals = done.map((x) => x.total);
  const avg = avgOf(totals);
  const within = done.length ? done.filter((x) => x.total <= target).length / done.length : null;
  const oldest = pending.length ? pending[0].total : null;
  const pendingAmt = pending.reduce((a, x) => a + x.amount, 0);

  const stepStats = DISB_STEPS.map((s) => ({
    ...s,
    avg: avgOf(done.map((x) => x.steps[s.id])),
    waitingNow: pending.filter((x) => x.step === s.id),
  }));
  const maxStep = Math.max(1, ...stepStats.map((s) => s.avg || 0));
  const slowest = stepStats.reduce((m, s) => (s.avg != null && (m == null || s.avg > m.avg) ? s : m), null);

  const buckets = [
    ["Up to 3 days", 0, 3, "var(--green)"],
    ["4 to 7 days", 4, 7, "var(--teal)"],
    ["8 to 14 days", 8, 14, "#c3880f"],
    ["15 to 30 days", 15, 30, "var(--red)"],
    ["Over 30 days", 31, Infinity, "var(--red)"],
  ].map(([label, lo, hi, color]) => {
    const inb = done.filter((x) => x.total >= lo && x.total <= hi);
    return { label, count: inb.length, amount: inb.reduce((a, x) => a + x.amount, 0), color };
  });

  const byLiaison = useMemo(() => {
    const m = new Map();
    for (const x of [...done, ...pending]) {
      const k = x.r.liaison_id;
      if (!m.has(k)) m.set(k, { id: k, name: x.r.liaison_name, done: [], pending: [] });
      m.get(k)[x.step ? "pending" : "done"].push(x);
    }
    return [...m.values()]
      .map((g) => ({
        ...g,
        avg: avgOf(g.done.map((x) => x.total)),
        erp: avgOf(g.done.map((x) => x.steps.erp)),
        oldest: g.pending.length ? Math.max(...g.pending.map((x) => x.total)) : null,
      }))
      .sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));
  }, [done, pending]);

  const liaisons = useMemo(
    () => [...new Map(data.requests.map((r) => [r.liaison_id, r.liaison_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [data.requests]
  );

  const exportCSV = () =>
    downloadCSV(`request-to-disbursement-${today}.csv`, [
      ["Reference", "Liaison", "Request date", "Approved", "ERP reference entered", "Disbursed", "Approval days", "ERP reference days", "Disbursement days", "Total days", "Status", "Amount"],
      ...done.map((x) => [x.r.ref_no, x.r.liaison_name, x.r.request_date, localDate(x.r.approved_at), localDate(x.r.erp_ref_at), x.r.disbursed_date, x.steps.approval, x.steps.erp, x.steps.disburse, x.total, "Disbursed", x.amount]),
      ...pending.map((x) => [x.r.ref_no, x.r.liaison_name, x.r.request_date, localDate(x.r.approved_at) || "", localDate(x.r.erp_ref_at) || "", "", "", "", "", x.total, DISB_STEPS.find((s) => s.id === x.step).waiting, x.amount]),
    ]);

  const daysCell = (d) => (
    <b className="num" style={{ color: d > target ? "var(--red)" : "var(--ink)" }}>
      {d} {d === 1 ? "day" : "days"}
    </b>
  );

  return (
    <div className="oe-stack">
      <p className="muted" style={{ maxWidth: "80ch" }}>
        Days from the request date to the date accounting disbursed the fund, split into approval, ERP reference and disbursement. Requests not yet disbursed are counted up to today.
      </p>
      <Filters style={{ marginBottom: 0 }}>
        <label className="oe-check small">
          Requested from <input name="from" className="oe-input" type="date" value={f.from} onChange={set("from")} style={{ width: 150 }} />
        </label>
        <label className="oe-check small">
          to <input name="to" className="oe-input" type="date" value={f.to} onChange={set("to")} style={{ width: 150 }} />
        </label>
        <select name="liaison" className="oe-select" value={f.liaison} onChange={set("liaison")} aria-label="Liaison">
          <option value="">All liaisons</option>
          {liaisons.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label className="oe-check small" title="Requests disbursed within this many days count as on time">
          Target <input name="target" className="oe-input num" inputMode="numeric" value={f.target} onChange={set("target")} style={{ width: 64 }} /> days
        </label>
        <span style={{ flex: 1 }} />
        <Button icon="download" onClick={exportCSV} disabled={!done.length && !pending.length}>
          Export CSV
        </Button>
      </Filters>

      <dl className="oe-strip" style={{ marginBottom: 0 }}>
        <div>
          <dt>Average days to disbursement</dt>
          <dd>{fmtDays(avg)}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd>{fmtDays(median(totals))}</dd>
        </div>
        <div>
          <dt>Disbursed within {target} {target === 1 ? "day" : "days"}</dt>
          <dd className={within != null && within < 0.8 ? "bad" : ""}>{within == null ? "—" : pct(within)}</dd>
        </div>
        <div>
          <dt>Not yet disbursed</dt>
          <dd className={pending.length ? "bad" : ""}>
            {pending.length} <span className="small muted" style={{ fontWeight: 500 }}>{pending.length ? compact(pendingAmt) : ""}</span>
          </dd>
        </div>
        <div>
          <dt>Longest waiting now</dt>
          <dd className={oldest != null && oldest > target ? "bad" : ""}>{fmtDays(oldest)}</dd>
        </div>
      </dl>

      {done.length === 0 && pending.length === 0 ? (
        <div className="oe-panel">
          <Empty title="No requests in this period" body="Change the dates or liaison to see results." />
        </div>
      ) : (
        <>
          <div className="oe-an-grid">
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>Average days per step</h2>
                  <p className="muted small">
                    Disbursed requests ({done.length}){slowest && slowest.avg > 0 ? ` · slowest step: ${slowest.label.toLowerCase()}` : ""}
                  </p>
                </div>
              </div>
              <div className="oe-panel-b">
                <div className="oe-bars">
                  {stepStats.map((s) => (
                    <div className="oe-bar-row oe-step-row" key={s.id}>
                      <span className="oe-bar-lbl">
                        {s.label}
                        <span className="sub muted small" style={{ display: "block" }}>
                          {s.owner}
                        </span>
                      </span>
                      <div className="oe-bar-track">
                        <div className="oe-bar-fill" style={{ width: `${((s.avg || 0) / maxStep) * 100}%`, background: slowest && s.id === slowest.id ? "#c3880f" : "var(--teal)" }} />
                      </div>
                      <span className="oe-bar-val num">
                        <b>{fmtDays(s.avg)}</b>
                        <span className="muted"> · {s.waitingNow.length} waiting now</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>Days from request to disbursement</h2>
                  <p className="muted small">Disbursed requests ({done.length})</p>
                </div>
              </div>
              <div className="oe-panel-b">{done.length ? <Bars items={buckets.map((b) => ({ ...b }))} unit="request" /> : <span className="muted">No requests disbursed yet.</span>}</div>
            </div>
          </div>

          <div className="oe-panel">
            <div className="oe-panel-h">
              <div>
                <h2>By liaison</h2>
                <p className="muted small">The ERP reference step is the part the liaison controls</p>
              </div>
            </div>
            <div className="oe-scrollx">
              <table className="oe-table">
                <thead>
                  <tr>
                    <th>Liaison</th>
                    <th className="r">Requests disbursed</th>
                    <th className="r">Average to disbursement</th>
                    <th className="r">Average ERP reference step</th>
                    <th className="r">Not yet disbursed</th>
                    <th className="r">Longest waiting now</th>
                  </tr>
                </thead>
                <tbody>
                  {byLiaison.map((g) => (
                    <tr key={g.id} className="click" tabIndex={0} onClick={() => setF((x) => ({ ...x, liaison: g.id }))} onKeyDown={(e) => e.key === "Enter" && setF((x) => ({ ...x, liaison: g.id }))} title="Show only this liaison">
                      <td style={{ fontWeight: 500, color: "var(--ink)" }}>{g.name}</td>
                      <td className="r">{g.done.length}</td>
                      <td className="r">{fmtDays(g.avg)}</td>
                      <td className="r">{fmtDays(g.erp)}</td>
                      <td className="r">{g.pending.length}</td>
                      <td className="r">{g.oldest == null ? "—" : daysCell(g.oldest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="oe-panel">
            <div className="oe-panel-h">
              <div>
                <h2>Not yet disbursed</h2>
                <p className="muted small">Oldest first, with the step each request is waiting on. Days over the target are in red.</p>
              </div>
            </div>
            {pending.length === 0 ? (
              <Empty title="Nothing waiting" body="Every approved request in this period has been disbursed." />
            ) : (
              <div className="oe-scrollx">
                <table className="oe-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Liaison</th>
                      <th className="r">Amount</th>
                      <th>Request date</th>
                      <th>Waiting on</th>
                      <th className="r">In this step</th>
                      <th className="r">Since request</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((x) => {
                      const st = DISB_STEPS.find((s) => s.id === x.step);
                      return (
                        <tr key={x.r.id} className="click" tabIndex={0} onClick={() => setOpenId(x.r.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(x.r.id)}>
                          <td>
                            <span className="oe-code">{x.r.ref_no}</span>
                            <span className="sub">
                              {x.r.lines.length} {x.r.lines.length === 1 ? "line" : "lines"}
                            </span>
                          </td>
                          <td>{x.r.liaison_name}</td>
                          <td className="r">{money(x.amount)}</td>
                          <td>{fmtDate(x.r.request_date)}</td>
                          <td>
                            {st.label}
                            <span className="sub">{st.owner}</span>
                          </td>
                          <td className="r num">
                            {x.inStep} {x.inStep === 1 ? "day" : "days"}
                          </td>
                          <td className="r">{daysCell(x.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {openId && <RequestDrawer requestId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

const CAT_COLORS = ["var(--teal)", "var(--blue)", "#c3880f", "var(--violet)", "var(--leaf)", "#2f8fb0", "var(--red)", "var(--slate)"];
const AMOUNT_BASIS = {
  approved: { label: "Approved to date", statuses: ["open", "disbursed", "part_paid", "paid", "closed"] },
  released: { label: "Released (disbursed or later)", statuses: ["disbursed", "part_paid", "paid", "closed"] },
  all: { label: "Including for approval", statuses: ["on_hold", "open", "disbursed", "part_paid", "paid", "closed"] },
};
const monthKey = (iso) => String(iso).slice(0, 7);
const monthLabel = (key) => new Date(key + "-01T00:00:00").toLocaleDateString("en-PH", { month: "short", year: "2-digit" });

function AmountBars({ items, total, onPick, picked }) {
  const max = Math.max(1, ...items.map((b) => b.amount));
  return (
    <div className="oe-bars">
      {items.map((b) => (
        <button
          type="button"
          key={b.id}
          className={`oe-bar-row oe-bar-btn ${picked === b.id ? "on" : ""}`}
          onClick={() => onPick && onPick(picked === b.id ? "" : b.id)}
          title={onPick ? (picked === b.id ? "Show all" : `Show only ${b.label}`) : undefined}
        >
          <span className="oe-bar-lbl">
            <i className="oe-dot" style={{ background: b.color }} />
            {b.label}
          </span>
          <div className="oe-bar-track">
            <div className="oe-bar-fill" style={{ width: `${(b.amount / max) * 100}%`, background: b.color }} />
          </div>
          <span className="oe-bar-val num">
            <b>{compact(b.amount)}</b>
            <span className="muted">
              {" "}
              · {total ? pct(b.amount / total) : "—"} · {b.count} {b.count === 1 ? "line" : "lines"}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Which expense categories and types carry the most amount. */
function ExpenseAnalysis() {
  const { data, idx } = useApp();
  const [f, setF] = useState({ from: "", to: "", basis: "approved", project: "" });
  const set = setter(setF);
  const [cat, setCat] = useState("");
  const [type, setType] = useState("");
  const statuses = AMOUNT_BASIS[f.basis].statuses;

  // one entry per line (or per reclassified part, so projects are attributed correctly)
  const items = useMemo(() => {
    const out = [];
    for (const r of data.requests) {
      if (f.from && r.request_date < f.from) continue;
      if (f.to && r.request_date > f.to) continue;
      for (const l of r.lines) {
        if (!statuses.includes(l.status)) continue;
        const amount = l.status === "on_hold" ? Number(l.amount) : lineNet(l);
        if (!(amount > 0)) continue;
        const parts = (l.reclass || []).map((x) => ({ project_id: x.project_id, amount: Number(x.amount) }));
        const rest = round2(amount - parts.reduce((a, x) => a + x.amount, 0));
        const pieces = [...parts, ...(rest > 0.004 ? [{ project_id: l.project_id, amount: rest }] : [])];
        for (const pc of pieces) {
          if (f.project && pc.project_id !== f.project) continue;
          out.push({ r, l, lineKey: l.id, project_id: pc.project_id, category_id: l.category_id, type_id: l.type_id, amount: pc.amount, month: monthKey(r.request_date) });
        }
      }
    }
    return out;
  }, [data.requests, f.from, f.to, f.project, statuses]);

  const total = items.reduce((a, x) => a + x.amount, 0);
  const lineCount = (list) => new Set(list.map((x) => x.lineKey)).size;
  const catColor = useMemo(() => {
    const m = new Map();
    idx.categories.forEach((c, i) => m.set(c.id, CAT_COLORS[i % CAT_COLORS.length]));
    return m;
  }, [idx.categories]);

  const byCat = useMemo(() => {
    const m = new Map();
    for (const x of items) {
      if (!m.has(x.category_id)) m.set(x.category_id, []);
      m.get(x.category_id).push(x);
    }
    return [...m.entries()]
      .map(([id, list]) => ({ id, label: (idx.cats.get(id) || {}).name || "?", amount: list.reduce((a, x) => a + x.amount, 0), count: lineCount(list), color: catColor.get(id) || "var(--slate)" }))
      .sort((a, b) => b.amount - a.amount);
  }, [items, idx, catColor]);

  const scoped = cat ? items.filter((x) => x.category_id === cat) : items;
  const scopedTotal = scoped.reduce((a, x) => a + x.amount, 0);
  const byType = useMemo(() => {
    const m = new Map();
    for (const x of scoped) {
      if (!m.has(x.type_id)) m.set(x.type_id, []);
      m.get(x.type_id).push(x);
    }
    let running = 0;
    return [...m.entries()]
      .map(([id, list]) => {
        const t = idx.typesById.get(id) || {};
        return { id, name: t.name || "?", category_id: t.category_id, amount: list.reduce((a, x) => a + x.amount, 0), count: lineCount(list), projects: new Set(list.map((x) => x.project_id)).size };
      })
      .sort((a, b) => b.amount - a.amount)
      .map((row) => {
        const before = running;
        running += row.amount;
        return { ...row, share: scopedTotal ? row.amount / scopedTotal : 0, cumulative: scopedTotal ? running / scopedTotal : 0, core: scopedTotal ? before / scopedTotal < 0.8 : false };
      });
  }, [scoped, scopedTotal, idx]);

  const typeSel = type && byType.some((t) => t.id === type) ? type : "";
  const drill = typeSel ? scoped.filter((x) => x.type_id === typeSel) : [];
  const byProject = useMemo(() => {
    const m = new Map();
    for (const x of drill) {
      const cur = m.get(x.project_id) || { id: x.project_id, amount: 0, lines: new Set() };
      cur.amount += x.amount;
      cur.lines.add(x.lineKey);
      m.set(x.project_id, cur);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);
  }, [drill]);
  const drillTotal = drill.reduce((a, x) => a + x.amount, 0);

  const months = useMemo(() => {
    const m = new Map();
    for (const x of items) {
      if (!m.has(x.month)) m.set(x.month, new Map());
      const mm = m.get(x.month);
      mm.set(x.category_id, (mm.get(x.category_id) || 0) + x.amount);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-12)
      .map(([key, mm]) => ({ key, total: [...mm.values()].reduce((a, v) => a + v, 0), parts: byCat.map((c) => ({ id: c.id, label: c.label, color: c.color, amount: mm.get(c.id) || 0 })).filter((p) => p.amount > 0) }));
  }, [items, byCat]);
  const monthMax = Math.max(1, ...months.map((m) => m.total));

  const topCat = byCat[0];
  const topType = [...byType].sort((a, b) => b.amount - a.amount)[0];
  const coreCount = byType.filter((t) => t.core).length;

  const exportCSV = () =>
    downloadCSV(`expense-analysis-${todayISO()}.csv`, [
      ["Rank", "Expense type", "Category", "Lines", "Projects", "Amount", "Share %", "Cumulative %"],
      ...byType.map((t, i) => [i + 1, t.name, (idx.cats.get(t.category_id) || {}).name, t.count, t.projects, round2(t.amount), round2(t.share * 100), round2(t.cumulative * 100)]),
    ]);

  return (
    <div className="oe-stack">
      <p className="muted" style={{ maxWidth: "80ch" }}>
        Which expense categories and types carry the most amount. Amounts filed under FOR-ASSIGNMENT or ADVANCES follow any reclassification when you filter by project.
      </p>
      <Filters style={{ marginBottom: 0 }}>
        <label className="oe-check small">
          Request date from <input name="from" className="oe-input" type="date" value={f.from} onChange={set("from")} style={{ width: 150 }} />
        </label>
        <label className="oe-check small">
          to <input name="to" className="oe-input" type="date" value={f.to} onChange={set("to")} style={{ width: 150 }} />
        </label>
        <select name="basis" className="oe-select" value={f.basis} onChange={set("basis")} aria-label="Amount basis">
          {Object.entries(AMOUNT_BASIS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <div style={{ width: 190 }}>
          <ProjectPicker projects={data.projects} value={f.project} onChange={(id) => setF((x) => ({ ...x, project: id }))} label="Filter by project ID" allLabel="All projects" />
        </div>
        <span style={{ flex: 1 }} />
        <Button icon="download" onClick={exportCSV} disabled={!byType.length}>
          Export CSV
        </Button>
      </Filters>

      <dl className="oe-strip" style={{ marginBottom: 0 }}>
        <div>
          <dt>Total amount</dt>
          <dd>{compact(total)}</dd>
        </div>
        <div>
          <dt>Top category</dt>
          <dd style={{ fontSize: 17 }}>{topCat ? topCat.label : "—"}</dd>
          {topCat && <span className="muted small">{pct(topCat.amount / total)} · {compact(topCat.amount)}</span>}
        </div>
        <div>
          <dt>Top expense type</dt>
          <dd style={{ fontSize: 17 }}>{topType ? topType.name : "—"}</dd>
          {topType && <span className="muted small">{pct(topType.amount / (scopedTotal || 1))} · {compact(topType.amount)}</span>}
        </div>
        <div>
          <dt>Request lines</dt>
          <dd>{lineCount(items)}</dd>
        </div>
        <div>
          <dt>Average per line</dt>
          <dd>{lineCount(items) ? compact(total / lineCount(items)) : "—"}</dd>
        </div>
      </dl>

      {items.length === 0 ? (
        <div className="oe-panel">
          <Empty title="No amounts in this selection" body="Change the dates, basis or project to see results." />
        </div>
      ) : (
        <>
          <div className="oe-an-grid">
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>By category</h2>
                  <p className="muted small">Click a category to rank only its expense types</p>
                </div>
                {cat && (
                  <Button size="sm" variant="ghost" onClick={() => setCat("")}>
                    Show all
                  </Button>
                )}
              </div>
              <div className="oe-panel-b">
                <AmountBars
                  items={byCat}
                  total={total}
                  picked={cat}
                  onPick={(id) => {
                    setCat(id);
                    setType("");
                  }}
                />
              </div>
            </div>
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>By month</h2>
                  <p className="muted small">Request date, latest 12 months in the selection</p>
                </div>
              </div>
              <div className="oe-panel-b">
                <div className="oe-months">
                  {months.map((m) => (
                    <div className="oe-month" key={m.key} title={`${monthLabel(m.key)}: ${money(m.total)}`}>
                      <span className="oe-month-amt num">{compact(m.total)}</span>
                      <div className="oe-month-bar" style={{ height: `${Math.max(4, (m.total / monthMax) * 150)}px` }}>
                        {m.parts.map((p) => (
                          <div key={p.id} style={{ flex: p.amount, background: p.color }} title={`${p.label}: ${money(p.amount)}`} />
                        ))}
                      </div>
                      <span className="oe-month-lbl">{monthLabel(m.key)}</span>
                    </div>
                  ))}
                </div>
                <div className="oe-legend">
                  {byCat.map((c) => (
                    <span key={c.id}>
                      <i className="oe-dot" style={{ background: c.color }} />
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="oe-panel">
            <div className="oe-panel-h">
              <div>
                <h2>Expense types ranked{cat ? `: ${(idx.cats.get(cat) || {}).name}` : ""}</h2>
                <p className="muted small">
                  {coreCount} of {byType.length} {byType.length === 1 ? "type makes" : "types make"} up 80% of the amount (highlighted). Click a type to see its projects.
                </p>
              </div>
            </div>
            <div className="oe-scrollx">
              <table className="oe-table">
                <thead>
                  <tr>
                    <th className="r" style={{ width: 44 }}>#</th>
                    <th>Expense type</th>
                    <th>Category</th>
                    <th className="r">Lines</th>
                    <th className="r">Projects</th>
                    <th className="r">Amount</th>
                    <th style={{ width: 220 }}>Share</th>
                    <th className="r">Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  {byType.map((t, i) => (
                    <tr
                      key={t.id}
                      className={`click ${t.core ? "oe-core" : ""} ${typeSel === t.id ? "sel" : ""}`}
                      tabIndex={0}
                      onClick={() => setType(typeSel === t.id ? "" : t.id)}
                      onKeyDown={(e) => e.key === "Enter" && setType(typeSel === t.id ? "" : t.id)}
                    >
                      <td className="r">{i + 1}</td>
                      <td style={{ fontWeight: 500, color: "var(--ink)" }}>{t.name}</td>
                      <td>
                        <i className="oe-dot" style={{ background: catColor.get(t.category_id) }} />
                        {(idx.cats.get(t.category_id) || {}).name}
                      </td>
                      <td className="r">{t.count}</td>
                      <td className="r">{t.projects}</td>
                      <td className="r">{money(t.amount)}</td>
                      <td>
                        <div className="oe-share">
                          <div className="oe-bar-track">
                            <div className="oe-bar-fill" style={{ width: `${t.share * 100}%`, background: catColor.get(t.category_id) }} />
                          </div>
                          <span className="num">{pct(t.share, 1)}</span>
                        </div>
                      </td>
                      <td className="r num">{pct(t.cumulative, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {typeSel && (
            <div className="oe-panel">
              <div className="oe-panel-h">
                <div>
                  <h2>Projects spending on {(idx.typesById.get(typeSel) || {}).name}</h2>
                  <p className="muted small">Top 10 by amount, total {money(drillTotal)}</p>
                </div>
                <Button size="sm" variant="ghost" icon="x" onClick={() => setType("")}>
                  Close
                </Button>
              </div>
              <div className="oe-scrollx">
                <table className="oe-table tight">
                  <thead>
                    <tr>
                      <th>Project ID</th>
                      <th>District</th>
                      <th className="r">Lines</th>
                      <th className="r">Amount</th>
                      <th style={{ width: 240 }}>Share of this type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byProject.map((p) => {
                      const pr = idx.projects.get(p.id) || {};
                      const share = drillTotal ? p.amount / drillTotal : 0;
                      return (
                        <tr key={p.id}>
                          <td className="oe-code">{pr.code || "?"}</td>
                          <td>{pr.district || (pr.is_internal ? "Internal" : "—")}</td>
                          <td className="r">{p.lines.size}</td>
                          <td className="r">{money(p.amount)}</td>
                          <td>
                            <div className="oe-share">
                              <div className="oe-bar-track">
                                <div className="oe-bar-fill" style={{ width: `${share * 100}%`, background: "var(--teal)" }} />
                              </div>
                              <span className="num">{pct(share, 1)}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   11. NEW REQUEST (liaison)
   --------------------------------------------------------------------- */
const blankLine = (project_id = "") => ({
  key: uid(), project_id, category_id: "", type_id: "", description: "", payee: "", detail: "",
  basis_amount: null, basis_pct: null, rate: null, amount: null, touched: false, files: [],
});

/** Form state for editing a request that is still for approval. */
const linesFromRequest = (r) =>
  r.lines.map((l) => ({
    ...blankLine(l.project_id),
    id: l.id, category_id: l.category_id, type_id: l.type_id, description: l.description || "", payee: l.payee || "", detail: l.detail || "",
    basis_amount: l.basis_amount ?? null, basis_pct: l.basis_pct ?? null, rate: l.rate ?? null, amount: Number(l.amount), touched: true,
    existingDocs: l.documents || [],
    // what top management approved last time, shown when it differs from what was requested
    approvedBefore: r.status === "open" && l.approved_amount != null && Math.abs(Number(l.approved_amount) - Number(l.amount)) > 0.004 ? Number(l.approved_amount) : null,
  }));
const editSnapshot = (head, lines) =>
  JSON.stringify([head, lines.map((l) => [l.id, l.project_id, l.type_id, l.description, l.payee, l.detail, l.basis_amount, l.basis_pct, l.rate, l.amount, (l.existingDocs || []).map((d) => d.id), l.files.length])]);

function NewRequestPage({ params }) {
  const { data, idx, me, can, api, run, settings, go, ui } = useApp();
  const showLimits = can("thresholds.view");
  // edit mode: a request of yours that is still for approval
  const editId = params && params.editId;
  const editing = editId ? data.requests.find((x) => x.id === editId) : null;
  const [initial] = useState(() =>
    editing
      ? { head: { request_date: editing.request_date, date_needed: editing.date_needed || "", remarks: editing.remarks || "" }, lines: linesFromRequest(editing) }
      : { head: { request_date: todayISO(), date_needed: "", remarks: "" }, lines: [blankLine()] }
  );
  const [head, setHead] = useState(initial.head);
  const [lines, setLines] = useState(initial.lines);
  const [baseline] = useState(() => editSnapshot(initial.head, initial.lines));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const activeCats = idx.categories.filter((c) => c.is_active);
  const dirty = editId
    ? !done && editSnapshot(head, lines) !== baseline
    : !done &&
    (head.remarks.trim() !== "" ||
      head.date_needed !== "" ||
      lines.some((l) => l.project_id || l.category_id || l.type_id || l.amount != null || l.description.trim() || l.payee.trim() || l.detail.trim() || l.files.length));
  useLeaveGuard(dirty, editId ? "Discard your changes?" : "Discard this request?", editId ? "Your changes to this request will be lost." : "The lines you entered will be lost.");

  const recompute = (l, patch) => {
    const next = { ...l, ...patch };
    const project = idx.projects.get(next.project_id);
    const type = idx.typesById.get(next.type_id);
    if ("amount" in patch) next.touched = true;
    if ("type_id" in patch) next.touched = false;
    if ("reset" in patch) {
      next.touched = false; // "use calculated amount"
      delete next.reset;
    }
    if (!type) {
      if ("type_id" in patch) Object.assign(next, { basis_amount: null, basis_pct: null, rate: null, amount: null });
      return next;
    }
    if ("type_id" in patch || "project_id" in patch) {
      if (type.calc_method === "manual") Object.assign(next, { basis_amount: null, basis_pct: null, rate: null });
      else {
        next.rate = effectiveRate(project, type, idx);
        if (type.calc_method === "contract_pct") next.basis_amount = project ? contractBase(project) || null : null;
      }
    }
    if (!next.touched && type.calc_method !== "manual")
      next.amount = next.basis_amount && next.rate ? round2((next.basis_amount * next.rate) / 100) : null;
    return next;
  };
  const updateLine = (key, patch) => {
    setLines((ls) => ls.map((l) => (l.key === key ? recompute(l, patch) : l)));
    // a line's validation messages go away once it is edited; submit checks again
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };
  // a new line starts on the previous line's project, since lines usually share one
  const addLine = () => setLines((ls) => [...ls, blankLine(ls.length ? ls[ls.length - 1].project_id : "")]);

  const checks = useMemo(
    () =>
      showLimits
        ? checkLines(
            lines.map((l) => ({ project_id: l.project_id, type_id: l.type_id, amount: l.amount })),
            idx,
            settings,
            false,
            editing // the request's own original amounts
              ? editing.lines
                  .filter((l) => l.status === "on_hold" || l.status === "open")
                  .map((l) => ({ project_id: l.project_id, type_id: l.type_id, amount: l.status === "open" ? l.approved_amount ?? l.amount : l.amount, used: l.status === "open" }))
              : null
          )
        : [],
    [lines, idx, settings, showLimits]
  );
  const total = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const overCount = checks.filter((c) => c && (c.state === "over" || c.state === "none")).length;
  const catTotals = activeCats.map((c) => ({ c, amount: lines.reduce((a, l) => a + (l.category_id === c.id ? Number(l.amount) || 0 : 0), 0) }));
  const projectCount = new Set(lines.map((l) => l.project_id).filter(Boolean)).size;

  const validate = () => {
    const e = {};
    lines.forEach((l) => {
      const le = {};
      if (!l.project_id) le.project_id = "Choose a project";
      if (!l.category_id) le.category_id = "Choose a category";
      if (!l.type_id) le.type_id = "Choose an expense type";
      if (!(Number(l.amount) > 0)) le.amount = "Enter an amount";
      else {
        const lt = idx.typesById.get(l.type_id);
        const cap = lt && lt.calc_method === "contract_pct" && l.basis_amount && l.rate ? round2((l.basis_amount * l.rate) / 100) : null;
        if (cap != null && Number(l.amount) > cap + 0.004) le.amount = `Amount can't exceed the calculated ${money(cap)}`;
      }
      if (!l.payee.trim()) le.payee = "Enter the payee";
      const lc = idx.cats.get(l.category_id);
      if (lc && lc.require_document && !l.files.length && !(l.existingDocs || []).length) le.document = "Attach a supporting document";
      const t = idx.typesById.get(l.type_id);
      if (t && t.detail_label && !l.detail.trim()) le.detail = `Fill in ${t.detail_label}`;
      if (Object.keys(le).length) e[l.key] = le;
    });
    if (!head.request_date) e.head = "Enter the request date";
    if (!head.date_needed) e.head_needed = "Enter the date needed";
    else if (head.request_date && head.date_needed < head.request_date) e.head_needed = "Can't be before the request date";
    if (!head.remarks.trim()) e.head_desc = "Enter a description";
    setErrors(e);
    return !Object.values(e).some(Boolean);
  };

  const submit = async () => {
    if (!validate()) {
      ui.err("Some lines are incomplete. Check the highlighted fields.");
      return;
    }
    const ans = await ui.confirm({
      title: editId ? `Save changes to ${editing.ref_no}?` : "Submit request?",
      confirmLabel: editId ? "Save changes" : "Submit request",
      body: (
        <div className="oe-stack">
          <p>
            {lines.length} {lines.length === 1 ? "line" : "lines"} totaling <b>{money(total)}</b>{" "}
            {editId
              ? editing.status === "open"
                ? `go back to top management for approval under ${editing.ref_no}. The current approval${editing.erp_ref ? ` and ERP reference ${editing.erp_ref}` : ""} will be cleared.`
                : `stay in the approval queue under ${editing.ref_no}. Top management will see the updated request.`
              : "will go to top management for approval. The reference ID is generated when you submit."}
          </p>
          {overCount > 0 && <Note tone="warn" icon="alert">{overCount} {overCount === 1 ? "line exceeds" : "lines exceed"} the project allocation. Approvers will see this.</Note>}
        </div>
      ),
    });
    if (ans === null) return;
    setBusy(true);
    // upload supporting documents first; the request then records where each file is
    const uploaded = [];
    try {
      for (const l of lines) {
        const docs = [];
        for (const f of l.files) docs.push(await api.uploadDocument(f.file));
        uploaded.push(docs);
      }
    } catch (e) {
      setBusy(false);
      ui.err((e && e.message) || "A document could not be uploaded.");
      return;
    }
    if (editId) {
      const saved = await run(
        () =>
          api.updateRequest(editId, {
            ...head,
            date_needed: head.date_needed || null,
            lines: lines.map((l, i) => ({
              id: l.id || null, project_id: l.project_id, type_id: l.type_id, description: l.description, payee: l.payee, detail: l.detail,
              basis_amount: l.basis_amount, basis_pct: l.basis_pct, rate: l.rate, amount: round2(l.amount),
              keep_documents: (l.existingDocs || []).map((d) => d.id), documents: uploaded[i],
            })),
          }),
        `${editing.ref_no} updated`
      );
      setBusy(false);
      if (saved) {
        setDone({ edited: true });
        go("requests", { requestId: editId });
      }
      return;
    }
    const ref = await run(
      () =>
        api.createRequest({
          ...head,
          project_id: new Set(lines.map((l) => l.project_id)).size === 1 ? lines[0].project_id : null,
          date_needed: head.date_needed || null,
          lines: lines.map((l, i) => ({
            project_id: l.project_id, type_id: l.type_id, description: l.description, payee: l.payee, detail: l.detail,
            basis_amount: l.basis_amount, basis_pct: l.basis_pct, rate: l.rate, amount: round2(l.amount), documents: uploaded[i],
          })),
        }),
      (r) => `Request ${r} submitted`
    );
    setBusy(false);
    if (ref) {
      setDone({ ref, total, count: lines.length });
      setLines([blankLine()]);
      setHead((h) => ({ ...h, remarks: "", date_needed: "" }));
      setErrors({});
    }
  };

  if (editId && !editing)
    return (
      <div className="oe-page">
        <div className="oe-panel" style={{ maxWidth: 620 }}>
          <Empty title="This request is no longer available" body="It may have been removed, or you no longer have access to it." action={<Button onClick={() => go("requests")}>Open request list</Button>} />
        </div>
      </div>
    );
  if (editing && !["on_hold", "open"].includes(editing.status) && !done)
    return (
      <div className="oe-page">
        <div className="oe-panel" style={{ maxWidth: 620 }}>
          <Empty
            title={`${editing.ref_no} can no longer be edited`}
            body="It has already been disbursed, closed, rejected or withdrawn, so its lines are locked."
            action={<Button onClick={() => go("requests", { requestId: editing.id })}>Open the request</Button>}
          />
        </div>
      </div>
    );
  if (done && done.edited) return null;
  if (done)
    return (
      <div className="oe-page">
        <div className="oe-panel" style={{ maxWidth: 620 }}>
          <div className="oe-panel-b oe-stack">
            <Chip tone="amber">For approval</Chip>
            <div>
              <p className="muted">Request reference</p>
              <h1 style={{ fontSize: 32, letterSpacing: "-.02em" }} className="num">
                {done.ref}
              </h1>
            </div>
            <p>
              {done.count} {done.count === 1 ? "line" : "lines"}, {money(done.total)}. Once approved, file the cash advance in Acumatica, then enter its ERP reference number on this request.
            </p>
            <div className="oe-actions">
              <Button icon="copy" onClick={() => copyText(done.ref).then(() => ui.ok("Reference copied"))}>
                Copy reference
              </Button>
              <Button variant="primary" icon="plus" onClick={() => setDone(null)}>
                File another request
              </Button>
              {(can("requests.view_own") || can("requests.view_all")) && (
                <Button variant="ghost" onClick={() => go("requests")}>
                  Open request list
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="oe-page narrow">
      <PageHead
        title={editing ? `Edit ${editing.ref_no}` : "New request"}
        desc={
          editing
            ? editing.status === "open"
              ? `This request is already approved. Saving changes sends it back to top management for approval${editing.erp_ref ? ` and clears ERP reference ${editing.erp_ref}` : ""}. The reference number stays the same.`
              : "Change amounts, lines, dates or the description. The request keeps its reference number and stays in the approval queue."
            : "File expenses for one or more projects. Each line is checked against its project's allocation."
        }
      >
        {editing && <Button onClick={() => go("requests", { requestId: editing.id })}>Cancel editing</Button>}
        <Button variant="primary" busy={busy} onClick={submit}>
          {editing ? "Save changes" : "Submit request"}
        </Button>
      </PageHead>
      <div className="oe-stack">
        <div className="oe-rq-head">
          <div className="oe-rq-box">
            <div className="oe-rq-row">
              <span className="oe-rq-label">Reference nbr</span>
              {editing ? (
                <span className="oe-rq-value oe-code">{editing.ref_no}</span>
              ) : (
                <span className="oe-rq-value muted" title="Generated when you submit">
                  &lt;NEW&gt;
                </span>
              )}
            </div>
            <div className="oe-rq-row">
              <span className="oe-rq-label">Status</span>
              <span className="oe-rq-value">
                <StatusChip status="on_hold" />
              </span>
            </div>
            <label className="oe-rq-row">
              <span className="oe-rq-label">
                Request date <span className="oe-req">*</span>
              </span>
              <span>
                <input name="request_date" className={`oe-input ${errors.head ? "bad" : ""}`} type="date" value={head.request_date} onChange={(e) => setHead((h) => ({ ...h, request_date: e.target.value }))} style={{ maxWidth: 190 }} />
                {errors.head && <span className="oe-lerr small" style={{ display: "block", marginTop: 4 }}>{errors.head}</span>}
              </span>
            </label>
          </div>

          <div className="oe-rq-box">
            <div className="oe-rq-row">
              <span className="oe-rq-label">Requested by</span>
              <span className="oe-rq-value" title="From your sign-in">
                {editing ? editing.liaison_name : me.full_name || me.email}
              </span>
            </div>
            <label className="oe-rq-row">
              <span className="oe-rq-label">
                Date needed <span className="oe-req">*</span>
              </span>
              <span>
                <input name="date_needed"
                  className={`oe-input ${errors.head_needed ? "bad" : ""}`}
                  type="date"
                  aria-required="true"
                  min={head.request_date || undefined}
                  value={head.date_needed}
                  onChange={(e) => {
                    setHead((h) => ({ ...h, date_needed: e.target.value }));
                    setErrors((x) => ({ ...x, head_needed: undefined }));
                  }}
                  style={{ maxWidth: 190 }}
                />
                {errors.head_needed && <span className="oe-lerr small" style={{ display: "block", marginTop: 4 }}>{errors.head_needed}</span>}
              </span>
            </label>
            <label className="oe-rq-row top">
              <span className="oe-rq-label">
                Description <span className="oe-req">*</span>
              </span>
              <span>
                <textarea name="remarks"
                  className={`oe-textarea ${errors.head_desc ? "bad" : ""}`}
                  rows={3}
                  aria-required="true"
                  value={head.remarks}
                  onChange={(e) => {
                    setHead((h) => ({ ...h, remarks: e.target.value }));
                    setErrors((x) => ({ ...x, head_desc: undefined }));
                  }}
                  placeholder="Purpose, client instruction, billing reference"
                />
                {errors.head_desc && <span className="oe-lerr small" style={{ display: "block", marginTop: 2 }}>{errors.head_desc}</span>}
              </span>
            </label>
          </div>

          <div className="oe-rq-box oe-rq-sum" aria-label="Request totals">
            {catTotals.map(({ c, amount }) => (
              <div className="oe-rq-row" key={c.id}>
                <span className="oe-rq-label">{c.name}</span>
                <span className="oe-rq-amt num">{amt(amount) === "—" ? "0.00" : amt(amount)}</span>
              </div>
            ))}
            <div className="oe-rq-row total">
              <span className="oe-rq-label">Request total</span>
              <span className="oe-rq-amt num">{money(total)}</span>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              {lines.length} {lines.length === 1 ? "line" : "lines"}, {projectCount} {projectCount === 1 ? "project" : "projects"}
              {overCount > 0 && <span style={{ color: "var(--red)", fontWeight: 500 }}>, {overCount} over allocation</span>}
            </p>
          </div>
        </div>

        <div className="oe-panel oe-lines">
          <div className="oe-lgrid oe-lines-h" aria-hidden="true">
            <span>#</span>
            <span>
              Project ID <span className="oe-req">*</span>
            </span>
            <span>
              Category <span className="oe-req">*</span>
            </span>
            <span>
              Expense type <span className="oe-req">*</span>
            </span>
            <span className="r">
              Amount (₱) <span className="oe-req">*</span>
            </span>
            <span>
              Payee / recipient <span className="oe-req">*</span>
            </span>
            <span>Remarks</span>
            <span />
          </div>
          {lines.map((l, i) => (
            <RequestLineRow
              key={l.key}
              line={l}
              index={i}
              check={checks[i]}
              showLimits={showLimits}
              errors={errors[l.key] || {}}
              cats={activeCats}
              onChange={(patch) => updateLine(l.key, patch)}
              onRemove={lines.length > 1 ? () => setLines((ls) => ls.filter((x) => x.key !== l.key)) : null}
              onDuplicate={() => setLines((ls) => [...ls.slice(0, i + 1), { ...l, key: uid(), files: [] }, ...ls.slice(i + 1)])}
            />
          ))}
          <div className="oe-lines-f">
            <Button size="sm" icon="plus" onClick={addLine}>
              Add line
            </Button>
          </div>
        </div>
        {/* phones: the total and the submit button stay in reach at the bottom of a long form */}
        <div className="oe-total oe-phone-only">
          <span>
            <span className="muted small" style={{ display: "block" }}>Request total</span>
            <b className="num">{money(total)}</b>
          </span>
          <Button variant="primary" busy={busy} onClick={submit}>
            {editing ? "Save changes" : "Submit request"}
          </Button>
        </div>

      </div>
    </div>
  );
}

/** Project ID picker: type to filter, arrow keys to move, Enter to pick. Lists project IDs only. */
function ProjectPicker({ projects, value, onChange, invalid, label = "Project ID", allLabel = null }) {
  const current = projects.find((p) => p.id === value) || null;
  const [text, setText] = useState(current ? current.code : "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [listId] = useState(() => "pp-" + uid());
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const [pos, setPos] = useState(null);
  // The list floats above the page (fixed position) so a scrolling window or drawer can't clip it;
  // it opens upward when there isn't room below.
  const place = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 200 && r.top > below;
    setPos({
      left: r.left,
      width: Math.max(r.width, 170),
      // set both edges explicitly: the stylesheet's default "top" would otherwise push an upward list off-screen
      top: up ? "auto" : r.bottom + 4,
      bottom: up ? window.innerHeight - r.top + 4 : "auto",
      maxHeight: Math.max(120, Math.min(260, (up ? r.top : below) - 12)),
    });
  }, []);
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);
  useEffect(() => {
    if (!open) return undefined;
    const onMove = (e) => {
      if (listRef.current && listRef.current.contains(e.target)) return; // the list's own scrolling
      place();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);
  const sorted = useMemo(
    () => [...projects].sort((a, b) => Number(a.is_internal) - Number(b.is_internal) || String(a.code).localeCompare(String(b.code))),
    [projects]
  );
  const filtering = open && !(current && text === current.code);
  const q = norm(text);
  const matches = filtering && q ? sorted.filter((p) => norm(p.code).includes(q)) : sorted;
  // optional first entry that clears the choice, e.g. "All projects" in a filter
  const list = allLabel && !(filtering && q) ? [{ id: "", code: allLabel, all: true }, ...matches] : matches;

  useEffect(() => {
    if (!open) setText(current ? current.code : "");
  }, [value, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // the mouse wheel over the list scrolls the list only, never the window or page behind it
    const list = listRef.current;
    if (!open || !list) return undefined;
    const onWheel = (e) => {
      const atTop = list.scrollTop <= 0;
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, [open, pos]);
  useEffect(() => {
    // keep the highlighted project visible by scrolling the list only (never the page or window)
    const list = listRef.current;
    if (!open || !list) return;
    const el = list.children[active];
    if (!el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }, [active, open, pos]);

  const choose = (p) => {
    const real = p && !p.all ? p : null;
    onChange(real ? real.id : "");
    setText(real ? real.code : "");
    setOpen(false);
  };
  const commit = () => {
    if (!open) return;
    const exact = sorted.find((p) => norm(p.code) === q);
    if (!q) choose(null);
    else if (exact) choose(exact);
    else {
      setText(current ? current.code : "");
      setOpen(false);
    }
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(Math.max(0, current ? sorted.indexOf(current) + (allLabel ? 1 : 0) : 0));
        return;
      }
      setActive((i) => Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      if (open && list[active]) {
        e.preventDefault();
        e.stopPropagation();
        choose(list[active]);
      }
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setText(current ? current.code : "");
      setOpen(false);
    }
  };

  return (
    <div className="oe-combo">
      <input name={label}
        ref={inputRef}
        className={`oe-input ${invalid ? "bad" : ""}`}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && list[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={allLabel || "Type ID"}
        value={text}
        onFocus={(e) => {
          // focus alone (e.g. a window opening) doesn't open the list; a click, typing or the arrow keys do
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onClick={() => {
          if (!open) {
            setOpen(true);
            setActive(Math.max(0, current ? sorted.indexOf(current) + (allLabel ? 1 : 0) : 0));
          }
        }}
        onBlur={commit}
        onKeyDown={onKey}
      />
      <span className="oe-combo-caret">
        <Icon name="down" size={14} />
      </span>
      {open && (
        <ul
          className="oe-combo-list"
          role="listbox"
          id={listId}
          ref={listRef}
          aria-label={label}
          style={pos ? { position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, minWidth: 0, maxHeight: pos.maxHeight } : { visibility: "hidden" }}
        >
          {list.length ? (
            list.map((p, i) => (
              <li
                key={p.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`${i === active ? "on" : ""} ${p.id === (value || "") && (p.all || value) ? "picked" : ""} ${p.all ? "all" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {p.code}
              </li>
            ))
          ) : (
            <li className="none">No project ID matches “{text}”</li>
          )}
        </ul>
      )}
    </div>
  );
}

function RequestLineRow({ line: l, index, check, showLimits, errors, cats, onChange, onRemove, onDuplicate }) {
  const { data, idx, settings, ui } = useApp();
  const fileRef = useRef(null);
  const lineCat = idx.cats.get(l.category_id);
  const needDoc = !!(lineCat && lineCat.require_document);
  const pickFiles = (e) => {
    const chosen = [...(e.target.files || [])];
    e.target.value = "";
    const ok = [];
    for (const file of chosen) {
      const bad = checkDocFile(file);
      if (bad) ui.err(bad);
      else ok.push({ key: uid(), file, name: file.name, size: file.size, type: file.type });
    }
    if (ok.length) onChange({ files: [...l.files, ...ok] });
  };
  const type = idx.typesById.get(l.type_id);
  const project = idx.projects.get(l.project_id);
  const types = (idx.typesByCat.get(l.category_id) || []).filter((t) => t.is_active);
  const method = type ? type.calc_method : "manual";
  const calc = type && method !== "manual" && l.basis_amount && l.rate ? round2((l.basis_amount * l.rate) / 100) : null;
  const bad = check && (check.state === "over" || check.state === "none");
  const errs = Object.values(errors);
  // contract-based types (e.g. Bidding) are calculated automatically; only show a note when the amount differs
  const amountNow = Number(l.amount) || 0;
  const contractNote = method === "contract_pct" && !!type && (calc == null || Math.abs(calc - amountNow) > 0.004);
  const kept = l.existingDocs || [];
  const hasSub = l.approvedBefore != null || needDoc || l.files.length > 0 || kept.length > 0 || method === "collection_pct" || contractNote || (type && type.detail_label) || (showLimits && check) || errs.length > 0;
  const n = index + 1;

  return (
    <div className={`oe-lrow ${bad ? "bad" : ""}`} role="group" aria-label={`Line ${n}`}>
      <div className="oe-lgrid">
        <span className="oe-line-no">{n}</span>
        {/* .oe-lf wrappers show a label on phones and disappear from the layout on wider screens */}
        <span className="oe-lf">
          <span className="oe-lf-t" aria-hidden="true">
            Project ID <span className="oe-req">*</span>
          </span>
          <ProjectPicker projects={data.projects} value={l.project_id} onChange={(id) => onChange({ project_id: id })} invalid={!!errors.project_id} label={`Line ${n} project ID`} />
        </span>
        <span className="oe-lf">
        <span className="oe-lf-t" aria-hidden="true">
          Category <span className="oe-req">*</span>
        </span>
        <select name="category_id"
          className={`oe-select ${errors.category_id ? "bad" : ""} ${l.category_id ? "" : "empty"}`}
          aria-label={`Line ${n} category`}
          value={l.category_id}
          onChange={(e) => onChange({ category_id: e.target.value, type_id: "" })}
        >
          <option value="" disabled hidden>
            Select
          </option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        </span>
        <span className="oe-lf">
        <span className="oe-lf-t" aria-hidden="true">
          Expense type <span className="oe-req">*</span>
        </span>
        <select name="type_id"
          className={`oe-select ${errors.type_id ? "bad" : ""} ${l.type_id ? "" : "empty"}`}
          aria-label={`Line ${n} expense type`}
          value={l.type_id}
          disabled={!l.category_id}
          onChange={(e) => onChange({ type_id: e.target.value })}
        >
          <option value="" disabled hidden>
            {l.category_id ? "Select" : "Category first"}
          </option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        </span>
        <span className="oe-lf">
        <span className="oe-lf-t" aria-hidden="true">
          Amount (₱) <span className="oe-req">*</span>
        </span>
        <MoneyInput
          className={errors.amount || (method === "contract_pct" && calc != null && amountNow > calc + 0.004) ? "bad" : ""}
          value={l.amount}
          onChange={(v) => onChange({ amount: v })}
          placeholder="0.00"
          aria-label={`Line ${n} amount`}
          title={method === "contract_pct" && calc != null ? `Calculated automatically; you can lower it, up to ${money(calc)}` : undefined}
        />
        </span>
        <span className="oe-lf">
          <span className="oe-lf-t" aria-hidden="true">
            Payee / recipient <span className="oe-req">*</span>
          </span>
          <input name="payee" className={`oe-input ${errors.payee ? "bad" : ""}`} value={l.payee} onChange={(e) => onChange({ payee: e.target.value })} placeholder="Payee" aria-label={`Line ${n} payee`} aria-required="true" />
        </span>
        <span className="oe-lf">
          <span className="oe-lf-t" aria-hidden="true">
            Remarks
          </span>
          <input name="description" className="oe-input" value={l.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="Optional" aria-label={`Line ${n} remarks`} />
        </span>
        <span className="oe-lrow-act">
          <input name="files" ref={fileRef} type="file" accept={DOC_ACCEPT} multiple hidden onChange={pickFiles} />
          <Button
            size="sm"
            variant="ghost"
            icon="clip"
            aria-label={`Attach files to line ${n}`}
            title={needDoc ? "Attach supporting documents (required)" : "Attach supporting documents (optional)"}
            onClick={() => fileRef.current && fileRef.current.click()}
          />
          <Button size="sm" variant="ghost" icon="dup" aria-label={`Duplicate line ${n}`} title="Duplicate line" onClick={onDuplicate} />
          {onRemove && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove line ${n}`} title="Remove line" onClick={onRemove} />}
        </span>
      </div>

      {hasSub && (
        <div className="oe-lsub">
          {contractNote && (
            <span className="oe-lsub-item">
              {calc == null ? (
                <span className="muted">No contract value on this project; enter the amount.</span>
              ) : amountNow > calc + 0.004 ? (
                <span className="oe-lerr">Can't exceed the calculated {money(calc)}</span>
              ) : (
                <span className="muted">Below the calculated {money(calc)}</span>
              )}
              {calc != null && (
                <Button size="sm" variant="ghost" onClick={() => onChange({ reset: true })}>
                  Use calculated
                </Button>
              )}
            </span>
          )}
          {method === "collection_pct" && type && (
            <span className="oe-lsub-item oe-calc">
              {method === "collection_pct" && (
                <>
                  <span className="muted">Billing</span>
                  <input name="basis_pct"
                    className="oe-input num"
                    style={{ width: 64 }}
                    inputMode="decimal"
                    placeholder="e.g. 30"
                    title="Billing percentage this collection is for (reference only)"
                    value={l.basis_pct ?? ""}
                    onChange={(e) => onChange({ basis_pct: num(e.target.value) })}
                    aria-label={`Line ${n} billing percent`}
                  />
                  <span className="muted">%</span>
                  <span className="muted oe-calc-gap">Net collection ₱</span>
                </>
              )}
              {method === "contract_pct" && <span className="muted">Contract value ₱</span>}
              <MoneyInput
                value={l.basis_amount}
                onChange={(v) => onChange({ basis_amount: v })}
                style={{ width: 150 }}
                placeholder="0.00"
                aria-label={`Line ${n} ${method === "collection_pct" ? "net collection" : "contract value"}`}
              />
              <span className="muted oe-calc-gap">× {type.name}</span>
              <input name="rate"
                className="oe-input num"
                style={{ width: 64 }}
                inputMode="decimal"
                title={`${type.name} rate from Settings; change only if this line uses a different rate`}
                value={l.rate ?? ""}
                onChange={(e) => onChange({ rate: num(e.target.value) })}
                aria-label={`Line ${n} ${type.name} percent`}
              />
              <span className="muted">%</span>
              <span className="oe-calc-eq">= {calc != null ? money(calc) : "—"}</span>
              {calc != null && l.touched && Math.abs(calc - (Number(l.amount) || 0)) > 0.004 && (
                <Button size="sm" variant="ghost" onClick={() => onChange({ reset: true })}>
                  Use calculated
                </Button>
              )}
            </span>
          )}
          {type && type.detail_label && (
            <span className="oe-lsub-item">
              <span className="muted">
                {type.detail_label} <span className="oe-req">*</span>
              </span>
              <input name="detail" className={`oe-input ${errors.detail ? "bad" : ""}`} style={{ width: 200 }} value={l.detail} onChange={(e) => onChange({ detail: e.target.value })} aria-label={`Line ${n} ${type.detail_label}`} aria-required="true" />
            </span>
          )}
          {l.approvedBefore != null && (
            <span className="oe-lsub-item">
              <Chip tone="amber" plain>
                Previously approved {money(l.approvedBefore)}
              </Chip>
            </span>
          )}
          {(needDoc || l.files.length > 0 || kept.length > 0) && (
            <span className="oe-lsub-item">
              <span className="muted">
                Supporting document{needDoc && <span className="oe-req"> *</span>}
              </span>
              {kept.map((d) => (
                <span className="oe-file" key={d.id} title={`${d.file_name} (already attached)`}>
                  <Icon name="clip" size={13} />
                  <span className="nm">{d.file_name}</span>
                  <span className="muted">{fmtSize(d.size_bytes)}</span>
                  <button type="button" aria-label={`Remove ${d.file_name}`} onClick={() => onChange({ existingDocs: kept.filter((x) => x.id !== d.id) })}>
                    ×
                  </button>
                </span>
              ))}
              {l.files.map((f) => (
                <span className="oe-file" key={f.key} title={`${f.name} (${fmtSize(f.size)})`}>
                  <Icon name="clip" size={13} />
                  <span className="nm">{f.name}</span>
                  <span className="muted">{fmtSize(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onChange({ files: l.files.filter((x) => x.key !== f.key) })}>
                    ×
                  </button>
                </span>
              ))}
              <Button size="sm" variant={l.files.length ? "ghost" : "secondary"} icon="clip" onClick={() => fileRef.current && fileRef.current.click()} className={errors.document ? "bad-btn" : ""}>
                {l.files.length || kept.length ? "Add file" : "Attach file"}
              </Button>
            </span>
          )}
          {showLimits && check && (
            <span className="oe-lsub-item oe-lcheck" aria-live="polite">
              <LimitChip state={check.state} over={-check.balanceAfter} />
              <span className="muted">
                {check.alloc.amount > 0 ? `Limit ${compact(check.alloc.amount)}` : "No limit set"} · approved {compact(check.used)}
                {check.otherPending > 0 && ` · pending approval ${compact(check.otherPending)}`} · this request {compact(check.prior + (Number(l.amount) || 0))} ·{" "}
                <b style={{ color: check.balanceAfter < -0.004 ? "var(--red)" : "var(--ink)", fontWeight: 600 }}>
                  {check.balanceAfter < -0.004 ? `over by ${compact(-check.balanceAfter)}` : `balance ${compact(check.balanceAfter)}`}
                </b>
              </span>
              <span style={{ width: 120 }}>
                <Meter alloc={check.alloc.amount} used={check.used} pending={check.otherPending + check.prior + (Number(l.amount) || 0)} near={Number(settings.near_limit_pct) || 90} />
              </span>
            </span>
          )}
          {errs.some((m) => !(contractNote && m.startsWith("Amount can't exceed"))) && (
            <span className="oe-lsub-item oe-lerr">{errs.filter((m) => !(contractNote && m.startsWith("Amount can't exceed"))).join(", ")}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   12. APPROVALS (top management)
   --------------------------------------------------------------------- */
function ApprovalsPage({ params }) {
  const { data, idx, me, settings } = useApp();
  const queue = useMemo(() => data.requests.filter((r) => r.status === "on_hold").sort((a, b) => (a.created_at > b.created_at ? 1 : -1)), [data.requests]);
  const [selId, setSelId] = useState((params && params.requestId) || null);
  // phones: the queue alone, and a tap opens the request in a full-screen drawer (nothing is picked by default,
  // and once a request is approved or rejected the drawer closes); desktops keep the queue beside the request
  const phone = useIsPhone();
  const sel = queue.find((r) => r.id === selId) || (phone ? null : queue[0] || null);
  const flags = useMemo(() => {
    const m = new Map();
    for (const r of queue) {
      const c = checkLines(r.lines.map((l) => ({ project_id: l.project_id, type_id: l.type_id, amount: l.amount, requested: l.amount })), idx, settings, true);
      m.set(r.id, c.filter((x) => x && (x.state === "over" || x.state === "none")).length);
    }
    return m;
  }, [queue, idx, settings]);

  return (
    <div className="oe-page">
      <PageHead title="Approvals" desc="Requests for approval, oldest first. Check each line against its project allocation, adjust amounts if needed, then approve or reject." />
      {queue.length === 0 ? (
        <div className="oe-panel">
          <Empty title="Nothing waiting for approval" body="New requests from liaisons will appear here." />
        </div>
      ) : (
        <div className="oe-split">
          <nav className="oe-queue" aria-label="Requests waiting for approval">
            {queue.map((r) => (
              <button key={r.id} className="oe-qitem" aria-current={sel && sel.id === r.id} aria-haspopup={phone ? "dialog" : undefined} onClick={() => setSelId(r.id)}>
                <div className="row">
                  <span className="oe-code">{r.ref_no}</span>
                  <b className="num" style={{ color: "var(--ink)" }}>
                    {compact(reqRequested(r))}
                  </b>
                </div>
                {phone && <span className="oe-qopen">Tap to review</span>}
                <div className="row muted small">
                  <span>
                    {r.liaison_name}, {fmtDate(r.request_date)}
                  </span>
                  <span>
                    {r.lines.length} {r.lines.length === 1 ? "line" : "lines"}
                  </span>
                </div>
                {(flags.get(r.id) > 0 || r.liaison_id === me.id) && (
                  <div className="oe-actions">
                    {flags.get(r.id) > 0 && <Chip tone="red">{flags.get(r.id)} over limit</Chip>}
                    {r.liaison_id === me.id && <Chip tone="muted">{me.role === "admin" ? "Filed by you" : "Filed by you, needs another approver"}</Chip>}
                  </div>
                )}
              </button>
            ))}
          </nav>
          {sel && !phone && <ApprovalDetail key={sel.id} request={sel} />}
        </div>
      )}
      {sel && phone && (
        <Drawer title={`Review ${sel.ref_no}`} subtitle="Check each line, then approve or reject at the bottom." onClose={() => setSelId(null)}>
          <ApprovalDetail key={sel.id} request={sel} />
        </Drawer>
      )}
    </div>
  );
}

/** The edit that sent an approved request back for approval, if no approval has come since. */
function reapprovalEdit(events) {
  const sorted = [...(events || [])].sort((a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : a.id - b.id));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    if (e.action === "approved" || e.action === "rejected") return null;
    // history written before edits kept a snapshot only says "back to approval" in its note
    if (e.action === "edited" && (e.changes ? e.changes.reapproval : / back to approval/.test(e.note || ""))) return e;
  }
  return null;
}

/** What changed on a request since the version that was approved: one row per changed detail, unchanged ones left out. */
function reapprovalChanges(before, r, idx) {
  const same = (a, b) => (typeof a === "number" || typeof b === "number" ? Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005 : String(a ?? "").trim() === String(b ?? "").trim());
  const show = (v) => (v == null || String(v).trim() === "" ? "—" : String(v));
  const proj = (id) => (idx.projects.get(id) || {}).code || "?";
  const type = (id) => (idx.typesById.get(id) || {}).name || "?";
  const basis = (l) => (l.basis_amount != null && l.rate != null ? `${l.rate}% of ${money(l.basis_amount)}${l.basis_pct != null ? ` (${l.basis_pct}% collection)` : ""}` : null);
  const summary = (l) => [`${proj(l.project_id)} ${type(l.type_id)}`, l.payee && `Payee: ${l.payee}`, money(l.amount)].filter(Boolean).join(", ");
  const rows = [];
  for (const [what, k, fmt] of [["Request date", "request_date", fmtDate], ["Date needed", "date_needed", fmtDate], ["Description", "remarks", show]]) {
    if (!same(before[k], r[k])) rows.push({ line: "Request", what, before: fmt(before[k]), after: fmt(r[k]) });
  }
  const old = new Map(before.lines.map((l) => [l.id, l]));
  for (const l of r.lines) {
    const o = old.get(l.id);
    if (!o) {
      rows.push({ line: `Line ${l.line_no}`, what: "Line added", before: "—", after: summary(l), tone: "add" });
      continue;
    }
    const line = o.line_no !== l.line_no ? `Line ${l.line_no} (was ${o.line_no})` : `Line ${l.line_no}`;
    const t = idx.typesById.get(l.type_id);
    const fields = [
      ["Project", proj(o.project_id), proj(l.project_id)],
      ["Expense type", type(o.type_id), type(l.type_id)],
      ["Payee", o.payee, l.payee],
      [(t && t.detail_label) || "Detail", o.detail, l.detail],
      ["Particulars", o.description, l.description],
      ["Basis", basis(o), basis(l)],
    ];
    for (const [what, a, b] of fields) if (!same(a, b)) rows.push({ line, what, before: show(a), after: show(b) });
    if (!same(Number(o.amount), Number(l.amount))) {
      rows.push({ line, what: "Requested amount", before: `${money(o.amount)}${o.approved_amount != null && !same(Number(o.approved_amount), Number(o.amount)) ? ` (approved ${money(o.approved_amount)})` : ""}`, after: money(l.amount), tone: "amount" });
    }
    const oldDocs = new Set((o.documents || []).map((d) => d.id));
    const newDocs = new Set((l.documents || []).map((d) => d.id));
    const added = (l.documents || []).filter((d) => !oldDocs.has(d.id)).map((d) => d.file_name);
    const removed = (o.documents || []).filter((d) => !newDocs.has(d.id)).map((d) => d.file_name);
    if (added.length || removed.length) rows.push({ line, what: "Documents", before: removed.length ? `Removed: ${removed.join(", ")}` : "—", after: added.length ? `Added: ${added.join(", ")}` : "—" });
  }
  const kept = new Set(r.lines.map((l) => l.id));
  for (const o of before.lines) {
    if (!kept.has(o.id)) rows.push({ line: `Line ${o.line_no} (old)`, what: "Line removed", before: `${summary(o)}${o.approved_amount != null ? `, approved ${money(o.approved_amount)}` : ""}`, after: "—", tone: "remove" });
  }
  return rows;
}

function ReapprovalChanges({ request: r }) {
  const { api, idx } = useApp();
  const [events, setEvents] = useState(null);
  useEffect(() => {
    let alive = true;
    api.loadEvents(r.id).then((ev) => alive && setEvents(ev)).catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [r.id, r.updated_at, r.lines.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = useMemo(() => reapprovalEdit(events), [events]);
  const before = edit && edit.changes && edit.changes.before;
  const rows = useMemo(() => (before ? reapprovalChanges(before, r, idx) : []), [before, r, idx]);
  if (!edit) return null;
  const wasApproved = before ? before.lines.reduce((a, l) => a + (l.approved_amount != null ? Number(l.approved_amount) : 0), 0) : null;
  const wasRequested = before ? before.lines.reduce((a, l) => a + Number(l.amount), 0) : null;
  const nowRequested = reqRequested(r);
  return (
    <div className="oe-panel-b oe-stack" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="oe-actions" style={{ alignItems: "center" }}>
        <Chip tone="amber">Reapproval</Chip>
        <span className="muted small">
          {before && before.approved_by_name
            ? `Approved by ${before.approved_by_name}${before.approved_at ? ` on ${fmtDate(before.approved_at)}` : ""} for ${money(wasApproved)}; `
            : "Approved before; "}
          edited by {edit.actor_name || "the liaison"} on {fmtDateTime(edit.created_at)}, so it needs approval again.
          {before && before.erp_ref ? ` ERP reference ${before.erp_ref} was cleared.` : ""}
        </span>
      </div>
      <details className="oe-fold" style={{ marginBottom: 0 }}>
        <summary>
          <span>
            Change log
            {before && rows.length > 0 && (
              <span className="muted small" style={{ fontWeight: 400 }}>
                {" "}
                ({rows.length} {rows.length === 1 ? "change" : "changes"})
              </span>
            )}
          </span>
        </summary>
        <div className="oe-stack" style={{ padding: "0 14px 14px" }}>
          {before && before.approval_remarks && <p className="muted small">Earlier approval remarks: {before.approval_remarks}</p>}
          {!before ? (
            <p className="muted small">{edit.note ? `Change recorded: ${edit.note}.` : "The details of this edit were not recorded."}</p>
          ) : rows.length === 0 ? (
            <p className="muted small">Saved again with no changes to the details or lines.</p>
          ) : (
            <div className="oe-scrollx">
              <table className="oe-table tight cards">
                <thead>
                  <tr>
                    <th>Where</th>
                    <th>What changed</th>
                    <th>Before (approved)</th>
                    <th>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x, i) => (
                    <tr key={i}>
                      <td className="lead">
                        <b>{x.line}</b>
                      </td>
                      <td data-th="What changed">{x.what}</td>
                      <td data-th="Before (approved)" style={{ color: x.tone === "remove" ? "var(--red)" : undefined }}>
                        {x.before}
                      </td>
                      <td data-th="Now" style={{ color: x.tone === "add" ? "var(--green)" : undefined, fontWeight: x.tone === "amount" ? 600 : undefined }}>
                        {x.after}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {Math.abs(wasRequested - nowRequested) >= 0.005 && (
                  <tfoot>
                    <tr>
                      <td className="lead">Total</td>
                      <td data-th="What changed">Requested total</td>
                      <td data-th="Before (approved)">{money(wasRequested)}</td>
                      <td data-th="Now">
                        <b>{money(nowRequested)}</b>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function ApprovalDetail({ request: r }) {
  const { idx, me, api, run, ui, settings } = useApp();
  const [amounts, setAmounts] = useState(() => Object.fromEntries(r.lines.map((l) => [l.id, Number(l.amount)])));
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [projectFocus, setProjectFocus] = useState(null);
  const [viewer, setViewer] = useState(null);
  const own = r.liaison_id === me.id && me.role !== "admin";
  const phone = useIsPhone(); // phones: Reject and Approve sit in a bar pinned to the bottom of the drawer
  const checks = useMemo(
    () => checkLines(r.lines.map((l) => ({ project_id: l.project_id, type_id: l.type_id, amount: amounts[l.id] ?? 0, requested: l.amount })), idx, settings, true),
    [r, amounts, idx, settings]
  );
  const approvedTotal = r.lines.reduce((a, l) => a + (Number(amounts[l.id]) || 0), 0);
  const over = checks.filter((c) => c && (c.state === "over" || c.state === "none")).length;

  const approve = async () => {
    const bad = r.lines.find((l) => amounts[l.id] == null || amounts[l.id] < 0 || amounts[l.id] > Number(l.amount));
    if (bad) return ui.err(`Line ${bad.line_no}: approved amount must be between 0 and ${money(bad.amount)}.`);
    if (!(approvedTotal > 0)) return ui.err("Approve at least one line, or reject the request.");
    if (over > 0) {
      const a = await ui.confirm({
        title: `Approve ${r.ref_no} over allocation?`,
        body: `${over} ${over === 1 ? "line goes" : "lines go"} past the project allocation. Approve anyway?`,
        confirmLabel: "Approve anyway",
      });
      if (a === null) return;
    }
    setBusy(true);
    await run(() => api.approveRequest(r.id, amounts, remarks, Object.fromEntries(r.lines.map((l) => [l.id, Number(l.amount)]))), `${r.ref_no} approved`);
    setBusy(false);
  };
  const reject = async () => {
    const reason = await ui.confirm({
      title: `Reject ${r.ref_no}?`,
      body: "The liaison will see your reason on the request.",
      input: { label: "Reason", required: true, placeholder: "Why this request is not approved" },
      confirmLabel: "Reject request",
      tone: "danger",
    });
    if (reason === null) return;
    setBusy(true);
    await run(() => api.rejectRequest(r.id, reason), `${r.ref_no} rejected`);
    setBusy(false);
  };

  const actions = (
    <>
      <Button variant="danger" onClick={reject} disabled={busy}>
        Reject
      </Button>
      <Button variant="primary" onClick={approve} busy={busy} disabled={own}>
        Approve {money(approvedTotal)}
      </Button>
    </>
  );
  return (
    <div className="oe-stack">
      <div className="oe-panel">
        <div className="oe-panel-h">
          <div>
            <h2>{r.ref_no}</h2>
            <p className="muted small">
              Filed by {r.liaison_name} on {fmtDate(r.request_date)}
              {r.date_needed && `, needed by ${fmtDate(r.date_needed)}`}
            </p>
          </div>
          <StatusChip status={r.status} />
        </div>
        {r.remarks && (
          <div className="oe-panel-b" style={{ paddingBottom: 0 }}>
            <Note>{r.remarks}</Note>
          </div>
        )}
        <div className="oe-scrollx" style={{ borderTop: r.remarks ? "1px solid var(--line)" : 0, marginTop: r.remarks ? 16 : 0 }}>
          <div>
            <table className="oe-table tight cards">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Project and expense</th>
                  <th>Particulars</th>
                  <th className="r">Requested</th>
                  <th>Limit check</th>
                  <th className="r">Balance after</th>
                  <th style={{ width: 140 }}>Approve amount</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l, i) => {
                  const p = idx.projects.get(l.project_id);
                  const t = idx.typesById.get(l.type_id);
                  const c = checks[i];
                  return (
                    <tr key={l.id}>
                      <td data-th="Line">{l.line_no}</td>
                      <td className="lead" style={{ minWidth: 200 }}>
                        {p ? (
                          <button
                            type="button"
                            className="oe-linkbtn oe-code"
                            title={`Open the project report for ${p.code}`}
                            onClick={() =>
                              setProjectFocus({
                                projectId: p.id,
                                typeId: l.type_id,
                                note: `Reviewing ${r.ref_no}, line ${l.line_no}: ${t ? t.name : "expense"}, requested ${money(l.amount)}${
                                  amounts[l.id] != null && Math.abs(Number(amounts[l.id]) - Number(l.amount)) > 0.004 ? ` (you are approving ${money(amounts[l.id])})` : ""
                                }. It is highlighted below; "In approval" already counts the requested amount.`,
                              })
                            }
                          >
                            {p.code}
                          </button>
                        ) : (
                          <span className="oe-code">?</span>
                        )}{" "}
                        {t ? t.name : "?"}
                        <DocLinks
                          docs={l.documents}
                          required={!!(idx.cats.get(l.category_id) || {}).require_document}
                          onOpen={(k) => setViewer({ docs: l.documents, index: k, title: `${r.ref_no}, line ${l.line_no}: supporting documents` })}
                        />
                        {(l.payee || l.detail) && <span className="sub">{[l.payee && `Payee: ${l.payee}`, l.detail && `${(t && t.detail_label) || "Detail"}: ${l.detail}`].filter(Boolean).join("; ")}</span>}
                        {l.basis_amount != null && l.rate != null && (
                          <span className="sub">
                            {l.rate}% of {money(l.basis_amount)}
                            {l.basis_pct != null && ` (${l.basis_pct}% collection)`}
                          </span>
                        )}
                      </td>
                      <td className="oe-particulars" data-th="Particulars">{l.description || ""}</td>
                      <td className="r" data-th="Requested">{money(l.amount)}</td>
                      <td style={{ minWidth: 170 }} data-th="Limit check">
                        {c ? (
                          <div className="oe-usage">
                            <div className="oe-usage-t">
                              <span>Approved {compact(c.used)}</span>
                              <span>limit {c.alloc.amount > 0 ? compact(c.alloc.amount) : "none"}</span>
                            </div>
                            <Meter alloc={c.alloc.amount} used={c.used} pending={c.otherPending + c.prior + (Number(amounts[l.id]) || 0)} near={Number(settings.near_limit_pct) || 90} />
                            <span className="note">
                              {allocationHint(c.alloc)}
                              {c.otherPending > 0 && `; ${compact(c.otherPending)} pending in other requests (counted)`}
                            </span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="r" data-th="Balance after">
                        <b style={{ color: c && c.balanceAfter < -0.004 ? "var(--red)" : "var(--ink)" }}>{c ? money(c.balanceAfter) : "—"}</b>
                        <div style={{ marginTop: 4 }}>
                          <LimitChip state={c && c.state} over={c ? -c.balanceAfter : 0} />
                        </div>
                      </td>
                      <td data-th="Approve amount">
                        <MoneyInput value={amounts[l.id]} onChange={(v) => setAmounts((a) => ({ ...a, [l.id]: v }))} aria-label={`Approve amount for line ${l.line_no}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="lead">
                    Total
                  </td>
                  <td className="r" data-th="Requested">{money(reqRequested(r))}</td>
                  <td colSpan={2} className="none" />
                  <td className="r" data-th="Approved">{money(approvedTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <div className="oe-panel-b" style={{ paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          <p className="muted small">Set a line to 0 to leave it out. Balance after = limit − approved − other requests still pending − this request. Lines of the same project and expense type are counted together.</p>
        </div>
        <ReapprovalChanges request={r} />
      </div>

      <div className="oe-panel">
        <div className="oe-panel-b oe-stack">
          <p className="muted small">Click a project ID above to see that project's report without leaving approvals.</p>
          {own && <Note tone="warn" icon="lock">You filed this request, so another approver has to approve it.</Note>}
          <Field label="Approval remarks" hint="Optional; saved with the request">
            <textarea name="remarks" className="oe-textarea" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
          {!phone && (
            <div className="oe-actions oe-approve-bar" style={{ justifyContent: "flex-end" }}>
              {actions}
            </div>
          )}
        </div>
      </div>
      {phone && <div className="oe-approve-bar oe-approve-float">{actions}</div>}
      {projectFocus && <ProjectDrawer projectId={projectFocus.projectId} initialTab="breakdown" focus={projectFocus} onClose={() => setProjectFocus(null)} />}
      {viewer && <DocumentViewer docs={viewer.docs} index={viewer.index} title={viewer.title} onClose={() => setViewer(null)} />}
    </div>
  );
}

/* ---------------------------------------------------------------------
   13. REQUEST LIST
   --------------------------------------------------------------------- */
const KPI_CARDS = [
  { id: "action", label: "Needs my action", color: "var(--teal)" },
  { id: "all", label: "All requests", color: "var(--ink)" },
  { id: "on_hold", label: "For approval", color: "var(--amber)" },
  { id: "open", label: "Open", color: "var(--teal)" },
  { id: "disbursed", label: "Disbursed", color: "var(--blue)" },
  { id: "partially_paid", label: "Partially paid", color: "var(--leaf)" },
  { id: "paid", label: "Paid", color: "var(--green)" },
  { id: "closed", label: "Closed", color: "var(--slate)" },
  { id: "reclassified", label: "Reclassified", color: "var(--violet)" },
  { id: "returned", label: "Returned", color: "var(--muted)" },
  { id: "ended", label: "Rejected / withdrawn", color: "var(--red)" },
];
const statusGroup = (st) => (st === "rejected" || st === "cancelled" ? "ended" : st);

function RequestsPage({ params }) {
  const { data, idx, me, can } = useApp();
  const seeAll = can("requests.view_all");
  const initialStatus = params && params.tab ? (params.tab === "mine" ? "action" : params.tab) : "all";
  const [status, setStatus] = useState(initialStatus);
  // Liaisons only ever see their own requests; roles that may see everything open on all requesters.
  const [f, setF] = useState({ q: "", project: "", requester: seeAll ? "" : me.id, from: "", to: "" });
  const set = setter(setF);
  const [openId, setOpenId] = useState((params && params.requestId) || null);
  const [page, setPage] = useState(1);
  const PER = 30;
  // phones: three status cards (needs my action, all, the one picked) until "All statuses" is tapped
  const phone = useIsPhone();
  const [allCards, setAllCards] = useState(false);
  const cards = phone && !allCards ? KPI_CARDS.filter((c) => c.id === "action" || c.id === "all" || c.id === status) : KPI_CARDS;

  const enriched = useMemo(() => data.requests.map((r) => ({ r, step: nextStep(r, me, can, idx), shown: displayStatus(r, idx) })), [data.requests, me, can, idx]);
  const matchesFilters = useCallback(
    ({ r }, ignoreRequester = false) => {
      const q = norm(f.q);
      if (!ignoreRequester && f.requester && r.liaison_id !== f.requester) return false;
      if (f.project && r.project_id !== f.project && !r.lines.some((l) => l.project_id === f.project || (l.reclass || []).some((x) => x.project_id === f.project))) return false;
      if (f.from && r.request_date < f.from) return false;
      if (f.to && r.request_date > f.to) return false;
      if (q) {
        const hay = [r.ref_no, r.erp_ref, r.liaison_name, r.remarks, ...r.lines.flatMap((l) => [l.description, l.payee, (idx.projects.get(l.project_id) || {}).code])];
        if (!hay.some((v) => norm(v).includes(q))) return false;
      }
      return true;
    },
    [f, idx]
  );
  const isAction = ({ step }) => step.mine;

  // KPI cards: status counts for the current filters; "Needs my action" covers every request you can see.
  const kpis = useMemo(() => {
    const k = Object.fromEntries(KPI_CARDS.map((c) => [c.id, { count: 0, amount: 0 }]));
    for (const e of enriched) {
      const amount = reqTotal(e.r);
      if (isAction(e) && matchesFilters(e, true)) {
        k.action.count++;
        k.action.amount += amount;
      }
      if (!matchesFilters(e)) continue;
      k.all.count++;
      k.all.amount += amount;
      const g = k[statusGroup(e.shown)];
      if (g) {
        g.count++;
        g.amount += amount;
      }
    }
    return k;
  }, [enriched, matchesFilters]);

  const rows = useMemo(
    () =>
      enriched.filter((e) => {
        if (status === "action") return isAction(e) && matchesFilters(e, true);
        if (!matchesFilters(e)) return false;
        return status === "all" || statusGroup(e.shown) === status;
      }),
    [enriched, status, matchesFilters]
  );
  useEffect(() => setPage(1), [status, f]);
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const shown = rows.slice((page - 1) * PER, page * PER);
  const requesters = useMemo(
    () =>
      [...new Map(data.requests.filter((r) => r.liaison_id !== me.id).map((r) => [r.liaison_id, r.liaison_name])).entries()].sort((a, b) =>
        String(a[1]).localeCompare(String(b[1]))
      ),
    [data.requests, me.id]
  );
  const pickCard = (id) => {
    setStatus(id);
    if (id === "action" && seeAll) setF((x) => ({ ...x, requester: "" }));
  };

  const exportCSV = () => {
    const out = [["Reference", "Request date", "Liaison", "Request status", "Days in status", "ERP reference", "Disbursed date", "Line", "Project ID", "Category", "Expense type", "Description", "Payee", "Detail", "Requested", "Approved", "Line status", "Paid date", "Accounting verified", "TM verified", "Reclassified to"]];
    for (const { r } of rows)
      for (const l of r.lines) {
        const t = idx.typesById.get(l.type_id);
        const c = idx.cats.get(l.category_id);
        out.push([r.ref_no, r.request_date, r.liaison_name, STATUS[displayStatus(r, idx)].label, daysSince(statusSince(r, displayStatus(r, idx))) ?? "", r.erp_ref, r.disbursed_date, l.line_no, (idx.projects.get(l.project_id) || {}).code, c && c.name, t && t.name, l.description, l.payee, l.detail, l.amount, l.approved_amount, (STATUS[l.status] || {}).label, l.paid_date, l.acct_verified_at ? String(l.acct_verified_at).slice(0, 10) : "", l.tm_verified_at ? String(l.tm_verified_at).slice(0, 10) : "", (l.reclass || []).map((x) => `${(idx.projects.get(x.project_id) || {}).code} ${x.amount}`).join("; ")]);
      }
    downloadCSV(`requests-${todayISO()}.csv`, out);
  };

  return (
    <div className="oe-page">
      <PageHead
        title="Request list"
        desc={seeAll ? "Every request, current and previous, with its status and next step." : "Your requests, current and previous, with their status and next step."}
      >
        <Button icon="download" onClick={exportCSV}>
          Export CSV
        </Button>
      </PageHead>
      <div className="oe-kpis" role="group" aria-label="Filter by status">
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`oe-kpi ${c.id === "action" ? "action" : ""}`}
            style={{ "--kpi": c.color }}
            aria-pressed={status === c.id}
            onClick={() => pickCard(c.id)}
          >
            <span className="k-label">{c.label}</span>
            <span className="k-nums">
              <span className="k-count num">{kpis[c.id].count}</span>
              <span className="k-amt num">{kpis[c.id].count ? compact(kpis[c.id].amount) : "—"}</span>
            </span>
          </button>
        ))}
        {phone && (
          <button type="button" className="oe-kpi oe-kpi-more" onClick={() => setAllCards((v) => !v)} aria-expanded={allCards}>
            <span className="k-label">{allCards ? "Fewer statuses" : `All ${KPI_CARDS.length} statuses`}</span>
          </button>
        )}
      </div>
      <Filters>
        <SearchBox value={f.q} onChange={set("q")} placeholder="Search reference, ERP ref, project, payee" />
        {seeAll && (
          <select name="requester" className="oe-select" value={f.requester} onChange={set("requester")} aria-label="Requested by">
            <option value={me.id}>Requested by me</option>
            <option value="">All requesters</option>
            {requesters.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <div style={{ width: 190 }}>
          <ProjectPicker projects={data.projects} value={f.project} onChange={(id) => setF((x) => ({ ...x, project: id }))} label="Filter by project ID" allLabel="All projects" />
        </div>
        <label className="oe-check small">
          From <input name="from" className="oe-input" type="date" value={f.from} onChange={set("from")} style={{ width: 150 }} />
        </label>
        <label className="oe-check small">
          To <input name="to" className="oe-input" type="date" value={f.to} onChange={set("to")} style={{ width: 150 }} />
        </label>
      </Filters>
      {rows.length === 0 ? (
        <div className="oe-panel">
          <Empty
            title={status === "action" ? "Nothing needs your action" : f.requester === me.id && seeAll ? "No requests filed by you here" : "No requests match"}
            body={status === "action" ? "Requests waiting on you will show up here." : "Try another status card or clear the filters."}
            action={
              seeAll && f.requester === me.id && status !== "action" ? (
                <Button onClick={() => setF((x) => ({ ...x, requester: "" }))}>Show all requesters</Button>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <div className="oe-tablewrap">
            <table className="oe-table cards">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Request date</th>
                  <th>Liaison</th>
                  <th>Projects</th>
                  <th className="r">Amount</th>
                  <th>ERP reference</th>
                  <th>Disbursed</th>
                  <th>Status</th>
                  <th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ r, step }) => {
                  const codes = [...new Set(r.lines.map((l) => (idx.projects.get(l.project_id) || {}).code).filter(Boolean))];
                  return (
                    <tr key={r.id} className="click" tabIndex={0} onClick={() => setOpenId(r.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(r.id)}>
                      <td className="lead">
                        <span className="oe-code">{r.ref_no}</span>
                        <span className="sub">
                          {r.lines.length} {r.lines.length === 1 ? "line" : "lines"}
                        </span>
                      </td>
                      <td data-th="Request date">{fmtDate(r.request_date)}</td>
                      <td data-th="Liaison">{r.liaison_name}</td>
                      <td data-th="Projects">
                        {codes[0] || "—"}
                        {codes.length > 1 && <span className="sub">and {codes.length - 1} more</span>}
                      </td>
                      <td className="r" data-th="Amount">{money(reqTotal(r))}</td>
                      <td data-th="ERP reference">{r.erp_ref || <span className="muted">—</span>}</td>
                      <td data-th="Disbursed">{r.disbursed_date ? fmtDate(r.disbursed_date) : <span className="muted">—</span>}</td>
                      <td data-th="Status">
                        <StatusChip status={displayStatus(r, idx)} />
                        {(() => {
                          const since = statusSince(r, displayStatus(r, idx));
                          const n = daysSince(since);
                          return n == null ? null : (
                            <TapHint hint={`In this status since ${fmtDate(since)}`} className="sub oe-since">
                              {n === 0 ? "since today" : `${daysLabel(n)}`}
                            </TapHint>
                          );
                        })()}
                      </td>
                      <td data-th="Next step" style={{ color: step.mine ? "var(--teal-d)" : "var(--muted)", fontWeight: step.mine ? 600 : 400 }}>{step.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} onPage={setPage} total={rows.length} />
        </>
      )}
      {openId && <RequestDrawer requestId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

const EVENT_TEXT = {
  created: "Filed",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  erp_ref: "ERP reference entered",
  disbursed: "Fund disbursed",
  paid: "Marked paid to client",
  verified_acct: "Verified by accounting",
  verified_tm: "Verified by top management",
  reclassified: "Reclassified",
  edited: "Edited",
  returned: "Fund returned",
  documents_added: "Documents added",
  document_removed: "Document removed",
};

/** Money on a line so far: disbursed, paid to the client, returned, and what is still with the liaison. */
function LineMoney({ l, compact: small }) {
  const rows = [
    ["Disbursed", lineApproved(l)],
    linePaid(l) > 0 && ["Paid to client", linePaid(l)],
    lineReturned(l) > 0 && ["Returned so far", lineReturned(l)],
    ["With liaison", lineWithLiaison(l), true],
  ].filter(Boolean);
  return (
    <div className={`oe-money ${small ? "small" : ""}`}>
      {rows.map(([k, v, strong]) => (
        <div key={k} className={strong ? "strong" : ""}>
          <span>{k}</span>
          <b className="num">{money(v)}</b>
        </div>
      ))}
    </div>
  );
}

/** Records money the liaison gave back on a disbursed or partly paid line: all of it, or part. Final. */
function ReturnFundModal({ r, line, onClose }) {
  const { api, run, idx } = useApp();
  const p = idx.projects.get(line.project_id);
  const t = idx.typesById.get(line.type_id);
  const c = idx.cats.get(line.category_id);
  const out = lineWithLiaison(line);
  const [f, setF] = useState({ amount: out, return_date: todayISO(), return_ref: "", return_reason: "" });
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    const v = e && e.target ? e.target.value : e;
    setF((x) => ({ ...x, [k]: v }));
    setErr((x) => ({ ...x, [k]: null }));
  };
  const amt = round2(f.amount || 0);
  const left = round2(out - amt);
  const partial = amt > 0 && left > 0.004;
  const dirty = !!(f.return_ref.trim() || f.return_reason.trim() || Math.abs(amt - out) > 0.004);
  const save = async () => {
    const e = {};
    if (!(amt > 0)) e.amount = "Enter the amount returned";
    else if (amt > out + 0.004) e.amount = `Only ${money(out)} is with the liaison`;
    if (!f.return_date) e.return_date = "Enter the date the fund was returned";
    else if (f.return_date > todayISO()) e.return_date = "The date can't be in the future";
    else if (r.disbursed_date && f.return_date < r.disbursed_date) e.return_date = `Not before the disbursement (${fmtDate(r.disbursed_date)})`;
    if (!f.return_ref.trim()) e.return_ref = "Enter the receipt or reference number";
    if (!f.return_reason.trim()) e.return_reason = "Enter the reason for the return";
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const done = await run(
      () => api.returnLine(line.id, { amount: amt, return_date: f.return_date, return_ref: f.return_ref.trim(), return_reason: f.return_reason.trim() }),
      partial ? `${money(amt)} recorded as returned; ${money(left)} still with the liaison` : `${money(amt)} recorded as returned`
    );
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Modal
      title={`Return fund: ${r.ref_no}, line ${line.line_no}`}
      subtitle="Record money the liaison gave back. Returned money leaves the project report, like a rejected line. This can't be undone."
      onClose={onClose}
      width={640}
      dirty={dirty}
      discardTitle="Discard this return?"
      discardBody="Nothing has been recorded yet."
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={save}>
            {partial ? `Record partial return of ${money(amt)}` : `Record return of ${money(amt > 0 ? amt : out)}`}
          </Button>
        </>
      )}
    >
      <div className="oe-return-head">
        <div>
          <span className="oe-code">{p ? p.code : "?"}</span> {c ? c.name : ""}: {t ? t.name : "?"}
          <span className="sub muted small">
            {line.payee ? `${line.payee}. ` : ""}Disbursed {r.disbursed_date ? fmtDate(r.disbursed_date) : ""}
            {r.erp_ref ? `, ERP reference ${r.erp_ref}` : ""}. Filed by {r.liaison_name}.
          </span>
        </div>
        <LineMoney l={line} />
      </div>
      <div className="oe-grid">
        <Field
          label="Amount returned"
          span={5}
          error={err.amount}
          hint={amt > 0 && amt <= out + 0.004 ? (partial ? `Partial: ${money(left)} stays with the liaison` : "Full: nothing left with the liaison") : undefined}
        >
          <MoneyInput value={f.amount} onChange={set("amount")} aria-label="Amount returned" />
        </Field>
        <Field label="Date returned" span={7} error={err.return_date}>
          <input name="return_date" type="date" className="oe-input" value={f.return_date} min={r.disbursed_date || undefined} max={todayISO()} onChange={set("return_date")} style={{ maxWidth: 200 }} />
        </Field>
        <Field label="Receipt or reference no." span={12} error={err.return_ref} hint="Official or acknowledgement receipt, or the Acumatica entry">
          <input name="return_ref" className="oe-input" value={f.return_ref} onChange={set("return_ref")} maxLength={80} data-autofocus />
        </Field>
        <Field label="Reason" span={12} error={err.return_reason}>
          <textarea name="return_reason" className="oe-input" rows={3} value={f.return_reason} onChange={set("return_reason")} maxLength={500} placeholder="For example: permit fee was lower, the rest returned" />
        </Field>
      </div>
    </Modal>
  );
}

/** The liaison records what was given to the client, per line. Defaults to everything still with them. */
function MarkPaidModal({ r, lines, onClose }) {
  const { api, run, idx } = useApp();
  const [amounts, setAmounts] = useState(() => Object.fromEntries(lines.map((l) => [l.id, lineWithLiaison(l)])));
  const [date, setDate] = useState(todayISO());
  const [remarks, setRemarks] = useState("");
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const rows = lines.map((l) => {
    const out = lineWithLiaison(l);
    const amt = round2(amounts[l.id] || 0);
    return { l, out, amt, left: round2(out - amt) };
  });
  const total = rows.reduce((a, x) => a + x.amt, 0);
  const partials = rows.filter((x) => x.amt > 0 && x.left > 0.004);
  const dirty = rows.some((x) => Math.abs(x.amt - x.out) > 0.004) || !!remarks.trim();
  const save = async () => {
    const e = {};
    for (const x of rows) {
      if (!(x.amt > 0)) e[x.l.id] = "Enter the amount given";
      else if (x.amt > x.out + 0.004) e[x.l.id] = `Only ${money(x.out)} is with you`;
    }
    if (!date) e.date = "Enter the date given";
    else if (date > todayISO()) e.date = "The date can't be in the future";
    else if (r.disbursed_date && date < r.disbursed_date) e.date = `Not before the disbursement (${fmtDate(r.disbursed_date)})`;
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const done = await run(
      () => api.markPaid(rows.map((x) => ({ id: x.l.id, amount: x.amt })), date, remarks.trim()),
      partials.length ? `Marked paid; ${money(partials.reduce((a, x) => a + x.left, 0))} to be returned to accounting` : `${rows.length} ${rows.length === 1 ? "line" : "lines"} marked paid`
    );
    setBusy(false);
    if (done) onClose(true);
  };
  return (
    <Modal
      title={`Mark as paid: ${r.ref_no}`}
      subtitle="Enter what you gave to the client for each line. If you gave less, the line becomes Partly paid and the rest goes back to accounting."
      onClose={onClose}
      width={720}
      dirty={dirty}
      discardTitle="Discard these amounts?"
      discardBody="Nothing has been marked paid yet."
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>
            Mark {rows.length} {rows.length === 1 ? "line" : "lines"} paid ({money(total)})
          </Button>
        </>
      )}
    >
      <div className="oe-tablewrap" style={{ marginBottom: 14 }}>
        <table className="oe-table tight">
          <thead>
            <tr>
              <th>Line</th>
              <th className="r">With you</th>
              <th className="r" style={{ width: 190 }}>Given to client</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ l, out, amt, left }) => {
              const p = idx.projects.get(l.project_id);
              const t = idx.typesById.get(l.type_id);
              return (
                <tr key={l.id}>
                  <td>
                    {l.line_no}. <span className="oe-code">{p ? p.code : "?"}</span> {t ? t.name : "?"}
                    {l.payee && <span className="sub">{l.payee}</span>}
                    {amt > 0 && left > 0.004 && amt <= out + 0.004 && (
                      <span className="sub" style={{ color: "var(--amber)" }}>
                        Partly paid: {money(left)} to be returned to accounting
                      </span>
                    )}
                  </td>
                  <td className="r num">{money(out)}</td>
                  <td className="r">
                    <MoneyInput value={amounts[l.id]} onChange={(v) => { setAmounts((a) => ({ ...a, [l.id]: v })); setErr((x) => ({ ...x, [l.id]: null })); }} aria-label={`Amount given, line ${l.line_no}`} />
                    {err[l.id] && <span className="err small" style={{ display: "block", color: "var(--red)" }}>{err[l.id]}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="oe-grid">
        <Field label="Date given to client" span={5} error={err.date}>
          <input name="date" className="oe-input" type="date" value={date} min={r.disbursed_date || undefined} max={todayISO()} onChange={(e) => { setDate(e.target.value); setErr((x) => ({ ...x, date: null })); }} />
        </Field>
        <Field label="Remarks" span={7} hint="Optional">
          <input name="remarks" className="oe-input" value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

/** Read-only request summary laid out like the New request header: details, requester, totals. */
function RequestHeader({ r }) {
  const { idx } = useApp();
  const approved = !!r.approved_at && r.status !== "rejected";
  const lineAmount = (l) => (approved ? (["declined", "cancelled", "returned"].includes(l.status) ? 0 : lineNet(l)) : Number(l.amount));
  const cats = idx.categories.filter((c) => c.is_active || r.lines.some((l) => l.category_id === c.id));
  const catTotals = cats.map((c) => ({ c, amount: r.lines.reduce((a, l) => a + (l.category_id === c.id ? lineAmount(l) : 0), 0) }));
  const projectCount = new Set(r.lines.map((l) => l.project_id)).size;
  const returnedSum = r.lines.reduce((x, l) => x + lineReturned(l), 0);
  const Row = ({ label, children, wrap }) => (
    <div className={`oe-rq-row ${wrap ? "top" : ""}`}>
      <span className="oe-rq-label">{label}</span>
      <span className={`oe-rq-value ${wrap ? "wrap" : ""}`}>{children}</span>
    </div>
  );
  return (
    <div className="oe-rq-head compact">
      <div className="oe-rq-box">
        <Row label="Reference nbr">
          <span className="oe-code">{r.ref_no}</span>
        </Row>
        <Row label="Status">
          <StatusChip status={displayStatus(r, idx)} />
          {(() => {
            const since = statusSince(r, displayStatus(r, idx));
            const n = daysSince(since);
            return n == null ? null : (
              <span className="muted small" style={{ marginLeft: 8 }} title={`Since ${fmtDate(since)}`}>
                {n === 0 ? "since today" : daysLabel(n)}
              </span>
            );
          })()}
        </Row>
        <Row label="Request date">{fmtDate(r.request_date)}</Row>
        <Row label="ERP reference">{r.erp_ref || "—"}</Row>
      </div>
      <div className="oe-rq-box">
        <Row label="Requested by">{r.liaison_name}</Row>
        <Row label="Date needed">{fmtDate(r.date_needed)}</Row>
        <Row label={r.status === "rejected" ? "Rejected by" : "Approved by"}>
          {r.approved_by_name ? `${r.approved_by_name}, ${fmtDate(r.approved_at)}` : "—"}
        </Row>
        <Row label="Disbursed">{r.disbursed_date ? `${fmtDate(r.disbursed_date)}, ${r.disbursed_by_name}` : "—"}</Row>
        <Row label="Description" wrap>
          {r.remarks || "—"}
        </Row>
      </div>
      <div className="oe-rq-box oe-rq-sum" aria-label="Request totals">
        {catTotals.map(({ c, amount }) => (
          <div className="oe-rq-row" key={c.id}>
            <span className="oe-rq-label">{c.name}</span>
            <span className="oe-rq-amt num">{amt(amount) === "—" ? "0.00" : amt(amount)}</span>
          </div>
        ))}
        {approved && Math.abs(reqRequested(r) - reqTotal(r)) > 0.004 && (
          <div className="oe-rq-row">
            <span className="oe-rq-label">Requested</span>
            <span className="oe-rq-amt num muted">{money(reqRequested(r))}</span>
          </div>
        )}
        <div className="oe-rq-row total">
          <span className="oe-rq-label">{approved ? "Approved total" : "Request total"}</span>
          <span className="oe-rq-amt num">{money(approved ? reqTotal(r) - (r.status === "returned" ? returnedSum : 0) : reqRequested(r))}</span>
        </div>
        {returnedSum > 0.004 && (
          <div className="oe-rq-row">
            <span className="oe-rq-label">Fund returned</span>
            <span className="oe-rq-amt num muted">{money(returnedSum)}</span>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 8 }}>
          {r.lines.length} {r.lines.length === 1 ? "line" : "lines"}, {projectCount} {projectCount === 1 ? "project" : "projects"}
        </p>
      </div>
    </div>
  );
}

function RequestDrawer({ requestId, onClose }) {
  const { data, idx, me, can, api, run, ui, go, settings } = useApp();
  const r = data.requests.find((x) => x.id === requestId);
  const [events, setEvents] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [erp, setErp] = useState(r ? r.erp_ref || "" : "");
  const [editErp, setEditErp] = useState(false);
  const [disb, setDisb] = useState({ date: todayISO(), remarks: "" });
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [reclassLine, setReclassLine] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [docBusy, setDocBusy] = useState(null); // line id while its files upload
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [returnLine, setReturnLine] = useState(null);
  const typed = !!r && r.status === "open" && (erp.trim() !== (r.erp_ref || "") || disb.remarks.trim() !== "");
  const sig = r ? r.status + "|" + (r.erp_ref || "") + "|" + r.lines.map((l) => l.status + (l.acct_verified_at ? "a" : "") + (l.tm_verified_at ? "t" : "") + (l.reclass || []).map((x) => x.project_id + x.amount).join("+") + "#" + (l.documents || []).length).join(",") : "";

  useEffect(() => {
    if (!r) return undefined;
    let alive = true;
    api.loadEvents(r.id).then((ev) => alive && setEvents(ev)).catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSel(new Set());
    if (r) setErp(r.erp_ref || "");
    setEditErp(false);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!r)
    return (
      <Drawer title="Request not available" onClose={onClose}>
        <Empty title="This request is no longer visible to you." />
      </Drawer>
    );

  const own = r.liaison_id === me.id;
  const mayTouch = own || can("requests.view_all");
  // the filer (or an admin) can still add or remove supporting documents while the request is for approval
  const canEditDocs = r.status === "on_hold" && can("requests.create") && (own || me.role === "admin");
  // who may record a return: the allowed roles; someone who filed the request only if they are an administrator
  const returnable = (l) => ["disbursed", "part_paid"].includes(l.status) && lineWithLiaison(l) > 0.004 && can("requests.return") && RETURN_ROLES.includes(me.role);
  const mayReturn = (l) => returnable(l) && (r.liaison_id !== me.id || me.role === "admin");
  const addDocs = async (line, files) => {
    setDocBusy(line.id);
    try {
      const docs = [];
      for (const f of files) docs.push(await api.uploadDocument(f));
      await run(() => api.addLineDocuments(line.id, docs), `${docs.length} ${docs.length === 1 ? "document" : "documents"} added to line ${line.line_no}`);
    } catch (e) {
      ui.err((e && e.message) || "A document could not be uploaded.");
    }
    setDocBusy(null);
  };
  const removeDoc = async (d) => {
    const a = await ui.confirm({ title: `Remove ${d.file_name}?`, body: "Approvers will no longer see this document on the request.", confirmLabel: "Remove document", tone: "danger" });
    if (a === null) return;
    run(() => api.removeLineDocument(d.id), `${d.file_name} removed`);
  };
  const lines = r.lines;
  const canPayLine = (l) => l.status === "disbursed" && can("requests.pay") && mayTouch;
  const canAcct = (l) => l.status === "paid" && can("requests.verify_acct") && !l.acct_verified_at;
  const canTm = (l) => l.status === "paid" && can("requests.verify_tm") && !l.tm_verified_at;
  const selectable = (l) => canPayLine(l) || canAcct(l) || canTm(l);
  const selectableIds = lines.filter(selectable).map((l) => l.id);
  const selLines = lines.filter((l) => sel.has(l.id));
  const payIds = selLines.filter(canPayLine).map((l) => l.id);
  const acctIds = selLines.filter(canAcct).map((l) => l.id);
  const tmIds = selLines.filter(canTm).map((l) => l.id);
  const toggle = (id) => setSel((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const act = async (fn, msg) => {
    setBusy(true);
    const ok = await run(fn, msg);
    setBusy(false);
    return ok;
  };
  const lineNo = (lid) => (lines.find((l) => l.id === lid) || {}).line_no;

  const withdraw = async () => {
    const reason = await ui.confirm({
      title: `Cancel ${r.ref_no}?`,
      body: r.erp_ref
        ? `The request moves to Rejected / withdrawn. Its ERP reference ${r.erp_ref} stays on record; void that cash advance in Acumatica.`
        : "The request moves to Rejected / withdrawn. You can file a new one later.",
      input: { label: "Reason", placeholder: "Optional" },
      confirmLabel: "Cancel request",
      cancelLabel: "Back",
      tone: "danger",
    });
    if (reason === null) return;
    act(() => api.withdrawRequest(r.id, reason), `${r.ref_no} withdrawn`);
  };

  return (
    <Drawer
      width="max(70vw, 940px)"
      title={
        <span className="oe-actions" style={{ gap: 10 }}>
          {r.ref_no} <StatusChip status={displayStatus(r, idx)} />
        </span>
      }
      subtitle={`Filed by ${r.liaison_name} on ${fmtDate(r.request_date)}`}
      onClose={onClose}
      dirty={typed}
      discardTitle="Discard what you entered?"
      actions={
        <>
          <Button size="sm" icon="copy" aria-label="Copy reference" title="Copy reference" onClick={() => copyText(r.ref_no).then(() => ui.ok("Reference copied"))} />
          <Button size="sm" icon="print" onClick={() => setPrinting(true)}>
            Print form
          </Button>
        </>
      }
    >
      <RequestHeader r={r} />
      {(r.approval_remarks || r.disbursement_remarks) && (
        <div className="oe-stack" style={{ gap: 8 }}>
          {r.approval_remarks && <Note tone={r.status === "rejected" ? "bad" : "info"}>Top management: {r.approval_remarks}</Note>}
          {r.disbursement_remarks && <Note>Accounting: {r.disbursement_remarks}</Note>}
        </div>
      )}

      {r.status === "on_hold" && (
        <div className="oe-panel">
          <div className="oe-panel-b oe-actions" style={{ justifyContent: "space-between" }}>
            <span className="muted">
              Waiting for top management approval.{canEditDocs ? " You can still attach supporting documents to the lines below." : ""}
            </span>
            <div className="oe-actions">
              {(own || me.role === "admin") && (
                <Button variant="danger" size="sm" onClick={() => setWithdrawOpen(true)} busy={busy}>
                  Withdraw
                </Button>
              )}
              {can("requests.approve") && (!own || me.role === "admin") && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    onClose();
                    go("approvals", { requestId: r.id });
                  }}
                >
                  Review for approval
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {r.status === "open" && (can("requests.erp_ref") || can("requests.disburse") || mayTouch) && (
        <div className="oe-panel">
          <div className="oe-panel-h">
            <div>
              <h2>ERP reference and disbursement</h2>
              <p className="muted small">After filing the cash advance in Acumatica, enter its reference number here. Accounting can then mark the fund as disbursed.</p>
            </div>
            {(own || me.role === "admin") && (
              <Button variant="danger" size="sm" onClick={() => setWithdrawOpen(true)} busy={busy} title="Edit (sends it back for approval) or cancel this request">
                Withdraw
              </Button>
            )}
          </div>
          {r.status === "open" && (
            <div className="oe-panel-b">
              {can("requests.erp_ref") && mayTouch && (!r.erp_ref || editErp) ? (
                <div className="oe-grid" style={{ alignItems: "end" }}>
                  <Field label="ERP reference number" span={6} hint="From Acumatica after you file the cash advance">
                    <input name="erp" className="oe-input" value={erp} onChange={(e) => setErp(e.target.value)} placeholder="e.g. CF-000123" />
                  </Field>
                  <div className="span-6 oe-actions">
                    <Button variant="primary" busy={busy} disabled={!erp.trim()} onClick={() => act(() => api.setErpRef(r.id, erp), "ERP reference saved")}>
                      Save ERP reference
                    </Button>
                    {editErp && <Button onClick={() => setEditErp(false)}>Cancel</Button>}
                  </div>
                </div>
              ) : r.erp_ref ? (
                <div className="oe-actions" style={{ justifyContent: "space-between" }}>
                  <span>
                    ERP reference <b>{r.erp_ref}</b>, entered by {r.erp_ref_by_name}
                  </span>
                  {can("requests.erp_ref") && mayTouch && (
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditErp(true)}>
                      Change
                    </Button>
                  )}
                </div>
              ) : (
                <span className="muted">Waiting for the liaison to enter the ERP reference.</span>
              )}
              {can("requests.disburse") && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
                  {r.erp_ref ? (
                    <div className="oe-grid" style={{ alignItems: "end" }}>
                      <Field label="Disbursement date" span={3}>
                        <input name="date" className="oe-input" type="date" value={disb.date} onChange={(e) => setDisb((d) => ({ ...d, date: e.target.value }))} />
                      </Field>
                      <Field label="Accounting remarks" span={5}>
                        <input name="remarks" className="oe-input" value={disb.remarks} onChange={(e) => setDisb((d) => ({ ...d, remarks: e.target.value }))} placeholder="Optional, e.g. check or voucher number" />
                      </Field>
                      <div className="span-4 oe-actions">
                        <Button variant="primary" busy={busy} disabled={!disb.date} onClick={() => act(() => api.disburseRequest(r.id, disb.date, disb.remarks), `${r.ref_no} marked disbursed`)}>
                          Mark as disbursed
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Note>Disbursement opens once the ERP reference is entered.</Note>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="oe-panel">
        <div className="oe-panel-h">
          <h2>Request lines</h2>
          {selectableIds.length > 0 && (
            <label className="oe-check small">
              <input name="select_all"
                type="checkbox"
                checked={selectableIds.every((id) => sel.has(id))}
                onChange={(e) => setSel(e.target.checked ? new Set(selectableIds) : new Set())}
              />
              Select all you can update
            </label>
          )}
        </div>
        <div className="oe-scrollx">
          <table className="oe-table tight cards">
            <thead>
              <tr>
                {selectableIds.length > 0 && <th aria-label="Select" />}
                <th>#</th>
                <th>Project and expense</th>
                <th>Particulars</th>
                <th className="r">Requested</th>
                <th className="r">Approved</th>
                <th>Status</th>
                <th>Paid</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const p = idx.projects.get(l.project_id);
                const t = idx.typesById.get(l.type_id);
                const c = idx.cats.get(l.category_id);
                return (
                  <tr key={l.id} className={sel.has(l.id) ? "sel" : ["declined", "rejected", "cancelled", "returned"].includes(l.status) ? "muted-row" : ""}>
                    {selectableIds.length > 0 && (
                      <td data-th="Select">{selectable(l) && <input name="select_line" type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select line ${l.line_no}`} />}</td>
                    )}
                    <td data-th="Line">{l.line_no}</td>
                    <td className="lead" style={{ minWidth: 240 }}>
                      <span className="oe-code">{p ? p.code : "?"}</span> {c ? c.name : ""}: {t ? t.name : "?"}
                      {(l.reclass || []).length > 0 && (
                        <>
                          {" "}
                          <Chip tone="violet" plain>
                            {reclassRemaining(l) > 0.004 ? "Partly reclassified" : "Reclassified"}
                          </Chip>
                        </>
                      )}
                      {(l.payee || l.detail) && <span className="sub">{[l.payee && `Payee: ${l.payee}`, l.detail && `${(t && t.detail_label) || "Detail"}: ${l.detail}`].filter(Boolean).join("; ")}</span>}
                      <DocLinks
                        docs={l.documents}
                        required={!!(c && c.require_document)}
                        onOpen={(k) => setViewer({ docs: l.documents, index: k, title: `${r.ref_no}, line ${l.line_no}: supporting documents` })}
                        canRemove={(d) => canEditDocs && (me.role === "admin" || d.uploaded_by === me.id)}
                        onRemove={removeDoc}
                      />
                      {canEditDocs && (
                        <div style={{ marginTop: 4 }}>
                          <AttachMore busy={docBusy === l.id} onFiles={(files) => addDocs(l, files)} label={(l.documents || []).length ? "Attach more" : "Attach document"} />
                        </div>
                      )}
                      {(l.reclass || []).length > 0 && (
                        <div className="oe-reclass">
                          <span className="oe-reclass-t">Reclassified to</span>
                          {l.reclass.map((x) => (
                            <span key={x.id} className="oe-reclass-row" title={[x.remarks, x.created_by_name && `by ${x.created_by_name}`].filter(Boolean).join(", ")}>
                              <b className="oe-code">{(idx.projects.get(x.project_id) || {}).code || "?"}</b> <span className="num">{money(x.amount)}</span>
                              {x.remarks && <span className="muted"> · {x.remarks}</span>}
                            </span>
                          ))}
                          {reclassRemaining(l) > 0.004 && (
                            <span className="oe-reclass-row muted">
                              {money(reclassRemaining(l))} remains on {p ? p.code : "?"}
                            </span>
                          )}
                        </div>
                      )}
                      {(l.status === "part_paid" || (l.status === "disbursed" && lineReturned(l) > 0)) && (
                        <span className="sub" style={{ color: "var(--amber)" }}>
                          {money(lineWithLiaison(l))} still with the liaison
                          {l.status === "part_paid" ? ", to be returned to accounting" : ""}
                        </span>
                      )}
                      {(l.returns || []).length > 0 && (
                        <div className="oe-returned">
                          {[...l.returns]
                            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
                            .map((x) => (
                              <div key={x.id}>
                                <b>
                                  {money(x.amount)} returned {fmtDate(x.return_date)}
                                </b>
                                <span>
                                  {" "}
                                  Ref {x.ref}; {x.reason}
                                </span>
                                {x.created_by_name && <span className="muted"> · Recorded by {x.created_by_name}</span>}
                              </div>
                            ))}
                        </div>
                      )}
                      {mayReturn(l) && (
                        <div style={{ marginTop: 6 }}>
                          <Button size="sm" icon="back" onClick={() => setReturnLine(l)}>
                            Return fund
                          </Button>
                        </div>
                      )}
                      {returnable(l) && !mayReturn(l) && (
                        <span className="sub muted">You filed this request, so someone else records its fund return.</span>
                      )}
                      {p && p.is_internal && ["disbursed", "paid", "closed"].includes(l.status) && can("requests.reclassify") && (
                        <div style={{ marginTop: 6 }}>
                          <Button size="sm" icon="edit" onClick={() => setReclassLine(l)}>
                            {(l.reclass || []).length ? "Edit split" : "Reclassify"}
                          </Button>
                        </div>
                      )}
                    </td>
                    <td className="oe-particulars" data-th="Particulars">{l.description || ""}</td>
                    <td className="r" data-th="Requested">{money(l.amount)}</td>
                    <td className="r" data-th="Approved">{l.approved_amount != null ? money(l.approved_amount) : "—"}</td>
                    <td data-th="Status">
                      <StatusChip status={l.status} />
                    </td>
                    <td style={{ whiteSpace: "nowrap" }} data-th="Paid">
                      {l.paid_date ? fmtDate(l.paid_date) : "—"}
                      {l.paid_date && (lineReturned(l) > 0 || l.status === "part_paid") && <span className="sub num">{money(linePaid(l))} given</span>}
                    </td>
                    <td className="small" style={{ whiteSpace: "nowrap" }} data-th="Verified">
                      {l.status === "returned" ? (
                        <span className="muted">Not needed (returned)</span>
                      ) : l.status === "part_paid" ? (
                        <span className="muted">After the rest is returned</span>
                      ) : (
                        <>
                      <div style={{ color: l.acct_verified_at ? "var(--green)" : "var(--faint)" }} title={l.acct_verified_by_name || ""}>
                        Accounting {l.acct_verified_at ? `✓ ${fmtDate(l.acct_verified_at)}` : l.status === "closed" ? "not needed" : "pending"}
                      </div>
                      <div style={{ color: l.tm_verified_at ? "var(--green)" : "var(--faint)" }} title={l.tm_verified_by_name || ""}>
                        Top mgmt {l.tm_verified_at ? `✓ ${fmtDate(l.tm_verified_at)}` : l.status === "closed" ? "not needed" : "pending"}
                      </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {selectableIds.length > 0 && (
          <div className="oe-panel-b" style={{ borderTop: "1px solid var(--line)" }}>
            <div className="oe-actions" style={{ alignItems: "end" }}>
              {lines.some(canPayLine) && (
                <Button variant="primary" disabled={!payIds.length} busy={busy} onClick={() => setPayOpen(true)} title="Enter what was given to the client for each selected line">
                  Mark {payIds.length || ""} paid…
                </Button>
              )}
              {lines.some(canTm) && (
                <Button variant="primary" disabled={!tmIds.length} busy={busy} onClick={() => act(() => api.verifyLines(tmIds, "tm"), "Verified as top management")}>
                  Verify {tmIds.length || ""} as top management
                </Button>
              )}
              {lines.some(canAcct) && (
                <Button
                  variant={settings.close_policy === "both" ? "primary" : "secondary"}
                  disabled={!acctIds.length}
                  busy={busy}
                  onClick={() => act(() => api.verifyLines(acctIds, "acct"), "Verified as accounting")}
                  title={settings.close_policy === "both" ? undefined : "Top management normally verifies; use this when they are not available"}
                >
                  Verify {acctIds.length || ""} as accounting{settings.close_policy === "both" ? "" : " (backup)"}
                </Button>
              )}
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              Select lines above, then choose an action.{" "}
              {settings.close_policy === "both"
                ? "Paid lines close after both accounting and top management verify them."
                : "Paid lines close when top management verifies them; accounting can verify as a backup."}
            </p>
          </div>
        )}
      </div>

      <div className="oe-panel">
        <div className="oe-panel-h">
          <h2>History</h2>
        </div>
        <div className="oe-panel-b">
          {events == null ? (
            <span className="muted">Loading history…</span>
          ) : events.length === 0 ? (
            <span className="muted">No history recorded.</span>
          ) : (
            <ol className="oe-timeline">
              {[...events]
                .sort((a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : a.id - b.id))
                .map((e) => (
                  <li key={e.id}>
                    <div>
                      <b>
                        {EVENT_TEXT[e.action] || e.action}
                        {e.line_id && lineNo(e.line_id) ? `, line ${lineNo(e.line_id)}` : ""}
                      </b>
                      {e.note && <span>: {e.note}</span>}
                      <small>
                        {e.actor_name}, {fmtDateTime(e.created_at)}
                      </small>
                    </div>
                  </li>
                ))}
            </ol>
          )}
        </div>
      </div>
      {printing && <PrintModal request={r} onClose={() => setPrinting(false)} />}
      {reclassLine && <ReclassifyModal request={r} line={reclassLine} onClose={() => setReclassLine(null)} />}
      {viewer && <DocumentViewer docs={viewer.docs} index={viewer.index} title={viewer.title} onClose={() => setViewer(null)} />}
      {returnLine && <ReturnFundModal r={r} line={returnLine} onClose={() => setReturnLine(null)} />}
      {payOpen && (
        <MarkPaidModal
          r={r}
          lines={selLines.filter(canPayLine)}
          onClose={(done) => {
            setPayOpen(false);
            if (done) setSel(new Set());
          }}
        />
      )}
      {withdrawOpen && (
        <Modal
          title={`Withdraw ${r.ref_no}`}
          subtitle={
            r.status === "open"
              ? "This request is already approved but not yet disbursed. Do you want to change it, or cancel it?"
              : "Do you want to change this request, or cancel it?"
          }
          onClose={() => setWithdrawOpen(false)}
          width={640}
          footer={(close) => <Button onClick={close}>Keep as is</Button>}
        >
          <div className="oe-choice">
            {can("requests.create") && (
              <button
                type="button"
                className="oe-choice-opt"
                data-autofocus
                onClick={() => {
                  setWithdrawOpen(false);
                  onClose();
                  go("new", { editId: r.id });
                }}
              >
                <span className="oe-choice-ic">
                  <Icon name="edit" size={20} />
                </span>
                <span>
                  <b>Edit request</b>
                  <span className="muted small">
                    Change amounts, lines, dates, the description or documents. It keeps {r.ref_no}
                    {r.status === "open"
                      ? ` but goes back to top management for approval${r.erp_ref ? `, and ERP reference ${r.erp_ref} is cleared` : ""}.`
                      : " and stays in the approval queue."}
                  </span>
                </span>
              </button>
            )}
            <button
              type="button"
              className="oe-choice-opt danger"
              onClick={() => {
                setWithdrawOpen(false);
                withdraw();
              }}
            >
              <span className="oe-choice-ic">
                <Icon name="x" size={20} />
              </span>
              <span>
                <b>Cancel request</b>
                <span className="muted small">
                  Withdraw it for good. It moves to Rejected / withdrawn.
                  {r.erp_ref ? ` Remember to void cash advance ${r.erp_ref} in Acumatica.` : ""}
                </span>
              </span>
            </button>
          </div>
        </Modal>
      )}
    </Drawer>
  );
}

/** Split a line filed under an internal project (FOR-ASSIGNMENT, ADVANCES) to the specific projects. */
function ReclassifyModal({ request: r, line: l, onClose }) {
  const { data, idx, api, run, settings, can } = useApp();
  const src = idx.projects.get(l.project_id);
  const type = idx.typesById.get(l.type_id);
  const cat = idx.cats.get(l.category_id);
  const base = Number(l.approved_amount ?? l.amount);
  const near = Number(settings.near_limit_pct) || 90;
  const seeLimits = can("report.view") || can("thresholds.view") || can("requests.approve");
  const targets = useMemo(() => data.projects.filter((p) => !p.is_internal), [data.projects]);
  const [initial] = useState(() =>
    (l.reclass || []).length
      ? l.reclass.map((x) => ({ key: uid(), project_id: x.project_id, amount: Number(x.amount), remarks: x.remarks || "" }))
      : [{ key: uid(), project_id: "", amount: null, remarks: "" }]
  );
  const [rows, setRows] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const strip = (list) => JSON.stringify(list.map(({ key, ...x }) => x));
  const dirty = strip(rows) !== strip(initial);
  const assigned = round2(rows.reduce((a, x) => a + (Number(x.amount) || 0), 0));
  const remaining = round2(base - assigned);
  const setRow = (key, patch) => {
    setRows((rs) => rs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };
  const addRow = () => setRows((rs) => [...rs, { key: uid(), project_id: "", amount: null, remarks: "" }]);

  // limit check for the target project; this line's earlier split on that project is replaced, so it isn't counted twice
  const limitFor = (row) => {
    if (!seeLimits || !row.project_id || !type) return null;
    const project = idx.projects.get(row.project_id);
    const alloc = allocationFor(project, type, idx);
    const u = usageFor(project.id, type.id, idx);
    const earlier = Number(((l.reclass || []).find((x) => x.project_id === row.project_id) || {}).amount || 0);
    const approved = usedOf(u) - earlier;
    const pending = Number(u.pending) || 0;
    const after = approved + pending + (Number(row.amount) || 0);
    return { alloc, approved, pending, balance: alloc.amount - after, state: classify(alloc.amount, after, near) };
  };

  const save = async () => {
    const e = {};
    const filled = rows.filter((x) => x.project_id || Number(x.amount) > 0 || x.remarks.trim());
    const seen = new Set();
    for (const x of filled) {
      const msg = [];
      if (!x.project_id) msg.push("Choose a project");
      else if (seen.has(x.project_id)) msg.push("This project is already in the split");
      if (!(Number(x.amount) > 0)) msg.push("Enter an amount");
      if (x.project_id) seen.add(x.project_id);
      if (msg.length) e[x.key] = msg.join(", ");
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    if (remaining < -0.004) return;
    setBusy(true);
    const ok = await run(
      () => api.reclassifyLine(l.id, filled.map((x) => ({ project_id: x.project_id, amount: round2(x.amount), remarks: x.remarks.trim() }))),
      filled.length ? `${r.ref_no} line ${l.line_no} reclassified` : `Split removed; line ${l.line_no} is back on ${src ? src.code : "the internal project"}`
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title={`Reclassify ${r.ref_no}, line ${l.line_no}`}
      subtitle="Split the amount to the specific projects. Category and expense type stay as originally approved."
      onClose={onClose}
      width="min(1240px, 94vw)"
      className="roomy"
      dirty={dirty}
      discardTitle="Discard this split?"
      footer={(close) => (
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            The original line stays as approved and paid. Record the same reclass in Acumatica separately.
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={remaining < -0.004 || !dirty} onClick={save}>
            Save split
          </Button>
        </>
      )}
    >
      <div className="oe-stack">
        <dl className="oe-reclass-src">
          <div>
            <dt>Request</dt>
            <dd>
              {r.ref_no}, line {l.line_no}
            </dd>
          </div>
          <div>
            <dt>Filed under</dt>
            <dd className="oe-code">{src ? src.code : "?"}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{cat ? cat.name : "—"}</dd>
          </div>
          <div>
            <dt>Expense type</dt>
            <dd>{type ? type.name : "—"}</dd>
          </div>
          <div>
            <dt>Line amount</dt>
            <dd className="num">{money(base)}</dd>
          </div>
        </dl>
        <div className="oe-tablewrap" style={{ overflow: "visible" }}>
          <table className="oe-table tight">
            <thead>
              <tr>
                <th style={{ width: 200 }}>
                  Project ID <span className="oe-req">*</span>
                </th>
                <th style={{ width: 150 }}>Category</th>
                <th style={{ width: 190 }}>Expense type</th>
                <th style={{ width: 180 }} className="r">
                  Amount (₱) <span className="oe-req">*</span>
                </th>
                <th>Remarks</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No projects in the split. Saving puts the whole amount back on {src ? src.code : "the internal project"}.
                  </td>
                </tr>
              )}
              {rows.map((x, i) => {
                const lim = limitFor(x);
                return (
                  <React.Fragment key={x.key}>
                    <tr>
                      <td>
                        <ProjectPicker projects={targets} value={x.project_id} onChange={(id) => setRow(x.key, { project_id: id })} invalid={!!errors[x.key] && !x.project_id} label={`Split row ${i + 1} project ID`} />
                      </td>
                      <td>
                        <input name="category-from-the-original-line" className="oe-input" readOnly tabIndex={-1} value={cat ? cat.name : ""} aria-label="Category (from the original line)" title="From the original line" />
                      </td>
                      <td>
                        <input name="expense-type-from-the-original-line" className="oe-input" readOnly tabIndex={-1} value={type ? type.name : ""} aria-label="Expense type (from the original line)" title="From the original line" />
                      </td>
                      <td>
                        <MoneyInput value={x.amount} onChange={(v) => setRow(x.key, { amount: v })} placeholder="0.00" aria-label={`Split row ${i + 1} amount`} className={errors[x.key] && !(Number(x.amount) > 0) ? "bad" : ""} />
                      </td>
                      <td>
                        <input name="remarks" className="oe-input" value={x.remarks} onChange={(e) => setRow(x.key, { remarks: e.target.value })} placeholder="Optional, e.g. how the amount was identified" aria-label={`Split row ${i + 1} remarks`} />
                      </td>
                      <td className="r">
                        <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove split row ${i + 1}`} onClick={() => setRows((rs) => rs.filter((y) => y.key !== x.key))} />
                      </td>
                    </tr>
                    {(lim || errors[x.key]) && (
                      <tr className="oe-reclass-sub">
                        <td colSpan={6}>
                          {errors[x.key] && <span className="oe-lerr">{errors[x.key]}</span>}
                          {lim && (
                            <span className="oe-lcheck oe-lsub-item">
                              <LimitChip state={lim.state} over={-lim.balance} />
                              <span className="muted">
                                {type.name} on this project: {lim.alloc.amount > 0 ? `limit ${compact(lim.alloc.amount)}` : "no limit set"} · approved {compact(lim.approved)}
                                {lim.pending > 0 && ` · pending approval ${compact(lim.pending)}`} ·{" "}
                                <b style={{ color: lim.balance < -0.004 ? "var(--red)" : "var(--ink)", fontWeight: 600 }}>
                                  {lim.balance < -0.004 ? `over by ${compact(-lim.balance)}` : `balance ${compact(lim.balance)}`}
                                </b>
                              </span>
                            </span>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="oe-actions" style={{ justifyContent: "space-between" }}>
          <Button size="sm" icon="plus" onClick={addRow}>
            Add project
          </Button>
          <dl className="oe-reclass-sum">
            <div>
              <dt>Line amount</dt>
              <dd className="num">{money(base)}</dd>
            </div>
            <div>
              <dt>Assigned</dt>
              <dd className="num">{money(assigned)}</dd>
            </div>
            <div>
              <dt>Remains on {src ? src.code : "internal"}</dt>
              <dd className="num" style={{ color: remaining < -0.004 ? "var(--red)" : undefined }}>
                {money(remaining)}
              </dd>
            </div>
          </dl>
        </div>
        {remaining < -0.004 && <Note tone="bad" icon="alert">The split is {money(-remaining)} more than the line amount. Reduce an amount to save.</Note>}
      </div>
    </Modal>
  );
}

/** Supporting documents on a line: click to open them in the viewer; optional × to remove one. */
function DocLinks({ docs, required, onOpen, canRemove, onRemove }) {
  const list = docs || [];
  if (!list.length) {
    return required ? (
      <span className="oe-docmissing">
        <Icon name="alert" size={13} /> No supporting document
      </span>
    ) : null;
  }
  return (
    <div className="oe-doclinks">
      {list.map((d, i) => (
        <span className="oe-docwrap" key={d.id || d.path}>
          <button
            type="button"
            className="oe-doclink"
            title={`View ${d.file_name}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(i);
            }}
          >
            <Icon name="clip" size={13} />
            <span>{d.file_name}</span>
          </button>
          {canRemove && canRemove(d) && (
            <button
              type="button"
              className="oe-docx"
              aria-label={`Remove ${d.file_name}`}
              title={`Remove ${d.file_name}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(d);
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** Button that picks files, checks them, and hands them over (used to add documents after filing). */
function AttachMore({ busy, onFiles, label = "Attach more" }) {
  const { ui } = useApp();
  const ref = useRef(null);
  return (
    <>
      <input name="files"
        ref={ref}
        type="file"
        accept={DOC_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const chosen = [...(e.target.files || [])];
          e.target.value = "";
          const ok = [];
          for (const f of chosen) {
            const bad = checkDocFile(f);
            if (bad) ui.err(bad);
            else ok.push(f);
          }
          if (ok.length) onFiles(ok);
        }}
      />
      <Button size="sm" variant="ghost" icon="clip" busy={busy} onClick={() => ref.current && ref.current.click()}>
        {label}
      </Button>
    </>
  );
}

/** In-app viewer for a line's supporting documents (PDF and images). */
function DocumentViewer({ docs, index = 0, title, onClose }) {
  const { api } = useApp();
  const [i, setI] = useState(index);
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState("");
  const doc = docs[i];
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setErr("");
    api
      .documentUrl(doc)
      .then((u) => alive && (u ? setUrl(u) : setErr("This document is no longer available.")))
      .catch((e) => alive && setErr(e.message || "This document could not be opened."));
    return () => {
      alive = false;
    };
  }, [doc, api]);
  const isPdf = (doc.mime || "").includes("pdf") || /\.pdf$/i.test(doc.file_name);
  return (
    <Modal
      title={title || "Supporting documents"}
      subtitle={`${docs.length} ${docs.length === 1 ? "document" : "documents"}`}
      onClose={onClose}
      width="min(1200px, 94vw)"
      footer={
        <>
          <span className="muted small" style={{ marginRight: "auto" }}>
            {doc.uploaded_by_name ? `Uploaded by ${doc.uploaded_by_name}` : ""}
            {doc.created_at ? `, ${fmtDateTime(doc.created_at)}` : ""}
          </span>
          {docs.length > 1 && (
            <>
              <Button disabled={i === 0} onClick={() => setI(i - 1)}>
                Previous
              </Button>
              <Button disabled={i === docs.length - 1} onClick={() => setI(i + 1)}>
                Next
              </Button>
            </>
          )}
          {url && (
            <a
              className="oe-btn secondary"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // browsers refuse to open data: URLs (demo documents) as a page; hand them over as a blob instead
                if (!String(url).startsWith("data:")) return;
                e.preventDefault();
                window.open(URL.createObjectURL(dataUrlToBlob(url)), "_blank", "noopener");
              }}
            >
              Open in new tab
            </a>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="oe-viewer">
        <div className="oe-viewer-list">
          {docs.map((d, k) => (
            <button key={d.id || d.path} type="button" aria-current={k === i} onClick={() => setI(k)}>
              <span className="nm">{d.file_name}</span>
              <span className="muted small">{fmtSize(d.size_bytes)}</span>
            </button>
          ))}
        </div>
        <div className="oe-viewer-stage">
          {err ? (
            <span className="muted">{err}</span>
          ) : !url ? (
            <span className="muted">Loading document…</span>
          ) : isPdf ? (
            <iframe src={url} title={doc.file_name} />
          ) : (
            <img src={url} alt={doc.file_name} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------
   14. PRINTABLE FORM
   --------------------------------------------------------------------- */
function RequestForm({ r }) {
  const { idx, settings } = useApp();
  const approved = !!r.approved_at && r.status !== "rejected";
  const live = r.lines.filter((l) => !["declined", "cancelled", "returned"].includes(l.status));
  const total = live.reduce((a, l) => a + (approved ? lineNet(l) : Number(l.amount)), 0);
  return (
    <div className="oe-form">
      <div className="top">
        <div>
          <div className="ttl">{settings.form_title}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10.5, color: "#555" }}>Code</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{r.ref_no}</div>
        </div>
      </div>
      <div className="meta">
        <div><span>Requestor</span><b>{r.liaison_name}</b></div>
        <div><span>Date requested</span><b>{fmtDate(r.request_date)}</b></div>
        <div><span>Date needed</span><b>{fmtDate(r.date_needed)}</b></div>
        <div><span>Status</span><b>{STATUS[displayStatus(r, idx)].label}</b></div>
        <div><span>ERP reference</span><b>{r.erp_ref || "—"}</b></div>
      </div>
      <table>
        <thead>
          <tr>
            <th>No.</th>
            <th>Project ID</th>
            <th>Code</th>
            <th>Acumatica details</th>
            <th>Particulars</th>
            <th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {live.map((l) => {
            const p = idx.projects.get(l.project_id) || {};
            const t = idx.typesById.get(l.type_id) || {};
            // the Acumatica item this expense type is mapped to (Settings, Acumatica mapping)
            const acu = t.acumatica_item_id ? idx.acuById.get(t.acumatica_item_id) : null;
            return (
              <tr key={l.id}>
                <td>{l.line_no}</td>
                <td>{p.code}</td>
                <td style={{ whiteSpace: "nowrap" }}>{t.code || "—"}</td>
                <td>
                  {acu ? (
                    <>
                      {acu.description}
                      <span style={{ display: "block", fontSize: 10, color: "#555" }}>{acu.inv_id}</span>
                    </>
                  ) : (
                    <i style={{ color: "#8a5a00" }}>Not mapped yet ({t.name})</i>
                  )}
                </td>
                <td>
                  {/* the line's remarks only (no payee, no calculation) */}
                  {l.description || ""}
                </td>
                <td className="r">{money(approved ? lineNet(l) : l.amount)}</td>
              </tr>
            );
          })}
          <tr>
            <td colSpan={5} style={{ fontWeight: 700, textAlign: "right" }}>
              Total
            </td>
            <td className="r" style={{ fontWeight: 700 }}>
              {money(total)}
            </td>
          </tr>
        </tbody>
      </table>
      {r.remarks && <p>Remarks: {r.remarks}</p>}
      <div className="appr">
        <div>
          <span>Requested by</span>
          <b>{r.liaison_name}</b>
          <span>Submitted {fmtDate(r.created_at || r.request_date)}</span>
        </div>
        <div>
          <span>Approved by top management</span>
          <b>{approved ? r.approved_by_name : "Not yet approved"}</b>
          <span>{approved ? fmtDateTime(r.approved_at) : "\u00a0"}</span>
        </div>
      </div>
      <div className="foot">
        <span>Confidential</span>
        <span>Printed {fmtDateTime(new Date().toISOString())}</span>
      </div>
    </div>
  );
}

function PrintModal({ request, onClose }) {
  const sheet = useRef(null);
  const print = () => {
    // Copy the preview to a body-level holder that the print stylesheet shows on its own.
    const holder = document.createElement("div");
    holder.className = "oe-print-root";
    holder.innerHTML = sheet.current ? sheet.current.innerHTML : "";
    document.body.appendChild(holder);
    const cleanup = () => {
      window.removeEventListener("afterprint", cleanup);
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => {
      window.print();
      setTimeout(cleanup, 60000);
    }, 50);
  };
  return (
    <Modal
      title="Print request form"
      subtitle="Preview of the printed special request payment form"
      onClose={onClose}
      width={900}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon="print" onClick={print} data-autofocus>
            Print
          </Button>
        </>
      }
    >
      <div className="oe-print-preview" ref={sheet}>
        <RequestForm r={request} />
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------
   15. SETTINGS
   --------------------------------------------------------------------- */
function SettingsPage() {
  const { can, confirmLeave } = useApp();
  const tabs = [
    can("settings.expenses") && { id: "expenses", label: "Expense categories and types" },
    can("settings.expenses") && { id: "rates", label: "SOP rates per district" },
    can("settings.expenses") && { id: "acumatica", label: "Acumatica items" },
    can("settings.users") && { id: "users", label: "Users" },
    can("settings.users") && { id: "access", label: "Access rights" },
    can("settings.users") && { id: "system", label: "System" },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0].id);
  return (
    <div className="oe-page">
      <PageHead title="Settings" desc="Set up expense categories and rates, manage who can sign in, and decide what each role can do." />
      <Tabs tabs={tabs} value={tab} onChange={async (id) => id !== tab && (await confirmLeave()) && setTab(id)} label="Settings sections" />
      {tab === "expenses" && <ExpenseSetup />}
      {tab === "rates" && <DistrictRates />}
      {tab === "acumatica" && <AcumaticaMapping />}
      {tab === "users" && <UsersAdmin />}
      {tab === "access" && <AccessRights />}
      {tab === "system" && <SystemSettings />}
    </div>
  );
}

function ExpenseSetup() {
  const { idx, api, run } = useApp();
  const [cat, setCat] = useState(null);
  const [type, setType] = useState(null);
  const swap = (list, i, j, save) => {
    if (j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    run(async () => {
      await save({ ...a, sort_order: b.sort_order });
      await save({ ...b, sort_order: a.sort_order });
    });
  };
  const nextOrder = (list) => list.reduce((m, x) => Math.max(m, x.sort_order || 0), 0) + 1;

  return (
    <div className="oe-stack">
      <div className="oe-actions" style={{ justifyContent: "space-between" }}>
        <p className="muted" style={{ maxWidth: "72ch" }}>
          Categories group the expense types a liaison picks on each request line. The rate sets both the automatic calculation and the default allocation per project.
        </p>
        <Button variant="primary" icon="plus" onClick={() => setCat({ name: "", is_active: true, sort_order: nextOrder(idx.categories) })}>
          Add category
        </Button>
      </div>
      {idx.categories.map((c, ci) => {
        const types = idx.typesByCat.get(c.id) || [];
        return (
          <div className="oe-panel" key={c.id} style={{ opacity: c.is_active ? 1 : 0.7 }}>
            <div className="oe-panel-h">
              <div className="oe-actions">
                <h2>{c.name}</h2>
                {!c.is_active && <Chip tone="muted">Inactive</Chip>}
                {c.require_document && (
                  <Chip tone="teal" plain>
                    Document required
                  </Chip>
                )}
                <span className="muted small">
                  {types.length} {types.length === 1 ? "type" : "types"}
                </span>
              </div>
              <div className="oe-actions">
                <Button size="sm" variant="ghost" icon="up" aria-label={`Move ${c.name} up`} disabled={ci === 0} onClick={() => swap(idx.categories, ci, ci - 1, api.saveCategory)} />
                <Button size="sm" variant="ghost" icon="down" aria-label={`Move ${c.name} down`} disabled={ci === idx.categories.length - 1} onClick={() => swap(idx.categories, ci, ci + 1, api.saveCategory)} />
                <Button size="sm" icon="edit" onClick={() => setCat(c)}>
                  Edit
                </Button>
                <Button size="sm" icon="plus" onClick={() => setType({ category_id: c.id, name: "", code: "", calc_method: "manual", rate: null, alloc_fixed: null, detail_label: "", is_active: true, sort_order: nextOrder(idx.types) })}>
                  Add type
                </Button>
              </div>
            </div>
            {types.length === 0 ? (
              <Empty title="No expense types yet" body="Add the first type for this category." />
            ) : (
              <div className="oe-scrollx">
                <table className="oe-table tight" style={{ tableLayout: "fixed", minWidth: 1120 }}>
                  <colgroup>
                    {[15, 6, 21, 14, 6, 10, 10, 8, 10].map((w, i) => (
                      <col key={i} style={{ width: w + "%" }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Expense type</th>
                      <th>Code</th>
                      <th>Acumatica details</th>
                      <th>Calculation</th>
                      <th className="r">Rate</th>
                      <th className="r">Fixed allocation</th>
                      <th style={{ paddingLeft: 28 }}>Extra field</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((t, ti) => (
                      <tr key={t.id} className={t.is_active ? "" : "muted-row"}>
                        <td style={{ fontWeight: 500, color: "var(--ink)" }}>{t.name}</td>
                        <td>{t.code || "—"}</td>
                        <td>
                          {t.acumatica_item_id && idx.acuById.get(t.acumatica_item_id) ? (
                            <>
                              {idx.acuById.get(t.acumatica_item_id).description}
                              <span className="sub">{idx.acuById.get(t.acumatica_item_id).inv_id}</span>
                            </>
                          ) : (
                            <span style={{ color: "var(--amber)" }}>Not mapped yet</span>
                          )}
                        </td>
                        <td>{CALC_METHODS[t.calc_method]}</td>
                        <td className="r">{t.rate != null ? `${Number(t.rate)}%` : "—"}</td>
                        <td className="r">{t.alloc_fixed ? money(t.alloc_fixed) : "—"}</td>
                        <td style={{ paddingLeft: 28 }}>{t.detail_label || "—"}</td>
                        <td>{t.is_active ? <Chip tone="teal">Active</Chip> : <Chip tone="muted">Inactive</Chip>}</td>
                        <td className="r" style={{ whiteSpace: "nowrap" }}>
                          <Button size="sm" variant="ghost" icon="up" aria-label={`Move ${t.name} up`} disabled={ti === 0} onClick={() => swap(types, ti, ti - 1, api.saveType)} />
                          <Button size="sm" variant="ghost" icon="down" aria-label={`Move ${t.name} down`} disabled={ti === types.length - 1} onClick={() => swap(types, ti, ti + 1, api.saveType)} />
                          <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${t.name}`} onClick={() => setType(t)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {cat && <CategoryForm cat={cat} onClose={() => setCat(null)} />}
      {type && <TypeForm type={type} onClose={() => setType(null)} />}
    </div>
  );
}

function CategoryForm({ cat, onClose }) {
  const { api, run } = useApp();
  const [f, setF] = useState(cat);
  const dirty = f.name !== cat.name || f.is_active !== cat.is_active || !!f.require_document !== !!cat.require_document;
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f.name.trim()) return;
    setBusy(true);
    const ok = await run(() => api.saveCategory({ ...f, name: f.name.trim() }), cat.id ? "Category updated" : "Category added");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title={cat.id ? `Edit ${cat.name}` : "Add category"}
      onClose={onClose}
      dirty={dirty}
      discardTitle={cat.id ? "Discard your changes?" : "Discard this category?"}
      discardBody={cat.id ? DISCARD_EDIT : DISCARD_NEW}
      width={460}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!f.name.trim()} onClick={save}>
            Save category
          </Button>
        </>
      )}
    >
      <div className="oe-grid">
        <Field label="Category name">
          <input name="name" className="oe-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Bidding" />
        </Field>
        <Field as="div" hint="Inactive categories stay on old requests but can't be picked on new ones.">
          <label className="oe-check">
            <input name="is_active" type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active
          </label>
        </Field>
        <Field as="div" hint="Liaisons must attach at least one PDF or image on every request line in this category; approvers can view it.">
          <label className="oe-check">
            <input name="require_document" type="checkbox" checked={!!f.require_document} onChange={(e) => setF({ ...f, require_document: e.target.checked })} /> Require a supporting document
          </label>
        </Field>
      </div>
    </Modal>
  );
}

function TypeForm({ type, onClose }) {
  const { api, run, idx, data } = useApp();
  const [f0] = useState(() => ({ ...type, rate: type.rate ?? "", code: type.code || "", detail_label: type.detail_label || "", acumatica_item_id: type.acumatica_item_id || "" }));
  const [f, setF] = useState(f0);
  const dirty = JSON.stringify(f) !== JSON.stringify(f0);
  const [busy, setBusy] = useState(false);
  const set = setter(setF);
  const rateNeeded = f.calc_method !== "manual" && (f.rate === "" || f.rate == null);
  const save = async () => {
    if (!f.name.trim() || rateNeeded) return;
    setBusy(true);
    const row = {
      ...f,
      name: f.name.trim(),
      code: f.code.trim() || null,
      rate: num(f.rate),
      alloc_fixed: f.alloc_fixed ? Number(f.alloc_fixed) : null,
      detail_label: f.detail_label.trim() || null,
      acumatica_item_id: f.acumatica_item_id || null,
    };
    const ok = await run(() => api.saveType(row), type.id ? "Expense type updated" : "Expense type added");
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title={type.id ? `Edit ${type.name}` : "Add expense type"}
      onClose={onClose}
      dirty={dirty}
      discardTitle={type.id ? "Discard your changes?" : "Discard this expense type?"}
      discardBody={type.id ? DISCARD_EDIT : DISCARD_NEW}
      width={640}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!f.name.trim() || rateNeeded} onClick={save}>
            Save expense type
          </Button>
        </>
      )}
    >
      <div className="oe-grid">
        <Field label="Category" span={6}>
          <select name="category_id" className="oe-select" value={f.category_id} onChange={set("category_id")}>
            {idx.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Expense type" span={4}>
          <input name="name" className="oe-input" value={f.name} onChange={set("name")} placeholder="e.g. Planning" />
        </Field>
        <Field label="Code" span={2}>
          <input name="code" className="oe-input" value={f.code} onChange={set("code")} placeholder="PLN" />
        </Field>
        <Field label="Calculation on the request" span={6} hint="How the line amount is computed when filing">
          <select name="calc_method" className="oe-select" value={f.calc_method} onChange={set("calc_method")}>
            {Object.entries(CALC_METHODS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rate (%)" span={3} error={rateNeeded ? "Required for this calculation" : null} hint="Also the default allocation">
          <input name="rate" className="oe-input num" inputMode="decimal" value={f.rate} onChange={set("rate")} placeholder="e.g. 2" />
        </Field>
        <Field label="Fixed allocation (₱)" span={3} hint="Per project, when no rate">
          <MoneyInput value={f.alloc_fixed} onChange={set("alloc_fixed")} />
        </Field>
        <Field label="Extra field on the line" span={6} hint="Optional label, e.g. Type of insurance">
          <input name="detail_label" className="oe-input" value={f.detail_label} onChange={set("detail_label")} />
        </Field>
        <Field label="Acumatica item" span={6} hint="Shown as the Acumatica details on the printed request form">
          <select name="acumatica_item_id" className="oe-select" value={f.acumatica_item_id} onChange={set("acumatica_item_id")} style={{ color: f.acumatica_item_id ? undefined : "var(--amber)" }}>
            <option value="">Not mapped yet</option>
            {[...(data.acumaticaItems || [])]
              .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
              .map((it) => (
                <option key={it.id} value={it.id}>
                  {it.inv_id} · {it.description}
                </option>
              ))}
          </select>
        </Field>
        <Field as="div" span={12}>
          <label className="oe-check">
            <input name="is_active" type="checkbox" checked={f.is_active} onChange={set("is_active")} /> Active, can be picked on new requests
          </label>
        </Field>
      </div>
    </Modal>
  );
}

/** Acumatica items (INV ID + description) that expense types are mapped to, in Expense categories and types. */
function AcumaticaMapping() {
  const { idx, data, api, run, ui } = useApp();
  const items = useMemo(
    () => [...(data.acumaticaItems || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.inv_id).localeCompare(String(b.inv_id))),
    [data.acumaticaItems]
  );
  const [form, setForm] = useState({ inv_id: "", description: "" });
  const [editing, setEditing] = useState(null);
  const usedBy = (id) => idx.types.filter((t) => t.acumatica_item_id === id);
  useLeaveGuard(!!(form.inv_id.trim() || form.description.trim()) || !!editing, "Discard your changes?", "The item you were adding or editing will be lost.");

  const addItem = async () => {
    const inv = form.inv_id.trim();
    if (!inv || !form.description.trim()) return ui.err("Enter both the INV ID and the description.");
    if (items.some((x) => norm(x.inv_id) === norm(inv))) return ui.err(`${inv} is already in the list.`);
    const maxSort = items.reduce((m, x) => Math.max(m, x.sort_order || 0), 0);
    if (await run(() => api.saveAcumaticaItem({ inv_id: inv, description: form.description.trim(), sort_order: maxSort + 1 }), `${inv} added`)) setForm({ inv_id: "", description: "" });
  };
  const saveEdit = async () => {
    if (await run(() => api.saveAcumaticaItem(editing), `${editing.inv_id.trim()} updated`)) setEditing(null);
  };
  const remove = async (it) => {
    const used = usedBy(it.id);
    if (used.length) return ui.err(`${it.inv_id} is mapped to ${used.map((t) => t.name).join(", ")}. Change ${used.length === 1 ? "that type" : "those types"} in Expense categories and types first.`);
    const a = await ui.confirm({ title: `Remove ${it.inv_id}?`, body: `${it.description} will no longer be offered for expense types.`, confirmLabel: "Remove item", tone: "danger" });
    if (a === null) return;
    run(() => api.deleteAcumaticaItem(it.id), `${it.inv_id} removed`);
  };

  return (
    <div className="oe-stack">
      <p className="muted" style={{ maxWidth: "80ch" }}>
        The Acumatica items (INV ID and description) used when filing cash advances. Pick one for each expense type in Expense categories and types; the printed request form shows it as the line's Acumatica details.
      </p>
      <div className="oe-panel">
        <div className="oe-panel-h">
          <div>
            <h2>Acumatica items</h2>
            <p className="muted small">
              {items.length} {items.length === 1 ? "item" : "items"}, {items.filter((it) => usedBy(it.id).length).length} in use
            </p>
          </div>
        </div>
        <Filters style={{ marginBottom: 12 }}>
          <input name="inv_id" className="oe-input" value={form.inv_id} onChange={(e) => setForm((f) => ({ ...f, inv_id: e.target.value }))} placeholder="INV ID, e.g. OPGAE0034" style={{ maxWidth: 200 }} aria-label="New item INV ID" maxLength={40} />
          <input name="description" className="oe-input" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Description" style={{ flex: 1, minWidth: 220 }} aria-label="New item description" maxLength={120} />
          <Button icon="plus" disabled={!form.inv_id.trim() || !form.description.trim()} onClick={addItem}>
            Add item
          </Button>
        </Filters>
        <div className="oe-tablewrap">
          <table className="oe-table tight">
            <thead>
              <tr>
                <th style={{ width: 160 }}>INV ID</th>
                <th>Description</th>
                <th>Mapped to</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const used = usedBy(it.id);
                const ed = editing && editing.id === it.id;
                return (
                  <tr key={it.id}>
                    <td>
                      {ed ? (
                        <input name="inv_id" className="oe-input" value={editing.inv_id} onChange={(e) => setEditing((x) => ({ ...x, inv_id: e.target.value }))} aria-label="INV ID" maxLength={40} />
                      ) : (
                        <span className="oe-code">{it.inv_id}</span>
                      )}
                    </td>
                    <td>
                      {ed ? (
                        <input name="description" className="oe-input" value={editing.description} onChange={(e) => setEditing((x) => ({ ...x, description: e.target.value }))} aria-label="Description" maxLength={120} />
                      ) : (
                        it.description
                      )}
                    </td>
                    <td className="small">{used.length ? used.map((t) => t.name).join(", ") : <span className="muted">Not used</span>}</td>
                    <td className="r" style={{ whiteSpace: "nowrap" }}>
                      {ed ? (
                        <>
                          <Button size="sm" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>{" "}
                          <Button size="sm" variant="primary" disabled={!editing.inv_id.trim() || !editing.description.trim()} onClick={saveEdit}>
                            Save
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${it.inv_id}`} onClick={() => setEditing({ id: it.id, inv_id: it.inv_id, description: it.description, sort_order: it.sort_order })} />
                          <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${it.inv_id}`} title={used.length ? "In use; change its expense types first" : "Remove"} onClick={() => remove(it)} />
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!items.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No Acumatica items yet. Add them above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DistrictRates() {
  const { idx, data, api, run } = useApp();
  const [showAll, setShowAll] = useState(false);
  const [extra, setExtra] = useState([]);
  const [newDistrict, setNewDistrict] = useState("");
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const existing = useMemo(() => {
    const m = new Map();
    for (const r of data.districtRates) m.set(norm(r.district) + "|" + r.type_id, r);
    return m;
  }, [data.districtRates]);
  const districts = useMemo(() => {
    const m = new Map();
    for (const d of [...idx.districts, ...data.districtRates.map((r) => r.district), ...extra]) if (d && !m.has(norm(d))) m.set(norm(d), d);
    return [...m.values()].sort();
  }, [idx.districts, data.districtRates, extra]);
  const types = idx.types.filter((t) => t.is_active && (showAll || t.calc_method !== "manual" || t.rate != null || data.districtRates.some((r) => r.type_id === t.id)));
  const key = (d, t) => norm(d) + "|" + t.id;
  const value = (d, t) => (key(d, t) in draft ? draft[key(d, t)] : existing.has(key(d, t)) ? String(Number(existing.get(key(d, t)).rate)) : "");
  const changes = [];
  for (const d of districts)
    for (const t of types) {
      const k = key(d, t);
      if (!(k in draft)) continue;
      const before = existing.has(k) ? Number(existing.get(k).rate) : null;
      const after = num(draft[k]);
      if (before !== after) changes.push({ district: existing.has(k) ? existing.get(k).district : d, type_id: t.id, rate: after });
    }
  useLeaveGuard(changes.length > 0, "Discard rate changes?", "The rates you changed will be lost.");
  const save = async () => {
    setBusy(true);
    if (await run(() => api.saveDistrictRates(changes), "District rates saved")) setDraft({});
    setBusy(false);
  };

  return (
    <div className="oe-stack">
      <p className="muted" style={{ maxWidth: "76ch" }}>
        Leave a cell blank to use the expense type's default rate. A district rate overrides it for every project in that district, for both the calculation and the default allocation.
      </p>
      <Filters style={{ marginBottom: 0 }}>
        <label className="oe-check">
          <input name="showall" type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all expense types
        </label>
        <input name="newdistrict" className="oe-input" value={newDistrict} onChange={(e) => setNewDistrict(e.target.value)} placeholder="Add a district" style={{ maxWidth: 200 }} />
        <Button
          size="sm"
          icon="plus"
          disabled={!newDistrict.trim()}
          onClick={() => {
            setExtra((x) => [...x, newDistrict.trim()]);
            setNewDistrict("");
          }}
        >
          Add district
        </Button>
        <span style={{ flex: 1 }} />
        {changes.length > 0 && <Button onClick={() => setDraft({})}>Discard</Button>}
        <Button variant="primary" disabled={!changes.length} busy={busy} onClick={save}>
          Save {changes.length || ""} {changes.length === 1 ? "change" : "changes"}
        </Button>
      </Filters>
      <div className="oe-tablewrap">
        <table className="oe-table tight oe-matrix">
          <thead>
            <tr>
              <th>District</th>
              {types.map((t) => (
                <th key={t.id} className="c">
                  {t.name}
                  <span className="sub" style={{ fontWeight: 400 }}>
                    default {t.rate != null ? `${Number(t.rate)}%` : "none"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {districts.map((d) => (
              <tr key={d}>
                <td className="oe-code">{d}</td>
                {types.map((t) => (
                  <td key={t.id} className="c">
                    <input name="rate-for"
                      className="oe-input num"
                      style={{ width: 84, height: 32, margin: "0 auto" }}
                      inputMode="decimal"
                      value={value(d, t)}
                      placeholder={t.rate != null ? String(Number(t.rate)) : "—"}
                      aria-label={`${t.name} rate for ${d}`}
                      onChange={(e) => setDraft((x) => ({ ...x, [key(d, t)]: e.target.value.replace(/[^0-9.]/g, "") }))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsersAdmin() {
  const { data, me, api, run, ui } = useApp();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [showFormer, setShowFormer] = useState(false); // deleted users whose profile stays for their records
  const [q, setQ] = useState("");
  const roles = [...data.roles].sort((a, b) => a.sort_order - b.sort_order);
  const formerCount = data.profiles.filter((u) => u.deleted_at).length;
  const users = data.profiles.filter((u) => (showFormer || !u.deleted_at) && (!q || norm(u.full_name).includes(norm(q)) || norm(u.email).includes(norm(q))));
  const save = (u, patch, msg) => run(() => api.saveProfile({ ...u, ...patch }), msg);
  const toggle = async (u) => {
    if (u.is_active) {
      const a = await ui.confirm({ title: `Remove access for ${u.full_name || u.email}?`, body: "They can no longer sign in to this system. Their past requests stay.", confirmLabel: "Remove access", tone: "danger" });
      if (a === null) return;
    }
    save(u, { is_active: !u.is_active }, u.is_active ? "Access removed" : "Access granted");
  };

  return (
    <div className="oe-stack">
      <Filters style={{ marginBottom: 0 }}>
        <SearchBox value={q} onChange={setQ} placeholder="Search name or email" />
        {formerCount > 0 && (
          <label className="oe-check small">
            <input name="showformer" type="checkbox" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} /> Show {formerCount} deleted {formerCount === 1 ? "user" : "users"}
          </label>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>
          Invite user
        </Button>
      </Filters>
      <div className="oe-tablewrap">
        <table className="oe-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Invite</th>
              <th>Access</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === me.id;
              // only an administrator can give, change or remove administrator access (the database checks the same)
              const adminLocked = me.role !== "admin" && u.role === "admin";
              const gone = !!u.deleted_at; // the sign-in is removed; the row stays because their name is on records
              return (
                <tr key={u.id} className={u.is_active ? "" : "muted-row"}>
                  <td style={{ fontWeight: 500, color: "var(--ink)" }}>
                    {u.full_name || "—"}
                    {self && <span className="sub">You</span>}
                    {gone && <span className="sub">Deleted {fmtDate(u.deleted_at)}{u.deleted_by_name ? ` by ${u.deleted_by_name}` : ""}</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select name="role" className="oe-select" style={{ width: 200 }} value={u.role} disabled={self || adminLocked || gone} title={self ? "Another administrator must change your role" : adminLocked ? "Only an administrator can change an administrator" : undefined} onChange={(e) => save(u, { role: e.target.value }, "Role updated")} aria-label={`Role for ${u.full_name}`}>
                      {roles.map((r) => (
                        <option key={r.role} value={r.role} disabled={r.role === "admin" && me.role !== "admin"}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {gone ? (
                      <span className="muted">—</span>
                    ) : u.accepted_at ? (
                      <Chip tone="teal" className="status" title={`Password set ${fmtDateTime(u.accepted_at)}`}>Accepted</Chip>
                    ) : u.invited_at ? (
                      <Chip tone="amber" className="status" title={`Invited ${fmtDateTime(u.invited_at)}. Hasn't opened the link and set a password yet.`}>Pending</Chip>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{gone ? <Chip tone="muted">Deleted</Chip> : u.is_active ? <Chip tone="teal">Can sign in</Chip> : <Chip tone="amber">No access</Chip>}</td>
                  <td className="r" style={{ whiteSpace: "nowrap" }}>
                    {!gone && <Button size="sm" variant="ghost" icon="edit" aria-label={`Rename ${u.full_name}`} onClick={() => setEditing(u)} />}
                    {!self && !adminLocked && !gone && (
                      <>
                        <Button size="sm" variant={u.is_active ? "danger" : "secondary"} onClick={() => toggle(u)}>
                          {u.is_active ? "Remove access" : "Grant access"}
                        </Button>{" "}
                        <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${u.full_name || u.email}`} title="Delete user" onClick={() => setDeleting(u)} />
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        {LIVE
          ? "Invites send an email link that opens this app so the person can set a password. Pending means they haven't opened it yet; Accepted means their password is set."
          : "Demo mode: invited users are added to the demo list only."}
      </p>
      {inviting && <InviteForm roles={roles} onClose={() => setInviting(false)} />}
      {editing && <RenameUser user={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteUser user={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function InviteForm({ roles, onClose }) {
  const { api, run, me } = useApp();
  const [f, setF] = useState({ email: "", full_name: "", role: "liaison" });
  const dirty = f.email.trim() !== "" || f.full_name.trim() !== "" || f.role !== "liaison";
  const [busy, setBusy] = useState(false);
  const set = setter(setF);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  const send = async () => {
    setBusy(true);
    const ok = await run(() => api.inviteUser({ ...f, email: f.email.trim() }), `Invite sent to ${f.email.trim()}`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title="Invite user"
      subtitle="They get an email link to set a password."
      onClose={onClose}
      dirty={dirty}
      discardTitle="Discard this invite?"
      width={500}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!valid} busy={busy} onClick={send}>
            Send invite
          </Button>
        </>
      )}
    >
      <div className="oe-grid">
        <Field label="Email">
          <input name="email" className="oe-input" type="email" value={f.email} onChange={set("email")} placeholder="name@company.com" />
        </Field>
        <Field label="Full name">
          <input name="full_name" className="oe-input" value={f.full_name} onChange={set("full_name")} />
        </Field>
        <Field label="Role">
          <select name="role" className="oe-select" value={f.role} onChange={set("role")}>
            {roles.map((r) => (
              <option key={r.role} value={r.role} disabled={r.role === "admin" && me.role !== "admin"}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/** Delete a user: their sign-in goes; their records stay with their name on them, and the email can be invited again. */
function DeleteUser({ user, onClose }) {
  const { api, run } = useApp();
  const [act, setAct] = useState(null); // null while loading
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .userActivity(user.id)
      .then((a) => alive && setAct(a || {}))
      .catch((e) => alive && setErr((e && e.message) || "Their records could not be checked."));
    return () => {
      alive = false;
    };
  }, [api, user.id]);
  const n = (k) => Number((act && act[k]) || 0);
  const hasRecords = !!act && ["requests", "approvals", "events", "documents", "returns", "reclass"].some((k) => n(k) > 0);
  const counts = [
    ["Requests filed", n("requests")],
    ["Of which still in progress", n("requests_in_progress")],
    ["Requests approved", n("approvals")],
    ["History entries", n("events")],
    ["Documents uploaded", n("documents")],
    ["Fund returns recorded", n("returns")],
    ["Reclassifications", n("reclass")],
  ].filter(([, v]) => v > 0);
  const del = async () => {
    setBusy(true);
    const ok = await run(() => api.deleteUser(user.id), `${user.full_name || user.email} deleted. ${user.email} can be invited again.`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title={`Delete ${user.full_name || user.email}?`}
      subtitle={user.email}
      onClose={onClose}
      width={540}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" className="solid" busy={busy} disabled={!act || !!err} onClick={del}>
            {hasRecords ? "Delete user anyway" : "Delete user"}
          </Button>
        </>
      )}
    >
      {err ? (
        <Note tone="bad">{err}</Note>
      ) : !act ? (
        <p className="muted">Checking their records…</p>
      ) : hasRecords ? (
        <div className="oe-stack" style={{ gap: 12 }}>
          <Note tone="warn" icon="alert">
            This person has records in the system. The records stay, with their name on them; only their sign-in is removed.
          </Note>
          <dl className="oe-kv">
            {counts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {act.recent && act.recent.length > 0 && (
            <div className="oe-tablewrap">
              <table className="oe-table tight">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Their part</th>
                  </tr>
                </thead>
                <tbody>
                  {act.recent.map((r) => (
                    <tr key={r.ref_no + r.role}>
                      <td className="oe-code">{r.ref_no}</td>
                      <td>{fmtDate(r.request_date)}</td>
                      <td>
                        <StatusChip status={r.status} />
                      </td>
                      <td>{r.role === "filed" ? "Filed it" : "Approved it"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {n("requests_in_progress") > 0 && (
            <Note tone="warn">
              {n("requests_in_progress")} of their requests {n("requests_in_progress") === 1 ? "is" : "are"} still in progress. They can no longer act on them, so someone else has to follow them up.
            </Note>
          )}
          <p className="muted small">Afterwards the same email can be invited again as a new user. This can't be undone.</p>
        </div>
      ) : (
        <div className="oe-stack" style={{ gap: 10 }}>
          <p>They have no requests, approvals or other records, so they are removed completely.</p>
          <p className="muted small">The same email can be invited again afterwards. This can't be undone.</p>
        </div>
      )}
    </Modal>
  );
}

function RenameUser({ user, onClose }) {
  const { api, run } = useApp();
  const [name, setName] = useState(user.full_name || "");
  const dirty = name !== (user.full_name || "");
  const save = async () => {
    if (await run(() => api.saveProfile({ ...user, full_name: name.trim() }), "Name updated")) onClose();
  };
  return (
    <Modal
      title="Edit name"
      subtitle={user.email}
      onClose={onClose}
      dirty={dirty}
      discardBody={DISCARD_EDIT}
      width={440}
      footer={(close) => (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={save}>
            Save name
          </Button>
        </>
      )}
    >
      <Field label="Full name" hint="Shown on requests and printed forms">
        <input name="name" className="oe-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Modal>
  );
}

function AccessRights() {
  const { data, api, run, ui, me } = useApp();
  const roles = useMemo(() => [...data.roles].sort((a, b) => a.sort_order - b.sort_order), [data.roles]);
  const snapshot = useMemo(() => Object.fromEntries(roles.map((r) => [r.role, [...r.permissions].sort().join(",")])), [roles]);
  const [draft, setDraft] = useState(() => Object.fromEntries(roles.map((r) => [r.role, new Set(r.permissions)])));
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(Object.fromEntries(roles.map((r) => [r.role, new Set(r.permissions)]))), [roles]);
  const dirty = roles.filter((r) => r.role !== "admin" && draft[r.role] && [...draft[r.role]].sort().join(",") !== snapshot[r.role]);
  useLeaveGuard(dirty.length > 0, "Discard access changes?", "The permissions you ticked or cleared will be lost.");
  const flip = (role, perm) =>
    setDraft((d) => {
      const s = new Set(d[role]);
      s.has(perm) ? s.delete(perm) : s.add(perm);
      return { ...d, [role]: s };
    });
  const save = async () => {
    setBusy(true);
    await run(async () => {
      for (const r of dirty) await api.saveRole({ ...r, permissions: [...draft[r.role]] });
    }, "Access rights saved");
    setBusy(false);
  };
  const addRole = async () => {
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!key) return;
    if (roles.some((r) => r.role === key)) return ui.err("A role with that name already exists.");
    if (await run(() => api.saveRole({ role: key, label: label.trim(), permissions: [], sort_order: roles.length + 1 }), `Role ${label.trim()} added`)) {
      setAdding(false);
      setLabel("");
    }
  };
  const removeRole = async (r) => {
    const a = await ui.confirm({ title: `Remove the ${r.label} role?`, body: "Only roles with no users can be removed.", confirmLabel: "Remove role", tone: "danger" });
    if (a === null) return;
    run(() => api.deleteRole(r.role), `${r.label} removed`);
  };
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))];
  // phones: the grid shows one role at a time, chosen from a list (administrators are read-only, so start on the next role)
  const phone = useIsPhone();
  const [roleView, setRoleView] = useState("");
  const defaultRole = (roles.find((r) => r.role !== "admin") || roles[0] || {}).role;
  const shownRoles = phone ? roles.filter((r) => r.role === (roleView || defaultRole)) : roles;

  return (
    <div className="oe-stack">
      <div className="oe-actions" style={{ justifyContent: "space-between" }}>
        <p className="muted" style={{ maxWidth: "72ch" }}>
          Tick what each role may see and do. The database enforces the same rules, so a hidden tab is also a locked one. Administrators always have every permission.
        </p>
        <div className="oe-actions">
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add role
          </Button>
          <Button variant="primary" disabled={!dirty.length} busy={busy} onClick={save}>
            Save access rights
          </Button>
        </div>
      </div>
      {phone && (
        <Field label="Role" as="div">
          <select name="role_view" className="oe-select" value={roleView || defaultRole || ""} onChange={(e) => setRoleView(e.target.value)} aria-label="Role to edit">
            {roles.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="oe-tablewrap">
        <table className="oe-table tight oe-matrix">
          <thead>
            <tr>
              <th>Permission</th>
              {shownRoles.map((r) => (
                <th key={r.role} className="c">
                  {r.label}
                  {r.role !== "admin" && !["tm", "accounting", "liaison"].includes(r.role) && (
                    <>
                      {" "}
                      <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${r.label}`} onClick={() => removeRole(r)} />
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g}>
                <tr className="grp">
                  <td colSpan={shownRoles.length + 1}>{g}</td>
                </tr>
                {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                  <tr key={p.key}>
                    <td style={{ paddingLeft: 22 }}>{p.label}</td>
                    {shownRoles.map((r) => {
                      // some permissions are limited to certain roles (e.g. fund returns); the database enforces the same
                      const barred = p.roles && !p.roles.includes(r.role);
                      // nobody but an administrator changes the rights of their own role (the database checks the same)
                      const ownRole = me.role !== "admin" && r.role === me.role;
                      return (
                        <td key={r.role} className="c" title={barred ? `Not available to ${r.label}` : ownRole ? "You can't change your own role's rights" : undefined}>
                          <input name={`${r.role}-${p.key}`}
                            type="checkbox"
                            checked={!barred && (r.role === "admin" || (draft[r.role] && draft[r.role].has(p.key)))}
                            disabled={r.role === "admin" || barred || ownRole}
                            onChange={() => flip(r.role, p.key)}
                            aria-label={`${r.label}: ${p.label}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Modal
          title="Add role"
          onClose={() => {
            setAdding(false);
            setLabel("");
          }}
          dirty={label.trim() !== ""}
          discardTitle="Discard this role?"
          width={420}
          footer={(close) => (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" disabled={!label.trim()} onClick={addRole}>
                Add role
              </Button>
            </>
          )}
        >
          <Field label="Role name" hint="Starts with no permissions; tick them in the table after adding.">
            <input name="label" className="oe-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. POD manager" />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function SystemSettings() {
  const { settings, api, run } = useApp();
  const [f, setF] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(settings), [settings]);
  useLeaveGuard(JSON.stringify(f) !== JSON.stringify(settings), "Discard setting changes?", DISCARD_EDIT);
  const set = setter(setF);
  const year = new Date().getFullYear();
  const save = async () => {
    setBusy(true);
    await run(
      () =>
        api.saveSettings({
          ...f,
          company_name: undefined, // retired: nothing in the app shows a company name
          ref_prefix: (f.ref_prefix || "REQ").trim().toUpperCase(),
          near_limit_pct: Math.min(100, Math.max(1, Number(f.near_limit_pct) || 90)),
          idle_minutes: Math.max(0, Number(f.idle_minutes) || 0),
          demo_enabled: f.demo_enabled !== false,
        }),
      "System settings saved"
    );
    setBusy(false);
  };
  return (
    <div className="oe-stack">
    <div className="oe-panel" style={{ maxWidth: 820 }}>
      <div className="oe-panel-b">
        <div className="oe-grid">
          <div className="oe-sect">Request reference</div>
          <Field label="Reference prefix" span={4} hint={`Next IDs look like ${(f.ref_prefix || "REQ").trim().toUpperCase()}-${year}-0001`}>
            <input name="ref_prefix" className="oe-input" value={f.ref_prefix} onChange={set("ref_prefix")} maxLength={10} />
          </Field>
          <div className="span-8" />
          <div className="oe-sect">Closing paid lines</div>
          <Field as="div" span={12}>
            <label className="oe-check">
              <input type="radio" name="oe-close" checked={f.close_policy !== "both"} onChange={() => setF({ ...f, close_policy: "either" })} /> One verification: top management verifies, accounting is the backup (default)
            </label>
            <label className="oe-check">
              <input type="radio" name="oe-close" checked={f.close_policy === "both"} onChange={() => setF({ ...f, close_policy: "both" })} /> Both accounting and top management must verify
            </label>
          </Field>
          <div className="oe-sect">Limits and security</div>
          <Field label="Near-limit warning at (%)" span={4} hint="Lines at or above this share of the allocation show a warning">
            <input name="near_limit_pct" className="oe-input num" inputMode="numeric" value={f.near_limit_pct} onChange={set("near_limit_pct")} />
          </Field>
          <Field label="Sign out after inactivity (minutes)" span={4} hint="0 turns this off">
            <input name="idle_minutes" className="oe-input num" inputMode="numeric" value={f.idle_minutes} onChange={set("idle_minutes")} />
          </Field>
          <div className="span-4" />
          {api.mode === "live" && (
            <>
              <div className="oe-sect">Sign-in page</div>
              <Field
                as="div"
                span={12}
                hint={
                  DEMO_ENABLED
                    ? "When off, the sign-in page no longer offers the demo. The demo only ever shows made-up sample data in the visitor's own browser."
                    : "Turned off for this deployment (VITE_DEMO_ENABLED=false in the environment), so this switch has no effect."
                }
              >
                <label className="oe-check">
                  <input name="demo_enabled" type="checkbox" checked={DEMO_ENABLED && f.demo_enabled !== false} disabled={!DEMO_ENABLED} onChange={(e) => setF({ ...f, demo_enabled: e.target.checked })} /> Offer "Try the demo with sample data" on the sign-in page
                </label>
              </Field>
            </>
          )}
          <div className="oe-sect">Printed form</div>
          <Field label="Form title" span={6}>
            <input name="form_title" className="oe-input" value={f.form_title} onChange={set("form_title")} />
          </Field>
          <div className="span-12 oe-actions" style={{ justifyContent: "space-between", marginTop: 6 }}>
            <span className="muted small">
              {LIVE ? `Connected to ${CONFIG.supabaseUrl.replace(/^https?:\/\//, "")}` : "Demo mode: settings reset on reload."}
              {APP_BUILD.time && (
                <span style={{ display: "block" }}>
                  Version {APP_BUILD.commit || "local"}, built {fmtDateTime(APP_BUILD.time)}
                </span>
              )}
            </span>
            <Button variant="primary" busy={busy} onClick={save}>
              Save system settings
            </Button>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   16. SIGN-IN SCREENS
   --------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Sign-in page: deliberately unbranded (no logo, company or system name).
   The background is a survey-style contour plan generated in the browser.
   --------------------------------------------------------------------- */
const TOPO_W = 1600;
const TOPO_H = 1000;
let topoCache = null;
/** Contour lines (marching squares over a few smooth "hills"); every fifth line is an index contour. */
function topoLines() {
  if (topoCache) return topoCache;
  const S = 16;
  const cols = Math.ceil(TOPO_W / S) + 1;
  const rows = Math.ceil(TOPO_H / S) + 1;
  // [centre x, centre y, radius x, radius y] as fractions of the plan, then height
  const hills = [
    [0.3, 0.58, 0.2, 0.26, 1],
    [0.6, 0.2, 0.15, 0.12, 0.62],
    [0.1, 0.12, 0.1, 0.12, 0.42],
    [0.86, 0.76, 0.15, 0.18, -0.5],
    [0.52, 0.9, 0.22, 0.08, 0.32],
  ];
  const height = (x, y) => {
    const u = x / TOPO_W;
    const v = y / TOPO_H;
    let z = 0.22 * u - 0.1 * v;
    for (const [cx, cy, rx, ry, a] of hills) {
      const dx = (u - cx) / rx;
      const dy = (v - cy) / ry;
      z += a * Math.exp(-(dx * dx + dy * dy));
    }
    return z + 0.035 * Math.sin(u * 11 + v * 4) + 0.025 * Math.sin(v * 13 - u * 6) + 0.015 * Math.sin(u * 23 + v * 17);
  };
  const g = new Float32Array(cols * rows);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const z = height(i * S, j * S);
      g[j * cols + i] = z;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  const levels = 28;
  const step = (hi - lo) / (levels + 1);
  const minor = [];
  const major = [];
  const R = Math.round;
  for (let k = 1; k <= levels; k++) {
    const t = lo + k * step;
    const out = k % 5 === 0 ? major : minor;
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = g[j * cols + i];
        const b = g[j * cols + i + 1];
        const c = g[(j + 1) * cols + i + 1];
        const d = g[(j + 1) * cols + i];
        const n = (a > t ? 8 : 0) | (b > t ? 4 : 0) | (c > t ? 2 : 0) | (d > t ? 1 : 0);
        if (n === 0 || n === 15) continue;
        const x = i * S;
        const y = j * S;
        const T = () => `${R(x + (S * (t - a)) / (b - a))} ${R(y)}`;
        const Rt = () => `${R(x + S)} ${R(y + (S * (t - b)) / (c - b))}`;
        const B = () => `${R(x + (S * (t - d)) / (c - d))} ${R(y + S)}`;
        const L = () => `${R(x)} ${R(y + (S * (t - a)) / (d - a))}`;
        const seg = (p, q) => out.push(`M${p}L${q}`);
        switch (n) {
          case 1: case 14: seg(L(), B()); break;
          case 2: case 13: seg(B(), Rt()); break;
          case 3: case 12: seg(L(), Rt()); break;
          case 4: case 11: seg(T(), Rt()); break;
          case 6: case 9: seg(T(), B()); break;
          case 7: case 8: seg(L(), T()); break;
          case 5: seg(T(), Rt()); seg(L(), B()); break;
          case 10: seg(L(), T()); seg(B(), Rt()); break;
          default: break;
        }
      }
  }
  topoCache = { minor: minor.join(""), major: major.join("") };
  return topoCache;
}

function TopoBackdrop() {
  const { minor, major } = topoLines();
  // survey benchmarks near the two main summits
  const marks = [
    [0.3 * TOPO_W, 0.57 * TOPO_H],
    [0.6 * TOPO_W, 0.2 * TOPO_H],
  ];
  return (
    <svg className="oe-topo" viewBox={`0 0 ${TOPO_W} ${TOPO_H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="oe-plan-grid" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M100 0H0V100" fill="none" stroke="#cdeee9" strokeOpacity="0.05" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={TOPO_W} height={TOPO_H} fill="url(#oe-plan-grid)" />
      <path className="minor" d={minor} />
      <path className="major" d={major} />
      {marks.map(([x, y]) => (
        <g className="bm" key={x} transform={`translate(${Math.round(x)} ${Math.round(y)})`}>
          <path d="M0 -9L8 5H-8Z" />
          <path d="M-16 0H-11M11 0H16M0 -18V-13M0 11V16" />
          <circle r="1.6" />
        </g>
      ))}
    </svg>
  );
}

/** Page frame shared by sign-in and set-password. */
function SignInFrame({ children }) {
  return (
    <div className="oe-signin">
      <TopoBackdrop />
      <main className="oe-signin-card">
        <svg className="oe-signin-mark" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
          <rect width="40" height="40" rx="11" />
          <g>
            <ellipse cx="20.5" cy="21" rx="12.5" ry="10.5" transform="rotate(-18 20.5 21)" />
            <ellipse cx="19.5" cy="20.5" rx="8" ry="6.4" transform="rotate(-18 19.5 20.5)" />
            <ellipse cx="18.8" cy="20" rx="3.6" ry="2.8" transform="rotate(-18 18.8 20)" />
          </g>
        </svg>
        {children}
      </main>
      <div className="oe-signin-foot">
        <Icon name="lock" size={14} /> Authorized users only
      </div>
    </div>
  );
}

/* Cloudflare Turnstile (captcha). Only rendered when CONFIG.captchaSiteKey is set, so nothing is
   loaded from Cloudflare until captcha is switched on in Supabase → Auth → Attack protection. */
let turnstilePromise = null;
function loadTurnstile() {
  if (!turnstilePromise)
    turnstilePromise = new Promise((resolve, reject) => {
      if (window.turnstile) return resolve(window.turnstile);
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => {
        turnstilePromise = null;
        reject(new Error("The verification widget couldn't be loaded."));
      };
      document.head.appendChild(s);
    });
  return turnstilePromise;
}

function Captcha({ siteKey, onToken, resetKey }) {
  const box = useRef(null);
  const widget = useRef(null);
  useEffect(() => {
    let alive = true;
    loadTurnstile()
      .then((ts) => {
        if (!alive || !box.current) return;
        widget.current = ts.render(box.current, {
          sitekey: siteKey,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      alive = false;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (resetKey && widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, [resetKey]);
  return <div ref={box} className="oe-captcha" />;
}

function Login({ api, onDone, onSwitchMode, demoOffered, notice }) {
  const [f, setF] = useState({ user: (notice && notice.user) || "", password: "" });
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState(notice ? { tone: notice.tone || "info", text: notice.text } : null);
  const [busy, setBusy] = useState(false);
  const demo = api.mode === "demo";
  const captchaOn = !demo && Boolean(CONFIG.captchaSiteKey);
  const [captcha, setCaptcha] = useState(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  // "Forgot password?": ask for the email, send the reset link, and say so without confirming the account exists
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const openForgot = () => {
    setForgot(true);
    setSent(false);
    setMsg(null);
    setEmail(loginEmail(f.user) || "");
  };
  const closeForgot = () => {
    setForgot(false);
    setSent(false);
    setMsg(null);
  };
  const sendReset = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    const em = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return setMsg({ tone: "warn", text: "Enter your full email address." });
    if (captchaOn && !captcha) return setMsg({ tone: "warn", text: "Complete the verification first." });
    setBusy(true);
    setMsg(null);
    try {
      await api.resetPassword(em, captchaOn ? captcha : undefined);
      setSent(true);
    } catch (err) {
      setMsg({ tone: "bad", text: /rate|second|too many/i.test(err.message) ? "A link was sent a moment ago. Wait a minute before asking again." : err.message });
      if (captchaOn) {
        setCaptcha(null);
        setCaptchaReset((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (!f.user.trim() || !f.password) return setMsg({ tone: "warn", text: "Enter your username and password." });
    if (captchaOn && !captcha) return setMsg({ tone: "warn", text: "Complete the verification first." });
    setBusy(true);
    setMsg(null);
    try {
      await api.signIn(f.user, f.password, captchaOn ? captcha : undefined);
      await onDone();
    } catch (err) {
      setMsg({ tone: "bad", text: /invalid/i.test(err.message) ? "Username or password is incorrect." : err.message });
      if (captchaOn) {
        setCaptcha(null);
        setCaptchaReset((n) => n + 1);
      }
      setBusy(false);
    }
  };
  return (
    <SignInFrame>
        {demo ? (
          <div className="oe-login-card">
            <div>
              <h2>Choose a demo account</h2>
              <p className="muted" style={{ marginTop: 4 }}>
                Demo mode with sample data that resets on reload. Live mode signs in with username and password.
              </p>
            </div>
            <div className="oe-demo-users">
              {api.demoAccounts().map((u) => (
                <button
                  key={u.id}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.signIn(u.username, demoPassword(u.username));
                      await onDone();
                    } catch (err) {
                      setMsg({ tone: "bad", text: err.message });
                      setBusy(false);
                    }
                  }}
                >
                  <span>
                    <b style={{ color: "var(--ink)", fontWeight: 500 }}>{u.full_name}</b>
                    <span className="muted small" style={{ display: "block" }}>
                      {u.username}
                    </span>
                  </span>
                  <Chip tone="teal" plain>
                    {u.roleLabel}
                  </Chip>
                </button>
              ))}
            </div>
            {msg && <Note tone={msg.tone}>{msg.text}</Note>}
            {onSwitchMode && LIVE && (
              <Button variant="ghost" icon="lock" disabled={busy} onClick={() => onSwitchMode("live")}>
                Sign in with your account
              </Button>
            )}
          </div>
        ) : forgot ? (
          <form className="oe-login-card" onSubmit={sendReset}>
            <div>
              <h2>Reset your password</h2>
              <p className="muted" style={{ marginTop: 4 }}>
                Enter the email address your administrator invited you with. We'll send a link to choose a new password.
              </p>
            </div>
            {sent ? (
              <>
                <Note tone="info">
                  If {email.trim()} has an account, a reset link is on its way. Check your inbox and spam folder. The link works once and expires after one hour.
                </Note>
                <Button variant="primary" onClick={closeForgot}>
                  Back to sign in
                </Button>
              </>
            ) : (
              <>
                <Field label="Email address">
                  <input name="email" className="oe-input" type="email" autoComplete="email" inputMode="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                {captchaOn && <Captcha siteKey={CONFIG.captchaSiteKey} onToken={setCaptcha} resetKey={captchaReset} />}
                {msg && <Note tone={msg.tone}>{msg.text}</Note>}
                <Button type="submit" variant="primary" busy={busy} onClick={sendReset}>
                  Send reset link
                </Button>
                <Button variant="ghost" disabled={busy} onClick={closeForgot}>
                  Back to sign in
                </Button>
              </>
            )}
          </form>
        ) : (
          <form className="oe-login-card" onSubmit={submit}>
            <div>
              <h2>Sign in</h2>
              <p className="muted" style={{ marginTop: 4 }}>
                Use the username and password from your administrator.
              </p>
            </div>
            <Field label="Username" hint={CONFIG.usernameDomain ? null : "Your full company email address"}>
              <input name="username"
                className="oe-input"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                value={f.user}
                onChange={(e) => setF({ ...f, user: e.target.value })}
              />
            </Field>
            <Field
              as="div"
              label={
                <span className="oe-label-row">
                  Password
                  <button type="button" className="oe-forgot" onClick={openForgot}>
                    Forgot password?
                  </button>
                </span>
              }
            >
              <div className="oe-pass">
                <input name="password"
                  className="oe-input"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  aria-label="Password"
                  value={f.password}
                  onChange={(e) => setF({ ...f, password: e.target.value })}
                />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>
                  {show ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
            {captchaOn && <Captcha siteKey={CONFIG.captchaSiteKey} onToken={setCaptcha} resetKey={captchaReset} />}
            {msg && <Note tone={msg.tone}>{msg.text}</Note>}
            <Button type="submit" variant="primary" busy={busy} onClick={submit}>
              Sign in
            </Button>
            {onSwitchMode && demoOffered && (
              <>
                <div className="oe-login-or">
                  <span>or</span>
                </div>
                <Button variant="ghost" disabled={busy} onClick={() => onSwitchMode("demo")}>
                  Try the demo with sample data
                </Button>
              </>
            )}
          </form>
        )}
    </SignInFrame>
  );
}

function SetPassword({ api, onDone, mode = "invite" }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Who the invite is for, read from the profile the administrator created with the invite.
  const [who, setWho] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const prof = await api.getProfile();
        if (!prof) return;
        const roleLabel = await api.getRoleLabel(prof.role);
        if (alive) setWho({ name: prof.full_name || "", email: prof.email || "", roleLabel });
      } catch (x) {
        /* the form still works without the summary */
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (a.length < 8) return setErr("Use at least 8 characters.");
    if (a !== b) return setErr("The two passwords don't match.");
    setErr("");
    setBusy(true);
    try {
      await api.updatePassword(a);
      if (window.history && window.history.replaceState) window.history.replaceState(null, "", window.location.pathname + window.location.search);
      await onDone(who ? who.email : "");
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  };
  return (
    <SignInFrame>
        <form className="oe-login-card" onSubmit={submit}>
          <div>
            <h2>{mode === "reset" ? "Choose a new password" : "Set your password"}</h2>
            <p className="muted" style={{ marginTop: 4 }}>
              {mode === "reset"
                ? "Enter a new password for your account, then sign in with it."
                : "You've been invited to this system. Choose a password, then sign in with it. Until you do, this is the only page you can open."}
            </p>
          </div>
          {who && (
            <div className="oe-invite-who">
              <div>
                <b style={{ color: "var(--ink)", fontWeight: 500 }}>{who.name || who.email}</b>
                {who.name && (
                  <span className="muted small" style={{ display: "block" }}>
                    {who.email}
                  </span>
                )}
              </div>
              <Chip tone="teal" plain>
                {who.roleLabel}
              </Chip>
            </div>
          )}
          <Field label="New password" hint="At least 8 characters" as="div">
            <div className="oe-pass">
              <input name="new_password" className="oe-input" type={show ? "text" : "password"} autoComplete="new-password" aria-label="New password" autoFocus value={a} onChange={(e) => setA(e.target.value)} />
              <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
          </Field>
          <Field label="Retype password">
            <input name="confirm_password" className="oe-input" type={show ? "text" : "password"} autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
          </Field>
          {err && <Note tone="bad">{err}</Note>}
          <Button type="submit" variant="primary" busy={busy} onClick={submit}>
            {mode === "reset" ? "Save new password" : "Confirm password"}
          </Button>
        </form>
    </SignInFrame>
  );
}

/* ---------------------------------------------------------------------
   17. APP SHELL
   --------------------------------------------------------------------- */
// path: the module's address. vercel.json rewrites each one to the app so it can be opened or reloaded directly.
const NAV = [
  { id: "report", path: "/project-report", label: "Project report", icon: "report", perms: ["report.view"] },
  { id: "new", path: "/new-request", label: "New request", icon: "plus", perms: ["requests.create"] },
  { id: "approvals", path: "/approvals", label: "Approvals", icon: "check", perms: ["requests.approve"] },
  { id: "requests", path: "/requests", label: "Request list", icon: "list", perms: ["requests.view_own", "requests.view_all"] },
  { id: "analysis", path: "/analysis", label: "Analysis", icon: "clock", perms: ["analysis.view"] },
  { id: "projects", path: "/projects", label: "Project listing", icon: "folder", perms: ["projects.view"] },
  { id: "settings", path: "/settings", label: "Settings", icon: "sliders", perms: ["settings.expenses", "settings.users"] },
];
const NAV_COLLAPSED_KEY = "oe-nav-collapsed"; // localStorage: the side panel was collapsed to icons on this browser
const IOS_HINT_KEY = "oe-ios-hint"; // localStorage: the "Add to Home Screen" hint was dismissed

/* Installing as an app. Chrome on Android fires beforeinstallprompt, possibly before React mounts, so it is caught here
   and offered later as an "Install app" button. iPhones have no prompt: Safari users add it from the Share menu. */
const IS_IOS = typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
const STANDALONE = typeof window !== "undefined" && ((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true);
let installPrompt = null;
if (typeof window !== "undefined")
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    window.dispatchEvent(new Event("oe-install-ready"));
  });

/* Push notifications (Web Push). Offered when the build carries the public key, the browser supports push and the
   app's service worker is installed (production builds; never the dev server or the demo). The browser sends the
   subscription to Supabase; the oe-push function sends the notifications. On iPhone and iPad, push works only in the
   app added to the Home Screen. */
const PUSH_SUPPORTED = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const PUSH_LATER_KEY = "oe-push-later"; // sessionStorage: "Not now" was tapped in this tab
const b64urlToBytes = (str) => {
  const b = atob(str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
/** Rejects with the message after ms; for browser steps that can otherwise wait forever. */
const withTimeout = (promise, ms, message) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
const QUIET_HINT = "Your browser is hiding the permission request: click the bell or notification icon in the address bar and choose Allow.";
/** Asks for notification permission. Chrome and Edge can hide the request behind an icon in the address bar
 *  ("quieter prompts"); the browser's promise then stays open until the person clicks it. onWaiting is called when
 *  that happens, and the answer still arrives once they give it. Gives up after ten minutes. */
const askPermission = (onWaiting) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (p) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(hint);
      clearTimeout(giveUp);
      resolve(p);
    };
    Notification.requestPermission().then(finish, () => finish(Notification.permission));
    // some browsers settle the permission without ever resolving the promise: watch the value as well
    const poll = setInterval(() => Notification.permission !== "default" && finish(Notification.permission), 500);
    const hint = setTimeout(() => Notification.permission === "default" && onWaiting(), 6000);
    const giveUp = setTimeout(() => finish(Notification.permission), 10 * 60_000);
  });
/** Subscribes this browser (or keeps its subscription current) and saves it for the signed-in person. */
async function pushSubscribe(api) {
  // No registration at all means the page has no service worker: the dev server (npm run dev) never installs one,
  // so notifications can't work there. Otherwise the worker registers while the page loads: give it a moment.
  if (!(await navigator.serviceWorker.getRegistration())) {
    throw new Error("This page has no service worker, so notifications can't work here. On a PC, build the app (npm run build) and open it with npm run preview, or use the live address.");
  }
  const reg = await withTimeout(navigator.serviceWorker.ready, 8000, "The app's service worker is not installed yet. Reload the page and try again.");
  const key = b64urlToBytes(CONFIG.vapidPublicKey);
  // Chrome, Edge and Brave hand the request to their push service; when that is blocked (company network, Brave's
  // "Use Google services for push messaging" off) some of them wait instead of failing
  const subscribe = () =>
    withTimeout(
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
      20000,
      'The browser\'s push service did not answer. Check that the browser allows push messaging (Brave: turn on "Use Google services for push messaging") and that the network is not blocking it, then try again.'
    );
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with an older key pair cannot be used by the function: start over
  if (sub && sub.options && sub.options.applicationServerKey && !sameBytes(new Uint8Array(sub.options.applicationServerKey), key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await subscribe();
  const save = (x) => {
    const j = x.toJSON();
    return api.savePushSubscription({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) });
  };
  try {
    await save(sub);
  } catch (e) {
    // this browser's subscription belongs to another account (someone else signed in here): make a fresh one
    await sub.unsubscribe();
    sub = await subscribe();
    await save(sub);
  }
  return sub;
}
/** Sign-out: this device stops receiving this person's notifications. */
async function pushForget(api) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await api.removePushSubscription(sub.endpoint);
  } catch (e) {
    /* best effort */
  }
}
function usePush(api, ready, approver) {
  const ui = useUI();
  const offered = PUSH_SUPPORTED && !!CONFIG.vapidPublicKey && api.mode === "live";
  const [perm, setPerm] = useState(() => (PUSH_SUPPORTED ? Notification.permission : "unsupported"));
  const [later, setLater] = useState(() => {
    try {
      return sessionStorage.getItem(PUSH_LATER_KEY) === "1";
    } catch (e) {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [quiet, setQuiet] = useState(false); // the browser is hiding the permission request behind an address-bar icon
  const asking = useRef(false);
  // already allowed: keep the subscription current on every sign-in, silently
  useEffect(() => {
    if (offered && ready && perm === "granted") pushSubscribe(api).catch(() => {});
  }, [offered, ready, perm, api]);
  // saves this device's subscription, then asks the server for a test notification and reports what happened
  const sendTest = useCallback(
    async (okText) => {
      await pushSubscribe(api); // from here on this device is signed up
      let r;
      try {
        r = await api.pushTest();
      } catch (e) {
        return ui.err(`This device is signed up, but the test message could not be sent (${(e && e.message) || "unknown error"}). It will still get notifications.`);
      }
      console.info("oe-push test", r); // per device: the push service and its answer (F12 → Console)
      if (r && r.sent === 0) {
        const note = ((r.details || []).find((d) => d.note) || {}).note;
        ui.err(
          r.failed
            ? `This device is signed up, but the push service refused the test message${note ? ` (${note})` : ""}. Try again in a minute.`
            : "This device could not be found for the test message. Turn notifications off and on again."
        );
      } else {
        // On a PC the browser shows it through Windows, which can be the part that is off
        const services = [...new Set(((r && r.details) || []).map((d) => d.service))].filter(Boolean);
        const pc = /Windows|Macintosh|Linux/.test(navigator.userAgent) && !/Android|Mobile/.test(navigator.userAgent);
        ui.ok(
          `${okText} The push service${services.length ? ` (${services.join(", ")})` : ""} accepted it.${
            pc ? " If nothing shows on this computer, check Windows Settings → System → Notifications for this browser, and that Focus assist / Do not disturb is off." : ""
          }`
        );
      }
    },
    [api, ui]
  );
  const enable = useCallback(async () => {
    if (asking.current) return ui.err(QUIET_HINT); // the earlier request is still open in the address bar
    setBusy(true);
    try {
      asking.current = true;
      // must follow a tap or click; a hidden prompt frees the button and shows where to find it
      const p = await askPermission(() => {
        setQuiet(true);
        setBusy(false);
      });
      asking.current = false;
      setQuiet(false);
      setBusy(true);
      setPerm(p);
      if (p !== "granted") {
        if (p === "denied") ui.err("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.");
        else ui.err("Notifications were not allowed. Tap Turn on notifications again and choose Allow.");
        return;
      }
      await sendTest("Notifications are on. A test notification is on its way.");
    } catch (e) {
      ui.err((e && e.message) || "Notifications could not be turned on.");
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }, [ui, sendTest]);
  const notNow = useCallback(() => {
    try {
      sessionStorage.setItem(PUSH_LATER_KEY, "1");
    } catch (e) {
      /* asked again next time */
    }
    setLater(true);
  }, []);
  const iosNeedsInstall = IS_IOS && !STANDALONE && !PUSH_SUPPORTED && api.mode === "live" && !!CONFIG.vapidPublicKey;
  const show = ready && !later && (offered ? perm === "default" || perm === "denied" : iosNeedsInstall);
  // "Test notifications" in the side panel: checks this device end to end (asks first if it was never allowed)
  const test = useCallback(async () => {
    if (Notification.permission !== "granted") return enable();
    setBusy(true);
    try {
      await sendTest("A test notification is on its way to this device.");
    } catch (e) {
      ui.err((e && e.message) || "The test notification could not be sent.");
    } finally {
      setBusy(false);
    }
  }, [enable, sendTest, ui]);
  return { show, perm, busy, quiet, offered, enable, test, notNow, iosNeedsInstall, approver };
}
/** Demo only: shows a sample notification on this device (there is no server in the demo to send a real one). */
async function demoNotification(ui) {
  if (!("Notification" in window)) return ui.err("This browser does not support notifications.");
  const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (p !== "granted") return ui.err("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.");
  // no page address: tapping it only brings the demo back to the front (opening a page would restart the demo)
  const opts = { body: "REQ-2026-0007 from Mae, \u20B178,000.00 (demo sample)", icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", tag: "oe-demo" };
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (reg) await reg.showNotification("Request for approval", opts);
  else new Notification("Request for approval", opts);
  ui.ok("A sample notification was shown on this device. On the live system, approvers get these when a request is filed.");
}
function PushCard({ push }) {
  if (!push.show) return null;
  let title, text, action = null;
  if (push.iosNeedsInstall) {
    title = push.approver ? "Get notified when a request needs your approval" : "Get notified when your requests are approved";
    text = "On iPhone and iPad, notifications work in the installed app: tap Share, then Add to Home Screen, then turn them on there.";
  } else if (push.perm === "denied") {
    title = "Notifications are blocked for this site";
    text = "Allow them in your browser's site settings (the icon left of the address), then reload this page.";
  } else {
    title = push.approver ? "Turn on notifications so you know when a request needs your approval" : "Turn on notifications to hear when your requests are approved or rejected";
    text = push.quiet
      ? `${QUIET_HINT} It carries on by itself once you do.`
      : `This device is told even when the app is closed, as long as it has internet.${push.approver ? " Approvers need this on." : ""}`;
    action = (
      <Button size="sm" variant="primary" busy={push.busy} onClick={push.enable}>
        Turn on notifications
      </Button>
    );
  }
  return (
    <div className="oe-push" role="region" aria-label="Notifications">
      <Icon name="bell" size={18} />
      <div>
        <b>{title}</b>
        <p>{text}</p>
      </div>
      <div className="oe-actions">
        <Button size="sm" onClick={push.notNow}>
          Not now
        </Button>
        {action}
      </div>
    </div>
  );
}

const pageFromPath = (path) => {
  const clean = (path || "").replace(/\/+$/, "").toLowerCase();
  return (NAV.find((n) => n.path === clean) || {}).id || null;
};
const pathOfPage = (id) => (NAV.find((n) => n.id === id) || {}).path || null;

function Root() {
  const ui = useUI();
  // Live (Supabase) whenever keys are configured; the demo stays reachable from the sign-in page.
  const [mode, setMode] = useState(LIVE ? "live" : "demo");
  const api = useMemo(() => (mode === "live" ? createSupabaseApi() : createDemoApi()), [mode]);
  const [auth, setAuth] = useState({ status: "loading" });
  const [profile, setProfile] = useState(null);
  const [data, setData] = useState(null);
  // a module's address opened directly (e.g. a bookmark) is remembered while signing in, then opened
  const [page, setPage] = useState(() => pageFromPath(INITIAL_PATH));
  const [params, setParams] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
    } catch (e) {
      return false;
    }
  });
  const toggleNav = useCallback(() => {
    setNavCollapsed((v) => {
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, v ? "0" : "1");
      } catch (e) {
        /* storage blocked: the choice lasts until reload */
      }
      return !v;
    });
  }, []);
  // 768 to 960px (tablets): the side panel is always the icon strip; the collapse choice applies from 961px up
  const tabletNarrow = useMediaQuery(TABLET_QUERY);
  const desktop = useMediaQuery("(min-width:961px)");
  const collapsed = navCollapsed || tabletNarrow;
  const [canInstall, setCanInstall] = useState(() => !!installPrompt);
  const [iosHint, setIosHint] = useState(() => {
    try {
      return IS_IOS && !STANDALONE && localStorage.getItem(IOS_HINT_KEY) !== "1";
    } catch (e) {
      return false;
    }
  });
  useEffect(() => {
    const ready = () => setCanInstall(true);
    const done = () => {
      installPrompt = null;
      setCanInstall(false);
    };
    window.addEventListener("oe-install-ready", ready);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("oe-install-ready", ready);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  const install = useCallback(async () => {
    const p = installPrompt;
    if (!p) return;
    p.prompt();
    try {
      await p.userChoice;
    } catch (e) {
      /* dismissed */
    }
    installPrompt = null;
    setCanInstall(false);
  }, []);
  const dismissIosHint = useCallback(() => {
    try {
      localStorage.setItem(IOS_HINT_KEY, "1");
    } catch (e) {
      /* storage blocked: the hint comes back next time */
    }
    setIosHint(false);
  }, []);
  const [popTick, setPopTick] = useState(0); // bumped on browser back/forward so the address is re-checked
  const addressMode = useRef("replace"); // "push" when the next address change is a module the person chose
  const [loginNotice, setLoginNotice] = useState(takeSignInNotice); // shown on the sign-in page after an invite's password is set
  // "Try the demo" on the live sign-in page: VITE_DEMO_ENABLED=false turns it off for the deployment;
  // otherwise administrators switch it in Settings → System. Hidden until the setting is known.
  const [demoOn, setDemoOn] = useState(LIVE ? null : DEMO_ENABLED);
  const demoRef = useRef(demoOn);
  demoRef.current = demoOn;
  const demoOffered = DEMO_ENABLED && demoOn === true;
  const switchMode = useCallback((m) => {
    if (m === "live" && !LIVE) return;
    if (m === "demo" && (!DEMO_ENABLED || (LIVE && demoRef.current !== true))) return;
    setPage(null);
    setParams(null);
    setAuth({ status: "loading" });
    setMode(m);
  }, []);

  const reload = useCallback(async () => {
    const d = await api.loadAll();
    setData(d);
    return d;
  }, [api]);

  const enter = useCallback(async () => {
    setLoginNotice(null);
    const prof = await api.getProfile();
    setProfile(prof);
    if (prof && prof.invited_at && !prof.accepted_at) {
      setAuth({ status: "set_password" });
      return;
    }
    if (!prof || !prof.is_active) {
      setAuth({ status: "inactive" });
      return;
    }
    await reload();
    setAuth({ status: "ready" });
  }, [api, reload]);

  const signOut = useCallback(
    async (message) => {
      // Signing out on purpose stops this device's notifications (a shared computer must not keep showing them).
      // The idle timeout passes a message and keeps them: working in another tab or browser for 30 minutes must
      // not switch notifications off; the notification then opens the sign-in page and, after it, the right page.
      if (typeof message !== "string" && api.mode === "live" && PUSH_SUPPORTED) await pushForget(api);
      if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
      try {
        await api.signOut();
      } finally {
        setData(null);
        setProfile(null);
        setPage(null);
        setParams(null); // otherwise the next sign-in on this tab inherits e.g. an "edit request" target
        setAuth({ status: "signed_out" });
        // Leaving the demo takes you back to the live sign-in form.
        if (api.mode === "demo" && LIVE) setMode("live");
        if (typeof message === "string") ui.ok(message);
      }
    },
    [api, ui]
  );

  // The invited person has confirmed a password: end the invite session and ask them to sign in with it.
  const passwordSet = useCallback(
    async (email) => {
      const notice = {
        tone: "info",
        user: email || "",
        text: RESET_FLOW ? "Your password is changed. Sign in with your email and your new password." : "Your password is saved. Sign in with your email and the password you just set.",
      };
      if (INVITE_TAB) {
        // end the in-memory invite session, then reload as the normal sign-in page (the administrator's session, if any, is untouched)
        try {
          await api.signOut();
        } catch (e) {
          /* the session is memory-only; the reload discards it anyway */
        }
        handoffToSignIn(notice);
        return;
      }
      setLoginNotice(notice);
      await signOut();
    },
    [api, signOut]
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const user = await api.init();
        if (!alive) return;
        if (LINK_ERROR && window.history && window.history.replaceState) window.history.replaceState(null, "", window.location.pathname + window.location.search);
        if (!user) {
          let notice = null;
          if (LINK_ERROR && RESET_FLOW)
            notice = { tone: "warn", text: /expired/i.test(LINK_ERROR) ? "That reset link was already used or has expired. Use Forgot password? to get a new one." : "That reset link could not be used. Use Forgot password? to get a new one." };
          else if (LINK_ERROR)
            notice = { tone: "warn", text: /expired/i.test(LINK_ERROR) ? "That link was already used or has expired. Ask your administrator to send a new invite." : "That link could not be used. Ask your administrator to send a new invite." };
          else if (INITIAL_PATH === INVITE_PATH)
            notice = { tone: "info", text: "To set your password, open the link in your invitation email. Already set it? Sign in below." };
          else if (INITIAL_PATH === RESET_PATH)
            notice = { tone: "info", text: "To choose a new password, open the link in the reset email. Need a new link? Use Forgot password? below." };
          // the invite tab never shows the sign-in form itself: its session would not survive a reload
          if (INVITE_TAB) return handoffToSignIn(notice);
          if (notice) setLoginNotice(notice);
          return setAuth({ status: "signed_out" });
        }
        if (NEEDS_PASSWORD) return setAuth({ status: "set_password" });
        await enter();
      } catch (e) {
        if (alive) setAuth({ status: "error", message: e.message });
      }
    })();
    const off = api.onAuthChange((event) => {
      if (event === "SIGNED_OUT") {
        setData(null);
        setProfile(null);
        setAuth({ status: "signed_out" });
      }
      if (event === "PASSWORD_RECOVERY") setAuth({ status: "set_password" });
    });
    return () => {
      alive = false;
      off();
    };
  }, [api, enter]);

  // live refresh when other users change requests
  useEffect(() => {
    if (auth.status !== "ready" || api.mode !== "live") return undefined;
    return api.subscribe(() => reload().catch(() => {}));
  }, [auth.status, api, reload]);

  // sign out after inactivity
  const idleMinutes = data ? Number(data.settings.idle_minutes) || 0 : 0;
  useEffect(() => {
    if (auth.status !== "ready" || !idleMinutes) return undefined;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const evs = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last > idleMinutes * 60000) signOut(`Signed out after ${idleMinutes} minutes without activity.`);
    }, 15000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(t);
    };
  }, [auth.status, idleMinutes, signOut]);

  const me = (data && profile && data.profiles.find((p) => p.id === profile.id)) || profile;
  const roleRow = data && me ? data.roles.find((r) => r.role === me.role) : null;
  const permSet = useMemo(() => new Set(me && me.role === "admin" ? ALL_PERMS : (roleRow && roleRow.permissions) || []), [me && me.role, roleRow]); // eslint-disable-line react-hooks/exhaustive-deps
  const can = useCallback((p) => permSet.has(p), [permSet]);
  const idx = useMemo(() => (data ? buildIndex(data) : null), [data]);

  const run = useCallback(
    async (fn, okMsg) => {
      try {
        const out = await fn();
        await reload();
        if (okMsg) ui.ok(typeof okMsg === "function" ? okMsg(out) : okMsg);
        return out === undefined || out === null ? true : out;
      } catch (e) {
        ui.err((e && e.message) || String(e));
        return false;
      }
    },
    [reload, ui]
  );
  const leaveGuard = useRef(null);
  const setLeaveGuard = useCallback((g) => {
    leaveGuard.current = g;
    activeLeaveGuard = g;
  }, []);
  const confirmLeave = useCallback(async () => {
    const g = leaveGuard.current;
    if (!g) return true;
    const a = await ui.confirm({ title: g.title, body: g.body, confirmLabel: "Discard", cancelLabel: "Keep editing", tone: "danger", focusCancel: true, width: 420 });
    if (a === null) return false;
    leaveGuard.current = null;
    activeLeaveGuard = null;
    return true;
  }, [ui]);
  const go = useCallback((p, prm = null) => {
    addressMode.current = "push";
    setPage(p);
    setParams(prm);
    setNavOpen(false);
  }, []);

  const visible = NAV.filter((n) => n.perms.some(can));
  const current = visible.find((n) => n.id === page) ? page : visible[0] && visible[0].id;

  const badges = useMemo(() => {
    if (!data || !me) return {};
    let approvals = 0;
    let requests = 0;
    for (const r of data.requests) {
      const mine = nextStep(r, me, can, idx).mine;
      // Approvals badge: requests you can approve. Request list badge: everything waiting on you, approvals included.
      if (r.status === "on_hold" && mine) approvals++;
      if (mine) requests++;
    }
    return { approvals, requests };
  }, [data, me, can, idx]);

  const push = usePush(api, auth.status === "ready", can("requests.approve"));
  // "Needs my action" count on the tab title and the installed app's icon
  const actionCount = auth.status === "ready" ? badges.requests || 0 : 0;
  useEffect(() => {
    if (navigator.setAppBadge) (actionCount ? navigator.setAppBadge(actionCount) : navigator.clearAppBadge()).catch(() => {});
  }, [actionCount]);

  const ctx = useMemo(
    () => (data && me ? { api, data, idx, me, can, settings: data.settings, run, go, reload, ui, setLeaveGuard, confirmLeave } : null),
    [api, data, idx, me, can, run, go, reload, ui, setLeaveGuard, confirmLeave]
  );

  // address bar: /sign-in, /invite/set-password, or the open module's path (see NAV).
  // Choosing a module adds a history entry; every other correction (after sign-in, sign-out, an unknown or
  // unpermitted address) replaces the current one, so Back never returns to the sign-in page.
  useEffect(() => {
    if (!(window.history && window.history.replaceState) || auth.status === "loading") return;
    const how = addressMode.current;
    addressMode.current = "replace";
    const want = auth.status === "set_password" ? (RESET_FLOW ? RESET_PATH : INVITE_PATH) : auth.status === "signed_out" ? SIGNIN_PATH : auth.status === "ready" ? pathOfPage(current) : null;
    if (!want || window.location.pathname === want) return;
    window.history[how === "push" ? "pushState" : "replaceState"](null, "", want + window.location.search);
  }, [auth.status, current, popTick]);

  // browser back/forward: open the module at the new address (asking first if there are unsaved changes)
  useEffect(() => {
    const onPop = async () => {
      const target = pageFromPath(window.location.pathname);
      if (auth.status === "ready" && target && target !== current && (await confirmLeave())) {
        setPage(target);
        setParams(null);
        setNavOpen(false);
      }
      setPopTick((t) => t + 1); // declined, signed out, or an address with no module: the effect above corrects it
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [auth.status, current, confirmLeave]);

  useEffect(() => {
    if (!LIVE || !DEMO_ENABLED || auth.status !== "signed_out" || api.mode !== "live") return undefined;
    let alive = true;
    api
      .getPublicSettings()
      .then((p) => alive && setDemoOn(!(p && p.demo_enabled === false)))
      .catch(() => alive && setDemoOn(true)); // database not updated yet, or offline: behave as before
    return () => {
      alive = false;
    };
  }, [auth.status, api]);

  // the browser tab stays neutral until someone is signed in
  const tabTitle = auth.status === "ready" ? `${actionCount ? `(${actionCount}) ` : ""}Project Expense Monitoring` : auth.status === "set_password" ? (RESET_FLOW ? "Choose a new password" : "Set your password") : "Sign in";
  useEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);

  if (auth.status === "loading")
    return (
      <div className="oe-center">
        <p className="muted">Loading…</p>
      </div>
    );
  if (auth.status === "error")
    return (
      <div className="oe-center">
        <div className="oe-stack" style={{ maxWidth: 440 }}>
          <h2>{typeof navigator !== "undefined" && navigator.onLine === false ? "You're offline" : "Can't reach the server"}</h2>
          <p className="muted">{typeof navigator !== "undefined" && navigator.onLine === false ? "Connect to the internet, then try again. Nothing is stored on this device." : auth.message}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  if (auth.status === "signed_out") return <Login key={loginNotice ? "after-invite" : "plain"} api={api} onDone={enter} onSwitchMode={LIVE ? switchMode : null} demoOffered={demoOffered} notice={loginNotice} />;
  if (auth.status === "set_password") return <SetPassword api={api} onDone={passwordSet} mode={RESET_FLOW ? "reset" : "invite"} />;
  if (auth.status === "inactive")
    return (
      <div className="oe-center">
        <div className="oe-stack" style={{ maxWidth: 460, alignItems: "center" }}>
          <Icon name="lock" size={28} />
          <h2>Your account is waiting for access</h2>
          <p className="muted">An administrator needs to assign your role in Settings, Users. Sign out and try again once they have.</p>
          <Button onClick={() => signOut()}>Sign out</Button>
        </div>
      </div>
    );
  if (!ctx) return null;

  if (!visible.length)
    return (
      <div className="oe-center">
        <div className="oe-stack" style={{ maxWidth: 460, alignItems: "center" }}>
          <h2>No sections are open to your role</h2>
          <p className="muted">Ask an administrator to update access rights for {roleRow ? roleRow.label : me.role}.</p>
          <Button onClick={() => signOut()}>Sign out</Button>
        </div>
      </div>
    );

  const PageComp = { report: ReportPage, analysis: AnalysisPage, projects: ProjectsPage, new: NewRequestPage, approvals: ApprovalsPage, requests: RequestsPage, settings: SettingsPage }[current];
  const currentLabel = (visible.find((n) => n.id === current) || {}).label;

  return (
    <AppCtx.Provider value={ctx}>
      <div className={`oe-shell ${collapsed ? "collapsed" : ""}`}>
        {navOpen && <div className="oe-scrim" onClick={() => setNavOpen(false)} />}
        <aside className={`oe-side ${navOpen ? "open" : ""}`}>
          <button className="oe-side-x" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <Icon name="x" />
          </button>
          <div className="oe-brand">
            <b className="full">Project Expense Monitoring</b>
            <b className="short" aria-hidden="true">PEM</b>
          </div>
          <nav className="oe-nav" aria-label="Main">
            {visible.map((n) => (
              <button
                key={n.id}
                aria-current={current === n.id ? "page" : undefined}
                title={collapsed ? (badges[n.id] > 0 ? `${n.label} (${badges[n.id]})` : n.label) : undefined}
                onClick={async () => (n.id === current && !params ? setNavOpen(false) : (await confirmLeave()) && go(n.id))}
              >
                <Icon name={n.icon} />
                <span className="lbl">{n.label}</span>
                {badges[n.id] > 0 && <span className="badge">{badges[n.id]}</span>}
              </button>
            ))}
          </nav>
          <div className="oe-me">
            <b>{me.full_name || me.email}</b>
            <small>{roleRow ? roleRow.label : me.role}</small>
            <div className="oe-me-row">
              <button onClick={async () => (await confirmLeave()) && signOut()} title={collapsed ? "Sign out" : undefined} aria-label="Sign out">
                <Icon name="logout" size={14} /> <span className="lbl">Sign out</span>
              </button>
              {api.mode === "demo" && typeof window !== "undefined" && "Notification" in window && (
                <button onClick={() => demoNotification(ui).catch((e) => ui.err((e && e.message) || "The sample notification could not be shown."))} title={collapsed ? "Test notifications" : undefined} aria-label="Test notifications">
                  <Icon name="bell" size={14} /> <span className="lbl">Test notifications</span>
                </button>
              )}
              {push.offered && (
                <button onClick={push.test} disabled={push.busy} title={collapsed ? "Test notifications" : undefined} aria-label="Test notifications">
                  <Icon name="bell" size={14} /> <span className="lbl">{push.busy ? "Testing…" : "Test notifications"}</span>
                </button>
              )}
              {/* phones and tablets only: desktop browsers already offer install in the address bar */}
              {canInstall && !desktop && (
                <button onClick={install} title={collapsed ? "Install app" : undefined} aria-label="Install app">
                  <Icon name="download" size={14} /> <span className="lbl">Install app</span>
                </button>
              )}
            </div>
            {iosHint && (
              <div className="oe-install">
                <p>To add this to your Home Screen: tap Share, then Add to Home Screen.</p>
                <button onClick={dismissIosHint}>Got it</button>
              </div>
            )}
            <div className="oe-conf" title={collapsed ? "Confidential. Authorized users only." : undefined}>
              <Icon name="lock" size={13} /> <span className="lbl">Confidential. Authorized users only.</span>
            </div>
          </div>
          {!tabletNarrow && (
            <button className="oe-side-toggle" onClick={toggleNav} aria-expanded={!navCollapsed} aria-label={navCollapsed ? "Expand side panel" : "Collapse side panel"} title={navCollapsed ? "Expand" : undefined}>
              <Icon name={navCollapsed ? "expand" : "collapse"} size={16} />
              <span className="lbl">Collapse</span>
            </button>
          )}
        </aside>
        <main className="oe-main">
          <div className="oe-topbar">
            <button onClick={() => setNavOpen(true)} aria-label="Open menu">
              <Icon name="menu" />
            </button>
            <b style={{ fontWeight: 500 }}>{currentLabel}</b>
          </div>
          {api.mode === "demo" && <div className="oe-demo">Demo mode with sample data. Changes reset when you reload. Signed in as {me.full_name}.</div>}
          <PushCard push={push} />
          <PageComp key={current + JSON.stringify(params || {})} params={params} />
        </main>
      </div>
    </AppCtx.Provider>
  );
}

/* Installed-app updates. main.jsx raises oe-sw-update when a new build has downloaded and is waiting.
   - Just opened (first 15 seconds), nothing typed, no dialog open: switch to it straight away; the person sees
     one quick reload at launch instead of a question.
   - Otherwise: a banner with Update and Later. Update asks first if the page has unsaved changes. Later hides it
     until the app comes back to the screen; the next launch updates by itself.
   Updating is a normal reload served from the new files; the person stays signed in. */
const APP_BUILD = typeof __APP_BUILD__ !== "undefined" ? __APP_BUILD__ : { commit: "", time: "" };
function UpdateBanner() {
  const ui = useUI();
  const [apply, setApply] = useState(() => (typeof window !== "undefined" && window.__oeSwUpdate) || null);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = (e) => {
      setApply(() => e.detail);
      setLater(false);
    };
    const back = () => document.visibilityState === "visible" && setLater(false);
    window.addEventListener("oe-sw-update", on);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("oe-sw-update", on);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
  const go = useCallback(() => {
    if (!apply) return;
    window.__oeUpdating = true;
    setBusy(true);
    Promise.resolve(apply()).catch(() => {
      window.__oeUpdating = false;
      setBusy(false);
      ui.err("The update could not be applied. Close the app and open it again.");
    });
  }, [apply, ui]);
  useEffect(() => {
    if (!apply) return;
    const justOpened = typeof performance !== "undefined" && performance.now() < 15000;
    const typed = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), textarea")].some((e) => e.value && !e.readOnly);
    if (justOpened && !activeLeaveGuard && !typed && !document.querySelector("[role=dialog]")) go();
  }, [apply, go]);
  const update = async () => {
    if (activeLeaveGuard) {
      const a = await ui.confirm({
        title: "Update now?",
        body: `${activeLeaveGuard.body} Updating reloads the app, so finish or save first if you want to keep it.`,
        confirmLabel: "Update anyway",
        cancelLabel: "Not yet",
        tone: "danger",
        focusCancel: true,
        width: 440,
      });
      if (a === null) return;
    }
    go();
  };
  if (!apply || later) return null;
  return (
    <div className="oe-update" role="status" aria-live="polite">
      <Icon name="download" size={18} />
      <div className="oe-update-t">
        <b>A new version is ready</b>
        <span>Takes a second. You stay signed in.</span>
      </div>
      <button type="button" className="later" onClick={() => setLater(true)} disabled={busy}>
        Later
      </button>
      <button type="button" onClick={update} disabled={busy}>
        {busy ? "Updating…" : "Update"}
      </button>
    </div>
  );
}

export default function App() {
  return (
    <div className="oe">
      <style>{CSS}</style>
      <UIProvider>
        <Root />
        <UpdateBanner />
      </UIProvider>
    </div>
  );
}
