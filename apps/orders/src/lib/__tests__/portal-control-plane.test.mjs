import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlaneSnapshot, handlePortalControlPlane } from "../portal/control-plane.mjs";

const NOW = new Date("2026-09-07T12:00:00.000Z");

test("control plane separates target ownership from runtime evidence", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [], steps: [], leases: [], watermarks: [], operations: [], sales: [], shipments: [],
  }, { ORCHESTRATOR_LIVE_ENABLED: "false", RELEASE_SHA: "a".repeat(40) }, NOW);

  assert.equal(snapshot.scheduler.target_owner, "vps_order_orchestrator");
  assert.equal(snapshot.scheduler.active_live_executor, null);
  assert.equal(snapshot.scheduler.active_live_executor_evidence, "unverified");
  assert.equal(snapshot.scheduler.production_kill_switch_state, "unverified");
  assert.equal(snapshot.health.state, "ATTENTION");
});

test("control plane exposes active lease, stale watermarks, operations, and distinct backlog", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [{ run_id: "run-1", owner_id: "vps-1", status: "PARTIAL", execution_mode: "shadow", started_at: "2026-09-07T11:55:00Z" }],
    steps: [{ run_id: "run-1", step_name: "reconcile", status: "FAILED", error_code: "timeout", ended_at: "2026-09-07T11:59:00Z" }],
    leases: [{ lease_name: "order-pipeline", owner_id: "vps-1", run_id: "run-1", heartbeat_at: "2026-09-07T11:59:00Z", expires_at: "2026-09-07T12:05:00Z" }],
    watermarks: [{ platform: "mercari", source_store_id: "shop-1", completion_state: "accounting_complete", completed_at: "2026-09-07T08:00:00Z", observed_at: "2026-09-07T07:59:00Z", run_id: "run-1", failed: 0 }],
    operations: [
      { capability: "mercari_close", status: "UNKNOWN_RESULT" },
      { capability: "mercari_close", status: "RESERVED" },
      { capability: "giga_push", status: "DEFINITIVE_FAILURE" },
    ],
    sales: [
      { order_id: "o1", source_store_id: "shop-1", order_status: "WAITING_FOR_SHIPPING", review_status: "APPROVED" },
      { order_id: "o1", source_store_id: "shop-1", order_status: "WAITING_FOR_SHIPPING", review_status: "APPROVED" },
      { order_id: "o2", source_store_id: "shop-1", order_status: "WAITING_FOR_SHIPPING", review_status: "PENDING_REVIEW", shipping_completed_at: "2026-09-07T10:00:00Z" },
    ],
    shipments: [{ order_id: "o3", source_store_id: "shop-1", giga_sync_status: "ERROR" }],
  }, { ORCHESTRATOR_LIVE_ENABLED: "true", ORDER_LIFECYCLE_FRESHNESS_MINUTES: "180" }, NOW);

  assert.equal(snapshot.scheduler.active_live_executor, null);
  assert.equal(snapshot.scheduler.active_live_executor_evidence, "unverified");
  assert.equal(snapshot.scheduler.active_executor_mode, "shadow");
  assert.equal(snapshot.lifecycle.watermarks[0].stale, true);
  assert.equal(snapshot.external_operations.open_count, 3);
  assert.deepEqual(snapshot.external_operations.counts_by_capability.mercari_close, { UNKNOWN_RESULT: 1, RESERVED: 1 });
  assert.equal(snapshot.workload_backlog.missing_projection_orders, 1);
  assert.equal(snapshot.workload_backlog.pending_review_orders, 1);
  assert.equal(snapshot.workload_backlog.unsynced_projection_orders, 1);
  assert.equal(snapshot.workload_backlog.shipped_not_closed_orders, 1);
  assert.equal(snapshot.failed_or_blocked_steps.length, 1);
});

test("expired lease never proves current scheduler ownership", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [], steps: [],
    leases: [{ lease_name: "order-pipeline", owner_id: "vps-1", run_id: "old", expires_at: "2026-09-07T11:59:59Z" }],
    watermarks: [], operations: [], sales: [], shipments: [],
  }, {}, NOW);
  assert.equal(snapshot.lease.active, false);
  assert.equal(snapshot.scheduler.active_live_executor, null);
});

test("only a matching active live run proves transient VPS production execution", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [{ run_id: "live-1", owner_id: "vps-1", execution_mode: "live", status: "RUNNING", started_at: "2026-09-07T11:59:00Z" }],
    steps: [],
    leases: [{ lease_name: "order-pipeline", owner_id: "vps-1", run_id: "live-1", heartbeat_at: "2026-09-07T11:59:30Z", expires_at: "2026-09-07T12:05:00Z" }],
    watermarks: [], operations: [], sales: [], shipments: [],
  }, {}, NOW);
  assert.equal(snapshot.scheduler.active_live_executor, "vps-1");
  assert.equal(snapshot.scheduler.active_live_executor_evidence, "matching_live_run_database_lease");
});

test("backlog joins normalized Mercari order ids and counts multi-line orders once", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [], steps: [], leases: [], watermarks: [], operations: [],
    sales: [
      { order_id: "order_m-1", source_store_id: "shop-1", order_status: "WAITING_FOR_SHIPPING", review_status: "APPROVED" },
      { order_id: "order_m-1", source_store_id: "shop-1", order_status: "WAITING_FOR_SHIPPING", review_status: "APPROVED" },
    ],
    shipments: [{ order_id: "m-1", source_store_id: "shop-1", giga_sync_status: "SYNCED" }],
  }, {}, NOW);
  assert.equal(snapshot.workload_backlog.missing_projection_orders, 0);
});

test("same-number shipment in another shop cannot hide a missing projection", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [], steps: [], leases: [], watermarks: [], operations: [],
    sales: [
      { order_id: "order_same", source_store_id: "shop-1", order_status: "WAITING_FOR_SHIPPING", review_status: "APPROVED" },
      { order_id: "order_same", source_store_id: "shop-2", order_status: "WAITING_FOR_SHIPPING", review_status: "APPROVED" },
    ],
    shipments: [{ order_id: "same", source_store_id: "shop-1", giga_sync_status: "SYNCED" }],
  }, {}, NOW);
  assert.equal(snapshot.workload_backlog.missing_projection_orders, 1);
});

test("future heartbeat cannot prove a live executor even when lease expiry is future", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [{ run_id: "live-1", owner_id: "vps-1", execution_mode: "live", status: "RUNNING" }],
    steps: [],
    leases: [{ owner_id: "vps-1", run_id: "live-1", heartbeat_at: "2026-09-07T12:01:00Z", expires_at: "2026-09-07T12:05:00Z" }],
    watermarks: [], operations: [], sales: [], shipments: [],
  }, {}, NOW);
  assert.equal(snapshot.scheduler.active_live_executor, null);
});

test("unexpired registry evidence is the durable workload scheduler fact", () => {
  const snapshot = buildControlPlaneSnapshot({
    runs: [{ run_id: "done", owner_id: "vps-1", execution_mode: "live", status: "SUCCEEDED" }],
    steps: [], leases: [], watermarks: [], operations: [], sales: [], shipments: [],
    ownership: [{
      workload_id: "ordermgmt_mercari_order_pull", scheduler_owner: "vps_order_orchestrator",
      runtime_host: "conoha-vps", kill_switch_state: "enabled", legacy_scheduler_disabled: true,
      evidence_ref: "cf-trigger-readback:123", evidence_observed_at: "2026-09-07T11:55:00Z",
      verified_at: "2026-09-07T11:56:00Z", expires_at: "2026-09-08T12:00:00Z",
    }],
  }, {}, NOW);
  assert.equal(snapshot.scheduler.workload_ownership[0].current, true);
  assert.equal(snapshot.scheduler.workload_ownership[0].scheduler_owner, "vps_order_orchestrator");
  assert.equal(snapshot.health.governance_state, "OWNERSHIP_EVIDENCE_CURRENT");
});

test("query layer scopes canonical lease and Mercari backlog deterministically", async () => {
  const calls = [];
  const tables = {
    pipeline_orchestration_runs: [], pipeline_steps: [], order_orchestrator_lease: [],
    order_lifecycle_watermarks: [], external_operation_attempts: [], sales_orders: [], giga_shipment_projections: [],
  };
  function builder(table) {
    const chain = {
      select(columns) { calls.push([table, "select", columns]); return chain; },
      order(column) { calls.push([table, "order", column]); return chain; },
      limit(limit) { calls.push([table, "limit", limit]); return chain; },
      eq(column, value) { calls.push([table, "eq", column, value]); return chain; },
      in(column, values) { calls.push([table, "in", column, values]); return chain; },
      then(resolve) { return Promise.resolve({ data: tables[table], error: null }).then(resolve); },
    };
    return chain;
  }
  await handlePortalControlPlane({}, NOW, { type: "supabase", supabase: { from: (table) => builder(table) } });
  assert.ok(calls.some((call) => call[0] === "order_orchestrator_lease" && call[1] === "eq" && call[2] === "lease_name" && call[3] === "ordermgmt-primary"));
  assert.ok(calls.some((call) => call[0] === "sales_orders" && call[1] === "eq" && call[2] === "sales_channel" && call[3] === "mercari"));
  assert.ok(calls.some((call) => call[0] === "giga_shipment_projections" && call[1] === "eq" && call[2] === "sales_channel" && call[3] === "Mercari"));
  assert.ok(calls.some((call) => call[0] === "sales_orders" && call[1] === "order" && call[2] === "id"));
});
