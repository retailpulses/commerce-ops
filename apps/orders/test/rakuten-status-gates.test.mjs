import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRmsOrderProgress } from "../src/lib/rakuten-ingest.mjs";
import {
  canConfirmRakutenOnRms,
  hasMappedRakutenProgress,
  isRakutenShipmentReady,
  planRakutenConfirmation,
} from "../src/lib/rakuten-status-gates.mjs";

test("RMS numeric 100-900 mapping is exact and auditable", () => {
  const expected = new Map([
    [100, "PENDING_CONFIRMATION"],
    [200, "WAITING_FOR_PAYMENT"],
    [300, "RMS_CONFIRMED"],
    [400, "PENDING_CONFIRMATION"],
    [500, "COMPLETED"],
    [600, "WAITING_FOR_PAYMENT"],
    [700, "CONFIRMED"],
    [800, "CANCELED"],
    [900, "CANCELED"],
  ]);
  for (const [raw, status] of expected) {
    const result = normalizeRmsOrderProgress(raw);
    assert.equal(result.raw, String(raw));
    assert.equal(result.status, status);
    assert.equal(result.mappingState, "MAPPED");
  }
});

test("only fresh mapped numeric 300 is shipment-ready", () => {
  assert.equal(isRakutenShipmentReady({ rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED" }), true);
  for (const row of [
    { rakuten_order_progress: "700", rakuten_status_mapping_state: "MAPPED" },
    { rakuten_order_progress: "ORDER_START", rakuten_status_mapping_state: "MAPPED" },
    { rakuten_order_progress: "300", rakuten_status_mapping_state: "UNKNOWN" },
    { rakuten_order_progress: null, rakuten_status_mapping_state: "MISSING" },
    {},
  ]) {
    assert.equal(isRakutenShipmentReady(row), false);
  }
});

test("unknown and missing mappings fail closed", () => {
  for (const row of [
    { rakuten_order_progress: "999", rakuten_status_mapping_state: "UNKNOWN" },
    { rakuten_order_progress: null, rakuten_status_mapping_state: "MISSING" },
    {},
  ]) {
    assert.equal(hasMappedRakutenProgress(row), false);
    assert.equal(canConfirmRakutenOnRms(row), false);
    assert.equal(isRakutenShipmentReady(row), false);
  }
});

test("mapped payment-pending 200/600 may confirm on RMS without becoming shipment-ready", () => {
  for (const raw of ["200", "600"]) {
    const row = { rakuten_order_progress: raw, rakuten_status_mapping_state: "MAPPED" };
    assert.equal(canConfirmRakutenOnRms(row), true);
    assert.equal(isRakutenShipmentReady(row), false);
  }
});

test("Portal confirmation preserves payment-pending lifecycle", () => {
  const plan = planRakutenConfirmation({
    sales_channel: "rakuten",
    order_status: "WAITING_FOR_PAYMENT",
    rakuten_order_progress: "600",
    rakuten_status_mapping_state: "MAPPED",
  });
  assert.deepEqual(plan, { ok: true, nextStatus: "WAITING_FOR_PAYMENT" });
});

test("Portal confirmation blocks unknown/missing and non-confirmable states", () => {
  assert.equal(planRakutenConfirmation({ sales_channel: "rakuten", order_status: "PENDING_CONFIRMATION", rakuten_status_mapping_state: "UNKNOWN" }).ok, false);
  assert.equal(planRakutenConfirmation({ sales_channel: "rakuten", order_status: "CONFIRMED", rakuten_order_progress: "700", rakuten_status_mapping_state: "MAPPED" }).ok, false);
});
