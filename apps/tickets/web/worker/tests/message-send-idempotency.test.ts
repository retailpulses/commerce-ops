import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { MessageSendService, SendError } from "../src/services/messageSendService";
import type {
  CopywritingRepository,
  SentMessage,
  TicketDetail,
  TicketMessage,
  TicketRepository,
} from "../src/repositories/ticketRepository";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CLAIMED_AT = "2026-07-15T00:00:00.000Z";
const SENT_AT = "2026-07-15T00:00:01.000Z";

const ticket = {
  id: "22222222-2222-4222-8222-222222222222",
  ticket_number: "T-1",
  platform: "mercari",
  external_order_id: "order-1",
  status: "open",
  needs_reply: true,
} as TicketDetail;

function ticketMessage(platformMessageId: string): TicketMessage {
  return {
    id: "message-1",
    ticket_id: ticket.id,
    platform: "mercari",
    external_message_id: platformMessageId,
    sender_type: "operator",
    sender_display_name: null,
    body: "final reply",
    sent_at: SENT_AT,
    raw_payload: { client_operation_id: OPERATION_ID },
    created_at: SENT_AT,
  };
}

class FakeCopyRepository {
  row: SentMessage | null = null;
  persistedTicketMessage: TicketMessage | null = null;
  finalizeCalls = 0;
  failAfterFinalizeOnce = false;

  async claimPlatformSentMessage(input: {
    ticket_id: string;
    platform: string;
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    sent_by?: string | null;
  }) {
    if (!this.row) {
      this.row = {
        id: "sent-1",
        ticket_id: input.ticket_id,
        platform: input.platform,
        platform_message_id: null,
        body: input.body,
        reply_intent: input.reply_intent,
        sent_by: input.sent_by ?? null,
        sent_at: CLAIMED_AT,
        created_at: CLAIMED_AT,
        client_operation_id: input.client_operation_id,
        delivery_status: "sending",
        delivery_error: null,
        platform_message_ids_before_send: null,
      };
      return { sentMessage: this.row, ticketMessage: null, claimed: true };
    }
    assert.equal(input.client_operation_id, this.row.client_operation_id);
    assert.equal(input.body, this.row.body);
    return {
      sentMessage: this.row,
      ticketMessage: this.persistedTicketMessage,
      claimed: false,
    };
  }

  async finalizeSentMessage(input: {
    platform_message_id: string;
    platform_sent_at: string;
  }) {
    this.finalizeCalls += 1;
    assert.ok(this.row);
    this.row = {
      ...this.row!,
      platform_message_id: input.platform_message_id,
      sent_at: input.platform_sent_at,
      delivery_status: "sent",
      delivery_error: null,
    };
    this.persistedTicketMessage = ticketMessage(input.platform_message_id);
    if (this.failAfterFinalizeOnce) {
      this.failAfterFinalizeOnce = false;
      throw new Error("database response lost after commit");
    }
    return {
      sentMessage: this.row,
      ticketMessage: this.persistedTicketMessage,
      replayed: this.finalizeCalls > 1,
    };
  }

  async releasePlatformSentMessageClaim() { this.row = null; }
  async recordPlatformSentMessagePreflight(_ticketId: string, _operationId: string, _platform: "mercari" | "rakuten", ids: string[]) {
    assert.ok(this.row);
    this.row = { ...this.row!, platform_message_ids_before_send: ids };
  }
  async markPlatformSentMessageAmbiguous(_ticketId: string, _operationId: string, _platform: "mercari" | "rakuten", error: string) {
    assert.ok(this.row);
    this.row = { ...this.row!, delivery_status: "ambiguous", delivery_error: error };
  }
}

function service(
  copy: FakeCopyRepository,
  thread: Array<{ id: string; createdAt: string; message: string; role: string }>,
  sendPlatformReply: () => Promise<{ id: string; createdAt: string }>,
) {
  return new MessageSendService(
    {} as TicketRepository,
    copy as unknown as CopywritingRepository,
    {
      fetchThread: async () => ({ data: { orderTransaction: { messages: thread } } }),
      sendPlatformReply: async () => sendPlatformReply(),
    },
  );
}

const input = {
  ticket,
  mercariToken: "token",
  transactionId: "order-1",
  message: "final reply",
  clientOperationId: OPERATION_ID,
  replyIntent: "terminal" as const,
  sentBy: "operator-1",
};

describe("operator outbound message idempotency", () => {
  it("replays a committed database result after its response is lost without sending twice", async () => {
    const copy = new FakeCopyRepository();
    copy.failAfterFinalizeOnce = true;
    let platformSends = 0;
    const subject = service(copy, [], async () => {
      platformSends += 1;
      return { id: "platform-1", createdAt: SENT_AT };
    });

    await assert.rejects(subject.sendReply(input), /database response lost/);
    const retry = await subject.sendReply(input);

    assert.equal(platformSends, 1);
    assert.equal(retry.platformMessageId, "platform-1");
    assert.equal(retry.replayed, true);
    assert.equal(copy.finalizeCalls, 1);
  });

  it("reconciles a platform-committed ambiguous send from the thread without resending", async () => {
    const copy = new FakeCopyRepository();
    const thread: Array<{ id: string; createdAt: string; message: string; role: string }> = [];
    let platformSends = 0;
    const subject = service(copy, thread, async () => {
      platformSends += 1;
      thread.push({ id: "platform-2", createdAt: SENT_AT, message: input.message, role: "SELLER" });
      throw new Error("connection reset after platform commit");
    });

    await assert.rejects(subject.sendReply(input), (error: unknown) =>
      error instanceof SendError && error.code === "MERCARI_SEND_FAILED");
    const retry = await subject.sendReply(input);

    assert.equal(platformSends, 1);
    assert.equal(retry.platformMessageId, "platform-2");
    assert.equal(retry.replayed, true);
    assert.equal(copy.row?.delivery_status, "sent");
  });

  it("fails closed when an earlier operation is unconfirmed", async () => {
    const copy = new FakeCopyRepository();
    await copy.claimPlatformSentMessage({
      ticket_id: ticket.id,
      platform: ticket.platform,
      client_operation_id: OPERATION_ID,
      body: input.message,
      reply_intent: input.replyIntent,
    });
    let platformSends = 0;
    const subject = service(copy, [], async () => {
      platformSends += 1;
      return { id: "unexpected", createdAt: SENT_AT };
    });

    await assert.rejects(subject.sendReply(input), (error: unknown) =>
      error instanceof SendError && error.code === "DELIVERY_UNCONFIRMED");
    assert.equal(platformSends, 0);
  });

  it("keeps the schema claim and completion transaction durable", async () => {
    const migration = await readFile(
      new URL("../../../supabase/migrations/20260715000005_operator_message_idempotency.sql", import.meta.url),
      "utf8",
    );
    assert.match(migration, /uq_sent_messages_client_operation/);
    assert.match(migration, /uq_ticket_messages_client_operation/);
    assert.match(migration, /FOR UPDATE/);
    assert.match(migration, /finalize_operator_message_send/);
  });
});
