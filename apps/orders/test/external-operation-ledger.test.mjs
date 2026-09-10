import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildExternalOperationKey,
  claimExternalOperation,
  finalizeExternalOperation,
  getExternalOperation,
  resolveExternalOperation,
} from "../src/lib/external-operation-ledger.mjs";

test("external operation identity includes capability, scope, order, and payload hash", () => {
  assert.equal(buildExternalOperationKey({
    capability: "giga_create_order", platform: "mercari", sourceStoreId: "shop",
    orderId: "order-1", payloadHash: "abc",
  }), "giga_create_order:mercari:shop:order-1:abc");
  assert.throws(() => buildExternalOperationKey({ capability: "x" }), /identity_incomplete/);
});

test("claim and finalize require authoritative RPC/readback", async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "claim_external_operation") return { data: [{ attempt_id: "a", claimed: true, operation_status: "RESERVED" }], error: null };
      return { data: true, error: null };
    },
    from() {
      const builder = {
        select() { return builder; }, eq() { return builder; },
        async single() { return { data: { operation_key: "giga_create_order:mercari:shop:order-1:abc", run_id: "run-1", status: "CONFIRMED" }, error: null }; },
      };
      return builder;
    },
  };
  const claim = await claimExternalOperation(supabase, {
    capability: "giga_create_order", platform: "mercari", sourceStoreId: "shop",
    orderId: "order-1", payloadHash: "abc", runId: "run-1",
  });
  assert.equal(claim.claimed, true);
  await finalizeExternalOperation(supabase, {
    operationKey: claim.operationKey, runId: "run-1", status: "CONFIRMED",
  });
  assert.deepEqual(calls.map((call) => call.name), ["claim_external_operation", "finalize_external_operation"]);
});

test("external operation migration never automatically reclaims ambiguous operations", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907110000_add_external_operation_ledger.sql", import.meta.url), "utf8");
  assert.match(sql, /ON CONFLICT \(operation_key\) DO UPDATE[\s\S]*WHERE external_operation_attempts\.status = 'RELEASED'/);
  assert.doesNotMatch(sql, /WHERE external_operation_attempts\.status IN \([^)]*UNKNOWN_RESULT/);
  assert.match(sql, /status = 'RESERVED'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.claim_external_operation[\s\S]*FROM PUBLIC, anon, authenticated/);
});

test("operator resolution requires RPC plus operation and immutable-audit readback", async () => {
  const calls = [];
  const attempt = {
    operation_key: "op-1", status: "ALREADY_APPLIED", capability: "rakuten_confirm_order",
    platform: "rakuten", source_store_id: "Rakuten", order_id: "r-1",
  };
  const audit = {
    id: "resolution-1", operation_key: "op-1", previous_status: "UNKNOWN_RESULT",
    resolution_outcome: "APPLIED", resulting_status: "ALREADY_APPLIED",
    evidence_ref: "rms-read-123", reason: "Exact RMS read proved progress 300",
    resolved_by: "operator@example.com",
  };
  const supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [{ resolution_id: "resolution-1", operation_key: "op-1", previous_status: "UNKNOWN_RESULT", resulting_status: "ALREADY_APPLIED" }], error: null };
    },
    from(table) {
      const builder = {
        select() { return builder; }, eq() { return builder; },
        async single() { return { data: table === "external_operation_attempts" ? attempt : audit, error: null }; },
      };
      return builder;
    },
  };
  const result = await resolveExternalOperation(supabase, {
    operationKey: "op-1", expectedStatus: "UNKNOWN_RESULT", outcome: "APPLIED",
    evidenceRef: "rms-read-123", reason: "Exact RMS read proved progress 300",
    resolvedBy: "operator@example.com",
  });
  assert.equal(result.operation.status, "ALREADY_APPLIED");
  assert.equal(result.resolution.id, "resolution-1");
  assert.equal(calls[0].name, "resolve_external_operation");
});

test("external operation reads use an exact operation key", async () => {
  let exactKey = "";
  const supabase = { from() {
    const builder = {
      select() { return builder; }, eq(_field, value) { exactKey = value; return builder; },
      async single() { return { data: { operation_key: "op-1" }, error: null }; },
    };
    return builder;
  } };
  await getExternalOperation(supabase, "op-1");
  assert.equal(exactKey, "op-1");
});

test("resolution migration is CAS, service-role-only, audited, and never age-releases", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907151000_add_external_operation_resolution.sql", import.meta.url), "utf8");
  assert.match(sql, /attempt\.status = p_expected_status/);
  assert.match(sql, /INSERT INTO external_operation_resolutions/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.resolve_external_operation[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /reserved_at\s*[<>]|updated_at\s*[<>]|interval\s+'/i);
});

test("forward migration permits authoritative applied evidence for any blocked classification", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907152000_allow_evidence_to_override_operation_failure.sql", import.meta.url), "utf8");
  assert.match(sql, /p_expected_status NOT IN \('RESERVED', 'UNKNOWN_RESULT', 'DEFINITIVE_FAILURE'\)/);
  assert.doesNotMatch(sql, /definitive failure cannot be resolved as applied/i);
  assert.match(sql, /INSERT INTO external_operation_resolutions/);
});
