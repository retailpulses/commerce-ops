import assert from "node:assert/strict";
import test from "node:test";
import { runRakutenConfirmOperations } from "../src/lib/rakuten-confirm-operation.mjs";

function found(action = "marked_in_progress") {
  return { results: [
    { order_id: "order_r-1", row_id: "row-1", action },
    { order_id: "r-1", row_id: "row-2", action },
  ] };
}

function inject(overrides = {}) {
  const finalized = [];
  const marked = [];
  return {
    finalized,
    marked,
    value: {
      db: { type: "supabase", supabase: {} },
      claim: async () => ({ claimed: true, operationKey: "op" }),
      finalize: async (_db, value) => { finalized.push(value); },
      markConfirmed: async (_env, rows) => { marked.push(rows); return { ok: true }; },
      runRelay: async () => ({ ok: true, body: { confirmed: ["r-1"] } }),
      readStatuses: async () => ({ ok: true, body: { orders: [] } }),
      ...overrides,
    },
  };
}

test("Rakuten confirm groups multi-line rows into exactly one external operation", async () => {
  let relayCalls = 0;
  const state = inject({ runRelay: async () => { relayCalls++; return { ok: true }; } });
  const result = await runRakutenConfirmOperations({}, found(), {
    runId: "run", _inject: state.value,
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidates, 1);
  assert.equal(relayCalls, 1);
  assert.equal(state.marked[0].length, 2);
  assert.equal(state.finalized[0].status, "CONFIRMED");
});

test("ambiguous Rakuten confirm stays UNKNOWN_RESULT and is not locally released", async () => {
  const state = inject({
    runRelay: async () => ({ ok: false, error: "timeout" }),
    readStatuses: async () => ({ ok: false, error: "timeout" }),
  });
  const result = await runRakutenConfirmOperations({}, found(), { runId: "run", _inject: state.value });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, "unknown_result");
  assert.equal(state.finalized[0].status, "UNKNOWN_RESULT");
  assert.equal(state.marked.length, 0);
});

test("exact RMS progress reconciles an ambiguous confirm as already applied", async () => {
  const state = inject({
    runRelay: async () => ({ ok: false, error: "timeout" }),
    readStatuses: async () => ({ ok: true, body: { orders: [{ orderNumber: "r-1", orderProgress: 300 }] } }),
  });
  const result = await runRakutenConfirmOperations({}, found(), { runId: "run", _inject: state.value });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].action, "reconciled_applied");
  assert.equal(state.finalized[0].status, "ALREADY_APPLIED");
  assert.equal(state.marked.length, 1);
});

test("existing unknown ledger state blocks confirm resubmission", async () => {
  let relayCalls = 0;
  const state = inject({
    claim: async () => ({ claimed: false, operationKey: "op", status: "UNKNOWN_RESULT" }),
    runRelay: async () => { relayCalls++; return { ok: true }; },
  });
  const result = await runRakutenConfirmOperations({}, found(), { runId: "run", _inject: state.value });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, "ledger_blocked");
  assert.equal(relayCalls, 0);
});

test("confirm dry-run writes no ledger and performs no external operation", async () => {
  let calls = 0;
  const state = inject({
    claim: async () => { calls++; }, runRelay: async () => { calls++; },
  });
  const result = await runRakutenConfirmOperations({}, found("would_mark_in_progress"), {
    dryRun: true, _inject: state.value,
  });
  assert.equal(result.would_confirm, 1);
  assert.equal(calls, 0);
});

test("claim failure is isolated and later orders still run", async () => {
  let claims = 0;
  let relayCalls = 0;
  const state = inject({
    claim: async () => {
      claims += 1;
      if (claims === 1) throw new Error("claim_readback_failed");
      return { claimed: true, operationKey: "op-2" };
    },
    runRelay: async () => { relayCalls += 1; return { ok: true }; },
  });
  const result = await runRakutenConfirmOperations({}, { results: [
    { order_id: "r-1", row_id: "row-1", action: "marked_in_progress" },
    { order_id: "r-2", row_id: "row-2", action: "marked_in_progress" },
  ] }, { runId: "run", _inject: state.value });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, "operation_failed_closed");
  assert.equal(result.results[1].action, "confirmed");
  assert.equal(relayCalls, 1);
});

test("finalization failure after provider success remains fail closed and does not persist locally", async () => {
  const state = inject({ finalize: async () => { throw new Error("finalize_readback_failed"); } });
  const result = await runRakutenConfirmOperations({}, found(), { runId: "run", _inject: state.value });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, "operation_failed_closed");
  assert.equal(state.marked.length, 0);
});

test("confirmed ledger heals local persistence failure without resubmitting", async () => {
  let relayCalls = 0;
  const state = inject({
    claim: async () => ({ claimed: false, operationKey: "op", status: "CONFIRMED" }),
    markConfirmed: async () => ({ ok: false, failed: 2 }),
    runRelay: async () => { relayCalls += 1; return { ok: true }; },
  });
  const result = await runRakutenConfirmOperations({}, found(), { runId: "run", _inject: state.value });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, "local_persistence_failed");
  assert.equal(relayCalls, 0);
});
