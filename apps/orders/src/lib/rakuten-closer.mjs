import { createBaserowClient, clientForRakuten, listAllRows, patchRow, FIELD, OPTION, validateExpectedFields, SALES_COLUMNS } from "./db.mjs";
import { runRakutenCloseViaRelay, runRakutenIngestViaRelay } from "./rakuten-relay.mjs";
import { isRakutenShipmentReady } from "./rakuten-status-gates.mjs";
import {
  claimExternalOperation,
  finalizeExternalOperation,
  hashExternalOperationPayload,
  resolveExternalOperation,
} from "./external-operation-ledger.mjs";

/**
 * Find Rakuten orders that are ready for RMS close and close them via the
 * VPS relay.
 *
 * Readiness criteria:
 * 1. Rakuten sales row has order_status = RMS_CONFIRMED (confirmed on RMS)
 * 2. Corresponding shipment row has giga_tracking_no populated (tracking pulled)
 * 3. Not already closed (no rms_close_completed_at on the sales row)
 *
 * The relay calls the Rakuten RMS API to mark the order as shipped.
 *
 * RMS close acknowledgement is deliberately strict: only a fresh getOrder
 * response with orderProgress=500 may transition the local row to COMPLETED.
 * Shipping-detail API success alone is non-terminal.
 *
 * @param {object} env
 * @param {object} opts
 * @param {number} [opts.limit=50]
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.orderId] exact order filter for controlled canaries
 */
export async function closeRakutenOrders(env, opts = {}) {
  const { limit = 50, dryRun = false, orderId = "", _inject } = opts;
  const selectedOrderId = normalizeOrderIdCandidate(orderId);
  const baserow = createBaserowClient(env);
  const rakutenClient = clientForRakuten(baserow);

  // ── Dependency injection (test-only) ──
  const _listAllRows = _inject?.listAllRows || listAllRows;
  const _patchRow   = _inject?.patchRow   || patchRow;
  const _runRelay   = _inject?.runRakutenCloseViaRelay || runRakutenCloseViaRelay;
  const _readRms    = _inject?.runRakutenIngestViaRelay || runRakutenIngestViaRelay;
  const _claim      = _inject?.claimExternalOperation || claimExternalOperation;
  const _finalize   = _inject?.finalizeExternalOperation || finalizeExternalOperation;
  const _resolve    = _inject?.resolveExternalOperation || resolveExternalOperation;
  const _complete   = _inject?.completeRakutenClose || completeRakutenClose;

  // ── 1. Rakuten sales rows: RMS_CONFIRMED ──────────────────────────────
  const salesRows = await _listAllRows(rakutenClient, rakutenClient.salesOrderTableId, {
    [`filter__field_${FIELD.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
    [`filter__field_${FIELD.RAKUTEN_SALES.ORDER_STATUS}__single_select_equal`]:
      OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED,
  });

  // ── 2. Shipment rows with Rakuten tracking ────────────────────────────
  const shipmentRows = await _listAllRows(baserow, baserow.shipmentOrderTableId, {
    [`filter__field_${FIELD.SHIPMENT.SALES_CHANNEL}__equal`]: "Rakuten",
  });

  // Build lookup: orderId → shipment row that has tracking info
  const trackingByOrderId = new Map();
  for (const row of shipmentRows) {
    const orderId = normalizeOrderIdCandidate(row.OrderId);
    const trackingNo = text(row.giga_tracking_no);
    if (!orderId || !trackingNo) continue;
    if (!trackingByOrderId.has(orderId)) {
      trackingByOrderId.set(orderId, row);
    }
  }

  // ── 3. Find candidates: RMS_CONFIRMED + tracking present + not yet closed ──
  const candidatesByOrder = new Map();
  for (const row of salesRows) {
    if (!isRakutenShipmentReady(row)) continue;
    const orderId = normalizeOrderIdCandidate(row.order_id);
    if (!orderId) continue;
    if (selectedOrderId && orderId !== selectedOrderId) continue;

    const shipmentRow = trackingByOrderId.get(orderId);
    if (!shipmentRow) continue;

    // Skip orders already closed on RMS
    const closeCompletedAt = text(row.rms_close_completed_at);
    if (closeCompletedAt) continue;

    if (!candidatesByOrder.has(orderId)) {
      candidatesByOrder.set(orderId, {
        order_id: orderId,
        sales_rows: [],
        shipment_row_id: shipmentRow.id,
        tracking_no: text(shipmentRow.giga_tracking_no),
        carrier: text(shipmentRow.giga_carrier_name),
        shipping_date: toDateOnly(text(shipmentRow.shipping_completed_at)),
      });
    }
    candidatesByOrder.get(orderId).sales_rows.push(row);
  }

  const candidates = [...candidatesByOrder.values()];

  const toClose = candidates.slice(0, limit > 0 ? limit : candidates.length);

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      platform: "Rakuten",
      candidates: candidates.length,
      would_close: toClose.length,
      order_ids: toClose.map((c) => c.order_id),
      order_filter: selectedOrderId || null,
    };
  }

  if (toClose.length === 0) {
    return {
      ok: true,
      platform: "Rakuten",
      candidates: 0,
      closed: 0,
      results: [],
    };
  }

  if (baserow.type !== "supabase") {
    return { ok: false, platform: "Rakuten", candidates: candidates.length, closed: 0, failed: toClose.length, persistence_failures: 0, error: "external_operation_ledger_requires_supabase", results: [] };
  }

  // ── 4. Close each order via relay ──────────────────────────────────────
  const results = [];
  let closedCount = 0;
  let failedCount = 0;
  let persistenceFailures = 0;

  for (const candidate of toClose) {
    const resultItem = { order_id: candidate.order_id };

    try {
      // Reconcile before mutating. This closes the local loop when RMS already
      // reached 500 after an earlier attempt, and prevents duplicate shipping
      // detail writes on retries.
      let verification = await readRmsCloseState(env, candidate.order_id, _readRms);
      if (!verification.ok) {
        throw new Error(`rms_close_preflight_failed:${verification.error}`);
      }

      if (!verification.closed && verification.orderProgress !== 300) {
        throw new Error(`rms_close_not_eligible:order_progress_${verification.orderProgress ?? "missing"}`);
      }

      const payloadHash = await hashExternalOperationPayload({ orderNumber: candidate.order_id });
      const runId = text(opts.runId || env.ORDERMGMT_RUN_ID || `rakuten_close_${Date.now()}`);
      const operation = await _claim(baserow.supabase, {
        capability: "rakuten_close_order",
        platform: "rakuten",
        sourceStoreId: "Rakuten",
        orderId: candidate.order_id,
        payloadHash,
        runId,
      });

      if (operation.claimed && verification.closed) {
        await _finalize(baserow.supabase, {
          operationKey: operation.operationKey,
          runId,
          status: "ALREADY_APPLIED",
          reconciliationNote: "preflight_rms_order_progress_500",
        });
      }

      if (!operation.claimed && verification.closed
          && ["RESERVED", "UNKNOWN_RESULT", "DEFINITIVE_FAILURE"].includes(operation.status)) {
        await _resolve(baserow.supabase, {
          operationKey: operation.operationKey,
          expectedStatus: operation.status,
          outcome: "APPLIED",
          evidenceRef: "rms_order_progress_500",
          reason: "Exact RMS getOrder read proved the order is closed",
          resolvedBy: "system:rakuten-close-reconciler",
        });
      } else if (!operation.claimed && !["CONFIRMED", "ALREADY_APPLIED"].includes(operation.status)) {
        throw new Error(`rms_close_ledger_blocked:${operation.status}`);
      }

      let relayResult = null;
      let closeSubmitted = false;
      if (!verification.closed && operation.claimed) {
          relayResult = await _runRelay(env, {
            orderNumber: candidate.order_id,
            trackingNo: candidate.tracking_no,
            carrier: candidate.carrier,
            shippingDate: candidate.shipping_date,
          });

          closeSubmitted = relayResult.ok === true;
          verification = await readRmsCloseState(env, candidate.order_id, _readRms);
          if (verification.ok && verification.closed) {
            await _finalize(baserow.supabase, {
              operationKey: operation.operationKey,
              runId,
              status: relayResult.ok ? "CONFIRMED" : "ALREADY_APPLIED",
              errorCode: relayResult.ok ? null : text(relayResult.error || relayResult.body?.error || "relay_close_failed"),
              reconciliationNote: "rms_order_progress_500",
            });
          } else if (relayResult.ok) {
            await _finalize(baserow.supabase, {
              operationKey: operation.operationKey,
              runId,
              status: "CONFIRMED",
              reconciliationNote: verification.ok
                ? `submitted_rms_order_progress_${verification.orderProgress ?? "missing"}`
                : "submitted_rms_read_failed",
            });
          } else {
            await _finalize(baserow.supabase, {
              operationKey: operation.operationKey,
              runId,
              status: "UNKNOWN_RESULT",
              errorCode: text(relayResult.error || relayResult.body?.error || "relay_close_failed"),
              reconciliationNote: verification.ok
                ? `exact_read_order_progress_${verification.orderProgress ?? "missing"}`
                : "exact_rms_read_failed",
            });
          }
      }

      // RMS does not accept JST offset; use UTC ISO for audit timestamps.
      const nowIso = new Date().toISOString();

      if (verification.ok && verification.closed) {
        // orderProgress=500 is the authoritative close acknowledgement. A
        // successful shipping-info response alone must never complete locally.
        const closePayload = {
          order_status: "COMPLETED",
          review_status: null,
          rms_close_completed_at: nowIso,
          rms_close_result: "closed",
          last_synced_at: nowIso,
          sync_error: "",
        };
        const validation = validateExpectedFields(closePayload, SALES_COLUMNS, "rakuten-closer");
        if (!validation.ok) {
          throw new Error(`rakuten_close_validation_failed:${validation.discarded.join(",")}`);
        }
        const patchSummary = await _complete(baserow.supabase, candidate, closePayload, verification);
        if (!patchSummary.ok) {
          persistenceFailures += patchSummary.failed;
          resultItem.ok = false;
          resultItem.error = `close_persistence_failed:${patchSummary.error}`;
          failedCount += 1;
        } else {
          closedCount += 1;
          resultItem.ok = true;
          resultItem.rms_order_progress = verification.orderProgress;
          resultItem.shipping_cmpl_rpt_datetime = verification.shippingCmplRptDatetime || null;
        }
      } else {
        // Accepted/unverified is non-terminal. Preserve order_status and make
        // the next scheduled run verification-only rather than re-submitting.
        const observed = verification.ok
          ? `order_progress_${verification.orderProgress ?? "missing"}`
          : `verification_error_${verification.error}`;
        const errorText = `rms_close_unverified:${observed}`.slice(0, 500);
        const errorPayload = {
          rms_close_result: closeSubmitted
            || candidate.sales_rows.some((row) => text(row.rms_close_result) === "submitted_awaiting_rms_500")
            || (!operation.claimed && operation.status === "CONFIRMED")
            ? "submitted_awaiting_rms_500"
            : "error",
          last_synced_at: nowIso,
          sync_error: errorText,
        };
        const patchSummary = await patchCandidateRows(candidate, errorPayload, rakutenClient, _patchRow);
        if (!patchSummary.ok) persistenceFailures += patchSummary.failed;
        failedCount += 1;
        resultItem.ok = false;
        resultItem.error = errorText;
        resultItem.rms_order_progress = verification.orderProgress ?? null;
      }
    } catch (error) {
      // TRD D3: On unexpected error, persist the error but don't mark as closed.
      const nowIso = new Date().toISOString();
      const errorMsg = (error && error.message ? error.message : String(error)).slice(0, 500);
      try {
        const errPatchRes = await patchCandidateRows(candidate, {
          last_synced_at: nowIso,
          sync_error: errorMsg,
        }, rakutenClient, _patchRow);
        if (!errPatchRes.ok) persistenceFailures += errPatchRes.failed;
      } catch (_) {
        persistenceFailures += 1;
      }
      failedCount += 1;
      resultItem.ok = false;
      resultItem.error = errorMsg;
    }
    results.push(resultItem);
  }

  return {
    ok: failedCount === 0,
    platform: "Rakuten",
    candidates: candidates.length,
    closed: closedCount,
    failed: failedCount,
    persistence_failures: persistenceFailures,
    results,
  };
}

async function completeRakutenClose(supabase, candidate, payload, verification) {
  const rowIds = candidate.sales_rows.map((row) => row.id);
  const expectedStatuses = candidate.sales_rows.map((row) => text(row.order_status));
  const observedAt = new Date().toISOString();
  const { data, error } = await supabase.rpc("complete_rakuten_order_close", {
    p_row_ids: rowIds,
    p_expected_statuses: expectedStatuses,
    p_completed_at: payload.rms_close_completed_at,
    p_order_progress: String(verification.orderProgress),
    p_progress_observed_at: observedAt,
  });
  if (error || Number(data) !== rowIds.length) {
    return { ok: false, failed: rowIds.length, error: text(error?.message || "close_completion_cas_failed") };
  }
  const { data: rows, error: readError } = await supabase.from("sales_orders")
    .select("id,order_status,review_status,rms_close_completed_at,rms_close_result,rakuten_order_progress,rakuten_status_mapping_state")
    .in("id", rowIds);
  const valid = !readError && Array.isArray(rows) && rows.length === rowIds.length
    && rows.every((row) => row.order_status === "COMPLETED"
      && row.review_status == null
      && row.rms_close_completed_at === payload.rms_close_completed_at
      && row.rms_close_result === "closed"
      && String(row.rakuten_order_progress) === "500"
      && row.rakuten_status_mapping_state === "MAPPED");
  return valid
    ? { ok: true, failed: 0, error: "" }
    : { ok: false, failed: rowIds.length, error: text(readError?.message || "close_completion_readback_failed") };
}

async function patchCandidateRows(candidate, payload, rakutenClient, patch) {
  let failed = 0;
  let error = "";
  for (const row of candidate.sales_rows) {
    const result = await patch(rakutenClient, rakutenClient.salesOrderTableId, row.id, payload, { match: { sales_channel: "rakuten" } });
    if (!result.ok) {
      failed += 1;
      error ||= text(result.error || result.status || "patch_failed");
    }
  }
  return { ok: failed === 0, failed, error };
}

async function readRmsCloseState(env, orderId, runIngest) {
  try {
    const result = await runIngest(env, { orderNumber: orderId, limit: 1 });
    if (!result?.ok) {
      return { ok: false, closed: false, error: text(result?.error || result?.body?.error || "rms_read_failed") };
    }
    const responseBody = result.body || result;
    const orders = Array.isArray(responseBody.orders) ? responseBody.orders : [];
    const order = orders.find((item) => normalizeOrderIdCandidate(item?.orderNumber) === orderId);
    if (!order) return { ok: false, closed: false, error: "order_not_found" };

    const orderProgress = Number(order.orderProgress);
    return {
      ok: Number.isFinite(orderProgress),
      closed: orderProgress === 500,
      orderProgress: Number.isFinite(orderProgress) ? orderProgress : null,
      shippingCmplRptDatetime: text(order.shippingCmplRptDatetime) || null,
      error: Number.isFinite(orderProgress) ? null : "missing_order_progress",
    };
  } catch (error) {
    return { ok: false, closed: false, error: text(error?.message || error || "rms_read_failed") };
  }
}

function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function toDateOnly(value) {
  const t = text(value);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
