import { describe, expect, it } from "vitest";
import { getProductInventory, getProductPricing } from "../product-pricing";

describe("getProductPricing", () => {
  it("extracts imported Mercari pricing and removes currency formatting", () => {
    const pricing = getProductPricing({
      id: "variant-1",
      item_code: "SKU-1",
      variant_name: "Chair",
      stock_qty: 2,
      raw_payload: {
        "mercari_effective_pricing_excl._shipping": "3,000",
        "mercari_effective_pricing_incl._shipping": "￥5,000",
        effective_tcogs: "3,302",
      },
    });

    expect(pricing).toEqual({
      effectivePriceExclShipping: 3000,
      effectivePriceInclShipping: 5000,
      effectiveTCOGS: 3302,
    });
  });

  it("returns null for absent or invalid pricing", () => {
    const pricing = getProductPricing({
      id: "variant-2",
      item_code: null,
      variant_name: null,
      stock_qty: null,
      raw_payload: { effective_tcogs: "N/A" },
    });

    expect(pricing).toEqual({
      effectivePriceExclShipping: null,
      effectivePriceInclShipping: null,
      effectiveTCOGS: null,
    });
  });
});

describe("getProductInventory", () => {
  it("prefers canonical GigaB2B store_name over legacy raw payload", () => {
    const inventory = getProductInventory({
      id: "variant-seller",
      item_code: "W770S00006",
      variant_name: "Cabinet",
      store_name: "Canonical supplier",
      raw_payload: { store_name: "Legacy supplier" },
    });

    expect(inventory.storeName).toBe("Canonical supplier");
  });

  it("extracts imported inventory details", () => {
    const inventory = getProductInventory({
      id: "variant-1",
      item_code: "SKU-1",
      variant_name: "Chair",
      stock_qty: 0,
      raw_payload: {
        store_name: " HEYA ",
      },
      product_commercials: {
        source_available_qty: "53",
        owned_qty: "0",
        restock_date: "2026-09-01",
        last_sync_success_at: "2026-08-29T12:31:00Z",
      },
      product_platform_links: [{
        shop_code: "shop1",
        platform: "mercari",
        platform_listing_skus: { stock_qty: "2" },
      }],
    });

    expect(inventory).toEqual({
      storeName: "HEYA",
      qtyAvailable: 53,
      ownedQty: 0,
      mercariQty: 2,
      restockDate: "2026-09-01",
    });
  });

  it("returns unknown instead of falling back to stale legacy inventory", () => {
    const inventory = getProductInventory({
      id: "variant-2",
      item_code: "SKU-2",
      variant_name: "Table",
      stock_qty: 99,
      raw_payload: { qty_available: "88", owned_qty: "7", mercari_qty: "6" },
    });

    expect(inventory).toEqual({
      storeName: null,
      qtyAvailable: null,
      ownedQty: null,
      mercariQty: null,
      restockDate: null,
    });
  });

  it("rejects invalid or negative quantities", () => {
    const inventory = getProductInventory({
      id: "variant-3",
      item_code: "SKU-3",
      variant_name: "Shelf",
      product_commercials: {
        source_available_qty: "unknown",
        owned_qty: -1,
        restock_date: null,
        last_sync_success_at: null,
      },
      product_platform_links: [{
        shop_code: "shop1",
        platform: "mercari",
        platform_listing_skus: { stock_qty: "2.5" },
      }],
    });

    expect(inventory.qtyAvailable).toBeNull();
    expect(inventory.ownedQty).toBeNull();
    expect(inventory.mercariQty).toBeNull();
  });
});
