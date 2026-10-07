/* oe-delete-user: removes a person's sign-in account so the email can be invited again.
   Called from Settings → Users → Delete (api.deleteUser). The caller is checked here with their own token:
   their role must manage users, nobody deletes themselves, and only an administrator deletes an administrator.
   - no records (never filed, approved or touched anything): the profile row goes too
   - has records: the profile row stays, marked deleted and without access, so their name stays on every request,
     approval, document and history line; the account itself is removed either way

   Deploy:  supabase functions deploy oe-delete-user
   Secrets: the project's built-in SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. */
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in first." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Function is not configured." }, 500);

  // 1. Who is calling, and may they manage users?
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Your session has ended. Sign in again." }, 401);
  const callerId = userData.user.id;
  const { data: allowed, error: permErr } = await asCaller.rpc("oe_has_perm", { p: "settings.users" });
  if (permErr || allowed !== true) return json({ error: "Your role can't manage users." }, 403);

  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const id = String(body?.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Invalid user." }, 400);
  if (id === callerId) return json({ error: "You can't delete your own account. Ask another administrator." }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: target, error: tErr } = await admin.from("oe_profiles").select("id, email, full_name, role, deleted_at").eq("id", id).maybeSingle();
  if (tErr) return json({ error: tErr.message }, 500);
  if (!target) return json({ error: "That user no longer exists." }, 404);
  if (target.deleted_at) return json({ error: "That user was already deleted." }, 409);

  if (target.role === "admin") {
    const { data: isAdmin } = await asCaller.rpc("oe_is_admin");
    if (isAdmin !== true) return json({ error: "Only an administrator can delete an administrator." }, 403);
  }

  // 2. What do they have in the system? (as the caller, so the permission check inside applies)
  const { data: activity, error: aErr } = await asCaller.rpc("oe_user_activity", { p_id: id });
  if (aErr) return json({ error: aErr.message }, 500);
  const a = (activity || {}) as Record<string, number>;
  const hasRecords = ["requests", "approvals", "events", "documents", "returns", "reclass"].some((k) => Number(a[k] || 0) > 0);

  // 3. Remove the sign-in account first (idempotent: an account that is already gone is fine), then the profile
  const { error: delErr } = await admin.auth.admin.deleteUser(id);
  if (delErr && !/not found/i.test(delErr.message || "")) return json({ error: `The account could not be removed: ${delErr.message}` }, 500);
  await admin.from("oe_push_subscriptions").delete().eq("user_id", id);

  const { data: callerProfile } = await admin.from("oe_profiles").select("full_name, email").eq("id", callerId).maybeSingle();
  const byName = (callerProfile?.full_name || callerProfile?.email || "an administrator") as string;
  if (hasRecords) {
    const { error: uErr } = await admin.from("oe_profiles").update({ is_active: false, deleted_at: new Date().toISOString(), deleted_by_name: byName }).eq("id", id);
    if (uErr) return json({ error: `The account is removed, but the profile could not be marked: ${uErr.message}` }, 500);
  } else {
    const { error: dErr } = await admin.from("oe_profiles").delete().eq("id", id);
    if (dErr) return json({ error: `The account is removed, but the profile could not be deleted: ${dErr.message}` }, 500);
  }
  return json({ ok: true, kept: hasRecords, email: target.email });
});
