/**
 * Tests for LLM-only buyer-message triage.
 *
 * Intent classification must come from the configured LLM provider. Keyword
 * rules are no longer allowed to decide quality/request/inquiry/closeable
 * buckets. If DeepSeek fails, OpenAI is used as a safety fallback. If both
 * providers fail, the message must become visible manual review.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, llmClassifyMessage, setLLMConfig } from "../src/logic/classifier";
import { initTicketProcessingRuntime } from "../src/logic/runtime-config";
import { deriveWorkflowTransition } from "../src/logic/ticket-state";

let originalFetch: typeof globalThis.fetch;

function providerResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function qualityPayload(): Record<string, unknown> {
  return {
    has_defect_or_damage: true,
    has_refund_exchange_request: false,
    has_delivery_inquiry: false,
    has_product_question: false,
    has_delivery_time_request_only: false,
    is_greeting_or_info_only: false,
    closeable_type: "none",
    has_operator_action_request: true,
    operator_action_reason: "manual_action",
    confidence: 0.96,
    reasons: "concrete damage",
  };
}

function greetingPayload(): Record<string, unknown> {
  return {
    has_defect_or_damage: false,
    has_refund_exchange_request: false,
    has_delivery_inquiry: false,
    has_product_question: false,
    has_delivery_time_request_only: false,
    is_greeting_or_info_only: true,
    closeable_type: "greeting",
    has_operator_action_request: false,
    operator_action_reason: "none",
    confidence: 0.96,
    reasons: "thanks only",
  };
}

describe("LLM-only classifier contract", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setLLMConfig("deepseek-v4-flash", 200, 0.85, true, "gpt-4o");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch!;
  });

  it("does not use deterministic keyword rules for intent buckets", () => {
    assert.deepEqual(classifyMessage("商品が破損しています"), {
      cls: "suspicious",
      subcls: "unknown",
    });
  });

  it("uses DeepSeek as the primary classifier", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calledUrl = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).href;
      return providerResponse(qualityPayload());
    }) as typeof globalThis.fetch;

    const result = await llmClassifyMessage(
      "deepseek-key",
      "openai-key",
      "商品が破損しています",
      { calls: 0, cache: {} }
    );

    assert.match(calledUrl, /api\.deepseek\.com/);
    assert.equal(result.cls, "real_ticket");
    assert.equal(result.subcls, "quality_issue");
    assert.equal(result.meta.source, "llm_deepseek");
  });

  it("shared runtime initialization enables model review after disabled fallback state", async () => {
    globalThis.fetch = (async () => providerResponse(greetingPayload())) as typeof globalThis.fetch;

    setLLMConfig("deepseek-v4-flash", 200, 0.85, false, "gpt-4o");
    initTicketProcessingRuntime(true);

    const result = await llmClassifyMessage(
      "deepseek-key",
      "openai-key",
      "よろしくお願いします^_^",
      { calls: 0, cache: {} }
    );

    assert.equal(result.cls, "greeting_only");
    assert.equal(result.subcls, "greeting");
    assert.equal(result.meta.source, "llm_deepseek");
  });

  it("falls back to OpenAI when DeepSeek fails", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).href;
      calledUrls.push(urlStr);
      if (urlStr.includes("api.deepseek.com")) {
        return new Response("deepseek unavailable", { status: 503 });
      }
      return providerResponse(qualityPayload());
    }) as typeof globalThis.fetch;

    const result = await llmClassifyMessage(
      "deepseek-key",
      "openai-key",
      "商品が破損しています",
      { calls: 0, cache: {} }
    );

    assert.ok(calledUrls.some((u) => u.includes("api.deepseek.com")));
    assert.ok(calledUrls.some((u) => u.includes("api.openai.com")));
    assert.equal(result.cls, "real_ticket");
    assert.equal(result.subcls, "quality_issue");
    assert.equal(result.meta.source, "llm_openai_fallback");
    assert.ok(result.meta.primary_error);
  });

  it("returns visible manual review when all providers fail", async () => {
    globalThis.fetch = (async () => new Response("provider down", { status: 503 })) as typeof globalThis.fetch;

    const result = await llmClassifyMessage(
      "deepseek-key",
      "openai-key",
      "領収書を送ってください",
      { calls: 0, cache: {} }
    );

    assert.equal(result.cls, "suspicious");
    assert.equal(result.subcls, "unknown");
    assert.equal(result.meta.manual_review_required, true);
    assert.equal(result.meta.operator_action_required, true);
  });

  it("replays the final cached classification, not raw flags", async () => {
    let calls = 0;
    const state = { calls: 0, cache: {} };
    globalThis.fetch = (async () => {
      calls++;
      return providerResponse(greetingPayload());
    }) as typeof globalThis.fetch;

    const first = await llmClassifyMessage("deepseek-key", "openai-key", "ありがとうございました", state);
    const second = await llmClassifyMessage("deepseek-key", "openai-key", "ありがとうございました", state);

    assert.equal(calls, 1);
    assert.equal(first.cls, "greeting_only");
    assert.equal(second.cls, "greeting_only");
    assert.equal(second.meta.source, "llm_cache");
  });
});

describe("workflow transition preserves strict ticket authority", () => {
  it("manual-review fallback recommends manual creation without creating a ticket", () => {
    const transition = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "suspicious",
      subcls: "unknown",
      isFugai: false,
      operatorActionRequired: true,
      sellerRepliedAfterLatestBuyer: false,
    });

    assert.equal(transition.route, "ticket_handling");
    assert.equal(transition.shouldCreateTicket, false);
    assert.equal(transition.shouldWriteTicket, false);
    assert.match(transition.reason, /^manual_creation_recommended_/);
  });

  it("high-confidence greeting still stays closeable when no ticket exists", () => {
    const transition = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "greeting_only",
      subcls: "greeting",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });

    assert.equal(transition.route, "ignore");
    assert.equal(transition.shouldCreateTicket, false);
  });
});
