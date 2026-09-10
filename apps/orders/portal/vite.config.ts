import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Canonical Ops Portal base path (Issue 60). The SPA is served under
  // /order/ on the shared ops host; nginx strips the prefix for static
  // assets and proxies /order/api/ to the portal-api (which normalizes
  // /order/api/portal/* → /api/portal/*).
  base: "/order/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/order/api": {
        // Dev: proxy the canonical /order/api/ prefix to local portal-api
        // (port 8790). Production: nginx proxies /order/api/ to 127.0.0.1:8790.
        target: "http://127.0.0.1:8790",
        changeOrigin: true,
      },
    },
  },
});
