#!/usr/bin/env node
/**
 * Unit tests for rakuten-ingest.mjs — RMS orderProgress mapping,
 * change-aware writes, and purchase_date backfill.
 *
 * Usage:
 *   node test/rakuten-ingest.test.mjs
 */

import { strict as assert } from "node:assert";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

function eq(actual, expected, label) {
  assert.strictEqual(actual, expected, label || `expected ${expected}, got ${actual}`);
}

function ok(value, label) {
  assert.ok(value, label || `expected truthy, got ${value}`);
}

// Baserow single-select object shape
function selectObj(value) {
  return value ? { id: 999, value, color: "blue" } : null;
}

async function main() {

// ============================================================================
// 1. mapRmsOrderProgressToStatus — pure function tests
// ============================================================================

console.log("\n── 1. mapRmsOrderProgressToStatus ──");

const { mapRmsOrderProgressToStatus, normalizeRmsOrderProgress } = await import("../src/lib/rakuten-ingest.mjs");

await test("ORDER_ACCEPTED → PENDING_CONFIRMATION", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_ACCEPTED"), "PENDING_CONFIRMATION");
});

await test("ORDER_IN_PROGRESS → PENDING_CONFIRMATION", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_IN_PROGRESS"), "PENDING_CONFIRMATION");
});

await test("ORDER_START → PENDING_CONFIRMATION", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_START"), "PENDING_CONFIRMATION");
});

await test("ORDER_COMPLETED → COMPLETED", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_COMPLETED"), "COMPLETED");
});

await test("ORDER_SHIPPED → COMPLETED", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_SHIPPED"), "COMPLETED");
});

await test("ORDER_CANCELED → CANCELED", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_CANCELED"), "CANCELED");
});

await test("Unknown progress → null", () => {
  eq(mapRmsOrderProgressToStatus("ORDER_UNKNOWN"), null);
});

await test("null → null", () => {
  eq(mapRmsOrderProgressToStatus(null), null);
});

await test("undefined → null", () => {
  eq(mapRmsOrderProgressToStatus(undefined), null);
});

await test("numeric 300 発送待ち → RMS_CONFIRMED", () => {
  eq(mapRmsOrderProgressToStatus(300), "RMS_CONFIRMED");
});

await test("numeric 400 変更確定待ち is non-terminal", () => {
  eq(mapRmsOrderProgressToStatus(400), "PENDING_CONFIRMATION");
});

await test("numeric 500 発送済 → COMPLETED", () => {
  eq(mapRmsOrderProgressToStatus(500), "COMPLETED");
});

await test("numeric 700 payment complete → CONFIRMED but not shipment-ready", () => {
  const result = normalizeRmsOrderProgress(700);
  eq(result.status, "CONFIRMED");
  eq(result.mappingState, "MAPPED");
  eq(result.shipmentReady, false);
});

await test("unknown and missing progress are distinguished", () => {
  eq(normalizeRmsOrderProgress(999).mappingState, "UNKNOWN");
  eq(normalizeRmsOrderProgress(null).mappingState, "MISSING");
});

// ============================================================================
// 2. Integration: change-aware writes on ingest
// ============================================================================

console.log("\n── 2. Change-aware writes ──");

const { ingestRakutenOrders } = await import("../src/lib/rakuten-ingest.mjs");

function makeEnv() {
  return {
    DATABASE_BACKEND: "baserow",
    BASEROW_API_BASE: "http://localhost:9999/api",
    BASEROW_DATABASE_TOKEN: "test-token",
    RAKUTEN_SALES_ORDER_TABLE_ID: "12345",
  };
}

// Helper: build a minimal RMS order sample
function sampleOrder(overrides = {}) {
  return {
    orderNumber: "order_1001",
    orderDatetime: "2026-07-19T10:00:00+09:00",
    orderProgress: "ORDER_COMPLETED",
    PackageModelList: [
      {
        ItemModelList: [
          { itemName: "Test Item", manageNumber: "MN-001", price: 1500, units: 2 },
        ],
        SenderModel: {
          familyName: "Taro", firstName: "Yamada",
          zipCode1: "100", zipCode2: "0001",
          prefecture: "Tokyo", city: "Chiyoda", subAddress: "1-1-1",
          phoneNumber1: "03", phoneNumber2: "1234", phoneNumber3: "5678",
        },
      },
    ],
    ...overrides,
  };
}

await test("Rakuten purchase amount and payment method are mapped from order totals", async () => {
  const { buildRakutenSalesPayload } = await import("../src/lib/rakuten-ingest.mjs");
  const payload = buildRakutenSalesPayload(sampleOrder({
    orderNumber: "440058-20260825-0379300277",
    totalPrice: 15750,
    couponAllTotalPrice: 945,
    SettlementModel: { settlementMethod: "クレジットカード" },
    PackageModelList: [{
      ItemModelList: [
        { itemName: "Test Item", manageNumber: "MN-001", price: 15750, units: 1 },
      ],
      SenderModel: {},
    }],
  }));

  eq(payload.product_price, 14805, "product_price uses 購買額 after coupon");
  eq(payload.payment_method, "クレジットカード", "payment method is persisted");
});

await test("Rakuten product price falls back to item price when totalPrice is absent", async () => {
  const { buildRakutenSalesPayload } = await import("../src/lib/rakuten-ingest.mjs");
  const payload = buildRakutenSalesPayload(sampleOrder());
  eq(payload.product_price, 1500, "legacy/partial payload fallback retained");
  eq(payload.payment_method, "", "missing settlement method stays empty");
});

await test("Rakuten getOrder v7 merchantDefinedSkuId is persisted directly", async () => {
  const { buildRakutenSalesPayload } = await import("../src/lib/rakuten-ingest.mjs");
  const order = sampleOrder();
  order.PackageModelList[0].ItemModelList[0] = {
    itemName: "Title says White",
    manageNumber: "cabnt-n515p416432",
    price: 15750,
    units: 1,
    SkuModelList: [{
      variantId: "n515p416432b",
      merchantDefinedSkuId: "n515p416432b",
      skuInfo: "カラー:ブラック",
    }],
  };
  const payload = buildRakutenSalesPayload(order);
  eq(payload.b2b_item_code, "n515p416432b");
});

await test("new order uses mapped status from orderProgress", async () => {
  const captured = [];
  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({ orderNumber: "order_2001", orderProgress: "ORDER_COMPLETED" }),
  ], {
    resolveItemCode: async () => ({ resolved: false, code: "", reason: "test" }),
    _inject: {
      listAllRows: async () => [],
      createRow: async (_client, _tableId, payload) => {
        captured.push(payload);
        return { ok: true, body: { id: 1 } };
      },
      patchRow: async () => { throw new Error("should not patch"); },
    },
  });

  eq(result.created, 1, "one order created");
  eq(captured.length, 1, "createRow called once");
  eq(captured[0].order_status, "COMPLETED", "status mapped from ORDER_COMPLETED");
});

await test("new order falls back to PENDING_CONFIRMATION when progress is null", async () => {
  const captured = [];
  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({ orderNumber: "order_2002", orderProgress: null }),
  ], {
    resolveItemCode: async () => ({ resolved: false, code: "", reason: "test" }),
    _inject: {
      listAllRows: async () => [],
      createRow: async (_client, _tableId, payload) => {
        captured.push(payload);
        return { ok: true, body: { id: 2 } };
      },
      patchRow: async () => { throw new Error("should not patch"); },
    },
  });

  eq(result.created, 1, "one order created");
  eq(captured[0].order_status, "PENDING_CONFIRMATION", "falls back to PENDING_CONFIRMATION");
});

await test("new order falls back when progress is unknown", async () => {
  const captured = [];
  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({ orderNumber: "order_2003", orderProgress: "ORDER_UNKNOWN" }),
  ], {
    resolveItemCode: async () => ({ resolved: false, code: "", reason: "test" }),
    _inject: {
      listAllRows: async () => [],
      createRow: async (_client, _tableId, payload) => {
        captured.push(payload);
        return { ok: true, body: { id: 3 } };
      },
      patchRow: async () => { throw new Error("should not patch"); },
    },
  });

  eq(result.created, 1, "one order created");
  eq(captured[0].order_status, "PENDING_CONFIRMATION", "falls back to PENDING_CONFIRMATION for unknown progress");
});

await test("existing row with unchanged status → no order_status in patch payload", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 42,
      order_id: "1001",
      purchase_date: "2026-07-19",
      product_name: "Old Name",
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"), // matches mapped value
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_1001",
      orderProgress: "ORDER_ACCEPTED", // maps to PENDING_CONFIRMATION — same as stored
      PackageModelList: [
        {
          ItemModelList: [
            { itemName: "Updated Name", manageNumber: "MN-001", price: 1500, units: 2 },
          ],
          SenderModel: {
            familyName: "Taro", firstName: "Yamada",
            zipCode1: "100", zipCode2: "0001",
            prefecture: "Tokyo", city: "Chiyoda", subAddress: "1-1-1",
            phoneNumber1: "03", phoneNumber2: "1234", phoneNumber3: "5678",
          },
        },
      ],
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated (product name changed)");
  eq(patchPayloads.length, 1, "patchRow called once");
  eq(patchPayloads[0].order_status, undefined, "order_status omitted when unchanged");
  eq(patchPayloads[0].product_name, "Updated Name", "other field changes still applied");
});

await test("existing row with changed status → order_status in patch payload", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 43,
      order_id: "1004",
      purchase_date: "2026-07-19",
      product_name: "Same Item",
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"), // different from mapped
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_1004",
      orderProgress: "ORDER_COMPLETED", // maps to COMPLETED — different from stored
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated (status changed)");
  eq(patchPayloads.length, 1, "patchRow called once");
  eq(patchPayloads[0].order_status, "COMPLETED", "order_status included when changed");
});

await test("existing row with unchanged status and all other fields same → unchanged", async () => {
  const patchCalls = [];
  const existingRows = [
    {
      id: 44,
      order_id: "1005",
      purchase_date: "2026-07-19",
      product_name: "Test Item",
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"),
      rakuten_order_progress: "ORDER_ACCEPTED",
      rakuten_status_mapping_state: "MAPPED",
      rakuten_order_progress_observed_at: "2026-07-19T01:00:00.000Z",
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_1005",
      orderProgress: "ORDER_ACCEPTED", // maps to same status as stored
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchCalls.push(payload);
        return { ok: true };
      },
    },
  });

  if (result.unchanged !== 1) {
    console.log("DEBUG: result =", JSON.stringify(result, null, 2));
  }
  eq(result.unchanged, 1, "order unchanged");
  eq(patchCalls.length, 0, "patchRow NOT called when nothing changed");
});

await test("existing row with null purchase_date gets backfilled", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 45,
      order_id: "1006",
      purchase_date: null,
      product_name: "Backfill Item",
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"),
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_1006",
      orderProgress: "ORDER_ACCEPTED", // same status
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated (purchase_date backfilled)");
  eq(patchPayloads.length, 1, "patchRow called once");
  eq(patchPayloads[0].purchase_date, "2026-07-19", "purchase_date backfilled from orderDatetime");
});

// ============================================================================
// 5. Transition-aware guard — ingest must not regress operator confirmation
// ============================================================================

console.log("\n── 5. Transition-aware guard ──");

const { RAKUTEN_ORDER_STATUS } = await import("../src/lib/order-state.mjs");

await test("CONFIRMED order NOT downgraded to PENDING_CONFIRMATION by RMS ORDER_ACCEPTED", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 5001,
      order_id: "5001",
      purchase_date: "2026-07-19",
      product_name: "Confirmed Item",
      manage_number: "MN-CONFIRMED",
      quantity: 1,
      product_price: 2000,
      shipping_name: "Test",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "CODE-1",
      order_status: selectObj(RAKUTEN_ORDER_STATUS.CONFIRMED),
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_5001",
      orderProgress: "ORDER_ACCEPTED", // RMS still says pre-confirmation
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated (other fields may differ)");
  eq(patchPayloads.length, 1, "patchRow called");
  eq(patchPayloads[0].order_status, undefined,
    "order_status NOT in patch — CONFIRMED preserved (no regressive downgrade)");
});

await test("RMS_CONFIRMED order NOT downgraded by RMS numeric 300", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 5004,
      order_id: "5004",
      purchase_date: "2026-07-19",
      product_name: "RMS Confirmed Item",
      manage_number: "MN-RMS-CONFIRMED",
      quantity: 1,
      product_price: 2000,
      shipping_name: "Test",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "CODE-4",
      order_status: selectObj(RAKUTEN_ORDER_STATUS.RMS_CONFIRMED),
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_5004",
      orderProgress: 300,
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated (other fields may differ)");
  eq(patchPayloads.length, 1, "patchRow called");
  eq(patchPayloads[0].order_status, undefined,
    "order_status NOT in patch — RMS_CONFIRMED preserved");
});

await test("COMPLETED from RMS overwrites CONFIRMED (terminal state wins)", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 5002,
      order_id: "5002",
      purchase_date: "2026-07-19",
      product_name: "Confirmed Item",
      manage_number: "MN-CONFIRMED-2",
      quantity: 1,
      product_price: 2000,
      shipping_name: "Test",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "CODE-2",
      order_status: selectObj(RAKUTEN_ORDER_STATUS.CONFIRMED),
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_5002",
      orderProgress: "ORDER_COMPLETED", // RMS says completed — must win
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated — terminal RMS state wins");
  eq(patchPayloads.length, 1, "patchRow called");
  ok(patchPayloads[0].order_status !== undefined,
    "order_status present in patch payload");
});

await test("CANCELED from RMS overwrites CONFIRMED (terminal state wins)", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 5003,
      order_id: "5003",
      purchase_date: "2026-07-19",
      product_name: "Cancelled Item",
      manage_number: "MN-CANCEL-1",
      quantity: 1,
      product_price: 2000,
      shipping_name: "Test",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "CODE-3",
      order_status: selectObj(RAKUTEN_ORDER_STATUS.CONFIRMED),
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_5003",
      orderProgress: "ORDER_CANCELED", // RMS says cancelled — must win
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(result.updated, 1, "order updated — terminal CANCELED wins");
  eq(patchPayloads.length, 1, "patchRow called");
  eq(patchPayloads[0].order_status, RAKUTEN_ORDER_STATUS.CANCELED,
    "status set to CANCELED");
});

// ============================================================================
// 6. Delivery preferences — real RMS OrderModel extraction
// ============================================================================

console.log("\n── 6. Delivery preferences ──");

const { buildRakutenSalesPayload } = await import("../src/lib/rakuten-ingest.mjs");

await test("delivery prefs and remarks extracted from RMS OrderModel", () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-08",
    shippingTerm: 1,
    remarks: "[配送日時指定:]\n2026-08-08(土)\n午前中",
  });
  const payload = buildRakutenSalesPayload(order);
  eq(payload.requested_delivery_date, "2026-08-08", "requested_delivery_date set");
  eq(payload.requested_delivery_time, "08:00-12:00", "午前 mapped to 08:00-12:00");
  ok(payload.order_comments.includes("[ingest] RMSお客様備考:"), "managed remarks block present");
  ok(payload.order_comments.includes("午前中"), "customer remarks preserved");
  ok(!payload.order_comments.includes("配送方法"), "delivery method is intentionally ignored");
});

await test("delivery note appended to order_comments on create", async () => {
  const captured = [];
  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_6001",
      deliveryDate: "2026-08-10",
      shippingTerm: 1618,
      remarks: "新築のベージュとブラウンの家です",
    }),
  ], {
    resolveItemCode: async () => ({ resolved: false, code: "", reason: "test" }),
    _inject: {
      listAllRows: async () => [],
      createRow: async (_client, _tableId, payload) => {
        captured.push(payload);
        return { ok: true, body: { id: 10 } };
      },
      patchRow: async () => { throw new Error("should not patch"); },
    },
  });

  eq(result.created, 1, "order created");
  eq(captured.length, 1, "createRow called");
  ok(captured[0].order_comments.includes("[ingest] RMSお客様備考:"), "remarks block present");
  ok(captured[0].order_comments.includes("新築のベージュとブラウンの家です"), "remarks preserved");
  eq(captured[0].requested_delivery_date, "2026-08-10", "requested_delivery_date set");
  eq(captured[0].requested_delivery_time, "16:00-18:00", "16時～18時 mapped to 16:00-18:00");
});

await test("RMS remarks backfill preserves operator memos", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 601,
      order_id: "6002",
      purchase_date: "2026-07-19",
      product_name: "Test Item",
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"),
      // Delivery fields NOT set — incoming RMS data will differ, triggering update
      order_comments: "OPERATOR MEMO: customer called",
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_6002",
      orderProgress: "ORDER_ACCEPTED",
      deliveryDate: "2026-08-09",
      shippingTerm: 1,
      remarks: "置き配不可",
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(patchPayloads.length, 1, "patchRow called");
  ok(patchPayloads[0].order_comments.includes("OPERATOR MEMO: customer called"), "operator memo preserved");
  ok(patchPayloads[0].order_comments.includes("置き配不可"), "RMS remarks backfilled");
});

await test("delivery prefs omitted when OrderModel fields are missing", () => {
  const order = sampleOrder();
  const payload = buildRakutenSalesPayload(order);
  eq(payload.requested_delivery_date, "", "requested_delivery_date empty");
  eq(payload.requested_delivery_time, "", "requested_delivery_time empty");
  eq(payload.order_comments, "", "order_comments empty");
});

await test("delivery prefs with date only (no time zone)", () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-09",
  });
  const payload = buildRakutenSalesPayload(order);
  eq(payload.requested_delivery_date, "2026-08-09", "date set");
  eq(payload.requested_delivery_time, "", "time empty when no time zone");
  eq(payload.order_comments, "", "date is structured and is not duplicated into comments");
});

await test("shippingTerm mapping — all supported values", () => {
  const knownMappings = {
    "1": "08:00-12:00",
    "1416": "14:00-16:00",
    "1618": "16:00-18:00",
    "1820": "18:00-20:00",
    "1921": "19:00-21:00",
  };
  for (const [rms, giga] of Object.entries(knownMappings)) {
    const order = sampleOrder({
      deliveryDate: "2026-08-08", shippingTerm: rms,
    });
    const payload = buildRakutenSalesPayload(order);
    eq(payload.requested_delivery_time, giga, rms + " → " + giga);
  }
});

await test("unverified 812 and 0812 morning edge cases are not guessed", () => {
  for (const shippingTerm of [812, "0812"]) {
    const payload = buildRakutenSalesPayload(sampleOrder({ shippingTerm }));
    eq(payload.requested_delivery_time, "", `${shippingTerm} remains unmapped until verified`);
    ok(payload.order_comments.includes(String(shippingTerm)), `${shippingTerm} gets an operator warning`);
  }
});

await test("shippingTerm mapping — unknown returns empty", () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-08", shippingTerm: 9999,
  });
  const payload = buildRakutenSalesPayload(order);
  eq(payload.requested_delivery_time, "", "unknown code not mapped");
  ok(payload.order_comments.includes("9999"), "unknown code shown in operator warning");
});

await test("shippingTerm mapping — empty returns empty without warning", () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-08", shippingTerm: null,
  });
  const payload = buildRakutenSalesPayload(order);
  eq(payload.requested_delivery_time, "", "empty term returns empty");
  ok(!payload.order_comments.includes("未対応"), "no warning for no preference");
});

await test("time zone mapping — lossy slots return empty (no GigaB2B match)", () => {
  const lossySlots = [1214, 2021];
  for (const rms of lossySlots) {
    const order = sampleOrder({
      deliveryDate: "2026-08-08", shippingTerm: rms,
    });
    const payload = buildRakutenSalesPayload(order);
    eq(payload.requested_delivery_time, "", rms + " returns empty (no matching Portal/Giga slot)");
  }
});

await test("delivery note — unmappable slot gets operator warning", () => {
  const lossySlots = [1214, 2021];
  for (const rms of lossySlots) {
    const order = sampleOrder({
      deliveryDate: "2026-08-08", shippingTerm: rms, remarks: "配送希望あり",
    });
    const payload = buildRakutenSalesPayload(order);
    ok(payload.order_comments.includes("[ingest] RMSお客様備考:"), "remarks present for " + rms);
    ok(payload.order_comments.includes("未対応"),
      "warning present for unmappable slot " + rms);
    ok(payload.order_comments.includes("手動設定してください"),
      "operator action call-to-action for " + rms);
    ok(payload.order_comments.includes(String(rms)),
      "raw RMS shipping term preserved in warning for " + rms);
  }
});

await test("delivery warning is idempotently replaced when code becomes supported", async () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-08", shippingTerm: 9999, remarks: "玄関前不可",
  });
  const first = buildRakutenSalesPayload(order);
  const { mergeRmsOrderComments, mapRmsShippingTerm } = await import("../src/lib/rakuten-order-fields.mjs");
  const merged = mergeRmsOrderComments(first.order_comments, "玄関前不可", mapRmsShippingTerm(1416));
  ok(!merged.includes("9999"), "stale warning removed");
  eq((merged.match(/RMSお客様備考:/g) || []).length, 1, "remarks block not duplicated");
});

await test("changed RMS remarks replace only the managed block", async () => {
  const { mergeRmsOrderComments, mapRmsShippingTerm, extractRmsCustomerRemarks } = await import("../src/lib/rakuten-order-fields.mjs");
  const initial = mergeRmsOrderComments(
    "[2026-08-07] PORTAL_OPERATOR: confirmed",
    "旧備考",
    mapRmsShippingTerm(1416),
  );
  const changed = mergeRmsOrderComments(initial, "新しい備考\n住所補足", mapRmsShippingTerm(1416));
  ok(changed.includes("PORTAL_OPERATOR: confirmed"), "operator audit preserved");
  ok(!changed.includes("旧備考"), "old RMS remarks removed");
  eq(extractRmsCustomerRemarks(changed), "新しい備考\n住所補足", "new multiline remarks extracted");
  eq((changed.match(/RMSお客様備考:/g) || []).length, 1, "one managed block remains");
});

await test("empty upstream remarks retain the last managed block", async () => {
  const { mergeRmsOrderComments, mapRmsShippingTerm, extractRmsCustomerRemarks } = await import("../src/lib/rakuten-order-fields.mjs");
  const initial = mergeRmsOrderComments("OPERATOR MEMO", "配送先補足", mapRmsShippingTerm(1));
  const merged = mergeRmsOrderComments(initial, "", mapRmsShippingTerm(1));
  eq(extractRmsCustomerRemarks(merged), "配送先補足", "transient empty response does not delete captured remarks");
  ok(merged.includes("OPERATOR MEMO"), "operator memo retained");
});

await test("delivery note — known mapping does NOT get warning", () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-08", shippingTerm: 1, remarks: "午前中希望",
  });
  const payload = buildRakutenSalesPayload(order);
  ok(!payload.order_comments.includes("未対応"), "no warning for known mapping");
  ok(payload.order_comments.includes("午前中希望"), "raw customer remarks retained");
});

await test("DeliveryModel deliveryName is intentionally ignored", () => {
  const order = sampleOrder({
    DeliveryModel: { deliveryName: "宅配便" },
  });
  const payload = buildRakutenSalesPayload(order);
  eq(payload.order_comments, "", "shipping method has no operational mapping");
});

await test("delivery note — date only (no extra paren)", () => {
  const order = sampleOrder({
    deliveryDate: "2026-08-09",
  });
  const payload = buildRakutenSalesPayload(order);
  eq(payload.order_comments, "", "structured date does not create a memo");
});

await test("existing operator delivery fields preserved on update", async () => {
  const patchPayloads = [];
  const existingRows = [
    {
      id: 660,
      order_id: "6060",
      purchase_date: "2026-07-19",
      product_name: "Different Name",  // differ from RMS to trigger update
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"),
      requested_delivery_date: "2026-08-15",   // operator set
      requested_delivery_time: "14:00-16:00",   // operator set
      order_comments: "OPERATOR MEMO",
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_6060",
      orderProgress: "ORDER_ACCEPTED",
      // Empty RMS fields must not overwrite operator-managed delivery prefs.
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async (_client, _tableId, _rowId, payload) => {
        patchPayloads.push(payload);
        return { ok: true };
      },
    },
  });

  eq(patchPayloads.length, 1, "patchRow called");
  eq(patchPayloads[0].requested_delivery_date, "2026-08-15",
    "operator delivery date preserved on update");
  eq(patchPayloads[0].requested_delivery_time, "14:00-16:00",
    "operator delivery time preserved on update");
  eq(patchPayloads[0].order_comments, "OPERATOR MEMO",
    "operator comments preserved on update");
});

await test("unchanged detection includes delivery fields", async () => {
  const existingRows = [
    {
      id: 650,
      order_id: "6050",
      purchase_date: "2026-07-19",
      product_name: "Test Item",
      manage_number: "MN-001",
      quantity: 2,
      product_price: 1500,
      shipping_name: "TaroYamada",
      shipping_postal_code: "100-0001",
      shipping_state: "Tokyo",
      shipping_city: "Chiyoda",
      shipping_address_1: "1-1-1",
      shipping_address_2: "",
      shipping_phone_number: "03-1234-5678",
      b2b_item_code: "EXISTING-CODE",
      order_status: selectObj("PENDING_CONFIRMATION"),
      requested_delivery_date: "2026-08-08",
      requested_delivery_time: "08:00-12:00",
      rakuten_order_progress: "ORDER_ACCEPTED",
      rakuten_status_mapping_state: "MAPPED",
      rakuten_order_progress_observed_at: "2026-07-19T01:00:00.000Z",
    },
  ];

  const result = await ingestRakutenOrders(makeEnv(), [
    sampleOrder({
      orderNumber: "order_6050",
      orderProgress: "ORDER_ACCEPTED",
      deliveryDate: "2026-08-08", shippingTerm: 1,
    }),
  ], {
    _inject: {
      listAllRows: async () => existingRows,
      createRow: async () => { throw new Error("should not create"); },
      patchRow: async () => { throw new Error("should not patch — rows are equivalent"); },
    },
  });

  eq(result.unchanged, 1, "unchanged when delivery fields match");
});

// ============================================================================
// 7. Projector delivery propagation (regression) — Phase B
// ============================================================================

console.log("\n── 7. Projector delivery propagation ──");

const { buildRakutenShipmentPayload } = await import("../src/lib/rakuten-projector.mjs");

await test("projector propagates delivery prefs to shipment row", () => {
  const payload = buildRakutenShipmentPayload({
    id: 1,
    order_id: "440058-test",
    purchase_date: "2026-08-02",
    product_name: "Test",
    manage_number: "MN-001",
    b2b_item_code: "B2B-001",
    quantity: 1,
    product_price: 1000,
    shipping_name: "Test User",
    shipping_postal_code: "100-0001",
    shipping_state: "Tokyo",
    shipping_city: "Chiyoda",
    shipping_address_1: "1-1-1",
    shipping_address_2: "",
    shipping_phone_number: "03-1234-5678",
    order_status: "RMS_CONFIRMED",
    requested_delivery_date: "2026-08-08",
    requested_delivery_time: "08:00-12:00",
    order_comments: "[2026-08-07] PORTAL_OPERATOR: confirmed\n\n[ingest] RMSお客様備考:\n15時50分までにお願いします\n[ingest] RMSお客様備考ここまで",
  });
  eq(payload.RequestedDeliveryDate, "2026-08-08T08:00-12:00",
    "delivery date+time combined as dateTtime for GigaB2B");
  eq(payload.OrderComments, "15時50分までにお願いします",
    "only RMS customer remarks propagate to Giga projection");
});

await test("projector leaves RequestedDeliveryDate empty when no delivery prefs", () => {
  const payload = buildRakutenShipmentPayload({
    id: 2,
    order_id: "440058-test2",
    purchase_date: "2026-08-02",
    product_name: "Test",
    manage_number: "MN-002",
    b2b_item_code: "B2B-002",
    quantity: 1,
    product_price: 1000,
    shipping_name: "Test User",
    shipping_postal_code: "100-0001",
    shipping_state: "Tokyo",
    shipping_city: "Chiyoda",
    shipping_address_1: "1-1-1",
    shipping_address_2: "",
    shipping_phone_number: "03-1234-5678",
    order_status: "RMS_CONFIRMED",
    // No delivery fields
  });
  eq(payload.RequestedDeliveryDate, "",
    "empty when no delivery prefs set");
});

await test("outbound payload sends projected remarks and delivery slot to Giga", async () => {
  const { buildDryRunPayload } = await import("../src/lib/outbound-sync.mjs");
  const result = buildDryRunPayload({
    orderId: "440058-test3",
    rows: [{
      id: "projection-1",
      SalesChannel: "Rakuten",
      ShipFrom: "HomesBliss Rakuten",
      SourceStoreID: "Rakuten",
      OrderId: "440058-test3",
      LineItemNumber: "1",
      B2BItemCode: "B2B-003",
      ShipToQty: 1,
      ShipToName: "Test User",
      ShipToPhone: "03-1234-5678",
      ShipToPostalCode: "100-0001",
      ShipToAddressDetail: "1-1-1",
      ShipToCity: "Chiyoda",
      ShipToState: "Tokyo",
      ShipToCountry: "JP",
      OrderDate: "2026-08-02",
      RequestedDeliveryDate: "2026-08-12T14:00-16:00",
      BuyerSkuDescription: "Test",
      BuyerSkuCommercialValue: 1000,
      OrderComments: "15時50分までにお願いします\n新築の家です",
    }],
  }, "Rakuten", "Rakuten");
  eq(result.payload.shippedDate, "2026-08-12T14:00-16:00", "delivery slot sent as shippedDate");
  eq(result.payload.customerComments, "15時50分までにお願いします\n新築の家です", "remarks sent as customerComments");
  eq(result.validationErrors.length, 0, "outbound payload remains valid");
});

// ============================================================================
// Summary
// ============================================================================

const total = passed + failed;
console.log(`\n── Summary ──\n${passed}/${total} passed`);
if (failed > 0) process.exit(1);

}

await main();
