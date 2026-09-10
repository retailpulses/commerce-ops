import assert from "node:assert/strict";
import test from "node:test";

import { buildEnv } from "../portal-api/src/env.mjs";

const REQUIRED_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: "test-supabase-key",
  BASEROW_DATABASE_TOKEN: "test-baserow-token",
  ORDER_MGMT_ADMIN_SECRET: "test-admin-secret",
  ORDERMGMT_CATALOG_API_TOKEN: "test-catalog-token",
};

function withProcessEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("portal API exposes the relay secret to shared message handlers", () => {
  withProcessEnv({ ...REQUIRED_ENV, MERCARI_RELAY_SECRET: "test-relay-secret" }, () => {
    assert.equal(buildEnv().MERCARI_RELAY_SECRET, "test-relay-secret");
  });
});

test("portal API fails fast when the relay secret is missing", () => {
  withProcessEnv({ ...REQUIRED_ENV, MERCARI_RELAY_SECRET: undefined }, () => {
    assert.throws(() => buildEnv(), /Missing required env var: MERCARI_RELAY_SECRET/);
  });
});
