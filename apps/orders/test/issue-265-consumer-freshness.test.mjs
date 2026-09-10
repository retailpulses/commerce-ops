import assert from "node:assert/strict";
import test from "node:test";
import { executePhase } from "../src/lib/pipeline-runner.mjs";
import { acceptShadowLifecycleEvidence, sendPaymentReminders } from "../src/lib/payment-reminders.mjs";

test("#265 accepts only same-run Mercari shadow lifecycle evidence for a dry-run consumer", () => {
  const evidence = { run_id: "run-1", execution_mode: "shadow", platform: "mercari", completion_state: "accounting_complete" };
  assert.equal(acceptShadowLifecycleEvidence({ dryRun: true, runId: "run-1", lifecycleFreshnessEvidence: evidence })?.ok, true);
  assert.equal(acceptShadowLifecycleEvidence({ dryRun: false, runId: "run-1", lifecycleFreshnessEvidence: evidence }), null);
  assert.equal(acceptShadowLifecycleEvidence({ dryRun: true, runId: "other", lifecycleFreshnessEvidence: evidence }), null);
  assert.equal(acceptShadowLifecycleEvidence({ dryRun: true, runId: "run-1", lifecycleFreshnessEvidence: { ...evidence, completion_state: "partial" } }), null);
});

function staleDatabase() {
  const supabase = {
    from(table) {
      assert.equal(table, "order_lifecycle_watermarks");
      return {
        select() {
          return {
            async in() {
              return {
                data: [{
                  platform: "mercari", source_store_id: "WMyisFmhbGWyVAPEwsfirn",
                  completion_state: "partial", observed_at: new Date().toISOString(),
                }],
                error: null,
              };
            },
          };
        },
      };
    },
  };
  return { type: "supabase", salesOrderTableId: "sales_orders", supabase };
}

test("#265 stale lifecycle blocks fulfillment before its phase runner", async () => {
  let phaseCalls = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await executePhase({}, {
      phase: "push_orders_to_giga", shops: ["Shop1"], limit: 1, orderId: "target",
      dryRun: true, runId: "issue-265-fulfillment", mode: "orchestrator_live_canary",
      triggerType: "manual_canary", cron: "", localTransport: true,
      createDatabaseClient: () => staleDatabase(),
      phaseRunner: async () => { phaseCalls += 1; return { ok: true }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.completion_state, "blocked_by_freshness");
    assert.equal(phaseCalls, 0);
  } finally {
    console.log = originalLog;
  }
});

test("#265 stale lifecycle blocks reminders before marketplace read or send", async () => {
  let messageReads = 0;
  let sends = 0;
  const result = await sendPaymentReminders({}, {
    shops: ["Shop1"], orderId: "target", limit: 1, dryRun: false,
    client: staleDatabase(),
    fetchOrderMessages: async () => { messageReads += 1; return { ok: true, body: { ok: true } }; },
    sendOrderReply: async () => { sends += 1; return { ok: true, body: { ok: true } }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.note, "blocked_by_freshness");
  assert.equal(result.orders_checked, 0);
  assert.equal(messageReads, 0);
  assert.equal(sends, 0);
});
