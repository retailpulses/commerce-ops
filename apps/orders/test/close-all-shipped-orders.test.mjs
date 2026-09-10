#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildShipmentCloseCandidates,
  buildShipmentTrackingGroups,
  buildSalesCloseOutcomePatches,
  buildSalesTrackingPatches,
  excludeTerminalSalesCandidates,
  mapCanonicalTracking,
  patchSalesRowsCloseOutcome,
  completeMercariClose,
} from "../scripts/close_all_shipped_orders.mjs";

const SHOP4_ID = "2JMLHBxjiFHDr55jMwA7fs";

test("Not Applicable close outcomes do not mark canceled orders as shipped", () => {
  const { richPayload } = buildSalesCloseOutcomePatches(
    "2026-07-13T12:00:00.000Z",
    "Not Applicable",
    "CANCELED",
  );

  assert.equal(richPayload.shop_close_status, "Not Applicable");
  assert.equal(richPayload.shipping_completed_at, undefined);
  assert.equal(richPayload.order_status, undefined);
  assert.equal(richPayload.review_status, undefined);
});

test("Completed close outcomes mark sales rows as shipped", () => {
  const { richPayload } = buildSalesCloseOutcomePatches(
    "2026-07-13T12:00:00.000Z",
    "Completed",
    "",
  );

  assert.equal(richPayload.shipping_completed_at, "2026-07-13T12:00:00.000Z");
  assert.equal(richPayload.order_status, "COMPLETED");
  assert.equal(richPayload.review_status, null);
});

test("sales tracking backfill keeps canonical tracking numbers prefix-free", () => {
  const { richPayload, fallbackPayload } = buildSalesTrackingPatches([
    { carrierName: "Yamato", trackingNum: "111" },
    { carrierName: "Sagawa", trackingNum: "222" },
  ], "2026-07-13T12:00:00.000Z");

  assert.equal(richPayload.tracking_carrier, "Yamato / Sagawa");
  assert.equal(richPayload.tracking_number, "111 / 222");
  assert.equal(richPayload.review_status, null);
  assert.equal(richPayload.shipping_tracking_info, "Yamato: 111; Sagawa: 222");
  assert.equal(fallbackPayload.tracking_number, undefined);
  assert.equal(fallbackPayload.review_status, null);
  assert.equal(fallbackPayload.shipping_tracking_info, "Yamato: 111; Sagawa: 222");
});

function shipment(overrides = {}) {
  return {
    id: "ship-1",
    order_id: "order_2JPBN5jziBvXbgUZaaZmoj",
    sales_channel: "mercari",
    source_store_id: SHOP4_ID,
    tracking_carrier: "Yamato",
    tracking_number: "1234567890",
    shipping_completed_at: "2026-07-10T00:00:00Z",
    order_date: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

test("mapCanonicalTracking maps a single canonical package", () => {
  assert.deepEqual(mapCanonicalTracking(" Yamato ", " 1234 "), [
    { carrierName: "Yamato", trackingNum: "1234" },
  ]);
});

test("mapCanonicalTracking rejects a missing tracking number", () => {
  assert.deepEqual(mapCanonicalTracking("Sagawa", ""), []);
  assert.deepEqual(mapCanonicalTracking(null, null), []);
});

test("mapCanonicalTracking preserves aligned multi-package summaries", () => {
  assert.deepEqual(
    mapCanonicalTracking("Yamato / Sagawa / Japan Post", "111 / 222 / 333"),
    [
      { carrierName: "Yamato", trackingNum: "111" },
      { carrierName: "Sagawa", trackingNum: "222" },
      { carrierName: "Japan Post", trackingNum: "333" },
    ],
  );
});

test("mapCanonicalTracking strips only a duplicated matching carrier prefix", () => {
  assert.deepEqual(
    mapCanonicalTracking("ヤマト運輸 / 佐川急便", "ヤマト運輸: 111 / 佐川急便：222"),
    [
      { carrierName: "ヤマト運輸", trackingNum: "111" },
      { carrierName: "佐川急便", trackingNum: "222" },
    ],
  );
  assert.deepEqual(mapCanonicalTracking("Yamato", "Other: 333"), [
    { carrierName: "Yamato", trackingNum: "Other: 333" },
  ]);
});

test("mapCanonicalTracking applies one carrier to multiple packages", () => {
  assert.deepEqual(mapCanonicalTracking("Yamato", "111 / 222"), [
    { carrierName: "Yamato", trackingNum: "111" },
    { carrierName: "Yamato", trackingNum: "222" },
  ]);
});

test("mapCanonicalTracking does not invent a carrier for an unaligned package", () => {
  assert.deepEqual(mapCanonicalTracking("Yamato / Sagawa", "111 / 222 / 333"), [
    { carrierName: "Yamato", trackingNum: "111" },
    { carrierName: "Sagawa", trackingNum: "222" },
    { carrierName: "Unknown", trackingNum: "333" },
  ]);
});

test("buildShipmentTrackingGroups groups and deduplicates Supabase rows", () => {
  const rows = [
    shipment(),
    shipment({
      id: "ship-2",
      tracking_carrier: "Sagawa / Yamato",
      tracking_number: "0987654321 / 1234567890",
    }),
  ];
  const groups = buildShipmentTrackingGroups(rows);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].orderId, "2JPBN5jziBvXbgUZaaZmoj");
  assert.equal(groups[0].shopId, SHOP4_ID);
  assert.deepEqual(groups[0].trackingEntries, [
    { carrierName: "Yamato", trackingNum: "1234567890" },
    { carrierName: "Sagawa", trackingNum: "0987654321" },
  ]);
});

test("buildShipmentTrackingGroups falls back to raw tracking data", () => {
  const rows = [shipment({
    tracking_carrier: "Yamato",
    tracking_number: "",
    giga_tracking_raw: JSON.stringify([{ carrierName: "Sagawa", trackingNum: "999" }]),
  })];

  assert.deepEqual(buildShipmentTrackingGroups(rows)[0].trackingEntries, [
    { carrierName: "Sagawa", trackingNum: "999" },
  ]);
});

test("buildShipmentTrackingGroups rejects non-Mercari and unknown-shop rows", () => {
  assert.deepEqual(buildShipmentTrackingGroups([shipment({ sales_channel: "rakuten" })]), []);
  assert.deepEqual(buildShipmentTrackingGroups([shipment({ source_store_id: "unknown" })]), []);
});

test("buildShipmentCloseCandidates requires valid tracking", () => {
  assert.deepEqual(buildShipmentCloseCandidates([shipment({ tracking_number: "" })]), []);
});

test("excludeTerminalSalesCandidates excludes Completed status without a timestamp", () => {
  const candidates = buildShipmentCloseCandidates([shipment()]);
  const salesRows = [{
    order_id: "2JPBN5jziBvXbgUZaaZmoj",
    source_store_id: SHOP4_ID,
    shop_close_status: "Completed",
    shop_close_completed_at: null,
  }];

  assert.deepEqual(excludeTerminalSalesCandidates(candidates, salesRows), []);
});

test("excludeTerminalSalesCandidates excludes Not Applicable canceled orders", () => {
  const candidates = buildShipmentCloseCandidates([shipment()]);
  const salesRows = [{
    order_id: "order_2JPBN5jziBvXbgUZaaZmoj",
    source_store_id: SHOP4_ID,
    shop_close_status: "Not Applicable",
    shop_close_completed_at: null,
  }];

  assert.deepEqual(excludeTerminalSalesCandidates(candidates, salesRows), []);
});

test("excludeTerminalSalesCandidates retains nonterminal orders", () => {
  const candidates = buildShipmentCloseCandidates([shipment()]);
  const salesRows = [{
    order_id: "2JPBN5jziBvXbgUZaaZmoj",
    source_store_id: SHOP4_ID,
    shop_close_status: "Failed",
    shop_close_completed_at: null,
  }];

  assert.equal(excludeTerminalSalesCandidates(candidates, salesRows).length, 1);
});

test("patchSalesRowsCloseOutcome fails when no sales row matches", async () => {
  await assert.rejects(
    patchSalesRowsCloseOutcome(
      { salesOrderTableId: "sales_orders" },
      [],
      "2JPBN5jziBvXbgUZaaZmoj",
      SHOP4_ID,
      "2026-07-13T00:00:00+09:00",
      "Completed",
      "",
    ),
    /sales_rows_not_found/,
  );
});

test("completeMercariClose requires atomic RPC count and exact readback for every line", async () => {
  const completedAt = "2026-09-07T12:00:00+09:00";
  const rows = [
    { id: "line-1", order_id: "order_O-1", source_store_id: SHOP4_ID, sales_channel: "mercari" },
    { id: "line-2", order_id: "O-1", source_store_id: SHOP4_ID, sales_channel: "mercari" },
  ];
  const readback = rows.map((row) => ({
    ...row, order_status: "COMPLETED", review_status: null,
    shop_close_status: "Completed", shop_close_completed_at: "2026-09-07T03:00:00.000+00:00",
    tracking_carrier: "Yamato", tracking_number: "111",
  }));
  const client = {
    supabase: {
      async rpc(name, args) {
        assert.equal(name, "complete_mercari_order_close");
        assert.equal(args.p_tracking_number, "111");
        return { data: 2, error: null };
      },
      from() {
        const builder = {
          select() { return builder; }, eq() { return builder; }, in() { return builder; },
          then(resolve) { return Promise.resolve({ data: readback, error: null }).then(resolve); },
        };
        return builder;
      },
    },
  };
  const result = await completeMercariClose(client, rows, "O-1", SHOP4_ID, [{ carrierName: "Yamato", trackingNum: "111" }], completedAt);
  assert.equal(result.length, 2);
});

test("Mercari close completion migration owns all-line terminal and tracking persistence", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907154000_add_atomic_mercari_close_completion.sql", import.meta.url), "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /sales_channel = 'mercari'/);
  assert.match(sql, /SET order_status = 'COMPLETED'[\s\S]*tracking_number = p_tracking_number/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.complete_mercari_order_close[\s\S]*FROM PUBLIC, anon, authenticated/);
});

test("Mercari close completion corrective migration uses canonical tracking columns", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260910002000_fix_mercari_close_completion_tracking.sql", import.meta.url), "utf8");
  assert.match(sql, /tracking_carrier = p_tracking_carrier/);
  assert.match(sql, /tracking_number = p_tracking_number/);
  assert.doesNotMatch(sql, /shipping_tracking_info\s*=/);
});
