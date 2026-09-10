import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { setOrderReviewStatusViaRpc } from "../src/lib/supabase.mjs";

// Static SQL contract regression tests for the portal "Cancel" review RPC.
// These read the governed migration and assert that the concurrency contract —
// order-scoped advisory lock, the four guards, the non-fee predicate, the
// AUTO_APPROVED CAS gate, and the privilege revoke/grant — is present and
// remains intact. They mirror the wave1-contract.test.mjs approach.
const migrationSql = readFileSync(
  new URL("../supabase/migrations/20260815120000_add_canceled_review_status.sql", import.meta.url),
  "utf8",
);

const NON_FEE_PREDICATE =
  /coalesce\(product_name, ''\) like '%各種手数料%' or coalesce\(product_name, ''\) = '追加支払い・追加送料専用'/;

test("cancel migration extends chk_review_status with CANCELED", () => {
  assert.match(
    migrationSql,
    /check \(review_status in \('PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD', 'CANCELED'\)\)/i,
  );
});

test("RPC takes an order-scoped advisory lock", () => {
  assert.match(
    migrationSql,
    /pg_advisory_xact_lock\(hashtext\(p_sales_channel \|\| '\|' \|\| p_source_store_id \|\| '\|' \|\| p_order_id\)\)/,
  );
});

test("RPC guards all five failure contracts", () => {
  assert.match(migrationSql, /raise exception 'ORDER_TERMINAL'/);
  assert.match(migrationSql, /raise exception 'ALREADY_SYNCED_TO_GIGA'/);
  assert.match(migrationSql, /raise exception 'REVIEW_CANCELED'/);
  assert.match(migrationSql, /raise exception 'REVIEW_STATUS_CHANGED'/);
  assert.match(migrationSql, /raise exception 'ORDER_NOT_FOUND'/);
});

test("AUTO_APPROVED is CAS-gated on PENDING_REVIEW (guard 4)", () => {
  // The CAS gate must apply only to AUTO_APPROVED and require every target
  // non-fee line to still be PENDING_REVIEW, so auto-approval never overrides
  // a concurrent operator On Hold / Approve / Cancel.
  assert.match(migrationSql, /if p_target = 'AUTO_APPROVED'[\s\S]*?review_status is distinct from 'PENDING_REVIEW'/);
});

test("non-fee predicate is applied consistently across guards and the update", () => {
  // The fee-row exclusion must appear in the guards AND the update CTE so fee
  // lines are never flipped or locked.
  const matches = migrationSql.match(/追加支払い・追加送料専用/g);
  assert.ok(matches && matches.length >= 4, "expected non-fee predicate in guards 1, 3, 4, and the update CTE");
  assert.match(migrationSql, NON_FEE_PREDICATE);
});

test("AUTO_APPROVED metadata is written in the same transaction", () => {
  assert.match(migrationSql, /auto_approval_rule = case when p_target = 'AUTO_APPROVED'/);
  assert.match(migrationSql, /auto_approved_at\s+= case when p_target = 'AUTO_APPROVED'/);
  assert.match(migrationSql, /p_auto_approved_at::timestamptz/);
});

test("RPC signature defaults the auto-approval metadata params to null", () => {
  assert.match(migrationSql, /p_auto_approval_rule text default null/);
  assert.match(migrationSql, /p_auto_approved_at\s+text default null/);
});

test("RPC execution is restricted to the trusted backend role", () => {
  assert.match(
    migrationSql,
    /revoke all on function public\.set_order_review_status\(text, text, text, text, text, text, text\) from public;/,
  );
  // Supabase default privileges grant EXECUTE to anon/authenticated explicitly;
  // revoke from public alone does not strip them.
  assert.match(
    migrationSql,
    /revoke execute on function public\.set_order_review_status\(text, text, text, text, text, text, text\) from anon, authenticated;/,
  );
  assert.match(
    migrationSql,
    /grant execute on function public\.set_order_review_status\(text, text, text, text, text, text, text\) to service_role;/,
  );
});

// ── JS RPC error-contract mapping ──────────────────────────────────────────

function makeSupabaseClient(rpcImpl) {
  return { type: "supabase", supabase: { rpc: rpcImpl } };
}

test("setOrderReviewStatusViaRpc maps each RPC exception to a stable error", async () => {
  const cases = [
    ["ORDER_TERMINAL", "terminal_lifecycle"],
    ["ALREADY_SYNCED_TO_GIGA", "already_synced_to_giga"],
    ["REVIEW_CANCELED", "already_canceled"],
    ["REVIEW_STATUS_CHANGED", "review_status_changed"],
    ["ORDER_NOT_FOUND", "order_not_found"],
    ["CANCELLATION_REASON_REQUIRED", "cancellation_reason_required"],
    ["CANCELLATION_REASON_TOO_LONG", "cancellation_reason_too_long"],
  ];
  for (const [sqlErr, jsErr] of cases) {
    const client = makeSupabaseClient(async () => ({ data: null, error: { message: sqlErr } }));
    const result = await setOrderReviewStatusViaRpc(client, { p_target: "AUTO_APPROVED" });
    assert.equal(result.ok, false, `${sqlErr} should not succeed`);
    assert.equal(result.error, jsErr, `${sqlErr} → ${jsErr}`);
  }
});

test("setOrderReviewStatusViaRpc returns the updated row count on success", async () => {
  const client = makeSupabaseClient(async () => ({
    data: { updated: 3, review_status: "AUTO_APPROVED" },
    error: null,
  }));
  const result = await setOrderReviewStatusViaRpc(client, { p_target: "AUTO_APPROVED" });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 3);
});

test("setOrderReviewStatusViaRpc rejects a non-supabase backend", async () => {
  const result = await setOrderReviewStatusViaRpc({ type: undefined }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "review_rpc_requires_supabase_backend");
});
