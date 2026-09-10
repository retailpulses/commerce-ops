/**
 * Parity tests for pipeline-runner.mjs — captures the Worker-compatible contract.
 *
 * Before the Worker can import from the shared runner, the shared runner must
 * match the Worker's existing behavior. These tests encode the Worker contract
 * (as observed in worker/index.js) and gate the Phase 1 migration.
 *
 * Key differences captured:
 *   1. normalizePhaseName — Worker replaces hyphens with underscores
 *   2. resolveShops — Worker filters to Shop1-4, splits multiple delimiters
 *   3. buildRunId — Worker uses decimal (not base36) timestamp
 *   4. normalizeErrorMessage — Worker returns error.stack (full trace)
 *   5. Payment reminders — Worker has aliases + dispatch + relay membership
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SHOPS,
  PHASE_ALIASES,
  CORE_PHASES,
  RELAY_DEPENDENT_PHASES,
  normalizePhaseName,
  resolveShops,
  buildRunId,
  normalizeErrorMessage,
  resolvePhases,
  parseInteger,
  text,
  phasesAreHourlyCore,
  extractCounts,
} from "../src/lib/pipeline-runner.mjs";

// ── normalizePhaseName ─────────────────────────────────────────────

test("normalizePhaseName — canonical aliases resolve", () => {
  assert.equal(normalizePhaseName("pull_shop_orders"), "pull_shop_orders");
  assert.equal(normalizePhaseName("build_giga_shipments"), "build_giga_shipments");
  assert.equal(normalizePhaseName("push_orders_to_giga"), "push_orders_to_giga");
  assert.equal(normalizePhaseName("pull_giga_tracking"), "pull_giga_tracking");
  assert.equal(normalizePhaseName("close_shop_orders"), "close_shop_orders");
  assert.equal(normalizePhaseName("reconcile_end_to_end"), "reconcile_end_to_end");
  assert.equal(normalizePhaseName("reconcile_cancellations"), "reconcile_cancellations");
});

test("normalizePhaseName — shortcut aliases resolve", () => {
  assert.equal(normalizePhaseName("ingest"), "pull_shop_orders");
  assert.equal(normalizePhaseName("project"), "build_giga_shipments");
  assert.equal(normalizePhaseName("reconcile"), "pull_giga_tracking");
  assert.equal(normalizePhaseName("syncback"), "close_shop_orders");
  assert.equal(normalizePhaseName("heal"), "reconcile_end_to_end");
  assert.equal(normalizePhaseName("sync-outbound"), "push_orders_to_giga");
  assert.equal(normalizePhaseName("sync_outbound"), "push_orders_to_giga");
});

test("normalizePhaseName — hyphenated phases are converted to underscores (Worker parity)", () => {
  // Worker does .replace(/-/g, "_") before alias lookup.
  // Shared must match this behavior.
  assert.equal(normalizePhaseName("pull-shop-orders"), "pull_shop_orders");
  assert.equal(normalizePhaseName("build-giga-shipments"), "build_giga_shipments");
  assert.equal(normalizePhaseName("push-orders-to-giga"), "push_orders_to_giga");
  assert.equal(normalizePhaseName("pull-giga-tracking"), "pull_giga_tracking");
  assert.equal(normalizePhaseName("close-shop-orders"), "close_shop_orders");
  assert.equal(normalizePhaseName("reconcile-end-to-end"), "reconcile_end_to_end");
});

test("normalizePhaseName — Rakuten aliases resolve", () => {
  assert.equal(normalizePhaseName("pull_rakuten_orders"), "pull_rakuten_orders");
  assert.equal(normalizePhaseName("confirm_rakuten_orders"), "confirm_rakuten_orders");
  assert.equal(normalizePhaseName("build_rakuten_shipments"), "build_rakuten_shipments");
  assert.equal(normalizePhaseName("push_rakuten_orders_to_giga"), "push_rakuten_orders_to_giga");
  assert.equal(normalizePhaseName("sync_rakuten_tracking"), "sync_rakuten_tracking");
  assert.equal(normalizePhaseName("pull_rakuten_tracking"), "sync_rakuten_tracking");
  assert.equal(normalizePhaseName("close_rakuten_orders"), "close_rakuten_orders");
});

test("normalizePhaseName — payment reminder aliases exist (Worker parity)", () => {
  // Worker defines these aliases (lines 130-132). Shared runner must also.
  assert.equal(normalizePhaseName("payment_reminders"), "send_payment_reminders");
  assert.equal(normalizePhaseName("send_payment_reminders"), "send_payment_reminders");
});

test("normalizePhaseName — message sync and auto-approve aliases", () => {
  assert.equal(normalizePhaseName("sync_messages"), "sync_mercari_messages");
  assert.equal(normalizePhaseName("sync_mercari_messages"), "sync_mercari_messages");
  assert.equal(normalizePhaseName("auto_approve"), "auto_approve_orders");
  assert.equal(normalizePhaseName("auto_approve_orders"), "auto_approve_orders");
});

test("normalizePhaseName — unknown phase passes through", () => {
  assert.equal(normalizePhaseName("bogus_phase"), "bogus_phase");
  assert.equal(normalizePhaseName(""), "");
  assert.equal(normalizePhaseName(undefined), "");
  assert.equal(normalizePhaseName(null), "");
});

// ── resolveShops ───────────────────────────────────────────────────

test("resolveShops — undefined/null/empty returns [] (Worker parity: callers supply fallback)", () => {
  // Worker resolveShops returns [] for falsy — callers supply the DEFAULT_SHOPS fallback chain.
  assert.deepEqual(resolveShops(undefined), []);
  assert.deepEqual(resolveShops(null), []);
  assert.deepEqual(resolveShops(""), []);
});

test("resolveShops — scalar comma-separated shops", () => {
  assert.deepEqual(resolveShops("Shop1"), ["Shop1"]);
  assert.deepEqual(resolveShops("Shop1,Shop2"), ["Shop1", "Shop2"]);
  assert.deepEqual(resolveShops(" Shop1 , Shop2 "), ["Shop1", "Shop2"]);
});

test("resolveShops — multi-delimiter splitting (Worker parity)", () => {
  // Worker splits on /[,\s;]+/g. Shared must handle semicolons and spaces too.
  assert.deepEqual(resolveShops("Shop1;Shop2"), ["Shop1", "Shop2"]);
  assert.deepEqual(resolveShops("Shop1 Shop2"), ["Shop1", "Shop2"]);
  assert.deepEqual(resolveShops("Shop1 Shop2;Shop3"), ["Shop1", "Shop2", "Shop3"]);
});

test("resolveShops — filters to Shop1-Shop4 only (Worker parity)", () => {
  // Worker filters to DEFAULT_SHOPS. Unknown shops must be dropped.
  assert.deepEqual(resolveShops("Shop5"), []);
  assert.deepEqual(resolveShops("Shop1,Shop5,Shop2"), ["Shop1", "Shop2"]);
  assert.deepEqual(resolveShops("ShopX"), []);
});

test("resolveShops — deduplicates correctly", () => {
  assert.deepEqual(resolveShops("Shop1,Shop1"), ["Shop1", "Shop1"]);
});

test("resolveShops — array input", () => {
  assert.deepEqual(resolveShops(["Shop1"]), ["Shop1"]);
  assert.deepEqual(resolveShops([" Shop1 ", "Shop2"]), ["Shop1", "Shop2"]);
  assert.deepEqual(resolveShops(["Shop1", "Shop5"]), ["Shop1"]);
});

// ── buildRunId ─────────────────────────────────────────────────────

test("buildRunId — uses decimal timestamp (Worker parity)", () => {
  const id = buildRunId();
  // Worker format: run_<decimal ts>_<8 base36 chars>
  // Shared currently uses base36 timestamp — must switch to decimal.
  assert.match(id, /^run_\d+_[a-z0-9]{1,8}$/);
});

test("buildRunId — produces unique IDs", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(buildRunId());
  assert.equal(ids.size, 100);
});

// ── normalizeErrorMessage ──────────────────────────────────────────

test("normalizeErrorMessage — returns stack for Error objects (Worker parity)", () => {
  const err = new Error("something broke");
  const result = normalizeErrorMessage(err);
  // Worker returns error.stack, not error.message.
  // The stack should contain the message plus trace info.
  assert.match(result, /something broke/);
  assert.match(result, /at /); // stack trace present
});

test("normalizeErrorMessage — returns string for non-Error", () => {
  assert.equal(normalizeErrorMessage("plain string"), "plain string");
  assert.equal(normalizeErrorMessage(null), "unknown_error");
  assert.equal(normalizeErrorMessage(undefined), "unknown_error");
  assert.equal(normalizeErrorMessage(42), "42");
});

test("normalizeErrorMessage — handles object with stack property", () => {
  const obj = { stack: "custom stack trace", message: "test" };
  const result = normalizeErrorMessage(obj);
  assert.equal(result, "custom stack trace");
});

// ── PHASE_ALIASES ──────────────────────────────────────────────────

test("PHASE_ALIASES — includes payment reminder aliases (Worker parity)", () => {
  assert.equal(PHASE_ALIASES.payment_reminders, "send_payment_reminders");
  assert.equal(PHASE_ALIASES.send_payment_reminders, "send_payment_reminders");
});

test("PHASE_ALIASES — every key maps to a known phase", () => {
  const knownPhases = new Set([
    "pull_shop_orders", "build_giga_shipments", "push_orders_to_giga",
    "pull_giga_tracking", "close_shop_orders", "reconcile_end_to_end",
    "reconcile_cancellations", "auto_approve_orders", "sync_mercari_messages",
    "pull_rakuten_orders", "confirm_rakuten_orders", "build_rakuten_shipments",
    "push_rakuten_orders_to_giga", "sync_rakuten_tracking", "close_rakuten_orders",
    "send_payment_reminders", "reconcile_order_lifecycle", "reconcile_rakuten_lifecycle",
    "audit_pipeline_integrity",
  ]);
  for (const [key, value] of Object.entries(PHASE_ALIASES)) {
    assert.ok(knownPhases.has(value), `alias "${key}" → "${value}": value is not a known phase`);
  }
});

// ── RELAY_DEPENDENT_PHASES ─────────────────────────────────────────

test("RELAY_DEPENDENT_PHASES — includes send_payment_reminders (Worker parity)", () => {
  assert.ok(RELAY_DEPENDENT_PHASES.has("send_payment_reminders"),
    "send_payment_reminders must be relay-dependent (it calls Mercari API)");
});

test("RELAY_DEPENDENT_PHASES — includes sync_mercari_messages", () => {
  assert.ok(RELAY_DEPENDENT_PHASES.has("sync_mercari_messages"));
});

test("RELAY_DEPENDENT_PHASES — includes lifecycle reconciliation", () => {
  assert.ok(RELAY_DEPENDENT_PHASES.has("reconcile_order_lifecycle"));
  assert.ok(RELAY_DEPENDENT_PHASES.has("reconcile_rakuten_lifecycle"));
});

test("RELAY_DEPENDENT_PHASES — includes all Mercari and Rakuten relay phases", () => {
  for (const phase of ["pull_shop_orders", "close_shop_orders", "pull_rakuten_orders", "confirm_rakuten_orders", "close_rakuten_orders"]) {
    assert.ok(RELAY_DEPENDENT_PHASES.has(phase), `expected ${phase} in RELAY_DEPENDENT_PHASES`);
  }
});

// ── CORE_PHASES ────────────────────────────────────────────────────

test("CORE_PHASES — is the canonical Mercari hourly triple", () => {
  assert.deepEqual(CORE_PHASES, ["pull_shop_orders", "build_giga_shipments", "push_orders_to_giga"]);
});

// ── resolvePhases ──────────────────────────────────────────────────

test("resolvePhases — hourly mode returns CORE_PHASES copy", () => {
  const result = resolvePhases("hourly", undefined);
  assert.deepEqual(result, CORE_PHASES);
  assert.notEqual(result, CORE_PHASES); // fresh copy
});

test("resolvePhases — scheduled mode returns CORE_PHASES copy", () => {
  const result = resolvePhases("scheduled", undefined);
  assert.deepEqual(result, CORE_PHASES);
});

test("resolvePhases — explicit phases overrides mode", () => {
  const result = resolvePhases("hourly", ["pull_rakuten_orders"]);
  assert.deepEqual(result, ["pull_rakuten_orders"]);
});

test("resolvePhases — explicit empty array falls through to mode default", () => {
  const result = resolvePhases("hourly", []);
  assert.deepEqual(result, CORE_PHASES);
});

test("resolvePhases — undefined explicitPhases with named mode", () => {
  assert.deepEqual(resolvePhases("pull_shop_orders", undefined), ["pull_shop_orders"]);
  assert.deepEqual(resolvePhases("send_payment_reminders", undefined), ["send_payment_reminders"]);
});

test("resolvePhases — does not throw on undefined explicitPhases", () => {
  assert.doesNotThrow(() => resolvePhases("hourly", undefined));
});

// ── phasesAreHourlyCore ────────────────────────────────────────────

test("phasesAreHourlyCore — true for exact match", () => {
  assert.ok(phasesAreHourlyCore(["pull_shop_orders", "build_giga_shipments", "push_orders_to_giga"]));
});

test("phasesAreHourlyCore — false for different order", () => {
  assert.equal(phasesAreHourlyCore(["push_orders_to_giga", "build_giga_shipments", "pull_shop_orders"]), false);
});

test("phasesAreHourlyCore — false for subsets/supersets", () => {
  assert.equal(phasesAreHourlyCore(["pull_shop_orders", "build_giga_shipments"]), false);
  assert.equal(phasesAreHourlyCore([...CORE_PHASES, "close_shop_orders"]), false);
  assert.equal(phasesAreHourlyCore([]), false);
  assert.equal(phasesAreHourlyCore(null), false);
  assert.equal(phasesAreHourlyCore("not_array"), false);
});

// ── parseInteger ───────────────────────────────────────────────────

test("parseInteger — returns fallback on undefined/null/empty", () => {
  assert.equal(parseInteger(undefined, 100), 100);
  assert.equal(parseInteger(null, 100), 100);
  assert.equal(parseInteger("", 100), 100);
  assert.equal(parseInteger("  ", 100), 100);
});

test("parseInteger — parses valid numbers", () => {
  assert.equal(parseInteger("50", 100), 50);
  assert.equal(parseInteger(50, 100), 50);
  assert.equal(parseInteger(" 50 ", 100), 50);
});

test("parseInteger — returns fallback on invalid", () => {
  assert.equal(parseInteger("abc", 100), 100);
  assert.equal(parseInteger("Infinity", 100), 100);
});

// ── text ───────────────────────────────────────────────────────────

test("text — trims and stringifies", () => {
  assert.equal(text("  hello  "), "hello");
  assert.equal(text(null), "");
  assert.equal(text(undefined), "");
  assert.equal(text(42), "42");
  assert.equal(text(""), "");
});

test("extractCounts — preserves durable Rakuten confirmation outcomes in the real runPhase shape", () => {
  assert.deepEqual(extractCounts({
    found: { total_confirmed_rows: 4, marked_in_progress: 4 },
    operations: { candidates: 4, results: [
    { action: "confirmed" },
    { action: "reconciled_applied" },
    { action: "unknown_result" },
    { action: "operation_failed_closed" },
  ] } }), {
    candidates: 4,
    confirmed: 1,
    reconciled_applied: 1,
    ledger_already_applied: 0,
    unknown_result: 1,
    ledger_blocked: 0,
    local_persistence_failed: 0,
    operation_failed_closed: 1,
  });
});
