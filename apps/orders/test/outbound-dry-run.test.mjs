import assert from "node:assert/strict";
import test from "node:test";
import { runOutboundSync } from "../src/lib/outbound-sync.mjs";

test("Mercari outbound dry-run never invokes the sync writer", async () => {
  let syncCalls = 0;
  const result = await runOutboundSync({}, {
    shops: ["Shop1"], limit: 1, orderId: "order-1", dryRun: true,
  }, {
    collectScopedGroups: async () => ({ ok: true, marker: "read-only" }),
    runDryRun: async (_env, body, collected) => ({ ok: true, mode: "dry_run", body, collected }),
    runSync: async () => { syncCalls += 1; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry_run");
  assert.equal(result.results[0].sync, null);
  assert.equal(syncCalls, 0);
});

test("Rakuten outbound dry-run never invokes the sync writer", async () => {
  let syncCalls = 0;
  const result = await runOutboundSync({}, {
    shops: [], limit: 1, platform: "Rakuten", dryRun: true,
  }, {
    collectScopedGroups: async () => ({ ok: true }),
    runDryRun: async () => ({ ok: true, mode: "dry_run" }),
    runSync: async () => { syncCalls += 1; return { ok: true }; },
  });
  assert.equal(result.mode, "dry_run");
  assert.equal(syncCalls, 0);
});
