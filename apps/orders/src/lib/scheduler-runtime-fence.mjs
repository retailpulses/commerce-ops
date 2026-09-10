const VPS_OWNER = "vps_order_orchestrator";
const CLOUDFLARE_OWNER = "cloudflare_worker";

export const PHASE_WORKLOAD_IDS = Object.freeze({
  sync_mercari_messages: "ordermgmt_mercari_message_sync",
  pull_shop_orders: "ordermgmt_mercari_order_pull",
  reconcile_order_lifecycle: "ordermgmt_mercari_order_pull",
  pull_rakuten_orders: "ordermgmt_rakuten_order_pull",
  reconcile_rakuten_lifecycle: "ordermgmt_rakuten_order_pull",
  auto_approve_orders: "ordermgmt_auto_approve_orders",
  build_giga_shipments: "ordermgmt_giga_shipment_build",
  confirm_rakuten_orders: "ordermgmt_rakuten_order_confirm",
  build_rakuten_shipments: "ordermgmt_rakuten_shipment_build",
  push_orders_to_giga: "ordermgmt_giga_order_push",
  push_rakuten_orders_to_giga: "ordermgmt_rakuten_order_push",
  pull_giga_tracking: "ordermgmt_giga_tracking_pull",
  sync_rakuten_tracking: "ordermgmt_rakuten_tracking_sync",
  close_shop_orders: "ordermgmt_shop_order_close",
  audit_pipeline_integrity: "ordermgmt_end_to_end_reconcile",
  reconcile_end_to_end: "ordermgmt_end_to_end_reconcile",
  reconcile_cancellations: "ordermgmt_cancellation_reconcile",
  send_payment_reminders: "ordermgmt_payment_reminder",
});

const OWNERSHIP_SELECT = "workload_id,scheduler_owner,runtime_host,release_version,kill_switch_state,legacy_scheduler_disabled,evidence_observed_at,expires_at";

export function workloadIdForPhase(phase) {
  return PHASE_WORKLOAD_IDS[String(phase || "").trim()] || null;
}

export async function readWorkloadOwnership(supabase, workloadId) {
  const { data, error } = await supabase.from("order_scheduler_ownership")
    .select(OWNERSHIP_SELECT).eq("workload_id", workloadId).maybeSingle();
  if (error) return { row: null, error: "scheduler_ownership_read_failed" };
  return { row: data || null, error: null };
}

export function validateVpsOwnership(row, { workloadId, release, runtimeHost, now = new Date(), maxEvidenceAgeMs = 24 * 60 * 60_000 }) {
  if (!workloadId || !release || release === "unknown" || !runtimeHost
      || /[<>]/.test(release) || /[<>]/.test(runtimeHost)) return "scheduler_ownership_identity_incomplete";
  if (!row) return "scheduler_ownership_missing";
  if (row.workload_id !== workloadId) return "scheduler_workload_mismatch";
  if (row.scheduler_owner !== VPS_OWNER) return "scheduler_owner_mismatch";
  if (row.runtime_host !== runtimeHost) return "scheduler_runtime_host_mismatch";
  if (row.release_version !== release) return "scheduler_release_mismatch";
  if (row.kill_switch_state !== "enabled") return "scheduler_not_enabled";
  if (row.legacy_scheduler_disabled !== true) return "legacy_scheduler_not_disabled";
  const observedAt = Date.parse(row.evidence_observed_at || "");
  if (!Number.isFinite(observedAt) || observedAt > now.getTime() + 5 * 60_000
      || observedAt < now.getTime() - maxEvidenceAgeMs) return "scheduler_ownership_evidence_stale";
  const expiresAt = Date.parse(row.expires_at || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return "scheduler_ownership_expired";
  return null;
}

export async function verifyVpsLiveOwnership(supabase, unit, context) {
  const workloadId = unit?.workloadId;
  if (!workloadId || !context?.release || context.release === "unknown" || !context?.runtimeHost) {
    return { ok: false, reason: "scheduler_ownership_identity_incomplete" };
  }
  const ownership = await readWorkloadOwnership(supabase, workloadId);
  if (ownership.error) return { ok: false, reason: ownership.error };
  const reason = validateVpsOwnership(ownership.row, { workloadId, ...context });
  return reason ? { ok: false, reason } : { ok: true };
}

export async function fenceCloudflareScheduledPhases(supabase, phases, { release, now = new Date() } = {}) {
  const allowed = [];
  const blocked = [];
  for (const phase of phases) {
    const workloadId = workloadIdForPhase(phase);
    if (!workloadId) {
      blocked.push({ phase, workload_id: null, reason: "scheduler_workload_unmapped" });
      continue;
    }
    const ownership = await readWorkloadOwnership(supabase, workloadId);
    if (ownership.error) {
      blocked.push({ phase, workload_id: workloadId, reason: ownership.error });
      continue;
    }
    const row = ownership.row;
    // Unregistered rows preserve the pre-cutover Cloudflare owner. Once a row
    // exists, it is the durable fence and must explicitly authorize this Worker.
    if (!row) {
      allowed.push(phase);
      continue;
    }
    const expiresAt = Date.parse(row.expires_at || "");
    const observedAt = Date.parse(row.evidence_observed_at || "");
    const reason = row.scheduler_owner !== CLOUDFLARE_OWNER ? "scheduler_owner_transferred"
      : row.kill_switch_state !== "enabled" ? "scheduler_not_enabled"
        : row.release_version && row.release_version !== release ? "scheduler_release_mismatch"
          : !Number.isFinite(observedAt) || observedAt > now.getTime() + 5 * 60_000
            || observedAt < now.getTime() - 24 * 60 * 60_000 ? "scheduler_ownership_evidence_stale"
          : !Number.isFinite(expiresAt) || expiresAt <= now.getTime() ? "scheduler_ownership_expired"
            : null;
    if (reason) blocked.push({ phase, workload_id: workloadId, reason });
    else allowed.push(phase);
  }
  return { allowed, blocked };
}
