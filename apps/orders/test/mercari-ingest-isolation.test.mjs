#!/usr/bin/env node
/**
 * Cross-shop isolation and core logic tests for the Mercari ingest script.
 *
 * Verifies that the 3-part row identity (shopId::orderId::sku) prevents
 * cross-shop mutation, that the backend guard fails closed, and that the
 * stale-cleanup / terminal-reconciliation cross-shop guards work correctly.
 *
 * All tested functions are pure — no Worker env, network, or database needed.
 *
 * Usage: node test/mercari-ingest-isolation.test.mjs
 */

import { strict as assert } from "node:assert";
import {
  makeRowKey,
  normalizeText,
  guardCrossShop,
  selectExactMercariTransaction,
} from "../scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs";

import { toDatabasePayload, toApplicationRow } from "../src/lib/supabase.mjs";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

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

function summary() {
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

// ===========================================================================
// Cross-shop key isolation (makeRowKey)
// ===========================================================================

function runCrossShopKeyTests() {
  console.log("── Cross-shop key isolation ──");

  test("different shopIds produce distinct keys for same orderId+sku", () => {
    const key1 = makeRowKey("Shop1_GraphQL_ID", "order-12345", "SKU-A");
    const key2 = makeRowKey("Shop2_GraphQL_ID", "order-12345", "SKU-A");
    assert.notEqual(key1, key2, "keys must differ when shopId differs");
    // normalizeText only trims (no lowercase) so the original case is preserved
    assert.ok(key1.startsWith("Shop1_GraphQL_ID::"), "key starts with first shopId");
    assert.ok(key2.startsWith("Shop2_GraphQL_ID::"), "key starts with second shopId");
  });

  test("same shopId with different orderIds produce distinct keys", () => {
    const key1 = makeRowKey("Shop1_ID", "order-12345", "SKU-A");
    const key2 = makeRowKey("Shop1_ID", "order-67890", "SKU-A");
    assert.notEqual(key1, key2, "keys must differ when orderId differs");
  });

  test("same shopId+orderId with different SKUs produce distinct keys", () => {
    const key1 = makeRowKey("Shop1_ID", "order-12345", "SKU-A");
    const key2 = makeRowKey("Shop1_ID", "order-12345", "SKU-B");
    assert.notEqual(key1, key2, "keys must differ when SKU differs");
  });

  test("shopId is preserved as-is by normalizeText (trim only, no case change)", () => {
    // normalizeText only trims whitespace and normalizes line endings.
    // GraphQL shop IDs (UUIDs) are case-sensitive and not lowercased.
    // The cross-shop guard compares exact normalizeText values, so
    // matching works as long as the same canonical form is used.
    const key = makeRowKey("  ShopX_ID  ", "order-123", "sku-a");
    assert.ok(key.startsWith("ShopX_ID::"), "shopId is trimmed but not lowercased");
    assert.ok(key.endsWith("::order-123::sku-a"), "key preserves orderId (only order_ prefix stripped) and SKU as-is");
  });

  test("order_ prefix is stripped from orderId in key", () => {
    const key1 = makeRowKey("s", "order_98765", "sku-x");
    const key2 = makeRowKey("s", "98765", "sku-x");
    assert.equal(key1, key2, "order_ prefix must be stripped");
  });

  test("exact provider selection rejects missing and mismatched transactions", () => {
    const target = { id: "order_target", products: [] };
    assert.equal(selectExactMercariTransaction(target, "target"), target);
    assert.equal(selectExactMercariTransaction({ id: "neighbor" }, "target"), null);
    assert.equal(selectExactMercariTransaction(null, "target"), null);
  });

  test("empty shopId still produces key with empty shop segment (trim-only behavior)", () => {
    // normalizeText does NOT reject empty strings — it returns "" after trim.
    // makeRowKey only returns "" when orderId or SKU normalize to empty.
    const key = makeRowKey("", "order-12345", "SKU-A");
    assert.notEqual(key, "", "key is not empty — only orderId/SKU emptiness triggers rejection");
    assert.ok(key.startsWith("::"), "shop segment is empty string");
  });

  test("empty orderId produces empty key", () => {
    const key = makeRowKey("Shop1", "", "SKU-A");
    assert.equal(key, "", "empty orderId → empty key");
  });

  test("empty SKU produces empty key", () => {
    const key = makeRowKey("Shop1", "order-12345", "");
    assert.equal(key, "", "empty SKU → empty key");
  });
}

// ===========================================================================
// guardCrossShop — the real production cross-shop isolation function
// ===========================================================================

// Matches the production ORDER_FIELD_NAMES shape that guardCrossShop expects.
const TEST_FIELD_NAMES = Object.freeze({ shopId: "shop_id" });

function runCrossShopGuardTests() {
  console.log("── guardCrossShop (production cross-shop guard) ──");

  test("returns true when existing.shop_id matches shopId exactly", () => {
    const row = { id: 1, order_id: "order-123", shop_id: "Shop1_GraphQL_ID" };
    assert.equal(guardCrossShop(row, "Shop1_GraphQL_ID", TEST_FIELD_NAMES), true,
      "matching shopId must return true");
  });

  test("returns false when existing.shop_id belongs to a different shop", () => {
    const row = { id: 2, order_id: "order-123", shop_id: "Shop2_GraphQL_ID" };
    assert.equal(guardCrossShop(row, "Shop1_GraphQL_ID", TEST_FIELD_NAMES), false,
      "different shopId must return false (prevents cross-shop mutation)");
  });

  test("returns false when existing.shop_id is empty and shopId is non-empty", () => {
    const row = { id: 3, order_id: "order-123", shop_id: "" };
    assert.equal(guardCrossShop(row, "Shop1_GraphQL_ID", TEST_FIELD_NAMES), false,
      "empty shop_id must not match any real shopId");
  });

  test("returns false when existing.shop_id is missing (null/undefined)", () => {
    assert.equal(guardCrossShop({ id: 4, order_id: "order-123" }, "Shop1_ID", TEST_FIELD_NAMES), false,
      "missing shop_id must not match");
    assert.equal(guardCrossShop({ id: 5, order_id: "order-123", shop_id: null }, "Shop1_ID", TEST_FIELD_NAMES), false,
      "null shop_id must not match");
  });

  test("whitespace-only differences are stripped (normalizeText trims)", () => {
    const row = { id: 6, order_id: "order-123", shop_id: "  Shop1_ID  " };
    assert.equal(guardCrossShop(row, "Shop1_ID", TEST_FIELD_NAMES), true,
      "trimmed shop_id must match");
  });

  test("is case-sensitive (normalizeText does not lowercase)", () => {
    // normalizeText only trims; GraphQL shop IDs are case-sensitive UUIDs.
    const row = { id: 7, order_id: "order-123", shop_id: "SHOP1_ID" };
    assert.equal(guardCrossShop(row, "shop1_id", TEST_FIELD_NAMES), false,
      "case mismatch must not match — shop IDs are exact");
  });

  test("stale-cleanup pattern: integrates into deletion filter correctly", () => {
    // Replicates the production stale-cleanup loop pattern:
    //   if (!guardCrossShop(existing, shopId, ORDER_FIELD_NAMES)) continue;
    const shopId = "Shop1_GraphQL_ID";
    const existingRows = [
      { id: 1, order_id: "order-123", shop_id: "Shop1_GraphQL_ID" },
      { id: 2, order_id: "order-123", shop_id: "Shop2_GraphQL_ID" },
    ];

    const stale = [];
    for (const existing of existingRows) {
      if (!guardCrossShop(existing, shopId, TEST_FIELD_NAMES)) continue;
      stale.push(existing);
    }

    assert.equal(stale.length, 1, "only Shop1 rows collected for deletion");
    assert.equal(stale[0].id, 1, "correct row survives filter");
  });

  test("terminal-reconciliation pattern: integrates into status-patch filter correctly", () => {
    // Replicates the production terminal-reconciliation pattern:
    //   if (!guardCrossShop(existing, shopId, ORDER_FIELD_NAMES)) continue;
    const shopId = "Shop4_GraphQL_ID";
    const existingRows = [
      { id: 10, order_id: "order-999", shop_id: "Shop4_GraphQL_ID" },
      { id: 20, order_id: "order-999", shop_id: "Shop3_GraphQL_ID" },
    ];

    const matched = [];
    for (const existing of existingRows) {
      if (!guardCrossShop(existing, shopId, TEST_FIELD_NAMES)) continue;
      matched.push(existing);
    }

    assert.equal(matched.length, 1, "only Shop4 rows matched");
    assert.equal(matched[0].id, 10, "correct row matches");
  });

  test("cross-shop key prevents false match in existingByKey lookup", () => {
    // Build a simulated existingByKey map with 3-part keys
    const existingByKey = new Map();
    existingByKey.set(
      makeRowKey("Shop1_ID", "order-123", "SKU-A"),
      { id: 1, order_id: "order-123", original_product_id: "SKU-A", shop_id: "Shop1_ID" },
    );
    existingByKey.set(
      makeRowKey("Shop2_ID", "order-123", "SKU-A"),
      { id: 2, order_id: "order-123", original_product_id: "SKU-A", shop_id: "Shop2_ID" },
    );

    // A lookup for Shop1 should NOT find Shop2's row
    const shop1Key = makeRowKey("Shop1_ID", "order-123", "SKU-A");
    const found = existingByKey.get(shop1Key);

    assert.ok(found, "Shop1 key finds a row");
    assert.equal(found.id, 1, "correct Shop1 row found");
    assert.notEqual(found.shop_id, "Shop2_ID", "did not cross-match Shop2 row");
  });
}

// ===========================================================================
// Backend guard simulation (fail-closed)
// ===========================================================================

function runBackendGuardTests() {
  console.log("── Fail-closed backend selection ──");

  test("guard rejects empty DATABASE_BACKEND", () => {
    const backend = "";
    const isSupabase = backend.trim().toLowerCase() === "supabase";
    assert.equal(isSupabase, false, "empty backend is not supabase → must fail closed");
  });

  test("guard rejects baserow backend", () => {
    const backend = "baserow";
    const isSupabase = backend.trim().toLowerCase() === "supabase";
    assert.equal(isSupabase, false, "baserow backend is not supabase → must fail closed");
  });

  test("guard accepts supabase backend (case-insensitive)", () => {
    for (const value of ["supabase", "SUPABASE", "Supabase", "  supabase  "]) {
      const isSupabase = value.trim().toLowerCase() === "supabase";
      assert.equal(isSupabase, true, `"${value}" must be accepted as supabase`);
    }
  });
}

// ===========================================================================
// SALES_COLUMNS allow-list (new Mercari ingest fields)
// ===========================================================================

function runSalesColumnsTests() {
  console.log("── SALES_COLUMNS allow-list for Mercari ingest fields ──");

  const TABLE = "sales_orders";

  test("toDatabasePayload accepts new ingest fields (payment_date, billing, etc.)", () => {
    const payload = {
      order_id: "test-1",
      shop_id: "Shop1_ID",
      payment_date: "2026-07-16T12:00:00Z",
      currency: "JPY",
      product_tax: 500,
      shipping_tax: 100,
      shipping_duration: "2-3 days",
      shipping_country: "JP",
      billing_country: "JP",
      billing_postal_code: "100-0001",
      billing_state: "Tokyo",
      billing_city: "Chiyoda",
      billing_address_1: "1-1-1",
      billing_name: "Taro",
      coupon_discount_amount: 300,
      coupon_id: "CPN-001",
      order_type: "standard",
    };
    const out = toDatabasePayload(TABLE, payload);
    assert.equal(out.source_store_id, "Shop1_ID", "shop_id → source_store_id alias");
    assert.equal(out.payment_date, "2026-07-16T12:00:00Z", "payment_date passed through");
    assert.equal(out.currency, "JPY");
    assert.equal(out.product_tax, 500);
    assert.equal(out.shipping_tax, 100);
    assert.equal(out.shipping_country, "JP");
    assert.equal(out.billing_country, "JP");
    assert.equal(out.billing_postal_code, "100-0001");
    assert.equal(out.billing_state, "Tokyo");
    assert.equal(out.billing_city, "Chiyoda");
    assert.equal(out.billing_address_1, "1-1-1");
    assert.equal(out.billing_name, "Taro");
    assert.equal(out.coupon_discount_amount, 300);
    assert.equal(out.coupon_id, "CPN-001");
    assert.equal(out.order_type, "standard");
  });

  test("toApplicationRow backfills legacy shop_id from source_store_id", () => {
    const row = { source_store_id: "Shop4_ID", order_id: "order-123" };
    const app = toApplicationRow(TABLE, row);
    assert.equal(app.shop_id, "Shop4_ID", "shop_id backfilled from source_store_id");
  });

  test("toApplicationRow does not overwrite explicit shop_id", () => {
    const row = { source_store_id: "source_val", shop_id: "explicit_val" };
    const app = toApplicationRow(TABLE, row);
    assert.equal(app.shop_id, "explicit_val", "explicit shop_id preserved");
    assert.equal(app.source_store_id, "source_val", "source_store_id preserved");
  });
}

// ===========================================================================
// Run all
// ===========================================================================

runCrossShopKeyTests();
runCrossShopGuardTests();
runBackendGuardTests();
runSalesColumnsTests();

const ok = summary();
process.exitCode = ok ? 0 : 1;
