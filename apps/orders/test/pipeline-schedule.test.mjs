/**
 * Parity tests for pipeline-schedule.mjs — captures the Worker cron→phases map.
 *
 * These tests verify that the extracted schedule module exactly matches the
 * Worker's SCHEDULED_CRON_MODES map and that unknown cron returns an empty
 * array (not defaulting to core phases).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SCHEDULED_CRON_MODES, phasesForCron, shouldHandleCron } from "../src/lib/pipeline-schedule.mjs";

// ── Map shape ──────────────────────────────────────────────────────

test("schedule map has exactly 11 cron entries after retiring duplicate writers", () => {
  assert.equal(Object.keys(SCHEDULED_CRON_MODES).length, 11);
});

test("every cron key maps to exactly one or more phases", () => {
  for (const [cron, phases] of Object.entries(SCHEDULED_CRON_MODES)) {
    assert.ok(Array.isArray(phases), `cron "${cron}" should map to an array`);
    assert.ok(phases.length > 0, `cron "${cron}" should have at least one phase`);
    for (const phase of phases) {
      assert.equal(typeof phase, "string", `phase in "${cron}" should be a string`);
    }
  }
});

test("unverified close_rakuten_orders is not scheduled", () => {
  assert.deepEqual(
    phasesForCron("10,20,30,40,50 * * * *"),
    ["sync_rakuten_tracking"],
  );
});

test("payment reminders map only from 0 23 * * * (08:00 JST)", () => {
  for (const [cron, phases] of Object.entries(SCHEDULED_CRON_MODES)) {
    if (phases.includes("send_payment_reminders")) {
      assert.equal(cron, "0 23 * * *");
    }
  }
});

// ── phasesForCron ──────────────────────────────────────────────────

test("phasesForCron — known crons return expected phases", () => {
  assert.deepEqual(phasesForCron("1 * * * *"), ["pull_shop_orders", "reconcile_order_lifecycle"]);
  assert.deepEqual(phasesForCron("2 * * * *"), ["pull_rakuten_orders", "reconcile_rakuten_lifecycle"]);
  assert.deepEqual(phasesForCron("0 23 * * *"), ["send_payment_reminders"]);
  assert.deepEqual(
    phasesForCron("3,13,23,33,43,53 * * * *"),
    ["sync_mercari_messages", "auto_approve_orders", "build_giga_shipments"],
  );
  assert.deepEqual(phasesForCron("50 14 * * *"), []);
  assert.deepEqual(
    phasesForCron("10,20,30,40,50 * * * *"),
    ["sync_rakuten_tracking"],
  );
});

test("phasesForCron — unknown cron returns empty array (no default to core phases)", () => {
  // The contract: unknown cron must return [], not default to CORE_PHASES.
  // The scheduled handler must short-circuit on [].
  assert.deepEqual(phasesForCron("* * * * *"), []);
  assert.deepEqual(phasesForCron("0 0 * * *"), []);
  assert.deepEqual(phasesForCron(""), []);
  assert.deepEqual(phasesForCron(null), []);
  assert.deepEqual(phasesForCron(undefined), []);
  assert.deepEqual(phasesForCron("garbage"), []);
});

test("phasesForCron — returns fresh array each time", () => {
  const a = phasesForCron("1 * * * *");
  const b = phasesForCron("1 * * * *");
  assert.deepEqual(a, b);
  assert.notEqual(a, b); // different references
});

// ── Specific schedule assertions ───────────────────────────────────

test("rakuten tracking cron has exactly 5 runs per hour (no :00)", () => {
  const phases = phasesForCron("10,20,30,40,50 * * * *");
  assert.deepEqual(phases, ["sync_rakuten_tracking"]);
  // Must NOT be "0,10,20,30,40,50" (6 runs)
  assert.deepEqual(phasesForCron("0,10,20,30,40,50 * * * *"), []);
  assert.deepEqual(phasesForCron("*/10 * * * *"), []);
});

// ── shouldHandleCron (scheduled handler short-circuit gate) ─────────

test("shouldHandleCron — returns true for every known cron", () => {
  for (const cron of Object.keys(SCHEDULED_CRON_MODES)) {
    assert.ok(shouldHandleCron(cron), `known cron "${cron}" must return true`);
  }
});

test("shouldHandleCron — returns false for unknown cron (short-circuit gate)", () => {
  assert.equal(shouldHandleCron(""), false);
  assert.equal(shouldHandleCron(null), false);
  assert.equal(shouldHandleCron(undefined), false);
  assert.equal(shouldHandleCron("garbage"), false);
  assert.equal(shouldHandleCron("* * * * *"), false);
  assert.equal(shouldHandleCron("0 0 * * *"), false);
  assert.equal(shouldHandleCron("*/10 * * * *"), false);
});

test("shouldHandleCron — integrates with phasesForCron", () => {
  // Known cron: shouldHandleCron = true, phasesForCron = non-empty
  assert.equal(shouldHandleCron("1 * * * *"), true);
  assert.deepEqual(phasesForCron("1 * * * *"), ["pull_shop_orders", "reconcile_order_lifecycle"]);

  // Unknown cron: shouldHandleCron = false, phasesForCron = []
  assert.equal(shouldHandleCron("bogus_cron"), false);
  assert.deepEqual(phasesForCron("bogus_cron"), []);

  // Payment reminders
  assert.equal(shouldHandleCron("0 23 * * *"), true);
  assert.deepEqual(phasesForCron("0 23 * * *"), ["send_payment_reminders"]);
});

test("all 15 phases are covered by at least one cron or intentionally excluded", () => {
  const scheduledPhases = new Set();
  for (const phases of Object.values(SCHEDULED_CRON_MODES)) {
    for (const phase of phases) scheduledPhases.add(phase);
  }

  // Phases that should be scheduled
  const expected = [
    "pull_shop_orders", "reconcile_order_lifecycle", "pull_rakuten_orders", "reconcile_rakuten_lifecycle", "sync_mercari_messages",
    "auto_approve_orders", "build_giga_shipments",
    "confirm_rakuten_orders", "push_orders_to_giga", "push_rakuten_orders_to_giga",
    "build_rakuten_shipments", "pull_giga_tracking", "close_shop_orders",
    "sync_rakuten_tracking",
    "send_payment_reminders",
  ];
  for (const phase of expected) {
    assert.ok(scheduledPhases.has(phase), `${phase} should be scheduled`);
  }

  assert.ok(!scheduledPhases.has("close_rakuten_orders"),
    "close_rakuten_orders must remain manual until its RMS contract is verified");
  assert.ok(!scheduledPhases.has("reconcile_end_to_end"),
    "write-capable legacy reconcile_end_to_end must remain unscheduled");
});
