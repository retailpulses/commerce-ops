import { PHASE_WORKLOAD_IDS } from "./scheduler-runtime-fence.mjs";

export function phasesForWorkload(workloadId) {
  return Object.entries(PHASE_WORKLOAD_IDS).filter(([, value]) => value === workloadId).map(([phase]) => phase);
}

export function validateWorkloadQuiescence({ ownership, phaseRuns = [], lease, openOperations = [], shadowAcceptance, workloadId, now = new Date(), drainMinutes = 40 }) {
  const failures = [];
  const observedAt = Date.parse(ownership?.evidence_observed_at || "");
  if (!ownership) failures.push("ownership_missing");
  else {
    if (ownership.workload_id !== workloadId) failures.push("workload_mismatch");
    if (ownership.scheduler_owner !== "disabled") failures.push("owner_not_disabled");
    if (ownership.kill_switch_state !== "disabled") failures.push("kill_switch_not_disabled");
    if (!Number.isFinite(observedAt)) failures.push("disable_evidence_invalid");
    else if (now.getTime() - observedAt < drainMinutes * 60000) failures.push("drain_interval_incomplete");
    if (Date.parse(ownership.expires_at || "") <= now.getTime()) failures.push("disable_evidence_expired");
  }
  for (const run of phaseRuns) {
    const startedAt = Date.parse(run.started_at || "");
    if (!run.ended_at) failures.push(`legacy_run_not_terminal:${run.run_id || "unknown"}`);
    if (Number.isFinite(observedAt) && Number.isFinite(startedAt) && startedAt > observedAt) {
      failures.push(`legacy_dispatch_after_disable:${run.run_id || "unknown"}`);
    }
  }
  if (lease) failures.push("orchestrator_lease_active");
  if (openOperations.length) failures.push("open_external_operations");
  if (!shadowAcceptance?.ok) failures.push("target_release_shadow_not_accepted");
  return {
    ok: failures.length === 0,
    completion_state: failures.length ? "workload_not_quiescent" : "workload_quiescent",
    workload_id: workloadId,
    phases: phasesForWorkload(workloadId),
    drain_minutes: drainMinutes,
    legacy_runs_checked: phaseRuns.length,
    open_operations: openOperations.length,
    failures,
  };
}
