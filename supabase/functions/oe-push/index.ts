/* oe-push: sends push notifications about a request to the people concerned.
   Called by the app right after a request is filed, re-filed, approved or rejected (api.notify in App.jsx), and
   once with event "test" when someone turns notifications on or taps Test notifications. The caller is checked
   here with their own token:
   - submitted : the request is waiting for approval and the caller filed it (or is an administrator)
                 → everyone whose role may approve requests, except the caller
   - approved / rejected : the caller's role may approve requests and the request is in that state
                 → the person who filed it
   - test      : → the caller's own devices; when the app names its own push address, only that one device, so
                 the answer describes the device the person is holding and not some other device of theirs
   Real notifications always go to every device of every recipient (office PC, laptop, Android, iPhone).
   Every message carries that recipient's own app-icon badge number: how many requests are waiting for them,
   counted from the committed state with the rule the app itself uses (_shared/next-step.js). 0 clears it.
   Subscriptions that the push service reports as gone (404, 410) are deleted.

   Deploy:  supabase functions deploy oe-push
   Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (from `npm run push:keys`), VAPID_SUBJECT (mailto:someone@yourcompany),
            plus the project's built-in SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. */
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.js";
import { deviceResult, endpointTail, isGone, targetSubscriptions } from "../_shared/push-target.js";
import { countNeedsAction, makeCan, visibleToUser } from "../_shared/next-step.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const peso = (n: number) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* The number on each recipient's app icon: how many requests are waiting for THEM, right now.
   Worked out from the committed state with the same rule the app uses (_shared/next-step.js), so the badge a
   notification carries is the number the app shows when it is opened. Never derived by adjusting an earlier
   number -- notify() runs after the change is committed, so one read of the current state is the truth.
   Statuses nobody can act on (rejected, withdrawn) are left out: the rule counts them as nobody's work.
   The same 5000 ceiling as the app's own load, so both sides count the same requests. */
const ACTIONABLE = ["on_hold", "open", "disbursed", "paid", "closed"];
const REQUEST_FIELDS =
  "id, status, liaison_id, erp_ref, lines:oe_request_lines(status, amount, approved_amount, returned_amount, paid_amount, project_id, acct_verified_at, tm_verified_at, reclass:oe_line_reclass(amount))";

// deno-lint-ignore no-explicit-any
async function badgeCounts(admin: any, recipients: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!recipients.length) return out;
  const [people, roles, settingsRow, projects] = await Promise.all([
    admin.from("oe_profiles").select("id, role").in("id", recipients),
    admin.from("oe_role_permissions").select("role, permissions"),
    admin.from("oe_settings").select("data").eq("id", 1).maybeSingle(),
    admin.from("oe_projects").select("id, is_internal"),
  ]);
  // built with explicit loops: Map(array.map(...)) trips over tuple inference, and this file is only
  // type-checked when it is deployed
  const permsByRole = new Map<string, string[]>();
  for (const r of (roles.data || []) as { role: string; permissions: string[] }[]) permsByRole.set(r.role, r.permissions);
  const byProject = new Map<string, { is_internal: boolean }>();
  for (const p of (projects.data || []) as { id: string; is_internal: boolean }[]) byProject.set(p.id, { is_internal: p.is_internal });
  const idx = {
    closePolicy: (settingsRow.data && settingsRow.data.data && settingsRow.data.data.close_policy) || "either",
    projects: byProject,
  };
  const who = (people.data || []) as { id: string; role: string }[];
  const cans = new Map<string, (p: string) => boolean>();
  for (const p of who) cans.set(p.id, makeCan(p.role, permsByRole.get(p.role)));

  // Someone whose role may see or approve every request needs the whole actionable set counted; someone who
  // can only see their own needs just those. Mirrors the oe_requests read policy, so nobody's badge counts
  // work they are not allowed to see.
  const broad = who.some((p) => {
    const can = cans.get(p.id)!;
    return can("requests.view_all") || can("requests.approve");
  });
  let q = admin.from("oe_requests").select(REQUEST_FIELDS).in("status", ACTIONABLE);
  if (!broad) q = q.in("liaison_id", recipients);
  const { data: rows } = await q.order("created_at", { ascending: false }).limit(5000);

  for (const p of who) {
    const can = cans.get(p.id)!;
    const me = { id: p.id, role: p.role };
    out.set(p.id, countNeedsAction(visibleToUser(rows || [], me, can), me, can, idx));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in first." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapid = { publicKey: Deno.env.get("VAPID_PUBLIC_KEY") || "", privateKey: Deno.env.get("VAPID_PRIVATE_KEY") || "", subject: Deno.env.get("VAPID_SUBJECT") || "" };
  if (!url || !anonKey || !serviceKey) return json({ error: "Function is not configured." }, 500);
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) return json({ error: "Push keys are not configured (VAPID_* secrets)." }, 500);

  // 1. Who is calling?
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Your session has ended. Sign in again." }, 401);
  const callerId = userData.user.id;

  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const event = String(body?.event ?? "");
  const requestId = String(body?.request_id ?? "");
  // A device test names the address of the device that asked. Only ever used to narrow the caller's own devices
  // (step 3 reads rows for the recipients), so naming someone else's address cannot reach them.
  const testEndpoint = event === "test" && typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!["submitted", "approved", "rejected", "test"].includes(event)) return json({ error: "Unknown event." }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // 2. Decide who hears about it, and what they are told
  let recipients: string[] = [];
  let payload: Record<string, unknown> = {};

  if (event === "test") {
    recipients = [callerId];
    payload = { title: "Notifications are on", body: "You'll be told here when a request needs your attention.", url: "/requests", tag: "oe-test" };
  } else {
    if (!requestId) return json({ error: "Missing request." }, 400);
    const { data: r, error: rErr } = await admin.from("oe_requests").select("id, ref_no, status, liaison_id, liaison_name").eq("id", requestId).maybeSingle();
    if (rErr) return json({ error: rErr.message }, 500);
    if (!r) return json({ error: "Request not found." }, 404);
    const { data: lines } = await admin.from("oe_request_lines").select("amount, approved_amount").eq("request_id", r.id);
    const requested = (lines || []).reduce((a: number, l: { amount: number }) => a + Number(l.amount || 0), 0);
    const approved = (lines || []).reduce((a: number, l: { approved_amount: number | null }) => a + Number(l.approved_amount || 0), 0);

    if (event === "submitted") {
      if (r.status !== "on_hold") return json({ error: "The request is not waiting for approval." }, 409);
      const { data: isAdmin } = await asCaller.rpc("oe_is_admin");
      if (r.liaison_id !== callerId && isAdmin !== true) return json({ error: "Only the person who filed the request can send this." }, 403);
      const { data: roles } = await admin.from("oe_role_permissions").select("role, permissions");
      const approverRoles = new Set((roles || []).filter((x: { role: string; permissions: string[] }) => x.role === "admin" || (Array.isArray(x.permissions) && x.permissions.includes("requests.approve"))).map((x: { role: string }) => x.role));
      const { data: people } = await admin.from("oe_profiles").select("id, role").eq("is_active", true);
      recipients = (people || []).filter((p: { id: string; role: string }) => approverRoles.has(p.role) && p.id !== callerId).map((p: { id: string }) => p.id);
      // the badge is added per recipient in step 3: their own count, not one number for everybody
      payload = { title: "Request for approval", body: `${r.ref_no} from ${r.liaison_name}, ${peso(requested)}`, url: "/approvals", tag: `oe-req-${r.id}` };
    } else {
      const { data: mayApprove } = await asCaller.rpc("oe_has_perm", { p: "requests.approve" });
      if (mayApprove !== true) return json({ error: "Your role can't send this." }, 403);
      if ((event === "approved" && r.status !== "open") || (event === "rejected" && r.status !== "rejected")) return json({ error: "The request is not in that state." }, 409);
      if (r.liaison_id !== callerId) recipients = [r.liaison_id];
      payload =
        event === "approved"
          ? { title: `${r.ref_no} approved`, body: `Approved for ${peso(approved)}. Next: enter the ERP reference.`, url: "/requests", tag: `oe-req-${r.id}` }
          : { title: `${r.ref_no} rejected`, body: "Open the request to see the reason.", url: "/requests", tag: `oe-req-${r.id}` };
    }
  }
  if (!recipients.length) return json({ event, recipients: 0, sent: 0, failed: 0, removed: 0, details: [] });

  // 3. Send to every device of every recipient -- a person stays told on their office PC, their laptop and their
  //    phone at the same time. A device test names one address and goes only there. Devices the push service no
  //    longer knows (404, 410) are forgotten.
  type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; device_id: string | null };
  const { data: subs, error: sErr } = await admin.from("oe_push_subscriptions").select("id, user_id, endpoint, p256dh, auth, device_id").in("user_id", recipients);
  if (sErr) return json({ error: sErr.message }, 500);
  const targets = targetSubscriptions((subs || []) as Sub[], testEndpoint) as Sub[];

  // Each recipient's own badge number. Best effort: if this cannot be worked out the notification still goes,
  // without a badge, and the app corrects the icon the next time it is opened. A wrong number would be worse
  // than a stale one.
  let badges = new Map<string, number>();
  try {
    badges = await badgeCounts(admin, recipients);
  } catch (e) {
    console.warn("oe-push badge", String(e && (e as Error).message));
  }
  const payloadFor = (userId: string) => {
    const n = badges.get(userId);
    return typeof n === "number" ? { ...payload, badge: n } : payload; // 0 tells the worker to clear it
  };
  let sent = 0, failed = 0;
  const gone: string[] = [];
  // one line per device for the caller's console: which device, the push service and its answer; never the
  // device's full address or its keys
  const results = await Promise.all(
    targets.map(async (s: Sub) => {
      const service = new URL(s.endpoint).host;
      const device = endpointTail(s.endpoint);
      try {
        const res = await sendPush(s, payloadFor(s.user_id), vapid, { ttl: 24 * 3600, urgency: "high" });
        const note = res.ok ? undefined : (await res.text()).slice(0, 160);
        if (res.ok) sent++;
        else if (isGone(res.status)) gone.push(s.id);
        else failed++;
        return { sub: s, detail: { service, status: res.status as number | string, note, device } };
      } catch (e) {
        failed++;
        return { sub: s, detail: { service, status: "error" as number | string, note: String(e && (e as Error).message).slice(0, 160), device } };
      }
    })
  );
  const details = results.map((r) => r.detail);
  if (gone.length) await admin.from("oe_push_subscriptions").delete().in("id", gone);

  if (event === "test") {
    // the answer is about the device the person is holding, not whichever of their devices happened to accept
    const mine = testEndpoint ? results.find((r) => r.sub.endpoint === testEndpoint) : null;
    // best effort: this person's own devices that have not been seen for three months are forgotten here
    let pruned = 0;
    try {
      const { data: n } = await admin.rpc("oe_prune_push_subscriptions", { p_user_id: callerId, p_days: 90 });
      if (typeof n === "number") pruned = n;
    } catch {
      /* the cleanup is housekeeping: never fails the test */
    }
    return json({
      event,
      scope: testEndpoint ? "device" : "all-devices",
      devices: (subs || []).length, // how many devices this person has registered in total
      badge: badges.has(callerId) ? badges.get(callerId) : null, // what the app icon was set to
      recipients: recipients.length,
      sent,
      failed,
      removed: gone.length,
      pruned,
      device: testEndpoint ? deviceResult(mine ? mine.detail : null, mine ? mine.sub : null) : null,
      details,
    });
  }
  return json({ event, recipients: recipients.length, sent, failed, removed: gone.length, details });
});
