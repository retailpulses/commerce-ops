import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOpsApiPath, releasePayload } from "../src/ops-path.mjs";

test("normalizeOpsApiPath rewrites canonical /order/api/* to /api/*", () => {
  assert.equal(normalizeOpsApiPath("/order/api/portal/summary"), "/api/portal/summary");
  assert.equal(normalizeOpsApiPath("/order/api/release"), "/api/release");
  assert.equal(
    normalizeOpsApiPath("/order/api/portal/orders/123/messages"),
    "/api/portal/orders/123/messages",
  );
});

test("normalizeOpsApiPath leaves non-canonical paths untouched (null)", () => {
  assert.equal(normalizeOpsApiPath("/api/portal/summary"), null);
  assert.equal(normalizeOpsApiPath("/health"), null);
  assert.equal(normalizeOpsApiPath("/order/"), null);
  assert.equal(normalizeOpsApiPath("/order"), null);
  assert.equal(normalizeOpsApiPath("/order/assets/app.js"), null);
  assert.equal(normalizeOpsApiPath(""), null);
  assert.equal(normalizeOpsApiPath(undefined), null);
});

test("releasePayload returns contract_version=1 with 40-char SHA", () => {
  const payload = releasePayload({
    RELEASE_SHA: "a".repeat(40),
    RELEASE_BUILT_AT: "2026-08-30T00:00:00Z",
  });
  assert.deepEqual(payload, {
    application: "order",
    release_sha: "a".repeat(40),
    built_at: "2026-08-30T00:00:00Z",
    contract_version: 1,
  });
});

test("releasePayload tolerates missing env", () => {
  const payload = releasePayload({});
  assert.equal(payload.application, "order");
  assert.equal(payload.release_sha, "");
  assert.equal(payload.built_at, "");
  assert.equal(payload.contract_version, 1);
});
