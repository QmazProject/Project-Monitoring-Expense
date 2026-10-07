/* Which devices a push goes to, and how one device's answer is described. Plain JavaScript so the same file runs
   in the Supabase edge runtime (Deno) and in Node 20 (scripts/push-selftest.mjs checks these rules). */

/** The push services' way of saying "this subscription no longer exists": the row is deleted when they do. */
export const isGone = (status) => status === 404 || status === 410;

/** The last few characters of a push address: enough to tell devices apart in a log, never the whole address
 *  (it is a capability -- anyone holding it can send that device a notification). */
export const endpointTail = (endpoint, n = 10) => (typeof endpoint === "string" && endpoint ? `…${endpoint.slice(-n)}` : "");

/** The devices a send goes to.
 *  subs are already limited to the recipients by the caller, so this never widens who is reached.
 *  - a device test naming an address: only that one row, and only if it is one of the caller's own
 *  - anything else (a real request notification, or an older app build that sends no address): every device
 *    of every recipient, which is what keeps a person told on their PC and their phone at the same time. */
export function targetSubscriptions(subs, endpoint) {
  const all = Array.isArray(subs) ? subs : [];
  if (!endpoint) return all;
  return all.filter((s) => s && s.endpoint === endpoint);
}

/** What the app says about the device that asked for the test: "this device: 201", "this device: 410 --
 *  subscription expired". detail is the one entry from details[] for that device, or null when it had no row. */
export function deviceResult(detail, sub) {
  if (!detail) return { status: "not registered", text: "this device: not registered", service: "", note: "", device_id: null, endpoint_tail: "" };
  const expired = isGone(detail.status);
  return {
    status: detail.status,
    service: detail.service || "",
    note: expired ? "subscription expired" : detail.note || "",
    device_id: (sub && sub.device_id) || null,
    endpoint_tail: endpointTail(sub && sub.endpoint),
    text: `this device: ${detail.status}${expired ? " -- subscription expired" : ""}`,
  };
}
