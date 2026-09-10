import { createBaserowClient, listAllRows } from "./db.mjs";
import { normalizeRmsOrderProgress } from "./rakuten-ingest.mjs";
import { runRakutenOrderStatusesViaRelay } from "./rakuten-relay.mjs";
import { persistLifecycleWatermark } from "./lifecycle-reconciler.mjs";

export const RAKUTEN_NON_TERMINAL_STATUSES = Object.freeze([
  "PENDING_CONFIRMATION", "WAITING_FOR_PAYMENT", "CONFIRMED", "RMS_CONFIRMED",
]);

const FORWARD_LOCAL = new Set(["CONFIRMED", "RMS_CONFIRMED"]);

export function planRakutenLifecycleTransition(currentStatus, mapping) {
  const current = String(currentStatus || "").trim().toUpperCase();
  if (!mapping || mapping.mappingState !== "MAPPED" || !mapping.status) {
    return { ok: false, reason: mapping?.mappingState === "MISSING" ? "missing_mapping" : "unknown_mapping" };
  }
  const target = String(mapping.status).toUpperCase();
  if (FORWARD_LOCAL.has(current) && target === "PENDING_CONFIRMATION") {
    return { ok: true, targetStatus: current, statusChanged: false, evidenceOnly: true, reason: "regression_guard" };
  }
  return { ok: true, targetStatus: target, statusChanged: current !== target, evidenceOnly: current === target };
}

export function resolveRakutenGroupTarget(rows, mapping) {
  const plans = (rows || []).map((row) => planRakutenLifecycleTransition(row.order_status, mapping));
  if (plans.some((plan) => !plan.ok)) return { ok: false, plans };
  const guarded = plans.some((plan) => plan.reason === "regression_guard");
  const targetStatus = guarded
    ? (rows.some((row) => String(row.order_status).toUpperCase() === "RMS_CONFIRMED") ? "RMS_CONFIRMED" : "CONFIRMED")
    : String(mapping.status).toUpperCase();
  return { ok: true, plans, targetStatus, statusChanged: rows.some((row) => String(row.order_status).toUpperCase() !== targetStatus) };
}

export async function reconcileRakutenLifecycle(env, options = {}) {
  const db = options._inject?.db || createBaserowClient(env);
  if (db.type !== "supabase") return { ok: false, completion_state: "failed", error: "rakuten_lifecycle_requires_supabase" };
  const loadRows = options._inject?.listAllRows || listAllRows;
  const fetchBatch = options._inject?.fetchBatch
    || ((batchEnv, orderIds) => fetchStatusBatch(batchEnv, orderIds, options.fetchOrderStatuses));
  const persistWatermark = options._inject?.persistWatermark || persistLifecycleWatermark;
  const rows = await loadRows(db, db.salesOrderTableId, {
    filter__field_sales_channel__equal: "rakuten",
    filter__field_order_status__single_select_equal: RAKUTEN_NON_TERMINAL_STATUSES,
  }, { select: "id,order_id,order_status,rakuten_order_progress,rakuten_status_mapping_state" });
  const selectedOrderId = normalizeOrderId(options.orderId || options.order_id);
  const allGroups = [...groupRows(rows).values()].filter((group) => !selectedOrderId || group.orderId === selectedOrderId);
  const requestedLimit = Number(options.limit);
  const boundedByLimit = requestedLimit > 0 && allGroups.length > requestedLimit;
  const bounded = boundedByLimit || Boolean(selectedOrderId);
  const groups = selectedOrderId ? allGroups.slice(0, 1) : (boundedByLimit ? allGroups.slice(0, requestedLimit) : allGroups);
  const counts = { candidates: groups.length, matched: 0, changed: 0, unchanged: 0, not_found: 0, failed: 0 };
  const observedAt = new Date().toISOString();

  for (let offset = 0; offset < groups.length; offset += 50) {
    const batch = groups.slice(offset, offset + 50);
    const resultById = await fetchBatch(env, batch.map((group) => group.orderId));
    for (const group of batch) {
      const order = resultById.get(group.orderId);
      if (order?.queryFailed) { counts.failed++; continue; }
      if (!order) { counts.not_found++; continue; }
      const mapping = normalizeRmsOrderProgress(order.orderProgress);
      const groupPlan = resolveRakutenGroupTarget(group.rows, mapping);
      if (!groupPlan.ok) { counts.failed++; continue; }
      counts.matched++;
      const targetStatuses = group.rows.map(() => groupPlan.targetStatus);
      const evidenceUnchanged = group.rows.every((row) =>
        String(row.rakuten_order_progress || "") === String(mapping.raw || "")
        && String(row.rakuten_status_mapping_state || "") === mapping.mappingState);
      if (!groupPlan.statusChanged && evidenceUnchanged) { counts.unchanged++; continue; }
      if (options.dryRun) { counts.changed++; continue; }
      const { data, error } = await db.supabase.rpc("reconcile_rakuten_order_status", {
        p_row_ids: group.rows.map((row) => row.id),
        p_expected_statuses: group.rows.map((row) => String(row.order_status)),
        p_target_statuses: targetStatuses,
        p_order_progress: mapping.raw,
        p_mapping_state: mapping.mappingState,
        p_observed_at: mapping.observedAt,
      });
      if (!error && Number(data) === group.rows.length) counts.changed++;
      else counts.failed++;
    }
  }

  if (selectedOrderId && groups.length === 0) {
    return { ok: false, completion_state: "scoped_candidate_not_found", order_filter: selectedOrderId, counts };
  }
  const scopedComplete = Boolean(selectedOrderId) && counts.failed === 0 && counts.not_found === 0;
  const complete = !bounded && counts.failed === 0 && counts.not_found === 0;
  if (!options.dryRun && !selectedOrderId) {
    await persistWatermark(db.supabase, {
      platform: "rakuten", source_store_id: "Rakuten",
      completion_state: complete ? "accounting_complete" : "partial",
      observed_at: observedAt, completed_at: new Date().toISOString(),
      run_id: options.runId || `rakuten_lifecycle_${Date.now()}`,
      release_version: env.RELEASE_VERSION || null, ...counts,
    });
  }
  return { ok: complete || scopedComplete, completion_state: complete ? "accounting_complete" : (scopedComplete ? "scoped_complete" : "partial"), order_filter: selectedOrderId || null, counts };
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const orderId = normalizeOrderId(row.order_id);
    if (!orderId) continue;
    if (!groups.has(orderId)) groups.set(orderId, { orderId, rows: [] });
    groups.get(orderId).rows.push(row);
  }
  return groups;
}

function normalizeOrderId(value) { return String(value || "").trim().replace(/^order_/, ""); }

async function fetchStatusBatch(env, orderIds, reader = runRakutenOrderStatusesViaRelay) {
  const relay = await reader(env, { orderNumbers: orderIds });
  if (relay.ok && Array.isArray(relay.body?.orders)) {
    return new Map(relay.body.orders.map((order) => [normalizeOrderId(order.orderNumber || order.orderNo || order.orderId), order]));
  }
  if (orderIds.length === 1) return new Map([[orderIds[0], { queryFailed: true }]]);
  const middle = Math.ceil(orderIds.length / 2);
  const left = await fetchStatusBatch(env, orderIds.slice(0, middle), reader);
  const right = await fetchStatusBatch(env, orderIds.slice(middle), reader);
  return new Map([...left, ...right]);
}
