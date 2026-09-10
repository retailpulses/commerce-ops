#!/usr/bin/env node
/**
 * Unit tests for payment-reminders pure functions.
 *
 * These test the zero-dependency pure functions in
 * src/lib/payment-reminders-pure.mjs — the same implementations used by
 * the production module. No network, no env vars needed.
 *
 * Integration tests (live relay calls) are performed via the --dry-run
 * flag in staging.
 *
 * Usage: node test/payment-reminders.test.mjs
 */

import { strict as assert } from "node:assert";
import {
  getReminderDay,
  isProductInStock,
  renderTemplate,
  getDeadlineDate,
  getEligiblePurchaseWindow,
  isWaitingForPaymentStatus,
} from "../src/lib/payment-reminders-pure.mjs";
import { applyExactPaymentReminderScope, findMatchingReminderMessage } from "../src/lib/payment-reminders.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertEqual(actual, expected, label) {
  assert.strictEqual(actual, expected, label || `${actual} !== ${expected}`);
}

function assertNull(actual, label) {
  assert.strictEqual(actual, null, label || `expected null, got ${actual}`);
}

/** Build a JST Date for a given date and hour. */
function jstDate(year, month, day, hour = 8) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9));
}

/** Build an ISO string representing purchase_date from a JST date. */
function purchaseAt(year, month, day, hour = 14, minute = 30) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute)).toISOString();
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// getReminderDay tests
// ---------------------------------------------------------------------------

test("getReminderDay: null purchaseDate returns null", () => {
  assertNull(getReminderDay(null, new Date()));
  assertNull(getReminderDay(undefined, new Date()));
  assertNull(getReminderDay("", new Date()));
});

test("getReminderDay: invalid date string returns null", () => {
  assertNull(getReminderDay("not-a-date", new Date()));
  assertNull(getReminderDay("2026-13-45", new Date()));
});

test("getReminderDay: same-day purchase returns null (not a reminder day)", () => {
  const purchased = purchaseAt(2026, 7, 16, 14, 30);
  const now = jstDate(2026, 7, 16, 8, 0);
  assertNull(getReminderDay(purchased, now));
});

test("getReminderDay: next calendar day returns day2", () => {
  const purchased = purchaseAt(2026, 7, 16, 14, 30);
  const now = jstDate(2026, 7, 17, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day2");
});

test("getReminderDay: 2 calendar days later returns day3", () => {
  const purchased = purchaseAt(2026, 7, 16, 14, 30);
  const now = jstDate(2026, 7, 18, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day3");
});

test("getReminderDay: 3 calendar days later returns null (past reminder window)", () => {
  const purchased = purchaseAt(2026, 7, 16, 14, 30);
  const now = jstDate(2026, 7, 19, 8, 0);
  assertNull(getReminderDay(purchased, now));
});

test("getReminderDay: late-night purchase still gets day2 next morning", () => {
  const purchased = purchaseAt(2026, 7, 16, 23, 30);
  const now = jstDate(2026, 7, 17, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day2");
});

test("getReminderDay: early-morning purchase same day at 8am is null", () => {
  const purchased = purchaseAt(2026, 7, 16, 7, 0);
  const now = jstDate(2026, 7, 16, 8, 0);
  assertNull(getReminderDay(purchased, now));
});

test("getReminderDay: works with Date object as purchaseDate", () => {
  const purchased = new Date(Date.UTC(2026, 6, 16, 5, 30)); // July 16 14:30 JST
  const now = jstDate(2026, 7, 18, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day3");
});

test("getReminderDay: month boundary — Jan 31 to Feb 1 is day2", () => {
  const purchased = purchaseAt(2026, 1, 31, 14, 30);
  const now = jstDate(2026, 2, 1, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day2");
});

test("getReminderDay: year boundary — Dec 31 to Jan 1 is day2", () => {
  const purchased = purchaseAt(2026, 12, 31, 14, 30);
  const now = jstDate(2027, 1, 1, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day2");
});

test("getReminderDay: Feb 28 to Mar 1 in non-leap year is day2", () => {
  const purchased = purchaseAt(2026, 2, 28, 14, 30);
  const now = jstDate(2026, 3, 1, 8, 0);
  assertEqual(getReminderDay(purchased, now), "day2");
});

test("getReminderDay: default nowJst uses Date.now()", () => {
  // Should not throw and should return a valid result (null since purchased now)
  const purchased = purchaseAt(2026, 7, 16, 14, 30);
  // With no nowJst arg, uses Date.now() — result depends on actual date,
  // but it should never throw for valid inputs
  const result = getReminderDay(purchased);
  assert.strictEqual(typeof result === "string" || result === null, true);
});

test("getEligiblePurchaseWindow: covers exactly the prior two JST dates", () => {
  const window = getEligiblePurchaseWindow(jstDate(2026, 7, 16, 8));
  assertEqual(window.start, "2026-07-13T15:00:00.000Z");
  assertEqual(window.end, "2026-07-15T15:00:00.000Z");
});

test("isWaitingForPaymentStatus: accepts only WAITING_FOR_PAYMENT", () => {
  assertEqual(isWaitingForPaymentStatus("WAITING_FOR_PAYMENT"), true);
  assertEqual(isWaitingForPaymentStatus(" waiting_for_payment "), true);
  assertEqual(isWaitingForPaymentStatus("TRADING"), false);
  assertEqual(isWaitingForPaymentStatus(null), false);
  assertEqual(isWaitingForPaymentStatus(""), false);
});

test("ambiguous reminder reconciliation matches exact seller intent after reservation", () => {
  const reminder = { message_text: "exact reminder", reserved_at: "2026-07-16T00:00:00.000Z" };
  const match = findMatchingReminderMessage([
    { id: "buyer", role: "BUYER", message: "exact reminder", createdAt: "2026-07-16T00:01:00.000Z" },
    { id: "old", role: "SELLER", message: "exact reminder", createdAt: "2026-07-15T23:00:00.000Z" },
    { id: "sent", role: "SELLER", message: "exact reminder", createdAt: "2026-07-16T00:01:00.000Z" },
  ], reminder);
  assertEqual(match.id, "sent");
});

test("ambiguous reminder reconciliation does not guess on different or invalid evidence", () => {
  assertNull(findMatchingReminderMessage([
    { id: "different", role: "SELLER", message: "other text", createdAt: "2026-07-16T00:01:00.000Z" },
  ], { message_text: "exact reminder", reserved_at: "2026-07-16T00:00:00.000Z" }));
  assertNull(findMatchingReminderMessage([], { message_text: "", reserved_at: "invalid" }));
});

test("exact reminder scope binds both normalized order and source store", () => {
  const filters = [];
  const query = { eq(column, value) { filters.push([column, value]); return this; } };
  assert.strictEqual(applyExactPaymentReminderScope(query, {
    orderId: "order_target", sourceStoreId: "shop-2",
  }), query);
  assert.deepEqual(filters, [["order_id", "target"], ["source_store_id", "shop-2"]]);
});

// ---------------------------------------------------------------------------
// isProductInStock tests
// ---------------------------------------------------------------------------

test("isProductInStock: null/undefined returns false", () => {
  assertEqual(isProductInStock(null), false);
  assertEqual(isProductInStock(undefined), false);
  assertEqual(isProductInStock({}), false);
});

test("isProductInStock: owned_qty >= 1 → true", () => {
  assertEqual(isProductInStock({ field_3: 5, field_4: null }), true);
  assertEqual(isProductInStock({ field_3: 1, field_4: 0 }), true);
  assertEqual(isProductInStock({ field_3: "10", field_4: null }), true);
});

test("isProductInStock: qty_available >= 1 → true", () => {
  assertEqual(isProductInStock({ field_3: 0, field_4: 5 }), true);
  assertEqual(isProductInStock({ field_3: null, field_4: 3 }), true);
  assertEqual(isProductInStock({ field_3: 0, field_4: "2" }), true);
});

test("isProductInStock: both null or 0 → false (out of stock)", () => {
  assertEqual(isProductInStock({ field_3: 0, field_4: 0 }), false);
  assertEqual(isProductInStock({ field_3: null, field_4: null }), false);
  assertEqual(isProductInStock({ field_3: 0, field_4: null }), false);
  assertEqual(isProductInStock({ field_3: null, field_4: 0 }), false);
});

test("isProductInStock: negative values treated as not-in-stock", () => {
  assertEqual(isProductInStock({ field_3: -1, field_4: null }), false);
  assertEqual(isProductInStock({ field_3: null, field_4: -1 }), false);
});

test("isProductInStock: string numbers are parsed correctly", () => {
  assertEqual(isProductInStock({ field_3: "5", field_4: "0" }), true);
  assertEqual(isProductInStock({ field_3: "0", field_4: "0" }), false);
  assertEqual(isProductInStock({ field_3: "  3  ", field_4: null }), true);
});

test("isProductInStock: handles non-object gracefully", () => {
  assertEqual(isProductInStock("not an object"), false);
  assertEqual(isProductInStock(42), false);
  assertEqual(isProductInStock([]), false);
});

// ---------------------------------------------------------------------------
// renderTemplate tests
// ---------------------------------------------------------------------------

test("renderTemplate: substitutes all variables", () => {
  const result = renderTemplate(
    "{{product_name}} is in stock. Purchased {{purchase_date}}. Deadline: {{deadline_date}}.",
    { product_name: "Test Chair", purchase_date: "2026-07-16", deadline_date: "2026-07-18" }
  );
  assertEqual(result, "Test Chair is in stock. Purchased 2026-07-16. Deadline: 2026-07-18.");
});

test("renderTemplate: multiple occurrences of same variable", () => {
  const result = renderTemplate(
    "{{product_name}} — {{product_name}}",
    { product_name: "Chair" }
  );
  assertEqual(result, "Chair — Chair");
});

test("renderTemplate: missing variables are left as-is", () => {
  const result = renderTemplate(
    "Product: {{product_name}}, Date: {{purchase_date}}",
    { product_name: "Chair" }
  );
  assertEqual(result, "Product: Chair, Date: {{purchase_date}}");
});

test("renderTemplate: null/undefined vars are skipped (placeholder left)", () => {
  const result = renderTemplate(
    "{{product_name}}",
    { product_name: null }
  );
  assertEqual(result, "{{product_name}}");
});

test("renderTemplate: empty string object returns empty", () => {
  assertEqual(renderTemplate("", {}), "");
});

test("renderTemplate: no variables in template returns original", () => {
  const result = renderTemplate("Plain text with no variables.", { product_name: "X" });
  assertEqual(result, "Plain text with no variables.");
});

// ---------------------------------------------------------------------------
// getDeadlineDate tests
// ---------------------------------------------------------------------------

test("getDeadlineDate: purchase + 2 calendar days in JST", () => {
  // Purchased July 16 (JST) → deadline July 18 (day 3)
  const purchased = purchaseAt(2026, 7, 16, 14, 30);
  assertEqual(getDeadlineDate(purchased), "2026-07-18");
});

test("getDeadlineDate: month boundary", () => {
  // Purchased Jan 31 → deadline Feb 2
  const purchased = purchaseAt(2026, 1, 31, 14, 30);
  assertEqual(getDeadlineDate(purchased), "2026-02-02");
});

test("getDeadlineDate: late-night purchase still same deadline day", () => {
  const purchased = purchaseAt(2026, 7, 16, 23, 59);
  assertEqual(getDeadlineDate(purchased), "2026-07-18");
});

test("getDeadlineDate: null/undefined returns empty string", () => {
  assertEqual(getDeadlineDate(null), "");
  assertEqual(getDeadlineDate(undefined), "");
  assertEqual(getDeadlineDate(""), "");
});

test("getDeadlineDate: works with Date object", () => {
  const purchased = new Date(Date.UTC(2026, 6, 16, 5, 30)); // July 16 14:30 JST
  assertEqual(getDeadlineDate(purchased), "2026-07-18");
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exitCode = 1;
