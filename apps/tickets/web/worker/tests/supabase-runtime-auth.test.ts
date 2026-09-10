import assert from "node:assert/strict";
import test from "node:test";

import { resolveSupabaseClientConfig } from "../src/repositories/supabase";

test("scoped runtime JWT is Authorization only and publishable key remains apikey", () => {
  const config = resolveSupabaseClientConfig({
    SUPABASE_ANON_KEY: "sb_publishable_test",
    SUPABASE_RUNTIME_KEY: "scoped.jwt.value",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-be-used",
  });
  assert.equal(config.apiKey, "sb_publishable_test");
  assert.equal(config.options.global?.headers.Authorization, "Bearer scoped.jwt.value");
});

test("scoped runtime cannot fall back to service_role as API key", () => {
  assert.throws(() => resolveSupabaseClientConfig({
    SUPABASE_RUNTIME_KEY: "scoped.jwt.value",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  }), /Missing SUPABASE_ANON_KEY/);
});

test("legacy portal service-role initialization remains compatible", () => {
  const config = resolveSupabaseClientConfig({ SUPABASE_SERVICE_ROLE_KEY: "service-role" });
  assert.equal(config.apiKey, "service-role");
  assert.equal("global" in config.options, false);
});
