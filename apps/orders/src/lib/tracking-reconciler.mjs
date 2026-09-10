import { createBaserowClient, clientForRakuten, listAllRows, patchRow, FIELD, OPTION } from "./db.mjs";
import { GigaClient } from "./giga-client.mjs";
import { formatTrackingArtifact } from "./tracking-format.mjs";
import { toJstIso } from "./timezone.mjs";
import { MERCARI_CHANNEL, RAKUTEN_CHANNEL } from "./channel-config.mjs";
import {
  GIGA_SYNC_STATUS,
  ORDER_STATUS,
  readSelectValue,
  statusEquals,
} from "./order-state.mjs";

const TRACKING_SHIPMENT_SELECT = [
  "id",
  "order_id",
  "sales_channel",
  "source_store_id",
  "giga_sync_status",
].join(",");
const TRACKING_SALES_SELECT = "id,order_id,sales_channel,source_store_id";

// ---------------------------------------------------------------------------
// Shop ID mapping — used by tracking reconciliation and exported for callers
// TODO: Phase 4 — consolidate with duplicates in outbound-sync, projector, health
// ---------------------------------------------------------------------------
export const DEFAULT_SHOP_IDS = MERCARI_CHANNEL.shopIds;

// ---------------------------------------------------------------------------
// reconcileShippingInfo
//
// Entry point for both Mercari and Rakuten tracking reconciliation.
// Creates Baserow + Giga clients from env and delegates to the
// channel-agnostic reconcileGigaTracking.
//
// This is the SINGLE source of truth — both the CLI (src/index.mjs) and the
// Cloudflare Worker (worker/index.js) import from here.
// ---------------------------------------------------------------------------
export async function reconcileShippingInfo(env, { shops, limit, orderId = "", salesChannel, dryRun = false }) {
  const platform = text(salesChannel) || "Mercari";
  const baserow = createBaserowClient(env);
  const giga = new GigaClient(env.GIGA_CLIENT_ID, env.GIGA_CLIENT_SECRET, env.GIGA_API_BASE_URL);

  if (platform === "Rakuten") {
    const salesBaserow = clientForRakuten(baserow);
    return reconcileGigaTracking({
      baserow,
      giga,
      salesBaserow,
      channelConfig: RAKUTEN_CHANNEL,
      context: { shops: shops || [], limit, orderId, dryRun },
    });
  }

  return reconcileGigaTracking({
    baserow,
    giga,
    channelConfig: MERCARI_CHANNEL,
    context: { shops: shops || [], limit, orderId, dryRun },
  });
}

// ---------------------------------------------------------------------------
// reconcileGigaTracking
//
// Channel-agnostic tracking reconciliation. Callers pass pre-built clients
// and a channelConfig data object (no logic, no vendor APIs).
//
// Parameters:
//   baserow       — Baserow client for shipment table (from createBaserowClient)
//   giga          — GigaClient instance
//   salesBaserow  — (optional) Baserow client for sales table. Defaults to baserow.
//                    Used when sales data lives in a different database (e.g. Rakuten).
//   channelConfig — { salesChannel, shopIds, salesOrderIdField,
//                     salesStatusFilters, patchSales }
//   context       — { shops (string[]), limit (number) }
// ---------------------------------------------------------------------------
export async function reconcileGigaTracking({ baserow, giga, salesBaserow, channelConfig, context, dependencies = {} }) {
  const salesClient = salesBaserow || baserow;
  const { shops, limit, orderId = "", dryRun = false } = context;
  const selectedOrderId = normalizeOrderIdCandidate(orderId);
  const listRows = dependencies.listAllRows || listAllRows;
  const patchWithFallback = dependencies.patchRowWithFallback || patchRowWithFallback;
  const {
    salesChannel,
    shopIds,
    salesOrderIdField,
    salesStatusFilters,
    patchSales,
  } = channelConfig;

  // 1. Load shipment rows with server-side filters:
  //    - SalesChannel must match
  //    - shipping_completed_at must be empty (skip already-tracked rows)
  //    - giga_sync_status must not be "Invalid" (skip terminal rows)
  //    These filters reduce the scan from ~1078 to ~100 rows, preventing
  //    Worker CPU timeout on full-table scans.
  const shipmentRows = await listRows(baserow, baserow.shipmentOrderTableId, {
    [`filter__field_${FIELD.SHIPMENT.SALES_CHANNEL}__equal`]: salesChannel,
    [`filter__field_${FIELD.SHIPMENT.SHIPPING_COMPLETED_AT}__empty`]: "1",
    [`filter__field_${FIELD.SHIPMENT.GIGA_SYNC_STATUS}__single_select_not_equal`]: OPTION.GIGA_SYNC_STATUS.INVALID,
  }, { select: TRACKING_SHIPMENT_SELECT });

  // 2. Load sales rows — one query per status filter, run concurrently.
  //    Uses salesClient (may differ from baserow for cross-database channels).
  const salesQueries = salesStatusFilters.map(({ field, optionId }) =>
    listRows(salesClient, salesClient.salesOrderTableId, {
      [`filter__field_${field}__single_select_equal`]: optionId,
    }, { select: TRACKING_SALES_SELECT }),
  );
  const salesResultSets = await Promise.all(salesQueries);
  const salesRows = salesResultSets.flat();

  // 3. Filter to relevant shipments: matching channel, not terminal, in shop scope
  const selectedShopIds = new Set(shops.map((shop) => shopIds[shop]).filter(Boolean));
  const relevantShipments = shipmentRows.filter((row) => {
    const rowChannel = text(row.SalesChannel);
    const sourceStoreId = text(row.SourceStoreID);
    const rowOrderId = normalizeOrderIdCandidate(row.OrderId);
    if (rowChannel !== salesChannel) return false;
    if (statusEquals(row.giga_sync_status, GIGA_SYNC_STATUS.INVALID)) return false;
    if (selectedOrderId && rowOrderId !== selectedOrderId) return false;
    return !selectedShopIds.size || selectedShopIds.has(sourceStoreId);
  });

  // 4. Build orderNo → store-scoped shipment rows. Giga returns only orderNo,
  // so a same-number order across stores is ambiguous and must fail closed.
  const scopedRowsByOrder = new Map();
  for (const row of relevantShipments) {
    const orderNo = normalizeOrderIdCandidate(row.OrderId);
    const storeId = text(row.SourceStoreID);
    if (!orderNo || !storeId) continue;
    if (!scopedRowsByOrder.has(orderNo)) scopedRowsByOrder.set(orderNo, new Map());
    const stores = scopedRowsByOrder.get(orderNo);
    if (!stores.has(storeId)) stores.set(storeId, []);
    stores.get(storeId).push(row);
  }

  const scopeConflicts = [];
  const orderMap = new Map();
  for (const [orderNo, stores] of scopedRowsByOrder) {
    if (stores.size !== 1) {
      scopeConflicts.push({ orderNo, source_store_ids: [...stores.keys()].sort(), error: "ambiguous_cross_store_order_id" });
      continue;
    }
    const [storeId, rows] = stores.entries().next().value;
    orderMap.set(orderNo, { storeId, rows });
  }

  const orderNos = Array.from(orderMap.keys());
  const selectedOrderNos = orderNos.slice(0, limit > 0 ? limit : orderNos.length);
  const batches = chunk(selectedOrderNos, 20);
  const batchSummaries = [];
  const patchErrors = [];
  let updatedShipments = 0;
  let updatedSalesRows = 0;
  let plannedShipmentUpdates = 0;
  let plannedSalesUpdates = 0;
  const nowIso = toJstIso(new Date());
  const requestIdPrefix = `giga-shipping-reconcile::${Date.now()}`;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    if (!batch.length) continue;
    const res = await giga.getTrackingInfo(batch);
    const trackingDatas = Array.isArray(res.data) ? res.data : [];
    const responseRequestId = text(res.requestId) || `${requestIdPrefix}::batch-${batchIndex + 1}`;
    const touched = new Set();

    for (const td of trackingDatas) {
      const normalizedOrderNo = normalizeOrderIdCandidate(td.orderNo);
      touched.add(normalizedOrderNo);
      const orderScope = orderMap.get(normalizedOrderNo);
      const shipRows = orderScope ? orderScope.rows : [];
      const shipTrackInfo = Array.isArray(td.shipTrackInfo) ? td.shipTrackInfo : [];
      if (!shipTrackInfo.length) continue;

      const trackingArtifact = formatTrackingArtifact(shipTrackInfo);
      const requestId = `${requestIdPrefix}::${normalizedOrderNo}`;

      // Validate tracking data integrity — prevent silent data loss
      const originalCount = shipTrackInfo.length;
      const formattedCount = trackingArtifact.trackingNumberSummary
        ? trackingArtifact.trackingNumberSummary.split(" / ").length
        : 0;
      if (originalCount !== formattedCount) {
        console.error(JSON.stringify({
          error: "tracking_data_loss_detected",
          orderNo: td.orderNo,
          original_count: originalCount,
          formatted_count: formattedCount,
          shipTrackInfo,
          formatted: trackingArtifact,
        }));
      }

      // Build patch payloads
      const shipmentPatchRich = {
        giga_sync_status: GIGA_SYNC_STATUS.SYNCED,
        giga_sync_error: "",
        giga_sync_processed_at: nowIso,
        giga_sync_request_id: requestId,
        tracking_carrier: trackingArtifact.carrierSummary,
        tracking_number: trackingArtifact.trackingNumberSummary,
        giga_sync_scope: inferScope(shipRows, salesChannel),
        giga_carrier_name: trackingArtifact.carrierSummary,
        giga_tracking_info: trackingArtifact.trackingDetailSummary,
        giga_tracking_raw: trackingArtifact.rawJson,
        shipping_completed_at: nowIso,
      };
      const shipmentPatchLegacy = {
        giga_sync_error: "canonical_tracking_persistence_failed",
        giga_sync_processed_at: nowIso,
        giga_sync_request_id: requestId,
        giga_sync_scope: inferScope(shipRows, salesChannel),
      };

      // Patch shipment rows (always)
      for (const row of shipRows) {
        if (dryRun) {
          plannedShipmentUpdates += 1;
          continue;
        }
        const patchResult = await patchWithFallback(
          baserow, baserow.shipmentOrderTableId, row.id,
          shipmentPatchRich, shipmentPatchLegacy,
        );
        if (!patchResult.ok) {
          patchErrors.push({ orderNo: text(td.orderNo), stage: "shipment_patch", rowId: row.id, error: patchResult.error });
          continue;
        }
        updatedShipments += 1;
      }

      // Patch sales rows (only when channelConfig says so)
      let matchingSalesRows = [];
      let updatedSalesCount = 0;
      if (patchSales) {
        // NOTE: shipping_status / shipping_tracking_no / shipping_tracking_raw /
        // shipping_info_request_id / shipping_info_synced_at / shipping_info_error
        // are NOT in the Baserow sales table schema. Only existing fields are used.
        const { rich: shippingUpdateRich, legacy: shippingUpdateLegacy } =
          buildCompletedSalesTrackingUpdate(trackingArtifact, nowIso);

        matchingSalesRows = salesRows.filter((row) =>
          normalizeOrderIdCandidate(row[salesOrderIdField]) === normalizedOrderNo
          && text(row.source_store_id || row.shop_id) === orderScope.storeId
          && (!text(row.sales_channel) || text(row.sales_channel).toLowerCase() === text(salesChannel).toLowerCase())
        );
        for (const row of matchingSalesRows) {
          if (dryRun) {
            plannedSalesUpdates += 1;
            continue;
          }
          const patchResult = await patchWithFallback(
            salesClient, salesClient.salesOrderTableId, row.id,
            shippingUpdateRich, shippingUpdateLegacy,
          );
          if (!patchResult.ok) {
            patchErrors.push({ orderNo: text(td.orderNo), stage: "sales_patch", rowId: row.id, error: patchResult.error });
            continue;
          }
          updatedSalesRows += 1;
        }
        updatedSalesCount = dryRun ? 0 : matchingSalesRows.length;
      }

      batchSummaries.push({
        orderNo: text(td.orderNo),
        carrier: trackingArtifact.carrierSummary,
        tracking: trackingArtifact.trackingDetailSummary,
        tracking_numbers: trackingArtifact.trackingNumberSummary,
        completed_at: nowIso,
        updated_shipments: dryRun ? 0 : shipRows.length,
        updated_sales_rows: updatedSalesCount,
        planned_shipment_updates: dryRun ? shipRows.length : 0,
        planned_sales_updates: dryRun ? matchingSalesRows.length : 0,
      });
    }

    // Orders in batch that Giga returned no tracking for
    for (const orderNo of batch) {
      if (!touched.has(normalizeOrderIdCandidate(orderNo))) {
        batchSummaries.push({ orderNo, updated_shipments: 0, updated_sales_rows: 0 });
      }
    }
  }

  return {
    ok: patchErrors.length === 0 && scopeConflicts.length === 0,
    mode: dryRun ? "dry_run" : "sync",
    side_effects: updatedShipments + updatedSalesRows,
    shipment_rows_loaded: shipmentRows.length,
    sales_rows_loaded: salesRows.length,
    candidate_orders: orderNos.length,
    selected_orders: selectedOrderNos.length,
    order_filter: selectedOrderId || null,
    batches: batches.length,
    patch_errors: patchErrors,
    scope_conflicts: scopeConflicts,
    scope_conflict_count: scopeConflicts.length,
    planned_shipment_updates: plannedShipmentUpdates,
    planned_sales_updates: plannedSalesUpdates,
    results: batchSummaries,
  };
}

export function buildCompletedSalesTrackingUpdate(trackingArtifact, nowIso) {
  const common = {
    order_status: ORDER_STATUS.COMPLETED,
    review_status: null,
    shipping_carrier: trackingArtifact.carrierSummary,
    shipping_tracking_info: trackingArtifact.trackingDetailSummary,
    shipping_completed_at: nowIso,
  };
  return {
    rich: { ...common },
    legacy: { ...common },
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function patchRowWithFallback(client, tableId, rowId, richPatch, fallbackPatch) {
  const richResult = await patchRow(client, tableId, rowId, richPatch);
  if (richResult.ok) return { ok: true, mode: "rich" };
  if (!fallbackPatch) return { ok: false, mode: "rich", error: richResult.error };
  const fallbackResult = await patchRow(client, tableId, rowId, fallbackPatch);
  if (fallbackResult.ok) return { ok: true, mode: "fallback", primary_error: richResult.error };
  return { ok: false, mode: "failed", error: fallbackResult.error || richResult.error, primary_error: richResult.error };
}

function inferScope(rows, salesChannel) {
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const platform = text(first && first.SalesChannel) || salesChannel || "Unknown";
  const storeId = text(first && first.SourceStoreID);
  return `${platform}::${storeId}`;
}

function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
