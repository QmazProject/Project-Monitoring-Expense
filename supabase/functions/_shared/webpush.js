/* Web Push with only Web Crypto, so the same file runs in the Supabase edge runtime (Deno) and in Node 20
   (scripts/push-selftest.mjs checks it against an independent implementation).
   - RFC 8291 message encryption (aes128gcm, one record)
   - RFC 8292 VAPID: a short-lived ES256 token that proves the sender to the push service
   - RFC 8030 delivery: POST to the subscription endpoint with TTL and Urgency */

const enc = new TextEncoder();

export const b64url = {
  decode(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  encode(bytes) {
    let bin = "";
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** Encrypts plaintext (Uint8Array) for one subscription: salt | rs | key id | sender public key | ciphertext. */
export async function encrypt(plaintext, { p256dh, auth }) {
  const receiverPub = b64url.decode(p256dh);
  const authSecret = b64url.decode(auth);
  if (receiverPub.length !== 65 || authSecret.length !== 16) throw new Error("Invalid subscription keys");
  if (plaintext.length > 3993) throw new Error("Payload too large for one record");

  const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const senderPub = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const receiverKey = await crypto.subtle.importKey("raw", receiverPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), receiverPub, senderPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(plaintext, new Uint8Array([2])); // 0x02 marks the last (only) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([senderPub.length]), senderPub, cipher);
}

/** The Authorization header for one push service: a signed token naming the service, an expiry and the sender. */
export async function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, expiresInSeconds = 12 * 3600) {
  const pub = b64url.decode(publicKey);
  if (pub.length !== 65) throw new Error("VAPID public key must be the 65-byte uncompressed point (base64url)");
  const jwk = { kty: "EC", crv: "P-256", x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33, 65)), d: privateKey, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, sub: subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url.encode(signature)}, k=${publicKey}`;
}

/** Sends one notification. Resolves to the push service's Response; 404 or 410 means the subscription is gone.
 *  A push service that does not answer within 15 seconds counts as failed, so one dead address can't hold the
 *  function (and the person waiting on "Turn on notifications") until the function's own time limit. */
export async function sendPush(subscription, payload, vapid, { ttl = 24 * 3600, urgency = "high", timeoutMs = 15_000 } = {}) {
  const body = await encrypt(enc.encode(JSON.stringify(payload)), subscription);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
