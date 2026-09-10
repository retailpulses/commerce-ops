import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export interface ControlPlaneSnapshot {
  generated_at: string;
  health: { state: "HEALTHY" | "ATTENTION"; pipeline_state: "HEALTHY" | "ATTENTION"; governance_state: string };
  release: { sha: string | null; built_at: string | null };
  scheduler: {
    target_owner: string;
    active_live_executor: string | null;
    active_live_executor_evidence: string;
    active_executor_mode: string | null;
    workload_ownership: Array<{ workload_id: string; scheduler_owner: string; runtime_host: string; release_version: string | null; kill_switch_state: string; legacy_scheduler_disabled: boolean; evidence_ref: string; evidence_observed_at: string | null; verified_at: string | null; expires_at: string | null; current: boolean }>;
    ownership_truncated: boolean;
    portal_process_live_flag: boolean;
    production_kill_switch_state: string;
    warning: string;
  };
  lease: { active: boolean; owner_id?: string; run_id?: string; heartbeat_at?: string; expires_at?: string };
  latest_run: null | { run_id: string; status: string; execution_mode: string; owner_id: string; started_at: string | null; ended_at: string | null };
  failed_or_blocked_steps: Array<{ run_id: string; step_name: string; status: string; error_code: string | null; ended_at: string | null }>;
  lifecycle: { freshness_sla_minutes: number; truncated: boolean; watermarks: Array<{ platform: string; source_store_id: string; completion_state: string; completed_at: string | null; age_minutes: number | null; stale: boolean; failed: number }> };
  external_operations: { open_count: number; counts_by_capability: Record<string, Record<string, number>>; truncated: boolean };
  workload_backlog: { pending_review_orders: number; missing_projection_orders: number; unsynced_projection_orders: number; shipped_not_closed_orders: number; truncated: boolean };
}

export function useControlPlaneQuery() {
  return useQuery({
    queryKey: ["control-plane"],
    queryFn: () => apiGet<ControlPlaneSnapshot>("/control-plane"),
    refetchInterval: 60_000,
  });
}
