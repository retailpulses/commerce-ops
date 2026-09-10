#!/usr/bin/env node
/**
 * Unit tests for buyer-message field alias contract between supabase.mjs
 * and buyer-messages.mjs.
 *
 * Verifies that toApplicationRow, toDatabasePayload, classifyUnreadStatus,
 * and extractBuyerMessageFacts correctly handle the buyer-message field
 * namespace (has_buyer_messages, latest_buyer_message_*, etc.) through
 * the SALES_ALIASES mapping and SALES_COLUMNS filtering layer.
 *
 * These are all pure functions — no Worker env, network, or Baserow needed.
 *
 * Usage: node test/buyer-message-supabase-alias.test.mjs
 */

import { strict as assert } from "node:assert";
import { toApplicationRow, toDatabasePayload } from "../src/lib/supabase.mjs";
import { classifyUnreadStatus, extractBuyerMessageFacts } from "../src/lib/buyer-messages.mjs";

// ---------------------------------------------------------------------------
// Test runner (matching tracking-reconciler.test.mjs style)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
  }
}

// ===========================================================================
// Category 1: toApplicationRow — DB row → application object
// ===========================================================================

{
  const TABLE = "sales_orders";

  test("toApplicationRow populates has_buyer_messages from has_unread_messages", () => {
    const row = {
      order_id: "test-1",
      has_unread_messages: true,
      latest_buyer_message_id: "m2",
      last_message_at: "2024-06-01T10:00:00Z",
    };
    const out = toApplicationRow(TABLE, row);
    // SALES_ALIASES has_buyer_messages → has_unread_messages should fill
    // the app-side key when the DB column is present.
    assert.equal(out.has_buyer_messages, true, "has_buyer_messages populated from has_unread_messages");
    assert.equal(out.has_unread_messages, true, "original has_unread_messages preserved");
  });

  test("toApplicationRow passes through latest_buyer_message_id unchanged", () => {
    const row = {
      order_id: "test-2",
      latest_buyer_message_id: "msg_abc123",
      has_unread_messages: false,
    };
    const out = toApplicationRow(TABLE, row);
    // No alias for latest_buyer_message_id — spread operator carries it
    assert.equal(out.latest_buyer_message_id, "msg_abc123");
  });

  test("toApplicationRow populates latest_buyer_message_at from last_message_at", () => {
    const row = {
      order_id: "test-3",
      last_message_at: "2024-06-01T10:00:00Z",
      // latest_buyer_message_at deliberately omitted — should be populated
      // via alias or spread-based fallback
    };
    const out = toApplicationRow(TABLE, row);
    assert.equal(out.latest_buyer_message_at, "2024-06-01T10:00:00Z");
  });

  test("toApplicationRow passes through message_last_synced_at unchanged", () => {
    const row = {
      order_id: "test-4",
      message_last_synced_at: "2024-06-01T10:00:00Z",
      has_unread_messages: false,
    };
    const out = toApplicationRow(TABLE, row);
    // message_last_synced_at has no alias — spread operator carries it
    assert.equal(out.message_last_synced_at, "2024-06-01T10:00:00Z");
  });
}

// ===========================================================================
// Category 2: toDatabasePayload — application object → DB payload
// ===========================================================================

{
  const TABLE = "sales_orders";

  test("toDatabasePayload translates has_buyer_messages → has_unread_messages", () => {
    const payload = {
      has_buyer_messages: true,
      order_id: "test-1",
    };
    const out = toDatabasePayload(TABLE, payload);
    // SALES_ALIASES has_buyer_messages → has_unread_messages should translate
    // the app-side key to the DB column name.
    assert.equal(out.has_unread_messages, true);
    assert.equal(out.has_buyer_messages, undefined, "app-side key removed from DB payload");
  });

  test("toDatabasePayload translates latest_buyer_message_at → last_message_at", () => {
    const payload = {
      latest_buyer_message_at: "2024-06-01T10:00:00Z",
      order_id: "test-1",
    };
    const out = toDatabasePayload(TABLE, payload);
    // Requires alias latest_buyer_message_at → last_message_at in
    // SALES_ALIASES (last_message_at is already in SALES_COLUMNS).
    assert.equal(out.last_message_at, "2024-06-01T10:00:00Z");
    assert.equal(out.latest_buyer_message_at, undefined, "app-side key removed from DB payload");
  });

  test("toDatabasePayload passes through latest_buyer_message_id and message_last_synced_at", () => {
    const payload = {
      latest_buyer_message_id: "msg_abc123",
      message_last_synced_at: "2024-06-01T10:00:00Z",
      order_id: "test-1",
    };
    const out = toDatabasePayload(TABLE, payload);
    // These columns need to be present in SALES_COLUMNS (or have aliases
    // that resolve to entries in SALES_COLUMNS) to survive the filter.
    assert.equal(out.latest_buyer_message_id, "msg_abc123");
    assert.equal(out.message_last_synced_at, "2024-06-01T10:00:00Z");
  });

  test("toDatabasePayload drops unknown columns", () => {
    const payload = {
      has_buyer_messages: true,
      unknown_field_xyz: "should be dropped",
      another_bogus_key: 42,
    };
    const out = toDatabasePayload(TABLE, payload);
    // SALES_COLUMNS filtering ensures only recognized columns survive.
    assert.equal(Object.keys(out).length, 1, "only has_unread_messages should survive");
    assert.equal(out.has_unread_messages, true);
    assert.equal(out.unknown_field_xyz, undefined);
    assert.equal(out.another_bogus_key, undefined);
  });

  test("toDatabasePayload accepts and passes through new Mercari ingest fields", () => {
    const payload = {
      order_id: "ingest-test-1",
      payment_date: "2026-07-16T12:00:00Z",
      currency: "JPY",
      product_tax: 500.00,
      shipping_tax: 100.00,
      shipping_duration: "2-3 days",
      shipping_country: "JP",
      billing_country: "JP",
      billing_postal_code: "100-0001",
      billing_state: "Tokyo",
      billing_city: "Chiyoda",
      billing_address_1: "1-1-1 Marunouchi",
      billing_address_2: "Bldg 2F",
      billing_name: "Taro Yamada",
      coupon_discount_amount: 300.00,
      coupon_id: "CPN-001",
      order_type: "standard",
    };
    const out = toDatabasePayload(TABLE, payload);
    assert.equal(out.payment_date, "2026-07-16T12:00:00Z", "payment_date passed through");
    assert.equal(out.currency, "JPY", "currency passed through");
    assert.equal(out.product_tax, 500.00, "product_tax passed through");
    assert.equal(out.shipping_tax, 100.00, "shipping_tax passed through");
    assert.equal(out.shipping_duration, "2-3 days", "shipping_duration passed through");
    assert.equal(out.shipping_country, "JP", "shipping_country passed through");
    assert.equal(out.billing_country, "JP", "billing_country passed through");
    assert.equal(out.billing_postal_code, "100-0001", "billing_postal_code passed through");
    assert.equal(out.billing_state, "Tokyo", "billing_state passed through");
    assert.equal(out.billing_city, "Chiyoda", "billing_city passed through");
    assert.equal(out.billing_address_1, "1-1-1 Marunouchi", "billing_address_1 passed through");
    assert.equal(out.billing_address_2, "Bldg 2F", "billing_address_2 passed through");
    assert.equal(out.billing_name, "Taro Yamada", "billing_name passed through");
    assert.equal(out.coupon_discount_amount, 300.00, "coupon_discount_amount passed through");
    assert.equal(out.coupon_id, "CPN-001", "coupon_id passed through");
    assert.equal(out.order_type, "standard", "order_type passed through");
  });

  test("toDatabasePayload handles null values for new ingest fields", () => {
    const payload = {
      order_id: "ingest-null-1",
      payment_date: null,
      currency: null,
      product_tax: null,
      shipping_tax: null,
      shipping_duration: null,
      shipping_country: null,
      billing_country: null,
      billing_postal_code: null,
      billing_state: null,
      billing_city: null,
      billing_address_1: null,
      billing_address_2: null,
      billing_name: null,
      coupon_discount_amount: null,
      coupon_id: null,
      order_type: null,
    };
    const out = toDatabasePayload(TABLE, payload);
    assert.equal(out.order_id, "ingest-null-1", "order_id still passes through");
    assert.equal(out.payment_date, null, "payment_date null accepted");
    assert.equal(out.currency, null, "currency null accepted");
    assert.equal(out.product_tax, null, "product_tax null accepted");
    assert.equal(out.shipping_tax, null, "shipping_tax null accepted");
    assert.equal(out.shipping_duration, null, "shipping_duration null accepted");
    assert.equal(out.shipping_country, null, "shipping_country null accepted");
    assert.equal(out.billing_country, null, "billing_country null accepted");
    assert.equal(out.billing_postal_code, null, "billing_postal_code null accepted");
    assert.equal(out.billing_state, null, "billing_state null accepted");
    assert.equal(out.billing_city, null, "billing_city null accepted");
    assert.equal(out.billing_address_1, null, "billing_address_1 null accepted");
    assert.equal(out.billing_address_2, null, "billing_address_2 null accepted");
    assert.equal(out.billing_name, null, "billing_name null accepted");
    assert.equal(out.coupon_discount_amount, null, "coupon_discount_amount null accepted");
    assert.equal(out.coupon_id, null, "coupon_id null accepted");
    assert.equal(out.order_type, null, "order_type null accepted");
  });
}

// ===========================================================================
// Category 3: classifyUnreadStatus — buyer message read-state
// ===========================================================================

test("classifyUnreadStatus returns unread when has_buyer_messages=true and latest_buyer_message_id differs from last_read_message_id", () => {
  const row = {
    has_buyer_messages: true,
    latest_buyer_message_id: "msg_2",
    latest_buyer_message_at: "2024-06-01T10:00:00Z",
  };
  const kvReadState = { last_read_message_id: "msg_1" };
  const result = classifyUnreadStatus(row, kvReadState);

  assert.deepEqual(result, { classification: "unread", has_unread: true });
});

test("classifyUnreadStatus returns read when has_buyer_messages=false and no KV state issues", () => {
  const now = new Date().toISOString();
  const row = {
    has_buyer_messages: false,
    message_last_synced_at: now,
  };
  const kvReadState = {
    last_read_message_id: "msg_1",
    last_check_status: "ok",
    last_checked_at: now,
  };
  const result = classifyUnreadStatus(row, kvReadState);

  // false + no staleness + healthy KV = read
  assert.deepEqual(result, { classification: "read", has_unread: false });
});

// ===========================================================================
// Category 4: extractBuyerMessageFacts — unchanged message processing
// ===========================================================================

test("extractBuyerMessageFacts returns latest buyer message info when buyer messages present", () => {
  const messages = [
    { role: "SELLER", id: "m1", createdAt: "2024-06-01T09:00:00Z", text: "seller message" },
    { role: "BUYER", id: "m2", createdAt: "2024-06-01T10:00:00Z", text: "first buyer message" },
    { role: "BUYER", id: "m3", createdAt: "2024-06-01T11:00:00Z", text: "latest buyer message" },
    { role: "SYSTEM", id: "m4", text: "system message" },
  ];
  const result = extractBuyerMessageFacts(messages);

  assert.equal(result.has_buyer_messages, true);
  assert.equal(result.latest_buyer_message_id, "m3");
  assert.equal(result.latest_buyer_message_at, "2024-06-01T11:00:00Z");
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${"─".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"─".repeat(50)}`);

if (failed > 0) process.exitCode = 1;
