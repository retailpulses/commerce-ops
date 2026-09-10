import assert from "node:assert/strict";
import test from "node:test";
import { runMercariCloseOperation } from "../src/lib/mercari-close-operation.mjs";
import { hashExternalOperationPayload } from "../src/lib/external-operation-ledger.mjs";

test("operation payload hashing falls back to node:crypto when Web Crypto is not global", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    assert.equal((await hashExternalOperationPayload({ orderId: "m-1" })).length, 64);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});

function setup(overrides = {}) {
  const calls = { execute: 0, finalize: [], resolve: [] };
  const options = {
    claim: async () => overrides.claimResult || { claimed: true, operationKey: "op", status: "RESERVED" },
    finalize: async (_db, value) => { calls.finalize.push(value); },
    resolve: async (_db, value) => { calls.resolve.push(value); },
    execute: async () => { calls.execute += 1; if (overrides.executeError) throw new Error(overrides.executeError); },
    readStatus: async () => overrides.readStatus || "COMPLETED",
  };
  const input = { supabase: {}, orderId: "order_m-1", sourceStoreId: "shop-1", initialStatus: overrides.initialStatus || "WAITING_FOR_SHIPPING", runId: "run-1" };
  return { calls, options, input };
}

test("Mercari close claims one stable order-level intent and completes only after exact readback", async () => {
  const state = setup();
  const result = await runMercariCloseOperation(state.input, state.options);
  assert.equal(result.completed, true);
  assert.equal(state.calls.execute, 1);
  assert.equal(state.calls.finalize[0].status, "CONFIRMED");
});

test("ambiguous mutation without completed readback becomes UNKNOWN_RESULT", async () => {
  const state = setup({ executeError: "transport_lost", readStatus: "WAITING_FOR_SHIPPING" });
  const result = await runMercariCloseOperation(state.input, state.options);
  assert.equal(result.action, "unknown_result");
  assert.equal(state.calls.finalize[0].status, "UNKNOWN_RESULT");
});

test("existing UNKNOWN_RESULT blocks every mutation while marketplace remains open", async () => {
  const state = setup({ claimResult: { claimed: false, operationKey: "op", status: "UNKNOWN_RESULT" } });
  const result = await runMercariCloseOperation(state.input, state.options);
  assert.equal(result.action, "ledger_blocked");
  assert.equal(state.calls.execute, 0);
});

test("exact COMPLETED preflight reconciles blocked state without mutation", async () => {
  const state = setup({ initialStatus: "COMPLETED", claimResult: { claimed: false, operationKey: "op", status: "UNKNOWN_RESULT" } });
  const result = await runMercariCloseOperation(state.input, state.options);
  assert.equal(result.completed, true);
  assert.equal(state.calls.execute, 0);
  assert.equal(state.calls.resolve[0].outcome, "APPLIED");
});

test("accepted mutation that has not completed is verification-only on future runs", async () => {
  const state = setup({ readStatus: "COMPLETING" });
  const first = await runMercariCloseOperation(state.input, state.options);
  assert.equal(first.action, "submitted_awaiting_completion");
  assert.equal(state.calls.finalize[0].status, "CONFIRMED");

  const secondState = setup({ claimResult: { claimed: false, operationKey: "op", status: "CONFIRMED" } });
  const second = await runMercariCloseOperation(secondState.input, secondState.options);
  assert.equal(second.action, "submitted_awaiting_completion");
  assert.equal(secondState.calls.execute, 0);
});

test("preexisting COMPLETING state is verification-only and creates no new intent", async () => {
  let claims = 0;
  const state = setup({ initialStatus: "COMPLETING" });
  state.options.claim = async () => { claims += 1; };
  const result = await runMercariCloseOperation(state.input, state.options);
  assert.equal(result.action, "preexisting_completion_in_progress");
  assert.equal(claims, 0);
  assert.equal(state.calls.execute, 0);
});
