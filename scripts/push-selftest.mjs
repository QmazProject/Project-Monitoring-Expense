// Checks the parts of push notifications that can be checked without a browser or a push service:
//  1-2. the encryption and signing used by the oe-push function (supabase/functions/_shared/webpush.js) against
//       an independent implementation: http_ece (from the web-push package) decrypts what we encrypt, and
//       Node's ECDSA verifies the VAPID token. Runs with the same Web Crypto the edge runtime uses.
//  3.   what the service worker (public/sw-push.js) shows, and what tapping it opens.
//  4.   one row per device (src/push-device.js): the id a browser keeps, and the writes that save a
//       subscription, replayed against a table that enforces the same unique keys as Postgres.
//  5.   who a send reaches (supabase/functions/_shared/push-target.js): every device for a real notification,
//       only the device that asked for a device test.
// usage: npm run push:selftest
import { createECDH, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { createRequire } from "node:module";
import { b64url, encrypt, vapidAuthorization } from "../supabase/functions/_shared/webpush.js";
import { DEVICE_ID_KEY, deviceId, endpointTail, pushSaveSteps } from "../src/push-device.js";
import { deviceResult, isGone, targetSubscriptions } from "../supabase/functions/_shared/push-target.js";

const ece = createRequire(import.meta.url)("http_ece");
let fails = 0;
const check = (cond, what) => {
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) fails++;
};

// 1. Message encryption (RFC 8291): the browser's keys are an ECDH pair plus a 16-byte auth secret
const receiver = createECDH("prime256v1");
receiver.generateKeys();
const sub = { p256dh: b64url.encode(receiver.getPublicKey()), auth: b64url.encode(randomBytes(16)) };
const msg = JSON.stringify({ title: "Request for approval", body: "REQ-2026-0007 from Mae, ₱78,000.00", url: "/approvals", badge: 3 });
const body = await encrypt(new TextEncoder().encode(msg), sub);
const decrypt = (secret) => ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: receiver, authSecret: secret });
let plain;
try {
  plain = decrypt(sub.auth);
} catch (e) {
  plain = decrypt(Buffer.from(b64url.decode(sub.auth)));
}
check(plain.toString("utf8") === msg, "a message encrypted for the browser decrypts to the same text (http_ece)");
check(body.length === 16 + 4 + 1 + 65 + Buffer.byteLength(msg) + 1 + 16, `the body is salt, record size, sender key and ciphertext (${body.length} bytes)`);
const again = await encrypt(new TextEncoder().encode(msg), sub);
check(Buffer.compare(Buffer.from(body), Buffer.from(again)) !== 0, "every message gets a fresh salt and sender key");
let bad = false;
try {
  await encrypt(new TextEncoder().encode("x"), { p256dh: sub.p256dh, auth: b64url.encode(randomBytes(8)) });
} catch (e) {
  bad = true;
}
check(bad, "malformed subscription keys are refused");

// 2. VAPID (RFC 8292): the token the push service checks
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pj = publicKey.export({ format: "jwk" });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, "base64url"), Buffer.from(pj.y, "base64url")]);
const vapid = { publicKey: b64url.encode(raw), privateKey: privateKey.export({ format: "jwk" }).d, subject: "mailto:helpdesk@example.com" };
const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
const header = await vapidAuthorization(endpoint, vapid);
const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
check(!!m, "the Authorization header has the t= token and k= key parts");
const [h, c, sig] = m[1].split(".");
const claims = JSON.parse(Buffer.from(c, "base64url").toString());
check(JSON.parse(Buffer.from(h, "base64url").toString()).alg === "ES256", "the token is ES256");
check(claims.aud === "https://fcm.googleapis.com" && claims.sub === vapid.subject && claims.exp > Date.now() / 1000 + 3600, "the token names the push service, the contact and a future expiry");
check(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), "the signature verifies with the public key");
check(m[2] === vapid.publicKey, "k= carries the public key the browser subscribed with");

// 3. The service worker side (public/sw-push.js): what a push shows, and what a tap opens
{
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const handlers = {};
  const calls = { shown: [], badge: null, opened: null, focused: null };
  const self = {
    addEventListener: (type, fn) => (handlers[type] = fn),
    registration: { showNotification: async (title, opts) => calls.shown.push({ title, ...opts }), pushManager: { subscribe: async () => ({}) } },
    navigator: { setAppBadge: async (n) => (calls.badge = n), clearAppBadge: async () => (calls.badge = 0) },
    location: { origin: "https://app.example.com" },
    clients: { matchAll: async () => [], openWindow: async (u) => (calls.opened = u) },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw-push.js", import.meta.url), "utf8"), { self, URL });
  const payload = { title: "Request for approval", body: "REQ-2026-0007 from Mae", url: "/approvals", tag: "oe-req-1", badge: 3 };
  const waits = [];
  await handlers.push({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const n = calls.shown[0];
  check(n && n.title === payload.title && n.body === payload.body && n.tag === "oe-req-1" && n.data.url === "/approvals", "a push shows the notification with its title, text and target page");
  check(n && n.icon === "/icons/icon-192.png" && n.badge === "/icons/badge-96.png", "the notification carries the app icon and the small badge mark");
  check(calls.badge === 3, "the app icon badge is set to the number of requests waiting");
  waits.length = 0;
  await handlers.notificationclick({ notification: { close() {}, data: { url: "/approvals" } }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  check(calls.opened === "https://app.example.com/approvals", "tapping the notification opens the Approvals page");
}

// 4. One row per device (src/push-device.js)
{
  // a browser's localStorage
  const storage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const officePc = storage();
  const id1 = deviceId(officePc);
  check(/^[A-Za-z0-9-]{8,64}$/.test(id1), `a browser makes itself an id (${id1})`);
  check(deviceId(officePc) === id1, "the same browser is given the same id every time it asks");
  check(officePc.getItem(DEVICE_ID_KEY) === id1, "the id is kept in that browser's own storage");
  const phone = storage();
  check(deviceId(phone) !== id1, "another browser or device makes its own id, so it becomes its own row");
  const tampered = storage();
  tampered.setItem(DEVICE_ID_KEY, "no, commas), and quotes'");
  check(/^[A-Za-z0-9-]{8,64}$/.test(deviceId(tampered)), "anything else found in storage is replaced with a fresh id");
  check(deviceId(null) === "", "a browser whose storage is blocked gets no id (its row is keyed by its address)");
  const threw = { getItem: () => { throw new Error("private mode"); }, setItem: () => {} };
  check(deviceId(threw) === "", "storage that throws is treated as no storage, not an error");
  check(deviceId(storage(), { getRandomValues: (b) => b.fill(7) }).length === 36, "a browser without crypto.randomUUID still gets a usable id");

  // the oe_push_subscriptions table, with the two unique keys the migration leaves in place: one row per
  // address, and one row per person and device. Row-level security limits every write to the person's own rows.
  const table = () => {
    const rows = [];
    return {
      rows,
      save(row) {
        for (const s of pushSaveSteps(row)) {
          if (s.op === "delete") {
            for (let i = rows.length - 1; i >= 0; i--) {
              const r = rows[i];
              if (r.user_id === s.user_id && r.endpoint === s.endpoint && r.device_id !== s.exceptDevice) rows.splice(i, 1);
            }
            continue;
          }
          const same = s.onConflict === "endpoint" ? (r) => r.endpoint === s.row.endpoint : (r) => r.user_id === s.row.user_id && r.device_id === s.row.device_id;
          const i = rows.findIndex(same);
          if (i >= 0) {
            rows[i] = { ...rows[i], ...s.row };
            continue;
          }
          if (rows.some((r) => r.endpoint === s.row.endpoint)) throw new Error("duplicate key value violates unique constraint oe_push_subscriptions_endpoint_key");
          if (s.row.device_id !== null && rows.some((r) => r.user_id === s.row.user_id && r.device_id === s.row.device_id)) throw new Error("duplicate key value violates unique constraint oe_push_subscriptions_user_device");
          rows.push({ ...s.row });
        }
      },
    };
  };
  const sub = (user, device, endpoint) => ({ user_id: user, device_id: device, endpoint, p256dh: "p", auth: "a", user_agent: "ua", last_seen_at: "now" });
  const admin = "user-admin", other = "user-liaison";

  // the bug this replaces: the same PC re-subscribing used to leave its old row behind
  let t = table();
  t.save(sub(admin, id1, "https://fcm.googleapis.com/x/aaaaaaaaaa"));
  t.save(sub(admin, id1, "https://fcm.googleapis.com/x/bbbbbbbbbb")); // the push service rotated the address
  t.save(sub(admin, id1, "https://fcm.googleapis.com/x/cccccccccc"));
  check(t.rows.length === 1, `the same person and device keep one row through three addresses (${t.rows.length} row)`);
  check(t.rows[0].endpoint.endsWith("cccccccccc"), "that row holds the address the browser has now");

  // several devices per person, which is the point of the change
  t = table();
  const ids = ["office-pc-aaaa", "home-laptop-bbb", "android-phone-c", "iphone-ddddddddd"];
  ids.forEach((d, i) => t.save(sub(admin, d, `https://push.example/${d}-${i}`)));
  check(t.rows.length === 4, `four devices of one person are four rows (${t.rows.length} rows)`);
  t.save(sub(admin, ids[2], "https://push.example/android-phone-c-new")); // the phone re-subscribes
  check(t.rows.length === 4, "one of them re-subscribing still leaves four rows");
  check(t.rows.filter((r) => r.device_id === ids[2])[0].endpoint.endsWith("new"), "and only that device's address changed");
  check(ids.every((d) => t.rows.some((r) => r.device_id === d)), "no device was replaced by another device registering");

  // rows saved before device_id existed carry none; the browser adopts an id and keeps one row
  t = table();
  t.rows.push({ ...sub(admin, null, "https://fcm.googleapis.com/x/DFdz9LabEM"), legacy: true });
  t.save(sub(admin, id1, "https://fcm.googleapis.com/x/DFdz9LabEM"));
  check(t.rows.length === 1 && t.rows[0].device_id === id1, "a row from before device ids is taken over, not duplicated");

  // two people on the same PC: the address belongs to whoever signed up with it, and the second save fails,
  // which is what makes the app unsubscribe and start a fresh subscription
  t = table();
  t.save(sub(other, "their-device-id", "https://fcm.googleapis.com/x/shared0000"));
  let blocked = false;
  try {
    t.save(sub(admin, id1, "https://fcm.googleapis.com/x/shared0000"));
  } catch (e) {
    blocked = /endpoint_key/.test(e.message);
  }
  check(blocked, "another account's address is not taken over silently (the app then re-subscribes)");
  check(t.rows.length === 1 && t.rows[0].user_id === other, "and that other person's device is left alone");

  // storage blocked: keyed by address, as before
  t = table();
  t.save(sub(admin, null, "https://fcm.googleapis.com/x/nostorage1"));
  t.save(sub(admin, null, "https://fcm.googleapis.com/x/nostorage1"));
  check(t.rows.length === 1, "a browser without storage still keeps one row per address");
}

// 5. Who a send reaches (supabase/functions/_shared/push-target.js)
{
  const subs = [
    { id: "1", endpoint: "https://fcm.googleapis.com/x/office-pc", device_id: "office" },
    { id: "2", endpoint: "https://fcm.googleapis.com/x/android11", device_id: "phone" },
    { id: "3", endpoint: "https://web.push.apple.com/x/iphone777", device_id: "iphone" },
  ];
  check(targetSubscriptions(subs, "").length === 3, "a real request notification goes to every device of every recipient");
  check(targetSubscriptions(subs, null).length === 3, "so does an older app build that names no device");
  const one = targetSubscriptions(subs, subs[1].endpoint);
  check(one.length === 1 && one[0].id === "2", "a device test goes only to the device that asked");
  check(targetSubscriptions(subs, "https://fcm.googleapis.com/x/someone-else").length === 0, "an address that is none of the caller's rows reaches nobody");
  check(targetSubscriptions(undefined, "").length === 0, "no devices at all is not an error");

  check(isGone(404) && isGone(410), "404 and 410 mean the subscription is gone");
  check(!isGone(201) && !isGone(429) && !isGone("error"), "accepted, rate-limited and network errors do not delete a device");
  const logged = endpointTail("https://fcm.googleapis.com/fcm/send/abcDFdz9LabEM");
  check(logged === "…DFdz9LabEM" && !logged.includes("fcm/send"), `a log shows only the tail of an address (${logged})`);
  check(endpointTail("") === "" && endpointTail(null) === "", "a device with no address logs nothing");

  check(deviceResult({ service: "fcm.googleapis.com", status: 201 }, subs[0]).text === "this device: 201", "an accepted test reports this device: 201");
  const expired = deviceResult({ service: "fcm.googleapis.com", status: 410, note: "unsubscribed" }, subs[0]);
  check(expired.text === "this device: 410 -- subscription expired", "an expired subscription says so");
  check(expired.device_id === "office" && expired.endpoint_tail === endpointTail(subs[0].endpoint), "the answer names which device it is about");
  check(deviceResult(null, null).text === "this device: not registered", "a device with no row is reported as not registered");
  check(deviceResult({ service: "fcm.googleapis.com", status: 429, note: "quota" }, subs[1]).note === "quota", "the push service's own words are passed through");
}

console.log(fails ? `\nPUSH SELFTEST: ${fails} failed` : "\nPUSH SELFTEST: all checks passed");
process.exit(fails ? 1 : 0);
