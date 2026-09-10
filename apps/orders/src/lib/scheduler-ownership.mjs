const OWNERS = new Set(["cloudflare_worker", "vps_order_orchestrator", "vps_reporting_timer", "disabled"]);
const KILL_SWITCH_STATES = new Set(["enabled", "disabled", "unverified"]);

function text(value) { return String(value ?? "").trim(); }

export function validateSchedulerOwnership(input, now = new Date()) {
  const value = {
    workloadId: text(input.workloadId),
    expectedOwner: input.expectedOwner == null || text(input.expectedOwner).toLowerCase() === "absent" ? null : text(input.expectedOwner),
    schedulerOwner: text(input.schedulerOwner), runtimeHost: text(input.runtimeHost),
    releaseVersion: text(input.releaseVersion) || null,
    killSwitchState: text(input.killSwitchState), legacySchedulerDisabled: input.legacySchedulerDisabled === true,
    evidenceRef: text(input.evidenceRef), evidenceObservedAt: text(input.evidenceObservedAt),
    verifiedBy: text(input.verifiedBy), expiresAt: text(input.expiresAt),
  };
  const observed = Date.parse(value.evidenceObservedAt);
  const expires = Date.parse(value.expiresAt);
  if (value.workloadId.length < 3 || !OWNERS.has(value.schedulerOwner)
      || (value.expectedOwner && !OWNERS.has(value.expectedOwner))
      || value.runtimeHost.length < 2 || !KILL_SWITCH_STATES.has(value.killSwitchState)
      || value.evidenceRef.length < 3 || value.verifiedBy.length < 2
      || !Number.isFinite(observed) || !Number.isFinite(expires)
      || observed > now.getTime() + 5 * 60_000 || observed < now.getTime() - 86400_000
      || expires <= now.getTime() || expires > now.getTime() + 8 * 86400_000
      || (value.schedulerOwner === "disabled" && value.killSwitchState !== "disabled")
      || (value.schedulerOwner === "vps_order_orchestrator"
        && (!value.legacySchedulerDisabled || !["disabled", "vps_order_orchestrator"].includes(value.expectedOwner)))) {
    throw new Error("scheduler_ownership_input_invalid");
  }
  return value;
}

export async function getSchedulerOwnership(supabase, workloadId) {
  const { data, error } = await supabase.from("order_scheduler_ownership")
    .select("workload_id,scheduler_owner,runtime_host,release_version,kill_switch_state,legacy_scheduler_disabled,evidence_ref,evidence_observed_at,verified_by,verified_at,expires_at")
    .eq("workload_id", workloadId).maybeSingle();
  if (error) throw new Error(`scheduler_ownership_read_failed:${error.message}`);
  return data || null;
}

export async function recordSchedulerOwnership(supabase, input) {
  const value = validateSchedulerOwnership(input);
  const { data, error } = await supabase.rpc("record_order_scheduler_ownership", {
    p_workload_id: value.workloadId, p_expected_owner: value.expectedOwner,
    p_scheduler_owner: value.schedulerOwner, p_runtime_host: value.runtimeHost,
    p_release_version: value.releaseVersion, p_kill_switch_state: value.killSwitchState,
    p_legacy_scheduler_disabled: value.legacySchedulerDisabled,
    p_evidence_ref: value.evidenceRef, p_evidence_observed_at: value.evidenceObservedAt,
    p_verified_by: value.verifiedBy, p_expires_at: value.expiresAt,
  });
  if (error) throw new Error(`scheduler_ownership_write_failed:${error.message}`);
  const returned = Array.isArray(data) ? data[0] : data;
  const readback = await getSchedulerOwnership(supabase, value.workloadId);
  if (!returned || !readback || readback.scheduler_owner !== value.schedulerOwner
      || readback.evidence_ref !== value.evidenceRef
      || Date.parse(readback.expires_at) !== Date.parse(value.expiresAt)) {
    throw new Error("scheduler_ownership_readback_mismatch");
  }
  const { data: events, error: eventError } = await supabase.from("order_scheduler_ownership_events")
    .select("id,workload_id,previous_owner,scheduler_owner,evidence_ref,recorded_at")
    .eq("workload_id", value.workloadId).eq("evidence_ref", value.evidenceRef)
    .order("recorded_at", { ascending: false }).limit(1);
  if (eventError || !Array.isArray(events) || events.length !== 1) {
    throw new Error(`scheduler_ownership_audit_readback_failed:${eventError?.message || "missing_event"}`);
  }
  return { ownership: readback, event: events[0] };
}
