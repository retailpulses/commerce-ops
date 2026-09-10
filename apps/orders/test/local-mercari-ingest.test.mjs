import test from "node:test";
import assert from "node:assert/strict";

import { runMercariIngest } from "../src/lib/mercari-ingest.mjs";

test("local Mercari ingest preserves scope and relay-compatible accounting", async () => {
  let invocation;
  const result = await runMercariIngest({ ORDER_MGMT_LIMIT: "9" }, {
    shops: ["Shop1", "Shop2"],
    statuses: ["WAITING_FOR_PAYMENT"],
    limit: null,
    dryRun: true,
    _runNode: async (args, env) => {
      invocation = { args, env };
      return { code: 0, parsed: { ok: true, totals: { transactions: 3, created: 1, updated: 1, unchanged: 1, skipped: 0, failed: 0 } } };
    },
  });

  assert.deepEqual(invocation.args.slice(1), ["--shops", "Shop1,Shop2", "--statuses", "WAITING_FOR_PAYMENT", "--dry-run"]);
  assert.equal(invocation.env.ORDER_MGMT_LIMIT, "0");
  assert.equal(invocation.env.DATABASE_BACKEND, "supabase");
  assert.deepEqual(result.body.counts, { candidates: 3, processed: 3, skipped: 0, failed: 0 });
  assert.equal(result.ok, true);
});

test("local Mercari ingest forwards exact order scope to both CLI and environment", async () => {
  let invocation;
  await runMercariIngest({}, {
    shops: ["Shop3"], orderId: "exact-1", limit: 1, dryRun: false,
    _runNode: async (args, env) => {
      invocation = { args, env };
      return { code: 0, parsed: { ok: true, totals: { transactions: 1, unchanged: 1 } } };
    },
  });
  assert.deepEqual(invocation.args.slice(1), ["--shops", "Shop3", "--order-id", "exact-1"]);
  assert.equal(invocation.env.MERCARI_ORDER_ID, "exact-1");
  assert.equal(invocation.env.ORDER_MGMT_LIMIT, "1");
});
