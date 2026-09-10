import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCommercialRows, resolveMetricsWindow } from "../src/lib/portal/metrics.mjs";

test("current_month uses exact JST month boundary", () => {
  assert.deepEqual(resolveMetricsWindow("current_month", new Date("2026-08-31T06:00:00Z")), {
    key: "current_month", start: "2026-07-31T15:00:00.000Z", end: "2026-08-31T06:00:00.000Z", timezone: "Asia/Tokyo",
  });
});

test("commercial rows reconcile shops and unmapped supplier", () => {
  const result = aggregateCommercialRows([
    { id: "1", order_id: "A", sales_channel: "mercari", source_store_id: "shop1", b2b_item_code: "SKU1", product_name: "Chair", quantity: 2, product_price: 1000 },
    { id: "2", order_id: "A", sales_channel: "mercari", source_store_id: "shop1", b2b_item_code: "SKU2", product_name: "Desk", quantity: 1, product_price: 3000 },
  ]);
  assert.deepEqual(result.totals, { order_count: 1, units_sold: 3, gross_sales_jpy: 5000 });
  assert.equal(result.by_shop_account[0].gross_sales_jpy, 5000);
  assert.equal(result.by_supplier[0].key, "unmapped_supplier");
});

test("commercial order counts preserve channel and store scope", () => {
  const result = aggregateCommercialRows([
    { id: "1", order_id: "order_same", sales_channel: "mercari", source_store_id: "shop1", quantity: 1, product_price: 1000 },
    { id: "2", order_id: "same", sales_channel: "mercari", source_store_id: "shop2", quantity: 1, product_price: 2000 },
    { id: "3", order_id: "same", sales_channel: "rakuten", source_store_id: "shop1", quantity: 1, product_price: 3000 },
  ]);
  assert.equal(result.totals.order_count, 3);
});
