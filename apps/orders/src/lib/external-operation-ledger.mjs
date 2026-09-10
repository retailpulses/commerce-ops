function text(value) { return String(value ?? "").trim(); }

export async function hashExternalOperationPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const runtimeCrypto = globalThis.crypto?.subtle
    ? globalThis.crypto
    : (await import("node:crypto")).webcrypto;
  const digest = await runtimeCrypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function buildExternalOperationKey({ capability, platform, sourceStoreId, orderId, payloadHash }) {
  const parts = [capability, platform, sourceStoreId, orderId, payloadHash].map(text);
  if (parts.some((part) => !part)) throw new Error("external_operation_identity_incomplete");
  return parts.join(":");
}

export async function claimExternalOperation(supabase, input) {
  const operationKey = buildExternalOperationKey(input);
  const { data, error } = await supabase.rpc("claim_external_operation", {
    p_operation_key: operationKey,
    p_capability: input.capability,
    p_platform: input.platform,
    p_source_store_id: input.sourceStoreId,
    p_order_id: input.orderId,
    p_payload_hash: input.payloadHash,
    p_run_id: input.runId,
  });
  if (error) throw new Error(`external_operation_claim_failed:${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.claimed !== "boolean" || !text(row.operation_status)) {
    throw new Error("external_operation_claim_readback_failed");
  }
  return { operationKey, attemptId: row.attempt_id, claimed: row.claimed, status: row.operation_status };
}

export async function finalizeExternalOperation(supabase, input) {
  const { data, error } = await supabase.rpc("finalize_external_operation", {
    p_operation_key: input.operationKey,
    p_run_id: input.runId,
    p_status: input.status,
    p_provider_request_id: text(input.providerRequestId) || null,
    p_provider_code: text(input.providerCode) || null,
    p_error_code: text(input.errorCode).slice(0, 500) || null,
    p_reconciliation_note: text(input.reconciliationNote).slice(0, 500) || null,
  });
  if (error || data !== true) throw new Error(error?.message || "external_operation_finalize_conflict");
  const { data: row, error: readError } = await supabase.from("external_operation_attempts")
    .select("operation_key,run_id,status").eq("operation_key", input.operationKey).single();
  if (readError || row?.run_id !== input.runId || row?.status !== input.status) {
    throw new Error("external_operation_finalize_readback_failed");
  }
  return row;
}

export async function getExternalOperation(supabase, operationKey) {
  const key = text(operationKey);
  if (!key) throw new Error("external_operation_key_required");
  const { data, error } = await supabase.from("external_operation_attempts")
    .select("operation_key,capability,platform,source_store_id,order_id,payload_hash,run_id,status,reserved_at,finalized_at,error_code,reconciliation_note,updated_at")
    .eq("operation_key", key).single();
  if (error || !data || data.operation_key !== key) {
    throw new Error(error?.message || "external_operation_readback_failed");
  }
  return data;
}

export async function resolveExternalOperation(supabase, input) {
  const operationKey = text(input?.operationKey);
  const expectedStatus = text(input?.expectedStatus).toUpperCase();
  const outcome = text(input?.outcome).toUpperCase();
  const evidenceRef = text(input?.evidenceRef);
  const reason = text(input?.reason);
  const resolvedBy = text(input?.resolvedBy);
  if (!operationKey || !["RESERVED", "UNKNOWN_RESULT", "DEFINITIVE_FAILURE"].includes(expectedStatus)
      || !["APPLIED", "NOT_APPLIED"].includes(outcome)
      || evidenceRef.length < 3 || reason.length < 10 || resolvedBy.length < 2) {
    throw new Error("external_operation_resolution_invalid");
  }
  const { data, error } = await supabase.rpc("resolve_external_operation", {
    p_operation_key: operationKey,
    p_expected_status: expectedStatus,
    p_resolution_outcome: outcome,
    p_evidence_ref: evidenceRef,
    p_reason: reason,
    p_resolved_by: resolvedBy,
  });
  const resolution = Array.isArray(data) ? data[0] : data;
  const resultingStatus = outcome === "APPLIED" ? "ALREADY_APPLIED" : "RELEASED";
  if (error || !resolution || resolution.operation_key !== operationKey
      || resolution.previous_status !== expectedStatus
      || resolution.resulting_status !== resultingStatus
      || !text(resolution.resolution_id)) {
    throw new Error(error?.message || "external_operation_resolution_failed");
  }

  const [operationReadback, resolutionReadback] = await Promise.all([
    getExternalOperation(supabase, operationKey),
    supabase.from("external_operation_resolutions")
      .select("id,operation_key,previous_status,resolution_outcome,resulting_status,evidence_ref,reason,resolved_by,resolved_at")
      .eq("id", resolution.resolution_id).single(),
  ]);
  const audit = resolutionReadback?.data;
  if (resolutionReadback?.error || operationReadback.status !== resultingStatus
      || !audit || audit.id !== resolution.resolution_id
      || audit.operation_key !== operationKey || audit.resulting_status !== resultingStatus
      || audit.resolution_outcome !== outcome || audit.resolved_by !== resolvedBy) {
    throw new Error("external_operation_resolution_readback_failed");
  }
  return { operation: operationReadback, resolution: audit };
}
