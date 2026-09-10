import { createBaserowClient, listAllRows, patchRow, FIELD, OPTION } from "./db.mjs";
import { runMercariIngestViaRelay } from "./mercari-relay.mjs";
import { toJstIso } from "./timezone.mjs";
import { ORDER_STATUS, GIGA_SYNC_STATUS, MERCARI_API_STATUS, readSelectValue, statusEquals } from "./order-state.mjs";

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

const SHOP_LABEL_BY_ID = Object.fromEntries(
  Object.entries(SHOP_IDS).map(([label, shopId]) => [shopId, label]),
);

const RECONCILE_STATUSES = [MERCARI_API_STATUS.WAITING_FOR_SHIPPING, MERCARI_API_STATUS.CANCELING, MERCARI_API_STATUS.CANCELED];

export async function reconcileMercariCancellations(env, { shops = [], limit = 0, dryRun = false, _inject = {} } = {}) {
  const baserow = _inject.client || createBaserowClient(env);
  const listRows = _inject.listAllRows || listAllRows;
  const patch = _inject.patchRow || patchRow;
  const runIngest = _inject.runMercariIngestViaRelay || runMercariIngestViaRelay;
  const selectedShopIds = new Set(
    (Array.isArray(shops) ? shops : [])
      .map((shop) => SHOP_IDS[String(shop || "").trim()])
      .filter(Boolean),
  );

  // Scan WAITING_FOR_SHIPPING and WAITING_FOR_PAYMENT rows — orders can be
  // cancelled from either state (e.g. buyer cancels before paying).
  const [wfsRows, wfpRows] = await Promise.all([
    listRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
    }),
    listRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT,
    }),
  ]);
  const salesRows = [...wfsRows, ...wfpRows];
  const candidates = salesRows.filter((row) => {
    const isWfs = statusEquals(row.order_status, ORDER_STATUS.WAITING_FOR_SHIPPING);
    const isWfp = statusEquals(row.order_status, ORDER_STATUS.WAITING_FOR_PAYMENT);
    if (!isWfs && !isWfp) return false;
    if (isWfs && String(row.shipping_completed_at || "").trim()) return false;
    const shopId = sourceStoreId(row);
    if (selectedShopIds.size && !selectedShopIds.has(shopId)) return false;
    return Boolean(shopId && SHOP_LABEL_BY_ID[shopId]);
  });

  const candidateScopes = new Set(candidates.map(orderScopeKey).filter(Boolean));
  const shopsToRun = Array.from(
    new Set(candidates.map((row) => SHOP_LABEL_BY_ID[sourceStoreId(row)]).filter(Boolean)),
  );
  if (!shopsToRun.length) {
    return {
      ok: true,
      mode: "reconcile_cancellations",
      dry_run: dryRun,
      counts: {
        candidates: 0,
        shops_run: 0,
        canceled_after_reconcile: 0,
      },
      shops: [],
    };
  }

  const relayResults = [];
  for (const shop of shopsToRun) {
    const relayResult = await runIngest(env, {
      shops: [shop],
      limit: limit > 0 ? limit : 0,
      dryRun,
      statuses: RECONCILE_STATUSES,
    });
    relayResults.push({
      shop,
      ok: relayResult && relayResult.ok !== false,
      status: relayResult ? relayResult.status : null,
      body: relayResult ? relayResult.body : null,
    });
  }

  // Second scan: find rows that transitioned from WAITING_FOR_SHIPPING to CANCELED.
  // Unfiltered scan — daily job, minor cost. Multi-status OR not supported by Baserow API.
  const afterRows = await listRows(baserow, baserow.salesOrderTableId);
  const canceledAfter = afterRows.filter((row) => {
    if (!candidateScopes.has(orderScopeKey(row))) return false;
    const status = readSelectValue(row.order_status);
    return statusEquals(status, MERCARI_API_STATUS.CANCELING) || statusEquals(status, MERCARI_API_STATUS.CANCELED);
  });

  // Mark associated shipment rows as Invalid so tracking reconciliation
  // stops polling Giga for orders that will never ship.
  const canceledScopes = new Set(canceledAfter.map(orderScopeKey).filter(Boolean));
  let shipmentsPatched = 0;
  let shipmentPatchErrors = 0;
  if (canceledScopes.size > 0 && !dryRun) {
    // Load Mercari shipment rows — filter server-side for efficiency
    const shipmentRows = await listRows(baserow, baserow.shipmentOrderTableId, {
      [`filter__field_${FIELD.SHIPMENT.SALES_CHANNEL}__equal`]: "Mercari",
    });
    const nowIso = toJstIso(new Date());
    for (const row of shipmentRows) {
      const shipmentScope = `${String(row.SourceStoreID || "").trim()}:${normalizeOrderId(row.OrderId)}`;
      if (!canceledScopes.has(shipmentScope)) continue;
      // Skip rows already in a terminal state
      const syncStatus = readSelectValue(row.giga_sync_status).toLowerCase();
      if (syncStatus === "invalid" || syncStatus === "error") continue;
      try {
        const result = await patch(baserow, baserow.shipmentOrderTableId, row.id, {
          giga_sync_status: GIGA_SYNC_STATUS.INVALID,
          giga_sync_error: "Order canceled on Mercari",
          giga_sync_processed_at: nowIso,
        });
        if (result.ok) {
          shipmentsPatched += 1;
        } else {
          shipmentPatchErrors += 1;
        }
      } catch {
        shipmentPatchErrors += 1;
      }
    }
  }

  // Clear stale review_status on cancelled sales rows so they don't
  // pollute the "On Hold" bucket or other review-status filters.
  let reviewCleared = 0;
  let reviewClearErrors = 0;
  if (canceledAfter.length > 0 && !dryRun) {
    for (const row of canceledAfter) {
      const currentReview = readSelectValue(row.review_status);
      if (!currentReview) continue; // already empty
      try {
        const result = await patch(
          baserow, baserow.salesOrderTableId, row.id, buildTerminalReviewClearPatch(),
        );
        if (result.ok) {
          reviewCleared += 1;
        } else {
          reviewClearErrors += 1;
        }
      } catch {
        reviewClearErrors += 1;
      }
    }
  }

  // Catch-all: scan for any CANCELED/CANCELING rows that still have a
  // review_status set. Handles edge cases where the initial candidate scan
  // missed an order (e.g. status changed between reconciler runs).
  let catchAllCleared = 0;
  let catchAllErrors = 0;
  if (!dryRun) {
    const allRows = await listRows(baserow, baserow.salesOrderTableId);
    for (const row of allRows) {
      const rowStatus = readSelectValue(row.order_status);
      if (!statusEquals(rowStatus, MERCARI_API_STATUS.CANCELING) && !statusEquals(rowStatus, MERCARI_API_STATUS.CANCELED)) continue;
      const currentReview = readSelectValue(row.review_status);
      if (!currentReview) continue;
      try {
        const result = await patch(
          baserow, baserow.salesOrderTableId, row.id, buildTerminalReviewClearPatch(),
        );
        if (result.ok) catchAllCleared += 1;
        else catchAllErrors += 1;
      } catch {
        catchAllErrors += 1;
      }
    }
  }

  return {
    ok: relayResults.every((item) => item.ok) && shipmentPatchErrors === 0 && reviewClearErrors === 0 && catchAllErrors === 0,
    mode: "reconcile_cancellations",
    dry_run: dryRun,
    statuses: RECONCILE_STATUSES.slice(),
    counts: {
      candidates: candidates.length,
      shops_run: shopsToRun.length,
      canceled_after_reconcile: canceledAfter.length,
      shipment_rows_patched: shipmentsPatched,
      shipment_patch_errors: shipmentPatchErrors,
      review_cleared: reviewCleared,
      review_clear_errors: reviewClearErrors,
      review_catch_all_cleared: catchAllCleared,
      review_catch_all_errors: catchAllErrors,
    },
    shops: relayResults,
    samples: canceledAfter.slice(0, 20).map((row) => ({
      row_id: row.id,
      order_id: String(row.order_id || "").trim(),
      shop_id: sourceStoreId(row),
      order_status: readSelectValue(row.order_status),
      review_status: readSelectValue(row.review_status),
    })),
  };
}

export function buildTerminalReviewClearPatch() {
  return { review_status: null };
}

export function orderScopeKey(row) {
  const storeId = sourceStoreId(row);
  const orderId = normalizeOrderId(row && (row.order_id || row.OrderId));
  return storeId && orderId ? `${storeId}:${orderId}` : "";
}

function sourceStoreId(row) {
  return String(row && (row.source_store_id || row.shop_id || row.SourceStoreID) || "").trim();
}

function normalizeOrderId(value) {
  return String(value || "").trim().replace(/^order_/, "");
}
