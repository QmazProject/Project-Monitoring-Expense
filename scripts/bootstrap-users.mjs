#!/usr/bin/env node
/* Creates the first sign-ins through the official Supabase Auth admin API and assigns
   their roles. An alternative to supabase/bootstrap_accounts.sql for people who prefer
   the terminal over the SQL Editor.

   Usage:
     1. Put SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).
     2. Copy scripts/bootstrap-users.example.json to scripts/bootstrap-users.json and edit it.
     3. npm run bootstrap:users

   The service_role key never leaves your machine; it is not part of the app. */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function loadEnv() {
  for (const name of [".env", ".env.local"]) {
    const p = resolve(root, name);
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.");
  process.exit(1);
}

const listPath = resolve(here, "bootstrap-users.json");
if (!existsSync(listPath)) {
  console.error("Copy scripts/bootstrap-users.example.json to scripts/bootstrap-users.json and fill it in.");
  process.exit(1);
}
const users = JSON.parse(readFileSync(listPath, "utf8"));

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: roles, error: rolesErr } = await admin.from("oe_role_permissions").select("role, label");
if (rolesErr) {
  console.error("Could not read roles. Did you run `supabase db push`?", rolesErr.message);
  process.exit(1);
}
const roleSet = new Set(roles.map((r) => r.role));

let failed = 0;
for (const u of users) {
  const email = String(u.email || "").trim().toLowerCase();
  const label = `${email} (${u.role})`;
  if (!email || !u.password || !u.role) {
    console.error(`skip  ${label}: email, password and role are required`);
    failed++;
    continue;
  }
  if (!roleSet.has(u.role)) {
    console.error(`skip  ${label}: unknown role. Roles: ${[...roleSet].join(", ")}`);
    failed++;
    continue;
  }
  if (String(u.password).length < 8) {
    console.error(`skip  ${label}: password must be at least 8 characters`);
    failed++;
    continue;
  }

  let id = null;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: u.password,
    email_confirm: true,
    user_metadata: { full_name: u.full_name || "" },
  });
  if (createErr) {
    if (/already/i.test(createErr.message)) {
      const { data: prof } = await admin.from("oe_profiles").select("id").ilike("email", email).maybeSingle();
      id = prof?.id || null;
      console.log(`exists ${label}: password left unchanged`);
    } else {
      console.error(`fail  ${label}: ${createErr.message}`);
      failed++;
      continue;
    }
  } else {
    id = created.user.id;
    console.log(`made  ${label}`);
  }
  if (!id) {
    console.error(`fail  ${label}: could not find its profile`);
    failed++;
    continue;
  }
  const { error: profErr } = await admin
    .from("oe_profiles")
    .upsert({ id, email, full_name: u.full_name || email.split("@")[0], role: u.role, is_active: true });
  if (profErr) {
    console.error(`fail  ${label}: role not saved: ${profErr.message}`);
    failed++;
  }
}

console.log(failed ? `\nDone with ${failed} problem(s).` : "\nDone. These accounts can sign in on the live form now.");
process.exit(failed ? 1 : 0);
