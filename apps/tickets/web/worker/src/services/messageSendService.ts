/** Message send service — Mercari reply orchestration.
 *  Handles: freshness check → send → double-write (sent_messages + ticket_messages).
 *  Token resolution is done by the handler; this service is platform-agnostic.
 */

import type {
  TicketRepository,
  CopywritingRepository,
  TicketDetail,
  SentMessage,
  TicketMessage,
} from "../repositories/ticketRepository";
import { fetchOrderTransaction, sendReply as mercariSendReply } from "../clients/mercari";
import { containsAfterSalesFormLink, fuguaiAlreadySent } from "../logic/templates";
import { SendError } from "./sendError";
export { SendError } from "./sendError";

export interface SendInput {
  ticket: TicketDetail;
  /** The resolved Mercari API token for the ticket's shop */
  mercariToken: string;
  /** Normalized Mercari transaction ID from ticket.external_order_id */
  transactionId: string;
  message: string;
  /** Stable UUID reused for every retry of this exact operator action. */
  clientOperationId: string;
  replyIntent: "terminal" | "holding";
  lastSeenMessageAt?: string;
  sentBy?: string | null;
}

export interface SendOutput {
  platformMessageId: string;
  sentAt: string;
  sentMessage: SentMessage;
  ticketMessage: TicketMessage;
  replayed: boolean;
  warning?: string;
  warningCode?: string;
}

export class MessageSendService {
  constructor(
    _ticketRepo: TicketRepository,
    private copyRepo: CopywritingRepository,
    private dependencies: {
      fetchThread?: typeof fetchOrderTransaction;
      sendPlatformReply?: typeof mercariSendReply;
    } = {},
  ) {}

  /** Send a reply to Mercari with freshness check and double-write. */
  async sendReply(input: SendInput): Promise<SendOutput> {
    let claim;
    try {
      claim = await this.copyRepo.claimPlatformSentMessage({
        ticket_id: input.ticket.id,
        platform: "mercari",
        client_operation_id: input.clientOperationId,
        body: input.message,
        reply_intent: input.replyIntent,
        sent_by: input.sentBy ?? null,
      });
    } catch (cause) {
      if (String(cause).includes("CLIENT_OPERATION_CONFLICT")) {
        throw new SendError(
          "This send operation was already used for different content.",
          "CLIENT_OPERATION_CONFLICT",
          409,
        );
      }
      throw cause;
    }

    if (claim.sentMessage.delivery_status === "sent") {
      if (!claim.ticketMessage || !claim.sentMessage.platform_message_id) {
        throw new SendError("Completed reply is missing its persisted result.", "SEND_RESULT_INCOMPLETE", 500);
      }
      return {
        platformMessageId: claim.sentMessage.platform_message_id,
        sentAt: claim.sentMessage.sent_at,
        sentMessage: claim.sentMessage,
        ticketMessage: claim.ticketMessage,
        replayed: true,
      };
    }

    // ── 1. Fetch current Mercari thread ──
    const fetchThread = this.dependencies.fetchThread || fetchOrderTransaction;
    const sendPlatformReply = this.dependencies.sendPlatformReply || mercariSendReply;
    let txResp;
    try {
      txResp = await fetchThread(input.mercariToken, input.transactionId);
    } catch (cause) {
      if (claim.claimed) {
        await this.copyRepo.releasePlatformSentMessageClaim(input.ticket.id, input.clientOperationId, "mercari", input.message, input.replyIntent).catch(() => undefined);
      }
      throw cause;
    }
    const tx = txResp.data?.orderTransaction as {
      messages?: Array<{ id: string; createdAt: string; message: string; role: string }>;
    } | undefined;

    if (!tx?.messages) {
      if (claim.claimed) {
        await this.copyRepo.releasePlatformSentMessageClaim(input.ticket.id, input.clientOperationId, "mercari", input.message, input.replyIntent).catch(() => undefined);
      }
      throw new SendError(
        "Failed to fetch Mercari thread. Cannot verify freshness.",
        "THREAD_FETCH_FAILED",
        500,
      );
    }

    // A previous request may have committed on Mercari before its database
    // result became visible to the caller. Reconcile the exact seller message
    // and finalize locally; never issue a second platform mutation.
    if (!claim.claimed) {
      const priorMessageIds = claim.sentMessage.platform_message_ids_before_send;
      if (!priorMessageIds) {
        throw new SendError(
          "The previous send attempt has no durable thread snapshot and cannot be retried safely.",
          "DELIVERY_UNCONFIRMED",
          409,
        );
      }
      const claimTime = Date.parse(claim.sentMessage.created_at);
      const matchingReply = [...tx.messages]
        .filter((message) =>
          message.role === "SELLER" &&
          message.message === input.message &&
          !priorMessageIds.includes(message.id) &&
          (!Number.isFinite(claimTime) || Date.parse(message.createdAt) >= claimTime - 120_000)
        )
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
      if (!matchingReply) {
        throw new SendError(
          "The previous send attempt is still unconfirmed. Refresh the platform thread before taking another action.",
          "DELIVERY_UNCONFIRMED",
          409,
        );
      }
      const finalized = await this.copyRepo.finalizeSentMessage({
        ticket_id: input.ticket.id,
        platform: "mercari",
        client_operation_id: input.clientOperationId,
        body: input.message,
        reply_intent: input.replyIntent,
        platform_message_id: matchingReply.id,
        platform_sent_at: matchingReply.createdAt,
        sent_by: input.sentBy ?? null,
      });
      return {
        platformMessageId: matchingReply.id,
        sentAt: matchingReply.createdAt,
        sentMessage: finalized.sentMessage,
        ticketMessage: finalized.ticketMessage,
        replayed: true,
      };
    }

    // ── 2. Mandatory freshness check ──
    let warning: string | undefined;
    let warningCode: string | undefined;

    if (input.lastSeenMessageAt) {
      const latestBuyerMsg = [...tx.messages]
        .filter((m) => m.role === "BUYER")
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];

      if (latestBuyerMsg && latestBuyerMsg.createdAt > input.lastSeenMessageAt) {
        await this.copyRepo.releasePlatformSentMessageClaim(input.ticket.id, input.clientOperationId, "mercari", input.message, input.replyIntent).catch(() => undefined);
        throw new SendError(
          "New messages arrived since you loaded this ticket. Refresh to see them before sending.",
          "THREAD_STALE",
          409,
        );
      }
    }

    // ── 3. FUGUAI guard ──
    const sendsFuguaiForm = containsAfterSalesFormLink(input.message);
    if (sendsFuguaiForm && fuguaiAlreadySent(tx.messages)) {
      warning = "FUGUAI form has already been sent in this thread.";
      warningCode = "FUGUAI_ALREADY_SENT";
    }

    try {
      await this.copyRepo.recordPlatformSentMessagePreflight(
        input.ticket.id,
        input.clientOperationId,
        "mercari",
        tx.messages.map((message) => message.id),
      );
    } catch (cause) {
      await this.copyRepo.releasePlatformSentMessageClaim(input.ticket.id, input.clientOperationId, "mercari", input.message, input.replyIntent).catch(() => undefined);
      throw cause;
    }

    // ── 4. Send via Mercari GraphQL ──
    let reply: { id: string; createdAt: string };
    try {
      reply = await sendPlatformReply(input.mercariToken, input.transactionId, input.message);
    } catch (e) {
      await this.copyRepo.markPlatformSentMessageAmbiguous(
        input.ticket.id,
        input.clientOperationId,
        "mercari",
        String(e),
      ).catch(() => undefined);
      throw new SendError(
        `Failed to send reply via Mercari: ${String(e).slice(0, 300)}`,
        "MERCARI_SEND_FAILED",
        500,
      );
    }

    // ── 5. Atomically persist audit + ticket message + Needs Reply state ──
    const finalized = await this.copyRepo.finalizeSentMessage({
      ticket_id: input.ticket.id,
      platform: "mercari",
      client_operation_id: input.clientOperationId,
      body: input.message,
      reply_intent: input.replyIntent,
      platform_message_id: reply.id,
      platform_sent_at: reply.createdAt,
      sent_by: input.sentBy ?? null,
    });

    return {
      platformMessageId: reply.id,
      sentAt: reply.createdAt,
      sentMessage: finalized.sentMessage,
      ticketMessage: finalized.ticketMessage,
      replayed: finalized.replayed,
      warning,
      warningCode,
    };
  }
}
