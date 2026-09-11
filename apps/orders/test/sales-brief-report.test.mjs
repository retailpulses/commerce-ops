import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-key";
process.env.WECOM_WEBHOOK_URL ||= "https://example.invalid/webhook";

const { buildSummary, classify, isDirectSalesBriefExecution, revenue, classifySalesBriefSendFailure, resolveSalesBriefDeliverySlot, runSalesBrief } = await import("../scripts/sales-brief-report.mjs");

test("sales brief entrypoint recognizes an immutable-release current symlink", async () => {
  const target = fileURLToPath(new URL("../scripts/sales-brief-report.mjs", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "sales-brief-current-"));
  const currentPath = join(directory, basename(target));
  try {
    await symlink(target, currentPath);
    assert.equal(isDirectSalesBriefExecution(new URL(`file://${target}`).href, currentPath), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Rakuten pending confirmation is recognized sales", () => {
  const row = {
    sales_channel: "rakuten",
    order_status: "PENDING_CONFIRMATION",
    quantity: 2,
    product_price: 1500,
    shipping_price: 500,
  };

  assert.equal(revenue(row), 3500);
  assert.deepEqual(classify(row), {
    platform: "Rakuten",
    group: "Rakuten",
    isPaid: true,
    isWaiting: false,
    revenue: 3500,
  });
});

test("Rakuten canceled orders remain excluded", () => {
  assert.equal(classify({
    sales_channel: "rakuten",
    order_status: "CANCELED",
    quantity: 2,
    product_price: 1500,
  }), null);
});

test("Rakuten quantity contributes to paid count and revenue", () => {
  const summary = buildSummary([{
    order_id: "R-1",
    sales_channel: "rakuten",
    order_status: "PENDING_CONFIRMATION",
    quantity: 3,
    product_price: 2000,
    shipping_price: 700,
    purchase_date: new Date().toISOString(),
  }]);

  assert.equal(summary.byPlatform.Rakuten.paidCount, 1);
  assert.equal(summary.byPlatform.Rakuten.paidRevenue, 6700);
  assert.equal(summary.byPlatform.Rakuten.waitingCount, 0);
});

test("delivery slots are stable in JST and reject unscheduled invocation", () => {
  assert.equal(resolveSalesBriefDeliverySlot(new Date("2026-09-06T23:12:00Z")), "2026-09-07T08:00+09:00");
  assert.throws(() => resolveSalesBriefDeliverySlot(new Date("2026-09-07T00:12:00Z")), /outside_delivery_slot/);
  assert.equal(resolveSalesBriefDeliverySlot(new Date("2026-09-07T02:12:00Z"), "2026-09-07T11:00+09:00"), "2026-09-07T11:00+09:00");
  assert.throws(() => resolveSalesBriefDeliverySlot(new Date("2026-09-07T02:12:00Z"), "2026-09-07T11:30+09:00"), /invalid_sales_brief_delivery_slot/);
  assert.throws(() => resolveSalesBriefDeliverySlot(new Date("2026-09-07T02:12:00Z"), "2026-09-07T08:00+09:00"), /slot_mismatch/);
  assert.throws(() => resolveSalesBriefDeliverySlot(new Date("2026-09-07T02:12:00Z"), "2026-09-07T03:00+09:00"), /invalid_sales_brief_delivery_slot/);
});

test("only an authoritative WeCom errcode proves definitive rejection", () => {
  assert.equal(classifySalesBriefSendFailure({ status: 400, body: { errcode: 40003 } }).status, "DEFINITIVE_FAILURE");
  assert.equal(classifySalesBriefSendFailure({ status: 502, body: null }).status, "UNKNOWN_RESULT");
  assert.equal(classifySalesBriefSendFailure({ status: 500, body: { message: "gateway" } }).status, "UNKNOWN_RESULT");
});

const quietLog = { log() {}, error() {} };
const fresh = async () => ({ ok: true });
const rows = async () => [];

test("sales brief claims and confirms one stable slot before reporting delivery", async () => {
  const events = [];
  const result = await runSalesBrief({
    checkFreshness: fresh, loadOrders: rows, log: quietLog,
    now: new Date("2026-09-06T23:01:00Z"), ledgerClient: {},
    hashPayload: async () => "hash",
    claimOperation: async (_client, input) => { events.push(["claim", input]); return { claimed: true, status: "RESERVED", operationKey: "op" }; },
    sendReport: async () => { events.push(["send"]); return { ok: true, status: 200 }; },
    finalizeOperation: async (_client, input) => { events.push(["finalize", input]); },
  });
  assert.equal(result.completion_state, "completed");
  assert.equal(result.reports_sent, 1);
  assert.deepEqual(events.map(([name]) => name), ["claim", "send", "finalize"]);
  assert.equal(events[0][1].orderId, "2026-09-07T08:00+09:00");
  assert.equal(events[2][1].status, "CONFIRMED");
});

test("existing or ambiguous delivery intent prevents a second WeCom send", async () => {
  for (const [status, expectedOk, expectedState] of [
    ["CONFIRMED", true, "already_delivered"],
    ["UNKNOWN_RESULT", false, "blocked_by_delivery_intent"],
    ["RESERVED", false, "blocked_by_delivery_intent"],
  ]) {
    let sends = 0;
    const result = await runSalesBrief({
      checkFreshness: fresh, loadOrders: rows, log: quietLog,
      now: new Date("2026-09-06T23:01:00Z"), ledgerClient: {},
      hashPayload: async () => "hash",
      claimOperation: async () => ({ claimed: false, status, operationKey: "op" }),
      sendReport: async () => { sends++; return { ok: true, status: 200 }; },
    });
    assert.equal(result.ok, expectedOk);
    assert.equal(result.completion_state, expectedState);
    assert.equal(sends, 0);
  }
});

test("ambiguous WeCom transport is finalized UNKNOWN_RESULT and never auto-retried", async () => {
  const finalized = [];
  const result = await runSalesBrief({
    checkFreshness: fresh, loadOrders: rows, log: quietLog,
    now: new Date("2026-09-06T23:01:00Z"), ledgerClient: {},
    hashPayload: async () => "hash",
    claimOperation: async () => ({ claimed: true, status: "RESERVED", operationKey: "op" }),
    sendReport: async () => { throw new Error("connection_lost"); },
    finalizeOperation: async (_client, input) => { finalized.push(input); },
  });
  assert.equal(result.completion_state, "unknown_delivery_result");
  assert.equal(result.reports_sent, 0);
  assert.equal(finalized[0].status, "UNKNOWN_RESULT");
});

test("ambiguous HTTP response is UNKNOWN_RESULT while provider rejection is definitive", async () => {
  for (const [send, expectedStatus, expectedState] of [
    [{ ok: false, status: 502, body: null, error: "HTTP 502" }, "UNKNOWN_RESULT", "unknown_delivery_result"],
    [{ ok: false, status: 200, body: { errcode: 40003, errmsg: "invalid user" }, error: "invalid user" }, "DEFINITIVE_FAILURE", "send_failed"],
  ]) {
    let finalStatus = "";
    const result = await runSalesBrief({
      checkFreshness: fresh, loadOrders: rows, log: quietLog,
      now: new Date("2026-09-06T23:01:00Z"), ledgerClient: {},
      hashPayload: async () => "hash",
      claimOperation: async () => ({ claimed: true, status: "RESERVED", operationKey: "op" }),
      sendReport: async () => send,
      finalizeOperation: async (_client, input) => { finalStatus = input.status; },
    });
    assert.equal(finalStatus, expectedStatus);
    assert.equal(result.completion_state, expectedState);
  }
});

test("sales brief dry-run performs no ledger or WeCom writes", async () => {
  let writes = 0;
  const result = await runSalesBrief({
    dryRun: true, checkFreshness: fresh, loadOrders: rows, log: quietLog,
    claimOperation: async () => { writes++; },
    finalizeOperation: async () => { writes++; },
    sendReport: async () => { writes++; },
  });
  assert.equal(result.completion_state, "preview_complete");
  assert.equal(writes, 0);
});
