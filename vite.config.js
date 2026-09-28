import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
