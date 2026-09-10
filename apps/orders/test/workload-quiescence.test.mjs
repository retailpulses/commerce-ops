import assert from "node:assert/strict";
import test from "node:test";
import { phasesForWorkload, validateWorkloadQuiescence } from "../src/lib/workload-quiescence.mjs";
import { parseArgs } from "../scripts/verify-workload-quiescence.mjs";

const now = new Date("2026-09-07T12:00:00Z");
const ownership = {
  workload_id: "ordermgmt_mercari_order_pull", scheduler_owner: "disabled", kill_switch_state: "disabled",
  evidence_observed_at: "2026-09-07T11:00:00Z", expires_at: "2026-09-08T12:00:00Z",
};

test("maps every phase sharing one workload ownership boundary", () => {
  assert.deepEqual(phasesForWorkload("ordermgmt_mercari_order_pull"), ["pull_shop_orders", "reconcile_order_lifecycle"]);
});

test("accepts drained disabled ownership with no execution or ambiguity", () => {
  const result = validateWorkloadQuiescence({
    ownership, phaseRuns: [{ run_id: "old", started_at: "2026-09-07T10:50:00Z", ended_at: "2026-09-07T11:02:00Z" }],
    lease: null, openOperations: [], shadowAcceptance: { ok: true },
    workloadId: ownership.workload_id, now, drainMinutes: 40,
  });
  assert.equal(result.ok, true);
});

test("fails on fresh disable, post-disable dispatch, active lease, open operations, or missing shadow acceptance", () => {
  const result = validateWorkloadQuiescence({
    ownership: { ...ownership, evidence_observed_at: "2026-09-07T11:50:00Z" },
    phaseRuns: [{ run_id: "new", started_at: "2026-09-07T11:55:00Z", ended_at: null }],
    lease: { run_id: "active" }, openOperations: [{ status: "UNKNOWN_RESULT" }], shadowAcceptance: { ok: false },
    workloadId: ownership.workload_id, now, drainMinutes: 40,
  });
  assert.equal(result.ok, false);
  for (const expected of ["drain_interval_incomplete", "legacy_run_not_terminal:new", "legacy_dispatch_after_disable:new", "orchestrator_lease_active", "open_external_operations", "target_release_shadow_not_accepted"]) {
    assert.ok(result.failures.includes(expected));
  }
});

test("quiescence CLI requires scoped workload and exact target identity", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseArgs(["--workload-id", ownership.workload_id, "--release-version", sha, "--runtime-host", "vps", "--drain-minutes", "60"]), {
    drainMinutes: 60, help: false, workloadId: ownership.workload_id, releaseVersion: sha, runtimeHost: "vps",
  });
  assert.throws(() => parseArgs(["--workload-id", ownership.workload_id, "--release-version", "main", "--runtime-host", "vps"]), /exact_release/);
});
