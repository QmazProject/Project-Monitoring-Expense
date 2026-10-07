/* oe-invite-user: invites a new person by email and assigns their role.
   Called from Settings → Users in the app (api.inviteUser). Only a signed-in user whose role
   has the "settings.users" permission may call it; the check runs in the database (oe_has_perm)
   with the caller's own token, so it follows whatever Access rights say.

   Deploy:  supabase functions deploy oe-invite-user
   Secrets: uses the project's built-in SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. */
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in first." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Function is not configured." }, 500);

  // 1. Who is calling, and may they manage users? (evaluated as the caller, under RLS)
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Your session has ended. Sign in again." }, 401);

  const { data: allowed, error: permErr } = await asCaller.rpc("oe_has_perm", { p: "settings.users" });
  if (permErr || allowed !== true) return json({ error: "Your role can't invite users." }, 403);

  // 2. Validate the request body
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const email = String(body?.email ?? "").trim().toLowerCase();
  const fullName = String(body?.full_name ?? "").trim().slice(0, 120);
  const role = String(body?.role ?? "").trim();
  const redirectTo = typeof body?.redirect_to === "string" ? body.redirect_to : undefined;

  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);
  if (!fullName) return json({ error: "Enter the person's name." }, 400);
  if (!role) return json({ error: "Choose a role." }, 400);
  if (redirectTo && !/^https?:\/\//.test(redirectTo)) return json({ error: "Invalid redirect address." }, 400);

  // 3. Do the privileged work with the service role
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: roleRow, error: roleErr } = await admin.from("oe_role_permissions").select("role, label").eq("role", role).maybeSingle();
  if (roleErr) return json({ error: roleErr.message }, 500);
  if (!roleRow) return json({ error: "That role doesn't exist." }, 400);

  // Only an administrator may hand out the administrator role (the database applies the same rule to role changes).
  if (role === "admin") {
    const { data: isAdmin, error: adminErr } = await asCaller.rpc("oe_is_admin");
    if (adminErr || isAdmin !== true) return json({ error: "Only an administrator can invite an administrator." }, 403);
  }

  // A non-administrator may not hand out a role that itself manages users (the database applies the same rule).
  if (!(await asCaller.rpc("oe_is_admin")).data) {
    const { data: perms } = await admin.from("oe_role_permissions").select("permissions").eq("role", role).maybeSingle();
    if (Array.isArray(perms?.permissions) && perms.permissions.includes("settings.users"))
      return json({ error: "Only an administrator can invite someone into a role that manages users." }, 403);
  }

  // Never overwrite an existing account (including the caller's own) through an invite.
  const pattern = email.replace(/[\\%_]/g, (ch) => "\\" + ch); // literal match: % and _ are wildcards in ilike
  // a deleted user's profile row may remain (it keeps their name on old records); that email may be invited again
  const { data: existing, error: existingErr } = await admin.from("oe_profiles").select("id").ilike("email", pattern).is("deleted_at", null).maybeSingle();
  if (existingErr) return json({ error: existingErr.message }, 500);
  if (existing) return json({ error: "That email already has an account. Change its role or access in the Users list instead." }, 409);

  // full_name / role_label are only used by the invite email and the sign-up trigger; the real role lives in oe_profiles.
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName, role_label: roleRow.label || role },
    redirectTo,
  });
  if (inviteErr || !invited?.user) return json({ error: inviteErr?.message || "The invite couldn't be sent." }, 400);
  // GoTrue re-sends an invite to a sign-in that exists but never accepted; that account keeps its role.
  if (Date.now() - Date.parse(invited.user.created_at) > 60_000)
    return json({ error: "That email already has a pending invite. Its role can be changed in the Users list." }, 409);

  // The auth trigger already created the profile row; set the details the administrator chose.
  const { error: profErr } = await admin
    .from("oe_profiles")
    .upsert({ id: invited.user.id, email, full_name: fullName, role, is_active: true, invited_at: new Date().toISOString(), accepted_at: null });
  if (profErr) return json({ error: `Invited, but the role could not be saved: ${profErr.message}` }, 500);

  return json({ ok: true, id: invited.user.id });
});
