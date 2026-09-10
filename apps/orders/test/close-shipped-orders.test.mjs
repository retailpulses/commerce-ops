import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShipmentCloseCandidates,
  buildShipmentTrackingGroups,
} from "../scripts/close_all_shipped_orders.mjs";

const SHOP4 = "2JMLHBxjiFHDr55jMwA7fs";

function shipment(overrides = {}) {
  return {
    id: 1,
    order_id: "order_test-1",
    sales_channel: "mercari",
    source_store_id: SHOP4,
    giga_tracking_raw: JSON.stringify([
      { carrierName: "Yamato", trackingNum: "TRACK-1" },
    ]),
    shipping_completed_at: "2026-06-20T00:00:00Z",
    shop_close_status: "",
    ...overrides,
  };
}

test("shipment tracking qualifies without a sales row", () => {
  const candidates = buildShipmentCloseCandidates([shipment()]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].orderId, "test-1");
  assert.deepEqual(candidates[0].trackingEntries, [
    { carrierName: "Yamato", trackingNum: "TRACK-1" },
  ]);
});

test("tracking-less shipments do not qualify", () => {
  assert.deepEqual(buildShipmentCloseCandidates([
    shipment({ giga_tracking_raw: "", giga_tracking_info: "" }),
  ]), []);
});

test("legacy shipment close state does not override canonical sales close state", () => {
  const candidates = buildShipmentCloseCandidates([
    shipment({ shop_close_status: "Completed" }),
    shipment({ id: 2, order_id: "order_test-2", shop_close_status: "Not Applicable" }),
  ]);
  assert.equal(candidates.length, 2);
});

test("shipment lines are grouped and tracking entries deduplicated", () => {
  const candidates = buildShipmentCloseCandidates([
    shipment(),
    shipment({ id: 2, line_item_number: "2" }),
  ]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].rows.map((row) => row.id), [1, 2]);
  assert.equal(candidates[0].trackingEntries.length, 1);
});

test("completed groups remain available for independent sales backfill", () => {
  const groups = buildShipmentTrackingGroups([
    shipment({ shop_close_status: "Completed" }),
  ], new Set(), true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].orderId, "test-1");
});

test("non-Mercari, unknown-shop, and malformed tracking rows are excluded", () => {
  assert.deepEqual(buildShipmentCloseCandidates([
    shipment({ sales_channel: "rakuten" }),
    shipment({ id: 2, source_store_id: "unknown" }),
    shipment({ id: 3, giga_tracking_raw: "not-json", giga_tracking_info: "bad" }),
  ]), []);
});
