import { describe, expect, it } from "vitest";
import {
  needsCatalogFallback,
  resolveInquiryValues,
  selectPrimaryProductId,
} from "../inquiry-value";

const baseFields = {
  units: null,
  effective_price_excl_shipping: null,
  effective_price_incl_shipping: null,
  effective_tcogs: null,
  expected_value: null,
};

describe("needsCatalogFallback", () => {
  it("requires fallback only when value and incl price are null and a product is linked", () => {
    expect(needsCatalogFallback({ ...baseFields, has_product: true })).toBe(true);
  });

  it("skips fallback when expected_value is persisted", () => {
    expect(
      needsCatalogFallback({ ...baseFields, expected_value: 100, has_product: true }),
    ).toBe(false);
  });

  it("skips fallback when incl price is persisted (sufficient to compute)", () => {
    expect(
      needsCatalogFallback({ ...baseFields, effective_price_incl_shipping: 500, has_product: true }),
    ).toBe(false);
  });

  it("skips fallback when no product is linked", () => {
    expect(needsCatalogFallback({ ...baseFields, has_product: false })).toBe(false);
  });
});

describe("resolveInquiryValues", () => {
  it("prefers persisted values over catalog pricing", () => {
    const values = resolveInquiryValues(
      {
        units: 3,
        effective_price_excl_shipping: 100,
        effective_price_incl_shipping: 120,
        effective_tcogs: 80,
        expected_value: 999,
      },
      {
        effectivePriceExclShipping: 200,
        effectivePriceInclShipping: 220,
        effectiveTCOGS: 180,
      },
    );

    expect(values).toEqual({
      effectivePriceExclShipping: 100,
      effectivePriceInclShipping: 120,
      effectiveTCOGS: 80,
      expectedValue: 999,
    });
  });

  it("falls back to catalog pricing when persisted values are null", () => {
    const values = resolveInquiryValues(baseFields, {
      effectivePriceExclShipping: 3000,
      effectivePriceInclShipping: 5000,
      effectiveTCOGS: 3302,
    });

    expect(values).toEqual({
      effectivePriceExclShipping: 3000,
      effectivePriceInclShipping: 5000,
      effectiveTCOGS: 3302,
      expectedValue: 5000, // units default to 1
    });
  });

  it("computes expected value as units * incl price when no persisted expected value", () => {
    const values = resolveInquiryValues(
      { ...baseFields, units: 2, effective_price_incl_shipping: 400 },
      null,
    );

    expect(values.expectedValue).toBe(800);
  });

  it("returns null expected value when incl price is unavailable", () => {
    const values = resolveInquiryValues(
      { ...baseFields, units: 5, effective_price_excl_shipping: 100 },
      null,
    );

    expect(values.effectivePriceExclShipping).toBe(100);
    expect(values.expectedValue).toBeNull();
  });
});

describe("selectPrimaryProductId", () => {
  it("prefers the primary link over earlier non-primary links", () => {
    const variantId = selectPrimaryProductId([
      { product_variant_id: "earlier", is_primary: false },
      { product_variant_id: "primary", is_primary: true },
    ]);

    expect(variantId).toBe("primary");
  });

  it("falls back to the earliest linked product when no primary exists", () => {
    const variantId = selectPrimaryProductId([
      { product_variant_id: "first", is_primary: false },
      { product_variant_id: "second", is_primary: false },
    ]);

    expect(variantId).toBe("first");
  });

  it("returns null when there are no links", () => {
    expect(selectPrimaryProductId([])).toBeNull();
  });
});
