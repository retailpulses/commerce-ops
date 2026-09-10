import { createBaserowClient } from "./db.mjs";
import { claimExternalOperation, finalizeExternalOperation, hashExternalOperationPayload } from "./external-operation-ledger.mjs";
import { markRakutenOrdersConfirmed } from "./rakuten-confirmer.mjs";
import { runRakutenConfirmViaRelay, runRakutenOrderStatusesViaRelay } from "./rakuten-relay.mjs";

export async function runRakutenConfirmOperations(env, found, options = {}) {
  const dryRun = options.dryRun === true;
  const candidates = groupCandidates(found?.results || [], dryRun);
  if (dryRun) return { ok: true, candidates: candidates.length, would_confirm: candidates.length, results: candidates.map((item) => ({ order_id: item.orderId, action: "would_confirm" })) };
  const db = options._inject?.db || createBaserowClient(env);
  if (db.type !== "supabase") return { ok: false, error: "external_operation_ledger_requires_supabase", results: [] };
  const runRelay = options._inject?.runRelay || runRakutenConfirmViaRelay;
  const readStatuses = options._inject?.readStatuses || runRakutenOrderStatusesViaRelay;
  const markConfirmed = options._inject?.markConfirmed || markRakutenOrdersConfirmed;
  const claim = options._inject?.claim || claimExternalOperation;
  const finalize = options._inject?.finalize || finalizeExternalOperation;
  const runId = String(options.runId || env.ORDERMGMT_RUN_ID || `rakuten_confirm_${Date.now()}`);
  const results = [];

  for (const candidate of candidates) {
    try {
      const payloadHash = await hashExternalOperationPayload({ orderNumber: candidate.orderId });
      const operation = await claim(db.supabase, {
        capability: "rakuten_confirm_order", platform: "rakuten", sourceStoreId: "Rakuten",
        orderId: candidate.orderId, payloadHash, runId,
      });
      if (!operation.claimed) {
        if (["CONFIRMED", "ALREADY_APPLIED"].includes(operation.status)) {
          const marked = await markConfirmed(env, candidate.rows.map((row) => ({ ...row, rms_result: "confirmed_from_ledger" })));
          results.push({ order_id: candidate.orderId, ok: marked.ok, action: marked.ok ? "ledger_already_applied" : "local_persistence_failed" });
        } else {
          results.push({ order_id: candidate.orderId, ok: false, action: "ledger_blocked", operation_status: operation.status });
        }
        continue;
      }

      const relay = await runRelay(env, { orderNumberList: [candidate.orderId] });
      if (relay.ok) {
        await finalize(db.supabase, { operationKey: operation.operationKey, runId, status: "CONFIRMED" });
        const marked = await markConfirmed(env, candidate.rows.map((row) => ({ ...row, rms_result: "confirmed" })));
        results.push({ order_id: candidate.orderId, ok: marked.ok, action: marked.ok ? "confirmed" : "local_persistence_failed" });
        continue;
      }

      const verification = await readStatuses(env, { orderNumbers: [candidate.orderId] }).catch(() => null);
      const order = verification?.ok && Array.isArray(verification.body?.orders)
        ? verification.body.orders.find((item) => normalizeId(item.orderNumber) === candidate.orderId)
        : null;
      const progress = Number(order?.orderProgress);
      const applied = progress === 300 || progress === 500;
      await finalize(db.supabase, {
        operationKey: operation.operationKey, runId,
        status: applied ? "ALREADY_APPLIED" : "UNKNOWN_RESULT",
        errorCode: relay.error || relay.body?.error || "rakuten_confirm_result_unknown",
        reconciliationNote: applied ? `rms_order_progress_${progress}` : "exact_id_read_did_not_prove_confirmation",
      });
      if (applied) {
        const marked = await markConfirmed(env, candidate.rows.map((row) => ({ ...row, rms_result: `reconciled_${progress}` })));
        results.push({ order_id: candidate.orderId, ok: marked.ok, action: marked.ok ? "reconciled_applied" : "local_persistence_failed", order_progress: progress });
      } else {
        results.push({ order_id: candidate.orderId, ok: false, action: "unknown_result", order_progress: Number.isFinite(progress) ? progress : null });
      }
    } catch (error) {
      results.push({
        order_id: candidate.orderId,
        ok: false,
        action: "operation_failed_closed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: results.every((result) => result.ok), candidates: candidates.length, results };
}

function groupCandidates(results, dryRun) {
  const allowed = new Set(dryRun ? ["would_mark_in_progress", "marked_in_progress"] : ["marked_in_progress"]);
  const groups = new Map();
  for (const row of results) {
    const orderId = normalizeId(row.order_id);
    if (!orderId || !allowed.has(row.action)) continue;
    if (!groups.has(orderId)) groups.set(orderId, { orderId, rows: [] });
    groups.get(orderId).rows.push({ order_id: orderId, row_id: row.row_id });
  }
  return [...groups.values()];
}

function normalizeId(value) { return String(value || "").trim().replace(/^order_/, ""); }
