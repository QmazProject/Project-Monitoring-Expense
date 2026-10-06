// env.js must be first: it publishes the Vite environment variables as
// globalThis.OE_CONFIG before App.jsx reads its CONFIG block.
import "./env.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";

// Installed app: after a deploy the new version waits until the person taps Reload (App shows the banner),
// so nothing they are typing is lost. Does nothing in browsers without service workers.
const updateSW = registerSW({
  onNeedRefresh() {
    // kept on window as well: a waiting worker can be found before the banner has mounted
    window.__oeSwUpdate = () => updateSW(true);
    window.dispatchEvent(new CustomEvent("oe-sw-update", { detail: window.__oeSwUpdate }));
  },
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
