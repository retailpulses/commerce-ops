import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  define: {
    __STAGE_C_REST_URL__: JSON.stringify(process.env.STAGE_C_REST_URL ?? ""),
    __STAGE_C_SERVICE_ROLE_KEY__: JSON.stringify(
      process.env.STAGE_C_SERVICE_ROLE_KEY ?? "",
    ),
  },
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
