import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { closeRakutenOrders } from "../src/lib/rakuten-closer.mjs";

const env = {
  DATABASE_BACKEND: "supabase",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
};

function salesRow(id, extra = {}) {
  return {
    id, order_id: "R-CLOSE-1", order_status: "RMS_CONFIRMED",
    rakuten_order_progress: "300", rakuten_status_mapping_state: "MAPPED",
    ...extra,
  };
}

function scenario(overrides = {}) {
  const calls = { relay: 0, claim: 0, finalize: [], resolve: [], patches: [] };
  const reads = overrides.reads || [300, 500];
  let readIndex = 0;
  const inject = {
    listAllRows: async (_client, _table, filters) => {
      if (filters.filter__field_order_status__single_select_equal === "RMS_CONFIRMED") {
        return overrides.salesRows || [salesRow("line-1")];
      }
      return [{ id: "shipment-1", OrderId: "R-CLOSE-1", giga_tracking_no: "TRACK-1", giga_carrier_name: "Sagawa", shipping_completed_at: "2026-09-07T00:00:00Z" }];
    },
    patchRow: async (_client, _table, rowId, payload) => {
      calls.patches.push({ rowId, payload });
      return { ok: true };
    },
    runRakutenIngestViaRelay: async () => {
      const progress = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      return { ok: true, body: { orders: [{ orderNumber: "R-CLOSE-1", orderProgress: progress }] } };
    },
    runRakutenCloseViaRelay: async () => { calls.relay += 1; return overrides.relayResult || { ok: true }; },
    claimExternalOperation: async () => {
      calls.claim += 1;
      return overrides.claimResult || { claimed: true, operationKey: "op-close", status: "RESERVED" };
    },
    finalizeExternalOperation: async (_db, value) => { calls.finalize.push(value); return {}; },
    resolveExternalOperation: async (_db, value) => { calls.resolve.push(value); return {}; },
    completeRakutenClose: async (_db, candidate, payload) => {
      for (const row of candidate.sales_rows) calls.patches.push({ rowId: row.id, payload });
      return { ok: true, failed: 0, error: "" };
    },
  };
  return { calls, inject };
}

test("Rakuten close deduplicates multi-line orders into one ledger claim and provider call", async () => {
  const state = scenario({ salesRows: [salesRow("line-1"), salesRow("line-2")] });
  const result = await closeRakutenOrders(env, { runId: "run-1", _inject: state.inject });
  assert.equal(result.ok, true);
  assert.equal(result.candidates, 1);
  assert.equal(state.calls.claim, 1);
  assert.equal(state.calls.relay, 1);
  assert.equal(state.calls.patches.length, 2);
  assert.ok(state.calls.patches.every((item) => item.payload.order_status === "COMPLETED"));
});

test("ambiguous Rakuten close becomes UNKNOWN_RESULT and is not locally completed", async () => {
  const state = scenario({ reads: [300, 300], relayResult: { ok: false, error: "timeout" } });
  const result = await closeRakutenOrders(env, { runId: "run-1", _inject: state.inject });
  assert.equal(result.ok, false);
  assert.equal(state.calls.finalize[0].status, "UNKNOWN_RESULT");
  assert.equal(state.calls.relay, 1);
  assert.ok(state.calls.patches.every((item) => item.payload.order_status !== "COMPLETED"));
});

test("existing UNKNOWN_RESULT blocks resubmission while RMS remains open", async () => {
  const state = scenario({
    reads: [300],
    claimResult: { claimed: false, operationKey: "op-close", status: "UNKNOWN_RESULT" },
  });
  const result = await closeRakutenOrders(env, { runId: "run-2", _inject: state.inject });
  assert.equal(result.ok, false);
  assert.equal(state.calls.relay, 0);
  assert.match(result.results[0].error, /ledger_blocked:UNKNOWN_RESULT/);
});

test("exact RMS 500 resolves an existing ambiguous operation and heals every local line", async () => {
  const state = scenario({
    reads: [500],
    salesRows: [salesRow("line-1"), salesRow("line-2")],
    claimResult: { claimed: false, operationKey: "op-close", status: "UNKNOWN_RESULT" },
  });
  const result = await closeRakutenOrders(env, { runId: "run-2", _inject: state.inject });
  assert.equal(result.ok, true);
  assert.equal(state.calls.relay, 0);
  assert.equal(state.calls.resolve[0].outcome, "APPLIED");
  assert.equal(state.calls.patches.length, 2);
});

test("preflight RMS 500 finalizes a newly claimed operation as already applied", async () => {
  const state = scenario({ reads: [500] });
  const result = await closeRakutenOrders(env, { runId: "run-3", _inject: state.inject });
  assert.equal(result.ok, true);
  assert.equal(state.calls.relay, 0);
  assert.equal(state.calls.finalize[0].status, "ALREADY_APPLIED");
});

test("Rakuten close completion migration is atomic, CAS guarded, and service-role-only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907153000_add_atomic_rakuten_close_completion.sql", import.meta.url), "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /cardinality\(p_row_ids\) <> cardinality\(p_expected_statuses\)/);
  assert.match(sql, /sales\.order_status = expected\.status/);
  assert.match(sql, /SET order_status = 'COMPLETED'[\s\S]*rms_close_result = 'closed'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.complete_rakuten_order_close[\s\S]*FROM PUBLIC, anon, authenticated/);
});
