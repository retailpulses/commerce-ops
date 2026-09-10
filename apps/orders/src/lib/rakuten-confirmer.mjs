import { createBaserowClient, listAllRows, patchRow, clientForRakuten, FIELD, OPTION, validateExpectedFields, SALES_COLUMNS } from "./db.mjs";
import { RAKUTEN_ORDER_STATUS, readSelectValue, statusEquals } from "./order-state.mjs";
import { canConfirmRakutenOnRms } from "./rakuten-status-gates.mjs";
import { resolveCandidateLimit } from "./phase-limit.mjs";

/**
 * Find Rakuten sales rows that have been manually set to CONFIRMED
 * and are not already in progress, then mark them CONFIRM_IN_PROGRESS
 * so a downstream RMS confirm call can process them safely (no double-confirm).
 *
 * Stuck-flag recovery: if confirm_in_progress=true and confirm_started_at
 * is older than STUCK_THRESHOLD_MS (30 min), reset the flag so the row
 * can be retried on the *next* cycle. We use a dedicated confirm_started_at
 * timestamp (not last_synced_at, which ingest also writes) as the
 * authoritative lock-acquisition time.
 *
 * Reset and re-lock are intentionally split across cycles to avoid
 * confusing metrics and to give the reset a full cycle to propagate.
 *
 * @param {object} env
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {boolean} [options.dryRun]
 * @returns {object} { ok, candidates, results }
 */
export async function findConfirmedRakutenOrders(env, options = {}) {
  const client = createBaserowClient(env);
  const baserow = clientForRakuten(client);
  const limit = resolveCandidateLimit(options.limit, 50);
  const dryRun = options.dryRun === true;
  const selectedOrderId = normalizeOrderId(text(options.orderId || options.order_id));

  // ── Dependency injection (test-only) ──
  const _listAllRows = options._inject?.listAllRows || listAllRows;
  const _patchRow   = options._inject?.patchRow   || patchRow;

  const baseFilter = {
    [`filter__field_${FIELD.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
  };
  const statusField = `filter__field_${FIELD.RAKUTEN_SALES.ORDER_STATUS}__single_select_equal`;
  const [confirmedRows, paymentPendingRows] = await Promise.all([
    _listAllRows(baserow, baserow.salesOrderTableId, {
      ...baseFilter,
      [statusField]: OPTION.RAKUTEN_ORDER_STATUS.CONFIRMED,
    }),
    _listAllRows(baserow, baserow.salesOrderTableId, {
      ...baseFilter,
      [statusField]: OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT,
    }),
  ]);
  const allRows = [...new Map(
    [...confirmedRows, ...paymentPendingRows].map((row) => [String(row.id), row]),
  ).values()];

  // ── Auto-reset stuck confirm_in_progress flags ──────────────────
  // If the Worker crashed between marking in_progress and calling RMS
  // confirmOrder, the flag stays stuck. Use confirm_started_at (dedicated
  // lock-acquisition timestamp) to detect stuck rows. Row will be retried
  // on the NEXT cycle (reset now, re-lock later) to avoid double-write
  // confusion in the same invocation.
  const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  let stuckReset = 0;

  const candidates = [];
  for (const row of allRows) {
    if (selectedOrderId && normalizeOrderId(text(row.order_id)) !== selectedOrderId) continue;
    if (!canConfirmRakutenOnRms(row)) continue;
    const status = readSelectValue(row.order_status);
    if (
      statusEquals(status, OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT) &&
      text(row.rms_confirm_result) !== "requested"
    ) continue;
    // Skip if already RMS_CONFIRMED (shouldn't happen with filter, but defensive)
    if (statusEquals(status, RAKUTEN_ORDER_STATUS.RMS_CONFIRMED)) continue;

    if (isTruthy(row.confirm_in_progress)) {
      // Use confirm_started_at as the authoritative lock timestamp.
      // Fall back to last_synced_at for rows created before this migration.
      const lockTs = row.confirm_started_at
        ? new Date(row.confirm_started_at).getTime()
        : (row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0);

      if (lockTs > 0 && (now - lockTs) < STUCK_THRESHOLD_MS) {
        // Still within window — a concurrent run may be processing it
        continue;
      }
      // Stuck or never had a timestamp — reset the flag so this row can be
      // retried on the NEXT cycle (reset now, don't re-lock in this pass).
      if (!dryRun) {
        const resetPayload = {
          confirm_in_progress: false,
          confirm_started_at: null,
          last_synced_at: new Date().toISOString(),
          sync_error: "auto_reset_stuck_confirm",
        };
        const validation = validateExpectedFields(resetPayload, SALES_COLUMNS, "rakuten-confirm-reset");
        if (validation.ok) {
          try {
            const resetRes = await _patchRow(baserow, baserow.salesOrderTableId, row.id, resetPayload, { match: { sales_channel: "rakuten" } });
            if (!resetRes.ok) {
              // Reset failed — skip this row, will retry next cycle
              continue;
            }
          } catch (_) {
            // Patch threw — skip this row, will retry next cycle
            continue;
          }
        }
      }
      stuckReset += 1;
      // Intentionally do NOT add to candidates in this cycle.
      // The row will be picked up as a fresh candidate next cycle
      // after the reset propagates.
      continue;
    }
    candidates.push(row);
  }

  const limited = candidates.slice(0, limit);

  const results = [];
  let marked = 0;

  for (const row of limited) {
    const orderId = text(row.order_id);
    const resultItem = {
      order_id: orderId,
      row_id: row.id,
      order_status: readSelectValue(row.order_status),
      rakuten_order_progress: row.rakuten_order_progress,
      rakuten_status_mapping_state: readSelectValue(row.rakuten_status_mapping_state),
    };

    if (dryRun) {
      resultItem.action = "would_mark_in_progress";
      results.push(resultItem);
      continue;
    }

    try {
      const startedAt = new Date().toISOString();
      const res = await _patchRow(baserow, baserow.salesOrderTableId, row.id, {
        confirm_in_progress: true,
        confirm_started_at: startedAt,
        last_synced_at: startedAt,
      }, { match: { sales_channel: "rakuten" } });
      if (!res.ok) throw new Error(res.error || `patch_failed_${res.status}`);
      resultItem.action = "marked_in_progress";
      marked += 1;
    } catch (error) {
      resultItem.action = "failed";
      resultItem.error = error && error.message ? error.message : String(error);
    }
    results.push(resultItem);
  }

  return {
    ok: true,
    total_confirmed_rows: allRows.length,
    stuck_reset: stuckReset,
    candidates: limited.length,
    marked_in_progress: marked,
    failed: results.filter((r) => r.action === "failed").length,
    order_filter: selectedOrderId || null,
    results,
  };
}

function normalizeOrderId(value) { return text(value).replace(/^order_/, ""); }

/**
 * After a successful RMS confirmOrder call, persist confirmation evidence
 * and clear confirm_in_progress. Confirmation alone must not make an unpaid
 * order shipment-ready; fresh RMS orderProgress=300 owns that transition.
 *
 * @param {object} env
 * @param {object[]} confirmedOrders - Array of { order_id, row_id, rms_result }
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @returns {object} { ok, updated, failed, results }
 */
export async function markRakutenOrdersConfirmed(env, confirmedOrders, options = {}) {
  const client = createBaserowClient(env);
  const baserow = clientForRakuten(client);
  const dryRun = options.dryRun === true;

  // ── Dependency injection (test-only) ──
  const _patchRow = options._inject?.patchRow || patchRow;

  const summary = { ok: true, updated: 0, failed: 0, results: [] };

  if (!Array.isArray(confirmedOrders) || confirmedOrders.length === 0) return summary;

  for (const item of confirmedOrders) {
    const rowId = item.row_id;
    const resultItem = { order_id: text(item.order_id), row_id: rowId };

    if (!rowId) {
      summary.failed += 1;
      resultItem.action = "failed";
      resultItem.error = "invalid_row_id";
      summary.results.push(resultItem);
      continue;
    }

    if (dryRun) {
      resultItem.action = "would_mark_rms_confirmed";
      summary.results.push(resultItem);
      continue;
    }

    try {
      const payload = {
        confirm_in_progress: false,
        confirm_started_at: null,
        rms_confirm_result: text(item.rms_result || "ok"),
        rms_confirmed_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        sync_error: "",
      };
      const validation = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-confirm");
      if (!validation.ok) {
        throw new Error(`rakuten_confirm_validation_failed:${validation.discarded.join(",")}`);
      }
      const res = await _patchRow(baserow, baserow.salesOrderTableId, rowId, payload, { match: { sales_channel: "rakuten" } });
      if (!res.ok) throw new Error(res.error || `patch_failed_${res.status}`);
      summary.updated += 1;
      resultItem.action = "marked_rms_confirmed";
    } catch (error) {
      summary.failed += 1;
      resultItem.action = "failed";
      resultItem.error = error && error.message ? error.message : String(error);
    }
    summary.results.push(resultItem);
  }

  summary.ok = summary.failed === 0;
  return summary;
}

/**
 * If RMS confirmOrder fails, reset the confirm_in_progress flag
 * so the row can be retried on the next cron cycle.
 */
export async function resetConfirmInProgress(env, orderRows, options = {}) {
  const client = createBaserowClient(env);
  const baserow = clientForRakuten(client);
  const dryRun = options.dryRun === true;

  // ── Dependency injection (test-only) ──
  const _patchRow = options._inject?.patchRow || patchRow;

  const summary = { ok: true, reset: 0, failed: 0, results: [] };

  if (!Array.isArray(orderRows) || orderRows.length === 0) return summary;

  for (const item of orderRows) {
    const rowId = item.row_id;
    if (!rowId) continue;

    if (dryRun) {
      summary.results.push({ row_id: rowId, action: "would_reset_in_progress" });
      continue;
    }

    try {
      const res = await _patchRow(baserow, baserow.salesOrderTableId, rowId, {
        confirm_in_progress: false,
        confirm_started_at: null,
        last_synced_at: new Date().toISOString(),
        sync_error: text(item.error || "").slice(0, 500),
      }, { match: { sales_channel: "rakuten" } });
      if (!res.ok) throw new Error(res.error || `patch_failed_${res.status}`);
      summary.reset += 1;
      summary.results.push({ row_id: rowId, action: "reset_in_progress" });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        row_id: rowId,
        action: "failed",
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  summary.ok = summary.failed === 0;
  return summary;
}

// ── Helpers ────────────────────────────────────────────────────────

function text(value) {
  return String(value == null ? "" : value).trim();
}

function isTruthy(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  const t = String(value).trim().toLowerCase();
  return t === "true" || t === "1" || t === "yes";
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
