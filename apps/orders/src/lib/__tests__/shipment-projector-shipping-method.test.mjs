import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GIGA_INELIGIBLE_SHIPPING_METHODS,
  isGigaEligibleShippingMethod,
} from "../shipment-projector.mjs";

describe("GIGA_INELIGIBLE_SHIPPING_METHODS", () => {
  it("contains MERCARI_SHIPPING_YAMATO", () => {
    assert.ok(GIGA_INELIGIBLE_SHIPPING_METHODS.has("MERCARI_SHIPPING_YAMATO"));
  });

  it("is a Set", () => {
    assert.ok(GIGA_INELIGIBLE_SHIPPING_METHODS instanceof Set);
  });
});

describe("isGigaEligibleShippingMethod", () => {
  it("returns false for MERCARI_SHIPPING_YAMATO", () => {
    assert.equal(isGigaEligibleShippingMethod("MERCARI_SHIPPING_YAMATO"), false);
  });

  it("returns false for whitespace-padded MERCARI_SHIPPING_YAMATO", () => {
    assert.equal(isGigaEligibleShippingMethod(" MERCARI_SHIPPING_YAMATO "), false);
  });

  it("returns true for empty string", () => {
    assert.equal(isGigaEligibleShippingMethod(""), true);
  });

  it("returns true for null", () => {
    assert.equal(isGigaEligibleShippingMethod(null), true);
  });

  it("returns true for undefined", () => {
    assert.equal(isGigaEligibleShippingMethod(undefined), true);
  });

  it("returns true for other Mercari shipping methods", () => {
    assert.equal(isGigaEligibleShippingMethod("MERCARI_SHIPPING_EASY"), true);
  });
});
