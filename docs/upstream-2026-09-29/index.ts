// Supabase Edge Function: oe-invite-user
// Lets an administrator (or a role given "Users, access rights and system settings") invite a new
// user by email from the Settings → Users tab. It runs with the service key, which bypasses the
// database's row rules, so it repeats their checks here: only an administrator may invite an
// administrator, and an email that already has an account is refused (roles of existing users are
// changed in the Users list, where the database guards apply, e.g. nobody changes their own role).
// Deploy:  supabase functions deploy oe-invite-user
// The service role key stays on the server; the browser never sees it.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. The caller must be signed in and hold the settings.users permission.
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: allowed, error: permError } = await caller.rpc("oe_has_perm", { p: "settings.users" });
    if (permError || allowed !== true) return json({ error: "You are not allowed to invite users." }, 403);

    // 2. Validate input.
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const fullName = String(body.full_name ?? "").trim();
    const role = String(body.role ?? "").trim();
    const redirectTo = body.redirect_to ? String(body.redirect_to) : undefined;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: roleRow } = await admin.from("oe_role_permissions").select("role").eq("role", role).maybeSingle();
    if (!roleRow) return json({ error: `Unknown role "${role}".` }, 400);

    // Only an administrator may hand out the administrator role.
    if (role === "admin") {
      const { data: isAdmin, error: adminError } = await caller.rpc("oe_is_admin");
      if (adminError || isAdmin !== true) return json({ error: "Only an administrator can invite an administrator." }, 403);
    }

    // Never overwrite an existing account (including the caller's own) through an invite.
    const { data: existing, error: existingError } = await admin.from("oe_profiles").select("id").ilike("email", email).maybeSingle();
    if (existingError) return json({ error: existingError.message }, 400);
    if (existing) return json({ error: "That email already has an account. Change its role or access in the Users list instead." }, 409);

    // 3. Send the invite and activate the profile with the chosen role.
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo,
    });
    if (error) return json({ error: error.message }, 400);

    const { error: upsertError } = await admin.from("oe_profiles").upsert({ // a brand-new account (checked above)
      id: data.user.id,
      email,
      full_name: fullName || email.split("@")[0],
      role,
      is_active: true,
    });
    if (upsertError) return json({ error: upsertError.message }, 400);

    return json({ ok: true, id: data.user.id });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
