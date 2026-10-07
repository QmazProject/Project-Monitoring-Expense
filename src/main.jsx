// env.js must be first: it publishes the Vite environment variables as
// globalThis.OE_CONFIG before App.jsx reads its CONFIG block.
import "./env.js";
// Poppins served with the app (no Google Fonts import). iPhone browsers held back the whole stylesheet until a
// remote font import finished, which showed an unstyled sign-in page for a moment after opening the installed app.
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";

// Installed app updates. After a deploy the new build is downloaded in the background and waits; App's
// UpdateBanner applies it (straight away when the app has just been opened, otherwise when the person taps
// Update), so nothing they are typing is lost. Does nothing in browsers without service workers.
let registration = null;
let applying = false;

// Tells the app a build is waiting. Kept on window as well: a waiting worker can be found before the banner mounts.
const announce = () => {
  window.__oeSwUpdate = applyUpdate;
  window.dispatchEvent(new CustomEvent("oe-sw-update", { detail: applyUpdate }));
};

// The waiting worker is told to take over, and the page reloads once it controls it (served from the new files;
// the person stays signed in). The banner never stays on "Updating…": if nothing happens within a few seconds the
// page reloads anyway, and the next launch runs whatever build is in charge.
async function applyUpdate() {
  if (applying) return;
  applying = true;
  const reg = registration || (await navigator.serviceWorker.getRegistration().catch(() => null));
  const sw = reg && (reg.waiting || reg.installing);
  let done = false;
  const reload = () => {
    if (done) return;
    done = true;
    window.location.reload();
  };
  if (!sw) return reload(); // nothing is waiting any more: the new build is already in charge
  navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  const takeOver = () => {
    sw.postMessage({ type: "SKIP_WAITING" });
    setTimeout(reload, 8000);
  };
  if (sw.state === "installed") takeOver();
  else
    sw.addEventListener("statechange", () => {
      if (sw.state === "installed") takeOver(); // still downloading when tapped: takes over once installed
      else if (sw.state === "redundant") reload(); // the download failed: reload, the next check tries again
    });
}

registerSW({
  onNeedRefresh: announce,
  onRegisteredSW(swUrl, reg) {
    if (!reg) return;
    registration = reg;
    if (reg.waiting) announce(); // a build that was already waiting when the page opened
    // Every new build is watched here. (The register helper stops watching after the first one it finds late in
    // a session, so a second deploy while the app stayed open would otherwise go unnoticed.)
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state !== "installed") return;
        // a moment later it is either waiting (an update) or already activating (the first install)
        setTimeout(() => navigator.serviceWorker.controller && reg.waiting === sw && announce(), 200);
      });
    });
    // The browser only looks for a new build when a page loads. Phones keep an installed app alive in the
    // background for days, so also look when it comes back to the screen, when the connection returns, and
    // every 30 minutes while it stays open (at most once a minute).
    let last = Date.now();
    const check = () => {
      if (Date.now() - last < 60_000 || navigator.onLine === false) return;
      last = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
    window.addEventListener("online", check);
    setInterval(check, 30 * 60_000);
  },
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
