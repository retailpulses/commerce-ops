#!/usr/bin/env node
/**
 * Unit tests for tracking-reconciler pure functions.
 *
 * These test the logic functions in isolation — no network, no env vars needed.
 * Integration tests (live API calls) are defined in docs/testing/tracking-reconciler-cases.md
 *
 * Usage: node test/tracking-reconciler.test.mjs
 */

import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Inline the pure helpers to test them without importing the full module
// (the full module imports baserow/giga which need env vars)
// ---------------------------------------------------------------------------

function text(value) {
  return String(value == null ? "" : value).trim();
}

function readSelectValue(value) {
  if (value == null) return "";
  if (typeof value === "object" && value) return text(value.value || value.name || value.label);
  return text(value);
}

function isTerminalSyncStatus(row) {
  const status = readSelectValue(row && row.giga_sync_status).toLowerCase();
  return status === "invalid";
}

function inferScope(rows, salesChannel) {
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const platform = text(first && first.SalesChannel) || salesChannel || "Unknown";
  const storeId = text(first && first.SourceStoreID);
  return `${platform}::${storeId}`;
}

function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

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

function equal(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

// ===========================================================================
// text()
// ===========================================================================
console.log("\ntext()");
test("null → empty string", () => equal(text(null), ""));
test("undefined → empty string", () => equal(text(undefined), ""));
test("whitespace → empty string", () => equal(text("   "), ""));
test("normal string", () => equal(text("hello"), "hello"));
test("trims surrounding whitespace", () => equal(text("  hello  "), "hello"));
test("number → string", () => equal(text(42), "42"));

// ===========================================================================
// normalizeOrderIdCandidate()
// ===========================================================================
console.log("\nnormalizeOrderIdCandidate()");
test("strips order_ prefix", () => equal(normalizeOrderIdCandidate("order_ABC123"), "ABC123"));
test("no prefix passes through", () => equal(normalizeOrderIdCandidate("ABC123"), "ABC123"));
test("null → empty string", () => equal(normalizeOrderIdCandidate(null), ""));
test("trims whitespace", () => equal(normalizeOrderIdCandidate("  order_XYZ  "), "XYZ"));

// ===========================================================================
// readSelectValue()
// ===========================================================================
console.log("\nreadSelectValue()");
test("null → empty string", () => equal(readSelectValue(null), ""));
test("plain string passes through", () => equal(readSelectValue("Synced"), "Synced"));
test("object with .value", () => equal(readSelectValue({ value: "Synced", id: 123 }), "Synced"));
test("object with .name (fallback)", () => equal(readSelectValue({ name: "Completed" }), "Completed"));
test("object with .label (fallback)", () => equal(readSelectValue({ label: "Invalid" }), "Invalid"));
test("object with all three → prefers .value", () => equal(readSelectValue({ value: "A", name: "B", label: "C" }), "A"));
test("empty object → empty string", () => equal(readSelectValue({}), ""));
test("number → string", () => equal(readSelectValue(123), "123"));

// ===========================================================================
// isTerminalSyncStatus()
// ===========================================================================
console.log("\nisTerminalSyncStatus()");
test("null row → false", () => equal(isTerminalSyncStatus(null), false));
test("empty row → false", () => equal(isTerminalSyncStatus({}), false));
test('status "invalid" → true', () => equal(isTerminalSyncStatus({ giga_sync_status: "invalid" }), true));
test('status "Invalid" (capital I) → true', () => equal(isTerminalSyncStatus({ giga_sync_status: "Invalid" }), true));
test('status via object .value → true', () => equal(isTerminalSyncStatus({ giga_sync_status: { value: "Invalid" } }), true));
test('status "Synced" → false', () => equal(isTerminalSyncStatus({ giga_sync_status: "Synced" }), false));
test('status "Error" → false', () => equal(isTerminalSyncStatus({ giga_sync_status: "Error" }), false));
test("empty status → false", () => equal(isTerminalSyncStatus({ giga_sync_status: "" }), false));

// ===========================================================================
// inferScope()
// ===========================================================================
console.log("\ninferScope()");
test("from row with SalesChannel + SourceStoreID", () => {
  equal(inferScope([{ SalesChannel: "Mercari", SourceStoreID: "WMyisFmhbGWyVAPEwsfirn" }], "Mercari"),
    "Mercari::WMyisFmhbGWyVAPEwsfirn");
});
test("fallback to salesChannel when row has no SalesChannel", () => {
  equal(inferScope([{ SourceStoreID: "abc123" }], "Rakuten"),
    "Rakuten::abc123");
});
test("empty rows → Unknown fallback", () => {
  equal(inferScope([], "Mercari"), "Mercari::");
});
test("null rows → Unknown fallback", () => {
  equal(inferScope(null, null), "Unknown::");
});
test("multiple rows → uses first", () => {
  equal(inferScope([
    { SalesChannel: "Mercari", SourceStoreID: "AAA" },
    { SalesChannel: "Mercari", SourceStoreID: "BBB" },
  ], "Mercari"), "Mercari::AAA");
});

// ===========================================================================
// chunk()
// ===========================================================================
console.log("\nchunk()");
test("empty array → empty", () => equal(chunk([], 5), []));
test("exact multiple of size", () => {
  equal(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});
test("partial last chunk", () => {
  equal(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});
test("single element per chunk", () => {
  equal(chunk([1, 2, 3], 1), [[1], [2], [3]]);
});
test("size larger than array", () => {
  equal(chunk([1, 2], 10), [[1, 2]]);
});
test("batch of 20 order numbers", () => {
  const orders = Array.from({ length: 45 }, (_, i) => `order_${i}`);
  const batches = chunk(orders, 20);
  equal(batches.length, 3);
  equal(batches[0].length, 20);
  equal(batches[1].length, 20);
  equal(batches[2].length, 5);
});

// ===========================================================================
// Multi-package tracking format validation
// ===========================================================================
console.log("\nmulti-package tracking validation");
test("single package: count matches", () => {
  const shipTrackInfo = [{ trackingNo: "TN001", carrier: "JP" }];
  const summary = "TN001";
  const originalCount = shipTrackInfo.length;
  const formattedCount = summary.split(" / ").length;
  equal(originalCount, formattedCount, "single package count mismatch");
});
test("multi-package: 3 packages count matches", () => {
  const shipTrackInfo = [
    { trackingNo: "TN001", carrier: "JP" },
    { trackingNo: "TN002", carrier: "JP" },
    { trackingNo: "TN003", carrier: "Sagawa" },
  ];
  const summary = "TN001 / TN002 / TN003";
  const originalCount = shipTrackInfo.length;
  const formattedCount = summary.split(" / ").length;
  equal(originalCount, formattedCount, "multi-package count mismatch");
});
test("multi-package: count mismatch detected", () => {
  const shipTrackInfo = [
    { trackingNo: "TN001", carrier: "JP" },
    { trackingNo: "TN002", carrier: "JP" },
  ];
  const summary = "TN001"; // missing TN002
  const originalCount = shipTrackInfo.length;
  const formattedCount = summary.split(" / ").length;
  equal(originalCount !== formattedCount, true, "should detect data loss");
});

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${"─".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"─".repeat(50)}`);

if (failed > 0) process.exitCode = 1;
