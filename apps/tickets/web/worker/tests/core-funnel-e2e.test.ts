import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_FORM_MAX_FILE_SIZE_BYTES,
  finalizeCustomerFormSubmission,
  prepareCustomerFormUploads,
} from "../src/handlers/customer-form";
import { MessageSendService } from "../src/services/messageSendService";
import { TicketService } from "../src/services/ticketService";
import {
  runTicketFormRequestAutomation,
  type AutomationDecision,
  type AutomationStore,
  type ReplyStatus,
  type TicketFormContext,
} from "../src/services/ticketFormRequestService";
import type { ClassificationMeta } from "../src/services/inboundMessageService";
import type {
  CopywritingRepository,
  CreateResolutionActionInput,
  TicketDetail,
  TicketRepository,
} from "../src/repositories/ticketRepository";
import type { Env, MercariTransaction } from "../src/types";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const INBOUND_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-15T00:00:00.000Z";

interface TokenRow {
  id: string;
  token_hash: string;
  ticket_id: string | null;
  customer_submission_id: string | null;
  platform: string;
  account_id: string;
  external_order_id: string;
  allowed_submission_type: string;
  status: "active" | "used";
  expires_at: string;
  max_upload_count: number;
  used_count: number;
}

class Query {
  private filters = new Map<string, unknown>();

  constructor(private state: CoreFunnelState, private table: string) {}
  select(): this { return this; }
  eq(column: string, value: unknown): this { this.filters.set(column, value); return this; }

  async single(): Promise<{ data: unknown; error: { message: string } | null }> {
    if (this.table === "submission_tokens") {
      const token = [...this.state.tokens.values()].find((row) =>
        [...this.filters].every(([column, value]) => row[column as keyof TokenRow] === value));
      return token ? { data: token, error: null } : { data: null, error: { message: "not found" } };
    }
    if (this.table === "platform_accounts" && this.filters.get("id") === ACCOUNT_ID) {
      return { data: { display_name: "Shop1" }, error: null };
    }
    return { data: null, error: { message: "not found" } };
  }

  async maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }> {
    return this.single();
  }
}

/** One stateful credential-free boundary shared by every real domain service in the funnel. */
class CoreFunnelState implements AutomationStore {
  tokens = new Map<string, TokenRow>();
  objects = new Map<string, { size: number; mime: string }>();
  tickets = new Map<string, TicketDetail>();
  submissions = new Set<string>();
  attachments = new Map<string, Array<Record<string, unknown>>>();
  inbound = { id: INBOUND_ID, queue_status: "unread", linked_ticket_id: null as string | null };
  thread: Array<{ id: string; createdAt: string; message: string; role: string }> = [
    { id: "buyer-1", createdAt: NOW, message: "商品が破損しています", role: "BUYER" },
  ];
  sentMessages = new Map<string, any>();
  ticketMessages = new Map<string, any>();
  automationOutcomes: Array<{ decision: AutomationDecision; reason: string; replyStatus: ReplyStatus }> = [];
  ticketCreationAuthorities: string[] = [];
  formRequestPlatformSends = 0;
  resolutionReplyPlatformSends = 0;
  baserowAccesses = 0;

  readonly supabase = {
    from: (table: string) => new Query(this, table),
    storage: {
      from: (_bucket: string) => ({
        createSignedUploadUrl: async (path: string) => ({
          data: { signedUrl: `https://storage.test/upload/${encodeURIComponent(path)}` },
          error: null,
        }),
        remove: async (paths: string[]) => {
          paths.forEach((path) => this.objects.delete(path));
          return { error: null };
        },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "finalize_ticketform_submission");
      const token = this.tokens.get(String(args.p_token_id));
      assert.ok(token, "finalization must use the automation-created token");
      const submissionId = String(args.p_submission_id);
      const evidence = args.p_attachments as Array<{
        storage_path: string; size_bytes: number; mime_type: string;
      }>;

      if (token.status === "used") {
        assert.equal(token.customer_submission_id, submissionId);
        return {
          data: [{
            ticket_id: token.ticket_id,
            submission_id: submissionId,
            created_ticket: false,
            replayed: true,
          }],
          error: null,
        };
      }

      for (const item of evidence) {
        const object = this.objects.get(item.storage_path);
        assert.ok(object, `staged object missing: ${item.storage_path}`);
        assert.equal(object.size, item.size_bytes);
        assert.equal(object.mime, item.mime_type);
      }

      const ticketId = "44444444-4444-4444-8444-444444444444";
      this.ticketCreationAuthorities.push("form_submission");
      this.submissions.add(submissionId);
      this.attachments.set(submissionId, evidence.map((item) => ({ ...item })));
      const ticket = this.makeTicket(ticketId, token.external_order_id);
      this.tickets.set(ticketId, ticket);
      token.status = "used";
      token.ticket_id = ticketId;
      token.customer_submission_id = submissionId;
      token.used_count = 1;
      this.inbound.queue_status = "linked";
      this.inbound.linked_ticket_id = ticketId;
      return {
        data: [{ ticket_id: ticketId, submission_id: submissionId, created_ticket: true, replayed: false }],
        error: null,
      };
    },
  } as unknown as SupabaseClient;

  uploadObject(path: string, size: number, mime: string): void {
    this.objects.set(path, { size, mime });
  }

  async resolveAccountId(): Promise<string> { return ACCOUNT_ID; }
  async resolveProduct(sku: string): Promise<{ name: string; sku: string }> {
    return { name: "Test Video Product", sku };
  }
  async hasActiveCase(caseKey: string, inboundId: string): Promise<boolean> {
    return [...this.tokens.values()].some((token: any) =>
      token.automation_case_key === caseKey && token.source_inbound_message_id !== inboundId);
  }
  async createToken(input: {
    tokenHash: string; context: TicketFormContext; caseKey: string; expiresAt: string;
  }): Promise<string> {
    const existing = [...this.tokens.values()].find((token) => token.token_hash === input.tokenHash);
    if (existing) return existing.id;
    const id = "55555555-5555-4555-8555-555555555555";
    this.tokens.set(id, Object.assign({
      id,
      token_hash: input.tokenHash,
      ticket_id: null,
      customer_submission_id: null,
      platform: input.context.platform,
      account_id: input.context.accountId,
      external_order_id: input.context.externalOrderId,
      allowed_submission_type: "aftersales_request",
      status: "active" as const,
      expires_at: input.expiresAt,
      max_upload_count: 5,
      used_count: 0,
    }, {
      automation_case_key: input.caseKey,
      source_inbound_message_id: input.context.inboundId,
    }));
    return id;
  }
  async claimSend(_inboundId: string, tokenId: string): Promise<boolean> {
    return !this.automationOutcomes.some((outcome) => outcome.replyStatus === "sent") && this.tokens.has(tokenId);
  }
  async persist(_inboundId: string, patch: {
    decision: AutomationDecision; reason: string; replyStatus: ReplyStatus;
  }): Promise<void> {
    this.automationOutcomes.push(patch);
  }

  makeTicket(id: string, orderId: string): TicketDetail {
    return {
      id, ticket_number: "T-1", platform: "mercari", account_id: ACCOUNT_ID,
      external_order_id: orderId, external_thread_id: null, origin: "form_submission",
      customer_display_name: null, customer_contact: null, subject: "Damaged product",
      description: "Video evidence supplied", status: "open", priority: "high",
      issue_types: ["quality_issue"], assigned_user_id: null, assigned_display_name: null,
      latest_message_at: NOW, latest_customer_message: "商品が破損しています", needs_reply: true,
      external_url: null, raw_source_payload: { source: "ticketform_submission" },
      started_at: NOW, created_at: NOW, updated_at: NOW, closed_at: null,
      products: [], messages: [], notes: [], events: [], resolution_actions: [],
    };
  }

  readonly ticketRepo = {
    getTicket: async (id: string) => this.tickets.get(id) ?? null,
    recordResolutionAction: async (input: CreateResolutionActionInput) => {
      const ticket = this.tickets.get(input.ticket_id)!;
      const existing = ticket.resolution_actions.find((action) => action.operation_id === input.operation_id);
      if (existing) return existing;
      const action = {
        id: "66666666-6666-4666-8666-666666666666", ticket_id: ticket.id,
        action_type: input.action_type, amount: input.amount ?? null, currency: input.currency ?? "JPY",
        replacement_sku: input.replacement_sku ?? null, quantity: input.quantity ?? null,
        reason: input.reason ?? null, approved_by: null, external_reference: input.external_reference ?? null,
        operation_id: input.operation_id, executed_at: NOW, created_at: NOW,
      };
      ticket.resolution_actions.push(action);
      return action;
    },
    updateTicket: async (id: string, patch: { status?: string }) => {
      const ticket = this.tickets.get(id)!;
      if (patch.status) ticket.status = patch.status;
      if (patch.status === "closed") ticket.closed_at = NOW;
      return ticket;
    },
    addTicketEvent: async (input: Record<string, unknown>) => ({ id: crypto.randomUUID(), created_at: NOW, actor_id: null, ...input }),
  } as unknown as TicketRepository;

  readonly copyRepo = {
    claimPlatformSentMessage: async (input: any) => {
      const existing = this.sentMessages.get(input.client_operation_id);
      if (existing) {
        return {
          sentMessage: existing,
          ticketMessage: this.ticketMessages.get(input.client_operation_id) ?? null,
          claimed: false,
        };
      }
      const row = {
        id: "sent-1", ...input, platform_message_id: null, sent_at: NOW, created_at: NOW,
        delivery_status: "sending", delivery_error: null, platform_message_ids_before_send: null,
      };
      this.sentMessages.set(input.client_operation_id, row);
      return { sentMessage: row, ticketMessage: null, claimed: true };
    },
    recordPlatformSentMessagePreflight: async (_ticketId: string, operationId: string, _platform: "mercari" | "rakuten", ids: string[]) => {
      this.sentMessages.get(operationId).platform_message_ids_before_send = ids;
    },
    finalizeSentMessage: async (input: any) => {
      const sent = this.sentMessages.get(input.client_operation_id);
      sent.platform_message_id = input.platform_message_id;
      sent.sent_at = input.platform_sent_at;
      sent.delivery_status = "sent";
      const message = {
        id: "ticket-message-1", ticket_id: input.ticket_id, platform: "mercari",
        external_message_id: input.platform_message_id, sender_type: "operator",
        sender_display_name: null, body: sent.body, sent_at: input.platform_sent_at,
        raw_payload: { client_operation_id: input.client_operation_id }, created_at: input.platform_sent_at,
      };
      this.ticketMessages.set(input.client_operation_id, message);
      return { sentMessage: sent, ticketMessage: message, replayed: false };
    },
    releasePlatformSentMessageClaim: async () => undefined,
    markPlatformSentMessageAmbiguous: async () => undefined,
  } as unknown as CopywritingRepository;
}

function classification(): ClassificationMeta {
  return {
    classification: "real_ticket/quality_issue", workflow_route: "ticket_handling",
    recommended_operator_action: "request_ticketform",
    recommended_for_manual_creation: false,
    should_convert_to_ticket: false,
    suggested_ticket_type: "quality_issue", suggested_category: null, suggested_priority: "high",
    confidence: 0.99, reasoning_summary: "Clear damage report", automation_eligible: true,
    automation_blockers: [], model: "credential-free-test", prompt_version: "core-funnel-v1",
    raw_classifier_response: {},
  };
}

function transaction(state: CoreFunnelState): MercariTransaction {
  return {
    id: "order-1", status: "COMPLETED", createdAt: NOW, shop: "Shop1",
    messages: state.thread as MercariTransaction["messages"],
    products: [{ productId: "product-1", variant: { skuCode: "SKU-1" }, purchasedQuantity: 1 }],
  };
}

describe("credential-free unified core business funnel", () => {
  it("runs Message -> TicketForm -> one ticket/evidence set -> resolution/reply/close idempotently", async () => {
    const state = new CoreFunnelState();
    const env = {
      TICKETFORM_AUTOMATION_MODE: "active",
      TICKETFORM_PUBLIC_BASE_URL: "https://tickets.example.test",
      TICKETFORM_TOKEN_SIGNING_SECRET: "credential-free-test-secret",
    } as Env;

    const sendFormRequest = async (_token: string, _orderId: string, message: string) => {
      state.formRequestPlatformSends += 1;
      state.thread.push({ id: "seller-form-1", createdAt: NOW, message, role: "SELLER" });
      return { id: "seller-form-1", createdAt: NOW };
    };
    const automationInput = {
      env, inboundId: INBOUND_ID, shopName: "Shop1", transaction: transaction(state),
      classification: classification(), mercariToken: "fake-platform-token", store: state,
      sendPlatformReply: sendFormRequest,
    };
    const firstAutomation = await runTicketFormRequestAutomation(automationInput);
    const duplicateInbound = await runTicketFormRequestAutomation({ ...automationInput, transaction: transaction(state) });
    assert.equal(firstAutomation.replyStatus, "sent");
    assert.equal(duplicateInbound.reason, "latest_message_not_buyer");
    assert.equal(state.formRequestPlatformSends, 1);
    assert.equal(state.tokens.size, 1);
    assert.equal(state.tickets.size, 0, "message automation must not create a ticket");

    const formMessage = state.thread.find((message) => message.id === "seller-form-1")!.message;
    const plainToken = formMessage.match(/forms\/after-sales\/([a-f0-9]{64})/)?.[1];
    assert.ok(plainToken, "automation reply must contain a usable TicketForm token");

    const prepareResponse = await prepareCustomerFormUploads(new Request("https://tickets.example.test/api/forms/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{
        filename: "damage-proof.mp4", mime_type: "video/mp4",
        size_bytes: CUSTOMER_FORM_MAX_FILE_SIZE_BYTES,
      }] }),
    }), env, plainToken, { supabase: state.supabase });
    assert.equal(prepareResponse.status, 200);
    const prepared = await prepareResponse.json() as { submission_id: string; uploads: Array<any> };
    assert.equal(prepared.uploads[0].size_bytes, 100 * 1024 * 1024);
    state.uploadObject(prepared.uploads[0].storage_path, CUSTOMER_FORM_MAX_FILE_SIZE_BYTES, "video/mp4");

    const finalizeBody = {
      submission_id: prepared.submission_id,
      issue_description: "The product arrived damaged; see the video.",
      expected_solution: "Replacement",
      attachments: prepared.uploads.map(({ signed_url: _signedUrl, ...attachment }) => attachment),
    };
    const finalize = () => finalizeCustomerFormSubmission(new Request("https://tickets.example.test/api/forms/finalize", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(finalizeBody),
    }), env, plainToken, {
      supabase: state.supabase,
      verifyStoredEvidence: async () => ({ valid: true }),
    });
    const firstFinalization = await finalize();
    const replayedFinalization = await finalize();
    assert.equal(firstFinalization.status, 200);
    assert.equal(replayedFinalization.status, 200);
    assert.equal((await replayedFinalization.json() as { replayed: boolean }).replayed, true);
    assert.equal(state.tickets.size, 1);
    assert.equal(state.submissions.size, 1);
    assert.equal(state.attachments.get(prepared.submission_id)?.length, 1);
    assert.equal(state.inbound.queue_status, "linked");

    const ticket = [...state.tickets.values()][0];
    const ticketService = new TicketService(state.ticketRepo);
    const resolution = await ticketService.recordResolution({
      ticket_id: ticket.id, operation_id: OPERATION_ID, action_type: "replacement",
      replacement_sku: "SKU-1-REPLACEMENT", reason: "Video confirms transit damage",
    });
    assert.equal(resolution.error, null);

    const sendService = new MessageSendService(state.ticketRepo, state.copyRepo, {
      fetchThread: async () => ({ data: { orderTransaction: { messages: state.thread } } }) as any,
      sendPlatformReply: async (_token, _orderId, message) => {
        state.resolutionReplyPlatformSends += 1;
        state.thread.push({ id: "seller-resolution-1", createdAt: NOW, message, role: "SELLER" });
        return { id: "seller-resolution-1", createdAt: NOW };
      },
    });
    const sendInput = {
      ticket, mercariToken: "fake-platform-token", transactionId: "order-1",
      message: "交換品を手配しました。", clientOperationId: OPERATION_ID,
      replyIntent: "terminal" as const, sentBy: "operator-1",
    };
    const firstReply = await sendService.sendReply(sendInput);
    const replayedReply = await sendService.sendReply(sendInput);
    assert.equal(firstReply.replayed, false);
    assert.equal(replayedReply.replayed, true);
    assert.equal(state.resolutionReplyPlatformSends, 1);

    const closed = await ticketService.updateTicket(ticket.id, { status: "closed" });
    assert.equal(closed.error, null);
    assert.equal(closed.ticket?.status, "closed");
    assert.equal(ticket.resolution_actions.length, 1);
    assert.deepEqual(state.ticketCreationAuthorities, ["form_submission"]);
    assert.equal(state.baserowAccesses, 0);
  });
});
