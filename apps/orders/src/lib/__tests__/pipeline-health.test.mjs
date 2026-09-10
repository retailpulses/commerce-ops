import test from "node:test";
import assert from "node:assert/strict";
import { collectPipelineHealthSnapshot, filterHealthSalesRows, healthOrderScopeKey, isShippedNotClosedCandidate } from "../pipeline-health.mjs";

test("completed marketplace orders are not reported as close backlog", () => {
  assert.equal(isShippedNotClosedCandidate({
    order_status: "COMPLETED",
    shipping_completed_at: "2026-06-11T12:28:33.548Z",
    shop_close_status: null,
  }), false);
});

test("non-terminal shipped orders without close completion remain backlog", () => {
  assert.equal(isShippedNotClosedCandidate({
    order_status: "WAITING_FOR_SHIPPING",
    shipping_completed_at: "2026-07-13T05:42:42.688Z",
    shop_close_status: null,
  }), true);
});

test("explicitly closed shipped orders are not backlog", () => {
  assert.equal(isShippedNotClosedCandidate({
    order_status: "WAITING_FOR_SHIPPING",
    shipping_completed_at: "2026-07-13T05:42:42.688Z",
    shop_close_status: "Completed",
  }), false);
});

test("health sales scope isolates Mercari and Rakuten without Mercari shop leakage", () => {
  const rows = [
    { id: "m1", sales_channel: "mercari", source_store_id: "shop-1" },
    { id: "m2", sales_channel: "mercari", source_store_id: "shop-2" },
    { id: "r1", sales_channel: "rakuten", source_store_id: "Rakuten" },
  ];
  assert.deepEqual(filterHealthSalesRows(rows, { platform: "Mercari", selectedShopIds: new Set(["shop-1"]) }).map((row) => row.id), ["m1"]);
  assert.deepEqual(filterHealthSalesRows(rows, { platform: "Rakuten" }).map((row) => row.id), ["r1"]);
});

test("health shipment identity preserves platform and store scope", () => {
  const sale = { sales_channel: "mercari", source_store_id: "shop-1", order_id: "order_same" };
  const matchingShipment = { SalesChannel: "Mercari", SourceStoreID: "shop-1", OrderId: "same" };
  const otherShopShipment = { SalesChannel: "Mercari", SourceStoreID: "shop-2", OrderId: "same" };
  assert.equal(healthOrderScopeKey(sale, "Mercari"), healthOrderScopeKey(matchingShipment, "Mercari"));
  assert.notEqual(healthOrderScopeKey(sale, "Mercari"), healthOrderScopeKey(otherShopShipment, "Mercari"));
});

test("scoped health audit binds database reads and defensive filters to one Mercari order", async () => {
  const reads = [];
  const targetStore = "ZaMyGWzp6hUdgDh5E9ADob";
  const snapshot = await collectPipelineHealthSnapshot({}, {
    shops: ["Shop2"], salesChannel: "Mercari", orderId: "order_target",
  }, {
    client: { salesOrderTableId: "sales", shipmentOrderTableId: "shipments" },
    listAllRows: async (_client, table, filters) => {
      reads.push({ table, filters });
      if (table === "sales") return [
        { id: "target-sale", sales_channel: "mercari", source_store_id: targetStore, order_id: "target" },
        { id: "neighbor-sale", sales_channel: "mercari", source_store_id: targetStore, order_id: "neighbor" },
      ];
      return [
        { id: "target-shipment", SalesChannel: "Mercari", SourceStoreID: targetStore, OrderId: "target" },
        { id: "neighbor-shipment", SalesChannel: "Mercari", SourceStoreID: targetStore, OrderId: "neighbor" },
      ];
    },
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.scoped, true);
  assert.equal(snapshot.sales_rows, 1);
  assert.equal(snapshot.shipment_rows, 1);
  assert.ok(reads.every(({ filters }) => Object.values(filters).includes("target")));
  assert.ok(reads.every(({ filters }) => Object.values(filters).includes(targetStore)));
});

test("scoped health audit fails when neither canonical table contains the target", async () => {
  const snapshot = await collectPipelineHealthSnapshot({}, {
    shops: [], salesChannel: "Rakuten", orderId: "missing",
  }, {
    client: { salesOrderTableId: "sales", shipmentOrderTableId: "shipments" },
    listAllRows: async () => [],
  });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error, "scoped_health_target_not_found");
});
