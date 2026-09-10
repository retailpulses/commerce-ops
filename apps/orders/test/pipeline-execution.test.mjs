/**
 * Execution-path tests for pipeline-runner.mjs — verifies that runPhase
 * and executePhase dispatch correctly without mocking.
 *
 * These tests call the real functions with an empty/minimal env. Each phase
 * handler fails at its first env-dependent check, producing a distinct error
 * that proves the dispatch hit the correct branch (not "unknown_phase").
 *
 * Codex P2: the 37 runner tests verified aliases/constants/helpers but never
 * called runPhase(), executePhase(), or runPipeline(). These tests close that gap.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  runPhase,
  executePhase,
  phaseSupportsDryRun,
  writePipelineRunAudit,
  resolvePhases,
  phasesAreHourlyCore,
  RELAY_DEPENDENT_PHASES,
} from "../src/lib/pipeline-runner.mjs";

test("dry-run audit is logged but never attempts database persistence", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    await writePipelineRunAudit({}, {
      runId: "dry-audit", mode: "dry-run", triggerType: "admin_dry_run",
      cron: "", phase: "pull_giga_tracking", shops: ["Shop1"], dryRun: true,
      stepResult: { ok: true, started_at: "start", ended_at: "end", summary: { side_effects: 0 } },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.some((line) => line.includes('"audit"')), true);
  assert.equal(logs.some((line) => line.includes("audit_backend_configured")), false);
  assert.equal(logs.some((line) => line.includes("audit_write_")), false);
});

test("admin dry-run fails closed for phases without a proven side-effect-free path", async () => {
  const unsupported = [
    "reconcile_end_to_end",
  ];
  for (const phase of unsupported) assert.equal(phaseSupportsDryRun(phase), false, phase);
  assert.equal(phaseSupportsDryRun("pull_shop_orders"), true);
  assert.equal(phaseSupportsDryRun("build_giga_shipments"), true);
  assert.equal(phaseSupportsDryRun("build_rakuten_shipments"), true);
  assert.equal(phaseSupportsDryRun("pull_giga_tracking"), true);
  assert.equal(phaseSupportsDryRun("sync_rakuten_tracking"), true);
  assert.equal(phaseSupportsDryRun("push_orders_to_giga"), true);
  assert.equal(phaseSupportsDryRun("push_rakuten_orders_to_giga"), true);
  assert.equal(phaseSupportsDryRun("send_payment_reminders"), true);

  const result = await executePhase({}, {
    phase: "reconcile_end_to_end", shops: ["Shop1"], limit: 1, orderId: "",
    dryRun: true, runId: "dry-run-fence", mode: "reconcile_end_to_end",
    triggerType: "admin", cron: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.completion_state, "dry_run_unsupported");
  assert.equal(result.summary.side_effects, 0);
});

// ── runPhase dispatch ──────────────────────────────────────────────

test("runPhase — send_payment_reminders dispatches to payment-reminders module", async () => {
  // With empty env, sendPaymentReminders calls createBaserowClient(env) which
  // throws "Missing BASEROW_DATABASE_TOKEN". The throw proves dispatch hit the
  // correct branch (not unknown_phase fallback which returns, not throws).
  await assert.rejects(
    () => runPhase("send_payment_reminders", {}, { limit: 10, dryRun: true }),
    { name: "Error", message: "Missing BASEROW_DATABASE_TOKEN" },
  );
});

test("runPhase — unknown phase returns unknown_phase error", async () => {
  const result = await runPhase("bogus_nonexistent_phase", {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_phase:bogus_nonexistent_phase");
});

test("runPhase — empty phase string returns unknown_phase error", async () => {
  const result = await runPhase("", {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_phase:");
});

test("runPhase — pull_shop_orders dispatches to Mercari ingest (relay check)", async () => {
  // With empty env, runMercariIngestViaRelay fails because there's no relay URL.
  // The error will be from the relay layer, not unknown_phase.
  const result = await runPhase("pull_shop_orders", {}, { limit: 5, dryRun: true });
  assert.equal(result.ok, false);
  // Mercari ingest returns a distinct error shape from the relay adapter
  assert.ok(result.error, "should have an error field from relay adapter");
  assert.notEqual(result.error, "unknown_phase:pull_shop_orders");
});

test("runPhase — build_giga_shipments dispatches to shipment projector", async () => {
  // With empty env, projectMercariSalesOrdersToShipment calls
  // createBaserowClient which throws "Missing BASEROW_DATABASE_TOKEN".
  // The throw proves dispatch hit the right branch.
  await assert.rejects(
    () => runPhase("build_giga_shipments", {}, { shops: ["Shop1"], limit: 5 }),
    { name: "Error", message: "Missing BASEROW_DATABASE_TOKEN" },
  );
});

test("runPhase — reconcile_end_to_end dispatches to healing pass", async () => {
  const result = await runPhase("reconcile_end_to_end", {}, { shops: ["Shop1"], limit: 5 });
  // End-to-end reconcile calls multiple sub-phases, each failing independently.
  // Should return a summary object, not unknown_phase.
  assert.notEqual(result.error, "unknown_phase:reconcile_end_to_end");
});

// ── executePhase relay health gate ──────────────────────────────────

test("executePhase — relay-dependent phase checks relay health before dispatch", async () => {
  // send_payment_reminders is in RELAY_DEPENDENT_PHASES.
  // With empty env, checkRelayHealth returns { ok: false, error: "no_relay_base_url" }.
  // executePhase must short-circuit before calling runPhase.
  const result = await executePhase({}, {
    phase: "send_payment_reminders",
    shops: ["Shop1"], limit: 10, dryRun: true,
    runId: "test_run", mode: "dry-run", triggerType: "manual", cron: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /^relay_unhealthy:/);
  assert.ok(result.relay_health, "should include relay_health payload");
  assert.equal(result.relay_health.ok, false);
});

test("executePhase — non-relay phase skips relay health check", async () => {
  // build_giga_shipments is NOT in RELAY_DEPENDENT_PHASES.
  // executePhase should go straight to runPhase without checking relay.
  const result = await executePhase({}, {
    phase: "build_giga_shipments",
    shops: ["Shop1"], limit: 5, dryRun: true,
    runId: "test_run", mode: "dry-run", triggerType: "manual", cron: null,
  });
  // Should NOT have relay_unhealthy error — it goes directly to shipment projection
  if (!result.ok) {
    assert.ok(!result.error || !result.error.startsWith("relay_unhealthy:"),
      `non-relay phase should not check relay health, got: ${result.error}`);
  }
});

test("executePhase — all RELAY_DEPENDENT_PHASES gate on relay health", async () => {
  for (const phase of RELAY_DEPENDENT_PHASES) {
    const result = await executePhase({}, {
      phase, shops: ["Shop1"], limit: 1, dryRun: true,
      runId: "test_contract", mode: "dry-run", triggerType: "manual", cron: null,
    });
    assert.equal(result.ok, false, `${phase}: should fail with empty env`);
    // Every relay-dependent phase must hit the relay health gate first
    assert.match(result.error, /^relay_unhealthy:/,
      `${phase}: relay-dependent phase must check relay health before dispatch`);
  }
});

// ── executePhase known-phase contract ───────────────────────────────

test("executePhase — unknown phase returns unknown_phase error", async () => {
  // executePhase wraps runPhase's result in stepResult.summary.
  // Unknown phases are caught by runPhase's fallback return.
  const result = await executePhase({}, {
    phase: "bogus_nonexistent", shops: ["Shop1"], limit: 1, dryRun: true,
    runId: "test_run", mode: "dry-run", triggerType: "manual", cron: null,
  });
  assert.equal(result.ok, false);
  // executePhase wraps: { ok, summary: { ok: false, error: "unknown_phase:..." } }
  assert.ok(result.summary, "executePhase wraps runPhase result in .summary");
  assert.equal(result.summary.error, "unknown_phase:bogus_nonexistent");
});

test("executePhase — every known phase name dispatches without unknown_phase error", async () => {
  const knownPhases = [
    "pull_shop_orders", "sync_mercari_messages", "auto_approve_orders",
    "build_giga_shipments", "push_orders_to_giga", "pull_giga_tracking",
    "close_shop_orders", "reconcile_cancellations",
    "pull_rakuten_orders", "confirm_rakuten_orders", "build_rakuten_shipments",
    "push_rakuten_orders_to_giga", "sync_rakuten_tracking", "close_rakuten_orders",
    "send_payment_reminders", "reconcile_order_lifecycle", "reconcile_rakuten_lifecycle", "reconcile_end_to_end",
  ];
  for (const phase of knownPhases) {
    const result = await executePhase({}, {
      phase, shops: ["Shop1"], limit: 1, dryRun: true,
      runId: "test_contract", mode: "dry-run", triggerType: "manual", cron: null,
    });
    // Every known phase must NOT return unknown_phase error — it must hit
    // its specific handler branch.
    // executePhase error sources:
    //   - relay gate:      result.error = "relay_unhealthy:..."
    //   - runPhase throw:   result.error = normalizeErrorMessage(err)
    //   - runPhase return:  result.summary.error
    const phaseError = result.error || (result.summary && result.summary.error) || "";
    assert.notEqual(phaseError, `unknown_phase:${phase}`,
      `${phase}: known phase must have a handler branch in runPhase`);
  }
});

// ── resolvePhases (orchestration helper) ────────────────────────────

test("resolvePhases — every known mode resolves to itself", () => {
  const knownPhases = [
    "pull_shop_orders", "sync_mercari_messages", "auto_approve_orders",
    "build_giga_shipments", "push_orders_to_giga", "pull_giga_tracking",
    "close_shop_orders", "reconcile_cancellations",
    "pull_rakuten_orders", "confirm_rakuten_orders", "build_rakuten_shipments",
    "push_rakuten_orders_to_giga", "sync_rakuten_tracking", "close_rakuten_orders",
    "send_payment_reminders", "reconcile_order_lifecycle", "reconcile_rakuten_lifecycle", "reconcile_end_to_end",
  ];
  for (const phase of knownPhases) {
    const result = resolvePhases(phase, undefined);
    assert.deepEqual(result, [phase], `${phase}: named mode must resolve to [self]`);
  }
});

// ── CORE_PHASES contract ────────────────────────────────────────────

test("phasesAreHourlyCore — all 16 known phases individually are not the hourly triple", () => {
  const knownPhases = [
    "pull_shop_orders", "sync_mercari_messages", "auto_approve_orders",
    "build_giga_shipments", "push_orders_to_giga", "pull_giga_tracking",
    "close_shop_orders", "reconcile_cancellations",
    "pull_rakuten_orders", "confirm_rakuten_orders", "build_rakuten_shipments",
    "push_rakuten_orders_to_giga", "sync_rakuten_tracking", "close_rakuten_orders",
    "send_payment_reminders", "reconcile_end_to_end",
  ];
  for (const phase of knownPhases) {
    assert.equal(phasesAreHourlyCore([phase]), false,
      `single phase "${phase}" is not the hourly core triple`);
  }
});
