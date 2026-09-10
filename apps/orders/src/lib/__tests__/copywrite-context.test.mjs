// ── Unit tests for copywrite-context.mjs ──────────────────────────
import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { buildContext, renderContextForPrompt, renderContextForLog } from "../copywrite-context.mjs";

// Sample data fixtures
const mockOrderRow = {
  order_id: "order_abc123",
  product_name: "ダイニングテーブル 120cm",
  product_code: "DT-120",
  shipping_name: "田中太郎",
  order_status: "WAITING_FOR_SHIPPING",
  shop_id: "shop2_id",
};

const mockMessages = [
  { role: "BUYER", message: "発送はいつになりますか？", createdAt: "2026-06-16T10:00:00+09:00" },
  { role: "SELLER", message: "ご連絡ありがとうございます。確認中です。", createdAt: "2026-06-16T14:00:00+09:00" },
  { role: "BUYER", message: "急いでいます。", createdAt: "2026-06-16T15:00:00+09:00" },
];

describe("buildContext", () => {
  it("extracts customer name from shipping_name", () => {
    const ctx = buildContext(mockOrderRow, []);
    assert.equal(ctx.customerName, "田中太郎");
  });

  it("falls back to buyer_name when shipping_name is empty", () => {
    const row = { ...mockOrderRow, shipping_name: "", buyer_name: "鈴木花子" };
    const ctx = buildContext(row, []);
    assert.equal(ctx.customerName, "鈴木花子");
  });

  it("falls back to customer_name when both are empty", () => {
    const row = { ...mockOrderRow, shipping_name: "", buyer_name: "", customer_name: "佐藤健" };
    const ctx = buildContext(row, []);
    assert.equal(ctx.customerName, "佐藤健");
  });

  it("falls back to 'お客様' when all name fields are missing", () => {
    const ctx = buildContext({}, []);
    assert.equal(ctx.customerName, "お客様");
  });

  it("extracts product info", () => {
    const ctx = buildContext(mockOrderRow, []);
    assert.equal(ctx.productName, "ダイニングテーブル 120cm");
    assert.equal(ctx.productCode, "DT-120");
  });

  it("handles missing product name gracefully", () => {
    const ctx = buildContext({ order_id: "x" }, []);
    assert.equal(ctx.productName, "(商品名なし)");
    assert.equal(ctx.productCode, "");
  });

  it("maps order status to Japanese label", () => {
    const ctx = buildContext(mockOrderRow, []);
    assert.equal(ctx.orderStatus, "発送待ち");
  });

  it("maps 'COMPLETED' to '完了'", () => {
    const row = { ...mockOrderRow, order_status: "COMPLETED" };
    const ctx = buildContext(row, []);
    assert.equal(ctx.orderStatus, "完了");
  });

  it("uses raw status when unknown", () => {
    const row = { ...mockOrderRow, order_status: "SomeNewStatus" };
    const ctx = buildContext(row, []);
    assert.equal(ctx.orderStatus, "SomeNewStatus");
  });

  it("maps message roles: BUYER → お客様, SELLER → 運営", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    assert.equal(ctx.messageHistory.length, 3);
    assert.equal(ctx.messageHistory[0].role, "お客様");
    assert.equal(ctx.messageHistory[1].role, "運営");
    assert.equal(ctx.messageHistory[2].role, "お客様");
  });

  it("extracts latest customer message (last BUYER)", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    assert.equal(ctx.latestCustomerMessage, "急いでいます。");
    // First buyer's message should NOT be the latest
    assert.notEqual(ctx.latestCustomerMessage, "発送はいつになりますか？");
  });

  it("returns empty latestCustomerMessage when no BUYER messages", () => {
    const msgs = [{ role: "SELLER", message: "test", createdAt: "2026-01-01T00:00:00Z" }];
    const ctx = buildContext(mockOrderRow, msgs);
    assert.equal(ctx.latestCustomerMessage, "");
  });

  it("formats message timestamps to JST", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    assert.ok(ctx.messageHistory[0].ts.includes("2026-06-16"), "should include date");
    assert.ok(ctx.messageHistory[0].ts.includes("10:00"), "should include time");
  });

  it("handles missing createdAt gracefully", () => {
    const msgs = [{ role: "BUYER", message: "hello" }];
    const ctx = buildContext(mockOrderRow, msgs);
    assert.equal(ctx.messageHistory[0].ts, "");
  });

  it("handles empty messages array", () => {
    const ctx = buildContext(mockOrderRow, []);
    assert.equal(ctx.messageCount, 0);
    assert.deepEqual(ctx.messageHistory, []);
    assert.equal(ctx.latestCustomerMessage, "");
  });

  it("handles null/undefined messages", () => {
    const ctx = buildContext(mockOrderRow, null);
    assert.equal(ctx.messageCount, 0);
  });

  it("includes shopLabel from options", () => {
    const ctx = buildContext(mockOrderRow, [], { shopLabel: "Shop2" });
    assert.equal(ctx.shopLabel, "Shop2");
  });

  it("falls back to shop_id from row when no shopLabel option", () => {
    const ctx = buildContext(mockOrderRow, []);
    assert.equal(ctx.shopLabel, "shop2_id");
  });

  it("handles null orderRow gracefully", () => {
    const ctx = buildContext(null, []);
    assert.equal(ctx.customerName, "お客様");
    assert.equal(ctx.orderId, "");
  });
});

describe("renderContextForPrompt", () => {
  it("produces Japanese polish prompt with customer info and draft", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    const draftText = "いつ発送されますか？教えてください。";
    const prompt = renderContextForPrompt(ctx, draftText);
    assert.ok(prompt.includes("田中太郎"), "should include customer name");
    assert.ok(prompt.includes("ダイニングテーブル 120cm"), "should include product name");
    assert.ok(prompt.includes("DT-120"), "should include product code");
    assert.ok(prompt.includes("発送待ち"), "should include order status");
    assert.ok(prompt.includes("order_abc123"), "should include order ID");
    assert.ok(prompt.includes("【お客様情報】"), "should have customer info section");
    assert.ok(prompt.includes("【運営者の下書き】"), "should have operator draft section");
    assert.ok(prompt.includes(draftText), "should include the draft text");
    assert.ok(prompt.includes("校正・添削"), "should mention polish/proofread");
  });

  it("does not include message history or generation instructions", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    const prompt = renderContextForPrompt(ctx, "発送予定を確認します。");
    assert.ok(!prompt.includes("【メッセージ履歴】"), "should not have message history section");
    assert.ok(!prompt.includes("【最新のお客様メッセージ】"), "should not have latest message section");
    assert.ok(!prompt.includes("発送はいつになりますか？"), "should not include customer messages");
    assert.ok(!prompt.includes("返信文を日本語で生成"), "should not include generate-from-scratch instruction");
  });

  it("still renders polish instructions when draftText is empty", () => {
    const ctx = buildContext(mockOrderRow, []);
    const prompt = renderContextForPrompt(ctx);
    assert.ok(prompt.includes("【運営者の下書き】"), "should have operator draft section");
    assert.ok(prompt.includes("校正・添削"), "should mention polish/proofread");
    assert.ok(!prompt.includes("【最新のお客様メッセージ】"), "should not have latest message section");
  });

  it("omits product code line when empty", () => {
    const ctx = buildContext({ order_id: "x", product_name: "test" }, []);
    const prompt = renderContextForPrompt(ctx, "下書き");
    assert.ok(!prompt.includes("商品コード:"), "should not have product code line");
  });
});

describe("renderContextForLog", () => {
  const meta = {
    generatedAt: "2026-06-16T15:30:00+09:00",
    model: "gpt-4o",
    temperature: 0.3,
    usage: { prompt_tokens: 150, completion_tokens: 200, total_tokens: 350 },
    generatedBy: "jim-young",
    draft: "田中様\n\nご連絡ありがとうございます。\nホムブリスカスタマーサポート",
  };

  it("produces structured log with generation metadata", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    const log = renderContextForLog(ctx, meta);

    assert.ok(log.includes("AI Copywrite Log"), "should have log header");
    assert.ok(log.includes("2026-06-16T15:30:00+09:00"), "should include timestamp");
    assert.ok(log.includes("gpt-4o"), "should include model");
    assert.ok(log.includes("0.3"), "should include temperature");
    assert.ok(log.includes("in=150"), "should include prompt tokens");
    assert.ok(log.includes("out=200"), "should include completion tokens");
    assert.ok(log.includes("total=350"), "should include total tokens");
    assert.ok(log.includes("jim-young"), "should include operator name");
  });

  it("includes context section", () => {
    const ctx = buildContext(mockOrderRow, mockMessages, { shopLabel: "Shop2" });
    const log = renderContextForLog(ctx, meta);

    assert.ok(log.includes("Context"), "should have context section");
    assert.ok(log.includes("田中太郎"), "should include customer name");
    assert.ok(log.includes("ダイニングテーブル 120cm"), "should include product");
    assert.ok(log.includes("DT-120"), "should include product code");
    assert.ok(log.includes("発送待ち"), "should include status");
    assert.ok(log.includes("order_abc123"), "should include order ID");
    assert.ok(log.includes("Shop2"), "should include shop label");
    assert.ok(log.includes("Messages (3 total)"), "should include message count");
  });

  it("includes generated draft text", () => {
    const ctx = buildContext(mockOrderRow, mockMessages);
    const log = renderContextForLog(ctx, meta);

    assert.ok(log.includes("Generated Draft"), "should have draft section");
    assert.ok(log.includes("田中様"), "should include draft greeting");
    assert.ok(log.includes("ホムブリスカスタマーサポート"), "should include signature");
  });

  it("shows empty draft when none provided", () => {
    const ctx = buildContext(mockOrderRow, []);
    const log = renderContextForLog(ctx, { ...meta, draft: "" });
    assert.ok(log.includes("(empty)"), "should show empty placeholder");
  });

  it("uses '?' placeholders for missing token counts", () => {
    const ctx = buildContext(mockOrderRow, []);
    const log = renderContextForLog(ctx, { generatedAt: "", model: "", temperature: 0.3, usage: null, generatedBy: "", draft: "" });
    assert.ok(log.includes("in=?"), "should use ? for missing prompt tokens");
    assert.ok(log.includes("out=?"), "should use ? for missing completion tokens");
    assert.ok(log.includes("total=?"), "should use ? for missing total tokens");
  });

  it("handles multi-line messages in context", () => {
    const msgs = [{ role: "BUYER", message: "line1\nline2\nline3", createdAt: "2026-06-16T10:00:00+09:00" }];
    const ctx = buildContext(mockOrderRow, msgs);
    const log = renderContextForLog(ctx, meta);
    assert.ok(log.includes("line1"), "should include line1");
    assert.ok(log.includes("line2"), "should include line2");
    assert.ok(log.includes("line3"), "should include line3");
  });

  it("handles null context fields gracefully", () => {
    const ctx = buildContext(null, null);
    const log = renderContextForLog(ctx, meta);
    assert.ok(typeof log === "string", "should return a string");
    assert.ok(log.length > 0, "should not be empty");
  });
});
