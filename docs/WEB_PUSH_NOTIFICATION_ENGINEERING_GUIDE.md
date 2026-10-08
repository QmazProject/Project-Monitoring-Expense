# Web Push Notification — Engineering Guide

**Project Expense Monitoring** · written 2026-10-07 · reflects commit state after the multi-device `device_id` work

This is a long-term engineering reference, not a changelog. It explains how the push system works end to end,
why it is built this way, what happens in real device/user situations, the bugs we hit and how we found them,
and the principles worth carrying into other systems.

Operational setup instructions live in [`docs/SETUP.md` §6](SETUP.md). This document is the *why* and the
*how it really behaves*. Where the two disagree, the code wins — and I note the disagreement.

Everything here was read out of this repository. Where something is a platform behaviour rather than our code,
it says so. No real keys, service-role tokens, or full push endpoints appear anywhere in this document.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [Web Push from zero](#2-web-push-from-zero)
3. [VAPID keys](#3-vapid-keys)
4. [Environment configuration](#4-environment-configuration)
5. [PWA and service worker](#5-pwa-and-service-worker)
6. [Desktop vs Android vs iOS](#6-desktop-vs-android-vs-ios)
7. [device_id vs push endpoint](#7-device_id-vs-push-endpoint-the-most-important-concept)
8. [The database design](#8-the-database-design)
9. [Multi-device engineering](#9-multi-device-engineering)
10. [Recipient logic](#10-recipient-logic)
11. [The Test Notification fix](#11-the-test-notification-fix)
12. [Push response codes](#12-push-response-codes)
13. [Case study: the Chrome/Windows incident](#13-case-study-the-chromewindows-incident)
14. [Debugging playbook](#14-debugging-playbook)
15. [Permission flow and timeouts](#15-permission-flow-and-timeouts)
16. [Logout behaviour](#16-logout-behaviour)
17. [Clear site data](#17-clear-site-data)
18. [Uninstall / reinstall](#18-uninstall--reinstall)
19. [Multiple users on one browser](#19-multiple-users-on-one-browser)
20. [Multiple browsers on one PC](#20-multiple-browsers-on-one-pc)
21. [Notification click routing](#21-notification-click-routing)
22. [Security model](#22-security-model)
23. [RLS and database security](#23-rls-and-database-security)
24. [Stale device cleanup](#24-stale-device-cleanup)
25. [Files that make up the system](#25-files-that-make-up-the-system)
26. [Commands and deployment](#26-commands-and-deployment)
27. [Testing](#27-testing)
28. [Known limitations](#28-known-limitations)
29. [Engineering mindset](#29-engineering-mindset)
30. [“What if…” scenario matrix](#30-what-if-scenario-matrix)
31. [Beginner mental model](#31-beginner-mental-model)
32. [Cheat sheet](#32-cheat-sheet)

---

# 1. The big picture

## ELI5

Imagine the app wants to tap someone on the shoulder, but the app isn't running. It can't.

So the app hires a courier company that is *always* awake — Google's for Chrome, Microsoft's for Edge, Apple's
for iPhone. The browser goes to that courier and gets a **private mailbox address**. The app writes that address
down. Later, when something happens, our server hands a **sealed envelope** to the courier with that address on
it. The courier delivers it to the browser, even if the app is closed. A tiny piece of our code that the browser
keeps running in the background — the **service worker** — opens the envelope and asks the **operating system**
to show a banner. Windows or Android or iOS decides whether that banner actually appears on screen.

Three separate "yes" answers are needed: the person must allow it, the courier must accept the envelope, and the
operating system must agree to draw the banner. **Our code controls only the first two.** That single sentence is
the most useful thing in this document — it is exactly what cost us a day of debugging (§13).

## The flow

```
 [1] USER
      |  signs in
      v
 [2] BROWSER / INSTALLED PWA                      (Chrome, Edge, Safari on Home Screen)
      |  the app offers "Turn on notifications"
      v
 [3] NOTIFICATION PERMISSION                      Notification.requestPermission()
      |  granted
      v
 [4] SERVICE WORKER                               dist/sw.js  +  public/sw-push.js
      |  installed and active (production build only)
      v
 [5] PUSH SUBSCRIPTION                            reg.pushManager.subscribe({ applicationServerKey })
      |  returns { endpoint, keys: { p256dh, auth } }
      v
 [6] DEVICE ID                                    src/push-device.js -> localStorage["oe-device-id"]
      |  stable name for THIS browser
      v
 [7] SUPABASE DATABASE                            oe_push_subscriptions
      |  upsert on (user_id, device_id)   <- RLS: only your own rows
      |
      |   ... time passes; a request is filed / approved / rejected ...
      |
      v
 [8] SUPABASE EDGE FUNCTION                       supabase/functions/oe-push/index.ts
      |  checks the caller, decides recipients, reads their devices
      v
 [9] WEB PUSH + VAPID                             supabase/functions/_shared/webpush.js
      |  encrypts the payload (RFC 8291), signs a VAPID token (RFC 8292)
      |  POSTs to the endpoint (RFC 8030)
      v
[10] BROWSER PUSH SERVICE                         fcm.googleapis.com | *.notify.windows.com | web.push.apple.com
      |  answers 201 (accepted)  <-- this is where our visibility ENDS
      v
[11] DEVICE / BROWSER
      |  delivers to the service worker (browser must be running or allowed in background)
      v
[12] SERVICE WORKER 'push' EVENT                  public/sw-push.js
      |  self.registration.showNotification(title, options)
      |  navigator.setAppBadge(n)
      v
[13] OPERATING SYSTEM NOTIFICATION UI             Windows / Android / iOS decides
      |  per-app settings, Do not disturb, banner vs centre
      v
[14] USER TAPS IT                                 'notificationclick'
      |  focus an open tab, or open a new window
      v
[15] APP OPENS THE RIGHT PAGE                     /approvals or /requests -> NAV -> module
```

## Vocabulary — keep these straight

These are confused constantly, and confusing them is how you end up debugging the wrong layer.

| Term | What it actually is | In this project |
|---|---|---|
| **Application** | Our React code. Only exists while a tab is open. | `src/App.jsx` (single-file app) |
| **Browser** | The program. Owns permissions and storage, per profile. | Chrome, Edge, Safari |
| **Service Worker** | A script the browser keeps and can run **without any tab open**. The only thing that can receive a push. | `dist/sw.js`, which imports `public/sw-push.js` |
| **Push Subscription** | The browser's registration with its push service. An object containing an endpoint + two crypto keys. | created in `pushSubscribe()` |
| **Push Endpoint** | A URL that *is* a capability — anyone holding it can send this browser a notification. **Not stable.** | `https://fcm.googleapis.com/fcm/send/…` (always redacted to its last 10 chars in logs) |
| **Device ID** | *Our own* invention. A UUID we generate and keep in the browser's `localStorage` so we can recognise this browser again after its endpoint changes. | `localStorage["oe-device-id"]` |
| **Push Provider / Push Service** | The always-on courier run by the browser vendor. Different vendors, different infrastructure. | FCM (Chrome), WNS (Edge), Apple Web Push (Safari) |
| **FCM** | Firebase Cloud Messaging — Google's push service, used by Chrome. Needs a persistent connection on ports 5228–5230. | `fcm.googleapis.com` |
| **Apple Web Push** | Apple's push service for Safari/Home-Screen web apps. Standard Web Push (VAPID), *not* native APNs tokens. | `web.push.apple.com` |
| **VAPID** | The way our server proves to a push service that it is the same sender the browser subscribed to. | `_shared/webpush.js` |
| **Supabase** | Our backend platform: Postgres + Auth + Edge Functions. | project `zbizmpoylftbeknhipjg` |
| **Edge Function** | Server-side Deno code. The *only* place that holds the VAPID private key. | `oe-push` |
| **Database** | Where subscriptions live, protected by RLS. | `oe_push_subscriptions` |
| **OS notification** | The banner itself. Drawn by Windows/Android/iOS, governed by *their* settings. | the layer we cannot see or control |

> **The single most important boundary:** steps 1–10 are ours. Steps 11–13 belong to the browser and the
> operating system. A `201` from step 10 says nothing about step 13.

---

# 2. Web Push from zero

## ELI5

A push notification is a *letter*, not a *phone call*. You can't phone a closed app. You post a letter to a
courier who is always awake, and the courier slides it under the door. The browser's background script picks it
up off the mat and holds it up for the OS to show.

The letter is sealed so that the courier cannot read it (end-to-end encryption), and stamped so the courier knows
it came from us and not an impostor (VAPID).

## What happens when someone presses "Turn on notifications"

This is the real sequence in `usePush().enable()` → `pushSubscribe()` → `sendTest()` in `src/App.jsx`.

### 1. The app decides whether to offer it at all

```js
const PUSH_SUPPORTED = typeof window !== "undefined"
  && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const offered = PUSH_SUPPORTED && !!CONFIG.vapidPublicKey && api.mode === "live";
```

Three conditions: the browser can do push, **this build carries a VAPID public key**, and we're in live mode
(never the demo). If `VITE_VAPID_PUBLIC_KEY` is empty, the whole feature silently does not exist — no bar, no
button. That is deliberate: a half-configured deployment should not show a button that cannot work.

### 2. The person is asked — by us first, then by the browser

The app shows a bar (`PushCard`) with **Turn on notifications** and **Not now**. We never call
`requestPermission()` on page load (§15 explains why). The browser prompt only appears inside the click handler,
because browsers require a user gesture.

```js
const p = await askPermission(() => { setQuiet(true); setBusy(false); });
if (p !== "granted") { /* explain and stop */ }
```

### 3. The service worker must exist

```js
if (!(await navigator.serviceWorker.getRegistration())) {
  throw new Error("This page has no service worker, so notifications can't work here. ...");
}
const reg = await withTimeout(navigator.serviceWorker.ready, 8000, "...not installed yet. Reload...");
```

No service worker, no push — there would be nothing to receive the message. This is exactly the case on
`npm run dev`, which is why the error names the fix (§4).

### 4. The browser creates a subscription

```js
const key = b64urlToBytes(CONFIG.vapidPublicKey);
reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
```

- `userVisibleOnly: true` is a promise to the browser that *every* push will result in a visible notification.
  Chrome requires it. Break the promise and the browser shows its own generic "site updated in the background"
  message instead.
- `applicationServerKey` is the **VAPID public key**. It is burned into the subscription — which is why a key
  change invalidates every existing subscription (§3).

The subscription contains three things we need:

```js
const j = sub.toJSON();   // { endpoint, keys: { p256dh, auth } }
```

`endpoint` = where to post. `p256dh` = the browser's public key. `auth` = a 16-byte secret. The last two are what
make the payload readable only by that browser.

### 5. We name the device and save it

```js
const device = deviceId();   // localStorage, stable across endpoint changes
api.savePushSubscription({ device_id: device, endpoint, p256dh, auth, user_agent });
```

Written to `oe_push_subscriptions`, upserted on `(user_id, device_id)`. RLS guarantees you can only write your
own rows (§23).

### 6. A test is sent immediately — to this device only

```js
await sendTest("Notifications are on. A test notification is on its way.");
```

Confirming the whole chain at the moment the person is standing there expecting it. §11 explains why "to this
device only" matters so much.

### 7. Much later: something happens

When a request is filed, approved or rejected, `api.notify(event, requestId)` invokes `oe-push`. The function
authenticates the caller with *their own JWT*, decides who should hear about it, reads those people's devices,
and sends.

### 8. Encrypt, sign, POST

In `_shared/webpush.js`:

```js
export async function sendPush(subscription, payload, vapid, { ttl = 24*3600, urgency = "high", timeoutMs = 15_000 } = {}) {
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
```

Three standards in one call:

- **RFC 8291** — payload encryption. ECDH against the browser's `p256dh`, HKDF with the `auth` secret,
  AES-128-GCM. The push service forwards ciphertext it cannot read.
- **RFC 8292** — VAPID. An ES256 JWT naming the push service (`aud`), an expiry (12 h), and our contact (`sub`).
- **RFC 8030** — delivery. `TTL: 86400` means "hold it for 24 hours if the device is offline".
  `Urgency: high` asks the service not to batch it.

`timeoutMs: 15_000` exists so that one dead push service cannot hold the whole function — and therefore the
person staring at a spinner — hostage.

### 9. Browser → service worker → OS

`public/sw-push.js`:

```js
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  const title = d.title || "Project Expense Monitoring";
  const options = {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: d.tag || "oe",
    renotify: !!d.tag,
    data: { url: d.url || "/" },
  };
  const jobs = [self.registration.showNotification(title, options)];
  if (typeof d.badge === "number" && self.navigator.setAppBadge)
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  event.waitUntil(Promise.all(jobs));
});
```

Note the `try/catch`: a malformed payload still produces a notification rather than nothing, because
`userVisibleOnly` obliges us to show *something*.

> **Maintenance trap — two different things called "badge".**
> `options.badge` is the small monochrome *image* shown by the OS (`/icons/badge-96.png`).
> `d.badge` is a **number** — the count of requests awaiting approval — used for the app-icon counter via
> `setAppBadge`. Same word, different layers. Don't "tidy" one into the other.

### 10. The tap

```js
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  const url = new URL(target || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus().then((c) => (target && c && c.navigate ? c.navigate(url) : c));
      return self.clients.openWindow(url);
    })
  );
});
```

Reuse an open window if there is one (nobody wants a fifth tab), otherwise open one. §21 follows the URL into the
app's router.

---

# 3. VAPID keys

## ELI5

VAPID is a **wax seal**. The browser tells the courier: "I will only accept letters sealed with *this* crest."
Our server owns the stamp. Anyone can look at the crest (public key); only we can press it (private key).

Without it, anyone who learned your endpoint could spam that browser.

## What it is technically

**V**oluntary **A**pplication **S**erver **I**dentification. An ECDSA P-256 key pair. The browser is given the
public key at subscribe time and bakes it into the subscription. Every push must carry a JWT signed by the
matching private key. The push service verifies the signature against the `k=` parameter and checks it matches
what the subscription was created with.

From `_shared/webpush.js`:

```js
const claims = b64url.encode(enc.encode(JSON.stringify({
  aud: new URL(endpoint).origin,                                  // which push service
  exp: Math.floor(Date.now() / 1000) + expiresInSeconds,          // 12 hours
  sub: subject,                                                   // mailto: contact
})));
// ...
return `vapid t=${header}.${claims}.${b64url.encode(signature)}, k=${publicKey}`;
```

- `aud` must be the push service's origin — a token minted for FCM is rejected by Apple. Correctly derived
  per-endpoint here.
- `exp` 12 hours. Services reject tokens valid for more than 24 h.
- `sub` the **VAPID subject**: how a push service operator contacts a human when your traffic misbehaves. A
  `mailto:` is the convention (an `https:` URL is also permitted by the spec). Use a monitored address.

## Which key goes where

| Key | Lives in | Who can see it | Why |
|---|---|---|---|
| **Public** | `VITE_VAPID_PUBLIC_KEY` → `.env` + Vercel env vars | **Everyone.** It is compiled into the JS bundle. | The browser needs it to subscribe. |
| **Public (again)** | `VAPID_PUBLIC_KEY` → Supabase secret | server only | The function must send it as `k=` and derive the JWK — it cannot recompute it from the private key alone as written. |
| **Private** | `VAPID_PRIVATE_KEY` → Supabase secret | **nothing client-side, ever** | Signs the token. Leaking it lets anyone notify your users. |
| **Subject** | `VAPID_SUBJECT` → Supabase secret | server only | Operator contact. Not a credential, but backend config. |

The public key is genuinely safe to publish — it is *designed* to be handed to every browser. It grants no
ability to send. We verified ours is in the deployed bundle at
`assets/index-*.js` → `VITE_VAPID_PUBLIC_KEY:"BAx_…IsW4"`, which is correct and expected.

The private key must never appear in a `VITE_*` variable. Vite inlines **every** `VITE_*` value into the client
bundle at build time, so a private key in a `VITE_` name is a public key the moment you deploy. This is why
`src/env.js` carries the warning it does, and why `.env.example` repeats it.

## How ours were generated

```bash
npm run push:keys      # -> node scripts/make-vapid-keys.mjs
```

```js
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
```

`prime256v1` is P-256. The `0x04` prefix marks an uncompressed EC point — 65 bytes total, which
`vapidAuthorization` asserts:

```js
if (pub.length !== 65) throw new Error("VAPID public key must be the 65-byte uncompressed point (base64url)");
```

The script prints both halves and the exact command to set the secrets:

```text
VITE_VAPID_PUBLIC_KEY=<public-key>

supabase secrets set VAPID_PUBLIC_KEY=<public-key> VAPID_PRIVATE_KEY=<private-key> VAPID_SUBJECT=mailto:<real-email>
```

It also prints the warning that matters most: *"Changing the keys later signs everyone's devices out of
notifications."*

## What a mismatch does

The frontend's public key and the function's key pair must correspond. If they drift:

| Situation | Symptom |
|---|---|
| Frontend key ≠ function's pair | Push services reject with **403** (`VAPID credential mismatch`). Counted as `failed`; the row is *not* deleted. The test now reports `this device: 403`. |
| Frontend key changed, old subscriptions remain | Those subscriptions were created against the old key and cannot be used. |

The client defends against its own stale state:

```js
if (sub && sub.options && sub.options.applicationServerKey
    && !sameBytes(new Uint8Array(sub.options.applicationServerKey), key)) {
  const old = sub.endpoint;
  await sub.unsubscribe();
  await drop(old);          // delete our DB row for the address we just gave up
  sub = null;               // then subscribe afresh with the current key
}
```

## Do not regenerate keys casually

Rotating VAPID keys **invalidates every existing subscription on every device of every user**. There is no
migration path: each person must open the app and press *Turn on notifications* again. Until they do, they are
silently not notified — and in this system that means an approver can miss a request.

Rotate only on actual private-key compromise, and plan for a re-subscribe campaign. If you ever do: set the
Supabase secrets **and** `VITE_VAPID_PUBLIC_KEY` together, deploy both, and expect `403`s from old subscriptions
until the key-mismatch branch above clears them device by device.

---

# 4. Environment configuration

`src/env.js` is the only bridge from Vite's env into the app:

```js
globalThis.OE_CONFIG = {
  supabaseUrl: str(env.VITE_SUPABASE_URL),
  supabaseAnonKey: str(env.VITE_SUPABASE_ANON_KEY),
  usernameDomain: str(env.VITE_USERNAME_DOMAIN),
  demoEnabled: str(env.VITE_DEMO_ENABLED).toLowerCase() !== "false",
  captchaSiteKey: str(env.VITE_TURNSTILE_SITE_KEY),
  vapidPublicKey: str(env.VITE_VAPID_PUBLIC_KEY),   // empty = notifications are not offered
};
```

## Where every variable belongs

| Variable | In browser bundle | Vercel env | Supabase secrets | Local `.env` | Secret? | Purpose |
|---|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Yes | Yes | — | Yes | No | Which Supabase project |
| `VITE_SUPABASE_ANON_KEY` | Yes | Yes | — | Yes | No — RLS protects the data | Browser DB/auth access |
| `VITE_VAPID_PUBLIC_KEY` | **Yes** | **Yes** | — | Yes | **No** | `applicationServerKey` for `subscribe()`. Empty ⇒ push never offered |
| `VAPID_PUBLIC_KEY` | No | No | **Yes** | No | No, but backend config | Sent as `k=`; used to build the signing JWK |
| `VAPID_PRIVATE_KEY` | **Never** | **Never** | **Yes** | No | **YES — critical** | Signs the VAPID JWT |
| `VAPID_SUBJECT` | No | No | **Yes** | No | Backend config | `mailto:` operator contact |
| `SUPABASE_URL` | No | No | built-in | Yes | No | For local scripts (`bootstrap:users`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Never** | **Never** | built-in | Yes | **YES — critical** | Bypasses RLS. Local scripts + the function's own runtime |
| `VITE_DEMO_ENABLED` | Yes | Yes | — | Yes | No | Hides the demo on the sign-in page |

Inside the deployed function, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided
by the platform — you do not set them as secrets. `oe-push` fails fast if anything is missing:

```ts
if (!url || !anonKey || !serviceKey) return json({ error: "Function is not configured." }, 500);
if (!vapid.publicKey || !vapid.privateKey || !vapid.subject)
  return json({ error: "Push keys are not configured (VAPID_* secrets)." }, 500);
```

Those two guards are genuinely useful diagnostics — they are how we confirmed the secrets were set without ever
reading them, by sending a request with a deliberately invalid bearer token and observing that it got *past* the
VAPID check to the session check.

## Local development: why `npm run dev` cannot do push

```bash
npm run dev       # vite dev server, port 5173 — NO service worker
npm run build     # produces dist/ including sw.js and sw-push.js
npm run preview   # serves dist/ on port 4173 — service worker present
```

`vite.config.js` configures `VitePWA` in `generateSW` mode with `injectRegister: false`, and does not enable
`devOptions`. The service worker is therefore a **build artifact only**. On the dev server there is no `sw.js`
to register, so `pushSubscribe()` throws its explicit message:

> "This page has no service worker, so notifications can't work here. On a PC, build the app
> (`npm run build`) and open it with `npm run preview`, or use the live address."

This is a deliberate design choice, and §7 of the original brief for this work said explicitly not to "fix" it
by faking a service worker in dev. Dev-mode service workers cache aggressively and create update bugs that cost
more time than they save.

**Secure context:** service workers and push require HTTPS — *except* that browsers treat
`http://localhost` (and `127.0.0.1`) as a secure context. So `npm run preview` on
`http://localhost:4173` can do real push, including real FCM delivery, with no certificate. Any other host must
be HTTPS. (Note: `http://<your-LAN-ip>:4173` is **not** a secure context — testing from a phone on your Wi-Fi
needs HTTPS or a tunnel.)

---

# 5. PWA and service worker

## ELI5

The service worker is a **doorman** the browser keeps on duty after everyone has gone home. He can't redecorate
the house (no DOM), but he can accept deliveries and ring the doorbell.

## Configuration

`vite.config.js`:

```js
VitePWA({
  registerType: "prompt",     // a new build waits until the person taps Reload
  injectRegister: false,      // we register it ourselves in src/main.jsx
  includeAssets: ["favicon.svg", "icons/*.png"],
  manifest: { name: "Project Expense Monitoring", short_name: "PEM", start_url: "/project-report",
              scope: "/", display: "standalone", theme_color: "#0b4338", icons: [...] },
  workbox: {
    globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}", "assets/poppins-latin-*.woff2"],
    importScripts: ["sw-push.js"],      // <-- our push handler
    navigateFallback: "/index.html",
    runtimeCaching: [],                 // nothing from Supabase is ever cached
    cleanupOutdatedCaches: true,
    clientsClaim: true,
  },
})
```

Points worth understanding:

- **`importScripts: ["sw-push.js"]`** is the whole integration. Workbox generates `dist/sw.js` for caching; our
  push logic lives separately in `public/sw-push.js` and is pulled in. Verified in the deployed build:
  `dist/sw.js` contains `importScripts("sw-push.js")`.
  *Consequence:* `public/sw-push.js` is **not** bundled, minified or transpiled. Write plain, widely-supported JS
  there. No JSX, no TypeScript, no npm imports.
- **`runtimeCaching: []`** — project and request data are never cached. Only the app shell is. A notification
  therefore always opens fresh data, and there is no stale-data class of bug.
- **`navigateFallback: "/index.html"`** plus the `rewrites` in `vercel.json` are what make
  `https://…/approvals` work when opened cold from a notification.
- **`display: "standalone"`** and `start_url: "/project-report"` matter for the installed app; `STANDALONE`
  detection in `App.jsx` uses `matchMedia("(display-mode: standalone)")` and `navigator.standalone`.

## Why push needs a service worker

A push arrives when no tab exists. Only a service worker can be started by the browser in response to an
incoming event. `showNotification` is available on `ServiceWorkerRegistration` — this is why the demo path also
prefers the registration and only falls back to `new Notification(...)`:

```js
const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
if (reg) await reg.showNotification("Request for approval", opts);
else new Notification("Request for approval", opts);
```

(`new Notification()` only works while a page is open, which is why it is a demo-only fallback.)

## The "stuck on Updating…" problem

This is worth understanding properly, because **a service-worker update bug is a notification bug**: if the
active worker is an old build without the push handler, pushes arrive and nothing useful happens — the browser
may show its own generic "This site has been updated in the background" message instead of your notification,
because `userVisibleOnly` was promised and nothing was shown.

The lifecycle: a new worker **installs**, then **waits** until no page is controlled by the old one. With
`registerType: "prompt"` we deliberately keep it waiting so a half-typed form isn't destroyed by a reload.

The symptom we had: tapping **Update** left the banner on "Updating…" forever. Two causes, both fixed:

**1. Nobody to hand over to.** A page loaded *before* any worker existed (first visit, hard refresh, freshly
installed app) is "uncontrolled". Telling a waiting worker to `skipWaiting()` produced no `controllerchange`
event, so the reload never fired. Fixed with:

```js
clientsClaim: true,   // a freshly activated worker takes charge of already-open pages at once
```

**2. No fallback if the handover never happens.** `src/main.jsx`:

```js
async function applyUpdate() {
  if (applying) return;                       // idempotent: double-taps are ignored
  applying = true;
  const reg = registration || (await navigator.serviceWorker.getRegistration().catch(() => null));
  const sw = reg && (reg.waiting || reg.installing);
  let done = false;
  const reload = () => { if (done) return; done = true; window.location.reload(); };
  if (!sw) return reload();                   // nothing waiting: the new build is already in charge
  navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  const takeOver = () => { sw.postMessage({ type: "SKIP_WAITING" }); setTimeout(reload, 8000); };
  if (sw.state === "installed") takeOver();
  else sw.addEventListener("statechange", () => {
    if (sw.state === "installed") takeOver();       // was still downloading when tapped
    else if (sw.state === "redundant") reload();    // download failed: reload and try again later
  });
}
```

Every branch ends in a reload. The banner cannot get stuck.

**3. Later deploys are still noticed.** The `registerSW` helper stops watching after the first update it finds,
so a second deploy during a long session would go unseen. `onRegisteredSW` adds its own `updatefound` listener,
plus checks on `visibilitychange`, on `online`, and every 30 minutes, throttled to at most one per minute:

```js
let last = Date.now();
const check = () => {
  if (Date.now() - last < 60_000 || navigator.onLine === false) return;
  last = Date.now();
  reg.update().catch(() => {});
};
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
window.addEventListener("online", check);
setInterval(check, 30 * 60_000);
```

This matters for phones, which keep an installed app alive in the background for days without ever reloading.

**Also note `pushsubscriptionchange`** in `sw-push.js`:

```js
self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  if (!old || !old.options) return;
  event.waitUntil(self.registration.pushManager.subscribe(old.options).catch(() => {}));
});
```

The worker re-subscribes, but **cannot write to the database** (no session, no auth token). The new endpoint is
persisted on the next app launch, when `pushSubscribe()` runs again. See §28.

## Infrastructure that must not break the worker

- `vercel.json` sets `Cache-Control: no-cache` on `/sw.js` and `/manifest.webmanifest`. If `sw.js` were cached,
  devices would be stuck on an old worker.
- `middleware.js` (Vercel Edge) deliberately **excludes** the worker from its matcher:
  ```js
  matcher: ["/((?!assets/|icons/|favicon\\.svg|sw\\.js|workbox-|manifest\\.webmanifest).*)"]
  ```
  If rate limiting ever applied to `sw.js`, update checks would start failing intermittently. Don't remove those
  exclusions.
- The CSP in `vercel.json` includes `worker-src 'self' blob:`. Without it the worker would not load at all.

---

# 6. Desktop vs Android vs iOS

## ELI5

Every browser hires a *different* courier company, and every operating system has its own rules about whether a
banner is allowed to appear. Same code, same server, very different last mile.

## The platform table (behaviour in this project)

| Platform | Browser | Install PWA? | Push supported? | Push service | Notes |
|---|---|---|---|---|---|
| Windows | Chrome | Optional | Yes | `fcm.googleapis.com` (FCM) | Needs a persistent FCM connection (ports 5228–5230). Per-app Windows notification settings apply. |
| Windows | Edge | Optional | Yes | `*.notify.windows.com` (WNS) | **Different infrastructure from Chrome on the same PC.** Observed working while Chrome was blocked. |
| Windows/macOS | Firefox | Optional | Yes (not yet observed here) | Mozilla autopush | Separate browser ⇒ separate subscription. |
| macOS | Safari 16.1+ | Optional | Yes | `web.push.apple.com` | Can deliver via Notification Center even when Safari is closed. |
| Android | Chrome | Optional | Yes | FCM | Works in the browser *and* in the installed app; they share the Chrome profile's storage for the origin, so normally one `device_id`. |
| **iPhone / iPad** | Safari | **Required** | **Only when added to the Home Screen** (iOS 16.4+) | `web.push.apple.com` | In plain Safari, `PushManager` is absent, so `PUSH_SUPPORTED` is false and we show install instructions instead. |

Our registered devices during this work included `fcm.googleapis.com` (Chrome, Windows and Android),
`wns2-bl2p.notify.windows.com` (Edge, Windows) and `web.push.apple.com` (iPhone, Safari 27 / iOS 18.7) — so all
three provider families are exercised in production.

## Desktop

Push works with no tab open **only while the browser process is still running**. On Windows, Chrome and Edge keep
a background process by default (*Settings → System → Continue running background apps when the browser is
closed*). If the browser is fully closed, the push service holds the message for our `TTL` of 24 hours and
delivers it when the browser next starts.

The genuinely surprising part, and the subject of §13: **the OS can accept the notification and refuse to draw
the banner**, per application, silently.

## Android

The least troublesome platform. Chrome and the installed PWA share the origin's storage, so they normally share
one `device_id` and one row. The app icon badge via `setAppBadge` works in the installed app.

## iOS / iPadOS — the special case

Apple only supports Web Push for web apps **added to the Home Screen**, from iOS 16.4. In plain Safari,
`window.PushManager` does not exist, so:

```js
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // iPad pretending to be a Mac
const STANDALONE = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || navigator.standalone === true;

const iosNeedsInstall = IS_IOS && !STANDALONE && !PUSH_SUPPORTED
  && api.mode === "live" && !!CONFIG.vapidPublicKey;
```

When `iosNeedsInstall` is true, the bar explains the only route that works:

> "On iPhone and iPad, notifications work in the installed app: tap Share, then Add to Home Screen, then turn
> them on there."

There is also a separate dismissible hint (`localStorage["oe-ios-hint"]`) and **no install button** for iOS —
Safari offers no `beforeinstallprompt`, so installation is entirely manual via the Share sheet. Note too that
`canInstall && !desktop` gates the Android install button: desktop browsers already offer install in the address
bar, so we don't duplicate it.

**Critical iOS consequence:** the Home Screen app has its **own storage and its own notification permission**,
separate from Safari. It therefore gets its **own `device_id` and its own database row**. An iPhone user who
allowed notifications in the installed app and then opens the site in Safari is, as far as this system is
concerned, at a different device. That is correct, not a bug.

Instruct iPhone users: Share → **Add to Home Screen** → open the icon (not Safari) → sign in → **Turn on
notifications**.

---

# 7. `device_id` vs push endpoint — the most important concept

## ELI5

> **`device_id` = the seat number.**
> **`endpoint` = the phone number the courier currently has for that seat.**

People keep their seat. Phone numbers change. If you file your customers by phone number, then every time
someone changes number you create a *second* customer — and you start posting letters to a disconnected line
while believing you have two happy customers.

That is precisely the bug we had.

## Why the endpoint cannot be an identity

A push endpoint is a **delivery address**, and it is not stable. It changes when:

- the browser re-subscribes after a VAPID key change;
- our save failed and the client deliberately unsubscribed and re-subscribed (the retry path);
- the push service rotates it and fires `pushsubscriptionchange`;
- the user clears site data, or uninstalls/reinstalls the PWA.

It is also a **capability**: whoever holds it can send that browser a notification. That is why every log in this
system prints only the last 10 characters:

```js
export const endpointTail = (endpoint, n = 10) =>
  (typeof endpoint === "string" && endpoint ? `…${endpoint.slice(-n)}` : "");
```

## The bug, concretely

Before the fix, `endpoint` was the only unique key:

```js
// old
upsert({ user_id, endpoint, p256dh, auth, user_agent, last_seen_at }, { onConflict: "endpoint" })
```

So a rotation inserted a **new** row and left the old one in place. Real production data from the admin account
on one single PC:

```
Chrome / Windows   ...DFdz9LabEM   created 06:15   last_seen 08:29   <- the live one
Chrome / Windows   ...toD3cmPUZD   created 06:08   last_seen 06:08   <- ghost
Chrome / Windows   ...wrQEY_8W52   created 05:56   last_seen 06:02   <- ghost
Chrome / Android   ...xIZ41dkXGK   created 02:06   last_seen 02:06
```

One PC, three rows. The consequences compound:

1. Every real notification was sent 4 times for this one person.
2. **FCM answered `201` for the ghosts.** Push services commonly keep accepting messages for endpoints whose
   subscription is gone, and discard them silently. So the `404/410` cleanup never fired, and the ghosts were
   immortal.
3. Worst of all: the **Test notifications** button reported success if *any* device was accepted. `sent: 4,
   failed: 0`. The PC in front of us was silently broken (as it turned out, by a Windows setting) and the app
   insisted everything was fine. We chased this for hours. §13.

## The fix

Give the browser a name of our own that outlives its address.

`src/push-device.js`:

```js
export const DEVICE_ID_KEY = "oe-device-id";
const VALID = /^[A-Za-z0-9-]{8,64}$/;

function newId(crypto) {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (crypto && typeof crypto.getRandomValues === "function") { /* manual UUIDv4 */ }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deviceId(store, crypto) {
  const ls = store !== undefined ? store : typeof localStorage !== "undefined" ? localStorage : null;
  const c  = crypto !== undefined ? crypto : globalThis.crypto;
  if (!ls) return "";
  try {
    const saved = ls.getItem(DEVICE_ID_KEY);
    if (saved && VALID.test(saved)) return saved;
    const made = newId(c);
    ls.setItem(DEVICE_ID_KEY, made);
    return made;
  } catch (e) {
    return "";   // Safari private mode throws: behave as "no id"
  }
}
```

Design decisions in those few lines, each deliberate:

- **`crypto.randomUUID()`** — the standard, available in secure contexts. Not `Math.random()`, which is neither
  unique enough nor available-by-contract.
- **Two fallbacks** — `getRandomValues` for older Safari and non-secure contexts; a last-resort
  time+random string so the function never throws.
- **`VALID` regex** — `localStorage` is user-writable. A tampered value is replaced rather than trusted. This is
  not paranoia: the id is interpolated into a PostgREST `or=(…)` filter (§8), where a comma or parenthesis would
  change the query's meaning. **Validating here is what makes that interpolation safe.**
- **Returns `""`, not a fresh id, when storage is unusable.** Returning a new random id each call would create a
  new row on every save. `""` means "no device id", and the save falls back to the old endpoint-keyed behaviour —
  which is still correct, just less clever.
- **`store`/`crypto` parameters** — injectable so the test suite can drive it with a fake `localStorage`
  (§27). Testability designed in, not bolted on.

### Scope of a `device_id`

One per **storage partition**, which means one per:

- browser profile (Chrome profile 1 ≠ Chrome profile 2),
- browser (Chrome ≠ Edge ≠ Firefox),
- iOS Home Screen app vs Safari,
- normal window vs private window (private storage is discarded).

It is **not** per user. Two people signing into the same Chrome share the `device_id` and are distinguished by
`user_id` — which is exactly why the unique key is the *pair* `(user_id, device_id)`.

---

# 8. The database design

## The base table

`supabase/migrations/20261006000000_oe_push_subscriptions.sql`:

```sql
create table if not exists oe_push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references oe_profiles(id) on delete cascade,
  endpoint     text not null unique,       -- the push service address for this browser
  p256dh       text not null,              -- the browser's public key (base64url)
  auth         text not null,              -- the browser's auth secret (base64url)
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists oe_push_subscriptions_user on oe_push_subscriptions(user_id);
```

`on delete cascade` means deleting a profile removes their devices — no orphans, no notifications to ex-staff.

## The device_id migration

`supabase/migrations/20261007000003_oe_push_device_id.sql`:

```sql
alter table oe_push_subscriptions add column if not exists device_id text;

create unique index if not exists oe_push_subscriptions_user_device
  on oe_push_subscriptions(user_id, device_id);
```

Four decisions here deserve explanation.

**1. Why `(user_id, device_id)` and not `device_id` alone?**
Two people can share a browser, so the same `device_id` legitimately appears under two users. The *pair* is what
is unique.

**2. Why is the index NOT partial?**
The obvious-looking `where device_id is not null` is wrong, and this is a genuine Postgres trap:

```sql
-- WRONG for our purpose:
create unique index ... on oe_push_subscriptions(user_id, device_id) where device_id is not null;
```

Postgres cannot use a partial index as an `ON CONFLICT` arbiter unless the statement's own `WHERE` clause implies
the predicate. PostgREST sends `on_conflict=user_id,device_id` with no `WHERE`, so a partial index yields
*"there is no unique or exclusion constraint matching the ON CONFLICT specification"* — every save would fail.
A plain index is also perfectly safe, because **nulls do not collide in a Postgres unique index**: all the legacy
rows with `device_id IS NULL` coexist happily. This is verified by a real executed test, not by reasoning (§27).

**3. Why keep `endpoint UNIQUE`?**
Because it is a security property, not an accident. One address belongs to one browser, and therefore to one
account at a time. It is the mechanism that detects "this browser's subscription belongs to someone else" — the
insert fails, and the client reacts by unsubscribing and starting fresh. Removing that constraint would let two
accounts claim the same address.

**4. What about pre-existing rows?**
They keep `device_id = NULL` and keep working. Each browser adopts an id the next time it saves. Nothing is
deleted by the migration — it only adds a column, an index, a comment and a function.

## The write path

`src/push-device.js` declares the writes; `App.jsx` executes them. Splitting them this way exists so the rule can
be unit-tested without a database:

```js
export function pushSaveSteps(row) {
  if (!row.device_id) return [{ op: "upsert", onConflict: "endpoint", row }];
  return [
    { op: "delete", user_id: row.user_id, endpoint: row.endpoint, exceptDevice: row.device_id },
    { op: "upsert", onConflict: "user_id,device_id", row },
  ];
}
```

```js
for (const step of pushSaveSteps(row)) {
  if (step.op === "delete") {
    await c.from("oe_push_subscriptions").delete()
      .eq("user_id", step.user_id).eq("endpoint", step.endpoint)
      .or(`device_id.is.null,device_id.neq.${step.exceptDevice}`);
    continue;
  }
  await ok(c.from("oe_push_subscriptions").upsert(step.row, { onConflict: step.onConflict }));
}
```

Why the delete must come first: `endpoint` is still globally unique. If a row already holds this address under a
*different* `device_id` — or under none, i.e. a legacy row — the insert would violate that constraint. Clearing
it first lets a legacy row be **taken over** instead of blocking the save.

Why `.or("device_id.is.null,device_id.neq.X")` rather than `.neq("device_id", X)`: in SQL, `NULL <> 'x'` is
`NULL`, not `true`, so a plain `neq` would never match legacy rows — the exact rows we most need to adopt.

Why this cannot harm another device: the filter pins `endpoint`, and one address belongs to one browser. Plus
`.eq("user_id", …)` and RLS both scope it to the signed-in person.

## Event-by-event behaviour

| Event | What happens |
|---|---|
| **Device A subscribes** | `delete` matches nothing; insert ⇒ 1 row `(user, A)`. |
| **Device A subscribes again, same endpoint** | `delete` excludes A, matches nothing; upsert conflicts on `(user, A)` ⇒ **updates** the row (incl. `last_seen_at`). Still 1 row. |
| **Device A gets a new endpoint** | `delete` matches nothing (new address); upsert hits `(user, A)` ⇒ `endpoint` updated in place. **Still 1 row** — this is the whole point of the change. |
| **Device B signs into the same account** | Different `device_id` ⇒ 1 new row. A is untouched. **2 devices, both notified.** |
| **Device C too** | 3 rows. No limit. |
| **The same address appears under another `device_id` of the same user** | The `delete` step removes the stale row, then the upsert writes the current device's. Net: 1 row, no duplicate. |
| **Another *user* holds that address** | RLS blocks the delete (0 rows affected), then the insert violates `endpoint`'s unique constraint and throws. The client catches it, unsubscribes, subscribes afresh, and saves a brand-new address. The other account keeps its row. |

That last row is the security case. Without it, signing into a shared PC could hijack the previous person's
notification address.

## The prune function

```sql
create or replace function public.oe_prune_push_subscriptions(p_user_id uuid, p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if p_user_id is null or coalesce(p_days, 0) < 30 then
    return 0;   -- never prune everyone at once, and never with a window short enough to drop a live device
  end if;
  with gone as (
    delete from oe_push_subscriptions
     where user_id = p_user_id
       and last_seen_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*) into n from gone;
  return n;
end;
$$;
revoke all on function public.oe_prune_push_subscriptions(uuid, integer) from public;
grant execute on function public.oe_prune_push_subscriptions(uuid, integer) to service_role;
```

Every clause is a guard rail:

- **`security definer`** — it must delete rows that RLS would hide from the caller, so it runs with the owner's
  rights. That makes it privileged code, so everything below matters.
- **`set search_path = public`** — mandatory hygiene for `security definer`. Without it, a caller who can
  influence `search_path` could point `oe_push_subscriptions` at a table of their own.
- **`p_user_id is null → 0`** — makes a global wipe impossible, even by accident. There is no code path that
  deletes everyone's devices.
- **`p_days < 30 → 0`** — a mistyped `0` or `1` cannot delete live devices.
- **`revoke … from public` + grant only to `service_role`** — users and the anon role cannot call it at all. Only
  the Edge Function can, and it passes the caller's own id.
- **Returns a count** so it is observable (`pruned` in the test response) instead of silent.

---

# 9. Multi-device engineering

## The principle

> **A USER is not a DEVICE.**

```
Admin (one person, one account)
├── Office Windows PC   (Chrome)    -> notify
├── Home laptop         (Edge)      -> notify
├── Android phone       (Chrome)    -> notify
└── iPhone              (Home Screen app) -> notify
```

The data model must therefore be `one user → many device subscriptions`, with no exceptions and no cap.

## Why "all devices" is the right answer

For an approval system, the cost of each error is asymmetric:

- A notification arriving on a device you aren't using: mildly redundant. The OS clears it, and `tag` collapses
  repeats per device.
- A notification **not** arriving on the device you *are* using: a request sits unapproved. That's the failure
  that matters.

Any "pick the best device" heuristic has to guess which device the person is holding. Servers cannot know that.
Last-seen is a terrible proxy — someone can sign in on a laptop at 9 a.m. and spend the day on their phone. So we
don't guess: we notify everything and let each OS handle presentation.

This is implemented in one small, well-tested function:

```js
export function targetSubscriptions(subs, endpoint) {
  const all = Array.isArray(subs) ? subs : [];
  if (!endpoint) return all;                                   // real notifications: every device
  return all.filter((s) => s && s.endpoint === endpoint);      // a device test: only the device that asked
}
```

`subs` is already restricted to the recipients by the caller, so this function can never *widen* who is reached —
only narrow it. That invariant is what makes it safe to accept an endpoint from the client (§11).

## Why we did *not* add a device cap

A cap (say "3 devices per user") looks like hygiene and is actually a bug generator:

- It punishes legitimate use. Admin and Top Management really do use four devices.
- It forces an eviction policy, and any policy will sometimes evict the device the person is holding — producing
  "notifications randomly stopped working", the worst kind of bug report.
- It treats a symptom. Our row growth was never caused by real devices; it was caused by **mis-identifying one
  device as many**. Fixing identity (§7) made the symptom disappear.

> Don't cap a resource to work around a bug in how you count it.

---

# 10. Recipient logic

**This logic was not changed by the device_id work.** It is reproduced here from
`supabase/functions/oe-push/index.ts` so it can be reasoned about, not reinterpreted.

Roles come from `oe_role_permissions` (`20260928000000_oe_schema.sql`):

| Role | Label | Has `requests.approve`? |
|---|---|---|
| `admin` | Administrator | **Yes** |
| `tm` | Top management | **Yes** |
| `accounting` | Accounting | No |
| `liaison` | Liaison | No |
| `viewer` | Auditor (read only) | No |

## `submitted` — a request needs approval

Triggered by `createRequest()` and by `updateRequest()` ("an edit sends the request back for approval").

```ts
if (r.status !== "on_hold") return json({ error: "The request is not waiting for approval." }, 409);
const { data: isAdmin } = await asCaller.rpc("oe_is_admin");
if (r.liaison_id !== callerId && isAdmin !== true)
  return json({ error: "Only the person who filed the request can send this." }, 403);

const approverRoles = new Set((roles || [])
  .filter((x) => x.role === "admin" || (Array.isArray(x.permissions) && x.permissions.includes("requests.approve")))
  .map((x) => x.role));
const { data: people } = await admin.from("oe_profiles").select("id, role").eq("is_active", true);
recipients = (people || []).filter((p) => approverRoles.has(p.role) && p.id !== callerId).map((p) => p.id);
```

- **Who receives:** every **active** profile whose role is `admin` or `tm` — **except the caller**.
- **Who does not:** the filer; inactive profiles; `accounting`, `liaison`, `viewer`.
- **Guards:** the request must actually be `on_hold`, and the caller must be its liaison or an admin.
- **Payload:** `title: "Request for approval"`, `body: "<ref> from <liaison_name>, ₱<requested>"`,
  `url: "/approvals"`, `tag: "oe-req-<id>"`, `badge: <count of on_hold requests>`.

**Why the filer is excluded:** they just pressed the button. Telling them what they did is noise, and noise
trains people to ignore notifications. It also has a practical consequence for testing — an admin who files a
request *themselves* may legitimately get no notification at all, because they were the only recipient and were
excluded. We hit exactly this confusion in §13.

> **Documented deviation worth knowing:** `submitted` notifies **all** approver-role users, not only the next
> approver in the app's escalation chain. The app's own `nextStep(...)` logic (used for the sidebar badges and the
> Approvals list) is more granular than the push fan-out. This is the current intended behaviour — a request
> waiting for approval is visible to everyone who could approve it — but if you ever make push follow the
> escalation chain, this is the line to change, and §27's test expectations will need updating too.

## `approved`

```ts
const { data: mayApprove } = await asCaller.rpc("oe_has_perm", { p: "requests.approve" });
if (mayApprove !== true) return json({ error: "Your role can't send this." }, 403);
if (event === "approved" && r.status !== "open") return json({ error: "The request is not in that state." }, 409);
if (r.liaison_id !== callerId) recipients = [r.liaison_id];
```

- **Who receives:** the person who filed it (the liaison) — unless they are the approver, in which case nobody.
- **Payload:** `title: "<ref> approved"`, `body: "Approved for ₱<approved>. Next: enter the ERP reference."`,
  `url: "/requests"`.

## `rejected`

Same authorisation; requires `status === "rejected"`.

- **Who receives:** the liaison who filed it (unless they are the caller).
- **Payload:** `title: "<ref> rejected"`, `body: "Open the request to see the reason."`, `url: "/requests"`.

## `test`

- **Who receives:** the caller only. With an `endpoint`, only that one device (§11).
- **Payload:** `title: "Notifications are on"`,
  `body: "You'll be told here when a request needs your attention."`, `url: "/requests"`, `tag: "oe-test"`.

## Recipient matrix

| Event | Triggered by | Recipients | Explicitly excluded | Lands on |
|---|---|---|---|---|
| `submitted` | filer (liaison) or an admin | all active `admin` + `tm` | the caller, inactive users, `accounting`, `liaison`, `viewer` | `/approvals` |
| `approved` | a user with `requests.approve` | the request's liaison | the caller if they are the liaison | `/requests` |
| `rejected` | a user with `requests.approve` | the request's liaison | the caller if they are the liaison | `/requests` |
| `test` | anyone signed in | the caller's own device(s) | everyone else | `/requests` |

**Everything is verified server-side with the caller's own JWT.** The client sends an event name and a request id;
it does not and cannot nominate recipients. A compromised browser cannot make the server notify arbitrary people.

```ts
const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, ... });
const { data: userData, error: userErr } = await asCaller.auth.getUser();
if (userErr || !userData?.user) return json({ error: "Your session has ended. Sign in again." }, 401);
const callerId = userData.user.id;
```

Note the two-client pattern: `asCaller` (anon key + the caller's token, so RLS and `oe_is_admin()` /
`oe_has_perm()` evaluate as *them*) and `admin` (service role, for reading other people's device rows). Using the
right client for the right question is the whole authorisation design.

---

# 11. The Test Notification fix

> **Since 8 October 2026 there is no longer a "Test notifications" button.** The device test was removed from
> the side panel in both live and demo mode once push was confirmed working, because turning notifications on
> already runs exactly the same check. The `test` event, the device-scoped targeting and all the reporting below
> are still in the code and still run — only the manual trigger is gone. Read "Test notifications" in this
> section as "the test that runs when someone turns notifications on", and see §15 for that flow.

## The old behaviour, and why it was actively harmful

```
Test notifications
  -> POST { event: "test" }
  -> function sends to ALL of this user's devices        (4 of them)
  -> Android phone accepts                              (201)
  -> response: sent: 4, failed: 0
  -> UI: "The push service accepted it."                 <- GREEN
  -> the Windows PC in front of you shows nothing
```

The old UI condition was simply `if (r && r.sent === 0)`. One success anywhere was reported as success. For a
button whose entire purpose is *"is this device working?"*, that is the wrong question answered confidently.

This cost us the most time of anything in this project. We had a **green success message** while the device was
broken, so we repeatedly concluded the app was fine and went looking elsewhere. A diagnostic that can be wrong in
the reassuring direction is worse than no diagnostic.

## The new behaviour

```
Test notifications
  -> pushSubscribe() -> sub.endpoint          (this browser, right now)
  -> POST { event: "test", endpoint: "<this device's address>" }
  -> targetSubscriptions(subs, endpoint) -> exactly 1 row (or none)
  -> response describes THAT device
  -> UI: "... fcm.googleapis.com accepted it (this device: 201)."
```

Client:

```js
const sub = await pushSubscribe(api);
r = await api.pushTest(sub.endpoint);
```
```js
async pushTest(endpoint) {
  const { data, error } = await c.functions.invoke("oe-push",
    { body: { event: "test", endpoint: endpoint || null }, timeout: 25_000 });
  ...
}
```

Server:

```ts
const testEndpoint = event === "test" && typeof body?.endpoint === "string" ? body.endpoint : "";
// ...
const targets = targetSubscriptions((subs || []) as Sub[], testEndpoint) as Sub[];
```

The endpoint is only ever used to **filter rows already restricted to the recipients**, so passing someone
else's address cannot reach them — it simply matches nothing. (And since `event === "test"` ⇒ `recipients ===
[callerId]`, the filter is applied to your own devices only.)

Response for a device test:

```json
{
  "event": "test",
  "scope": "device",
  "devices": 4,
  "recipients": 1,
  "sent": 1,
  "failed": 0,
  "removed": 0,
  "pruned": 0,
  "device": {
    "status": 201,
    "service": "fcm.googleapis.com",
    "note": "",
    "device_id": "6292affb-…",
    "endpoint_tail": "…DFdz9LabEM",
    "text": "this device: 201"
  },
  "details": [{ "service": "fcm.googleapis.com", "status": 201, "device": "…DFdz9LabEM" }]
}
```

```js
export function deviceResult(detail, sub) {
  if (!detail) return { status: "not registered", text: "this device: not registered", ... };
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
```

## Reading the result

| Result | Means | What to do |
|---|---|---|
| `this device: 201` | The push service accepted the message **for this device**. | If no banner appears, the fault is now provably in the browser or the OS (§13, §14). |
| `this device: 410 -- subscription expired` | The subscription is dead. The row has been deleted. | Turn notifications off and on again to re-subscribe. |
| `this device: 404 -- subscription expired` | Same; the service has never heard of it. | As above. |
| `this device: 403` | VAPID mismatch — frontend key and function key pair disagree. | Check `VITE_VAPID_PUBLIC_KEY` against the Supabase secrets (§3). |
| `this device: 429` | Rate limited by the push service. | Wait and retry. |
| `this device: error` | Network failure or the 15 s per-service timeout. | Check connectivity; retry. |
| `this device: not registered` | No row matched this browser's address. | The save failed, or the row was just removed. Turn notifications off and on again. |

## Backward compatibility

The frontend and the Edge Function deploy separately, so for a while a new frontend may talk to an old function.
Handled explicitly:

```js
const perDevice = !!(r && r.scope === "device");   // an older oe-push build still answers for every device
const reached = perDevice ? r.sent === 1 : !!(r && r.sent > 0);
```

Without that check, a new frontend plus an old function would report `sent: 4` against a `=== 1` test and claim
failure on a working device — swapping a false positive for a false negative. Both are bugs. The fallback keeps
the old wording until the function catches up, which is also a handy way to tell whether the function was
actually deployed (§26).

## Why this is better engineering

1. **The test answers the question asked.** "Does *this* device work?" not "does *any* device work?"
2. **It cannot be misleading in the reassuring direction.** Silence is now reported as failure.
3. **It names the layer.** `201` vs `410` vs `403` points at the OS, the subscription, or the keys respectively.
4. **It is observable.** The console line carries `device_id`, endpoint tail, service, status and counts — enough
   to diagnose without a debugger, and enough to correlate with a database row.

---

# 12. Push response codes

## ELI5

`201` means *the courier took the envelope*. It does **not** mean the letter was read, or even delivered. Those
are later, invisible steps.

## The codes

| Code | Meaning | What our code does |
|---|---|---|
| **201 Created** | Accepted for delivery. The normal success. | `sent++` |
| **200 / 202** | Also accepted by some services. | `sent++` (we test `res.ok`, i.e. any 2xx) |
| **400** | Malformed request/headers. A bug on our side. | `failed++`, note kept |
| **403** | VAPID signature/key mismatch. | `failed++` |
| **404 Not Found** | The push service never heard of this subscription. | **row deleted** (`isGone`) |
| **410 Gone** | The subscription existed and is now permanently dead. | **row deleted** (`isGone`) |
| **413** | Payload too large (we also pre-check `> 3993` bytes locally). | `failed++` |
| **429** | Rate limited. | `failed++` — retried naturally by the next event |
| `"error"` | Network failure, DNS, or our 15 s `AbortSignal.timeout`. | `failed++`, message kept (160 chars) |

```ts
export const isGone = (status) => status === 404 || status === 410;
```
```ts
if (res.ok) sent++;
else if (isGone(res.status)) gone.push(s.id);
else failed++;
// ...
if (gone.length) await admin.from("oe_push_subscriptions").delete().in("id", gone);
```

Only `404/410` delete a row. A `429` or a timeout must **never** delete a subscription — that would turn a
transient blip into permanent notification loss.

## The crucial caveat

```
Application            -> we control
     |
Edge Function          -> we control
     |
Push Provider          -> answers 201  ============ OUR VISIBILITY ENDS HERE
     |
Browser                -> must be running / allowed in background
     |
Operating System       -> per-app settings, Do not disturb, focus rules
     |
Notification UI        -> the banner the user actually sees
```

**A `201` proves acceptance at stage 3 of 6.** Everything after it is invisible to the server. There is no
delivery receipt in Web Push — no read receipt, no "was it displayed" callback. If the browser is closed, the
message waits (our `TTL` is 24 h). If the OS has notifications disabled for that browser, the message is
delivered, `showNotification()` resolves successfully, and **nothing appears**.

That last sentence is the entire content of §13. Internalise it and you will never again spend a day debugging a
server that was working.

---

# 13. Case study: the Chrome/Windows incident

A real debugging session, including the wrong turns, because the wrong turns are the instructive part.

## Symptom

> "I signed in as admin and clicked Test notification — it was supposed to slide a notification window in,
> but it won't."

Later refined to: Edge showed notifications; Chrome, on the same PC, showed nothing.

## What we checked, in order, and what each step eliminated

**1. Is the system even deployed?** Probed the function unauthenticated:

```bash
curl -s -X OPTIONS "$URL/functions/v1/oe-push"                 # -> 200
curl -s -X POST "$URL/functions/v1/oe-push" -d '{"event":"test"}'  # -> 401 {"error":"Sign in first."}
```

Deployed, and running code recent enough to produce that exact message. ✔

**2. Are the VAPID secrets set?** Sent a deliberately invalid bearer token. The function checks secrets *before*
the session, so the answer distinguishes the two:

```bash
curl -s -X POST "$URL/functions/v1/oe-push" -H "Authorization: Bearer not-a-real-token" -d '{"event":"test"}'
# -> 401 {"error":"Your session has ended. Sign in again."}   (NOT "Push keys are not configured")
```

It got past the VAPID guard ⇒ all three secrets are present. ✔ *No secret was ever read to learn this.*

**3. Does the deployed frontend carry the right public key?** Fetched the live bundle and compared with `.env`:
identical. So no key mismatch. ✔

**4. Is the service worker served correctly?** `/sw.js` → `200`, `Cache-Control: no-cache`,
`application/javascript`, containing `importScripts("sw-push.js")`; `/sw-push.js` → `200`, correct type. ✔

At this point everything the server controls was verified. The bug had to be in the last mile.

**5. First wrong turn — "another device's success is masking this one".** Querying
`oe_push_subscriptions` revealed four devices on the admin account, including two ghost Chrome rows. Since the
old test reported success if *any* device was accepted, this looked like the whole answer. It was a **real bug**
(and we fixed it, §7/§11) but it was **not this bug** — the console showed:

```
oe-push test { event: 'test', recipients: 1, sent: 4, failed: 0, removed: 0, … }
my endpoint tail: DFdz9LabEM
```

`sent: 4` with `failed: 0` meant *all four*, including this PC's current endpoint, were accepted. The masking
theory was disproven by its own evidence. Noted and moved on.

**6. Second wrong turn — "the network is blocking FCM".** A compelling theory: Edge uses WNS over 443; Chrome
needs a persistent FCM connection on 5228–5230, which corporate networks often block. That would produce
*exactly* this signature — `201` accepted, never delivered. Tested it:

```powershell
foreach ($p in 5228,5229,5230) { Test-NetConnection -ComputerName mtalk.google.com -Port $p }
# -> True, True, True
```

All reachable. Theory dead. ✔ *Two minutes to kill a plausible theory is a bargain.*

**7. The real discovery — Chrome and Edge were different people.** Joining devices to profiles:

| Browser | Account | Role |
|---|---|---|
| Chrome (Windows), Chrome (Android) | the admin account | `admin` |
| **Edge (Windows), iPhone** | **a different account** | `liaison` |

So "approved notifications pop in Edge" was *correct behaviour*: `approved` notifies the **liaison who filed the
request**, and that person is the Edge/iPhone user — not the admin. Nothing was wrong there at all.

**8. Confirming the admin really should have been notified.** Checked the requests table: `REQ-2026-0016` was
filed at 12:52:44 **by the liaison**, status `on_hold`. A genuine `submitted` trigger, with the admin an eligible
recipient (different person, so not self-excluded). The admin's Chrome row had been refreshed at 12:48:41 — four
minutes earlier, so it was live. And the row **still existed** afterwards, which means FCM did not answer
404/410. So the message was accepted for Chrome and Chrome displayed nothing.

Every server-side layer was now eliminated by evidence rather than assumption.

**9. The decisive local test.** Isolating "delivery" from "display" with one line in Chrome's console:

```js
navigator.serviceWorker.ready.then(r => r.showNotification("Chrome local test", { body: "…" }))
```

This bypasses the server, the push service and the network entirely. If **this** draws no banner, the fault is
Windows/Chrome. It drew nothing.

## Root cause

**Chrome was disabled in Windows notification settings.** Windows 11 notification settings are **per
application**, and Edge's entry was enabled while Chrome's was not. Per-app, and silent — nothing in the browser
or the app reports it.

> **Nothing was wrong with the push architecture.** The only app-level defect was the misleading test, which kept
> insisting the device was fine.

## Lessons

1. **Isolate layers before changing code.** Every step above eliminated one layer with evidence. We shipped no
   speculative code fix for a problem that turned out to be a checkbox.
2. **Two plausible theories were wrong, and that was fine** — because each was cheap to test. Prefer the
   two-minute falsifiable test over the one-hour "probably this" refactor.
3. **A success message you cannot trust is worse than no message.** The green toast actively misdirected us for
   hours. Fixing that was the most valuable change in the whole project.
4. **Context beats code.** The real breakthrough was noticing that two browsers were two different *people*.
   That fact was in the database all along, not in the code.
5. **Test the exact device.** "It works on my phone" is not evidence about a PC.
6. **Not every bug is in your code — but prove it before you say so.** It is only acceptable to blame the OS
   after you have eliminated your own layers. We did, in order, and only then.

---

# 14. Debugging playbook

Work **top to bottom**. Each step eliminates a layer. Do not skip ahead, and do not change code until a step
actually fails.

### A. Is it even offered?

1. **Is `VITE_VAPID_PUBLIC_KEY` set in this build?** If empty, the bar and button never appear, by design.
   Check: `grep -o 'VITE_VAPID_PUBLIC_KEY:`[^`]*`' ` on the deployed bundle, or DevTools → Sources.
2. **Live mode, not demo?** `push.offered` requires `api.mode === "live"`.
3. **Is there a service worker?** `npm run dev` has none — use `npm run preview` or the live URL.

### B. The browser's own state

Run this in the Console on the live site:

```js
(async () => {
  const r = await navigator.serviceWorker.ready;
  const s = await r.pushManager.getSubscription();
  console.log("permission:", Notification.permission);
  console.log("active SW:", r.active && r.active.scriptURL);
  console.log("waiting SW (update pending):", !!r.waiting);
  console.log("device_id:", localStorage.getItem("oe-device-id"));
  console.log("my endpoint tail:", s ? s.endpoint.slice(-10) : "NO SUBSCRIPTION");
})()
```

4. `permission` must be `"granted"`.
5. `active SW` must be `…/sw.js`. `waiting SW: true` means an update is pending — apply it; an old worker may
   predate the push handler.
6. `device_id` should be a UUID. `null` means storage is blocked or was cleared.
7. `NO SUBSCRIPTION` ⇒ press *Turn on notifications* again.

### C. Database

8. **Is there a row for this device?** Match the endpoint tail and `device_id`:

```sql
select p.email, s.device_id, right(s.endpoint, 10) as tail, s.user_agent, s.last_seen_at
  from oe_push_subscriptions s join oe_profiles p on p.id = s.user_id
 order by s.last_seen_at desc;
```

Or via `supabase db query --linked "<sql>"`. Check `user_id` is the account you think you're signed in as —
this is where the §13 breakthrough came from.

### D. Server

9. **Is the Edge Function deployed, with secrets?**
   ```bash
   curl -s -X POST "$SUPABASE_URL/functions/v1/oe-push" \
        -H "Authorization: Bearer not-a-real-token" -H "Content-Type: application/json" \
        -d '{"event":"test"}'
   ```
   `"Push keys are not configured"` ⇒ secrets missing. `"Your session has ended"` ⇒ secrets fine.
   A 404 from the platform ⇒ the function is not deployed.
10. **Is the migration applied?** If `device_id` is missing, every save fails with a PostgREST
    "no unique or exclusion constraint matching the ON CONFLICT specification" error.

### E. The push service

11. **Turn notifications off and on again, then read the toast and console.** (There is no longer a Test
    notifications button — turning them on runs the same device test.) `this device: 201` ⇒ accepted; go to F.
    `410/404` ⇒ re-subscribe. `403` ⇒ VAPID mismatch. `not registered` ⇒ back to C.

### F. Browser transport and OS — where §13 actually ended

12. **Is the browser running?** Push needs a live browser process. Enable
    *Chrome/Edge → Settings → System → Continue running background apps when the browser is closed*.
13. **Is the browser connected to its push service?**
    - Chrome: **`chrome://gcm-internals`** → *Connection State* should be **CONNECTED** with a recent
      "Last connection time"; the **Receive Message Log** at the bottom should show an entry at the time you
      tested. No entry ⇒ it never reached Chrome.
    - Edge: `edge://gcm-internals` (Edge also uses WNS; registration issues show in Windows' own settings).
14. **Does the OS draw a banner at all?** The decisive isolation test:
    ```js
    navigator.serviceWorker.ready.then(r => r.showNotification("Local test", { body: "OS display works." }))
    ```
    No banner ⇒ stop looking at the app.
15. **Windows (per application!)** → Settings → System → Notifications:
    - master toggle **On**;
    - click the **application's name** (not just its toggle) and confirm **Show notification banners** is ticked
      — banner off + centre on produces "nothing slides in, but it's in `Win`+`N`";
    - the app must be present in the list at all.
16. **Do not disturb / Focus assist** off — including *"Turn on do not disturb automatically"* rules (duplicating
    a display, gaming, scheduled hours) and any active Focus session in the Clock app.
17. **Browser site permission:** `chrome://settings/content/notifications` → the site must be under *Allowed*,
    and "quieter messaging" can hide prompts.
18. **iOS:** is the app on the **Home Screen** and opened from there? Safari alone cannot do push.
19. **Check `Win` + `N`** (Notification Center) — if it's there, delivery worked and only the banner is suppressed.

### G. The tap

20. Notification appears but opens the wrong place: check `data.url` in the payload and `pageFromPath()`
    (§21); confirm `vercel.json` has a rewrite for that path.

## Quick reference URLs

| URL | Use |
|---|---|
| `chrome://gcm-internals` | Is Chrome connected to FCM? Did the message arrive? |
| `chrome://settings/content/notifications` | Site-level permission |
| `chrome://serviceworker-internals` | Inspect/unregister workers |
| `edge://gcm-internals`, `edge://settings/content/notifications` | Edge equivalents |
| DevTools → Application → Service Workers | Active/waiting worker, "Update on reload", Unregister |
| Windows Settings → System → Notifications | **Per-app** banner settings, Do not disturb |

---

# 15. Permission flow and timeouts

## Why we don't ask on page load

An immediate `requestPermission()` is the classic anti-pattern:

- The person has no idea what they'd be agreeing to, so they click **Block**.
- `denied` is **sticky**. It cannot be undone from JavaScript — the user must go into browser settings. One
  badly-timed prompt permanently removes your ability to notify that person on that browser.
- Chrome and Edge punish sites that do it with "quieter messaging", which hides future prompts behind an
  address-bar icon.

So we explain first, with a bar that states the benefit in the person's own terms:

```js
title = push.approver
  ? "Turn on notifications so you know when a request needs your approval"
  : "Turn on notifications to hear when your requests are approved or rejected";
```

Note the role-awareness: `usePush(api, auth.status === "ready", can("requests.approve"))`. Approvers are told
"Approvers need this on."

## When the bar shows

```js
const show = ready && !later && (offered ? perm === "default" || perm === "denied" : iosNeedsInstall);
```

- `ready` — signed in and loaded. Never on the sign-in page.
- `!later` — **Not now** sets `sessionStorage["oe-push-later"]`, hiding it for that tab's session. Session, not
  permanent: a deliberate middle ground between nagging and forgetting.
- `perm === "default"` (not yet asked) **or** `"denied"` (blocked — shows *where* to unblock).
- Already `granted` ⇒ no bar; the subscription is refreshed silently instead:

```js
useEffect(() => {
  if (offered && ready && perm === "granted") pushSubscribe(api).catch(() => {});
}, [offered, ready, perm, api]);
```

That effect is why `last_seen_at` stays current on every sign-in — which in turn is what makes the 90-day prune
safe (§24).

## The "quiet prompt" problem and the 6-second hint

Chrome/Edge may hide the permission request behind a small bell icon in the address bar. The promise from
`requestPermission()` then stays **pending indefinitely** — until the person notices the icon. A naive
implementation leaves the button spinning forever.

```js
const askPermission = (onWaiting) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (p) => { if (done) return; done = true;
      clearInterval(poll); clearTimeout(hint); clearTimeout(giveUp); resolve(p); };

    Notification.requestPermission().then(finish, () => finish(Notification.permission));

    // some browsers settle the permission without ever resolving the promise: watch the value as well
    const poll    = setInterval(() => Notification.permission !== "default" && finish(Notification.permission), 500);
    const hint    = setTimeout(() => Notification.permission === "default" && onWaiting(), 6000);
    const giveUp  = setTimeout(() => finish(Notification.permission), 10 * 60_000);
  });
```

Three mechanisms:

- **The 6-second hint is not a timeout.** It does not cancel anything. After 6 s with the permission still
  `default`, `onWaiting()` fires, which frees the button and shows:
  > "Your browser is hiding the permission request: click the bell or notification icon in the address bar and
  > choose Allow. It carries on by itself once you do."

  Six seconds is long enough that a normal prompt-and-click never triggers it, short enough that nobody stares at
  a dead button. **The original promise is still live** — when the person finally clicks Allow, the flow resumes
  and the test notification is still sent.
- **The 500 ms poll** covers browsers that change `Notification.permission` without ever resolving the promise.
  Defensive, cheap, and cleaned up on every exit path.
- **The 10-minute give-up** stops the promise leaking forever.

There is also re-entrancy protection, because the prompt can only be open once:

```js
if (asking.current) return ui.err(QUIET_HINT);   // the earlier request is still open in the address bar
```

## Every timeout in the system, and its purpose

| Timeout | Where | Why |
|---|---|---|
| **6 s** | permission hint | Reveal a hidden prompt; frees the UI without cancelling |
| **500 ms** poll | permission | Browsers that settle without resolving |
| **10 min** | permission give-up | Don't leak a pending promise |
| **8 s** | `navigator.serviceWorker.ready` | A worker that never activates would hang forever |
| **20 s** | `pushManager.subscribe()` | Chrome/Edge/Brave can *wait* rather than fail when their push service is blocked |
| **15 s** | `sendPush` per service | One dead service must not hold the function (or the waiting person) |
| **25 s** | `pushTest` invoke | Deliberately **longer** than the function's internal 15 s, so a slow service is *reported* rather than waited on |
| **30 s** | `notify` invoke | Fire-and-forget; generous because nobody is watching |
| **12 h** | VAPID token `exp` | Services reject > 24 h |
| **24 h** | push `TTL` | Hold for an offline device; deliver when it comes back |

> **Why timeouts matter here:** almost every layer is a third party — a push service, a browser's internal
> machinery, a person reading a dialog. Any of them can simply never answer. The 25 s/15 s pairing is the pattern
> to remember: **the outer timeout must exceed the inner one**, or you lose the inner layer's diagnosis and
> replace a precise error with a useless "no answer from the server".

---

# 16. Logout behaviour

## Three things that are often confused

| Thing | Owned by | Survives sign-out? | Cleared by |
|---|---|---|---|
| **Browser notification permission** | the browser, per origin | **Yes** | only the user, in browser settings |
| **Application auth session** | Supabase Auth, in browser storage | No — that's the point | sign-out, idle timeout, expiry |
| **Push subscription** | the browser + its push service | **Yes** (the browser keeps it) | `unsubscribe()`, clearing site data, uninstalling |

Our **database row** is a fourth, separate thing, and it is the only one sign-out actually touches.

## What sign-out does

```js
const signOut = useCallback(async (message) => {
  // Signing out on purpose stops this device's notifications (a shared computer must not keep showing them).
  // The idle timeout passes a message and keeps them: working in another tab or browser for 30 minutes must
  // not switch notifications off; the notification then opens the sign-in page and, after it, the right page.
  if (typeof message !== "string" && api.mode === "live" && PUSH_SUPPORTED) await pushForget(api);
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  ...
```

**There are two kinds of sign-out, and they behave differently on purpose.** The `message` argument is the
discriminator:

- **Explicit "Sign out"** (no message) ⇒ `pushForget()` runs ⇒ the device's **database row is deleted**.
  Rationale: a shared office PC must stop showing another person's approvals the moment they sign out.
- **Idle timeout** (30 min, passes a message) ⇒ the row is **kept**. Rationale: being idle in this tab while
  working in another browser must not silently disable notifications. The notification still arrives, opens the
  sign-in page, and after signing in lands on the right page.

That distinction is subtle, intentional, and easy to destroy by "simplifying" `signOut`. Leave it alone.

```js
async function pushForget(api) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await api.removePushSubscription(sub.endpoint);
  } catch (e) { /* best effort */ }
}
```

## Answering the specific questions

- **Does logout delete the push subscription?** No. It deletes the **database row**. `pushForget` does *not* call
  `sub.unsubscribe()` — the browser keeps its subscription and endpoint.
- **Does it delete the database device row?** Yes, on an explicit sign-out. No, on an idle timeout.
- **Does `device_id` remain in `localStorage`?** **Yes.** It is per-browser, not per-session, and is never
  removed by the app. That's the design: the same browser must be recognisable across sign-ins.
- **What happens on sign-in again?** `perm === "granted"` ⇒ the effect calls `pushSubscribe()` ⇒ the *same*
  endpoint and the *same* `device_id` are saved ⇒ exactly one row reappears. No new device, no duplicate.
- **What if a different user signs in on that browser?** Same `device_id`, different `user_id` ⇒ a separate row,
  because the unique key is the pair. See §19 for the endpoint-collision mechanics.
- **Can user A's subscription stay attached to user B?** No. Rows are keyed by `user_id`, RLS forbids writing
  another user's row, and `endpoint UNIQUE` means two accounts cannot hold the same address — the second save
  fails and the client re-subscribes to a fresh address.
- **What happens to notifications while logged out?** After an explicit sign-out: none, the row is gone. After an
  idle timeout: they keep arriving and open the sign-in page.
- **What happens to the browser permission?** Untouched. Still `granted`. This is why signing back in needs no
  prompt — and why "I signed out, so notifications must be off" is wrong on an idle timeout.

---

# 17. Clear site data

When the user clears cookies/cache/site storage for the origin:

| Thing | Result |
|---|---|
| `localStorage` | **Wiped** — including `oe-device-id` |
| `device_id` | Gone ⇒ a **new** one is generated on the next save ⇒ a **new row** |
| Auth session | Gone ⇒ must sign in again |
| Service worker | **Unregistered** |
| Push subscription | **Gone** with the worker ⇒ the old endpoint becomes invalid |
| Notification permission | Usually **kept** — it is a site *permission*, not storage. But some browser UIs ("Delete data" from site settings, "Reset permissions") clear it too. Verify rather than assume. |
| Database row | **Remains**, now pointing at a dead endpoint |

## What the system does when the browser comes back

1. The person signs in. `Notification.permission` is often still `granted`, so `pushSubscribe()` runs silently.
2. No `device_id` in storage ⇒ a fresh UUID is generated and stored.
3. No subscription exists ⇒ the browser creates one with a **new endpoint**.
4. The save writes a **new row** — new `device_id`, new endpoint. Correct: as far as we can tell, this *is* a new
   device. There is no honest way to know otherwise; that information was in the storage the user deleted.
5. The old row lingers, pointing at a dead address.

## Why the stale row is not a problem

- The old endpoint is genuinely dead, so the next real notification gets **404/410** and the row is deleted
  automatically (§12).
- If the push service keeps answering `201` for it (FCM does this), the **90-day prune** eventually removes it —
  because `last_seen_at` is only refreshed by a successful save, which that browser will never do again.

Two independent cleanup mechanisms, because one of them is unreliable for reasons outside our control.

---

# 18. Uninstall / reinstall

| Action | `device_id` | Endpoint | Database | Notifications after? |
|---|---|---|---|---|
| **Desktop: clears site data** | New one next time | New | Old row stale; new row created | Yes, after signing in again |
| **Android: removes the installed PWA** | Usually **kept** (the installed app shares the Chrome profile's storage for the origin) | Usually kept while Chrome's subscription survives | Same row reused | Yes — often with no visible change |
| **iPhone: removes the Home Screen app** | **Lost** (that app has its own storage) | Lost | Old row stale | Only after reinstalling and allowing again |
| **Reinstall on iPhone** | **New** `device_id` | New endpoint | **New row**; the old one is stale | Yes, after *Turn on notifications* in the installed app |
| **New phone entirely** | New | New | New row; old row stale until cleaned | Yes, once signed in and allowed |

The asymmetry between Android and iOS is pure platform behaviour: an iOS Home Screen web app is a separate
storage partition from Safari, whereas an Android WebAPK shares the browser profile's storage for that origin.
(Both are platform details that could change; the system does not depend on either being true.)

## Why the backend must simply tolerate all of this

The backend cannot distinguish "reinstalled" from "new device" and **should not try**. The required property is
not accuracy about device history — it is *convergence*:

```
unsubscribe      -> the row's endpoint dies -> 404/410 -> row deleted
reinstall        -> a new device_id         -> a new row
new endpoint     -> same device_id          -> the same row, updated
an old row       -> 404/410 or 90 days      -> deleted
```

Every transition ends in a correct steady state, from any starting point, with no manual intervention and no
cross-device damage. Design for convergence, not for perfect knowledge.

---

# 19. Multiple users on one browser

```
Chrome on the office PC
  User A signs in  -> device_id D (localStorage, shared by the browser)
                   -> row (A, D, endpoint E1)
  User A signs out -> row (A, D, E1) DELETED by pushForget
  User B signs in  -> same device_id D, different user
                   -> delete step: no row holds E1 any more
                   -> upsert on (B, D)  -> row (B, D, E1)
```

Clean. One row, correctly owned, and A receives nothing on that PC.

## The interesting case: A's row still exists

If A left by **idle timeout**, their row was deliberately kept. Then:

```
  row (A, D, E1) still present
  User B signs in -> same device_id D, same endpoint E1
                  -> delete: endpoint E1 matches, but RLS scopes it to B's rows -> 0 rows deleted
                  -> insert (B, D, E1) -> VIOLATES endpoint UNIQUE -> throws
                  -> client catch: sub.unsubscribe(); drop(E1); subscribe() -> NEW endpoint E2
                  -> save (B, D, E2) -> success
```

Result:

- B gets a working row with a fresh address.
- A's row still holds E1 — but the browser **unsubscribed** from E1, so it is dead. A receives nothing. The row
  is removed on the next 404/410, or by the 90-day prune.
- The two rows share `device_id` D but differ in `user_id`, which the `(user_id, device_id)` unique index allows
  by design.

**A never receives B's notifications, and B never receives A's.** That is the ownership guarantee, and it is
enforced by three independent mechanisms:

1. **RLS** — you can only read/write/delete rows where `user_id = auth.uid()`.
2. **`endpoint UNIQUE`** — two accounts cannot hold the same address; the second save fails loudly instead of
   silently stealing it.
3. **The client's reaction to that failure** — unsubscribe and start a genuinely new subscription, rather than
   retrying or forcing.

> This is why the push endpoint must never be treated as permanently owned by one account. It is owned by whoever
> currently has a *valid* subscription to it, and the database must be able to say "that's not yours".

---

# 20. Multiple browsers on one PC

```
One Windows PC
├── Chrome   -> own storage, own permission, own SW -> device_id D1 -> FCM endpoint -> row 1
├── Edge     -> own storage, own permission, own SW -> device_id D2 -> WNS endpoint -> row 2
└── Firefox  -> own storage, own permission, own SW -> device_id D3 -> Mozilla endpoint -> row 3
```

Each browser is an independent world:

- **Separate `localStorage`** ⇒ separate `device_id`. There is no shared machine identity available to web code
  (and that is a privacy feature, not a gap).
- **Separate permission** ⇒ allowing in Chrome does nothing for Edge.
- **Separate service worker registration** ⇒ separate subscription.
- **Different push providers** ⇒ *different infrastructure, different failure modes.* Chrome → FCM, Edge → WNS,
  Firefox → Mozilla autopush.
- **Separate OS notification settings** ⇒ Windows treats Chrome and Edge as different applications. **This is
  the §13 bug.**

Therefore:

```
same PC   != same push subscription
same user != one device
same OS   != same notification settings
```

Each browser must sign in once and press **Turn on notifications** separately. Chrome *profiles* count as
separate browsers too, for all of the above reasons.

Practical consequence for support: "it works in Edge but not Chrome on the same machine" is **not** evidence
that the server is broken. It is evidence that the server is *fine* and something per-browser is wrong.

---

# 21. Notification click routing

## The payload

Every notification carries its destination. The URL is chosen server-side, per event:

| Event | `url` | `tag` |
|---|---|---|
| `submitted` | `/approvals` | `oe-req-<request id>` |
| `approved` | `/requests` | `oe-req-<request id>` |
| `rejected` | `/requests` | `oe-req-<request id>` |
| `test` | `/requests` | `oe-test` |

`tag` makes repeat notifications about the **same request** replace each other on a device rather than stack up,
with `renotify: !!d.tag` so the replacement still alerts.

Note that `url` is a **path**, not a full URL; the worker resolves it against its own origin:

```js
const url = new URL(target || "/", self.location.origin).href;
```

An absolute URL in the payload could send a tap to another site. Keeping payload URLs relative and resolving
against `self.location.origin` means a tap can only ever land on our own origin.

## The click chain

```
notificationclick
      |
      v
event.notification.close()                 close the banner immediately
      |
      v
clients.matchAll({ type:"window", includeUncontrolled:true })
      |
      +-- an existing window on our origin? --> focus() --> client.navigate(url)
      |
      +-- none?                              --> clients.openWindow(url)
      |
      v
the app boots (or is already running) at /approvals
      |
      v
pageFromPath("/approvals") -> "approvals"   (NAV lookup)
      |
      v
permission filter: visible = NAV.filter(n => n.perms.some(can))
                   current  = visible.find(n => n.id === page) ? page : visible[0].id
      |
      v
the module renders
```

`includeUncontrolled: true` matters: a tab that loaded before the worker took control would otherwise be
invisible to `matchAll`, and we'd open a duplicate window.

## How the app knows where to go

Routing is path-based, defined once in `NAV`:

```js
const NAV = [
  { id: "report",    path: "/project-report", label: "Project report", icon: "report", perms: ["report.view"] },
  { id: "new",       path: "/new-request",    label: "New request",    icon: "plus",   perms: ["requests.create"] },
  { id: "approvals", path: "/approvals",      label: "Approvals",      icon: "check",  perms: ["requests.approve"] },
  { id: "requests",  path: "/requests",       label: "Request list",   icon: "list",   perms: ["requests.view_own","requests.view_all"] },
  ...
];

const pageFromPath = (path) => (NAV.find((n) => n.path === (path || "").replace(/\/+$/,"").toLowerCase()) || {}).id || null;
const pathOfPage   = (id)   => (NAV.find((n) => n.id === id) || {}).path || null;
```

The initial page is taken from the address at mount:

```js
const INITIAL_PATH = typeof window !== "undefined" ? window.location.pathname : "/";
const [page, setPage] = useState(() => pageFromPath(INITIAL_PATH));
```

Three things have to cooperate for a cold open from a notification to work — change any one and taps break:

1. **`vercel.json` rewrites** `/approvals` (and the other module paths) to `/index.html`, so the server returns
   the app instead of 404.
2. **`navigateFallback: "/index.html"`** in Workbox does the same when the response comes from the cache offline.
3. **`NAV`** maps the path to a module.

> **If you add a new module path, you must add it to `NAV` *and* to `vercel.json`'s `rewrites`.** Otherwise a
> notification pointing at it 404s on a cold open, and only works when a tab happens to be open.

**Permission-safe by construction:** `current` falls back to the first module the person is allowed to see. A
liaison who somehow receives an `/approvals` notification lands on their own first page rather than an error.
And if the session has expired, they see the sign-in page and then the intended page, because `page` was
captured from the address at mount — which is exactly why the idle timeout deliberately keeps the subscription
(§16).

---

# 22. Security model

## The boundaries

```
+--------------------------------------------------------------+
|  BROWSER (hostile territory: the user can read everything)    |
|    may know:  VAPID public key, its own device_id,             |
|               its own subscription, the Supabase anon key      |
|    must NOT:  VAPID private key, service-role key              |
+--------------------------------------------------------------+
                         |  anon key + the user's JWT
                         v
+--------------------------------------------------------------+
|  SUPABASE (Auth + Postgres + RLS)                              |
|    authenticates, enforces row ownership                       |
+--------------------------------------------------------------+
                         ^  service role (server-side only)
                         |
+--------------------------------------------------------------+
|  EDGE FUNCTION oe-push (trusted)                               |
|    holds VAPID private key, signs tokens, decides recipients,   |
|    reads other users' device rows, runs privileged cleanup      |
+--------------------------------------------------------------+
```

## Why push must not be sent from the frontend

Sending a Web Push requires the **VAPID private key**. Anything in the browser is readable by the user. So
frontend sending would mean publishing the key, and then:

- anyone could notify any user of this system, with any content — a phishing vector wearing our icon and name;
- anyone could read other people's endpoints (needed to address a push), which are themselves capabilities;
- recipient rules would be client-side, i.e. advisory.

Instead the client sends only `{ event, request_id }` (plus, for a test, *its own* endpoint). The server decides
everything that matters, verifying with the caller's own token:

- `oe_is_admin()` / `oe_has_perm('requests.approve')` evaluated **as the caller** via the `asCaller` client;
- the request's `status` must match the claimed event (`409` otherwise);
- the caller must be the filer or an admin for `submitted` (`403` otherwise).

A compromised or modified frontend can lie about `event` and `request_id` and still not reach anyone it
shouldn't.

## Data minimisation in the payload

The notification body contains the reference number, who filed it, and the amount — and nothing else. No line
items, no project financials, no personal data. It is deliberately safe to display on a lock screen, which is
exactly where it will appear.

## Secrets discipline, as actually practised

- `.gitignore` keeps `.env` out of git; `.env.example` documents the names with empty values.
- `src/env.js` carries the rule in a comment: *"Never put the service_role key in any VITE_ variable."*
- Logs print `endpointTail()` only — never a full endpoint, never `p256dh`/`auth`.
- Error notes from push services are truncated to 160 characters.
- During the §13 investigation, secrets were *tested* without being *read*: the function's own ordering of
  guards (VAPID check before session check) was used to prove the secrets existed.

> Prefer diagnostics that prove a secret is configured without printing it. Build that ordering into your
> functions deliberately — it is a debugging feature.

---

# 23. RLS and database security

## ELI5

Row Level Security is a bouncer *inside* the database. Even if you ask for everything, you are handed only your
own rows. It isn't a filter the app remembers to apply — it is applied whether or not the app asks.

## The policy

```sql
alter table oe_push_subscriptions enable row level security;

create policy oe_push_subscriptions_own on oe_push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on oe_push_subscriptions to authenticated;
```

- **`for all`** covers SELECT, INSERT, UPDATE and DELETE with one rule.
- **`using`** controls which rows you can *see* (and therefore update/delete).
- **`with check`** controls what you may *write* — this is what stops you inserting a row with someone else's
  `user_id`.
- **`auth.uid()`** is the authenticated user's id, taken from the verified JWT. Not a parameter the client can
  set.
- **`(select auth.uid())`** rather than bare `auth.uid()` is a Supabase performance idiom: it lets the planner
  evaluate it once per statement instead of per row.
- **`to authenticated`** — the `anon` role gets nothing. A signed-out visitor cannot even count the rows.

## What this guarantees

| Attempt | Result |
|---|---|
| Read another user's device rows | 0 rows. The data simply isn't there for you. |
| Insert a row with someone else's `user_id` | Rejected by `with check`. |
| Delete another user's row (e.g. by endpoint) | 0 rows affected. This is what makes `drop(endpoint)` safe to call unconditionally in `pushSubscribe`. |
| Hijack another account's endpoint | The delete silently affects nothing, then `endpoint UNIQUE` rejects the insert. |

Note how much of the client code's safety is *inherited* from RLS rather than implemented in JavaScript:
`removePushSubscription(endpoint)` filters only on `endpoint`, yet cannot touch anyone else's row. The client
code is small because the database is strict. **Put the invariant where it cannot be bypassed.**

## Why the prune function is `security definer`

The prune must delete rows RLS would hide, so it runs with the definer's privileges. That makes it the one piece
of privileged SQL in this feature, which is why it is fenced in on all sides (§8): mandatory `search_path`,
`p_user_id` required, a 30-day floor, `revoke from public`, and `grant execute` only to `service_role`. A
`security definer` function with a permissive grant and no `search_path` is a privilege-escalation bug; these
guards are what make it merely a maintenance task.

The Edge Function always calls it with the **caller's own** id:

```ts
const { data: n } = await admin.rpc("oe_prune_push_subscriptions", { p_user_id: callerId, p_days: 90 });
```

So even a bug in the function's own logic cannot reach another account's devices.

---

# 24. Stale device cleanup

Three independent mechanisms, because no single one is reliable.

## 1. Delete the row for an address the browser gives up (client)

```js
const drop = async (endpoint) => {
  try { await api.removePushSubscription(endpoint); }
  catch (e) { /* housekeeping: forgotten later by 404/410 or the 90-day cleanup */ }
};
```

Called in both paths where `pushSubscribe` abandons a subscription: the VAPID key mismatch, and the
save-failed-and-retry path. **This is the fix for the original leak** — the ghost rows existed because the old
code unsubscribed without ever deleting the row. It is safe to call blindly: RLS makes it a no-op on anyone
else's row.

## 2. Delete on 404/410 (server)

```ts
else if (isGone(res.status)) gone.push(s.id);
// ...
if (gone.length) await admin.from("oe_push_subscriptions").delete().in("id", gone);
```

The authoritative signal — the push service itself saying the subscription is gone. Reacts within one
notification.

**Why it is not enough:** push services, FCM notably, keep returning `201` for endpoints whose subscription has
been dropped, and silently discard the message. We saw exactly that: `sent: 4, failed: 0, removed: 0` with two
of those four rows provably dead. A cleanup that waits for `404/410` will wait forever on such rows.

## 3. The 90-day prune (server, lazy)

```ts
const { data: n } = await admin.rpc("oe_prune_push_subscriptions", { p_user_id: callerId, p_days: 90 });
```

Called after a device test. `last_seen_at` is refreshed on **every** save, and a save happens on every sign-in
(the `perm === "granted"` effect), so 90 days without a refresh means nobody has opened the app in that browser
for three months. The next time they do, they re-subscribe and get a fresh row. Scoped to the caller; floor of
30 days; returns a count.

## What we deliberately do *not* do

- **No blind deletion.** A `429` or a timeout never deletes a row. Transient failures must not cause permanent
  notification loss — that failure mode is silent and would be nearly impossible to diagnose.
- **No device cap** (§9).
- **No automatic deletion of the legacy rows found during debugging.** Two pre-`device_id` Chrome rows on the
  admin account (addresses redacted to `…toD3cmPUZD` and `…wrQEY_8W52`) were left in place on purpose: they are
  live production data, the brief said not to remove existing subscriptions unnecessarily, and they are not
  `404/410` nor yet 90 days old. The new code stops more of them appearing; these two will go when one of the
  mechanisms above catches them, or when someone deletes them deliberately. **Deleting production rows is an
  operator's decision, not a cleanup script's.**

---

# 25. Files that make up the system

| File | Layer | Responsibility | Do not change casually |
|---|---|---|---|
| `supabase/migrations/20261006000000_oe_push_subscriptions.sql` | DB | Creates `oe_push_subscriptions`, its index, RLS policy and grants | `endpoint UNIQUE` is a security property (§8). The RLS policy is what makes the client code safe. |
| `supabase/migrations/20261007000003_oe_push_device_id.sql` | DB | Adds `device_id`, the `(user_id, device_id)` unique index, the prune function | **The index must stay non-partial** or every upsert fails (§8). The prune's guards are security, not style. |
| `supabase/functions/oe-push/index.ts` | Server | Authorises the caller, decides recipients, sends, cleans up, answers per-device for tests | **The recipient rules are business logic** — changing them changes who learns about money. The two-client (`asCaller` / `admin`) split is the authorisation design. |
| `supabase/functions/_shared/webpush.js` | Server | RFC 8291 encryption, RFC 8292 VAPID, RFC 8030 delivery | Cryptography verified against an independent implementation (§27). **Do not "optimise" it.** Must stay runnable in both Deno and Node. |
| `supabase/functions/_shared/push-target.js` | Server | `targetSubscriptions`, `isGone`, `endpointTail`, `deviceResult` | `targetSubscriptions` may only ever *narrow* the recipient list. That invariant is what makes accepting a client endpoint safe. |
| `src/push-device.js` | Frontend | `device_id` generation/persistence, `endpointTail`, `pushSaveSteps` | The `VALID` regex is what makes interpolating the id into a PostgREST filter safe. Returning `""` (not a fresh id) without storage prevents row growth. |
| `src/App.jsx` | Frontend | `pushSubscribe`, `pushForget`, `usePush`, `PushCard`, `savePushSubscription`, `pushTest`, `notify`, `NAV` routing | Delete-before-upsert order in `savePushSubscription`. The explicit-vs-idle `signOut` distinction (§16). The `perDevice` fallback (§11). |
| `src/main.jsx` | Frontend | Service-worker registration, update prompt, reload-after-activate, periodic update checks | Every branch of `applyUpdate` must end in a reload, or the banner sticks (§5). |
| `src/env.js` | Frontend | Publishes `VITE_*` into `OE_CONFIG` | Never add a non-`VITE_` secret here. |
| `public/sw-push.js` | Service worker | `push`, `notificationclick`, `pushsubscriptionchange` | **Not bundled or transpiled** — plain, conservative JS only. Resolve URLs against `self.location.origin`. |
| `vite.config.js` | Build | `VitePWA`: `importScripts`, `clientsClaim`, `registerType: "prompt"`, `runtimeCaching: []` | Removing `importScripts: ["sw-push.js"]` silently disables all push. `clientsClaim` fixes the stuck update. |
| `vercel.json` | Infra | Rewrites for module paths; `no-cache` on `/sw.js`; CSP with `worker-src` | A missing rewrite breaks cold opens from notifications (§21). Caching `sw.js` freezes devices on an old worker. |
| `middleware.js` | Infra | Edge rate limiting, with `sw.js`/`manifest`/assets **excluded** | Re-including the worker in the matcher would break update checks. |
| `scripts/make-vapid-keys.mjs` | Tooling | Generates the VAPID pair and prints the exact `secrets set` command | Run **once** per deployment lifetime (§3). |
| `scripts/push-selftest.mjs` | Tests | 45 checks: crypto vs `http_ece`, VAPID vs Node ECDSA, the worker in a VM, device identity, save steps, targeting | The in-memory table mirrors Postgres' two unique keys; keep them in step with the migration. |
| `public/icons/icon-192.png`, `badge-96.png` | Assets | Notification icon and the small monochrome badge mark | Paths are hard-coded in `sw-push.js`. Renaming them breaks notification appearance silently. |
| `docs/SETUP.md` §6 | Docs | Operator setup and desktop expectations | Keep in step with this guide. **Currently slightly out of date:** it says `npm run functions:deploy` deploys "`oe-invite-user` and `oe-push`"; the script in `package.json` also deploys `oe-delete-user`. Harmless, but don't trust it over `package.json`. |
| `.env.example` | Docs | Documents variable names with empty values | Must never gain real values. |
| `package.json` | Tooling | `push:keys`, `push:selftest`, `db:push`, `functions:deploy` | `functions:deploy` deploys `oe-invite-user`, `oe-push` **and** `oe-delete-user`. |
| `dist/sw.js`, `dist/sw-push.js` | Build output | Generated. Never edit. | Edit the sources instead. |

---

# 26. Commands and deployment

## What each command actually changes

| Command | Touches | Effect |
|---|---|---|
| `npm run push:keys` | nothing | Prints a new VAPID pair and the `secrets set` command. **Run once per lifetime.** |
| `npm run push:selftest` | nothing | 45 local checks of crypto, VAPID, the worker, device identity and targeting. No network. |
| `npm run build` | `dist/` | Compiles the app, generates `sw.js` + `manifest`, inlines `VITE_*` values. |
| `npm run preview` | nothing | Serves `dist/` on `:4173` **with** the service worker — the only way to test push locally. |
| `npm run db:push` | **Supabase database** | Applies pending migrations. **Schema change.** |
| `supabase functions deploy oe-push` | **Supabase Edge Function** | Uploads the function. **Not done by git push.** |
| `npm run functions:deploy` | Supabase | Deploys `oe-invite-user`, `oe-push`, `oe-delete-user`. |
| `supabase secrets set …` | Supabase | Sets the VAPID secrets. Needs a function redeploy/restart to take effect. |
| `git add` / `commit` | local repo | Nothing deployed. |
| `git push origin main` | GitHub → **Vercel** | Triggers the **frontend** build and deploy. **Does not touch the database or the Edge Function.** |

## The six separate places state lives

```
1. Local code         (your working tree)
2. Git / GitHub       (history; the Vercel trigger)
3. Vercel             (the built frontend + its env vars)
4. Supabase database  (schema + rows)         <- npm run db:push
5. Supabase Function  (oe-push)               <- supabase functions deploy
6. Supabase secrets   (VAPID_*)               <- supabase secrets set
```

> **The trap that cost us real time in this project:** "I already committed and pushed everything" is true of 1–3
> and says **nothing** about 4–6. Git push does not deploy a Supabase Edge Function or run a migration. Nothing
> warns you. The symptom is a frontend expecting a response shape the deployed function has never heard of.

Likewise, adding `VITE_VAPID_PUBLIC_KEY` to Vercel requires a **redeploy** — `VITE_*` values are inlined at build
time, not read at runtime.

## Deployment order, and why

```
1. Database migration     ->  npm run db:push
2. Edge Function          ->  supabase functions deploy oe-push
3. Frontend               ->  git push origin main   (Vercel builds)
4. Verify the deploy      ->  check the bundle / the function's answer
5. Test on a real device  ->  turn notifications on; read the per-device result
```

**Why this order is the only safe one:**

- **Migration before everything.** The new frontend upserts on `(user_id, device_id)`. Without the column and the
  index, PostgREST rejects *every* save — turning notifications on breaks outright. The new function also selects
  `device_id`, which would error on a pre-migration schema.
- **Function before frontend?** Either way is tolerable *here*, because both directions were handled explicitly:
  - new function + old frontend ⇒ no `endpoint` in the body ⇒ `scope: "all-devices"` ⇒ old behaviour;
  - new frontend + old function ⇒ no `scope` in the response ⇒ the `perDevice` fallback (§11).
  Function first is still preferred, so the device-specific diagnosis is available the moment the frontend lands.
- **Verify, don't assume.** The frontend is the easiest to confirm (`grep` the deployed bundle); the function is
  confirmed by the toast wording (`this device: 201` ⇒ new function).

Backwards compatibility in both directions is not ceremony — it is what lets you deploy three systems that
cannot be deployed atomically.

---

# 27. Testing

## Automated — actual results from the latest implementation

| Suite | Command | Result | What it proves |
|---|---|---|---|
| Push self-test | `npm run push:selftest` | **45/45 passed** | See breakdown below |
| Migration behaviour | PGlite harness (scratchpad) | **24/24 passed** | The migration applies to a real Postgres engine and the upsert semantics are correct |
| Production build | `npm run build` | **PASS** (`✓ built in 401ms`; 30 precache entries; `sw.js` + `sw-push.js` emitted) | Nothing broken; the worker still imports the push handler |
| Smoke (jsdom) | `node scripts/smoke-test.mjs dist-smoke demo` | **6/6 passed** | Sign-in flows and role-based navigation still work |
| Mobile layout | `node scripts/mobile-test.mjs dist-smoke` | **86/86 passed** | No layout regressions at 390 px / 800 px / 1280 px |

### What the 45 self-test checks cover

1–4. **Encryption (RFC 8291)** verified against `http_ece` from the `web-push` package — an *independent*
implementation decrypts what we encrypt. Also: exact body length, a fresh salt and sender key every time, and
malformed subscription keys rejected.

5–9. **VAPID (RFC 8292)** — header shape, `ES256`, correct `aud`/`sub`/`exp`, and the signature verified with
Node's own ECDSA against the public key.

10–13. **The service worker**, loaded into a `node:vm` with a fake `self`: a push shows the right title/body/tag
and target page, carries the icon and badge image, sets the app-icon count, and a tap opens `/approvals`.

14–21. **Device identity** (8 checks) — an id is created and reused; it is persisted in storage; another browser
gets a different one; a tampered storage value is replaced; blocked storage returns `""`; storage that *throws*
is handled as "no storage" rather than an error; a browser without `crypto.randomUUID` still gets a usable id.

22–31. **The save steps** (10 checks), replayed against an in-memory table enforcing *both* unique keys: one row
through three endpoint rotations; four devices staying four rows across a re-subscribe, with only the
re-subscribing device's address changing and no device displaced; a legacy `NULL` row taken over rather than
duplicated; another account's address refused and that account's row left intact; no-storage still one row per
address.

32–45. **Targeting** (14 checks) — all devices for a real notification (and for an old client that sends no
endpoint), only the asking device for a test, nobody for an unknown address, an empty device list handled; `isGone`
true only for 404/410 and false for 201/429/`"error"`; `endpointTail` hides the host and handles an empty address;
`deviceResult` wording for 201 / 410 / not-registered, the device it names, and pass-through of the service's own
note.

### The migration check

Docker Desktop was not running and the local PostgreSQL 16 service required a password that was not available, so
the migration was verified with **PGlite** — real PostgreSQL (18.3) compiled to WASM — installed into the
scratchpad so nothing was added to the repository. The harness:

- applies `20261006…` then `20261007000003…` **verbatim**, then re-applies the second to prove idempotence;
- asserts `device_id` is nullable `text`, the `(user_id, device_id)` index exists and is **not partial**, and
  `endpoint` is still uniquely indexed;
- replays the real PostgREST-shaped `ON CONFLICT (user_id, device_id)` upsert — **the one thing that would
  silently break every save if the index did not match**;
- proves one row through three endpoint rotations; four devices surviving a re-subscribe; two `NULL` device_ids
  coexisting; legacy take-over; cross-account refusal;
- exercises the prune: one stale row removed, today's row kept, **another person's stale row untouched**,
  idempotent on a second call, refuses a null user, refuses a 1-day window, and `service_role` can execute while
  `authenticated` cannot.

**Honest caveats:** the harness lives in the scratchpad, not the repo, so it is not re-runnable from a clean
checkout (it can be added as `scripts/push-db-test.mjs` with a devDependency if wanted). It ran on PG 18.3 while
Supabase runs a different major version. And `npm run test:smoke` / `test:mobile` **cannot run as npm scripts on
Windows** — npm invokes them through `cmd.exe`, which does not understand the POSIX `VAR= cmd` prefix in those
script definitions; the two steps were run directly in Bash instead. This is a pre-existing limitation, unrelated
to the push work.

## Real-world testing — and why automation cannot replace it

Automated tests proved: the crypto is correct, the recipient targeting is correct, the SQL does what we think,
the worker shows what we expect. **Not one of them could have found the actual bug**, because the bug was a
checkbox in Windows.

| Only a real device can tell you | Why |
|---|---|
| Whether the OS draws the banner | No API reports it. `showNotification()` resolves either way. |
| Whether the browser is connected to its push service | Browser-internal; see `chrome://gcm-internals`. |
| Whether a per-app OS setting is off | Not visible to web code at all. |
| How iOS behaves installed vs in Safari | Requires an actual iPhone. |
| Whether a closed browser still delivers | Depends on OS and background-app settings. |

Real-device results observed during this work: Edge/Windows ✔ (WNS, liaison account); iPhone Home Screen app ✔
(Apple Web Push); Chrome/Android subscribed; Chrome/Windows — FCM accepted (`201`) but **no banner** until the
Windows per-app notification setting for Chrome was enabled.

> **Automated tests prove your code does what you meant. Real-device tests prove the user gets the outcome.**
> Push notifications cross five boundaries you do not own; you need both, and neither substitutes for the other.

---

# 28. Known limitations

Platform and protocol realities — not bugs, but things to remember:

1. **`201` does not mean the user saw anything** (§12). There is no delivery or display receipt in Web Push.
2. **OS and per-app settings override everything.** Windows notification settings are per application; Chrome and
   Edge are separate apps with separate switches.
3. **Chrome and Edge use different push infrastructure** (FCM vs WNS) on the same PC. Diagnose them separately.
4. **iOS requires the Home Screen app.** Plain Safari cannot do Web Push, and the installed app has its own
   storage, permission, `device_id` and row.
5. **A closed browser may not deliver** until it next starts (our `TTL` holds the message 24 h).
6. **Users can disable notifications** at the OS level, the browser level, or per site — all invisible to us.
7. **Clearing site data creates a new device** from our point of view. Unavoidable: the identity was in the
   storage they deleted.
8. **Endpoints rotate.** Handled, but it means the DB endpoint is a cache, not a fact.
9. **`pushsubscriptionchange` does not write to the database.** The worker re-subscribes, but has no session, so
   the new endpoint is only persisted on the next app launch. Between the two, sends to the old address fail (and
   then clean themselves up). A future improvement would be to queue the new endpoint for the next launch.
10. **Service-worker updates must stay correct**, or an old worker without the push handler stays active (§5).
11. **The 90-day prune is lazy** — it only runs after a device test, so stale rows can outlive 90 days until
    someone tests. A scheduled job (`pg_cron`) would make it deterministic.
12. **Legacy `NULL` `device_id` rows persist** until 404/410 or the prune catches them (§24).
13. **`accounting` and `viewer` receive no push at all** — they lack `requests.approve`, and no event targets
    them. Intentional today; revisit if Accounting needs to know about disbursements.
14. **`submitted` notifies all approvers, not the escalation chain** (§10).
15. **No "Your devices" UI yet.** Users cannot see or revoke their own devices; it needs a service-role query
    today. Deliberately out of scope, and the natural next feature.
16. **Device tests depend on `localStorage`.** A browser with storage blocked falls back to endpoint-keyed rows,
    losing the stable identity (but not correctness).
17. **`npm run test:smoke` / `test:mobile` fail as npm scripts on Windows** (§27).
18. **The migration check is not in the repo** (§27).
19. **`http://<LAN-ip>` is not a secure context** — phone-on-Wi-Fi testing needs HTTPS or a tunnel.

---

# 29. Engineering mindset

The transferable part. Each principle earned its place in this project.

### 1. Separate user identity from device identity

`User ≠ Device`. One person legitimately has four. Any schema assuming one row per user eventually corrupts or
loses notifications. Model the relationship that exists in the world, not the one that is convenient.

### 2. Separate device identity from transport address

`device_id ≠ endpoint`. The endpoint is a *delivery address* that rotates; the device is a *thing* that persists.
This is a general pattern: never use a mutable, provider-issued address as a primary identity. The same mistake
appears as email-as-user-id, IP-as-device-id, and session-token-as-identity.

> **Ask: "who issues this value, and can they change it without telling me?"** If yes, it is not an identity.

### 3. Design for multiple devices from the start

Retrofitting multi-device meant a migration, a client change, a function change and a careful backfill story.
Starting with `(user_id, device_id)` would have cost one extra column on day one. Multiplicity is almost never
"later" — it is just undiscovered.

### 4. Never assume delivery means display

`201 Accepted ≠ the user saw it`. Know exactly where your visibility ends, and make your success messages claim
no more than that. Our old toast said "accepted it" while meaning "something somewhere accepted it" — true, and
useless.

### 5. Test the exact thing you are asking about

The test button answered "does any of your devices work?" while the user was asking "does *this* one work?". When
a diagnostic aggregates, it can succeed while the subject fails. **A diagnostic must be specific to its
subject.** This was the single most valuable fix in the project.

### 6. Preserve business logic while changing infrastructure

The device_id work deliberately did not touch who receives what. The diff shows only the device-selection step
and the test response changing. Recipient rules encode *policy* (who learns about money); infrastructure encodes
*mechanism*. Changing both at once makes a regression impossible to attribute.

### 7. Make failures observable

The console line carries `device_id`, endpoint tail, service, status, counts and notes. The function returns a
per-device result. The prune returns a count. **If you log a truncated secret-free identifier, you can diagnose
without a debugger** — and crucially, the log must distinguish "worked" from "worked somewhere".

### 8. Use defensive, converging cleanup

Three mechanisms (client drop, 404/410, 90-day prune) because each has a blind spot — notably, FCM's `201` for
dead endpoints defeats the authoritative one. But: never delete on transient failures. **Asymmetric costs
deserve asymmetric caution**; a wrongly deleted subscription fails silently and forever.

### 9. Handle platform differences explicitly, in code and in words

`IS_IOS`, `STANDALONE`, `iosNeedsInstall`, and a bar that tells iPhone users the *only* thing that works. Don't
pretend platforms are uniform; detect and explain. The user-facing string is part of the engineering.

### 10. Expect state to disappear

Users log out, clear data, uninstall, reinstall, switch browsers, revoke permission. None of these are
exceptional. The system must **converge** from any state (§18) rather than depend on a history it cannot see.

### 11. Don't paper over an infrastructure problem with an arbitrary limit

A "max 3 devices" cap would have hidden the row growth and broken real users. The growth was a *counting* bug.
**Fix the identity, and the symptom disappears** (§9). Caps are what you reach for when you don't understand the
cause yet.

### 12. Debug layer by layer, with falsifiable tests

```
Recipient logic -> Database -> Edge Function -> Push provider -> Browser connection
                -> Service Worker -> Browser notification -> Operating System
```

We eliminated each with evidence: a `curl` probe, a bundle `grep`, a DB query, a port test, a one-line
`showNotification()`. Two attractive theories died in two minutes each. **We shipped no speculative fix for a
problem that turned out to be a checkbox** — and the one code change we did make (the device-specific test) was
justified independently, because it was a real defect that had been actively misleading us.

### 13. Prefer diagnostics that prove without revealing

We confirmed the VAPID secrets existed by exploiting the function's own guard ordering, never reading a secret.
Build that property into your functions on purpose.

### 14. Backwards compatibility is what makes multi-system deploys survivable

Database, function and frontend cannot deploy atomically. Both directions of version skew were handled
explicitly (`scope` absent ⇒ fall back). That is not over-engineering; it is the price of three deploy targets.

---

# 30. "What if…" scenario matrix

| Scenario | `device_id` | Endpoint | Database | Notifications resume? |
|---|---|---|---|---|
| **User signs out (explicit)** | Kept in `localStorage` | Kept by the browser (no `unsubscribe()`) | **Row deleted** by `pushForget` | Yes, automatically on next sign-in (permission still granted) |
| **Idle timeout (30 min)** | Kept | Kept | **Row kept — deliberately** | Never stopped. The notification opens sign-in, then the right page |
| **User signs back in** | Same | Same | Same row re-upserted; `last_seen_at` refreshed | Already working |
| **Clears site data** | **Lost** ⇒ new one | **Lost** ⇒ new one | Old row stale; **new row** created | Yes, after signing in (permission usually survives) |
| **Clears cache only** | Kept | Kept | Unchanged | Unaffected |
| **Permission denied** | May exist | **No subscription created** | No row written | Only after allowing in browser site settings; the bar explains where |
| **Permission later allowed** | Same (or created) | New subscription | Row created/updated | Yes, immediately — a test is sent at once |
| **PWA installed (Android)** | Usually shared with Chrome | Usually shared | Usually the same row | Unchanged |
| **PWA installed (iOS)** | **Its own, new** | Its own | **Its own row** | Yes, after allowing *inside* the installed app |
| **PWA removed (Android)** | Usually kept with the Chrome profile | Usually kept | Row usually still valid | Usually unaffected |
| **PWA removed (iOS)** | Lost with that app's storage | Lost | Row stale | No, until reinstalled and allowed |
| **PWA reinstalled (iOS)** | **New** | New | **New row**; old one stale | Yes, after *Turn on notifications* |
| **New phone** | New | New | New row | Yes, once signed in and allowed |
| **Same user, second PC** | New (own storage) | New | **Additional row** | Both PCs notified |
| **Same user, Chrome + Edge** | **Two different ids** | Two endpoints, **two providers** | **Two rows** | Both notified — each needs its own permission |
| **Endpoint rotates** | **Unchanged** | New | **Same row, endpoint updated** (on next launch) | Yes. Sends to the old address fail meanwhile and self-clean |
| **Push returns 410/404** | Unchanged | Dead | **Row deleted** | After turning notifications off and on again |
| **Push returns 429 / timeout** | Unchanged | Still valid | **Row kept** (never deleted on transient failure) | Yes — the next event delivers |
| **Device offline** | Unchanged | Valid | Unchanged | Yes — held up to the 24 h `TTL` |
| **Browser closed** | Unchanged | Valid | Unchanged | While the browser runs in the background, yes; otherwise on next start (within `TTL`) |
| **Windows notifications disabled for that browser** | Unchanged | Valid | Unchanged, `201` | **Message delivered, banner never drawn.** §13. Fix the OS setting |
| **Do not disturb / Focus on** | Unchanged | Valid | `201` | Goes to the Notification Center, no banner. Check `Win`+`N` |
| **iOS, PWA not installed** | n/a — `PUSH_SUPPORTED` false | None | No row | Only after Add to Home Screen |
| **User A signs out, User B signs in** | **Shared** id | B reuses A's endpoint if free, else gets a new one | A's row deleted (explicit sign-out); B's row created | B yes; A gets nothing on that browser |
| **User A idle-timed-out, User B signs in** | Shared | **B is forced to a new endpoint** (A's row blocks the old one) | A's row survives but is dead; B's row valid | B yes; A silently no (their row is dead until cleaned) |
| **VAPID keys rotated** | Unchanged | Old ones invalid | Rows kept until 403/410 | Only after every user presses *Turn on notifications* again |
| **`VITE_VAPID_PUBLIC_KEY` missing from the build** | Unchanged | — | — | Feature not offered at all; no bar, no button |
| **Migration not applied, new frontend live** | Created | Created | **Every save fails** (no matching ON CONFLICT constraint) | No — turning notifications on is broken. Apply the migration |
| **Function not deployed, new frontend live** | Normal | Normal | Normal | Yes — the test falls back to the old all-devices wording (§11) |
| **Profile deleted / deactivated** | Unchanged on the device | Valid | Rows **cascade-deleted** with the profile; inactive users excluded from recipients | No |

---

# 31. Beginner mental model

Memorise this shape:

```
USER                      one person, one account
  |
  | has many
  v
DEVICES                   office PC, home laptop, Android, iPhone
  |                       identified by OUR device_id (localStorage, stable)
  | each has one
  v
PUSH SUBSCRIPTION         created by the browser, per browser profile
  |
  | contains
  v
ENDPOINT + KEYS           endpoint = delivery address (CHANGES)
                          p256dh + auth = how to seal it so only this browser can read it
```

And the responsibilities:

```
VAPID            proves our server is allowed to send to this subscription
device_id        OUR stable name for this browser  (we invent it; it persists)
endpoint         the CURRENT delivery address      (the provider owns it; it rotates)
service worker   receives the push with no tab open
push provider    transports it (FCM / WNS / Apple) and answers 201
operating system DECIDES WHETHER TO DRAW THE BANNER   <- not ours
```

> **Never confuse these identities.**
> A user is not a device. A device is not an endpoint. An endpoint is not an identity.
> And **accepted is not displayed.**

If a notification doesn't appear, ask in this order: *was the right user chosen; does the device have a row; did
the provider accept it; is the browser connected and running; did the OS agree to show it?* The answer is in that
list, in that order, far more often than it is in your code.

---

# 32. Cheat sheet

### Architecture
```
User -> Browser/PWA -> Permission -> Service Worker -> Subscription -> device_id
     -> oe_push_subscriptions -> oe-push (Edge Function) -> VAPID+encrypt
     -> Push provider (FCM/WNS/Apple) -> Browser -> sw-push.js showNotification()
     -> OS banner -> tap -> /approvals or /requests
```

### Environment variables
```
VITE_VAPID_PUBLIC_KEY=<public-key>     # .env + Vercel. Public. Empty => push not offered.
VAPID_PUBLIC_KEY=<public-key>          # Supabase secret (k= and the signing JWK)
VAPID_PRIVATE_KEY=<private-key>        # Supabase secret ONLY. NEVER in VITE_*.
VAPID_SUBJECT=mailto:<real-email>      # Supabase secret
VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY   # public, RLS protects the data
SUPABASE_SERVICE_ROLE_KEY              # local scripts only. NEVER in Vercel or VITE_*.
```

### Important files
```
supabase/migrations/20261006000000_oe_push_subscriptions.sql   table + RLS
supabase/migrations/20261007000003_oe_push_device_id.sql       device_id + index + prune
supabase/functions/oe-push/index.ts                            recipients + send
supabase/functions/_shared/webpush.js                          RFC 8291/8292/8030
supabase/functions/_shared/push-target.js                      targeting + result wording
src/push-device.js                                             device_id + save steps
src/App.jsx                                                    pushSubscribe/usePush/NAV
src/main.jsx                                                   SW registration + updates
public/sw-push.js                                              push + notificationclick
vite.config.js                                                 importScripts, clientsClaim
scripts/push-selftest.mjs                                      45 automated checks
```

### Commands
```bash
npm run push:keys        # once per lifetime. Rotating invalidates every subscription.
npm run push:selftest    # 45 checks, no network
npm run build            # dist/ + sw.js
npm run preview          # :4173 WITH service worker <- test push locally here
npm run db:push          # apply migrations
supabase functions deploy oe-push
git push origin main     # frontend only (Vercel)
```

### Browser URLs
```
chrome://gcm-internals                        connected? did the message arrive?
chrome://settings/content/notifications        site permission
chrome://serviceworker-internals               workers
DevTools > Application > Service Workers       active/waiting, Unregister
Windows Settings > System > Notifications      PER-APP banners, Do not disturb
Win + N                                        was it delivered but not shown?
```

### Deployment order
```
1. migration  2. Edge Function  3. frontend  4. verify  5. real-device test
```
Git push deploys **only** the frontend.

### Troubleshooting order
```
offered? -> permission -> service worker -> DB row -> function deployed -> 201?
        -> browser connected/running -> OS per-app setting -> Do not disturb
```
Decisive isolation test, in the browser console:
```js
navigator.serviceWorker.ready.then(r => r.showNotification("Local test", { body: "OS display works." }))
```

### Security rules
```
Private VAPID key + service-role key: server only, forever.
Anything in a VITE_* variable is PUBLIC the moment you build.
Push sending happens server-side so recipient rules are enforced, not advisory.
Log endpoint TAILS only. Never p256dh/auth.
RLS: user_id = auth.uid(), for all, using + with check.
```

### Multi-device rules
```
One user -> many devices. No cap.
Unique key: (user_id, device_id). endpoint stays unique separately.
Real notifications -> ALL devices of ALL eligible recipients.
Device test -> ONLY the asking device.
targetSubscriptions() may only narrow, never widen.
```

### iOS rules
```
Web Push needs the Home Screen app (iOS 16.4+). Safari alone: not supported.
Share -> Add to Home Screen -> open the icon -> sign in -> Turn on notifications.
The installed app has its own storage, permission, device_id and row.
```

### Logout / clear-data behaviour
```
Explicit Sign out  -> DB row deleted; permission + device_id + subscription kept
Idle timeout       -> DB row KEPT on purpose
Sign back in       -> same device_id, same row, no prompt
Clear site data    -> new device_id, new endpoint, new row; old row cleaned by 404/410 or 90 days
Another user signs in -> own row; endpoint collision forces a fresh subscription; no cross-account delivery
```

---

## One more time, because it is the whole lesson

**A `201` from the push service means the courier took the envelope. It does not mean anyone saw it.**

Our code is responsible up to that `201`. The browser and the operating system own everything after it. When a
notification "doesn't work", find out which side of that line you are on **before** you change any code.
