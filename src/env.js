/* Bridges Vite's .env values into the app's CONFIG block (App.jsx merges globalThis.OE_CONFIG).
   Only VITE_* variables reach the browser. Never put the service_role key in any VITE_ variable. */
const env = import.meta.env || {};
const str = (v) => (v == null ? "" : String(v).trim());

globalThis.OE_CONFIG = {
  supabaseUrl: str(env.VITE_SUPABASE_URL),
  supabaseAnonKey: str(env.VITE_SUPABASE_ANON_KEY),
  usernameDomain: str(env.VITE_USERNAME_DOMAIN),
  // "false" hides the demo on the sign-in page (for example on the production deployment).
  demoEnabled: str(env.VITE_DEMO_ENABLED).toLowerCase() !== "false",
  // Cloudflare Turnstile site key. Leave empty until captcha is switched on in Supabase (Auth → Attack protection).
  captchaSiteKey: str(env.VITE_TURNSTILE_SITE_KEY),
  // Public half of the push notification key pair (npm run push:keys). Empty = notifications are not offered.
  vapidPublicKey: str(env.VITE_VAPID_PUBLIC_KEY),
};
