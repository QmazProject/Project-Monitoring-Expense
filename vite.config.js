import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  // Which build is running, shown in Settings → System (Vercel provides the commit).
  define: {
    __APP_BUILD__: JSON.stringify({ commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7), time: new Date().toISOString() }),
  },
  plugins: [
    react(),
    // Installable app for Android and iOS. The service worker caches only the app's own files (index.html, the
    // bundles, icons); project and request data stay in Supabase and are never stored on the phone.
    VitePWA({
      registerType: "prompt", // a new build waits until the person taps Reload (src/main.jsx), so a form in progress is kept
      injectRegister: false,
      includeAssets: ["favicon.svg", "icons/*.png"],
      manifest: {
        name: "Project Expense Monitoring",
        short_name: "PEM",
        description: "Project expense requests, approvals and monitoring.",
        start_url: "/project-report",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#eef3f2", // launch screen: the light page colour, with the green logo on it
        theme_color: "#0b4338",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // the Poppins files for Latin text and the peso sign (latin, latin-ext) open instantly and offline
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}", "assets/poppins-latin-*.woff2"],
        importScripts: ["sw-push.js"], // push notifications (public/sw-push.js)
        navigateFallback: "/index.html",
        runtimeCaching: [], // nothing from Supabase or any other site is cached
        cleanupOutdatedCaches: true,
        // A freshly installed worker takes charge of the open page at once. Without this, a page opened before
        // the worker existed (first visit, hard refresh, a just-installed app) is never controlled, so tapping
        // Update on a later build had nothing to hand over to and the banner stayed on "Updating…".
        clientsClaim: true,
      },
    }),
  ],
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    sourcemap: false,
    target: "es2020",
    rollupOptions: {
      output: {
        // Keep the vendor libraries in their own long-cached chunks.
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("node_modules/@supabase")) return "supabase";
          return undefined;
        },
      },
    },
  },
});
