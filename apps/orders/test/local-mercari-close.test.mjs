import test from "node:test";
import assert from "node:assert/strict";

import { runMercariCloseLocal } from "../src/lib/mercari-close-local.mjs";

test("local Mercari close preserves scope and reports structured failure accounting", async () => {
  let invocation;
  const result = await runMercariCloseLocal({}, {
    shops: ["Shop3"], orderId: "order-123", limit: 2, dryRun: true,
    _runNode: async (args, env) => {
      invocation = { args, env };
      return { code: 1, parsed: { ok: false, candidates: 2, processed: 1, skipped: 0, failed: 1, backfill_failed: 0 } };
    },
  });
  assert.deepEqual(invocation.args.slice(1), ["--shops", "Shop3", "--order-id", "order-123", "--limit", "2", "--dry-run"]);
  assert.equal(invocation.env.MERCARI_ORDER_ID, "order-123");
  assert.equal(invocation.env.DATABASE_BACKEND, "supabase");
  assert.deepEqual(result.body.counts, { candidates: 2, processed: 1, skipped: 0, failed: 1 });
  assert.equal(result.ok, false);
});
