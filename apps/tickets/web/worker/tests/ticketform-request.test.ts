import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  automationModeAllowsShop,
  decideTicketFormAction,
  runTicketFormRequestAutomation,
  type AutomationDecision,
  type AutomationStore,
  type ReplyStatus,
  type TicketFormContext,
} from "../src/services/ticketFormRequestService";
import type { Env, MercariTransaction } from "../src/types";
import type { ClassificationMeta } from "../src/services/inboundMessageService";

function classification(label: string, confidence = 0.95, blockers: string[] = []): ClassificationMeta {
  return {
    classification: label,
    workflow_route: "ticket_handling",
    recommended_operator_action: "review_ticket",
    recommended_for_manual_creation: true,
    should_convert_to_ticket: true,
    suggested_ticket_type: "quality_issue",
    suggested_category: null,
    suggested_priority: "high",
    confidence,
    reasoning_summary: "test",
    automation_eligible: false,
    automation_blockers: blockers,
    model: "test-model",
    prompt_version: "test-prompt",
    raw_classifier_response: {},
  };
}

function transaction(messages = [{ id: "buyer-1", createdAt: "2026-07-15T00:00:00Z", message: "壊れています", role: "BUYER" as const }]): MercariTransaction {
  return {
    id: "m-order-1",
    status: "COMPLETED",
    createdAt: "2026-07-14T00:00:00Z",
    shop: "Shop1",
    messages,
    products: [{ productId: "product-1", variant: { skuCode: "SKU-1" }, purchasedQuantity: 1 }],
  };
}

class FakeStore implements AutomationStore {
  outcomes: Array<{ decision: AutomationDecision; reason: string; replyStatus: ReplyStatus }> = [];
  tokenInputs: Array<{ tokenHash: string; context: TicketFormContext; caseKey: string; expiresAt: string }> = [];
  activeCase = false;
  claim = true;

  async resolveAccountId(): Promise<string | null> { return "account-1"; }
  async resolveProduct(sku: string): Promise<{ name: string; sku: string } | null> { return { name: "Test Product", sku }; }
  async hasActiveCase(): Promise<boolean> { return this.activeCase; }
  async createToken(input: { tokenHash: string; context: TicketFormContext; caseKey: string; expiresAt: string }): Promise<string> {
    this.tokenInputs.push(input);
    return "token-id-1";
  }
  async claimSend(): Promise<boolean> { return this.claim; }
  async persist(_id: string, patch: { decision: AutomationDecision; reason: string; replyStatus: ReplyStatus }): Promise<void> {
    this.outcomes.push(patch);
  }
}

const baseEnv = {
  TICKETFORM_AUTOMATION_MODE: "active",
  TICKETFORM_PUBLIC_BASE_URL: "https://tickets.example.test/",
  TICKETFORM_TOKEN_SIGNING_SECRET: "test-secret-that-is-not-deployed",
} as Env;

describe("Message-to-TicketForm decision", () => {
  it("requests a form only for a high-confidence quality issue", () => {
    assert.deepEqual(decideTicketFormAction(classification("real_ticket/quality_issue")), {
      decision: "ticketform_request",
      reason: "high_confidence_quality_issue",
    });
    assert.equal(decideTicketFormAction(classification("real_ticket/quality_issue", 0.7)).decision, "operator_review");
    assert.equal(decideTicketFormAction(classification("real_ticket/request")).decision, "operator_review");
    assert.equal(decideTicketFormAction(classification("delivery_request")).decision, "non_form_reply");
    assert.equal(decideTicketFormAction(classification("greeting_only/greeting")).decision, "no_action");
  });

  it("defaults to shadow and supports a limited-shop allow-list", () => {
    assert.equal(automationModeAllowsShop({} as Env, "Shop1"), false);
    assert.equal(automationModeAllowsShop({ TICKETFORM_AUTOMATION_MODE: "limited", TICKETFORM_AUTOMATION_SHOPS: "Shop1, Shop3" } as Env, "Shop1"), true);
    assert.equal(automationModeAllowsShop({ TICKETFORM_AUTOMATION_MODE: "limited", TICKETFORM_AUTOMATION_SHOPS: "Shop1, Shop3" } as Env, "Shop2"), false);
  });
});

describe("Message-to-TicketForm execution", () => {
  it("keeps a static no-ticket-write boundary", async () => {
    const source = await readFile(new URL("../src/services/ticketFormRequestService.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /ticketRepository|ticketService|\.from\(["']tickets["']\)|createTicket/);
    const migration = await readFile(new URL("../../../supabase/migrations/20260715000002_message_to_ticketform.sql", import.meta.url), "utf8");
    assert.doesNotMatch(migration, /INSERT\s+INTO\s+tickets|UPDATE\s+tickets/i);
  });

  it("persists shadow outcome without creating a token or sending", async () => {
    const store = new FakeStore();
    let sends = 0;
    const outcome = await runTicketFormRequestAutomation({
      env: { ...baseEnv, TICKETFORM_AUTOMATION_MODE: "shadow" },
      inboundId: "inbound-1",
      shopName: "Shop1",
      transaction: transaction(),
      classification: classification("real_ticket/quality_issue"),
      mercariToken: "mercari-token",
      store,
      sendPlatformReply: async () => { sends++; return { id: "sent", createdAt: "now" }; },
    });
    assert.equal(outcome.replyStatus, "not_attempted");
    assert.equal(outcome.reason, "shadow_mode");
    assert.equal(store.tokenInputs.length, 0);
    assert.equal(sends, 0);
  });

  it("creates one context-rich token and sends one tokenized request", async () => {
    const store = new FakeStore();
    const sentMessages: string[] = [];
    const outcome = await runTicketFormRequestAutomation({
      env: baseEnv,
      inboundId: "inbound-1",
      shopName: "Shop1",
      transaction: transaction(),
      classification: classification("real_ticket/quality_issue"),
      mercariToken: "mercari-token",
      store,
      sendPlatformReply: async (_token, _order, message) => {
        sentMessages.push(message);
        return { id: "platform-message-1", createdAt: "2026-07-15T00:01:00Z" };
      },
    });
    assert.equal(outcome.replyStatus, "sent");
    assert.equal(store.tokenInputs.length, 1);
    assert.deepEqual(store.tokenInputs[0].context, {
      inboundId: "inbound-1",
      shopName: "Shop1",
      platform: "mercari",
      accountId: "account-1",
      externalOrderId: "m-order-1",
      productName: "Test Product",
      productSku: "SKU-1",
    });
    assert.match(sentMessages[0], /https:\/\/tickets\.example\.test\/forms\/after-sales\/[a-f0-9]{64}/);
    assert.equal(sentMessages[0].includes("{{AFTERSALES_FORM_URL}}"), false);
    assert.equal(store.outcomes.at(-1)?.replyStatus, "sent");
  });

  it("blocks duplicate active cases and recovers platform-confirmed form links as sent", async () => {
    const activeStore = new FakeStore();
    activeStore.activeCase = true;
    const active = await runTicketFormRequestAutomation({
      env: baseEnv,
      inboundId: "inbound-2",
      shopName: "Shop1",
      transaction: transaction(),
      classification: classification("real_ticket/quality_issue"),
      mercariToken: "mercari-token",
      store: activeStore,
    });
    assert.equal(active.reason, "active_ticketform_already_exists");
    assert.equal(activeStore.tokenInputs.length, 0);

    const threadStore = new FakeStore();
    const inThread = await runTicketFormRequestAutomation({
      env: baseEnv,
      inboundId: "inbound-3",
      shopName: "Shop1",
      transaction: transaction([{ id: "buyer-1", createdAt: "2026-07-15T00:00:00Z", message: "https://tickets.example.test/forms/after-sales/existing", role: "BUYER" }]),
      classification: classification("real_ticket/quality_issue"),
      mercariToken: "mercari-token",
      store: threadStore,
    });
    assert.equal(inThread.reason, "ticketform_request_confirmed_in_thread");
    assert.equal(inThread.replyStatus, "sent");
    assert.equal(threadStore.tokenInputs.length, 0);
  });
});
