import assert from "node:assert/strict";
import test from "node:test";
import { runSalesBrief } from "../scripts/sales-brief-report.mjs";

const silentLog = { log() {}, error() {} };

test("#265 stale lifecycle evidence blocks report reads and delivery", async () => {
  let orderReads = 0;
  let sends = 0;
  let claims = 0;
  const result = await runSalesBrief({
    dryRun: false,
    checkFreshness: async () => ({ ok: false, failures: [{ scope: "mercari:shop4", reason: "stale" }] }),
    loadOrders: async () => { orderReads += 1; return [{ order_status: "WAITING_FOR_PAYMENT" }]; },
    sendReport: async () => { sends += 1; return { ok: true }; },
    claimOperation: async () => { claims += 1; throw new Error("intent_must_follow_freshness"); },
    log: silentLog,
  });
  assert.equal(result.ok, false);
  assert.equal(result.completion_state, "blocked_by_freshness");
  assert.equal(result.orders_read, 0);
  assert.equal(result.reports_sent, 0);
  assert.equal(orderReads, 0);
  assert.equal(sends, 0);
  assert.equal(claims, 0);
});

test("fresh report preview reads canonical orders but never sends", async () => {
  let sends = 0;
  const result = await runSalesBrief({
    dryRun: true,
    checkFreshness: async () => ({ ok: true, failures: [] }),
    loadOrders: async () => [],
    sendReport: async () => { sends += 1; return { ok: true }; },
    log: silentLog,
  });
  assert.equal(result.ok, true);
  assert.equal(result.completion_state, "preview_complete");
  assert.equal(result.orders_read, 0);
  assert.equal(result.reports_sent, 0);
  assert.equal(sends, 0);
});
