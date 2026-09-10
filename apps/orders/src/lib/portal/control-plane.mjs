import { createBaserowClient } from "../db.mjs";
import { isShippedNotClosedCandidate } from "../pipeline-health.mjs";

const ROW_LIMIT = 5001;
const OPERATION_OPEN_STATUSES = new Set(["RESERVED", "UNKNOWN_RESULT", "DEFINITIVE_FAILURE"]);

function text(value) {
  return String(value ?? "").trim();
}

function isoOrNull(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function normalizeOrderId(value) {
  return text(value).replace(/^order_/, "");
}

function orderScopeKey(row, defaultChannel = "") {
  const channel = text(row.sales_channel || defaultChannel).toLowerCase();
  const store = text(row.source_store_id || row.shop_id).toLowerCase();
  const orderId = normalizeOrderId(row.order_id).toLowerCase();
  return channel && store && orderId ? `${channel}\u0000${store}\u0000${orderId}` : "";
}

function distinctOrders(rows, defaultChannel = "") {
  return new Set(rows.map((row) => orderScopeKey(row, defaultChannel)).filter(Boolean)).size;
}

function bounded(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return { rows: list.slice(0, ROW_LIMIT - 1), truncated: list.length >= ROW_LIMIT };
}

function groupOperations(rows) {
  const counts = {};
  for (const row of rows) {
    const capability = text(row.capability) || "unknown";
    const status = text(row.status) || "unknown";
    counts[capability] ||= {};
    counts[capability][status] = (counts[capability][status] || 0) + 1;
  }
  return counts;
}

export function buildControlPlaneSnapshot(input, env = {}, now = new Date()) {
  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  const runs = bounded(input.runs).rows;
  const steps = bounded(input.steps).rows;
  const leases = bounded(input.leases).rows;
  const watermarkResult = bounded(input.watermarks);
  const watermarks = watermarkResult.rows;
  const operations = bounded(input.operations);
  const sales = bounded(input.sales);
  const shipments = bounded(input.shipments);
  const ownership = bounded(input.ownership);
  const latestRun = runs[0] || null;
  const activeLease = leases.find((row) => {
    const heartbeat = Date.parse(text(row.heartbeat_at));
    const expiry = Date.parse(text(row.expires_at));
    return Number.isFinite(heartbeat) && heartbeat <= nowMs && expiry > nowMs;
  }) || null;
  const activeRun = activeLease
    ? runs.find((row) => text(row.run_id) === text(activeLease.run_id)) || null
    : null;
  const freshnessMinutes = Number.parseInt(text(env.ORDER_LIFECYCLE_FRESHNESS_MINUTES || "180"), 10) || 180;

  const lifecycle = watermarks.map((row) => {
    const completedAt = isoOrNull(row.completed_at);
    const ageMinutes = completedAt ? Math.max(0, Math.floor((nowMs - Date.parse(completedAt)) / 60000)) : null;
    const stale = text(row.completion_state) !== "accounting_complete"
      || ageMinutes === null
      || ageMinutes > freshnessMinutes;
    return {
      platform: text(row.platform),
      source_store_id: text(row.source_store_id),
      completion_state: text(row.completion_state),
      completed_at: completedAt,
      observed_at: isoOrNull(row.observed_at),
      age_minutes: ageMinutes,
      stale,
      run_id: text(row.run_id) || null,
      failed: Number(row.failed || 0),
    };
  });

  const shipmentOrderScopes = new Set(shipments.rows.map((row) => orderScopeKey(row, "mercari")).filter(Boolean));
  const approvedWaiting = sales.rows.filter((row) =>
    text(row.order_status) === "WAITING_FOR_SHIPPING"
    && ["APPROVED", "AUTO_APPROVED"].includes(text(row.review_status))
  );
  const missingProjection = approvedWaiting.filter((row) => !shipmentOrderScopes.has(orderScopeKey(row, "mercari")));
  const unsynced = shipments.rows.filter((row) =>
    !["SYNCED", "ALREADY_EXISTS"].includes(text(row.giga_sync_status))
  );
  const closeBacklog = sales.rows.filter(isShippedNotClosedCandidate);

  const partialSteps = steps.filter((row) => ["BLOCKED", "FAILED"].includes(text(row.status)));
  const openOperations = operations.rows.filter((row) => OPERATION_OPEN_STATUSES.has(text(row.status)));
  const liveEnabled = isTrue(env.ORCHESTRATOR_LIVE_ENABLED);
  const liveOwnershipProven = Boolean(
    activeLease && activeRun
    && text(activeRun.execution_mode) === "live"
    && text(activeRun.owner_id) === text(activeLease.owner_id)
  );
  const ownershipRows = ownership.rows.map((row) => ({
    workload_id: text(row.workload_id),
    scheduler_owner: text(row.scheduler_owner),
    runtime_host: text(row.runtime_host),
    release_version: text(row.release_version) || null,
    kill_switch_state: text(row.kill_switch_state),
    legacy_scheduler_disabled: row.legacy_scheduler_disabled === true,
    evidence_ref: text(row.evidence_ref),
    evidence_observed_at: isoOrNull(row.evidence_observed_at),
    verified_at: isoOrNull(row.verified_at),
    expires_at: isoOrNull(row.expires_at),
    current: Date.parse(text(row.expires_at)) > nowMs,
  }));
  const latestRunHealthy = Boolean(latestRun && text(latestRun.status) === "SUCCEEDED");
  const pipelineAttention = !latestRunHealthy || lifecycle.some((row) => row.stale)
    || partialSteps.length > 0 || openOperations.length > 0;

  return {
    ok: true,
    contract_version: 1,
    generated_at: generatedAt,
    release: {
      sha: /^[0-9a-f]{40}$/.test(text(env.RELEASE_SHA)) ? text(env.RELEASE_SHA) : null,
      built_at: isoOrNull(env.RELEASE_BUILT_AT),
    },
    scheduler: {
      target_owner: "vps_order_orchestrator",
      active_live_executor: liveOwnershipProven ? text(activeLease.owner_id) : null,
      active_live_executor_evidence: liveOwnershipProven ? "matching_live_run_database_lease" : "unverified",
      active_executor_mode: activeRun ? text(activeRun.execution_mode) : null,
      workload_ownership: ownershipRows,
      ownership_truncated: ownership.truncated,
      portal_process_live_flag: liveEnabled,
      production_kill_switch_state: "unverified",
      warning: "An active shadow lease is not production ownership. Portal process configuration proves neither orchestrator service configuration nor Cloudflare trigger retirement.",
    },
    lease: activeLease ? {
      lease_name: text(activeLease.lease_name), owner_id: text(activeLease.owner_id),
      run_id: text(activeLease.run_id), release_version: text(activeLease.release_version) || null,
      heartbeat_at: isoOrNull(activeLease.heartbeat_at), expires_at: isoOrNull(activeLease.expires_at), active: true,
    } : { active: false },
    latest_run: latestRun ? {
      run_id: text(latestRun.run_id), status: text(latestRun.status),
      execution_mode: text(latestRun.execution_mode), owner_id: text(latestRun.owner_id),
      release_version: text(latestRun.release_version) || null,
      started_at: isoOrNull(latestRun.started_at), ended_at: isoOrNull(latestRun.ended_at),
    } : null,
    failed_or_blocked_steps: partialSteps.slice(0, 20).map((row) => ({
      run_id: text(row.run_id), step_name: text(row.step_name), status: text(row.status),
      error_code: text(row.error_code) || null, ended_at: isoOrNull(row.ended_at),
    })),
    lifecycle: { freshness_sla_minutes: freshnessMinutes, watermarks: lifecycle, truncated: watermarkResult.truncated },
    external_operations: {
      open_count: openOperations.length,
      counts_by_capability: groupOperations(openOperations),
      truncated: operations.truncated,
    },
    workload_backlog: {
      pending_review_orders: distinctOrders(sales.rows.filter((row) => text(row.review_status) === "PENDING_REVIEW"), "mercari"),
      missing_projection_orders: distinctOrders(missingProjection, "mercari"),
      unsynced_projection_orders: distinctOrders(unsynced, "mercari"),
      shipped_not_closed_orders: distinctOrders(closeBacklog, "mercari"),
      truncated: sales.truncated || shipments.truncated,
    },
    health: {
      pipeline_state: pipelineAttention ? "ATTENTION" : "HEALTHY",
      governance_state: ownershipRows.length > 0 && ownershipRows.every((row) => row.current)
        ? "OWNERSHIP_EVIDENCE_CURRENT" : "PRODUCTION_OWNER_UNVERIFIED",
      state: pipelineAttention || ownershipRows.length === 0 || ownershipRows.some((row) => !row.current) ? "ATTENTION" : "HEALTHY",
    },
  };
}

async function query(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`control_plane_${label}_query_failed:${error.message}`);
  return data || [];
}

export async function handlePortalControlPlane(env, now = new Date(), injectedClient = null) {
  const client = injectedClient || createBaserowClient(env);
  if (client.type !== "supabase") throw new Error("control_plane_requires_supabase");
  const sb = client.supabase;
  const [runs, steps, leases, watermarks, operations, sales, shipments, ownership] = await Promise.all([
    query(sb.from("pipeline_orchestration_runs").select("run_id,owner_id,release_version,execution_mode,status,started_at,ended_at").order("started_at", { ascending: false }).limit(20), "runs"),
    query(sb.from("pipeline_steps").select("run_id,step_name,status,error_code,ended_at").in("status", ["BLOCKED", "FAILED"]).order("ended_at", { ascending: false }).limit(20), "steps"),
    query(sb.from("order_orchestrator_lease").select("lease_name,owner_id,run_id,release_version,heartbeat_at,expires_at").eq("lease_name", "ordermgmt-primary").limit(1), "lease"),
    query(sb.from("order_lifecycle_watermarks").select("platform,source_store_id,completion_state,completed_at,observed_at,run_id,failed").order("platform").order("source_store_id").limit(ROW_LIMIT), "watermarks"),
    query(sb.from("external_operation_attempts").select("capability,status").in("status", [...OPERATION_OPEN_STATUSES]).limit(ROW_LIMIT), "operations"),
    query(sb.from("sales_orders").select("id,order_id,sales_channel,source_store_id,order_status,review_status,shipping_completed_at,shop_close_status").eq("sales_channel", "mercari").order("id").limit(ROW_LIMIT), "sales"),
    query(sb.from("giga_shipment_projections").select("id,order_id,sales_channel,source_store_id,giga_sync_status").eq("sales_channel", "Mercari").order("id").limit(ROW_LIMIT), "shipments"),
    query(sb.from("order_scheduler_ownership").select("workload_id,scheduler_owner,runtime_host,release_version,kill_switch_state,legacy_scheduler_disabled,evidence_ref,evidence_observed_at,verified_at,expires_at").order("workload_id").limit(ROW_LIMIT), "ownership"),
  ]);
  return buildControlPlaneSnapshot({ runs, steps, leases, watermarks, operations, sales, shipments, ownership }, env, now);
}
