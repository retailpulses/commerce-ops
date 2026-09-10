import assert from "node:assert/strict";
import test from "node:test";
import { orderScopeKey, reconcileMercariCancellations } from "../src/lib/cancellation-reconciler.mjs";

test("cancellation reconciliation never invalidates a same-number order in another shop", async () => {
  const shopA = "WMyisFmhbGWyVAPEwsfirn";
  const shopB = "ZaMyGWzp6hUdgDh5E9ADob";
  const client = { salesOrderTableId: "sales", shipmentOrderTableId: "shipments" };
  let salesRead = 0;
  const patched = [];
  const canceledRows = [
    { id: "sale-a", order_id: "order_same", source_store_id: shopA, order_status: "CANCELED", review_status: null },
    { id: "sale-b", order_id: "order_same", source_store_id: shopB, order_status: "CANCELED", review_status: null },
  ];

  const result = await reconcileMercariCancellations({}, {
    shops: ["Shop1"],
    _inject: {
      client,
      listAllRows: async (_client, tableId) => {
        if (tableId === "shipments") {
          return [
            { id: "shipment-a", OrderId: "same", SourceStoreID: shopA, giga_sync_status: "Synced" },
            { id: "shipment-b", OrderId: "same", SourceStoreID: shopB, giga_sync_status: "Synced" },
          ];
        }
        salesRead += 1;
        if (salesRead === 1) {
          return [{ id: "candidate-a", order_id: "order_same", source_store_id: shopA, order_status: "WAITING_FOR_SHIPPING" }];
        }
        if (salesRead === 2) return [];
        return canceledRows;
      },
      runMercariIngestViaRelay: async () => ({ ok: true, status: 200, body: { ok: true } }),
      patchRow: async (_client, tableId, rowId) => {
        patched.push({ tableId, rowId });
        return { ok: true };
      },
    },
  });

  assert.equal(result.counts.canceled_after_reconcile, 1);
  assert.deepEqual(patched, [{ tableId: "shipments", rowId: "shipment-a" }]);
});

test("order scope normalizes IDs and includes source store", () => {
  assert.equal(orderScopeKey({ order_id: "order_abc", source_store_id: "shop-a" }), "shop-a:abc");
  assert.equal(orderScopeKey({ OrderId: "abc", SourceStoreID: "shop-b" }), "shop-b:abc");
});
