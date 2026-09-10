import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adminAuthErrorResponse,
  requireAdminAuth,
  validateAdminToken,
} from "../admin-auth.mjs";

describe("validateAdminToken", () => {
  it("accepts an exact token match", () => {
    assert.equal(validateAdminToken("secret-123", "secret-123"), true);
  });

  it("rejects wrong, empty, shorter, longer, and case-mismatched tokens", () => {
    assert.equal(validateAdminToken("wrong-secret", "secret-123"), false);
    assert.equal(validateAdminToken("", "secret-123"), false);
    assert.equal(validateAdminToken("secret-123", ""), false);
    assert.equal(validateAdminToken("secret", "secret-123"), false);
    assert.equal(validateAdminToken("secret-123-extra", "secret-123"), false);
    assert.equal(validateAdminToken("SECRET-123", "secret-123"), false);
  });

  it("compares equal-length wrong strings without early match semantics", () => {
    assert.equal(validateAdminToken("abcdefgX", "abcdefgh"), false);
    assert.equal(validateAdminToken("Xbcdefgh", "abcdefgh"), false);
  });
});

describe("requireAdminAuth", () => {
  const env = { ORDER_MGMT_ADMIN_SECRET: "secret-123" };

  it("accepts valid Bearer auth", () => {
    const request = new Request("https://example.test/admin/run-once", {
      headers: { Authorization: "Bearer secret-123" },
    });
    assert.equal(requireAdminAuth(request, env), true);
  });

  it("rejects missing, invalid, and unset-secret auth", () => {
    assert.equal(requireAdminAuth(new Request("https://example.test/admin/run-once"), env), false);
    assert.equal(requireAdminAuth(new Request("https://example.test/admin/run-once", {
      headers: { Authorization: "Bearer wrong-secret" },
    }), env), false);
    assert.equal(requireAdminAuth(new Request("https://example.test/admin/run-once", {
      headers: { Authorization: "Bearer secret-123" },
    }), {}), false);
  });

  it("accepts legacy GIGA_SYNC_ADMIN_SECRET when ORDER_MGMT_ADMIN_SECRET is not set", () => {
    const request = new Request("https://example.test/admin/run-once", {
      headers: { Authorization: "Bearer legacy-secret" },
    });
    assert.equal(requireAdminAuth(request, { GIGA_SYNC_ADMIN_SECRET: "legacy-secret" }), true);
  });
});

describe("adminAuthErrorResponse", () => {
  it("returns a generic no-store 401 JSON response", async () => {
    const response = adminAuthErrorResponse();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  });
});
