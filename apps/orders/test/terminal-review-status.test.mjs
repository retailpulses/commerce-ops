import assert from "node:assert/strict";
import test from "node:test";

import { buildCompletedSalesTrackingUpdate } from "../src/lib/tracking-reconciler.mjs";
import { buildTerminalReviewClearPatch } from "../src/lib/cancellation-reconciler.mjs";
import { mapReviewStatus, transformSalesRow } from "../scripts/migrate-to-supabase.mjs";
import {
  applyTerminalReviewInvariant,
  buildTerminalStatusPatch,
} from "../scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs";

test("bridge maps terminal Mercari review statuses to null", () => {
  for (const orderStatus of ["COMPLETED", "CANCELED", { value: "COMPLETED" }]) {
    assert.equal(mapReviewStatus("Approved", orderStatus), null);
    assert.equal(mapReviewStatus("Pending Review", orderStatus), null);
  }
});

test("bridge retains active review mapping and default", () => {
  assert.equal(mapReviewStatus("Approved", "WAITING_FOR_SHIPPING"), "APPROVED");
  assert.equal(mapReviewStatus(null, "WAITING_FOR_SHIPPING"), "PENDING_REVIEW");
});

test("sales bridge transform cannot recreate a terminal review queue value", () => {
  const transformed = transformSalesRow({
    order_id: "terminal-order",
    shop_id: "shop-id",
    order_status: { value: "COMPLETED" },
    review_status: { value: "Pending Review" },
  }, "mercari", new Map(), "");

  assert.equal(transformed.order_status, "COMPLETED");
  assert.equal(transformed.review_status, null);
});

test("tracking completion clears review status in rich and fallback writes", () => {
  const update = buildCompletedSalesTrackingUpdate({
    carrierSummary: "Yamato",
    trackingDetailSummary: "Yamato: 123",
  }, "2026-07-15T00:00:00.000Z");

  for (const payload of [update.rich, update.legacy]) {
    assert.equal(payload.order_status, "COMPLETED");
    assert.equal(payload.review_status, null);
  }
});

test("Mercari terminal ingest clears review in the order-status patch", () => {
  assert.deepEqual(buildTerminalStatusPatch("COMPLETED"), {
    order_status: "COMPLETED",
    review_status: null,
  });
});

test("Mercari cancellation updates clear review in the same ingest patch", () => {
  assert.deepEqual(applyTerminalReviewInvariant({ order_status: "CANCELED" }), {
    order_status: "CANCELED",
    review_status: null,
  });
  assert.deepEqual(applyTerminalReviewInvariant({ order_status: "WAITING_FOR_SHIPPING" }), {
    order_status: "WAITING_FOR_SHIPPING",
  });
});

test("cancellation cleanup sends SQL null instead of an invalid empty string", () => {
  assert.deepEqual(buildTerminalReviewClearPatch(), { review_status: null });
});
