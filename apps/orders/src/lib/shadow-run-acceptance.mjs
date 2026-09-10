import { ORDER_PIPELINE_DAG } from "../orchestrator.mjs";

export function validateShadowRunAcceptance({ run, steps, lease, legacyAuditRows, releaseVersion, runtimeHost }) {
  const failures = [];
  if (!run) failures.push("run_missing");
  else {
    if (run.execution_mode !== "shadow") failures.push("execution_mode_not_shadow");
    if (run.status !== "SUCCEEDED") failures.push(`run_status_${String(run.status || "missing").toLowerCase()}`);
    if (!run.ended_at) failures.push("run_not_terminal");
    if (run.release_version !== releaseVersion) failures.push("release_mismatch");
    if (!String(run.owner_id || "").startsWith(`${runtimeHost}:`)) failures.push("owner_host_mismatch");
  }
  const expected = new Map(ORDER_PIPELINE_DAG.map((unit, sequence) => [unit.name, { unit, sequence }]));
  const seen = new Set();
  for (const step of steps || []) {
    const definition = expected.get(step.step_name);
    if (!definition) { failures.push(`unexpected_step:${step.step_name}`); continue; }
    if (seen.has(step.step_name)) failures.push(`duplicate_step:${step.step_name}`);
    seen.add(step.step_name);
    if (Number(step.sequence) !== definition.sequence) failures.push(`sequence_mismatch:${step.step_name}`);
    const expectedStatus = definition.unit.shadow === "skip" ? "SKIPPED" : "SUCCEEDED";
    if (step.status !== expectedStatus) failures.push(`status_mismatch:${step.step_name}:${step.status || "missing"}`);
    if (!step.ended_at) failures.push(`step_not_terminal:${step.step_name}`);
    if (expectedStatus === "SKIPPED" && Number(step.result_counts?.shadow_external_or_business_write) !== definition.unit.phases.length) {
      failures.push(`skip_evidence_missing:${step.step_name}`);
    }
  }
  for (const name of expected.keys()) if (!seen.has(name)) failures.push(`missing_step:${name}`);
  if (lease) failures.push("lease_not_released");
  if ((legacyAuditRows || []).length) failures.push("shadow_wrote_pipeline_run_log");
  return {
    ok: failures.length === 0,
    completion_state: failures.length ? "shadow_run_not_accepted" : "shadow_run_accepted",
    run_id: run?.run_id || null,
    release_version: run?.release_version || null,
    owner_id: run?.owner_id || null,
    expected_steps: expected.size,
    observed_steps: (steps || []).length,
    failures,
  };
}
