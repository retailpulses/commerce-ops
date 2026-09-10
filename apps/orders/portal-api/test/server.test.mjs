import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/server.mjs";

// Dummy values satisfy buildEnv()'s requireEnv checks without real secrets.
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.BASEROW_DATABASE_TOKEN = "test-baserow-token";
process.env.MERCARI_RELAY_SECRET = "test-relay-secret";
process.env.ORDERMGMT_CATALOG_API_TOKEN = "test-catalog-token";
process.env.ORDER_MGMT_ADMIN_SECRET = "test-admin-secret";
process.env.RELEASE_SHA = "a".repeat(40);
process.env.RELEASE_BUILT_AT = "2026-08-30T00:00:00Z";

const { app } = createApp();

test("GET /order/api/release is public read-only and returns contract_v1", async () => {
  const res = await app.request("/order/api/release");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.application, "order");
  assert.equal(body.release_sha, "a".repeat(40));
  assert.equal(body.release_sha.length, 40);
  assert.equal(body.built_at, "2026-08-30T00:00:00Z");
  assert.equal(body.contract_version, 1);
});

test("GET /order/api/portal/summary is still auth-gated after normalization", async () => {
  const res = await app.request("/order/api/portal/summary");
  assert.equal(res.status, 401);
});

test("GET /order/api/portal/control-plane is auth-gated after normalization", async () => {
  const res = await app.request("/order/api/portal/control-plane");
  assert.equal(res.status, 401);
});

test("canonical write normalization preserves body handling and auth gate", async () => {
  const res = await app.request("/order/api/portal/orders/bulk-approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order_ids: ["test"] }),
  });
  assert.equal(res.status, 401);
});

test("legacy GET /api/portal/summary remains auth-gated", async () => {
  const res = await app.request("/api/portal/summary");
  assert.equal(res.status, 401);
});

test("legacy GET /api/release returns the same public payload", async () => {
  const res = await app.request("/api/release");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.application, "order");
  assert.equal(body.contract_version, 1);
});
