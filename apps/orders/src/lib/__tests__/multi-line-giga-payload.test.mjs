import test from "node:test";
import assert from "node:assert/strict";
import { buildShipmentPayload } from "../shipment-projector.mjs";
import { dedupeOrderLines } from "../outbound-sync.mjs";

function salesLine(id, code, quantity = 1) {
  return {
    id,
    order_id: "order_2JW3bPgq8GjmaYwCdScDXk",
    purchase_date: "2026-08-30T01:00:00Z",
    product_name: `Product ${id}`,
    quantity,
    product_price: 1000,
    shipping_postal_code: "1000001",
    shipping_state: "Tokyo",
    shipping_city: "Chiyoda",
    shipping_address_1: "1-1",
    shipping_name: "Test Buyer",
    shipping_phone_number: "09012345678",
    shop_id: "WMyisFmhbGWyVAPEwsfirn",
    B2BItemCode: code,
  };
}

test("three portal-resolved SKU lines become three GigaB2B orderLines", () => {
  const projections = [
    salesLine(101, "B2B-A", 1),
    salesLine(102, "B2B-B", 2),
    salesLine(103, "B2B-C", 1),
  ].map((line, index) => ({ id: line.id, ...buildShipmentPayload(line, String(index + 1)) }));

  assert.deepEqual(projections.map((row) => row.LineItemNumber), ["1", "2", "3"]);
  const outbound = dedupeOrderLines(projections, "2JW3bPgq8GjmaYwCdScDXk");
  assert.deepEqual(outbound.lines.map((line) => ({ sku: line.sku, qty: line.qty })), [
    { sku: "B2B-A", qty: 1 },
    { sku: "B2B-B", qty: 2 },
    { sku: "B2B-C", qty: 1 },
  ]);
  assert.deepEqual(outbound.duplicateRowIds, []);
});
