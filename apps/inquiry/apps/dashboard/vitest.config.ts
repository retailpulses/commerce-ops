import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["functions/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    setupFiles: [],
  },
});
