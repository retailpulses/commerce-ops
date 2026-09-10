import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/inquiry/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      // In local dev, proxy /api to Pages Functions via wrangler
      "/inquiry/api": {
        target: "http://localhost:8788",
        rewrite: (path) => path.replace(/^\/inquiry/, ""),
      },
    },
  },
});
