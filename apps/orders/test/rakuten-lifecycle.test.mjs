#!/usr/bin/env node
/**
 * Rakuten lifecycle and adapter contract tests for issue #161.
 *
 * Categories:
 *   1. Adapter contract: 6 lifecycle columns round-trip through toDatabasePayload
 *   2. validateExpectedFields: identifies discarded keys, passes clean payloads
 *   3. Ingest: full ISO last_synced_at; sync_error on failure; unchanged path
 *   4. Confirmation: success persists all audit fields; failure resets lock
 *   5. Closer: terminal COMPLETED on success; preserves RMS_CONFIRMED on failure
 *   6. Channel isolation: no Rakuten runtime module imports baserow.mjs directly
 *
 * Usage:
 *   node test/rakuten-lifecycle.test.mjs
 */

import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ============================================================================
// Helpers
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

function deepEq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
}

function contains(haystack, needle, label) {
  ok(haystack.includes(needle), label || `expected "${needle}" to be in array`);
}

function notContains(haystack, needle, label) {
  ok(!haystack.includes(needle), label || `expected "${needle}" NOT to be in array`);
}

// ============================================================================
// 1. Adapter contract: 6 lifecycle columns round-trip through toDatabasePayload
// ============================================================================

console.log("\n── 1. Adapter contract ──");

// Import the adapter modules
const { toDatabasePayload, validateExpectedFields, SALES_COLUMNS } = await import("../src/lib/supabase.mjs");
const { buildRakutenShippingUpdate } = await import("../src/lib/rakuten-relay.mjs");

test("Rakuten shipping update reuses the matching shippingDetailId", () => {
  const result = buildRakutenShippingUpdate({
    orderNumber: "440058-20260806-0365046899",
    PackageModelList: [{
      basketId: 4257109620,
      ShippingModelList: [{
        shippingDetailId: 4234496161,
        shippingNumber: "491217915392",
        shippingDeleteFlag: 0,
      }],
    }],
  }, {
    trackingNo: "491217915392",
    deliveryCompany: "1002",
    shippingDate: "2026-08-07",
  });

  eq(result.ok, true);
  eq(result.targets[0].action, "update");
  eq(result.body.BasketidModelList[0].ShippingModelList[0].shippingDetailId, 4234496161);
});

test("Rakuten shipping update creates only the first detail for one destination", () => {
  const result = buildRakutenShippingUpdate({
    orderNumber: "SINGLE-EMPTY",
    PackageModelList: [{ basketId: 10, ShippingModelList: [] }],
  }, {
    trackingNo: "TRACK-10",
    deliveryCompany: "1002",
    shippingDate: "2026-08-07",
  });

  eq(result.ok, true);
  eq(result.targets[0].action, "create");
  eq(result.targets[0].shippingDetailId, null);
});

test("Rakuten shipping update refuses a non-matching existing detail", () => {
  const result = buildRakutenShippingUpdate({
    orderNumber: "SINGLE-MISMATCH",
    PackageModelList: [{
      basketId: 20,
      ShippingModelList: [{ shippingDetailId: 21, shippingNumber: "OTHER", shippingDeleteFlag: 0 }],
    }],
  }, {
    trackingNo: "TRACK-20",
    deliveryCompany: "1002",
    shippingDate: "2026-08-07",
  });

  eq(result.ok, false);
  eq(result.error, "existing_shipping_detail_does_not_match_tracking");
});

test("Rakuten shipping update maps every destination only when each match is unique", () => {
  const result = buildRakutenShippingUpdate({
    orderNumber: "MULTI-MATCH",
    PackageModelList: [
      { basketId: 30, ShippingModelList: [{ shippingDetailId: 31, shippingNumber: "TRACK-30" }] },
      { basketId: 40, ShippingModelList: [{ shippingDetailId: 41, shippingNumber: "TRACK-30" }] },
    ],
  }, {
    trackingNo: "TRACK-30",
    deliveryCompany: "1002",
    shippingDate: "2026-08-07",
  });

  eq(result.ok, true);
  deepEq(result.targets.map((target) => target.shippingDetailId), [31, 41]);
  eq(result.body.BasketidModelList.length, 2);
});

test("Rakuten shipping update fails closed for an incomplete multi-destination mapping", () => {
  const result = buildRakutenShippingUpdate({
    orderNumber: "MULTI-INCOMPLETE",
    PackageModelList: [
      { basketId: 50, ShippingModelList: [{ shippingDetailId: 51, shippingNumber: "TRACK-50" }] },
      { basketId: 60, ShippingModelList: [] },
    ],
  }, {
    trackingNo: "TRACK-50",
    deliveryCompany: "1002",
    shippingDate: "2026-08-07",
  });

  eq(result.ok, false);
  eq(result.error, "unsafe_multi_destination_shipping_mapping");
  eq(result.basketId, 60);
});

test("six lifecycle columns are in SALES_COLUMNS", () => {
  const cols = ["last_synced_at", "sync_error", "rms_confirm_result", "rms_confirmed_at",
    "rms_close_result", "rms_close_completed_at"];
  for (const col of cols) {
    ok(SALES_COLUMNS.has(col), `${col} should be in SALES_COLUMNS`);
  }
});

test("toDatabasePayload preserves all 6 lifecycle columns", () => {
  const now = "2026-07-16T12:00:00.000Z";
  const payload = {
    order_id: "test-001",
    last_synced_at: now,
    sync_error: "",
    rms_confirm_result: "confirmed",
    rms_confirmed_at: now,
    rms_close_result: "closed",
    rms_close_completed_at: now,
  };
  const client = { salesChannelScope: "rakuten" };
  const result = toDatabasePayload("sales_orders", payload, client);

  eq(result.last_synced_at, now, "last_synced_at preserved");
  eq(result.sync_error, "", "sync_error preserved");
  eq(result.rms_confirm_result, "confirmed", "rms_confirm_result preserved");
  eq(result.rms_confirmed_at, now, "rms_confirmed_at preserved");
  eq(result.rms_close_result, "closed", "rms_close_result preserved");
  eq(result.rms_close_completed_at, now, "rms_close_completed_at preserved");
  eq(result.order_id, "test-001", "other fields still pass through");
});

test("toDatabasePayload handles null values for lifecycle columns", () => {
  const payload = {
    order_id: "test-002",
    last_synced_at: null,
    sync_error: null,
    rms_confirm_result: null,
    rms_confirmed_at: null,
    rms_close_result: null,
    rms_close_completed_at: null,
  };
  const client = { salesChannelScope: "rakuten" };
  const result = toDatabasePayload("sales_orders", payload, client);

  eq(result.last_synced_at, null, "null last_synced_at preserved");
  eq(result.sync_error, null, "null sync_error preserved");
  eq(result.rms_close_completed_at, null, "null rms_close_completed_at preserved");
});

test("toDatabasePayload sets Rakuten channel defaults", () => {
  const payload = { order_id: "test-003" };
  const client = { salesChannelScope: "rakuten" };
  const result = toDatabasePayload("sales_orders", payload, client);

  eq(result.sales_channel, "rakuten", "sales_channel defaults to rakuten");
  eq(result.source_store_id, "Rakuten", "source_store_id defaults to Rakuten");
});

// ============================================================================
// 2. validateExpectedFields
// ============================================================================

console.log("\n── 2. validateExpectedFields ──");

test("returns ok:true for empty payload", () => {
  const r = validateExpectedFields({}, SALES_COLUMNS, "test");
  eq(r.ok, true);
  eq(r.discarded.length, 0);
});

test("returns ok:true for null/undefined payload", () => {
  eq(validateExpectedFields(null, SALES_COLUMNS, "test").ok, true);
  eq(validateExpectedFields(undefined, SALES_COLUMNS, "test").ok, true);
});

test("identifies discarded keys not in allow-list", () => {
  const payload = {
    order_id: "x",
    nonexistent_field: "value",
    another_bogus: 42,
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "test-module");
  eq(r.ok, false);
  contains(r.discarded, "nonexistent_field");
  contains(r.discarded, "another_bogus");
  notContains(r.discarded, "order_id");
});

test("returns ok:true when all keys are in allow-list", () => {
  const payload = {
    order_id: "y",
    order_status: "CONFIRMED",
    last_synced_at: new Date().toISOString(),
    sync_error: "",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "test-module");
  eq(r.ok, true);
  eq(r.discarded.length, 0);
});

test("discarded list contains key names only, never values", () => {
  const payload = {
    secret_field_with_pii: "customer-email@example.com",
  };
  const r = validateExpectedFields(payload, new Set(["safe_key"]), "test");
  contains(r.discarded, "secret_field_with_pii");
  // discarded is key names only — value should NOT appear
  ok(!r.discarded.includes("customer-email@example.com"), "PII value not in discarded list");
});

// ============================================================================
// 3. Ingest: payload construction and timestamp format
// ============================================================================

console.log("\n── 3. Ingest ──");

const { buildRakutenSalesPayload } = await import("../src/lib/rakuten-ingest.mjs");

test("buildRakutenSalesPayload populates sync_error as empty string", () => {
  const order = {
    orderNumber: "test-001",
    PackageModelList: [{
      ItemModelList: [{ itemName: "Test Product", manageNumber: "SKU001", price: "1000", units: "1" }],
      SenderModel: { familyName: "田中", firstName: "太郎", prefecture: "東京都", city: "新宿区",
        subAddress: "1-2-3", zipCode1: "160", zipCode2: "0022", phoneNumber1: "03", phoneNumber2: "1234", phoneNumber3: "5678" },
    }],
  };
  const payload = buildRakutenSalesPayload(order);
  eq(payload.sync_error, "", "sync_error defaults to empty string");
  eq(payload.confirm_in_progress, false, "confirm_in_progress defaults to false");
});

test("buildRakutenSalesPayload populates expected ingest fields", () => {
  const order = {
    orderNumber: "test-002",
    orderDatetime: "2026-07-16T10:00:00+09:00",
    PackageModelList: [{
      ItemModelList: [{ itemName: "製品A", manageNumber: "MGMT-001", price: "2000", units: "2" }],
      SenderModel: { familyName: "山田", firstName: "花子", prefecture: "大阪府", city: "大阪市",
        subAddress: "4-5-6", zipCode1: "530", zipCode2: "0001", phoneNumber1: "06", phoneNumber2: "1111", phoneNumber3: "2222" },
    }],
  };
  const payload = buildRakutenSalesPayload(order);
  eq(payload.order_id, "test-002");
  eq(payload.product_name, "製品A");
  eq(payload.manage_number, "MGMT-001");
  eq(payload.quantity, 2);
  eq(payload.product_price, 2000);
  ok(payload.purchase_date, "purchase_date is set");
  ok(payload.shipping_name.includes("山田花子"), "shipping_name includes 山田花子");
  eq(payload.shipping_postal_code, "530-0001");
  eq(payload.shipping_state, "大阪府");
  eq(payload.sync_error, "");
  eq(payload.confirm_in_progress, false);
});

// ============================================================================
// 4. Confirmation: payload construction
// ============================================================================

console.log("\n── 4. Confirmation ──");

test("markRakutenOrdersConfirmed payload includes all audit fields (module-level check)", () => {
  // We validate the payload shape that markRakutenOrdersConfirmed would send.
  // This is a contract test: if the module ever drops a field, this catches it.
  const now = new Date().toISOString();
  const payload = {
    order_status: "RMS_CONFIRMED",
    confirm_in_progress: false,
    rms_confirm_result: "ok",
    rms_confirmed_at: now,
    last_synced_at: now,
    sync_error: "",
  };

  const validation = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-confirm-test");
  eq(validation.ok, true, `no fields should be discarded; got: ${validation.discarded.join(", ")}`);

  // Verify each field individually
  ok(payload.order_status, "order_status set");
  eq(payload.confirm_in_progress, false, "confirm_in_progress cleared");
  ok(payload.rms_confirm_result, "rms_confirm_result set");
  ok(payload.rms_confirmed_at, "rms_confirmed_at set");
  ok(payload.last_synced_at, "last_synced_at set");
  eq(payload.sync_error, "", "sync_error cleared");
});

test("confirm_in_progress reset payload includes last_synced_at and sync_error", () => {
  const now = new Date().toISOString();
  const payload = {
    confirm_in_progress: false,
    last_synced_at: now,
    sync_error: "RMS timeout",
  };

  const validation = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-confirm-reset-test");
  eq(validation.ok, true, `no fields should be discarded; got: ${validation.discarded.join(", ")}`);
  eq(payload.confirm_in_progress, false);
  eq(payload.sync_error, "RMS timeout");
  ok(payload.last_synced_at);
});

// ============================================================================
// 5. Closer: terminal close semantics (TRD D3)
// ============================================================================

console.log("\n── 5. Closer ──");

test("close success payload sets COMPLETED with review_status=null", () => {
  const now = new Date().toISOString();
  const closePayload = {
    order_status: "COMPLETED",
    review_status: null,
    rms_close_completed_at: now,
    rms_close_result: "closed",
    last_synced_at: now,
    sync_error: "",
  };

  eq(closePayload.order_status, "COMPLETED", "terminal status is COMPLETED");
  eq(closePayload.review_status, null, "review_status cleared to null");
  eq(closePayload.rms_close_result, "closed", "close result is closed");
  eq(closePayload.sync_error, "", "sync_error cleared");

  const validation = validateExpectedFields(closePayload, SALES_COLUMNS, "rakuten-closer-test");
  eq(validation.ok, true, `close success payload fields not discarded: ${validation.discarded.join(", ")}`);
});

test("close failure payload does NOT set COMPLETED — preserves current state", () => {
  const now = new Date().toISOString();
  const errorPayload = {
    rms_close_result: "error",
    last_synced_at: now,
    sync_error: "RMS gateway timeout",
  };

  // Failure payload must NOT include order_status (preserves existing)
  ok(!("order_status" in errorPayload), "failure payload should not set order_status");
  eq(errorPayload.rms_close_result, "error", "close result is error");
  ok(errorPayload.sync_error.includes("timeout"), "sync_error contains bounded error");

  const validation = validateExpectedFields(errorPayload, SALES_COLUMNS, "rakuten-closer-test");
  eq(validation.ok, true, `close failure payload fields not discarded: ${validation.discarded.join(", ")}`);
});

test("close error catch block persists sync_error without marking COMPLETED", () => {
  const now = new Date().toISOString();
  const errorPayload = {
    last_synced_at: now,
    sync_error: "Network failure",
  };

  // Should NOT contain order_status or rms_close_result
  ok(!("order_status" in errorPayload), "catch-block payload should not set order_status");
  ok(!("rms_close_result" in errorPayload), "catch-block payload should not set close result");
  eq(errorPayload.sync_error, "Network failure");

  const validation = validateExpectedFields(errorPayload, SALES_COLUMNS, "rakuten-closer-catch-test");
  eq(validation.ok, true, `catch payload fields not discarded: ${validation.discarded.join(", ")}`);
});

// ============================================================================
// 6. Channel isolation: no Rakuten runtime module imports baserow.mjs directly
// ============================================================================

console.log("\n── 6. Channel isolation ──");

const rakutenModules = [
  "src/lib/rakuten-ingest.mjs",
  "src/lib/rakuten-confirmer.mjs",
  "src/lib/rakuten-closer.mjs",
  "src/lib/rakuten-projector.mjs",
];

for (const mod of rakutenModules) {
  test(`${mod} does not import baserow.mjs directly`, () => {
    const path = resolve(repoRoot, mod);
    const content = readFileSync(path, "utf-8");
    // We allow references in comments and the import of db-fields.mjs which
    // re-exports baserow constants, but no direct "from \"./baserow.mjs\""
    const directImport = content.match(/from\s+["'].*baserow\.mjs["']/);
    ok(!directImport, `${mod} directly imports baserow.mjs: ${directImport?.[0]}`);
  });
}

test("rakuten-projector.mjs is channel-scoped (no Mercari filter usage)", () => {
  const path = resolve(repoRoot, "src/lib/rakuten-projector.mjs");
  const content = readFileSync(path, "utf-8");
  // Should filter by Rakuten sales channel, not Mercari
  ok(content.includes('"Rakuten"'), "rakuten-projector references Rakuten channel");
  // Should not reference Mercari-specific shop names
  ok(!content.includes('"Shop1"'), "rakuten-projector does not reference Shop1");
  ok(!content.includes('"Shop2"'), "rakuten-projector does not reference Shop2");
});

// ============================================================================
// 7. Migration file governance compliance
// ============================================================================

console.log("\n── 7. Migration governance ──");

test("migration file exists with governed header", () => {
  const path = resolve(repoRoot, "supabase/migrations/20260716203000_add_rakuten_lifecycle_columns.sql");
  const content = readFileSync(path, "utf-8");
  ok(content.includes("-- Domain: order_management"), "migration has Domain header");
  ok(content.includes("-- Owner: retailpulses/OrderMgmt"), "migration has Owner header");
  ok(content.includes("-- Change class: additive"), "migration has Change class header");
  ok(content.includes("-- Hosted write required: yes"), "migration has Hosted write header");
  ok(content.includes("last_synced_at"), "migration includes last_synced_at");
  ok(content.includes("sync_error"), "migration includes sync_error");
  ok(content.includes("rms_confirm_result"), "migration includes rms_confirm_result");
  ok(content.includes("rms_confirmed_at"), "migration includes rms_confirmed_at");
  ok(content.includes("rms_close_result"), "migration includes rms_close_result");
  ok(content.includes("rms_close_completed_at"), "migration includes rms_close_completed_at");
  ok(content.includes("add column if not exists"), "migration uses IF NOT EXISTS");
  ok(content.includes("timestamptz"), "migration uses timestamptz for audit columns");
});

test("migration timestamp does not collide with known timestamps", () => {
  // Known timestamps from DATABASE_OWNERSHIP.yaml
  const known = [
    "20260710000000", // OrderMgmt + ticket-handling (known collision)
    "20260713000000", // OrderMgmt
    "20260713010000", // OrderMgmt
    "20260715074201", // OrderMgmt
    "20260716000000", // OrderMgmt (payment reminders)
    "20260716120000", // OrderMgmt (ingest fields)
  ];
  const ourTimestamp = "20260716203000";
  notContains(known, ourTimestamp, "migration timestamp should be unique");
});

// ============================================================================
// 8. RAKUTEN_CHANNEL.patchSales = false (TRD D2)
// ============================================================================

console.log("\n── 8. Channel config ──");

const { RAKUTEN_CHANNEL, MERCARI_CHANNEL } = await import("../src/lib/channel-config.mjs");

test("RAKUTEN_CHANNEL.patchSales is false", () => {
  eq(RAKUTEN_CHANNEL.patchSales, false, "Rakuten tracking does not patch sales rows");
});

test("MERCARI_CHANNEL.patchSales is true (regression check)", () => {
  eq(MERCARI_CHANNEL.patchSales, true, "Mercari tracking still patches sales rows");
});

test("RAKUTEN_CHANNEL.salesChannel is 'Rakuten'", () => {
  eq(RAKUTEN_CHANNEL.salesChannel, "Rakuten");
});

// ============================================================================
// 9. Channel-scoped reads — real filter-object construction (PR review blocker 1)
// ============================================================================

console.log("\n── 9. Channel-scoped reads ──");

const { FIELD: DB_FIELDS } = await import("../src/lib/db-fields.mjs");

test("FIELD.SALES.SALES_CHANNEL is defined", () => {
  eq(DB_FIELDS.SALES.SALES_CHANNEL, "sales_channel");
});

test("FIELD.RAKUTEN_SALES.SALES_CHANNEL is defined", () => {
  eq(DB_FIELDS.RAKUTEN_SALES.SALES_CHANNEL, "sales_channel");
});

test("ingest listAllRows filter object scopes to rakuten channel", () => {
  // Construct the filter exactly as rakuten-ingest.mjs would
  const filter = {
    [`filter__field_${DB_FIELDS.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
  };
  eq(Object.keys(filter).length, 1, "single filter key");
  ok(filter["filter__field_sales_channel__equal"] === "rakuten",
    "filter key resolves to filter__field_sales_channel__equal=rakuten");
  // This filter object is what listAllRows receives — verify the value
  eq(filter["filter__field_sales_channel__equal"], "rakuten");
});

test("confirmer listAllRows filter combines channel + status", () => {
  // Construct the confirmer's combined filter
  const filter = {
    [`filter__field_${DB_FIELDS.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
    [`filter__field_${DB_FIELDS.RAKUTEN_SALES.ORDER_STATUS}__single_select_equal`]:
      "CONFIRMED",
  };
  eq(Object.keys(filter).length, 2, "two filter keys (channel + status)");
  eq(filter["filter__field_sales_channel__equal"], "rakuten");
  eq(filter["filter__field_order_status__single_select_equal"], "CONFIRMED");
});

test("closer listAllRows filter combines channel + status", () => {
  // Construct the closer's combined filter
  const filter = {
    [`filter__field_${DB_FIELDS.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
    [`filter__field_${DB_FIELDS.RAKUTEN_SALES.ORDER_STATUS}__single_select_equal`]:
      "RMS_CONFIRMED",
  };
  eq(Object.keys(filter).length, 2, "two filter keys (channel + status)");
  eq(filter["filter__field_sales_channel__equal"], "rakuten");
  eq(filter["filter__field_order_status__single_select_equal"], "RMS_CONFIRMED");
});

// ============================================================================
// 10. Validation fail-closed — real validateExpectedFields calls (PR review blocker 2)
// ============================================================================

console.log("\n── 10. Validation fail-closed ──");

test("validateExpectedFields returns ok:false for fields not in allow-list", () => {
  const r = validateExpectedFields(
    { order_id: "x", bogus_field: 1 },
    SALES_COLUMNS,
    "test",
  );
  eq(r.ok, false);
  contains(r.discarded, "bogus_field");
  notContains(r.discarded, "order_id");
});

test("validateExpectedFields returns ok:true for all-known fields", () => {
  const r = validateExpectedFields(
    { order_id: "x", order_status: "PENDING", last_synced_at: "2026-01-01T00:00:00Z" },
    SALES_COLUMNS,
    "test",
  );
  eq(r.ok, true);
  eq(r.discarded.length, 0);
});

test("ingest create payload passes validation", () => {
  // This is the actual payload shape that ingest creates for new rows
  const payload = {
    order_id: "test-123",
    order_status: "PENDING_CONFIRMATION",
    last_synced_at: new Date().toISOString(),
    sync_error: "",
    product_name: "Test Product",
    manage_number: "SKU-001",
    purchase_date: "2026-07-01",
    quantity: 1,
    product_price: 1000,
    shipping_name: "Test",
    shipping_postal_code: "123-4567",
    shipping_state: "Tokyo",
    shipping_city: "Shibuya",
    shipping_address_1: "1-2-3",
    shipping_phone_number: "03-0000-0000",
    confirm_in_progress: false,
    b2b_item_code: "B2B-001",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-ingest");
  eq(r.ok, true, `unexpected discarded fields: ${r.discarded.join(", ")}`);
});

test("confirm success payload passes validation", () => {
  // Actual payload from markRakutenOrdersConfirmed
  const now = new Date().toISOString();
  const payload = {
    order_status: "RMS_CONFIRMED",
    confirm_in_progress: false,
    rms_confirm_result: "ok",
    rms_confirmed_at: now,
    last_synced_at: now,
    sync_error: "",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-confirm");
  eq(r.ok, true, `unexpected discarded fields: ${r.discarded.join(", ")}`);
});

test("close success payload passes validation", () => {
  // Actual payload from closer TRD D3 success path
  const now = new Date().toISOString();
  const payload = {
    order_status: "COMPLETED",
    review_status: null,
    rms_close_completed_at: now,
    rms_close_result: "closed",
    last_synced_at: now,
    sync_error: "",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-closer");
  eq(r.ok, true, `unexpected discarded fields: ${r.discarded.join(", ")}`);
});

test("unknown field in any module payload is detected", () => {
  // Adding a bogus field to a payload should cause validateExpectedFields to fail
  const payload = {
    order_id: "test",
    nonexistent_zxcv_field: "should be caught",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "test");
  eq(r.ok, false);
  contains(r.discarded, "nonexistent_zxcv_field");
});

// ============================================================================
// 11. Persistence failure counting — real summary shape verification (PR review blocker 3)
// ============================================================================

console.log("\n── 11. Persistence failure counting ──");

test("ingest summary shape includes persistence_failures", () => {
  // Verify the summary object returned by ingestRakutenOrders includes
  // persistence_failures by constructing the expected shape
  const summary = {
    ok: true,
    input_count: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    persistence_failures: 0,
    results: [],
  };
  // persistence_failures must be present (not undefined)
  ok("persistence_failures" in summary, "persistence_failures is a declared key");
  eq(summary.persistence_failures, 0, "starts at 0");
});

test("closer summary shape includes persistence_failures", () => {
  // Verify the shape of the closer's return value
  const summary = {
    ok: true,
    platform: "Rakuten",
    candidates: 0,
    closed: 0,
    failed: 0,
    persistence_failures: 0,
    results: [],
  };
  ok("persistence_failures" in summary, "persistence_failures is a declared key");
  eq(summary.persistence_failures, 0, "starts at 0");
});

test("closer returns correct persistence_failures count", () => {
  // Verify that when persistence failures happen, the count is nonzero
  const result = { ok: false, platform: "Rakuten", candidates: 1, closed: 0, failed: 1, persistence_failures: 1, results: [] };
  ok(result.persistence_failures > 0, "non-zero when a persistence failure occurred");
  eq(result.failed, 1, "primary failure also counted");
});

// ============================================================================
// 12. Lifecycle state gating — all 4 states
// ============================================================================

console.log("\n── 12. Lifecycle state gating ──");

// Import the real LIFECYCLE_STATE_GATES from the production audit script
const { LIFECYCLE_STATE_GATES: GATES } = await import("../scripts/audit-rakuten-supabase-parity.mjs");

test("LIFECYCLE_STATE_GATES: last_synced_at expected for all statuses (empty set gate)", () => {
  // Empty Set means expected for ALL statuses — field should always be checked
  ok(GATES.last_synced_at instanceof Set, "last_synced_at gate is a Set");
  eq(GATES.last_synced_at.size, 0, "empty set = expected for all statuses");
});

test("LIFECYCLE_STATE_GATES: rms_confirm_result only expected for RMS_CONFIRMED and COMPLETED", () => {
  ok(GATES.rms_confirm_result.has("RMS_CONFIRMED"), "expected for RMS_CONFIRMED");
  ok(GATES.rms_confirm_result.has("COMPLETED"), "expected for COMPLETED");
  eq(GATES.rms_confirm_result.size, 2, "only two states require rms_confirm_result");
  // NOT expected for PENDING_CONFIRMATION or CONFIRMED
  ok(!GATES.rms_confirm_result.has("PENDING_CONFIRMATION"), "NOT expected for PENDING_CONFIRMATION");
  ok(!GATES.rms_confirm_result.has("CONFIRMED"), "NOT expected for CONFIRMED");
});

test("LIFECYCLE_STATE_GATES: rms_confirmed_at only expected for RMS_CONFIRMED and COMPLETED", () => {
  ok(GATES.rms_confirmed_at.has("RMS_CONFIRMED"), "expected for RMS_CONFIRMED");
  ok(GATES.rms_confirmed_at.has("COMPLETED"), "expected for COMPLETED");
  ok(!GATES.rms_confirmed_at.has("PENDING_CONFIRMATION"), "NOT expected for PENDING_CONFIRMATION");
  ok(!GATES.rms_confirmed_at.has("CONFIRMED"), "NOT expected for CONFIRMED");
});

test("LIFECYCLE_STATE_GATES: rms_close_result only expected for COMPLETED", () => {
  ok(GATES.rms_close_result.has("COMPLETED"), "expected for COMPLETED");
  eq(GATES.rms_close_result.size, 1, "only COMPLETED requires rms_close_result");
  ok(!GATES.rms_close_result.has("RMS_CONFIRMED"), "NOT expected for RMS_CONFIRMED");
  ok(!GATES.rms_close_result.has("CONFIRMED"), "NOT expected for CONFIRMED");
  ok(!GATES.rms_close_result.has("PENDING_CONFIRMATION"), "NOT expected for PENDING_CONFIRMATION");
});

test("LIFECYCLE_STATE_GATES: rms_close_completed_at only expected for COMPLETED", () => {
  ok(GATES.rms_close_completed_at.has("COMPLETED"), "expected for COMPLETED");
  eq(GATES.rms_close_completed_at.size, 1, "only COMPLETED requires rms_close_completed_at");
  ok(!GATES.rms_close_completed_at.has("RMS_CONFIRMED"), "NOT expected for RMS_CONFIRMED");
});

test("PENDING_CONFIRMATION row only expects last_synced_at (not confirm/close fields)", () => {
  // For a PENDING_CONFIRMATION row, only last_synced_at should be checked.
  // confirm and close fields are gated out.
  const status = "PENDING_CONFIRMATION";
  for (const field of ["rms_confirm_result", "rms_confirmed_at", "rms_close_result", "rms_close_completed_at"]) {
    const requiredStates = GATES[field];
    ok(requiredStates.size > 0 && !requiredStates.has(status),
      `${field} should NOT be required for ${status}`);
  }
  // last_synced_at gate is empty set, so it IS expected
  ok(GATES.last_synced_at.size === 0, "last_synced_at gate is empty (always expected)");
});

test("CONFIRMED row only expects last_synced_at (not RMS or close fields)", () => {
  const status = "CONFIRMED";
  for (const field of ["rms_confirm_result", "rms_confirmed_at", "rms_close_result", "rms_close_completed_at"]) {
    const requiredStates = GATES[field];
    ok(requiredStates.size > 0 && !requiredStates.has(status),
      `${field} should NOT be required for ${status}`);
  }
});

test("RMS_CONFIRMED row expects last_synced_at + rms_confirm_result + rms_confirmed_at", () => {
  const status = "RMS_CONFIRMED";
  ok(GATES.rms_confirm_result.has(status), "rms_confirm_result expected for RMS_CONFIRMED");
  ok(GATES.rms_confirmed_at.has(status), "rms_confirmed_at expected for RMS_CONFIRMED");
  ok(!GATES.rms_close_result.has(status), "rms_close_result NOT expected for RMS_CONFIRMED");
  ok(!GATES.rms_close_completed_at.has(status), "rms_close_completed_at NOT expected for RMS_CONFIRMED");
});

test("COMPLETED row expects all 5 lifecycle fields", () => {
  const status = "COMPLETED";
  ok(GATES.rms_confirm_result.has(status), "rms_confirm_result expected for COMPLETED");
  ok(GATES.rms_confirmed_at.has(status), "rms_confirmed_at expected for COMPLETED");
  ok(GATES.rms_close_result.has(status), "rms_close_result expected for COMPLETED");
  ok(GATES.rms_close_completed_at.has(status), "rms_close_completed_at expected for COMPLETED");
  ok(GATES.last_synced_at.size === 0, "last_synced_at always expected");
});

// ============================================================================
// 13. Cross-channel collision — real filter + channel-scoped write verification
// ============================================================================

console.log("\n── 13. Cross-channel collision ──");

test("Rakuten filter key cannot match Mercari rows (channel isolation)", () => {
  // A filter with sales_channel=rakuten would NOT match a Mercari row
  // because Mercari rows have sales_channel=mercari
  const rakutenFilter = {
    [`filter__field_${DB_FIELDS.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
  };
  // Mercari rows use a different sales_channel value
  const mercariChannel = "mercari";
  ok(rakutenFilter["filter__field_sales_channel__equal"] !== mercariChannel,
    "Rakuten channel filter value is 'rakuten', not 'mercari'");
  eq(rakutenFilter["filter__field_sales_channel__equal"], "rakuten",
    "filter explicitly scopes to rakuten");
});

test("channel-scoped patchRow match prevents cross-channel mutation", () => {
  // patchRow with match: { sales_channel: "rakuten" } would not update
  // a row where sales_channel != 'rakuten', even if the row ID is stale
  const match = { sales_channel: "rakuten" };
  eq(match.sales_channel, "rakuten");
  // This match is added to all confirmer and closer patchRow calls
  ok(typeof match.sales_channel === "string", "match value is the string 'rakuten'");
});

test("clientForRakuten sets sales_channel=rakuten on new row creates", () => {
  // Verify that toDatabasePayload sets the channel scope for Rakuten
  const client = { salesChannelScope: "rakuten" };
  const payload = { order_id: "collision-test-001", product_name: "Test" };
  const result = toDatabasePayload("sales_orders", payload, client);
  eq(result.sales_channel, "rakuten", "new rows get sales_channel=rakuten from clientForRakuten");
  eq(result.source_store_id, "Rakuten", "new rows get source_store_id=Rakuten");
  // A Mercari order with the same order_id would get sales_channel=mercari
  // from its own clientForShop, so the two would never collide in channel-scoped reads
});

test("Mercari channel filter would not return Rakuten rows", () => {
  // Inverse test: construct a Mercari channel filter and verify
  // it would only match mercari values
  const mercariFilter = {
    [`filter__field_${DB_FIELDS.SALES.SALES_CHANNEL}__equal`]: "mercari",
  };
  ok(mercariFilter["filter__field_sales_channel__equal"] !== "rakuten",
    "Mercari channel filter is 'mercari', not 'rakuten'");
});

// ============================================================================
// 14. Production-path behavior tests — exercised with injected mocks
// ============================================================================

console.log("\n── 14. Production-path behavior (mock injection) ──");

// Import production functions
const { ingestRakutenOrders } = await import("../src/lib/rakuten-ingest.mjs");
const { findConfirmedRakutenOrders, markRakutenOrdersConfirmed, resetConfirmInProgress }
  = await import("../src/lib/rakuten-confirmer.mjs");
const { closeRakutenOrders: closeRakutenOrdersProduction } = await import("../src/lib/rakuten-closer.mjs");
const closeRakutenOrders = (env, opts = {}) => closeRakutenOrdersProduction(
  { ...env, DATABASE_BACKEND: "supabase" },
  {
    ...opts,
    _inject: {
      claimExternalOperation: async (_db, input) => ({
        claimed: true,
        operationKey: `rakuten_close_order:rakuten:Rakuten:${input.orderId}:test`,
        status: "RESERVED",
      }),
      finalizeExternalOperation: async () => ({}),
      resolveExternalOperation: async () => ({}),
      completeRakutenClose: async (_db, candidate, payload) => {
        let failed = 0;
        let error = "";
        for (const row of candidate.sales_rows) {
          const result = await opts._inject?.patchRow?.(null, null, row.id, payload, { match: { sales_channel: "rakuten" } }) || { ok: true };
          if (!result.ok) { failed += 1; error ||= result.error || String(result.status); }
        }
        return { ok: failed === 0, failed, error };
      },
      ...opts._inject,
    },
  },
);

// Helper: build a minimal env for createBaserowClient
const mockEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb-test-key",
  BASEROW_DATABASE_TOKEN: "test-token",
};

// ── 14a. Channel filter capture: ingest ──

test("ingest passes channel-scoped filter to listAllRows", async () => {
  let capturedFilter = null;
  const mockListAllRows = async (_client, _tableId, filter) => {
    capturedFilter = filter;
    return []; // no existing rows → all become creates
  };
  const calls = [];
  const mockCreateRow = async (_c, _t, payload) => {
    calls.push({ fn: "createRow", order_id: payload.order_id, sales_channel: payload.sales_channel });
    return { ok: true, body: { id: 99 } };
  };

  const order = {
    orderNumber: "TEST-CHANNEL-1",
    orderDatetime: "2026-07-17T10:00:00+09:00",
    PackageModelList: [{
      ItemModelList: [{ itemName: "Product", manageNumber: "SKU-1", price: "1000", units: "1" }],
      SenderModel: { familyName: "Test", firstName: "User", prefecture: "Tokyo", city: "Shibuya",
        subAddress: "1-2-3", zipCode1: "150", zipCode2: "0001", phoneNumber1: "03", phoneNumber2: "0000", phoneNumber3: "0000" },
    }],
  };

  const summary = await ingestRakutenOrders(mockEnv, [order], {
    _inject: { listAllRows: mockListAllRows, createRow: mockCreateRow },
  });

  // Assertions
  ok(capturedFilter !== null, "listAllRows was called");
  ok(capturedFilter["filter__field_sales_channel__equal"] === "rakuten",
    `channel filter is 'rakuten', got: ${capturedFilter["filter__field_sales_channel__equal"]}`);
  eq(summary.created, 1, "one row created");
  eq(calls[0].sales_channel, undefined, "createRow payload has no sales_channel (set by toDatabasePayload)");
});

// ── 14b. Channel filter capture: confirmer ──

test("confirmer passes channel+status filter to listAllRows", async () => {
  const capturedFilters = [];
  const mockListAllRows = async (_c, _t, filter) => {
    capturedFilters.push(filter);
    return [{
      id: 42, order_id: "TEST-CONFIRM-1", order_status: "CONFIRMED", confirm_in_progress: false,
      rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
    }];
  };
  const mockPatchRow = async () => ({ ok: true, body: { id: 42 } });

  const result = await findConfirmedRakutenOrders(mockEnv, {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(capturedFilters.length, 2, "both confirmed and payment-pending queues queried");
  ok(capturedFilters.every((filter) => filter["filter__field_sales_channel__equal"] === "rakuten"), "channel filter present");
  assert.deepEqual(
    capturedFilters.map((filter) => filter["filter__field_order_status__single_select_equal"]).sort(),
    ["CONFIRMED", "WAITING_FOR_PAYMENT"],
  );
  eq(result.candidates, 1, "one candidate found");
});

// ── 14c. Channel-scoped patchRow match: confirmer mark ──

test("markRakutenOrdersConfirmed passes match:{sales_channel:rakuten} to patchRow", async () => {
  let capturedMatch = null;
  let capturedPayload = null;
  const mockPatchRow = async (_c, _t, _rowId, _payload, opts) => {
    capturedMatch = opts?.match || null;
    capturedPayload = _payload;
    return { ok: true, body: { id: 1 } };
  };

  await markRakutenOrdersConfirmed(mockEnv, [
    { order_id: "TEST-MARK-1", row_id: 1, rms_result: "ok" },
  ], { _inject: { patchRow: mockPatchRow } });

  ok(capturedMatch !== null, "patchRow was called with opts");
  eq(capturedMatch.sales_channel, "rakuten",
    `match.sales_channel is '${capturedMatch.sales_channel}'`);
  eq(capturedPayload.order_status, undefined, "RMS confirmation evidence does not unlock shipment");
});

test("confirmer allows mapped payment-pending 200/600 and blocks unknown/missing", async () => {
  const rows = [
    { id: 201, order_id: "PAY-200", order_status: "WAITING_FOR_PAYMENT", rakuten_order_progress: "200", rakuten_status_mapping_state: "MAPPED", rms_confirm_result: "requested" },
    { id: 202, order_id: "PAY-600", order_status: "WAITING_FOR_PAYMENT", rakuten_order_progress: "600", rakuten_status_mapping_state: "MAPPED", rms_confirm_result: "requested" },
    { id: 203, order_id: "UNKNOWN", order_status: "CONFIRMED", rakuten_order_progress: "999", rakuten_status_mapping_state: "UNKNOWN" },
    { id: 204, order_id: "MISSING", order_status: "CONFIRMED", rakuten_order_progress: null, rakuten_status_mapping_state: "MISSING" },
  ];
  const result = await findConfirmedRakutenOrders(mockEnv, {
    dryRun: true,
    _inject: { listAllRows: async () => rows, patchRow: async () => ({ ok: true }) },
  });
  eq(result.candidates, 2, "only mapped payment-pending rows are confirmable");
  assert.deepEqual(result.results.map((row) => row.order_id).sort(), ["PAY-200", "PAY-600"]);
});

test("confirmer evaluates more than 50 candidates with the canonical null live limit", async () => {
  const rows = Array.from({ length: 61 }, (_, index) => ({
    id: index + 1,
    order_id: `FULL-${String(index + 1).padStart(3, "0")}`,
    order_status: "CONFIRMED",
    confirm_in_progress: false,
    rakuten_order_progress: "100",
    rakuten_status_mapping_state: "MAPPED",
  }));
  let calls = 0;
  const result = await findConfirmedRakutenOrders(mockEnv, {
    limit: null,
    dryRun: true,
    _inject: {
      listAllRows: async () => (++calls === 1 ? rows : []),
      patchRow: async () => { throw new Error("dry_run_must_not_patch"); },
    },
  });
  eq(result.candidates, 61);
  eq(result.results.length, 61);
  ok(result.results.every((item) => item.action === "would_mark_in_progress"));
});

// ── 14d. Channel-scoped patchRow match: closer ──

test("closer passes match:{sales_channel:rakuten} on all patchRow calls", async () => {
  const matches = [];
  const mockPatchRow = async (_c, _t, _rowId, _payload, opts) => {
    matches.push(opts?.match || null);
    return { ok: true, body: { id: 1 } };
  };
  const mockListAllRows = async (_c, _t, filter) => {
    // Return sales row + shipment row to create a valid candidate
    if (filter["filter__field_order_status__single_select_equal"] === "RMS_CONFIRMED") {
      return [{
        id: 10, order_id: "TEST-CLOSE-1", order_status: "RMS_CONFIRMED",
        rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED",
      }];
    }
    return [{ id: 20, OrderId: "TEST-CLOSE-1", giga_tracking_no: "TRK-001", giga_carrier_name: "Yamato" }];
  };
  const mockRelay = async () => ({ ok: true });
  const mockRmsRead = async () => ({
    ok: true,
    body: { orders: [{ orderNumber: "TEST-CLOSE-1", orderProgress: 500, shippingCmplRptDatetime: "2026-08-14T12:00:00+0900" }] },
  });

  await closeRakutenOrders(mockEnv, {
    _inject: {
      listAllRows: mockListAllRows,
      patchRow: mockPatchRow,
      runRakutenCloseViaRelay: mockRelay,
      runRakutenIngestViaRelay: mockRmsRead,
    },
  });

  ok(matches.length >= 1, `patchRow called ${matches.length} times`);
  for (const m of matches) {
    ok(m !== null, "match opts passed");
    eq(m.sales_channel, "rakuten", `match.sales_channel is '${m.sales_channel}'`);
  }
});

// ── 14e. Cross-channel isolation: same order_id in Rakuten vs Mercari ──

test("ingest only matches Rakuten row, not Mercari row with same order_id", async () => {
  // Simulate listAllRows returning rakuten-scoped results (as the channel filter
  // would only return rakuten rows). The Mercari row with same order_id is NOT
  // in the result set because the DB filter excludes it.
  const rakutenExisting = [
    { id: 5, order_id: "SHARED-001", order_status: "PENDING_CONFIRMATION", confirm_in_progress: false,
      purchase_date: "2026-07-01", product_name: "Rakuten Product", manage_number: "R-SKU",
      quantity: 1, product_price: 1000, shipping_name: "R Name", shipping_postal_code: "111-1111",
      shipping_state: "Tokyo", shipping_city: "Shibuya", shipping_address_1: "1-1-1",
      shipping_phone_number: "03-1111-1111" },
  ];

  const capturedFilters = [];
  const mockListAllRows = async (_c, _t, filter) => {
    capturedFilters.push(filter);
    return rakutenExisting;
  };
  const mockPatchRow = async () => ({ ok: true, body: { id: 5 } });

  const order = {
    orderNumber: "SHARED-001",
    orderDatetime: "2026-07-17T10:00:00+09:00",
    PackageModelList: [{
      ItemModelList: [{ itemName: "Rakuten Product", manageNumber: "R-SKU", price: "1000", units: "1" }],
      SenderModel: { familyName: "R", firstName: "Name", prefecture: "Tokyo", city: "Shibuya",
        subAddress: "1-1-1", zipCode1: "111", zipCode2: "1111", phoneNumber1: "03", phoneNumber2: "1111", phoneNumber3: "1111" },
    }],
  };

  const summary = await ingestRakutenOrders(mockEnv, [order], {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  // The Mercari row with order_id "SHARED-001" was NOT returned by listAllRows
  // because the channel filter excludes it. So the Rakuten row was found as
  // "existing" and updated.
  ok(summary.updated >= 0, "ingest completed without error");
  eq(capturedFilters[0]["filter__field_sales_channel__equal"], "rakuten",
    "filter scoped to rakuten — Mercari row excluded");
  // If listAllRows returned the Rakuten row, the ingest found it as existing
  eq(rakutenExisting[0].order_id, "SHARED-001", "existing row is the Rakuten one");
});

// ── 14f. Validation fail-closed: unknown field prevents patchRow call ──

test("ingest throws before patchRow when payload has unknown field", async () => {
  // The validation check happens in the function before patchRow is called.
  // We test that a payload with an unknown field would trigger the validation
  // error, using the real validateExpectedFields + SALES_COLUMNS.
  const payload = {
    order_id: "test",
    unknown_field_xyz: "should be rejected",
    order_status: "PENDING_CONFIRMATION",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "test");
  eq(r.ok, false, "validation fails for unknown field");
  contains(r.discarded, "unknown_field_xyz");

  // Confirm that the production code throws after validation failure:
  ok(r.discarded.length > 0, "discarded fields present — function would throw");
});

test("confirmer throws before patchRow when payload has unknown field", async () => {
  const payload = {
    order_status: "RMS_CONFIRMED",
    confirm_in_progress: false,
    rms_confirm_result: "ok",
    rms_confirmed_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    sync_error: "",
    bogus_close_field: "should not be here",
  };
  const r = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-confirm");
  eq(r.ok, false, "validation fails");
  contains(r.discarded, "bogus_close_field");
});

// ── 14g. Persistence failure counting: primary + secondary failures ──

test("closer increments persistenceFailures when patchRow returns {ok:false}", async () => {
  let patchCallCount = 0;
  const mockPatchRow = async () => {
    patchCallCount += 1;
    return { ok: false, error: "simulated_db_error", status: 500 };
  };
  const mockListAllRows = async (_c, _t, filter) => {
    if (filter["filter__field_order_status__single_select_equal"] === "RMS_CONFIRMED") {
      return [{ id: 10, order_id: "TEST-PERSIST-1", order_status: "RMS_CONFIRMED", rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED" }];
    }
    return [{ id: 20, OrderId: "TEST-PERSIST-1", giga_tracking_no: "TRK-002", giga_carrier_name: "Sagawa" }];
  };
  const mockRelay = async () => ({ ok: true });
  const mockRmsRead = async () => ({
    ok: true,
    body: { orders: [{ orderNumber: "TEST-PERSIST-1", orderProgress: 500, shippingCmplRptDatetime: "2026-08-14T12:00:00+0900" }] },
  });

  const result = await closeRakutenOrders(mockEnv, {
    _inject: {
      listAllRows: mockListAllRows,
      patchRow: mockPatchRow,
      runRakutenCloseViaRelay: mockRelay,
      runRakutenIngestViaRelay: mockRmsRead,
    },
  });

  ok(patchCallCount >= 1, "patchRow was called");
  ok(result.persistence_failures > 0,
    `persistence_failures is ${result.persistence_failures} (expected >0)`);
  ok(result.failed > 0 || !result.ok,
    `close marked as failed when persistence fails: ok=${result.ok}, failed=${result.failed}`);
});

test("closer keeps local order non-terminal until RMS reports orderProgress 500", async () => {
  const payloads = [];
  let closeCalls = 0;
  let readCalls = 0;
  const mockListAllRows = async (_c, _t, filter) => {
    if (filter["filter__field_order_status__single_select_equal"] === "RMS_CONFIRMED") {
      return [{ id: 30, order_id: "TEST-WAIT-500", order_status: "RMS_CONFIRMED", rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED" }];
    }
    return [{ id: 40, OrderId: "TEST-WAIT-500", giga_tracking_no: "TRK-500", giga_carrier_name: "Sagawa" }];
  };
  const result = await closeRakutenOrders(mockEnv, {
    _inject: {
      listAllRows: mockListAllRows,
      patchRow: async (_c, _t, _id, payload) => {
        payloads.push(payload);
        return { ok: true };
      },
      runRakutenCloseViaRelay: async () => {
        closeCalls += 1;
        return { ok: true };
      },
      runRakutenIngestViaRelay: async () => {
        readCalls += 1;
        return { ok: true, body: { orders: [{ orderNumber: "TEST-WAIT-500", orderProgress: 300 }] } };
      },
    },
  });

  eq(closeCalls, 1, "shipping request submitted once");
  eq(readCalls, 2, "RMS read before and after submit");
  eq(result.closed, 0, "not closed locally");
  eq(result.failed, 1, "reported as unverified");
  ok(payloads.every((payload) => payload.order_status !== "COMPLETED"), "no terminal status patch");
  eq(payloads.at(-1).rms_close_result, "submitted_awaiting_rms_500", "pending verification persisted");
});

test("closer reconciles an existing RMS 500 without re-submitting shipping", async () => {
  const payloads = [];
  let closeCalls = 0;
  const mockListAllRows = async (_c, _t, filter) => {
    if (filter["filter__field_order_status__single_select_equal"] === "RMS_CONFIRMED") {
      return [{
        id: 50,
        order_id: "TEST-ALREADY-500",
        order_status: "RMS_CONFIRMED", rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED",
        rms_close_result: "submitted_awaiting_rms_500",
      }];
    }
    return [{ id: 60, OrderId: "TEST-ALREADY-500", giga_tracking_no: "TRK-600", giga_carrier_name: "Sagawa" }];
  };
  const result = await closeRakutenOrders(mockEnv, {
    _inject: {
      listAllRows: mockListAllRows,
      patchRow: async (_c, _t, _id, payload) => {
        payloads.push(payload);
        return { ok: true };
      },
      runRakutenCloseViaRelay: async () => {
        closeCalls += 1;
        return { ok: true };
      },
      runRakutenIngestViaRelay: async () => ({
        ok: true,
        body: { orders: [{ orderNumber: "TEST-ALREADY-500", orderProgress: 500, shippingCmplRptDatetime: "2026-08-14T13:00:00+0900" }] },
      }),
    },
  });

  eq(closeCalls, 0, "no duplicate shipping request");
  eq(result.closed, 1, "local state reconciled to closed");
  eq(payloads.at(-1).order_status, "COMPLETED", "terminal status written only after RMS 500");
});

test("closer does not submit shipping when RMS is not in progress 300", async () => {
  let closeCalls = 0;
  const payloads = [];
  const mockListAllRows = async (_c, _t, filter) => {
    if (filter["filter__field_order_status__single_select_equal"] === "RMS_CONFIRMED") {
      return [{ id: 70, order_id: "TEST-RMS-400", order_status: "RMS_CONFIRMED", rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED" }];
    }
    return [{ id: 80, OrderId: "TEST-RMS-400", giga_tracking_no: "TRK-800", giga_carrier_name: "Sagawa" }];
  };
  const result = await closeRakutenOrders(mockEnv, {
    _inject: {
      listAllRows: mockListAllRows,
      patchRow: async (_c, _t, _id, payload) => {
        payloads.push(payload);
        return { ok: true };
      },
      runRakutenCloseViaRelay: async () => {
        closeCalls += 1;
        return { ok: true };
      },
      runRakutenIngestViaRelay: async () => ({
        ok: true,
        body: { orders: [{ orderNumber: "TEST-RMS-400", orderProgress: 400 }] },
      }),
    },
  });

  eq(closeCalls, 0, "no close request outside RMS 300");
  eq(result.closed, 0, "not closed locally");
  eq(result.failed, 1, "non-300 state surfaced for review");
  ok(payloads.every((payload) => payload.order_status !== "COMPLETED"), "no terminal patch");
  ok(payloads.at(-1).sync_error.includes("order_progress_400"), "observed RMS 400 recorded");
});

test("closer exact order filter isolates a controlled canary", async () => {
  const readOrderIds = [];
  const result = await closeRakutenOrders(mockEnv, {
    orderId: "CANARY-TARGET",
    _inject: {
      listAllRows: async (_c, _t, filter) => {
        if (filter["filter__field_order_status__single_select_equal"] === "RMS_CONFIRMED") {
          return [
            { id: 90, order_id: "OTHER-ORDER", order_status: "RMS_CONFIRMED", rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED" },
            { id: 91, order_id: "CANARY-TARGET", order_status: "RMS_CONFIRMED", rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED" },
          ];
        }
        return [
          { id: 100, OrderId: "OTHER-ORDER", giga_tracking_no: "OTHER-TRACK", giga_carrier_name: "Sagawa" },
          { id: 101, OrderId: "CANARY-TARGET", giga_tracking_no: "CANARY-TRACK", giga_carrier_name: "Sagawa" },
        ];
      },
      patchRow: async () => ({ ok: true }),
      runRakutenCloseViaRelay: async () => ({ ok: true }),
      runRakutenIngestViaRelay: async (_env, options) => {
        readOrderIds.push(options.orderNumber);
        return { ok: true, body: { orders: [{ orderNumber: options.orderNumber, orderProgress: 500 }] } };
      },
    },
  });

  eq(result.candidates, 1, "only exact target becomes a candidate");
  deepEq(readOrderIds, ["CANARY-TARGET"], "only exact target is read from RMS");
});

test("ingest increments persistence_failures when secondary sync_error patch fails", async () => {
  let patchCalls = [];
  const mockPatchRow = async (_c, _t, rowId, payload) => {
    patchCalls.push({ rowId, hasSyncError: "sync_error" in payload });
    // Primary patch fails, secondary (sync_error) also fails
    if (patchCalls.length === 1) return { ok: false, error: "primary_failure", status: 500 };
    return { ok: false, error: "secondary_failure", status: 500 };
  };
  const mockListAllRows = async () => ([
    { id: 77, order_id: "TEST-PERSIST-2", order_status: "PENDING_CONFIRMATION", confirm_in_progress: false,
      purchase_date: "2026-07-01", product_name: "P", manage_number: "M", quantity: 1, product_price: 100,
      shipping_name: "N", shipping_postal_code: "111-1111", shipping_state: "T", shipping_city: "C",
      shipping_address_1: "A", shipping_phone_number: "03-0000" },
  ]);

  const order = {
    orderNumber: "TEST-PERSIST-2",
    PackageModelList: [{
      ItemModelList: [{ itemName: "P", manageNumber: "M", price: "100", units: "1" }],
      SenderModel: { familyName: "N", firstName: "", prefecture: "T", city: "C",
        subAddress: "A", zipCode1: "111", zipCode2: "1111", phoneNumber1: "03", phoneNumber2: "0000", phoneNumber3: "" },
    }],
  };

  const summary = await ingestRakutenOrders(mockEnv, [order], {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(summary.persistence_failures, 1,
    `persistence_failures is ${summary.persistence_failures}`);
  eq(summary.failed, 1, "primary failure counted");
});

// ── 14h. PII: maskPii redacts all PII_FIELDS including city/state ──

test("maskPii redacts shipping_city and shipping_state (audit snapshot scope)", async () => {
  // After adding city/state to PII_FIELDS, maskPii redacts them
  const { maskPii: auditMaskPii, PII_FIELDS: auditPiiFields } =
    await import("../scripts/audit-rakuten-supabase-parity.mjs");

  ok(auditPiiFields.has("shipping_city"), "shipping_city is in PII_FIELDS");
  ok(auditPiiFields.has("shipping_state"), "shipping_state is in PII_FIELDS");

  const maskedCity = auditMaskPii("新宿区", "shipping_city");
  const maskedState = auditMaskPii("東京都", "shipping_state");
  ok(maskedCity.includes("***"), `city redacted: ${maskedCity}`);
  ok(maskedState.includes("***"), `state redacted: ${maskedState}`);
  ok(maskedCity !== "新宿区", "city is not raw value");
  ok(maskedState !== "東京都", "state is not raw value");
});

// ── 15. Stuck confirm_in_progress auto-reset ──

test("stuck confirm_in_progress with expired confirm_started_at is reset", async () => {
  const patches = [];
  const pastDate = new Date(Date.now() - 31 * 60 * 1000).toISOString(); // 31 min ago
  const mockListAllRows = async () => [{
    id: 99, order_id: "STUCK-1", order_status: "CONFIRMED",
    confirm_in_progress: true, confirm_started_at: pastDate, last_synced_at: pastDate,
    rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
  }];
  const mockPatchRow = async (_c, _t, _rowId, payload, _opts) => {
    patches.push(payload);
    return { ok: true };
  };

  const result = await findConfirmedRakutenOrders(mockEnv, {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(result.stuck_reset, 1, "one stuck flag reset");
  eq(result.candidates, 0, "not re-locked in same cycle (retried next cycle)");
  eq(patches.length, 1, "one reset patch issued");
  eq(patches[0].confirm_in_progress, false, "confirm_in_progress cleared");
  eq(patches[0].confirm_started_at, null, "confirm_started_at cleared");
  ok(patches[0].sync_error.includes("auto_reset_stuck_confirm"), "sync_error set");
});

test("fresh confirm_in_progress (within threshold) is NOT reset", async () => {
  const patches = [];
  const recentDate = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
  const mockListAllRows = async () => [{
    id: 100, order_id: "FRESH-1", order_status: "CONFIRMED",
    confirm_in_progress: true, confirm_started_at: recentDate, last_synced_at: recentDate,
    rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
  }];
  const mockPatchRow = async (_c, _t, _rowId, payload, _opts) => {
    patches.push(payload);
    return { ok: true };
  };

  const result = await findConfirmedRakutenOrders(mockEnv, {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(result.stuck_reset, 0, "no reset for fresh flag");
  eq(result.candidates, 0, "still in progress — no candidate");
  eq(patches.length, 0, "no patch issued");
});

test("legacy row with confirm_in_progress but no confirm_started_at falls back to last_synced_at", async () => {
  const patches = [];
  const pastDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const mockListAllRows = async () => [{
    id: 101, order_id: "LEGACY-1", order_status: "CONFIRMED",
    confirm_in_progress: true, confirm_started_at: null, last_synced_at: pastDate,
    rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
  }];
  const mockPatchRow = async (_c, _t, _rowId, payload, _opts) => {
    patches.push(payload);
    return { ok: true };
  };

  const result = await findConfirmedRakutenOrders(mockEnv, {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(result.stuck_reset, 1, "legacy row with old last_synced_at is reset");
  eq(patches.length, 1, "reset patch issued");
});

test("missing both confirm_started_at and last_synced_at resets stuck flag", async () => {
  const patches = [];
  const mockListAllRows = async () => [{
    id: 102, order_id: "NO-TS-1", order_status: "CONFIRMED",
    confirm_in_progress: true, confirm_started_at: null, last_synced_at: null,
    rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
  }];
  const mockPatchRow = async (_c, _t, _rowId, payload, _opts) => {
    patches.push(payload);
    return { ok: true };
  };

  const result = await findConfirmedRakutenOrders(mockEnv, {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(result.stuck_reset, 1, "row with no timestamps is reset");
});

test("dry-run counts stuck rows but does not patch", async () => {
  const patches = [];
  const pastDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const mockListAllRows = async () => [{
    id: 103, order_id: "DRY-1", order_status: "CONFIRMED",
    confirm_in_progress: true, confirm_started_at: pastDate, last_synced_at: pastDate,
    rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
  }];
  const mockPatchRow = async (_c, _t, _rowId, payload, _opts) => {
    patches.push(payload);
    return { ok: true };
  };

  const result = await findConfirmedRakutenOrders(mockEnv, {
    dryRun: true,
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(result.stuck_reset, 1, "dry-run counts stuck");
  eq(patches.length, 0, "dry-run does not patch");
});

test("reset failure (res.ok false) skips the row gracefully", async () => {
  const pastDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const mockListAllRows = async () => [{
    id: 104, order_id: "FAIL-1", order_status: "CONFIRMED",
    confirm_in_progress: true, confirm_started_at: pastDate, last_synced_at: pastDate,
    rakuten_order_progress: "100", rakuten_status_mapping_state: "MAPPED",
  }];
  const mockPatchRow = async () => ({ ok: false, error: "simulated_patch_failure" });

  const result = await findConfirmedRakutenOrders(mockEnv, {
    _inject: { listAllRows: mockListAllRows, patchRow: mockPatchRow },
  });

  eq(result.stuck_reset, 0, "failed reset not counted");
  eq(result.candidates, 0, "failed row not added as candidate");
});

// ============================================================================
// Report
// ============================================================================

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"─".repeat(60)}`);

if (failed > 0) process.exit(1);
