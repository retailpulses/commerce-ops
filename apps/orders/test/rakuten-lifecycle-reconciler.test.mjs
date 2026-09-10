import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  planRakutenLifecycleTransition,
  resolveRakutenGroupTarget,
  reconcileRakutenLifecycle,
} from "../src/lib/rakuten-lifecycle-reconciler.mjs";
import { runRakutenOrderStatusesViaRelay } from "../src/lib/rakuten-relay.mjs";

function dbWithRpc(result = 1) {
  const calls = [];
  return {
    calls,
    db: {
      type: "supabase", salesOrderTableId: "sales_orders",
      supabase: { async rpc(name, args) { calls.push({ name, args }); return { data: result, error: null }; } },
    },
  };
}

test("Rakuten lifecycle mapping preserves local forward progress but lets terminal RMS truth win", () => {
  assert.deepEqual(planRakutenLifecycleTransition("RMS_CONFIRMED", {
    mappingState: "MAPPED", status: "PENDING_CONFIRMATION",
  }), {
    ok: true, targetStatus: "RMS_CONFIRMED", statusChanged: false,
    evidenceOnly: true, reason: "regression_guard",
  });
  assert.equal(planRakutenLifecycleTransition("RMS_CONFIRMED", {
    mappingState: "MAPPED", status: "CANCELED",
  }).targetStatus, "CANCELED");
  assert.equal(planRakutenLifecycleTransition("CONFIRMED", {
    mappingState: "UNKNOWN", status: null,
  }).ok, false);
});

test("multi-line Rakuten orders always converge to one group status", () => {
  const plan = resolveRakutenGroupTarget([
    { order_status: "PENDING_CONFIRMATION" },
    { order_status: "RMS_CONFIRMED" },
  ], { mappingState: "MAPPED", status: "PENDING_CONFIRMATION" });
  assert.equal(plan.ok, true);
  assert.equal(plan.targetStatus, "RMS_CONFIRMED");
  assert.equal(plan.statusChanged, true);
});

test("full exact-ID dry-run accounts for every non-terminal Rakuten order without writes", async () => {
  const state = dbWithRpc();
  let watermarkWrites = 0;
  const result = await reconcileRakutenLifecycle({}, {
    dryRun: true,
    limit: 100,
    _inject: {
      db: state.db,
      listAllRows: async () => [{
        id: "row-1", order_id: "rakuten-1", order_status: "WAITING_FOR_PAYMENT",
        rakuten_order_progress: "200", rakuten_status_mapping_state: "MAPPED",
      }],
      fetchBatch: async () => new Map([["rakuten-1", { orderNumber: "rakuten-1", orderProgress: 700 }]]),
      persistWatermark: async () => { watermarkWrites++; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "accounting_complete");
  assert.equal(result.counts.changed, 1);
  assert.equal(state.calls.length, 0);
  assert.equal(watermarkWrites, 0);
});

test("live reconciliation updates every line atomically and publishes a complete watermark", async () => {
  const state = dbWithRpc(2);
  let watermark = null;
  const result = await reconcileRakutenLifecycle({ RELEASE_VERSION: "test" }, {
    runId: "run-rakuten",
    _inject: {
      db: state.db,
      listAllRows: async () => [
        { id: "row-1", order_id: "rakuten-1", order_status: "RMS_CONFIRMED" },
        { id: "row-2", order_id: "rakuten-1", order_status: "RMS_CONFIRMED" },
      ],
      fetchBatch: async () => new Map([["rakuten-1", { orderNumber: "rakuten-1", orderProgress: 900 }]]),
      persistWatermark: async (_client, row) => { watermark = row; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].name, "reconcile_rakuten_order_status");
  assert.deepEqual(state.calls[0].args.p_target_statuses, ["CANCELED", "CANCELED"]);
  assert.equal(watermark.completion_state, "accounting_complete");
  assert.equal(watermark.source_store_id, "Rakuten");
});

test("exact Rakuten lifecycle scope bypasses queue head and never publishes a global watermark", async () => {
  const state = dbWithRpc(1);
  let requested = [];
  let watermarkWrites = 0;
  const result = await reconcileRakutenLifecycle({}, {
    orderId: "order_target",
    _inject: {
      db: state.db,
      listAllRows: async () => [
        { id: "neighbor", order_id: "neighbor", order_status: "WAITING_FOR_PAYMENT" },
        { id: "target", order_id: "target", order_status: "WAITING_FOR_PAYMENT" },
      ],
      fetchBatch: async (_env, ids) => { requested = ids; return new Map([["target", { orderNumber: "target", orderProgress: 700 }]]); },
      persistWatermark: async () => { watermarkWrites++; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "scoped_complete");
  assert.equal(result.order_filter, "target");
  assert.deepEqual(requested, ["target"]);
  assert.equal(state.calls[0].args.p_row_ids[0], "target");
  assert.equal(watermarkWrites, 0);
});

test("exact Rakuten lifecycle scope fails when the local non-terminal candidate is absent", async () => {
  const state = dbWithRpc();
  const result = await reconcileRakutenLifecycle({}, {
    orderId: "missing",
    _inject: { db: state.db, listAllRows: async () => [], fetchBatch: async () => { throw new Error("must_not_read_provider"); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.completion_state, "scoped_candidate_not_found");
});

test("missing or unknown authoritative evidence stays partial and retryable", async () => {
  const state = dbWithRpc();
  let watermark = null;
  const result = await reconcileRakutenLifecycle({}, {
    _inject: {
      db: state.db,
      listAllRows: async () => [{ id: "row-1", order_id: "rakuten-1", order_status: "CONFIRMED" }],
      fetchBatch: async () => new Map([["rakuten-1", { orderNumber: "rakuten-1", orderProgress: 999 }]]),
      persistWatermark: async (_client, row) => { watermark = row; },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.counts.failed, 1);
  assert.equal(watermark.completion_state, "partial");
  assert.equal(state.calls.length, 0);
});

test("Rakuten lifecycle relay request sends exact IDs without a discovery date window", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, orders: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await runRakutenOrderStatusesViaRelay({
      MERCARI_RUNNER_BASE_URL: "http://relay.test", MERCARI_RELAY_SECRET: "test",
    }, { orderNumbers: ["a", "b"] });
    assert.equal(result.ok, true);
    assert.deepEqual(requestBody, { orderNumber: ["a", "b"] });
    assert.equal("startDate" in requestBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Rakuten lifecycle RPC is channel-scoped, CAS-protected, atomic, and service-role only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907090000_add_lifecycle_freshness_watermarks.sql", import.meta.url), "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.reconcile_rakuten_order_status");
  const end = sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
  const block = sql.slice(start, end < 0 ? undefined : end);
  assert.match(block, /sales_channel = 'rakuten'/);
  assert.match(block, /order_status = expected\.status/);
  assert.match(block, /UPDATE sales_orders AS s[\s\S]*FROM unnest\(p_row_ids, p_target_statuses\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.reconcile_rakuten_order_status[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reconcile_rakuten_order_status[\s\S]*TO service_role/);
});
