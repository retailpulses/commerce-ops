import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, reconcileExternalOperation } from "../scripts/resolve-external-operation.mjs";

const operation = {
  operation_key: "op-1", capability: "rakuten_confirm_order", platform: "rakuten",
  source_store_id: "Rakuten", order_id: "r-1", run_id: "run-1",
  status: "UNKNOWN_RESULT", reserved_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
};

const request = {
  supabase: {}, operationKey: "op-1", expectedStatus: "UNKNOWN_RESULT", outcome: "APPLIED",
  evidenceRef: "rms-read-123", reason: "Exact RMS read proved progress 300",
  resolvedBy: "operator@example.com",
};

test("resolution CLI defaults to a zero-write dry run", async () => {
  let writes = 0;
  const result = await reconcileExternalOperation({ ...request, _inject: {
    getOperation: async () => operation,
    resolveOperation: async () => { writes += 1; },
  } });
  assert.equal(result.mode, "dry_run");
  assert.equal(result.proposal.resulting_status, "ALREADY_APPLIED");
  assert.equal(writes, 0);
});

test("confirmed resolution requires exact expected state and returns readback", async () => {
  let writes = 0;
  const audit = { id: "resolution-1", resulting_status: "ALREADY_APPLIED" };
  const result = await reconcileExternalOperation({ ...request, confirmWrite: true, _inject: {
    getOperation: async () => operation,
    resolveOperation: async () => { writes += 1; return { operation: { ...operation, status: "ALREADY_APPLIED" }, resolution: audit }; },
  } });
  assert.equal(writes, 1);
  assert.equal(result.operation.status, "ALREADY_APPLIED");
  assert.equal(result.resolution.id, "resolution-1");
});

test("resolution rejects unsafe or weakly evidenced transitions before writes", async () => {
  await assert.rejects(() => reconcileExternalOperation({ ...request, evidenceRef: "", _inject: { getOperation: async () => operation } }), /resolution_invalid/);
  await assert.rejects(() => reconcileExternalOperation({ ...request, expectedStatus: "RESERVED", confirmWrite: true, _inject: { getOperation: async () => operation } }), /expected_status_mismatch/);
});

test("argument parser requires an explicit write flag", () => {
  const args = parseArgs(["--operation-key", "op-1", "--expected-status", "UNKNOWN_RESULT", "--outcome", "NOT_APPLIED", "--evidence-ref", "provider-proof", "--reason", "Provider search proved no order exists", "--resolved-by", "operator", "--confirm-write"]);
  assert.equal(args.confirmWrite, true);
  assert.equal(args.operationKey, "op-1");
});
