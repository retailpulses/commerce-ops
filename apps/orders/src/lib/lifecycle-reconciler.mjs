import { createBaserowClient, listAllRows } from "./db.mjs";
import { runMercariOrderStatusesViaRelay } from "./mercari-relay.mjs";

const SHOP_IDS = Object.freeze({ Shop1: "WMyisFmhbGWyVAPEwsfirn", Shop2: "ZaMyGWzp6hUdgDh5E9ADob", Shop3: "2JGrmZqojnBMfdWrtP2xk3", Shop4: "2JMLHBxjiFHDr55jMwA7fs" });
const SHOP_LABEL_BY_ID = new Map(Object.entries(SHOP_IDS).map(([label, id]) => [id, label]));
const NON_TERMINAL = ["WAITING_FOR_PAYMENT", "WAITING_FOR_SHIPPING", "COMPLETING", "CANCELING"];
const KNOWN_STATUSES = new Set([...NON_TERMINAL, "COMPLETED", "CANCELED"]);

export function normalizeMercariLifecycleStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (status === "COMPLETING") return "COMPLETED";
  if (status === "CANCELING") return "CANCELED";
  return KNOWN_STATUSES.has(status) ? status : null;
}

export async function reconcileMercariLifecycle(env, options = {}) {
  const db = options._inject?.db || createBaserowClient(env);
  const loadRows = options._inject?.listAllRows || listAllRows;
  const persistWatermark = options._inject?.persistWatermark || persistLifecycleWatermark;
  if (db.type !== "supabase") return { ok: false, completion_state: "failed", error: "lifecycle_reconcile_requires_supabase" };
  const labels = (options.shops?.length ? options.shops : Object.keys(SHOP_IDS)).filter((shop) => SHOP_IDS[shop]);
  const shopIds = labels.map((shop) => SHOP_IDS[shop]);
  const rows = await loadRows(db, db.salesOrderTableId, {
    filter__field_sales_channel__equal: "mercari",
    filter__field_order_status__single_select_equal: NON_TERMINAL,
    filter__field_source_store_id__equal: shopIds,
  }, { select: "id,order_id,source_store_id,order_status" });
  const selectedOrderId = normalizeOrderId(options.orderId || options.order_id);
  const allGroups = [...groupRows(rows).values()].filter((group) => !selectedOrderId || group.orderId === selectedOrderId);
  const requestedLimit = Number(options.limit);
  const boundedByLimit = requestedLimit > 0 && allGroups.length > requestedLimit;
  const bounded = boundedByLimit || Boolean(selectedOrderId);
  const groups = selectedOrderId ? allGroups.slice(0, 1) : (boundedByLimit ? allGroups.slice(0, requestedLimit) : allGroups);
  const now = new Date().toISOString();
  const counts = { candidates: groups.length, matched: 0, changed: 0, unchanged: 0, not_found: 0, failed: 0 };
  const perShop = new Map(shopIds.map((id) => [id, { candidates: 0, matched: 0, changed: 0, unchanged: 0, not_found: 0, failed: 0 }]));

  for (const shopId of shopIds) {
    const shopGroups = groups.filter((group) => group.sourceStoreId === shopId);
    perShop.get(shopId).candidates = shopGroups.length;
    for (let offset = 0; offset < shopGroups.length; offset += 50) {
      const batch = shopGroups.slice(offset, offset + 50);
      const resultById = await fetchStatusBatch(env, SHOP_LABEL_BY_ID.get(shopId), batch.map((group) => group.orderId), options.fetchOrderStatuses);
      for (const group of batch) {
        const result = resultById.get(group.orderId);
        if (result?.queryFailed) { counts.failed++; perShop.get(shopId).failed++; continue; }
        await reconcileGroup(db, group, result, options, counts, perShop.get(shopId));
      }
    }
  }

  if (selectedOrderId && groups.length === 0) {
    return { ok: false, completion_state: "scoped_candidate_not_found", order_filter: selectedOrderId, counts };
  }
  const scopedComplete = Boolean(selectedOrderId) && counts.failed === 0 && counts.not_found === 0;
  const complete = !bounded && counts.failed === 0 && counts.not_found === 0;
  if (!options.dryRun && !selectedOrderId) {
    for (const [shopId, shopCounts] of perShop) {
      const state = !bounded && shopCounts.failed === 0 && shopCounts.not_found === 0 ? "accounting_complete" : "partial";
      await persistWatermark(db.supabase, { platform: "mercari", source_store_id: shopId, completion_state: state, observed_at: now, completed_at: now, run_id: options.runId || `lifecycle_${Date.now()}`, release_version: env.RELEASE_VERSION || null, ...shopCounts });
    }
  }
  return { ok: complete || scopedComplete, completion_state: complete ? "accounting_complete" : (scopedComplete ? "scoped_complete" : "partial"), order_filter: selectedOrderId || null, counts };
}

async function reconcileGroup(db, group, result, options, counts, shopCounts) {
  if (!result?.found) { counts.not_found++; shopCounts.not_found++; return; }
  const status = normalizeMercariLifecycleStatus(result.status);
  if (!status) { counts.failed++; shopCounts.failed++; return; }
  counts.matched++; shopCounts.matched++;
  if (group.rows.every((row) => String(row.order_status).toUpperCase() === status)) { counts.unchanged++; shopCounts.unchanged++; return; }
  if (options.dryRun) { counts.changed++; shopCounts.changed++; return; }
  const { data, error } = await db.supabase.rpc("reconcile_mercari_order_status", {
    p_row_ids: group.rows.map((row) => row.id),
    p_expected_statuses: group.rows.map((row) => String(row.order_status)),
    p_target_status: status,
  });
  const changed = !error && Number(data) === group.rows.length;
  if (changed) { counts.changed++; shopCounts.changed++; } else { counts.failed++; shopCounts.failed++; }
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const orderId = normalizeOrderId(row.order_id);
    const sourceStoreId = String(row.source_store_id || row.shop_id || "").trim();
    if (!orderId || !SHOP_LABEL_BY_ID.has(sourceStoreId)) continue;
    const key = `${sourceStoreId}:${orderId}`;
    if (!groups.has(key)) groups.set(key, { orderId, sourceStoreId, rows: [] });
    groups.get(key).rows.push(row);
  }
  return groups;
}

function normalizeOrderId(value) { return String(value || "").trim().replace(/^order_/, ""); }

async function fetchStatusBatch(env, shopLabel, orderIds, reader = runMercariOrderStatusesViaRelay) {
  const response = await reader(env, { shopLabel, orderIds });
  const orders = response.body?.orders || response.orders;
  if (response.ok && Array.isArray(orders)) {
    return new Map(orders.map((item) => [normalizeOrderId(item.orderId), item]));
  }
  if (orderIds.length === 1) return new Map([[orderIds[0], { queryFailed: true }]]);
  const middle = Math.ceil(orderIds.length / 2);
  const left = await fetchStatusBatch(env, shopLabel, orderIds.slice(0, middle), reader);
  const right = await fetchStatusBatch(env, shopLabel, orderIds.slice(middle), reader);
  return new Map([...left, ...right]);
}

export async function persistLifecycleWatermark(supabase, row) {
  const { error } = await supabase.from("order_lifecycle_watermarks").upsert(row, { onConflict: "platform,source_store_id" });
  if (error) throw new Error(`watermark_write_failed:${error.message}`);
  const { data, error: readError } = await supabase.from("order_lifecycle_watermarks").select("run_id,completion_state").eq("platform", row.platform).eq("source_store_id", row.source_store_id).single();
  if (readError || data?.run_id !== row.run_id || data?.completion_state !== row.completion_state) throw new Error("watermark_readback_failed");
}
