import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveB2BItemCode, mercariResolveItemCode } from "../item-code-resolver.mjs";

// ── mercariResolveItemCode tests ──────────────────────────────────────

describe("mercariResolveItemCode", () => {
  // Rule 3: pass-through (normal case)
  it("passes through normal SKU", () => {
    const result = mercariResolveItemCode("7824213");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "7824213");
    assert.equal(result.reason, null);
  });

  it("passes through alphanumeric SKU", () => {
    const result = mercariResolveItemCode("ABC123");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "ABC123");
  });

  it("passes through SKU with underscores", () => {
    const result = mercariResolveItemCode("PRODUCT_001");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "PRODUCT_001");
  });

  // Rule 1: RP prefix → skip (internal fee adjustment)
  it("skips SKU starting with RP (uppercase)", () => {
    const result = mercariResolveItemCode("RP00123");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "rp_fee_adjustment");
  });

  it("skips SKU starting with rp (lowercase)", () => {
    const result = mercariResolveItemCode("rp-fee-adjustment");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    // RP match takes priority over hyphen rule
    assert.equal(result.reason, "rp_fee_adjustment");
  });

  it("skips exact RP string", () => {
    const result = mercariResolveItemCode("RP");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "rp_fee_adjustment");
  });

  // Rule 2: contains hyphen → skip (ambiguous)
  it("skips SKU containing hyphen", () => {
    const result = mercariResolveItemCode("SKU-001");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "ambiguous_hyphen");
  });

  it("skips SKU with multiple hyphens", () => {
    const result = mercariResolveItemCode("A-B-C");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "ambiguous_hyphen");
  });

  // RP rule takes priority over hyphen rule
  it("RP prefix takes priority over hyphen rule", () => {
    const result = mercariResolveItemCode("RP-SKU-001");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "rp_fee_adjustment");
  });

  // Empty / null / whitespace
  it("returns unresolved for empty string", () => {
    const result = mercariResolveItemCode("");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "empty_sku");
  });

  it("returns unresolved for null/undefined input", () => {
    const result = mercariResolveItemCode(null);
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "empty_sku");
  });

  it("returns unresolved for whitespace-only input", () => {
    const result = mercariResolveItemCode("   ");
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "empty_sku");
  });

  // Trimming
  it("trims whitespace around SKU before resolving", () => {
    const result = mercariResolveItemCode("  7824213  ");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "7824213");
  });

  // Numeric-only SKU
  it("passes through numeric-only SKU", () => {
    const result = mercariResolveItemCode("1234567890");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "1234567890");
  });
});

// ── resolveB2BItemCode (channel-agnostic) tests ───────────────────────

describe("resolveB2BItemCode — channel-agnostic API", () => {
  it("returns unresolved for empty originalProductId", () => {
    const result = resolveB2BItemCode("", {});
    assert.equal(result.resolved, false);
    assert.equal(result.code, null);
    assert.equal(result.reason, "empty_original_product_id");
  });

  it("passes through when no channelConfig provided", () => {
    const result = resolveB2BItemCode("SKU123");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "SKU123");
    assert.equal(result.reason, null);
  });

  it("passes through when channelConfig has no itemCodeResolver", () => {
    const result = resolveB2BItemCode("SKU123", { salesChannel: "Unknown" });
    assert.equal(result.resolved, true);
    assert.equal(result.code, "SKU123");
  });

  it("delegates to channelConfig.itemCodeResolver when present", () => {
    const result = resolveB2BItemCode("RP-FEE", {
      itemCodeResolver: mercariResolveItemCode,
    });
    assert.equal(result.resolved, false);
    assert.equal(result.reason, "rp_fee_adjustment");
  });

  it("delegates normal SKU through channelConfig resolver", () => {
    const result = resolveB2BItemCode("NORMAL_SKU", {
      itemCodeResolver: mercariResolveItemCode,
    });
    assert.equal(result.resolved, true);
    assert.equal(result.code, "NORMAL_SKU");
  });

  it("handles null channelConfig gracefully", () => {
    const result = resolveB2BItemCode("SKU123", null);
    assert.equal(result.resolved, true);
    assert.equal(result.code, "SKU123");
  });
});
