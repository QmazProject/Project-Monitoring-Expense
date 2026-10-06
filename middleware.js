/* Vercel Edge Middleware: a first line of defence in front of the static app.
   Runs on Vercel's edge network before any file is served.

   What it does:
   - refuses request methods the site never uses (the app only ever GETs its own files;
     all data traffic goes straight to Supabase, not through this host)
   - refuses obvious scanner tools and requests with no User-Agent
   - best-effort per-IP rate limiting on page loads (in-memory per edge isolate)

   What it does not replace: Vercel's platform-level DDoS mitigation (always on), the
   Vercel Firewall / Attack Challenge Mode (Project → Firewall), Supabase Auth rate
   limits, and the captcha that will be added to the sign-in form later. */
import { next } from "@vercel/edge";

export const config = {
  // Skip hashed build assets, the icons and the installed-app files (service worker, manifest): harmless to fetch,
  // and the service worker re-checks sw.js on every launch.
  matcher: ["/((?!assets/|icons/|favicon\\.svg|sw\\.js|workbox-|manifest\\.webmanifest).*)"],
};

const WINDOW_MS = 60_000; // 1 minute
const MAX_PER_WINDOW = 90; // page loads per IP per minute (a person needs a handful)
const BLOCK_MS = 5 * 60_000; // how long an IP stays blocked after exceeding the limit
const MAX_TRACKED_IPS = 5000; // keep the map bounded

const SCANNERS = /\b(sqlmap|nikto|masscan|nmap|zgrab|acunetix|nessus|dirbuster|gobuster|wpscan|nuclei)\b/i;

const buckets = new Map(); // ip -> { count, windowStart, blockedUntil }

function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}

function limited(ip, now) {
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= MAX_TRACKED_IPS) buckets.clear(); // crude but keeps memory flat
    b = { count: 0, windowStart: now, blockedUntil: 0 };
    buckets.set(ip, b);
  }
  if (b.blockedUntil > now) return true;
  if (now - b.windowStart > WINDOW_MS) {
    b.count = 0;
    b.windowStart = now;
  }
  b.count += 1;
  if (b.count > MAX_PER_WINDOW) {
    b.blockedUntil = now + BLOCK_MS;
    return true;
  }
  return false;
}

export default function middleware(request) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }

  const ua = request.headers.get("user-agent") || "";
  if (!ua.trim() || SCANNERS.test(ua)) {
    return new Response("Forbidden", { status: 403 });
  }

  const now = Date.now();
  if (limited(clientIp(request), now)) {
    return new Response("Too many requests. Please wait a few minutes and try again.", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(BLOCK_MS / 1000)), "Cache-Control": "no-store" },
    });
  }

  return next();
}
