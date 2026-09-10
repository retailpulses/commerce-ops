import {
  claimExternalOperation,
  finalizeExternalOperation,
  hashExternalOperationPayload,
  resolveExternalOperation,
} from "./external-operation-ledger.mjs";

export async function runMercariCloseOperation(input, options = {}) {
  const db = input?.supabase;
  const orderId = normalizeId(input?.orderId);
  const sourceStoreId = text(input?.sourceStoreId);
  const initialStatus = text(input?.initialStatus).toUpperCase();
  const runId = text(input?.runId) || `mercari_close_${Date.now()}`;
  if (!db || !orderId || !sourceStoreId || !["WAITING_FOR_SHIPPING", "COMPLETING", "COMPLETED"].includes(initialStatus)) {
    return { ok: false, completed: false, action: "invalid_close_operation" };
  }
  const claim = options.claim || claimExternalOperation;
  const finalize = options.finalize || finalizeExternalOperation;
  const resolve = options.resolve || resolveExternalOperation;
  const execute = options.execute;
  const readStatus = options.readStatus;
  if (typeof execute !== "function" || typeof readStatus !== "function") {
    return { ok: false, completed: false, action: "close_operation_dependencies_missing" };
  }

  if (initialStatus === "COMPLETING") {
    return { ok: false, completed: false, action: "preexisting_completion_in_progress" };
  }

  try {
    const payloadHash = await hashExternalOperationPayload({ orderId });
    const operation = await claim(db, {
      capability: "mercari_close_order",
      platform: "mercari",
      sourceStoreId,
      orderId,
      payloadHash,
      runId,
    });

    if (initialStatus === "COMPLETED") {
      if (operation.claimed) {
        await finalize(db, { operationKey: operation.operationKey, runId, status: "ALREADY_APPLIED", reconciliationNote: "preflight_mercari_status_COMPLETED" });
      } else if (["RESERVED", "UNKNOWN_RESULT", "DEFINITIVE_FAILURE"].includes(operation.status)) {
        await resolve(db, {
          operationKey: operation.operationKey, expectedStatus: operation.status,
          outcome: "APPLIED", evidenceRef: "mercari_order_status_COMPLETED",
          reason: "Exact Mercari orderTransaction read proved completion",
          resolvedBy: "system:mercari-close-reconciler",
        });
      }
      return { ok: true, completed: true, action: "already_completed" };
    }

    if (!operation.claimed) {
      return {
        ok: false,
        completed: false,
        action: ["CONFIRMED", "ALREADY_APPLIED"].includes(operation.status)
          ? "submitted_awaiting_completion"
          : "ledger_blocked",
        operation_status: operation.status,
      };
    }

    let executionError = "";
    try {
      await execute();
    } catch (error) {
      executionError = text(error?.message || error || "mercari_close_failed").slice(0, 500);
    }

    let observedStatus = "";
    try {
      observedStatus = text(await readStatus()).toUpperCase();
    } catch {
      observedStatus = "";
    }
    const completed = observedStatus === "COMPLETED";
    const terminalStatus = executionError
      ? (completed ? "ALREADY_APPLIED" : "UNKNOWN_RESULT")
      : "CONFIRMED";
    await finalize(db, {
      operationKey: operation.operationKey,
      runId,
      status: terminalStatus,
      errorCode: executionError || null,
      reconciliationNote: observedStatus
        ? `exact_mercari_status_${observedStatus}`
        : "exact_mercari_read_failed",
    });
    if (completed) return { ok: true, completed: true, action: executionError ? "reconciled_applied" : "completed" };
    return {
      ok: false,
      completed: false,
      action: executionError ? "unknown_result" : "submitted_awaiting_completion",
      observed_status: observedStatus || null,
      error: executionError || null,
    };
  } catch (error) {
    return { ok: false, completed: false, action: "operation_failed_closed", error: text(error?.message || error) };
  }
}

function normalizeId(value) { return text(value).replace(/^order_/, ""); }
function text(value) { return String(value ?? "").trim(); }
