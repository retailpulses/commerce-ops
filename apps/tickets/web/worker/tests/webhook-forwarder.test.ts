import assert from "node:assert/strict";
import test from "node:test";

import {
  buildForwardPayload,
  forwardPendingInboundMessages,
  forwardSingleInboundMessage,
  forwardToOrderMgmt,
  isForwardingConfigured,
  maxForwardAttempts,
} from "../src/services/webhook-forwarder";
import type { ForwarderDbClient } from "../src/services/webhook-forwarder";
import type { Env } from "../src/types";

const ENDPOINT = "https://rp-order-mgmt.test.workers.dev/webhooks/mercari-message";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ORDERMGMT_WEBHOOK_ENDPOINT: ENDPOINT,
    ORDERMGMT_WEBHOOK_FORWARD_SECRET: "test-forward-secret",
    ...overrides,
  } as unknown as Env;
}

const baseRow = {
  id: "inbound-1",
  shop_id: "WMyisFmhbGWyVAPEwsfirn",
  order_transaction_id: "order_tx_abc123",
  webhook_received_at: "2026-08-04T10:30:00Z",
  forwarding_status: "not_forwarded",
  forwarding_attempts: 0,
};

interface FakeSupabaseState {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  updates: Array<{ patch: Record<string, unknown>; id: string }>;
  claimRows: Array<Record<string, unknown>>;
  getByIdRow: Record<string, unknown> | null;
}

function makeFakeSupabase(state: FakeSupabaseState): ForwarderDbClient {
  return {
    rpc: async (fn, args) => {
      state.rpcCalls.push({ fn, args });
      return { data: state.claimRows, error: null };
    },
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          state.updates.push({ patch, id });
          return { error: null };
        },
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.getByIdRow ? { data: state.getByIdRow, error: null } : { data: null, error: null },
        }),
      }),
    }),
  };
}

function makeFetchReturning(
  status: number,
  body: unknown = {},
  capture: Array<{ url: string; init: RequestInit }> = []
): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    capture.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

// ── Payload / config helpers ──

test("buildForwardPayload produces the OrderMgmt contract payload", () => {
  assert.deepEqual(buildForwardPayload(baseRow), {
    topic: "ORDER_TRANSACTION_MESSAGE_CREATED",
    shop_id: "WMyisFmhbGWyVAPEwsfirn",
    order_transaction_id: "order_tx_abc123",
    created_at: "2026-08-04T10:30:00Z",
  });
});

test("buildForwardPayload returns null when required fields are missing", () => {
  assert.equal(buildForwardPayload({ shop_id: "s", order_transaction_id: "", webhook_received_at: "2026-08-04T10:30:00Z" }), null);
  assert.equal(buildForwardPayload({ shop_id: "s", order_transaction_id: "t", webhook_received_at: null }), null);
});

test("isForwardingConfigured requires endpoint AND secret", () => {
  assert.equal(isForwardingConfigured(makeEnv()), true);
  assert.equal(isForwardingConfigured(makeEnv({ ORDERMGMT_WEBHOOK_ENDPOINT: "" })), false);
  assert.equal(isForwardingConfigured(makeEnv({ ORDERMGMT_WEBHOOK_FORWARD_SECRET: "" })), false);
  assert.equal(isForwardingConfigured({} as Env), false);
});

test("maxForwardAttempts defaults to 5 and honors the env override", () => {
  assert.equal(maxForwardAttempts(makeEnv()), 5);
  assert.equal(maxForwardAttempts(makeEnv({ ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS: "3" })), 3);
  assert.equal(maxForwardAttempts(makeEnv({ ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS: "0" })), 5);
  assert.equal(maxForwardAttempts(makeEnv({ ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS: "not-a-number" })), 5);
});

// ── Network path ──

test("forwardToOrderMgmt sends Bearer secret header-only (never in URL)", async () => {
  const capture: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = makeFetchReturning(200, { status: "ok" }, capture);

  const result = await forwardToOrderMgmt(makeEnv(), baseRow, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(capture.length, 1);
  assert.equal(capture[0].url, ENDPOINT);
  assert.equal(new URL(capture[0].url).searchParams.get("secret"), null);
  const headers = capture[0].init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-forward-secret");
  assert.equal(headers["Content-Type"], "application/json");
  const sentBody = JSON.parse(capture[0].init.body as string);
  assert.equal(sentBody.topic, "ORDER_TRANSACTION_MESSAGE_CREATED");
  assert.equal(sentBody.shop_id, "WMyisFmhbGWyVAPEwsfirn");
});

test("forwardToOrderMgmt treats OrderMgmt duplicate 200 as success", async () => {
  const result = await forwardToOrderMgmt(makeEnv(), baseRow, {
    fetchImpl: makeFetchReturning(200, { status: "duplicate" }),
  });
  assert.equal(result.ok, true);
});

test("forwardToOrderMgmt treats permanent 4xx as terminal", async () => {
  for (const status of [400, 401, 403, 404, 413]) {
    const result = await forwardToOrderMgmt(makeEnv(), baseRow, {
      fetchImpl: makeFetchReturning(status),
    });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false, `status ${status} must be non-retryable`);
  }
});

test("forwardToOrderMgmt treats 5xx/429 as retryable", async () => {
  for (const status of [429, 500, 503]) {
    const result = await forwardToOrderMgmt(makeEnv(), baseRow, {
      fetchImpl: makeFetchReturning(status),
    });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true, `status ${status} must be retryable`);
  }
});

test("forwardToOrderMgmt treats network failure as retryable", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection reset");
  }) as typeof fetch;
  const result = await forwardToOrderMgmt(makeEnv(), baseRow, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.error ?? "", /forward_fetch_failed/);
});

test("forwardToOrderMgmt skips (no network) when unconfigured", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await forwardToOrderMgmt({} as Env, baseRow, { fetchImpl });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

// ── Single-row path (webhook handler waitUntil) ──

test("forwardSingleInboundMessage marks the row forwarded on success", async () => {
  const state: FakeSupabaseState = { rpcCalls: [], updates: [], claimRows: [], getByIdRow: baseRow };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(200, { status: "ok" });

  const result = await forwardSingleInboundMessage(makeEnv(), "inbound-1", { supabase, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(state.updates.length, 1);
  const patch = state.updates[0].patch;
  assert.equal(patch.forwarding_status, "forwarded");
  assert.equal(patch.forwarding_attempts, 1);
  assert.equal(patch.forward_error, null);
  assert.ok(patch.forwarded_at);
});

test("forwardSingleInboundMessage keeps row not_forwarded on transient failure", async () => {
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [],
    getByIdRow: { ...baseRow, forwarding_attempts: 2 },
  };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(500);

  const result = await forwardSingleInboundMessage(makeEnv(), "inbound-1", { supabase, fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  const patch = state.updates[0].patch;
  assert.equal(patch.forwarding_status, "not_forwarded");
  assert.equal(patch.forwarding_attempts, 3);
  assert.match(String(patch.forward_error), /forward_rejected_500/);
});

test("forwardSingleInboundMessage marks row failed on permanent rejection", async () => {
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [],
    getByIdRow: baseRow,
  };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(401);

  const result = await forwardSingleInboundMessage(makeEnv(), "inbound-1", { supabase, fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  const patch = state.updates[0].patch;
  assert.equal(patch.forwarding_status, "failed");
  assert.match(String(patch.forward_error), /forward_rejected_401/);
});

test("forwardSingleInboundMessage does not touch already-forwarded rows", async () => {
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [],
    getByIdRow: { ...baseRow, forwarding_status: "forwarded", forwarding_attempts: 1 },
  };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(200);

  const result = await forwardSingleInboundMessage(makeEnv(), "inbound-1", { supabase, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(state.updates.length, 0);
});

test("forwardSingleInboundMessage skips rows claimed in-flight elsewhere (forwarding)", async () => {
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [],
    getByIdRow: { ...baseRow, forwarding_status: "forwarding", forwarding_attempts: 1 },
  };
  const supabase = makeFakeSupabase(state);
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await forwardSingleInboundMessage(makeEnv(), "inbound-1", { supabase, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(called, false, "must not double-forward a row claimed by another worker");
  assert.equal(state.updates.length, 0);
});

test("forwardSingleInboundMessage skips without network when unconfigured", async () => {
  const state: FakeSupabaseState = { rpcCalls: [], updates: [], claimRows: [], getByIdRow: baseRow };
  const supabase = makeFakeSupabase(state);
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await forwardSingleInboundMessage({} as Env, "inbound-1", { supabase, fetchImpl });

  assert.equal(result.skipped, true);
  assert.equal(called, false);
  assert.equal(state.updates.length, 0);
});

// ── Cron path ──

test("forwardPendingInboundMessages claims via RPC and applies outcomes", async () => {
  const claimedRow = {
    id: "inbound-9",
    shop_id: "ZaMyGWzp6hUdgDh5E9ADob",
    order_transaction_id: "order_tx_xyz",
    webhook_received_at: "2026-08-04T09:00:00Z",
    forwarding_attempts: 2, // RPC already incremented
  };
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [claimedRow],
    getByIdRow: null,
  };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(200, { status: "ok" });

  const stats = await forwardPendingInboundMessages(makeEnv(), 10, { supabase, fetchImpl });

  assert.equal(state.rpcCalls.length, 1);
  assert.equal(state.rpcCalls[0].fn, "claim_pending_webhook_forwarding");
  assert.equal(state.rpcCalls[0].args.claim_limit, 10);
  assert.equal(state.rpcCalls[0].args.max_attempts, 5);
  assert.deepEqual(stats, { claimed: 1, forwarded: 1, failed: 0, skipped: 0 });
  const patch = state.updates[0].patch;
  assert.equal(patch.forwarding_status, "forwarded");
  assert.equal(patch.forwarding_attempts, 2); // preserved from RPC increment
});

test("forwardPendingInboundMessages reports skipped when unconfigured", async () => {
  const stats = await forwardPendingInboundMessages({} as Env, 10, {
    supabase: makeFakeSupabase({ rpcCalls: [], updates: [], claimRows: [], getByIdRow: null }),
  });
  assert.deepEqual(stats, { claimed: 0, forwarded: 0, failed: 0, skipped: 1 });
});

test("forwardPendingInboundMessages forwards rows reclaimed from a stale claim", async () => {
  // RPC reclaimed a crashed worker's in-flight row (status 'forwarding',
  // stale last_forward_attempt_at) and returned it with attempts bumped.
  const claimedRow = {
    id: "inbound-10",
    shop_id: "ZaMyGWzp6hUdgDh5E9ADob",
    order_transaction_id: "order_tx_reclaimed",
    webhook_received_at: "2026-08-04T08:00:00Z",
    forwarding_status: "forwarding",
    forwarding_attempts: 3,
  };
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [claimedRow],
    getByIdRow: null,
  };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(200, { status: "ok" });

  const stats = await forwardPendingInboundMessages(makeEnv(), 10, { supabase, fetchImpl });

  assert.deepEqual(stats, { claimed: 1, forwarded: 1, failed: 0, skipped: 0 });
  const patch = state.updates[0].patch;
  assert.equal(patch.forwarding_status, "forwarded");
  assert.equal(patch.forwarding_attempts, 3);
});

test("forwardPendingInboundMessages terminalizes rows whose attempts are exhausted", async () => {
  const claimedRow = {
    id: "inbound-11",
    shop_id: "ZaMyGWzp6hUdgDh5E9ADob",
    order_transaction_id: "order_tx_exhausted",
    webhook_received_at: "2026-08-04T07:00:00Z",
    forwarding_attempts: 5, // max — RPC already incremented past the cap
  };
  const state: FakeSupabaseState = {
    rpcCalls: [],
    updates: [],
    claimRows: [claimedRow],
    getByIdRow: null,
  };
  const supabase = makeFakeSupabase(state);
  const fetchImpl = makeFetchReturning(500);

  const stats = await forwardPendingInboundMessages(makeEnv(), 10, { supabase, fetchImpl });

  assert.deepEqual(stats, { claimed: 1, forwarded: 0, failed: 1, skipped: 0 });
  const patch = state.updates[0].patch;
  assert.equal(patch.forwarding_status, "failed");
  assert.match(String(patch.forward_error), /forward_rejected_500/);
});
