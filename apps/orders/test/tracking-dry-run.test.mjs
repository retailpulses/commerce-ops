import assert from "node:assert/strict";
import test from "node:test";
import { MERCARI_CHANNEL, RAKUTEN_CHANNEL } from "../src/lib/channel-config.mjs";
import { reconcileGigaTracking } from "../src/lib/tracking-reconciler.mjs";

function trackingResponse(orderNo) {
  return {
    data: [{
      orderNo,
      shipTrackInfo: [{ carrierName: "Carrier", trackingNum: "TRACK-1" }],
    }],
    requestId: "tracking-read-1",
  };
}

test("Mercari tracking dry-run reads Giga but never patches shipment or sales rows", async () => {
  const baserow = { shipmentOrderTableId: "shipments", salesOrderTableId: "sales" };
  let patchCalls = 0;
  let gigaReads = 0;
  let salesReads = 0;
  const result = await reconcileGigaTracking({
    baserow,
    giga: { getTrackingInfo: async () => { gigaReads += 1; return trackingResponse("order-1"); } },
    channelConfig: MERCARI_CHANNEL,
    context: { shops: ["Shop1"], limit: 1, dryRun: true },
    dependencies: {
      listAllRows: async (_client, tableId) => {
        if (tableId === "shipments") {
          return [{ id: "shipment-1", OrderId: "order-1", SalesChannel: "Mercari", SourceStoreID: MERCARI_CHANNEL.shopIds.Shop1 }];
        }
        salesReads += 1;
        return salesReads === 1 ? [{ id: "sale-1", order_id: "order-1", sales_channel: "mercari", source_store_id: MERCARI_CHANNEL.shopIds.Shop1 }] : [];
      },
      patchRowWithFallback: async () => { patchCalls += 1; return { ok: true }; },
    },
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.side_effects, 0);
  assert.equal(result.planned_shipment_updates, 1);
  assert.equal(result.planned_sales_updates, 1);
  assert.equal(gigaReads, 1);
  assert.equal(patchCalls, 0);
});

test("tracking fails closed on same-number orders across stores", async () => {
  const baserow = { shipmentOrderTableId: "shipments", salesOrderTableId: "sales" };
  let gigaReads = 0;
  let patchCalls = 0;
  const result = await reconcileGigaTracking({
    baserow,
    giga: { getTrackingInfo: async () => { gigaReads += 1; return trackingResponse("same"); } },
    channelConfig: MERCARI_CHANNEL,
    context: { shops: ["Shop1", "Shop2"], limit: 10, dryRun: false },
    dependencies: {
      listAllRows: async (_client, tableId) => tableId === "shipments" ? [
        { id: "shipment-1", OrderId: "same", SalesChannel: "Mercari", SourceStoreID: MERCARI_CHANNEL.shopIds.Shop1 },
        { id: "shipment-2", OrderId: "same", SalesChannel: "Mercari", SourceStoreID: MERCARI_CHANNEL.shopIds.Shop2 },
      ] : [],
      patchRowWithFallback: async () => { patchCalls += 1; return { ok: true }; },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.scope_conflict_count, 1);
  assert.equal(gigaReads, 0);
  assert.equal(patchCalls, 0);
});

test("Rakuten tracking dry-run never patches shipment rows", async () => {
  const baserow = { shipmentOrderTableId: "shipments" };
  const salesBaserow = { salesOrderTableId: "rakuten-sales" };
  let patchCalls = 0;
  const result = await reconcileGigaTracking({
    baserow,
    salesBaserow,
    giga: { getTrackingInfo: async () => trackingResponse("rakuten-1") },
    channelConfig: RAKUTEN_CHANNEL,
    context: { shops: ["Rakuten"], limit: 1, dryRun: true },
    dependencies: {
      listAllRows: async (_client, tableId) => tableId === "shipments"
        ? [{ id: "shipment-r1", OrderId: "rakuten-1", SalesChannel: "Rakuten", SourceStoreID: "Rakuten" }]
        : [{ id: "sale-r1", order_id: "rakuten-1" }],
      patchRowWithFallback: async () => { patchCalls += 1; return { ok: true }; },
    },
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.side_effects, 0);
  assert.equal(result.planned_shipment_updates, 1);
  assert.equal(result.planned_sales_updates, 0);
  assert.equal(patchCalls, 0);
});

test("tracking applies exact scope and limit globally before any Giga read", async () => {
  const baserow = { shipmentOrderTableId: "shipments", salesOrderTableId: "sales" };
  const requested = [];
  const shipments = Array.from({ length: 25 }, (_, index) => ({
    id: `shipment-${index}`, OrderId: index === 24 ? "target" : `neighbor-${index}`,
    SalesChannel: "Mercari", SourceStoreID: MERCARI_CHANNEL.shopIds.Shop1,
  }));
  const result = await reconcileGigaTracking({
    baserow,
    giga: { getTrackingInfo: async (ids) => { requested.push(ids); return { data: [], requestId: "bounded" }; } },
    channelConfig: MERCARI_CHANNEL,
    context: { shops: ["Shop1"], limit: 1, orderId: "order_target", dryRun: true },
    dependencies: {
      listAllRows: async (_client, tableId) => tableId === "shipments" ? shipments : [],
      patchRowWithFallback: async () => { throw new Error("unexpected_patch"); },
    },
  });
  assert.deepEqual(requested, [["target"]]);
  assert.equal(result.candidate_orders, 1);
  assert.equal(result.selected_orders, 1);
  assert.equal(result.order_filter, "target");
});

test("tracking limit is global across more than one provider batch", async () => {
  const baserow = { shipmentOrderTableId: "shipments", salesOrderTableId: "sales" };
  const requested = [];
  const shipments = Array.from({ length: 45 }, (_, index) => ({
    id: `shipment-${index}`, OrderId: `order-${index}`, SalesChannel: "Mercari", SourceStoreID: MERCARI_CHANNEL.shopIds.Shop1,
  }));
  const result = await reconcileGigaTracking({
    baserow, giga: { getTrackingInfo: async (ids) => { requested.push(ids); return { data: [] }; } },
    channelConfig: MERCARI_CHANNEL, context: { shops: ["Shop1"], limit: 21, dryRun: true },
    dependencies: { listAllRows: async (_client, tableId) => tableId === "shipments" ? shipments : [] },
  });
  assert.deepEqual(requested.map((batch) => batch.length), [20, 1]);
  assert.equal(result.selected_orders, 21);
});
