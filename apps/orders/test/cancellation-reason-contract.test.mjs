import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { setOrderReviewStatusViaRpc } from "../src/lib/supabase.mjs";
import { handlePortalCancel } from "../src/lib/portal/handlers.mjs";

const migrationSql = readFileSync(
  new URL("../supabase/migrations/20260826091000_add_cancellation_reason.sql", import.meta.url),
  "utf8",
);

test("cancellation reason migration stores free text on sales_orders", () => {
  assert.match(migrationSql, /add column if not exists cancellation_reason text/i);
  assert.match(migrationSql, /char_length\(btrim\(p_cancellation_reason\)\) > 2000/i);
  assert.match(migrationSql, /set cancellation_reason = btrim\(p_cancellation_reason\)/i);
});

test("cancel wrapper writes reason in the same transaction as review status", () => {
  assert.match(migrationSql, /v_result := public\.set_order_review_status\(/i);
  assert.match(migrationSql, /'CANCELED'/);
  assert.match(migrationSql, /grant execute on function public\.cancel_order_with_reason\(text, text, text, text, text\) to service_role/i);
  assert.match(migrationSql, /and not \(\s*coalesce\(product_name, ''\) like '%各種手数料%'/i);
});

test("cancellation RPC adapter selects the reason-aware RPC and strips p_target", async () => {
  let call;
  const client = {
    type: "supabase",
    supabase: {
      rpc: async (name, params) => {
        call = { name, params };
        return { data: { updated: 2 }, error: null };
      },
    },
  };

  const result = await setOrderReviewStatusViaRpc(client, {
    p_sales_channel: "mercari",
    p_source_store_id: "shop-1",
    p_order_id: "123",
    p_target: "CANCELED",
    p_audit: "audit",
    p_cancellation_reason: "Buyer requested cancellation",
  });

  assert.equal(result.ok, true);
  assert.equal(call.name, "cancel_order_with_reason");
  assert.deepEqual(call.params, {
    p_sales_channel: "mercari",
    p_source_store_id: "shop-1",
    p_order_id: "123",
    p_audit: "audit",
    p_cancellation_reason: "Buyer requested cancellation",
  });
});

test("review RPC adapter preserves the existing non-cancellation path", async () => {
  let call;
  const client = {
    type: "supabase",
    supabase: {
      rpc: async (name, params) => {
        call = { name, params };
        return { data: { updated: 1 }, error: null };
      },
    },
  };
  const params = { p_target: "APPROVED", p_audit: "" };
  const result = await setOrderReviewStatusViaRpc(client, params);
  assert.equal(result.ok, true);
  assert.deepEqual(call, { name: "set_order_review_status", params });
});

test("cancel handler rejects missing, null, and oversized reasons before database access", async () => {
  for (const body of [{}, null, { cancellation_reason: "   " }]) {
    const result = await handlePortalCancel({}, "order-1", body);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, "cancellation_reason_required");
  }
  const oversized = await handlePortalCancel({}, "order-1", { cancellation_reason: "x".repeat(2001) });
  assert.equal(oversized.statusCode, 400);
  assert.equal(oversized.error, "cancellation_reason_too_long");
});
