import type { CopywritingRepository, SentMessage, TicketDetail, TicketMessage } from "../repositories/ticketRepository";
import type { RakutenRmesseInquiry } from "../clients/rakuten-rmesse";
import { createRakutenRmesseClient, nativeMessageId } from "../clients/rakuten-rmesse";
import { SendError } from "./messageSendService";

export interface RakutenSendOutput {
  platformMessageId: string;
  sentAt: string;
  sentMessage: SentMessage;
  ticketMessage: TicketMessage;
  replayed: boolean;
}

export function isTimestampAfter(candidate: string, reference: string): boolean {
  const candidateMs = Date.parse(candidate);
  const referenceMs = Date.parse(reference);
  // Freshness is a send-safety guard, so malformed timestamps fail closed.
  if (!Number.isFinite(candidateMs) || !Number.isFinite(referenceMs)) return true;
  return candidateMs > referenceMs;
}

function merchantReplyMatch(
  inquiry: RakutenRmesseInquiry,
  body: string,
  priorIds: string[],
  notBefore: number,
) {
  return [...(inquiry.replies || [])]
    .filter((reply) => reply.replyFrom === "merchant" && reply.message === body)
    .filter((reply) => !priorIds.includes(nativeMessageId(inquiry.inquiryNumber, reply)))
    .filter((reply) => !Number.isFinite(notBefore) || Date.parse(reply.regDate) >= notBefore - 120_000)
    .sort((a, b) => b.regDate.localeCompare(a.regDate))[0];
}

export class RakutenRmesseSendService {
  constructor(
    private copyRepo: CopywritingRepository,
    private config: { relayUrl: string; relaySecret: string },
  ) {}

  async send(input: {
    ticket: TicketDetail;
    message: string;
    clientOperationId: string;
    replyIntent: "terminal" | "holding";
    lastSeenMessageAt?: string;
    sentBy?: string | null;
  }): Promise<RakutenSendOutput> {
    if (!input.ticket.external_thread_id) throw new SendError("Rakuten inquiry number is missing.", "NO_INQUIRY_ID", 400);
    const client = createRakutenRmesseClient({ url: this.config.relayUrl, secret: this.config.relaySecret });
    const claim = await this.copyRepo.claimPlatformSentMessage({
      ticket_id: input.ticket.id,
      platform: "rakuten",
      client_operation_id: input.clientOperationId,
      body: input.message,
      reply_intent: input.replyIntent,
      sent_by: input.sentBy ?? null,
    });
    if (claim.sentMessage.delivery_status === "sent" && claim.ticketMessage && claim.sentMessage.platform_message_id) {
      return {
        platformMessageId: claim.sentMessage.platform_message_id,
        sentAt: claim.sentMessage.sent_at,
        sentMessage: claim.sentMessage,
        ticketMessage: claim.ticketMessage,
        replayed: true,
      };
    }

    const before = await client.get(input.ticket.external_thread_id);
    const messageIds = (before.replies || []).map((reply) => nativeMessageId(before.inquiryNumber, reply));
    if (!claim.claimed) {
      const matched = merchantReplyMatch(
        before, input.message, claim.sentMessage.platform_message_ids_before_send || [],
        Date.parse(claim.sentMessage.created_at),
      );
      if (!matched) throw new SendError("Previous Rakuten send is still unconfirmed.", "DELIVERY_UNCONFIRMED", 409);
      return this.finalize(input, nativeMessageId(before.inquiryNumber, matched), matched.regDate, true);
    }

    if (input.lastSeenMessageAt) {
      const latestCustomer = [...(before.replies || [])]
        .filter((reply) => reply.replyFrom === "user")
        .sort((a, b) => b.regDate.localeCompare(a.regDate))[0];
      if (latestCustomer && isTimestampAfter(latestCustomer.regDate, input.lastSeenMessageAt)) {
        await this.copyRepo.releasePlatformSentMessageClaim(input.ticket.id, input.clientOperationId, "rakuten", input.message, input.replyIntent);
        throw new SendError("New Rakuten messages arrived. Refresh before sending.", "THREAD_STALE", 409);
      }
    }
    await this.copyRepo.recordPlatformSentMessagePreflight(input.ticket.id, input.clientOperationId, "rakuten", messageIds);

    let platformResult;
    try {
      platformResult = await client.reply({
        inquiryNumber: before.inquiryNumber,
        shopId: String(before.shopId),
        message: input.message,
      });
    } catch {
      await this.copyRepo.markPlatformSentMessageAmbiguous(
        input.ticket.id,
        input.clientOperationId,
        "rakuten",
        "rakuten_relay_request_failed",
      ).catch(() => undefined);
      throw new SendError("Rakuten send result is ambiguous; reconcile before retry.", "RAKUTEN_SEND_AMBIGUOUS", 502);
    }

    const after = await client.get(before.inquiryNumber);
    const matched = merchantReplyMatch(after, input.message, messageIds, Date.parse(platformResult.regDate));
    if (!matched) {
      await this.copyRepo.markPlatformSentMessageAmbiguous(input.ticket.id, input.clientOperationId, "rakuten", "reply_not_visible_after_send");
      throw new SendError("Rakuten accepted the reply but its message ID is not visible yet.", "DELIVERY_UNCONFIRMED", 409);
    }
    return this.finalize(input, nativeMessageId(after.inquiryNumber, matched), matched.regDate, false);
  }

  private async finalize(
    input: { ticket: TicketDetail; message: string; replyIntent: "terminal" | "holding"; clientOperationId: string; sentBy?: string | null },
    platformMessageId: string,
    sentAt: string,
    replayed: boolean,
  ): Promise<RakutenSendOutput> {
    const result = await this.copyRepo.finalizeSentMessage({
      ticket_id: input.ticket.id,
      platform: "rakuten",
      client_operation_id: input.clientOperationId,
      body: input.message,
      reply_intent: input.replyIntent,
      platform_message_id: platformMessageId,
      platform_sent_at: sentAt,
      sent_by: input.sentBy ?? null,
    });
    return {
      platformMessageId, sentAt,
      sentMessage: result.sentMessage,
      ticketMessage: result.ticketMessage,
      replayed: replayed || result.replayed,
    };
  }
}
