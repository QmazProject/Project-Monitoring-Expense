/* This browser's name in oe_push_subscriptions.

   A push address (endpoint) is not a stable identifier: the same browser is given a new one whenever it
   re-subscribes, which used to leave a second row behind and make one PC look like several devices. The device
   is therefore named by an id made once and kept in this browser's own localStorage, so the row for this PC is
   found again however often its address changes.

   Each browser, browser profile and installed app has its own storage, so each gets its own id and its own row:
   a person may stay signed in on an office PC, a laptop, an Android phone and an iPhone at the same time.
   A private window, or storage the person clears, is simply a device that has not been seen before. */

export const DEVICE_ID_KEY = "oe-device-id";
const VALID = /^[A-Za-z0-9-]{8,64}$/; // what we wrote; anything else in storage is replaced

/** A random id. crypto.randomUUID needs a secure context, so there is a fallback for plain http and old Safari. */
function newId(crypto) {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (crypto && typeof crypto.getRandomValues === "function") {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** This browser's device id, made on first use and kept from then on.
 *  Returns "" when storage cannot be used (private mode in some browsers, storage blocked by policy): the
 *  subscription is then saved against its address alone, exactly as it was before device ids existed. */
export function deviceId(store, crypto) {
  const ls = store !== undefined ? store : typeof localStorage !== "undefined" ? localStorage : null;
  const c = crypto !== undefined ? crypto : typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (!ls) return "";
  try {
    const saved = ls.getItem(DEVICE_ID_KEY);
    if (saved && VALID.test(saved)) return saved;
    const made = newId(c);
    ls.setItem(DEVICE_ID_KEY, made);
    return made;
  } catch (e) {
    return ""; // storage threw (Safari private mode): fall back to naming the device by its address
  }
}

/** The last few characters of a push address: enough to tell devices apart in a log, never the whole address
 *  (it is a capability -- anyone holding it can send this device a notification). */
export const endpointTail = (endpoint, n = 10) => (typeof endpoint === "string" && endpoint ? `…${endpoint.slice(-n)}` : "");

/** The writes that save one device's subscription, in order. Kept here, apart from the Supabase calls that carry
 *  them out (api.savePushSubscription), so scripts/push-selftest.mjs can replay them against a table that
 *  enforces the same two unique keys -- one address belongs to one row, and one device to one row per person.
 *
 *  With a device id the row is found by (user_id, device_id), so this browser updates its own row however often
 *  its address changes, and every other device of that person keeps its own row untouched. The delete first
 *  clears a row that holds this address under a different device id -- or none at all, which is every row saved
 *  before device ids existed -- because the address is unique in the table and would otherwise block the insert.
 *  Without a device id (storage blocked) the row is keyed by its address, exactly as it was before. */
export function pushSaveSteps(row) {
  if (!row.device_id) return [{ op: "upsert", onConflict: "endpoint", row }];
  return [
    { op: "delete", user_id: row.user_id, endpoint: row.endpoint, exceptDevice: row.device_id },
    { op: "upsert", onConflict: "user_id,device_id", row },
  ];
}
