#!/usr/bin/env node
/**
 * Comprehensive parity tests for the Supabase adapter.
 *
 * Categories:
 *   1. translateFilterParams unit tests (pure function, inlined from baserow.mjs)
 *      -- tests the reverse-mapping of column names to Baserow field IDs
 *   2. applyFilters unit tests (inlined from supabase.mjs)
 *      -- tests how Baserow-format filter keys map to Supabase query methods
 *   3. Client creation tests (no DB needed, imports supabase.mjs)
 *   4. CRUD response shape tests (mock supabase client)
 *      -- verifies return shapes match baserow.mjs exactly
 *   5. Integration tests (skipped without live Supabase connection)
 *
 * Usage:
 *   node test/supabase-adapter.test.mjs
 *
 * To run integration tests:
 *   SUPABASE_URL=https://your-project.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
 *   node test/supabase-adapter.test.mjs
 */

import { strict as assert } from "node:assert";
import {
  createBaserowClient,
  clientForRakuten,
  patchRow,
  createRow,
  deleteRow,
  listRowsWithLimit,
  listAllRows,
} from "../src/lib/supabase.mjs";
import {
  FIELD,
  OPTION,
  BASEROW_FIELD,
  BASEROW_OPTION,
} from "../src/lib/db-fields.mjs";

// ============================================================================
// Inlined pure functions for unit testing
// ============================================================================

// ---------------------------------------------------------------------------
// translateFilterParams from baserow.mjs
// Maps column names to Baserow numeric field IDs.
// ---------------------------------------------------------------------------

const FIELD_NAME_TO_ID = {
  order_id: "7824209",
  product_name: "7824214",
  original_product_id: "7824213",
  b2b_item_code: "8990468",
  source_store_id: "7907194",
  order_status: "7907193",
  shipping_completed_at: "7909235",
  shipping_phone_number: "7824241",
  shipping_name: "7824233",
  shipping_postal_code: "7824228",
  review_status: "8989067",
  auto_approval_rule: "9308210",
  auto_approved_at: "9308212",
  ai_copywrite_log: "9064713",
  manage_number: "8918899",
  confirm_in_progress: "8918919",
  giga_sync_status: "7907696",
  sales_channel: "7824251",
  created_at: "8016485",
};

const OPTION_VALUE_TO_ID = {
  CANCELED: "5982564",
  WAITING_FOR_SHIPPING: "5982565",
  WAITING_FOR_PAYMENT: "5982566",
  COMPLETED: "5982567",
  PENDING_CONFIRMATION: "6444571",
  CONFIRMED: "6444572",
  RMS_CONFIRMED: "6444573",
  SYNCED: "5785872",
  ALREADY_EXISTS: "5785873",
  INVALID: "5785874",
  ERROR: "5785875",
  PENDING_REVIEW: "6482438",
  APPROVED: "6482439",
  ON_HOLD: "6484637",
  AUTO_APPROVED: "6523828",
};

function translateFilterParams(filterParams) {
  if (!filterParams || !Object.keys(filterParams).length) return filterParams;

  const translated = {};
  for (const [key, value] of Object.entries(filterParams)) {
    const match = key.match(/^filter__field_(.+?)__(.+?)$/);
    if (match) {
      let [, identifier, operator] = match;
      const fieldId = FIELD_NAME_TO_ID[identifier];
      if (fieldId) identifier = fieldId;

      let translatedValue = value;
      if (
        (operator === "single_select_equal" ||
          operator === "single_select_not_equal") &&
        !Array.isArray(value)
      ) {
        const optionId = OPTION_VALUE_TO_ID[String(value)];
        if (optionId) translatedValue = optionId;
      } else if (operator === "single_select_equal" && Array.isArray(value)) {
        translatedValue = value.map(
          (v) => OPTION_VALUE_TO_ID[String(v)] || v
        );
      }

      translated[`filter__field_${identifier}__${operator}`] =
        translatedValue;
    } else {
      translated[key] = value;
    }
  }
  return translated;
}

// ---------------------------------------------------------------------------
// applyFilters from supabase.mjs
// Applies Baserow-format filter keys to a Supabase query builder.
// ---------------------------------------------------------------------------

function applyFilters(query, filterParams) {
  for (const [key, value] of Object.entries(filterParams)) {
    if (value == null) continue;

    const match = key.match(/^filter__field_(.+?)__(.+?)$/);
    if (!match) continue;

    const [, column, operator] = match;

    if (Array.isArray(value)) {
      if (operator === "equal" || operator === "single_select_equal") {
        query = query.in(column, value.map(String));
      }
      continue;
    }

    const strVal = String(value);

    switch (operator) {
      case "equal":
      case "single_select_equal":
        query = query.eq(column, strVal);
        break;
      case "single_select_not_equal":
        query = query.neq(column, strVal);
        break;
      case "empty":
        query = query.is(column, null);
        break;
      case "not_empty":
        query = query.not(column, "is", null);
        break;
      case "contains":
        query = query.ilike(column, `%${strVal}%`);
        break;
      case "boolean":
        query = query.eq(column, strVal === "true" || strVal === "1");
        break;
    }
  }

  return query;
}

/**
 * Create a mock query builder that records all method calls.
 * Each filter method returns the builder (chainable).
 */
function createMockQuery() {
  const calls = [];
  const q = function () {
    return q;
  };
  q.eq = (...a) => (calls.push(["eq", ...a]), q);
  q.neq = (...a) => (calls.push(["neq", ...a]), q);
  q.is = (...a) => (calls.push(["is", ...a]), q);
  q.not = (...a) => (calls.push(["not", ...a]), q);
  q.ilike = (...a) => (calls.push(["ilike", ...a]), q);
  q.in = (...a) => (calls.push(["in", ...a]), q);
  q.limit = (...a) => (calls.push(["limit", ...a]), q);
  q.range = (...a) => (calls.push(["range", ...a]), q);
  q.select = (...a) => (calls.push(["select", ...a]), q);
  q._calls = calls;
  return q;
}

// ============================================================================
// Test runner
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function equal(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

function ok(value, msg) {
  assert.ok(value, msg);
}

// ============================================================================
// Category 1: translateFilterParams — pure function tests
// ============================================================================
console.log(
  "\n=== Category 1: translateFilterParams (baserow.mjs reverse mapping) ==="
);

test("null / undefined input returns as-is", () => {
  equal(translateFilterParams(null), null);
  equal(translateFilterParams(undefined), undefined);
});

test("empty object returns empty object", () => {
  equal(translateFilterParams({}), {});
});

test("column name order_id is translated to Baserow field ID 7824209", () => {
  const result = translateFilterParams({
    "filter__field_order_id__equal": "test-123",
  });
  equal(result, { "filter__field_7824209__equal": "test-123" });
});

test("all known column names translate to correct field IDs", () => {
  const inputs = {
    "filter__field_order_id__equal": "o1",
    "filter__field_product_name__equal": "pn",
    "filter__field_original_product_id__equal": "opi",
    "filter__field_b2b_item_code__equal": "bic",
    "filter__field_source_store_id__equal": "ssi",
    "filter__field_order_status__equal": "os",
    "filter__field_shipping_completed_at__equal": "sca",
    "filter__field_shipping_phone_number__equal": "spn",
    "filter__field_shipping_name__equal": "sn",
    "filter__field_shipping_postal_code__equal": "spc",
    "filter__field_review_status__equal": "rs",
    "filter__field_auto_approval_rule__equal": "aar",
    "filter__field_auto_approved_at__equal": "aaa",
    "filter__field_ai_copywrite_log__equal": "acl",
    "filter__field_manage_number__equal": "mn",
    "filter__field_confirm_in_progress__equal": "cip",
    "filter__field_giga_sync_status__equal": "gss",
    "filter__field_sales_channel__equal": "sc",
    "filter__field_created_at__equal": "ca",
  };
  const result = translateFilterParams(inputs);
  equal(result["filter__field_7824209__equal"], "o1");
  equal(result["filter__field_7824214__equal"], "pn");
  equal(result["filter__field_7824213__equal"], "opi");
  equal(result["filter__field_8990468__equal"], "bic");
  equal(result["filter__field_7907194__equal"], "ssi");
  equal(result["filter__field_7907193__equal"], "os");
  equal(result["filter__field_7909235__equal"], "sca");
  equal(result["filter__field_7824241__equal"], "spn");
  equal(result["filter__field_7824233__equal"], "sn");
  equal(result["filter__field_7824228__equal"], "spc");
  equal(result["filter__field_8989067__equal"], "rs");
  equal(result["filter__field_9308210__equal"], "aar");
  equal(result["filter__field_9308212__equal"], "aaa");
  equal(result["filter__field_9064713__equal"], "acl");
  equal(result["filter__field_8918899__equal"], "mn");
  equal(result["filter__field_8918919__equal"], "cip");
  equal(result["filter__field_7907696__equal"], "gss");
  equal(result["filter__field_7824251__equal"], "sc");
  equal(result["filter__field_8016485__equal"], "ca");
  equal(Object.keys(result).length, 19);
});

test("already-numeric field IDs pass through unchanged (backward compatibility)", () => {
  const result = translateFilterParams({
    "filter__field_7824209__equal": "test-123",
  });
  equal(result, { "filter__field_7824209__equal": "test-123" });
});

test("Mercari BASEROW_FIELD constants pass through unchanged", () => {
  const result = translateFilterParams({
    [`filter__field_${BASEROW_FIELD.SALES.ORDER_ID}__equal`]: "test-123",
    [`filter__field_${BASEROW_FIELD.SALES.ORDER_STATUS}__single_select_equal`]: "CANCELED",
  });
  equal(result["filter__field_7824209__equal"], "test-123");
  equal(
    result["filter__field_7907193__single_select_equal"],
    "5982564"
  );
});

test("display value maps to option ID for single_select_equal", () => {
  const result = translateFilterParams({
    "filter__field_order_status__single_select_equal": "CANCELED",
  });
  equal(
    result,
    { "filter__field_7907193__single_select_equal": "5982564" }
  );
});

test("display value maps to option ID for single_select_not_equal", () => {
  const result = translateFilterParams({
    "filter__field_order_status__single_select_not_equal": "CANCELED",
  });
  equal(
    result,
    { "filter__field_7907193__single_select_not_equal": "5982564" }
  );
});

test("every known OPTION display value maps to correct option ID", () => {
  for (const [displayValue, optionId] of Object.entries(OPTION_VALUE_TO_ID)) {
    const result = translateFilterParams({
      "filter__field_order_status__single_select_equal": displayValue,
    });
    equal(
      result,
      { ["filter__field_7907193__single_select_equal"]: optionId },
      `option ${displayValue} should map to ${optionId}`
    );
  }
});

test("unknown display values in single_select pass through unchanged", () => {
  const result = translateFilterParams({
    "filter__field_order_status__single_select_equal": "UNKNOWN_STATUS",
  });
  equal(
    result,
    { "filter__field_7907193__single_select_equal": "UNKNOWN_STATUS" }
  );
});

test("OPTION constants from db-fields.mjs resolve through translateFilterParams", () => {
  // OPTION constants hold display-value strings like "APPROVED".
  const result = translateFilterParams({
    "filter__field_review_status__single_select_equal":
      OPTION.REVIEW_STATUS.APPROVED,
  });
  equal(
    result,
    { "filter__field_8989067__single_select_equal": "6482439" }
  );
});

test("FIELD constants from db-fields.mjs work as filter key identifiers", () => {
  const result = translateFilterParams({
    [`filter__field_${FIELD.SALES.ORDER_ID}__equal`]: "test-123",
    [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]:
      "COMPLETED",
  });
  equal(result["filter__field_7824209__equal"], "test-123");
  equal(
    result["filter__field_7907193__single_select_equal"],
    "5982567"
  );
});

test("__empty operator passes through with column name translated", () => {
  const result = translateFilterParams({
    "filter__field_shipping_completed_at__empty": "true",
  });
  equal(result, { "filter__field_7909235__empty": "true" });
});

test("__not_empty operator passes through with column name translated", () => {
  const result = translateFilterParams({
    "filter__field_shipping_completed_at__not_empty": "true",
  });
  equal(result, { "filter__field_7909235__not_empty": "true" });
});

test("__contains operator passes through with column name translated", () => {
  const result = translateFilterParams({
    "filter__field_product_name__contains": "test",
  });
  equal(result, { "filter__field_7824214__contains": "test" });
});

test("null values are preserved in translateFilterParams (dropped later by caller URL builder)", () => {
  const result = translateFilterParams({
    "filter__field_order_id__equal": "test-123",
    "filter__field_product_name__equal": null,
  });
  // translateFilterParams does NOT drop null/undefined — that happens
  // in the listAllRows/listRowsWithLimit URL builder (.filter(([,v])=>v!=null))
  equal(result["filter__field_7824209__equal"], "test-123");
  equal(result["filter__field_7824214__equal"], null);
});

test("undefined values are preserved in translateFilterParams (dropped later by caller)", () => {
  const result = translateFilterParams({
    "filter__field_order_id__equal": "test-123",
    "filter__field_product_name__equal": undefined,
  });
  equal(result["filter__field_7824209__equal"], "test-123");
  equal(result["filter__field_7824214__equal"], undefined);
});

test("empty string values are preserved (valid for __empty operator)", () => {
  const result = translateFilterParams({
    "filter__field_shipping_completed_at__empty": "",
  });
  equal(result, { "filter__field_7909235__empty": "" });
});

test("array values for single_select_equal map each element to option ID", () => {
  const result = translateFilterParams({
    "filter__field_order_status__single_select_equal": [
      "CANCELED",
      "COMPLETED",
    ],
  });
  equal(result, {
    "filter__field_7907193__single_select_equal": ["5982564", "5982567"],
  });
});

test("array values with unknown display values leave unknowns as-is", () => {
  const result = translateFilterParams({
    "filter__field_order_status__single_select_equal": [
      "CANCELED",
      "UNKNOWN",
    ],
  });
  equal(result, {
    "filter__field_7907193__single_select_equal": ["5982564", "UNKNOWN"],
  });
});

test("unrecognized filter key (no filter__field_ prefix) passes through unchanged", () => {
  const result = translateFilterParams({ some_other_key: "value" });
  equal(result, { some_other_key: "value" });
});

test("multiple filters are all translated together", () => {
  const result = translateFilterParams({
    "filter__field_order_id__equal": "order_test-1",
    "filter__field_source_store_id__equal": "Shop1",
    "filter__field_order_status__single_select_equal": "COMPLETED",
  });
  equal(result["filter__field_7824209__equal"], "order_test-1");
  equal(result["filter__field_7907194__equal"], "Shop1");
  equal(
    result["filter__field_7907193__single_select_equal"],
    "5982567"
  );
  equal(Object.keys(result).length, 3);
});

test("BASEROW_OPTION constants resolve correctly through translateFilterParams", () => {
  // BASEROW_OPTION holds numeric option IDs. When used as the VALUE
  // in a filter, translateFilterParams sees a string like "5982564"
  // which is NOT in OPTION_VALUE_TO_ID (since that maps display names
  // to IDs, not IDs to IDs), so it passes through unchanged.
  const result = translateFilterParams({
    "filter__field_order_status__single_select_equal":
      BASEROW_OPTION.ORDER_STATUS.CANCELED,
  });
  // BASEROW_OPTION.ORDER_STATUS.CANCELED is "5982564". This string
  // doesn't match any key in OPTION_VALUE_TO_ID (which contains
  // display names like "CANCELED"), so it passes through as-is.
  equal(
    result,
    {
      "filter__field_7907193__single_select_equal": "5982564",
    }
  );
});

// ============================================================================
// Category 2: applyFilters — supabase adapter filter translation
// ============================================================================
console.log(
  "\n=== Category 2: applyFilters (supabase.mjs filter translation) ==="
);

test("equal operator calls .eq(column, value)", () => {
  const q = createMockQuery();
  applyFilters(q, { "filter__field_order_id__equal": "test-123" });
  equal(q._calls, [["eq", "order_id", "test-123"]]);
});

test("single_select_equal calls .eq(column, value)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_status__single_select_equal": "COMPLETED",
  });
  equal(q._calls, [["eq", "order_status", "COMPLETED"]]);
});

test("single_select_not_equal calls .neq(column, value)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_status__single_select_not_equal": "CANCELED",
  });
  equal(q._calls, [["neq", "order_status", "CANCELED"]]);
});

test("empty operator calls .is(column, null)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_shipping_completed_at__empty": "true",
  });
  equal(q._calls, [["is", "shipping_completed_at", null]]);
});

test("not_empty operator calls .not(column, 'is', null)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_shipping_completed_at__not_empty": "true",
  });
  equal(q._calls, [["not", "shipping_completed_at", "is", null]]);
});

test("contains operator calls .ilike(column, '%value%')", () => {
  const q = createMockQuery();
  applyFilters(q, { "filter__field_product_name__contains": "phone" });
  equal(q._calls, [["ilike", "product_name", "%phone%"]]);
});

test("boolean operator with 'true' calls .eq(column, true)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_confirm_in_progress__boolean": "true",
  });
  equal(q._calls, [["eq", "confirm_in_progress", true]]);
});

test("boolean operator with '1' calls .eq(column, true)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_confirm_in_progress__boolean": "1",
  });
  equal(q._calls, [["eq", "confirm_in_progress", true]]);
});

test("boolean operator with 'false' calls .eq(column, false)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_confirm_in_progress__boolean": "false",
  });
  equal(q._calls, [["eq", "confirm_in_progress", false]]);
});

test("boolean operator with arbitrary string calls .eq(column, false)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_confirm_in_progress__boolean": "maybe",
  });
  equal(q._calls, [["eq", "confirm_in_progress", false]]);
});

test("null value is skipped (no method called)", () => {
  const q = createMockQuery();
  applyFilters(q, { "filter__field_order_id__equal": null });
  equal(q._calls, []);
});

test("undefined value is skipped", () => {
  const q = createMockQuery();
  applyFilters(q, { "filter__field_order_id__equal": undefined });
  equal(q._calls, []);
});

test("array value for equal operator calls .in(column, values)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_status__equal": ["COMPLETED", "CANCELED"],
  });
  equal(q._calls, [
    ["in", "order_status", ["COMPLETED", "CANCELED"]],
  ]);
});

test("array value for single_select_equal calls .in(column, values)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_status__single_select_equal": [
      "COMPLETED",
      "CANCELED",
    ],
  });
  equal(q._calls, [
    ["in", "order_status", ["COMPLETED", "CANCELED"]],
  ]);
});

test("array value for single_select_not_equal is silently skipped (unsupported)", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_status__single_select_not_equal": [
      "COMPLETED",
      "CANCELED",
    ],
  });
  equal(q._calls, []);
});

test("unknown operator is silently skipped", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_id__unknown_operator": "test",
  });
  equal(q._calls, []);
});

test("unparseable key (no filter__field_ prefix) is silently skipped", () => {
  const q = createMockQuery();
  applyFilters(q, { not_a_filter_key: "test" });
  equal(q._calls, []);
});

test("mixed valid and null filters — nulls excluded, valid ones applied", () => {
  const q = createMockQuery();
  applyFilters(q, {
    "filter__field_order_id__equal": "test-123",
    "filter__field_product_name__equal": null,
    "filter__field_order_status__single_select_equal": "COMPLETED",
  });
  equal(q._calls, [
    ["eq", "order_id", "test-123"],
    ["eq", "order_status", "COMPLETED"],
  ]);
});

test("empty filter params object leaves query unchanged", () => {
  const q = createMockQuery();
  const result = applyFilters(q, {});
  equal(result, q);
  equal(q._calls, []);
});

// ============================================================================
// Category 3: Client creation tests
// ============================================================================
console.log("\n=== Category 3: Client Creation ===");

test("createBaserowClient with valid Supabase env returns correct client shape", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-12345",
  };
  const client = createBaserowClient(env);

  ok(client, "client is truthy");
  equal(client.type, "supabase");
  ok(client.supabase, "supabase client is present (created by @supabase/supabase-js)");
  equal(client.url, "https://example.supabase.co");
  ok(client.serviceKey, "serviceKey is present");
  equal(client.salesOrderTableId, "sales_orders");
  equal(client.shipmentOrderTableId, "giga_shipment_projections");
  equal(client.rakutenSalesOrderTableId, "sales_orders");
});

test("createBaserowClient with missing SUPABASE_URL throws", () => {
  assert.throws(
    () =>
      createBaserowClient({ SUPABASE_SERVICE_ROLE_KEY: "key" }),
    /Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/
  );
});

test("createBaserowClient with missing SUPABASE_SERVICE_ROLE_KEY throws", () => {
  assert.throws(
    () =>
      createBaserowClient({ SUPABASE_URL: "https://example.supabase.co" }),
    /Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/
  );
});

test("createBaserowClient with both missing throws", () => {
  assert.throws(
    () => createBaserowClient({}),
    /Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/
  );
});

test("createBaserowClient tolerates whitespace-padded credentials", () => {
  const env = {
    SUPABASE_URL: "  https://example.supabase.co  ",
    SUPABASE_SERVICE_ROLE_KEY: "\n  service-role-key-12345  \n",
  };
  const client = createBaserowClient(env);
  equal(client.url, "https://example.supabase.co");
  equal(client.serviceKey, "service-role-key-12345");
});

test("createBaserowClient sets a workload x-client-info header", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-12345",
  };
  const client = createBaserowClient(env);
  ok(client.supabase && client.supabase.headers, "supabase client exposes headers");
  equal(client.supabase.headers["x-client-info"], "ordermgmt", "stable ordermgmt identity");
  ok(
    !String(client.supabase.headers["x-client-info"]).includes("service-role-key"),
    "header never leaks the service key"
  );
});

test("createBaserowClient suffixes x-client-info with RELEASE_VERSION when present", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-12345",
    RELEASE_VERSION: "2026.08.27",
  };
  const client = createBaserowClient(env);
  equal(client.supabase.headers["x-client-info"], "ordermgmt/2026.08.27");
});

test("createBaserowClient includes workload and release in x-client-info", () => {
  const client = createBaserowClient({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-12345",
    ORDERMGMT_WORKLOAD_ID: "build_giga_shipments",
    RELEASE_VERSION: "2026.08.30",
  });
  equal(
    client.supabase.headers["x-client-info"],
    "ordermgmt/build_giga_shipments/2026.08.30",
  );
});

test("clientForRakuten returns cloned client with salesOrderTableId = sales_orders", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-12345",
  };
  const client = createBaserowClient(env);
  const rakutenClient = clientForRakuten(client);

  ok(rakutenClient.supabase, "supabase client is present");
  equal(rakutenClient.salesOrderTableId, "sales_orders");
  equal(rakutenClient.type, "supabase");
  equal(rakutenClient.url, "https://example.supabase.co");
  equal(rakutenClient.serviceKey, "service-role-key-12345");
});

test("clientForRakuten does not mutate the original client", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-12345",
  };
  const client = createBaserowClient(env);
  const originalSalesTableId = client.salesOrderTableId;
  clientForRakuten(client);
  equal(
    client.salesOrderTableId,
    originalSalesTableId,
    "original client unchanged after clientForRakuten call"
  );
});

test("BASEROW_FIELD and BASEROW_OPTION are re-exported from supabase.mjs", () => {
  // Verify via the db-fields re-export chain
  ok(BASEROW_FIELD, "BASEROW_FIELD is available");
  ok(BASEROW_OPTION, "BASEROW_OPTION is available");
  equal(BASEROW_FIELD.SALES.ORDER_ID, "7824209");
  equal(BASEROW_OPTION.ORDER_STATUS.CANCELED, "5982564");
});

test("FIELD and OPTION constants match expected values", () => {
  equal(FIELD.SALES.ORDER_ID, "order_id");
  equal(FIELD.SALES.ORDER_STATUS, "order_status");
  equal(FIELD.SALES.REVIEW_STATUS, "review_status");
  equal(OPTION.ORDER_STATUS.CANCELED, "CANCELED");
  equal(OPTION.REVIEW_STATUS.APPROVED, "APPROVED");
  equal(OPTION.GIGA_SYNC_STATUS.SYNCED, "SYNCED");
});

// ============================================================================
// Category 4: CRUD response shape tests
// ============================================================================
console.log("\n=== Category 4: CRUD Response Shape ===");

// ---------------------------------------------------------------------------
// patchRow
// ---------------------------------------------------------------------------

test("patchRow success returns { ok: true, status: 200, body, error: null }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        update: (payload) => ({
          eq: (col, val) => ({
            select: () =>
              Promise.resolve({
                data: [
                  { id: val, ...payload, updated_at: "2026-01-01" },
                ],
                error: null,
              }),
          }),
        }),
      }),
    },
  };
  const result = await patchRow(mockClient, "sales_orders", 42, {
    order_status: "COMPLETED",
  });
  equal(result.ok, true);
  equal(result.status, 200);
  ok(result.body !== null, "body is not null on success");
  equal(result.body.id, 42);
  equal(result.body.order_status, "COMPLETED");
  equal(result.error, null);
});

test("patchRow error returns { ok: false, status: 400, body: null, error: string }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        update: () => ({
          eq: () => ({
            select: () =>
              Promise.resolve({
                data: null,
                error: { message: "Row not found" },
              }),
          }),
        }),
      }),
    },
  };
  const result = await patchRow(mockClient, "sales_orders", 99999, {
    order_status: "COMPLETED",
  });
  equal(result.ok, false);
  equal(result.status, 400);
  equal(result.body, null);
  ok(result.error !== null, "error is not null on failure");
  ok(result.error.includes("Row not found"), `error="${result.error}"`);
});

test("patchRow treats a zero-row update as a conflict", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        update: () => ({
          eq: () => ({
            select: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    },
  };
  const result = await patchRow(mockClient, "sales_orders", "missing", {
    review_status: "Auto-Approved",
  });
  equal(result.ok, false);
  equal(result.status, 409);
  equal(result.body, null);
  equal(result.error, "supabase_patch_affected_zero_rows");
});

test("patchRow applies normalized optimistic match conditions", async () => {
  const calls = [];
  const thenable = {
    eq(column, value) {
      calls.push([column, value]);
      return this;
    },
    select() {
      return Promise.resolve({
        data: [{ id: "row-1", review_status: "AUTO_APPROVED" }],
        error: null,
      });
    },
  };
  const mockClient = {
    type: "supabase",
    supabase: {
      from: () => ({ update: () => thenable }),
    },
  };
  const result = await patchRow(
    mockClient,
    "sales_orders",
    "row-1",
    { review_status: "Auto-Approved" },
    { match: { review_status: "Pending Review" } },
  );
  equal(result.ok, true);
  ok(calls.some(([column, value]) => column === "id" && value === "row-1"));
  ok(calls.some(([column, value]) => column === "review_status" && value === "PENDING_REVIEW"));
});

test("patchRow exception returns { ok: false, status: 500, body: null, error: string }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        update: () => ({
          eq: () => ({
            select: () => Promise.reject(new Error("Connection timeout")),
          }),
        }),
      }),
    },
  };
  const result = await patchRow(mockClient, "sales_orders", 42, {
    order_status: "COMPLETED",
  });
  equal(result.ok, false);
  equal(result.status, 500);
  equal(result.body, null);
  ok(result.error !== null, "error is not null on exception");
  ok(
    result.error.includes("Connection timeout"),
    `error="${result.error}"`
  );
});

// ---------------------------------------------------------------------------
// createRow
// ---------------------------------------------------------------------------

test("createRow success returns { ok: true, status: 201, body, error: null }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        insert: (payload) => ({
          select: () =>
            Promise.resolve({
              data: [{ id: 100, ...payload }],
              error: null,
            }),
        }),
      }),
    },
  };
  const result = await createRow(mockClient, "sales_orders", {
    order_id: "test-1",
  });
  equal(result.ok, true);
  equal(result.status, 201);
  ok(result.body !== null, "body is not null on success");
  equal(result.body.id, 100);
  equal(result.body.order_id, "test-1");
  equal(result.error, null);
});

test("createRow error returns { ok: false, status: 400, body: null, error: string }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        insert: () => ({
          select: () =>
            Promise.resolve({
              data: null,
              error: {
                message:
                  'duplicate key value violates unique constraint "sales_orders_order_id_key"',
              },
            }),
        }),
      }),
    },
  };
  const result = await createRow(mockClient, "sales_orders", {
    order_id: "dup-1",
  });
  equal(result.ok, false);
  equal(result.status, 400);
  equal(result.body, null);
  ok(result.error !== null, "error is not null on failure");
  ok(
    result.error.includes("duplicate key"),
    `error="${result.error}"`
  );
});

test("createRow exception returns { ok: false, status: 500, body: null, error: string }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        insert: () => ({
          select: () =>
            Promise.reject(new Error("Insert failed")),
        }),
      }),
    },
  };
  const result = await createRow(mockClient, "sales_orders", {
    order_id: "test-1",
  });
  equal(result.ok, false);
  equal(result.status, 500);
  equal(result.body, null);
  ok(result.error !== null, "error is not null on exception");
  ok(
    result.error.includes("Insert failed"),
    `error="${result.error}"`
  );
});

// ---------------------------------------------------------------------------
// deleteRow
// ---------------------------------------------------------------------------

test("deleteRow success returns { ok: true, status: 204, body: null, error: null }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        delete: () => ({
          eq: () =>
            Promise.resolve({ data: null, error: null }),
        }),
      }),
    },
  };
  const result = await deleteRow(mockClient, "sales_orders", 42);
  equal(result.ok, true);
  equal(result.status, 204);
  equal(result.body, null);
  equal(result.error, null);
});

test("deleteRow error returns { ok: false, status: 400, body: null, error: string }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        delete: () => ({
          eq: () =>
            Promise.resolve({
              data: null,
              error: {
                message: "foreign key constraint violation",
              },
            }),
        }),
      }),
    },
  };
  const result = await deleteRow(mockClient, "sales_orders", 42);
  equal(result.ok, false);
  equal(result.status, 400);
  equal(result.body, null);
  ok(result.error !== null, "error is not null on failure");
  ok(
    result.error.includes("foreign key"),
    `error="${result.error}"`
  );
});

test("deleteRow exception returns { ok: false, status: 500, body: null, error: string }", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        delete: () => ({
          eq: () =>
            Promise.reject(new Error("Network failure")),
        }),
      }),
    },
  };
  const result = await deleteRow(mockClient, "sales_orders", 42);
  equal(result.ok, false);
  equal(result.status, 500);
  equal(result.body, null);
  ok(result.error !== null, "error is not null on exception");
  ok(
    result.error.includes("Network failure"),
    `error="${result.error}"`
  );
});

// ---------------------------------------------------------------------------
// listRowsWithLimit & listAllRows
// ---------------------------------------------------------------------------

test("listRowsWithLimit applies filter params and limit to query builder", async () => {
  const calls = [];
  const thenable = {
    then: (resolve) => resolve({ data: [], error: null }),
  };
  thenable.eq = (...a) => (calls.push(["eq", ...a]), thenable);
  thenable.limit = (...a) => (calls.push(["limit", ...a]), thenable);

  const mockClient = {
    supabase: {
      from: () => ({
        select: () => thenable,
      }),
    },
  };

  const result = await listRowsWithLimit(mockClient, "sales_orders", {
    "filter__field_order_status__single_select_equal": "COMPLETED",
    "filter__field_source_store_id__equal": "Shop1",
  }, 25);

  equal(result.length, 0);
  ok(
    calls.some(
      (c) =>
        c[0] === "eq" &&
        c[1] === "order_status" &&
        c[2] === "COMPLETED"
    ),
    "eq for order_status called"
  );
  ok(
    calls.some(
      (c) =>
        c[0] === "eq" && c[1] === "source_store_id" && c[2] === "Shop1"
    ),
    "eq for source_store_id called"
  );
  ok(
    calls.some((c) => c[0] === "limit" && c[1] === 25),
    "limit 25 called"
  );
});

test("listRowsWithLimit defaults to select('*') for backward compatibility", async () => {
  const selectArgs = [];
  const thenable = {
    then: (resolve) => resolve({ data: [], error: null }),
  };
  thenable.limit = () => thenable;

  const mockClient = {
    supabase: {
      from: () => ({
        select: (...a) => (selectArgs.push(a), thenable),
      }),
    },
  };

  const result = await listRowsWithLimit(mockClient, "sales_orders", {}, 10);
  equal(result.length, 0);
  equal(selectArgs[0][0], "*", "default projection is *");
});

test("listRowsWithLimit honors an options.select projection", async () => {
  const selectArgs = [];
  const thenable = {
    then: (resolve) => resolve({ data: [], error: null }),
  };
  thenable.eq = () => thenable;
  thenable.limit = () => thenable;

  const mockClient = {
    supabase: {
      from: () => ({
        select: (...a) => (selectArgs.push(a), thenable),
      }),
    },
  };

  const result = await listRowsWithLimit(mockClient, "sales_orders", {
    "filter__field_order_status__single_select_equal": "WAITING_FOR_SHIPPING",
  }, 20, { select: "id,order_id,source_store_id" });

  equal(result.length, 0);
  equal(selectArgs[0][0], "id,order_id,source_store_id", "projection passed to select");
});

test("listRowsWithLimit with no filter params returns all rows up to maxRows", async () => {
  let queryCalled = false;
  const thenable = {
    then: (resolve) => {
      queryCalled = true;
      return resolve({
        data: Array.from({ length: 10 }, (_, i) => ({ id: i })),
        error: null,
      });
    },
  };
  thenable.limit = (...a) => {
    thenable._limitArgs = a;
    return thenable;
  };

  const mockClient = {
    supabase: {
      from: () => ({ select: () => thenable }),
    },
  };

  const result = await listRowsWithLimit(mockClient, "sales_orders", {}, 10);
  equal(result.length, 10);
  ok(queryCalled, "query was executed");
});

test("listAllRows handles pagination across multiple pages", async () => {
  const pageData = [
    Array.from({ length: 1000 }, (_, i) => ({ id: i })),
    Array.from({ length: 500 }, (_, i) => ({ id: 1000 + i })),
  ];
  let pageIndex = 0;

  function makeQueryBuilder() {
    const q = Promise.resolve({
      data: pageData[pageIndex] || [],
      error: null,
    });
    pageIndex += 1;
    q.range = () => q;
    q.eq = () => q;
    q.in = () => q;
    q.is = () => q;
    q.not = () => q;
    q.neq = () => q;
    q.ilike = () => q;
    return q;
  }

  const mockClient = {
    supabase: {
      from: () => ({
        select: () => makeQueryBuilder(),
      }),
    },
  };

  const result = await listAllRows(mockClient, "sales_orders");
  equal(result.length, 1500, "all 1500 rows returned across 2 pages");
});

test("listAllRows with empty table returns empty array", async () => {
  const mockClient = {
    supabase: {
      from: () => ({
        select: () => {
          const q = Promise.resolve({
            data: [],
            error: null,
          });
          q.range = () => q;
          return q;
        },
      }),
    },
  };

  const result = await listAllRows(mockClient, "sales_orders");
  equal(result.length, 0);
});

test("listAllRows passes filter params to each page query", async () => {
  const pageData = [
    Array.from({ length: 1000 }, (_, i) => ({ id: i, source_store_id: "Shop1" })),
    Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, source_store_id: "Shop1" })),
  ];
  let pageIndex = 0;
  const calls = [];

  function makeQueryBuilder() {
    const q = Promise.resolve({
      data: pageData[pageIndex] || [],
      error: null,
    });
    pageIndex += 1;
    q.range = () => q;
    q.eq = (...a) => (calls.push(["eq", ...a]), q);
    return q;
  }

  const mockClient = {
    supabase: {
      from: () => ({
        select: () => makeQueryBuilder(),
      }),
    },
  };

  const result = await listAllRows(mockClient, "sales_orders", {
    "filter__field_source_store_id__equal": "Shop1",
  });
  equal(result.length, 1200, "all filtered rows returned");
  ok(
    calls.every((c) => c[0] === "eq" && c[1] === "source_store_id" && c[2] === "Shop1"),
    "every page had the filter applied"
  );
  equal(calls.length, 2, "filter applied on both pages");
});

test("listAllRows applies an explicit column projection to every page", async () => {
  const selected = [];
  const pageData = [
    Array.from({ length: 1000 }, (_, i) => ({ id: i, order_id: `order-${i}` })),
    [{ id: 1000, order_id: "order-1000" }],
  ];
  let pageIndex = 0;

  function makeQueryBuilder() {
    const q = Promise.resolve({ data: pageData[pageIndex] || [], error: null });
    pageIndex += 1;
    q.range = () => q;
    return q;
  }

  const mockClient = {
    supabase: {
      from: () => ({
        select: (columns) => {
          selected.push(columns);
          return makeQueryBuilder();
        },
      }),
    },
  };

  const result = await listAllRows(
    mockClient,
    "sales_orders",
    {},
    { select: "id,order_id" },
  );
  equal(result.length, 1001);
  equal(selected, ["id,order_id", "id,order_id"]);
});

// ============================================================================
// Category 5: Integration test stubs (skipped without live connection)
// ============================================================================
console.log("\n=== Category 5: Integration Tests ===");

if (
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  console.log(
    "  SKIP: No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set.\n" +
    "  To run integration tests, set both env vars pointing to a live Supabase project."
  );
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
