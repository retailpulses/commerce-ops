import assert from "node:assert/strict";
import test from "node:test";
import { evaluateShadowParity, SHADOW_EXECUTED_STEPS, SHADOW_SKIPPED_STEPS } from "../src/lib/shadow-parity.mjs";
import { parseArgs } from "../scripts/audit-orchestrator-shadow-parity.mjs";

function fixture({ days = 7, runsPerDay = 2, runStatus = "SUCCEEDED", mutateSteps } = {}) {
  const now = new Date("2026-09-08T03:00:00Z");
  const runs = [];
  const steps = [];
  for (let day = days; day >= 1; day--) {
    for (let index = 0; index < runsPerDay; index++) {
      const started = new Date(now.getTime() - day * 86400000 + index * 3600000);
      const runId = `run-${day}-${index}`;
      runs.push({ run_id: runId, execution_mode: "shadow", status: runStatus, started_at: started.toISOString(), ended_at: started.toISOString() });
      for (const step of SHADOW_EXECUTED_STEPS) steps.push({ run_id: runId, step_name: step, status: "SUCCEEDED" });
      for (const step of SHADOW_SKIPPED_STEPS) steps.push({ run_id: runId, step_name: step, status: "SKIPPED" });
    }
  }
  mutateSteps?.(steps);
  return { now, runs, steps };
}

test("accepts only seven complete JST days with full run and step coverage", () => {
  const data = fixture();
  const result = evaluateShadowParity({ ...data, days: 7, minRunsPerDay: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.qualifying_days, 7);
  assert.equal(result.completion_state, "shadow_window_healthy");
  assert.equal(result.parity_proven, false);
});

test("fails closed on insufficient cadence, failed runs, missing steps, or executed writes", () => {
  const insufficient = fixture({ runsPerDay: 1 });
  assert.equal(evaluateShadowParity({ ...insufficient, minRunsPerDay: 2 }).ok, false);
  const failed = fixture({ runStatus: "PARTIAL" });
  assert.equal(evaluateShadowParity({ ...failed, minRunsPerDay: 2 }).ok, false);
  const missing = fixture({ mutateSteps: (steps) => steps.splice(steps.findIndex((step) => step.step_name === "integrity_audit"), 1) });
  assert.equal(evaluateShadowParity({ ...missing, minRunsPerDay: 2 }).ok, false);
  const wrote = fixture({ mutateSteps: (steps) => { steps.find((step) => step.step_name === "mercari_close").status = "SUCCEEDED"; } });
  assert.equal(evaluateShadowParity({ ...wrote, minRunsPerDay: 2 }).ok, false);
});

test("argument parser is bounded and rejects unknown options", () => {
  assert.deepEqual(parseArgs(["--days", "9", "--min-runs-per-day", "18"]), { days: 9, minRunsPerDay: 18, help: false });
  assert.throws(() => parseArgs(["--days", "0"]), /invalid_days/);
  assert.throws(() => parseArgs(["--min-runs-per-day", "25"]), /invalid_min_runs_per_day/);
  assert.throws(() => parseArgs(["--write"]), /unknown_argument/);
});
