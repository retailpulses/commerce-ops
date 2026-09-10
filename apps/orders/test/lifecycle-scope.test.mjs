import assert from "node:assert/strict";
import test from "node:test";
import { reconcileMercariLifecycle } from "../src/lib/lifecycle-reconciler.mjs";

test("exact Mercari lifecycle scope reads and mutates only the selected store/order group", async () => {
  const rpcCalls = [];
  let requested = null;
  let watermarkWrites = 0;
  const db = {
    type: "supabase", salesOrderTableId: "sales",
    supabase: { async rpc(name, args) { rpcCalls.push({ name, args }); return { data: 1, error: null }; } },
  };
  const result = await reconcileMercariLifecycle({}, {
    shops: ["Shop1"], orderId: "order_target",
    fetchOrderStatuses: async (_env, input) => {
      requested = input;
      return { ok: true, orders: [{ orderId: "target", status: "WAITING_FOR_SHIPPING", found: true }] };
    },
    _inject: {
      db,
      listAllRows: async () => [
        { id: "neighbor", order_id: "neighbor", source_store_id: "WMyisFmhbGWyVAPEwsfirn", order_status: "WAITING_FOR_PAYMENT" },
        { id: "target", order_id: "target", source_store_id: "WMyisFmhbGWyVAPEwsfirn", order_status: "WAITING_FOR_PAYMENT" },
      ],
      persistWatermark: async () => { watermarkWrites++; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "scoped_complete");
  assert.deepEqual(requested.orderIds, ["target"]);
  assert.deepEqual(rpcCalls[0].args.p_row_ids, ["target"]);
  assert.equal(watermarkWrites, 0);
});

test("exact Mercari lifecycle scope fails without a local non-terminal candidate", async () => {
  const result = await reconcileMercariLifecycle({}, {
    shops: ["Shop1"], orderId: "missing",
    _inject: { db: { type: "supabase", salesOrderTableId: "sales", supabase: {} }, listAllRows: async () => [] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.completion_state, "scoped_candidate_not_found");
});

test("Mercari shadow limit is complete when it covers the full candidate set", async () => {
  let watermarkWrites = 0;
  const result = await reconcileMercariLifecycle({}, {
    shops: ["Shop1"], dryRun: true, limit: 100,
    fetchOrderStatuses: async () => ({
      ok: true,
      orders: [{ orderId: "target", status: "WAITING_FOR_SHIPPING", found: true }],
    }),
    _inject: {
      db: { type: "supabase", salesOrderTableId: "sales", supabase: {} },
      listAllRows: async () => [{
        id: "target", order_id: "target", source_store_id: "WMyisFmhbGWyVAPEwsfirn",
        order_status: "WAITING_FOR_PAYMENT",
      }],
      persistWatermark: async () => { watermarkWrites++; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "accounting_complete");
  assert.equal(result.counts.changed, 1);
  assert.equal(watermarkWrites, 0);
});
