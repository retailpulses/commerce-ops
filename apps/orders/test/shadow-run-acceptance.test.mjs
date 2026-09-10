import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_PIPELINE_DAG } from "../src/orchestrator.mjs";
import { validateShadowRunAcceptance } from "../src/lib/shadow-run-acceptance.mjs";
import { parseArgs } from "../scripts/verify-orchestrator-shadow-run.mjs";

const sha = "a".repeat(40);
const run = {
  run_id: "run-shadow", owner_id: "vps-order:123", release_version: sha,
  execution_mode: "shadow", status: "SUCCEEDED", ended_at: "2026-09-07T00:01:00Z",
};
const steps = ORDER_PIPELINE_DAG.map((unit, sequence) => ({
  run_id: run.run_id, step_name: unit.name, sequence,
  status: unit.shadow === "skip" ? "SKIPPED" : "SUCCEEDED",
  ended_at: "2026-09-07T00:01:00Z",
  result_counts: unit.shadow === "skip" ? { shadow_external_or_business_write: unit.phases.length } : {},
}));

test("accepts an exact terminal shadow run with released lease and zero legacy audit writes", () => {
  const result = validateShadowRunAcceptance({ run, steps, lease: null, legacyAuditRows: [], releaseVersion: sha, runtimeHost: "vps-order" });
  assert.equal(result.ok, true);
  assert.equal(result.observed_steps, ORDER_PIPELINE_DAG.length);
});

test("fails closed on identity, terminal, step, skip, lease, or audit drift", () => {
  const result = validateShadowRunAcceptance({
    run: { ...run, status: "PARTIAL", owner_id: "other:1" },
    steps: steps.map((step, index) => index === 0 ? { ...step, status: "FAILED" } : step).slice(0, -1),
    lease: { run_id: run.run_id }, legacyAuditRows: [{ id: "unexpected" }], releaseVersion: "b".repeat(40), runtimeHost: "vps-order",
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("release_mismatch"));
  assert.ok(result.failures.includes("owner_host_mismatch"));
  assert.ok(result.failures.includes("lease_not_released"));
  assert.ok(result.failures.includes("shadow_wrote_pipeline_run_log"));
  assert.ok(result.failures.some((failure) => failure.startsWith("missing_step:")));
});

test("CLI requires exact release identity and bounded lookback", () => {
  assert.deepEqual(parseArgs(["--release-version", sha, "--runtime-host", "vps-order", "--since-minutes", "30"]), {
    sinceMinutes: 30, runId: "", help: false, releaseVersion: sha, runtimeHost: "vps-order",
  });
  assert.throws(() => parseArgs(["--release-version", "main", "--runtime-host", "vps-order"]), /exact_release/);
  assert.throws(() => parseArgs(["--release-version", sha]), /runtime_host_required/);
  assert.throws(() => parseArgs(["--release-version", sha, "--runtime-host", "vps-order", "--since-minutes", "0"]), /invalid_since/);
});
