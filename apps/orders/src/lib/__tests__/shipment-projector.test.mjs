import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMatchingShipmentRows } from "../shipment-projector.mjs";

// The SHIPMENT_FIELDS map uses PascalCase keys: OrderId, BuyerPlatformSku,
// B2BItemCode, SourceStoreID, LineItemNumber.
function shipmentRow(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    OrderId: overrides.OrderId ?? "order-1",
    BuyerPlatformSku: overrides.BuyerPlatformSku ?? "SKU-A",
    B2BItemCode: overrides.B2BItemCode ?? "SKU-A",
    SourceStoreID: overrides.SourceStoreID ?? "store1",
    LineItemNumber: overrides.LineItemNumber ?? "1",
    ShipToQty: overrides.ShipToQty ?? 1,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    OrderId: overrides.OrderId ?? "order-1",
    BuyerPlatformSku: overrides.BuyerPlatformSku ?? "SKU-A",
    B2BItemCode: overrides.B2BItemCode ?? "SKU-A",
    SourceStoreID: overrides.SourceStoreID ?? "store1",
    LineItemNumber: overrides.LineItemNumber ?? "1",
    ...overrides,
  };
}

describe("findMatchingShipmentRows", () => {
  it("matches by same orderId + SKU + sourceStoreId", () => {
    const rows = [shipmentRow()];
    const result = findMatchingShipmentRows(rows, payload());
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });

  it("no match — different orderId", () => {
    const rows = [shipmentRow({ OrderId: "order-1" })];
    const result = findMatchingShipmentRows(rows, payload({ OrderId: "order-2" }));
    assert.equal(result.length, 0);
  });

  it("no match — different SKU", () => {
    const rows = [shipmentRow({ BuyerPlatformSku: "SKU-A", B2BItemCode: "SKU-A" })];
    const result = findMatchingShipmentRows(rows, payload({ BuyerPlatformSku: "SKU-B" }));
    assert.equal(result.length, 0);
  });

  it("no match — different sourceStoreId", () => {
    const rows = [shipmentRow({ SourceStoreID: "store1" })];
    const result = findMatchingShipmentRows(rows, payload({ SourceStoreID: "store2" }));
    assert.equal(result.length, 0);
  });

  it("matches using b2bItemCode fallback when BuyerPlatformSku is empty on row", () => {
    const rows = [shipmentRow({ BuyerPlatformSku: "", B2BItemCode: "SKU-A" })];
    const result = findMatchingShipmentRows(rows, payload({ BuyerPlatformSku: "SKU-A" }));
    assert.equal(result.length, 1);
  });

  it("no match via lineItemNumber alone (OR logic removed)", () => {
    // Before the fix, this would match because LineItemNumber === "1".
    // After the fix, different SKU means no match even if LineItemNumber matches.
    const rows = [shipmentRow({ BuyerPlatformSku: "SKU-A", LineItemNumber: "1" })];
    const result = findMatchingShipmentRows(rows, payload({ BuyerPlatformSku: "SKU-B", LineItemNumber: "1" }));
    assert.equal(result.length, 0, "must not match different SKU by LineItemNumber alone");
  });

  it("returns multiple matches when rows exist across different LineItemNumbers with same SKU", () => {
    const rows = [
      shipmentRow({ id: 1, LineItemNumber: "1", BuyerPlatformSku: "SKU-A" }),
      shipmentRow({ id: 2, LineItemNumber: "2", BuyerPlatformSku: "SKU-A" }),
    ];
    const result = findMatchingShipmentRows(rows, payload({ BuyerPlatformSku: "SKU-A" }));
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result.map((r) => r.id).sort(), [1, 2]);
  });

  it("empty rows → empty result", () => {
    const result = findMatchingShipmentRows([], payload());
    assert.equal(result.length, 0);
  });

  it("multiple shops, same orderId+SKU → matches only correct shop", () => {
    const rows = [
      shipmentRow({ id: 1, SourceStoreID: "store1", OrderId: "order-X", BuyerPlatformSku: "SKU-A" }),
      shipmentRow({ id: 2, SourceStoreID: "store2", OrderId: "order-X", BuyerPlatformSku: "SKU-A" }),
    ];
    const result = findMatchingShipmentRows(rows, payload({ SourceStoreID: "store1", OrderId: "order-X", BuyerPlatformSku: "SKU-A" }));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });
});
