// Checks the push encryption and signing used by the oe-push function (supabase/functions/_shared/webpush.js)
// against an independent implementation: http_ece (from the web-push package) decrypts what we encrypt, and
// Node's ECDSA verifies the VAPID token. Runs in Node with the same Web Crypto the edge runtime uses.
// usage: npm run push:selftest
import { createECDH, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { createRequire } from "node:module";
import { b64url, encrypt, vapidAuthorization } from "../supabase/functions/_shared/webpush.js";

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

console.log(fails ? `\nPUSH SELFTEST: ${fails} failed` : "\nPUSH SELFTEST: all checks passed");
process.exit(fails ? 1 : 0);
