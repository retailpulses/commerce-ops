import type { SupabaseClient } from "@supabase/supabase-js";
import type { CopywritingRepository, TicketDetail } from "../repositories/ticketRepository";
import { SendError } from "./messageSendService";
import { ZohoMailClient } from "../clients/zoho-mail";

interface AmazonInboundSource {
  id: string;
  external_order_id: string;
  provider_folder_id: string;
  provider_message_id: string;
  provider_account_id: string;
  provider_thread_id: string | null;
  source_received_at: string;
  message_subject: string;
  mail_auth_status: string;
}

export interface AmazonMailSendInput {
  ticket: TicketDetail;
  message: string;
  clientOperationId: string;
  replyIntent: "terminal" | "holding";
  reviewedCustomerMessageId: string;
  lastSeenMessageAt: string;
  reviewedCustomerRevision: string;
  reviewedThreadRevision: string;
  sentBy?: string | null;
}

function nativeId(externalId: string): string {
  const parts = externalId.split(":");
  return parts.length >= 3 && parts[0] === "zoho" ? parts.slice(2).join(":") : "";
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export class AmazonMailSendService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly copyRepo: CopywritingRepository,
    private readonly client: ZohoMailClient,
    private readonly sentFolderId: string,
    private readonly providerAccountId?: string,
  ) {}

  async send(input: AmazonMailSendInput) {
    const source = await this.reviewedAuthorizedSource(
      input.ticket.id, input.reviewedCustomerMessageId, input.lastSeenMessageAt,
    );

    let claim;
    try {
      claim = await this.copyRepo.claimAmazonMailSentMessage({
        ticket_id: input.ticket.id,
        client_operation_id: input.clientOperationId,
        body: input.message,
        reply_intent: input.replyIntent,
        sent_by: input.sentBy ?? null,
        source_inbound_message_id: source.id,
        reviewed_customer_message_id: input.reviewedCustomerMessageId,
        reviewed_customer_message_at: input.lastSeenMessageAt,
        reviewed_customer_revision: input.reviewedCustomerRevision,
        reviewed_thread_revision: input.reviewedThreadRevision,
      });
    } catch (cause) {
      if (String(cause).includes("CLIENT_OPERATION_CONFLICT")) {
        throw new SendError("This operation ID was already used for different content.", "CLIENT_OPERATION_CONFLICT", 409);
      }
      if (String(cause).includes("client_operation_conflict")) {
        throw new SendError("This operation ID was already used for different reviewed evidence.", "CLIENT_OPERATION_CONFLICT", 409);
      }
      if (String(cause).includes("amazon_thread_revision_stale")) {
        throw new SendError("The ticket thread changed after it was reviewed.", "THREAD_STALE", 409);
      }
      if (String(cause).includes("amazon_send_in_progress")) {
        throw new SendError("Another Amazon reply is still being reconciled.", "SEND_IN_PROGRESS", 409);
      }
      throw cause;
    }

    if (claim.sentMessage.delivery_status === "sent") {
      if (!claim.ticketMessage || !claim.sentMessage.platform_message_id) {
        throw new SendError("Completed Amazon reply is missing persisted evidence.", "SEND_RESULT_INCOMPLETE", 500);
      }
      const finalized = await this.copyRepo.finalizeAmazonMailSend({
        ticket_id: input.ticket.id,
        client_operation_id: input.clientOperationId,
        platform_message_id: claim.sentMessage.platform_message_id,
        platform_sent_at: claim.sentMessage.sent_at,
        sent_by: input.sentBy ?? null,
      });
      return {
        platformMessageId: claim.sentMessage.platform_message_id,
        sentAt: finalized.sentMessage.sent_at,
        ticketMessage: finalized.ticketMessage,
        replayed: true,
        newerCustomerMessage: finalized.newerCustomerMessage,
      };
    }

    if (claim.sentMessage.delivery_status === "confirmed_not_sent") {
      throw new SendError(
        "This operation was confirmed not sent. Review the latest thread and start a new send action.",
        "SEND_CONFIRMED_NOT_SENT",
        409,
      );
    }

    if (!claim.claimed) {
      if (claim.sentMessage.delivery_status === "sending") {
        throw new SendError("The original Amazon send worker is still active.", "SEND_IN_PROGRESS", 409);
      }
      return this.reconcileAmbiguous(
        input,
        source,
        claim.sentMessage.provider_mutation_started_at || claim.sentMessage.created_at,
        claim.sentMessage.platform_message_ids_before_send || [],
        claim.sentMessage.delivery_error,
      );
    }
    let before: Awaited<ReturnType<AmazonMailSendService["sentMessages"]>>;
    let details: Awaited<ReturnType<ZohoMailClient["getMessageDetails"]>>;
    try {
      const latest = await this.latestAuthorizedSource(input.ticket.id);
      if (latest.id !== source.id) {
        throw new SendError("New customer messages arrived after this ticket was reviewed.", "THREAD_STALE", 409);
      }
      const current = await this.latestProviderMessage(source.external_order_id);
      if (!current || current.messageId !== source.provider_message_id ||
          Date.parse(new Date(Number(current.receivedTime)).toISOString()) !== Date.parse(source.source_received_at)) {
        throw new SendError("The Zoho thread changed after this ticket was reviewed.", "THREAD_STALE", 409);
      }
      before = await this.sentMessages(source.external_order_id);
      await this.copyRepo.recordAmazonMailSentMessagePreflight(
        input.ticket.id, input.clientOperationId, before.map((message) => message.messageId),
        claim.sentMessage.lease_generation,
      );
      details = await this.client.getMessageDetails(source.provider_folder_id, source.provider_message_id);
      if (!/@marketplace\.amazon\.co\.jp$/i.test(details.fromAddress)) {
        throw new SendError("Resolved reply target is not an Amazon anonymized address.", "TARGET_NOT_ALLOWED", 409);
      }
      claim.sentMessage.provider_mutation_started_at = await this.copyRepo.markSentMessageProviderMutationStarted(
        input.ticket.id, input.clientOperationId, claim.sentMessage.lease_generation,
      );
    } catch (cause) {
      await this.copyRepo.releaseAmazonMailSentMessageClaim(
        input.ticket.id, input.clientOperationId, claim.sentMessage.lease_generation,
      ).catch(() => undefined);
      if (String(cause).includes("amazon_thread_revision_stale")) {
        throw new SendError("The ticket thread changed after it was reviewed.", "THREAD_STALE", 409);
      }
      if (String(cause).includes("amazon_send_lease_fenced")) {
        throw new SendError("This send worker no longer owns the active lease.", "SEND_IN_PROGRESS", 409);
      }
      throw cause;
    }

    let providerReply: { messageId: string; sentTime: string };
    try {
      providerReply = await this.client.reply({
        messageId: source.provider_message_id,
        toAddress: details.fromAddress,
        subject: /^re:/i.test(source.message_subject) ? source.message_subject : `Re: ${source.message_subject}`,
        content: input.message,
      });
    } catch {
      await this.copyRepo.markAmazonMailSentMessageAmbiguous(
        input.ticket.id, input.clientOperationId, "zoho_reply_result_unknown", claim.sentMessage.lease_generation,
      ).catch(() => undefined);
      throw new SendError("Amazon reply result is ambiguous; reconcile before retrying.", "DELIVERY_UNCONFIRMED", 409);
    }

    try {
      const after = await this.sentMessages(source.external_order_id);
      const confirmed = await this.matchSentReply(
        after, before.map((message) => message.messageId), input.message,
        providerReply.messageId, Date.parse(claim.sentMessage.provider_mutation_started_at || claim.sentMessage.created_at),
        source, details.fromAddress,
      );
      if (!confirmed) throw new Error("sent_readback_missing");
      const finalized = await this.copyRepo.finalizeAmazonMailSend({
        ticket_id: input.ticket.id,
        client_operation_id: input.clientOperationId,
        platform_message_id: `zoho:${source.provider_account_id}:${confirmed.messageId}`,
        platform_sent_at: new Date(Number(confirmed.sentDateInGMT || confirmed.receivedTime)).toISOString(),
        sent_by: input.sentBy ?? null,
      });
      return {
        platformMessageId: `zoho:${source.provider_account_id}:${confirmed.messageId}`,
        sentAt: finalized.sentMessage.sent_at,
        ticketMessage: finalized.ticketMessage,
        replayed: finalized.replayed,
        newerCustomerMessage: finalized.newerCustomerMessage,
      };
    } catch {
      await this.copyRepo.markAmazonMailSentMessageAmbiguous(
        input.ticket.id, input.clientOperationId, `zoho_reply_candidate:${providerReply.messageId}`,
        claim.sentMessage.lease_generation,
      ).catch(() => undefined);
      throw new SendError("Reply was submitted but authoritative readback is pending.", "DELIVERY_UNCONFIRMED", 409);
    }
  }

  async inspectActiveLease(ticketId: string, clientOperationId: string) {
    const promotion = await this.supabase.rpc("promote_abandoned_amazon_send", {
      p_ticket_id: ticketId,
      p_client_operation_id: clientOperationId,
    });
    if (promotion.error) {
      throw new SendError("The Amazon send lease could not be inspected.", "SEND_LEASE_INSPECTION_FAILED", 500);
    }
    const select = "client_operation_id,body,delivery_status,created_at,provider_mutation_started_at,no_send_first_observed_at,no_send_last_observed_at,no_send_observation_count,source_inbound_message_id,platform_message_ids_before_send";
    let { data: sent, error } = await this.supabase.from("sent_messages")
      .select(select)
      .eq("ticket_id", ticketId)
      .eq("client_operation_id", clientOperationId)
      .eq("platform", "amazon")
      .in("delivery_status", ["sending", "ambiguous"])
      .maybeSingle();
    if (!sent && !error) {
      const fallback = await this.supabase.from("sent_messages")
        .select(select)
        .eq("ticket_id", ticketId)
        .eq("platform", "amazon")
        .in("delivery_status", ["sending", "ambiguous"])
        .maybeSingle();
      sent = fallback.data;
      error = fallback.error;
    }
    if (error || !sent?.source_inbound_message_id) {
      throw new SendError("No active Amazon send lease was found.", "SEND_LEASE_NOT_FOUND", 404);
    }
    const source = await this.authorizedSourceById(ticketId, String(sent.source_inbound_message_id));
    this.assertProviderAccount(source);
    const sourceDetails = await this.client.getMessageDetails(source.provider_folder_id, source.provider_message_id);
    const messages = await this.sentMessages(source.external_order_id);
    const candidates = await this.matchingSentReplies(
      messages,
      Array.isArray(sent.platform_message_ids_before_send) ? sent.platform_message_ids_before_send.map(String) : [],
      String(sent.body),
      Date.parse(String(sent.provider_mutation_started_at || sent.created_at)),
      source,
      sourceDetails.fromAddress,
    );
    return {
      clientOperationId: String(sent.client_operation_id),
      deliveryStatus: String(sent.delivery_status),
      providerMutationStartedAt: sent.provider_mutation_started_at ? String(sent.provider_mutation_started_at) : null,
      noSendFirstObservedAt: sent.no_send_first_observed_at ? String(sent.no_send_first_observed_at) : null,
      noSendLastObservedAt: sent.no_send_last_observed_at ? String(sent.no_send_last_observed_at) : null,
      noSendObservationCount: Number(sent.no_send_observation_count || 0),
      candidates: candidates.map((message) => ({
        platformMessageId: `zoho:${source.provider_account_id}:${message.messageId}`,
        sentAt: new Date(Number(message.sentDateInGMT || message.receivedTime)).toISOString(),
      })),
    };
  }

  async resolveActiveLease(input: {
    ticketId: string;
    clientOperationId: string;
    resolution: "confirmed_sent" | "confirmed_not_sent";
    platformMessageId?: string;
    sentBy: string;
  }) {
    const inspection = await this.inspectActiveLease(input.ticketId, input.clientOperationId);
    if (inspection.deliveryStatus !== "ambiguous") {
      throw new SendError("The original Amazon send worker is still active.", "SEND_IN_PROGRESS", 409);
    }
    const activeOperationId = inspection.clientOperationId;
    if (input.resolution === "confirmed_not_sent") {
      if (inspection.candidates.length !== 0) {
        throw new SendError("Matching Sent messages exist; select the exact sent message instead.", "SEND_CANDIDATE_EXISTS", 409);
      }
      const { data, error } = await this.supabase.rpc("resolve_amazon_mail_send_as_not_sent", {
        p_ticket_id: input.ticketId,
        p_client_operation_id: activeOperationId,
        p_actor_id: input.sentBy,
      });
      if (error) throw new SendError("The active send lease could not be released.", "SEND_LEASE_RESOLUTION_FAILED", 409);
      const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
      if (result.resolution === "settlement_pending") {
        return {
          resolution: "settlement_pending" as const,
          eligibleAfter: typeof result.eligible_after === "string" ? result.eligible_after : null,
          nextObservationAfter: typeof result.next_observation_after === "string" ? result.next_observation_after : null,
          candidates: [],
        };
      }
      return { resolution: "confirmed_not_sent" as const, candidates: [] };
    }
    const selected = inspection.candidates.find((item) => item.platformMessageId === input.platformMessageId);
    if (!selected) {
      throw new SendError("The selected Sent message is not an authoritative match.", "SEND_CANDIDATE_INVALID", 409);
    }
    const finalized = await this.copyRepo.finalizeAmazonMailSend({
      ticket_id: input.ticketId,
      client_operation_id: activeOperationId,
      platform_message_id: selected.platformMessageId,
      platform_sent_at: selected.sentAt,
      sent_by: input.sentBy,
    });
    return { resolution: "confirmed_sent" as const, finalized, candidates: inspection.candidates };
  }

  private async latestAuthorizedSource(ticketId: string): Promise<AmazonInboundSource> {
    const { data, error } = await this.supabase.from("inbound_ticket_messages")
      .select("id,external_order_id,provider_folder_id,provider_message_id,provider_account_id,provider_thread_id,source_received_at,message_subject,mail_auth_status")
      .eq("source", "amazon_zoho_mail")
      .eq("linked_ticket_id", ticketId)
      .eq("mail_auth_status", "pass")
      .order("source_received_at", { ascending: false })
      .order("provider_message_id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) throw new SendError("No authenticated Amazon source message is linked to this ticket.", "NO_SOURCE_MESSAGE", 409);
    const source = data as AmazonInboundSource;
    this.assertProviderAccount(source);
    return source;
  }

  private async authorizedSourceById(ticketId: string, sourceId: string): Promise<AmazonInboundSource> {
    const { data, error } = await this.supabase.from("inbound_ticket_messages")
      .select("id,external_order_id,provider_folder_id,provider_message_id,provider_account_id,provider_thread_id,source_received_at,message_subject,mail_auth_status")
      .eq("id", sourceId)
      .eq("source", "amazon_zoho_mail")
      .eq("linked_ticket_id", ticketId)
      .eq("mail_auth_status", "pass")
      .maybeSingle();
    if (error || !data?.external_order_id) {
      throw new SendError("The Amazon source for this lease is unavailable.", "NO_SOURCE_MESSAGE", 409);
    }
    const source = data as AmazonInboundSource;
    this.assertProviderAccount(source);
    return source;
  }

  private async reviewedAuthorizedSource(
    ticketId: string,
    reviewedCustomerMessageId: string,
    reviewedCustomerMessageAt: string,
  ): Promise<AmazonInboundSource> {
    const providerMessageId = nativeId(reviewedCustomerMessageId);
    const providerAccountId = reviewedCustomerMessageId.split(":")[1] || "";
    if (!providerMessageId || !providerAccountId || !Number.isFinite(Date.parse(reviewedCustomerMessageAt))) {
      throw new SendError("The reviewed Amazon customer message token is invalid.", "THREAD_STALE", 409);
    }
    const { data, error } = await this.supabase.from("inbound_ticket_messages")
      .select("id,external_order_id,provider_folder_id,provider_message_id,provider_account_id,provider_thread_id,source_received_at,message_subject,mail_auth_status")
      .eq("source", "amazon_zoho_mail")
      .eq("linked_ticket_id", ticketId)
      .eq("mail_auth_status", "pass")
      .eq("provider_account_id", providerAccountId)
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    if (error || !data || Date.parse(String(data.source_received_at)) !== Date.parse(reviewedCustomerMessageAt)) {
      throw new SendError("The reviewed Amazon customer message is no longer valid.", "THREAD_STALE", 409);
    }
    const source = data as AmazonInboundSource;
    this.assertProviderAccount(source);
    return source;
  }

  private async latestProviderMessage(orderNumber: string) {
    const messages = await this.client.searchMessages({
      searchKey: `sender:@marketplace.amazon.co.jp::entire:${orderNumber}`,
      start: 1, limit: 100,
    });
    return messages
      .filter((message) => /@marketplace\.amazon\.co\.jp$/i.test(message.fromAddress))
      .sort((a, b) => Number(b.receivedTime) - Number(a.receivedTime) || b.messageId.localeCompare(a.messageId))[0] || null;
  }

  private sentMessages(orderNumber: string) {
    return this.client.searchMessages({ searchKey: `entire:${orderNumber}::in:Sent`, start: 1, limit: 100 });
  }

  private async matchSentReply(
    messages: Awaited<ReturnType<ZohoMailClient["searchMessages"]>>,
    beforeIds: string[],
    body: string,
    providerReplyId: string | null,
    claimTime: number,
    source: AmazonInboundSource,
    replyTarget: string,
  ) {
    const bodyMatches = await this.matchingSentReplies(messages, beforeIds, body, claimTime, source, replyTarget);
    if (providerReplyId) return bodyMatches.find((message) => message.messageId === providerReplyId) || null;
    return bodyMatches.length === 1 ? bodyMatches[0] : null;
  }

  private async matchingSentReplies(
    messages: Awaited<ReturnType<ZohoMailClient["searchMessages"]>>,
    beforeIds: string[],
    body: string,
    claimTime: number,
    source: AmazonInboundSource,
    replyTarget: string,
  ) {
    const bodyMatches: Awaited<ReturnType<ZohoMailClient["searchMessages"]>> = [];
    for (const message of messages
      .filter((item) => !beforeIds.includes(item.messageId))
      .sort((a, b) => Number(b.sentDateInGMT || b.receivedTime) - Number(a.sentDateInGMT || a.receivedTime))) {
      const sentAt = Number(message.sentDateInGMT || message.receivedTime);
      if (Number.isFinite(claimTime) && sentAt < claimTime - 120_000) continue;
      if (source.provider_thread_id && message.threadId !== source.provider_thread_id) continue;
      if ((message.toAddress || "").trim().toLowerCase() !== replyTarget.trim().toLowerCase()) continue;
      const content = await this.client.getMessageContent(message.folderId || this.sentFolderId, message.messageId);
      if (normalizeBody(content.replace(/<[^>]+>/g, " ")) === normalizeBody(body)) bodyMatches.push(message);
    }
    return bodyMatches;
  }

  private async reconcileAmbiguous(
    input: AmazonMailSendInput,
    source: AmazonInboundSource,
    createdAt: string,
    beforeIds: string[],
    deliveryError: string | null,
  ) {
    const sent = await this.sentMessages(source.external_order_id);
    const sourceDetails = await this.client.getMessageDetails(source.provider_folder_id, source.provider_message_id);
    const candidateId = deliveryError?.match(/^zoho_reply_candidate:(.+)$/)?.[1] || null;
    const confirmed = await this.matchSentReply(
      sent, beforeIds, input.message, candidateId, Date.parse(createdAt), source, sourceDetails.fromAddress,
    );
    if (!confirmed) {
      throw new SendError("Previous Amazon reply remains unconfirmed; no second send was attempted.", "DELIVERY_UNCONFIRMED", 409);
    }
    const finalized = await this.copyRepo.finalizeAmazonMailSend({
      ticket_id: input.ticket.id,
      client_operation_id: input.clientOperationId,
      platform_message_id: `zoho:${source.provider_account_id}:${confirmed.messageId}`,
      platform_sent_at: new Date(Number(confirmed.sentDateInGMT || confirmed.receivedTime)).toISOString(),
      sent_by: input.sentBy ?? null,
    });
    return {
      platformMessageId: `zoho:${source.provider_account_id}:${confirmed.messageId}`,
      sentAt: finalized.sentMessage.sent_at,
      ticketMessage: finalized.ticketMessage,
      replayed: true,
      newerCustomerMessage: finalized.newerCustomerMessage,
    };
  }

  private assertProviderAccount(source: AmazonInboundSource): void {
    if (this.providerAccountId && source.provider_account_id !== this.providerAccountId) {
      throw new SendError("The Amazon source belongs to a different provider account.", "NO_SOURCE_MESSAGE", 409);
    }
    if (!source.provider_thread_id) {
      throw new SendError("The Amazon source has no authoritative provider thread.", "NO_SOURCE_MESSAGE", 409);
    }
  }
}
