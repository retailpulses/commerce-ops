import assert from "node:assert/strict";
import test from "node:test";

import { callRelayEndpoint, relayCompletionState } from "../src/lib/mercari-relay.mjs";
import { runRakutenIngestViaRelay } from "../src/lib/rakuten-relay.mjs";

test("relay 202 is accepted, not completed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ ok: true, accepted: true, pid: 123 }),
    { status: 202, headers: { "content-type": "application/json" } },
  ));

  const result = await callRelayEndpoint("https://relay.test/admin/ingest", {}, "secret", { requireCompletion: true });
  assert.equal(result.ok, false);
  assert.equal(result.completion_state, "accepted");
  assert.equal(result.completion_proven, false);
  assert.equal(result.error, "relay_completion_not_proven:accepted");
});

test("relay synchronous success is completed with counts", async (t) => {
  const counts = { candidates: 3, processed: 2, skipped: 1, failed: 0 };
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ ok: true, state: "completed", counts }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));

  const result = await callRelayEndpoint("https://relay.test/admin/ingest", {}, "secret", { requireCompletion: true });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "completed");
  assert.equal(result.completion_proven, true);
  assert.deepEqual(result.counts, counts);
});

test("completed close with zero candidates remains completed", async (t) => {
  const counts = { candidates: 0, processed: 0, skipped: 0, failed: 0 };
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ ok: true, state: "completed", counts }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));

  const result = await callRelayEndpoint("https://relay.test/admin/close-shipped-orders", {}, "secret", { requireCompletion: true });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "completed");
  assert.deepEqual(result.counts, counts);
});

test("explicit failed state cannot be treated as success", () => {
  assert.equal(relayCompletionState(200, { ok: false, state: "failed" }), "failed");
});

test("legacy 200 without an explicit state is not completion proof", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ ok: true, counts: { candidates: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));

  const result = await callRelayEndpoint("https://relay.test/admin/ingest", {}, "secret", { requireCompletion: true });
  assert.equal(result.ok, false);
  assert.equal(result.completion_proven, false);
});

test("Rakuten discovery preserves explicit unbounded null across the relay contract", async (t) => {
  let requestBody;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, orders: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const result = await runRakutenIngestViaRelay({
    MERCARI_RUNNER_BASE_URL: "https://relay.test",
    MERCARI_RELAY_SECRET: "secret",
  }, { limit: null });
  assert.equal(result.ok, true);
  assert.equal(requestBody.limit, null);
});
