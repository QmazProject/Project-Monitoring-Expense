// Makes the key pair that signs push notifications (VAPID). Run once; keep the private key secret.
// usage: npm run push:keys
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });
const b64url = (b) => Buffer.from(b).toString("base64url");
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);

console.log(`
Public key (the app, safe to publish). Add to .env and to Vercel's environment variables:

  VITE_VAPID_PUBLIC_KEY=${b64url(raw)}

Private key (the oe-push function only). Set it as Supabase secrets, with a contact address:

  supabase secrets set VAPID_PUBLIC_KEY=${b64url(raw)} VAPID_PRIVATE_KEY=${priv.d} VAPID_SUBJECT=mailto:helpdesk@yourcompany.com

Changing the keys later signs everyone's devices out of notifications; they turn them on again from the app.
`);
