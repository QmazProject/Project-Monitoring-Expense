import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
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
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        importScripts: ["sw-push.js"], // push notifications (public/sw-push.js)
        navigateFallback: "/index.html",
        runtimeCaching: [], // nothing from Supabase or any other site is cached
        cleanupOutdatedCaches: true,
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
