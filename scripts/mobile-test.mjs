// Headless phone walk: opens the built demo in a real Chromium at phone, tablet and desktop sizes and checks the
// mobile layout (stacked tables, 16px fields, finger-sized controls, reachable buttons) and that desktop is unchanged.
// usage: npm run test:mobile          (builds dist-smoke, then runs this)
//        node scripts/mobile-test.mjs dist-smoke
// Needs a Chromium: set OE_CHROME=/path/to/chrome, or install one with `npx playwright install chromium`.
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";

const dist = process.argv[2] || "dist-smoke";
if (!existsSync(join(dist, "index.html"))) {
  console.error(`No build in ${dist}. Run: npm run test:mobile`);
  process.exit(2);
}

function findChrome() {
  if (process.env.OE_CHROME) return existsSync(process.env.OE_CHROME) ? process.env.OE_CHROME : null;
  const cands = [];
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache))
    for (const d of readdirSync(cache))
      cands.push(
        join(cache, d, "chrome-linux64", "chrome"),
        join(cache, d, "chrome-linux", "chrome"),
        join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(cache, d, "chrome-win", "chrome.exe"),
        join(cache, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
      );
  cands.push(
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
  return cands.find((c) => existsSync(c)) || null;
}
const exe = findChrome();
if (!exe) {
  console.error("No Chromium found. Set OE_CHROME=/path/to/chrome or run: npx playwright install chromium");
  process.exit(2);
}

// tiny static server with the same fallback as Vercel: unknown paths serve index.html
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const server = createServer((req, res) => {
  let file = join(dist, normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
let n = 0;
const check = (cond, what) => {
  n++;
  if (cond) console.log("ok   " + what);
  else {
    console.log("FAIL " + what);
    failures.push(what);
  }
};

const browser = await chromium.launch({ executablePath: exe });
const wait = (pg, ms = 450) => pg.waitForTimeout(ms);

// Measurements inside the page. Controls smaller than 40px are a mis-tap risk; a few small things are allowed.
const SMALL_OK = ["input[type=checkbox]", "input[type=radio]", ".oe-pass button", ".oe-file button", ".oe-docx", ".oe-linkbtn", ".oe-bar-btn", ".oe-tabs button", "a"].join(",");
const measure = (pg) =>
  pg.evaluate((smallOk) => {
    const vw = innerWidth;
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden";
    };
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
      return false;
    };
    const dialogs = [...document.querySelectorAll("[role=dialog]")];
    const scope = dialogs.at(-1) || document.querySelector(".oe-main") || document.body;
    const all = [...scope.querySelectorAll("*")].filter(vis);
    const offRight = all.filter((el) => el.getBoundingClientRect().right > vw + 1 && !clipped(el)).length;
    const fields = [...scope.querySelectorAll(".oe-input,.oe-select,.oe-textarea")].filter(vis);
    const smallFont = fields.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).length;
    const controls = [...scope.querySelectorAll("button,input:not([type=hidden]),select,textarea,[role=tab]")].filter(vis).filter((el) => !el.matches(smallOk));
    const smallCtl = controls.filter((el) => el.getBoundingClientRect().height < 40).map((el) => `${(el.getAttribute("aria-label") || el.textContent || el.placeholder || el.tagName).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}px`);
    return { pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw, offRight, smallFont, fields: fields.length, smallCtl };
  }, SMALL_OK);
const fits = async (pg, label) => {
  const m = await measure(pg);
  check(m.pageOverflow <= 0 && m.offRight === 0, `${label}: nothing runs off the right edge`);
  check(m.smallFont === 0, `${label}: every field is 16px or more (${m.fields} fields)`);
  check(m.smallCtl.length === 0, `${label}: every control is at least 40px tall${m.smallCtl.length ? ` (${m.smallCtl.slice(0, 4).join("; ")})` : ""}`);
};
const rect = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, vw: innerWidth, vh: innerHeight };
});
const nav = async (pg, re) => {
  const menu = pg.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) {
    await menu.click();
    await wait(pg, 300);
  }
  await pg.locator(".oe-nav button").filter({ hasText: re }).click();
  await wait(pg);
};

for (const [w, h, name] of [
  [360, 800, "Android 360px"],
  [390, 844, "iPhone 390px"],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
  const pg = await ctx.newPage();
  await pg.goto(base + "/");
  await wait(pg, 800);
  await fits(pg, `${name} sign-in`);
  await pg.getByRole("button", { name: /Patrick/ }).click();
  await wait(pg, 900);

  await fits(pg, `${name} project report`);
  check((await pg.locator(".oe-table.cards td[data-th]").count()) > 0, `${name} project report: table shows as stacked cards`);
  check((await pg.locator(".oe-fold summary").count()) === 1, `${name} project report: filters fold behind a Filters bar`);

  await nav(pg, /Approvals/);
  await fits(pg, `${name} approvals queue`);
  check((await pg.locator('input[aria-label^="Approve amount"]').count()) === 0, `${name} approvals: the queue shows alone until a request is tapped`);
  await pg.locator(".oe-qitem").first().click();
  await wait(pg);
  check((await pg.locator("[role=dialog] .oe-approve-bar").count()) === 1, `${name} approvals: a tap opens the request in a full-screen drawer`);
  await fits(pg, `${name} approvals drawer`);
  const amounts = pg.locator('input[aria-label^="Approve amount"]');
  const na = await amounts.count();
  let inView = 0;
  for (let i = 0; i < na; i++) {
    const r = await rect(amounts.nth(i));
    if (r.left >= 0 && r.right <= r.vw) inView++;
  }
  check(na > 0 && inView === na, `${name} approvals: all ${na} approve-amount fields fit on screen`);
  const ab = await rect(pg.locator(".oe-approve-bar button").last());
  check(ab.bottom <= ab.vh + 1 && ab.top >= 0, `${name} approvals: Approve button in reach without scrolling`);
  await pg.keyboard.press("Escape");
  await wait(pg, 400);
  check((await pg.locator("[role=dialog]").count()) === 0, `${name} approvals: the drawer closes and the queue is back`);

  await nav(pg, /Request list/);
  await fits(pg, `${name} request list`);
  check((await pg.locator(".oe-table.cards").count()) === 1, `${name} request list: stacked cards`);
  check((await pg.locator(".oe-kpi-more").count()) === 1, `${name} request list: status cards fold`);
  await pg.locator("tr.click").first().click();
  await wait(pg);
  const cr = await rect(pg.locator("[role=dialog] button[aria-label=Close]").last());
  check(cr.top < 80 && cr.right <= cr.vw && cr.right > cr.vw - 70, `${name} request drawer: close button at the top right`);
  await fits(pg, `${name} request drawer`);
  await pg.keyboard.press("Escape");
  await wait(pg, 400);

  await nav(pg, /New request/);
  await fits(pg, `${name} new request`);
  check((await pg.locator(".oe-lf-t:visible").count()) >= 6, `${name} new request: line fields are labelled`);
  await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(pg, 300);
  const sb = await rect(pg.locator(".oe-total button").last());
  check(sb.bottom <= sb.vh + 1 && sb.top >= 0, `${name} new request: Submit in reach at the bottom`);

  await nav(pg, /Settings/);
  const tabs = pg.locator(".oe-main [role=tab]");
  let tabsIn = 0;
  const nt = await tabs.count();
  for (let i = 0; i < nt; i++) {
    const r = await rect(tabs.nth(i));
    if (r.right <= r.vw + 1) tabsIn++;
  }
  check(nt > 0 && tabsIn === nt, `${name} settings: all ${nt} tabs visible without scrolling`);
  await tabs.filter({ hasText: "Access rights" }).click();
  await wait(pg);
  check((await pg.locator('select[aria-label="Role to edit"]').count()) === 1, `${name} access rights: role picker shown`);
  check((await pg.locator(".oe-matrix thead th").count()) === 2, `${name} access rights: one role at a time`);
  await fits(pg, `${name} access rights`);
  await ctx.close();
}

// tablet: icon side panel, no collapse toggle
{
  const ctx = await browser.newContext({ viewport: { width: 800, height: 1000 } });
  const pg = await ctx.newPage();
  await pg.goto(base + "/");
  await wait(pg, 800);
  await pg.getByRole("button", { name: /Patrick/ }).click();
  await wait(pg, 900);
  check((await pg.locator(".oe-shell.collapsed").count()) === 1, "tablet 800px: side panel is the icon strip");
  check((await pg.locator(".oe-side-toggle").count()) === 0, "tablet 800px: no collapse toggle");
  check((await pg.locator(".oe-fold").count()) === 0, "tablet 800px: filters shown in full");
  await ctx.close();
}

// desktop: unchanged layout
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pg = await ctx.newPage();
  await pg.goto(base + "/");
  await wait(pg, 800);
  await pg.getByRole("button", { name: /Patrick/ }).click();
  await wait(pg, 900);
  check((await pg.locator(".oe-table.cards").first().evaluate((t) => getComputedStyle(t).display)) === "table", "desktop 1280px: tables are tables");
  check((await pg.locator(".oe-fold").count()) === 0 && (await pg.locator(".oe-filters").count()) === 1, "desktop 1280px: filter row shown in full");
  check((await pg.locator(".oe-side-toggle").count()) === 1 && (await pg.locator(".oe-shell.collapsed").count()) === 0, "desktop 1280px: full side panel with collapse toggle");
  const f = await pg.locator(".oe-input").first().evaluate((el) => getComputedStyle(el).fontSize);
  check(f === "14px", `desktop 1280px: field text unchanged (${f})`);
  await nav(pg, /New request/);
  check((await pg.locator(".oe-lf-t:visible").count()) === 0 && (await pg.locator(".oe-total:visible").count()) === 0, "desktop 1280px: new request keeps its grid, no bottom bar");
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\nMOBILE: ${n - failures.length} of ${n} checks passed`);
if (failures.length) {
  console.log("Failed:\n  " + failures.join("\n  "));
  process.exit(1);
}
