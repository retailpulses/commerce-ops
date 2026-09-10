/** Supabase implementation of CopywritingRepository.
 *  Handles drafts, sent-message audit, and copywriting logs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CopywritingRepository,
  MessageDraft,
  SentMessage,
  TicketMessage,
  CopywritingLog,
} from "./ticketRepository";

export class SupabaseCopywritingRepository implements CopywritingRepository {
  constructor(private supabase: SupabaseClient) {}

  async getDraft(ticketId: string): Promise<MessageDraft | null> {
    const { data, error } = await this.supabase
      .from("message_drafts")
      .select("*")
      .eq("ticket_id", ticketId)
      .maybeSingle();

    if (error || !data) return null;
    return this.mapDraft(data as Record<string, unknown>);
  }

  async saveDraft(input: {
    ticket_id: string;
    body: string;
    resolution_guide?: string;
    created_by?: string | null;
  }): Promise<MessageDraft> {
    const row = {
      ticket_id: input.ticket_id,
      body: input.body,
      resolution_guide: input.resolution_guide ?? "",
      created_by: input.created_by ?? null,
    };

    const { data, error } = await this.supabase
      .from("message_drafts")
      .upsert(row, { onConflict: "ticket_id" })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to save draft: ${error.message}`);
    }

    return this.mapDraft(data as Record<string, unknown>);
  }

  async claimPlatformSentMessage(input: {
    ticket_id: string;
    platform: "mercari" | "rakuten";
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    sent_by?: string | null;
  }): Promise<{ sentMessage: SentMessage; ticketMessage: TicketMessage | null; claimed: boolean }> {
    const { data, error } = await this.supabase
      .from("sent_messages")
      .insert({
        ticket_id: input.ticket_id,
        platform: input.platform,
        client_operation_id: input.client_operation_id,
        platform_message_id: null,
        body: input.body,
        reply_intent: input.reply_intent,
        sent_by: input.sent_by ?? null,
        delivery_status: "sending",
      })
      .select()
      .single();

    if (!error && data) {
      return { sentMessage: this.mapSentMessage(data as Record<string, unknown>), ticketMessage: null, claimed: true };
    }

    if (error?.code !== "23505") {
      throw new Error(`Failed to claim sent message: ${error?.message || "no row returned"}`);
    }

    const { data: existing, error: lookupError } = await this.supabase
      .from("sent_messages")
      .select("*")
      .eq("ticket_id", input.ticket_id)
      .eq("platform", input.platform)
      .eq("client_operation_id", input.client_operation_id)
      .single();
    if (lookupError || !existing) {
      throw new Error(`Failed to load sent message claim: ${lookupError?.message || "not found"}`);
    }
    if (
      existing.platform !== input.platform ||
      existing.body !== input.body ||
      existing.reply_intent !== input.reply_intent
    ) {
      throw new Error("CLIENT_OPERATION_CONFLICT: operation ID was already used for a different reply");
    }

    let ticketMessage: TicketMessage | null = null;
    if (existing.delivery_status === "sent") {
      const { data: persisted, error: messageError } = await this.supabase
        .from("ticket_messages")
        .select("*")
        .eq("ticket_id", input.ticket_id)
        .eq("client_operation_id", input.client_operation_id)
        .single();
      if (messageError || !persisted) {
        throw new Error(`Completed sent message is missing its ticket message: ${messageError?.message || "not found"}`);
      }
      ticketMessage = this.mapTicketMessage(persisted as Record<string, unknown>);
    }
    return {
      sentMessage: this.mapSentMessage(existing as Record<string, unknown>),
      ticketMessage,
      claimed: false,
    };
  }

  async finalizeSentMessage(input: {
    ticket_id: string;
    platform: "mercari" | "rakuten";
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    platform_message_id: string;
    platform_sent_at: string;
    sent_by?: string | null;
  }): Promise<{ sentMessage: SentMessage; ticketMessage: TicketMessage; replayed: boolean }> {
    const rpcName = input.platform === "mercari"
      ? "finalize_mercari_operator_message_send"
      : "finalize_rakuten_operator_message_send";
    const { data, error } = await this.supabase.rpc(rpcName, {
      p_ticket_id: input.ticket_id,
      p_client_operation_id: input.client_operation_id,
      p_expected_body: input.body,
      p_expected_reply_intent: input.reply_intent,
      p_platform_message_id: input.platform_message_id,
      p_platform_sent_at: input.platform_sent_at,
      p_sent_by: input.sent_by ?? null,
    });
    if (error) throw new Error(`Failed to finalize sent message: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.sent_message || !row?.ticket_message) {
      throw new Error("Failed to finalize sent message: malformed RPC response");
    }
    return {
      sentMessage: this.mapSentMessage(row.sent_message as Record<string, unknown>),
      ticketMessage: this.mapTicketMessage(row.ticket_message as Record<string, unknown>),
      replayed: row.replayed === true,
    };
  }

  async claimAmazonMailSentMessage(input: {
    ticket_id: string;
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    sent_by?: string | null;
    source_inbound_message_id: string;
    reviewed_customer_message_id: string;
    reviewed_customer_message_at: string;
    reviewed_customer_revision: string;
    reviewed_thread_revision: string;
  }): Promise<{ sentMessage: SentMessage; ticketMessage: TicketMessage | null; claimed: boolean }> {
    const { data, error } = await this.supabase.rpc("claim_amazon_mail_send", {
      p_ticket_id: input.ticket_id,
      p_client_operation_id: input.client_operation_id,
      p_body: input.body,
      p_reply_intent: input.reply_intent,
      p_sent_by: input.sent_by ?? null,
      p_source_inbound_message_id: input.source_inbound_message_id,
      p_reviewed_customer_message_id: input.reviewed_customer_message_id,
      p_reviewed_customer_message_at: input.reviewed_customer_message_at,
      p_reviewed_customer_revision: input.reviewed_customer_revision,
      p_reviewed_thread_revision: input.reviewed_thread_revision,
    });
    if (error) throw new Error(`Failed to claim Amazon mail send: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.sent_message) throw new Error("Failed to claim Amazon mail send: malformed RPC response");
    return {
      sentMessage: this.mapSentMessage(row.sent_message as Record<string, unknown>),
      ticketMessage: row.ticket_message
        ? this.mapTicketMessage(row.ticket_message as Record<string, unknown>)
        : null,
      claimed: row.claimed === true,
    };
  }

  async finalizeAmazonMailSend(input: {
    ticket_id: string;
    client_operation_id: string;
    platform_message_id: string;
    platform_sent_at: string;
    sent_by?: string | null;
  }): Promise<{
    sentMessage: SentMessage;
    ticketMessage: TicketMessage;
    replayed: boolean;
    newerCustomerMessage: boolean;
  }> {
    const { data, error } = await this.supabase.rpc("finalize_amazon_mail_send", {
      p_ticket_id: input.ticket_id,
      p_client_operation_id: input.client_operation_id,
      p_platform_message_id: input.platform_message_id,
      p_platform_sent_at: input.platform_sent_at,
      p_sent_by: input.sent_by ?? null,
    });
    if (error) throw new Error(`Failed to finalize Amazon mail send: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.sent_message || !row?.ticket_message) {
      throw new Error("Failed to finalize Amazon mail send: malformed RPC response");
    }
    return {
      sentMessage: this.mapSentMessage(row.sent_message as Record<string, unknown>),
      ticketMessage: this.mapTicketMessage(row.ticket_message as Record<string, unknown>),
      replayed: row.replayed === true,
      newerCustomerMessage: row.newer_customer_message === true,
    };
  }

  async releasePlatformSentMessageClaim(
    ticketId: string,
    clientOperationId: string,
    platform: "mercari" | "rakuten",
    body: string,
    replyIntent: "terminal" | "holding",
  ): Promise<void> {
    const rpcName = platform === "mercari"
      ? "release_mercari_operator_message_claim_v1"
      : "release_rakuten_operator_message_claim_v1";
    const { data, error } = await this.supabase.rpc(rpcName, {
      p_ticket_id: ticketId,
      p_client_operation_id: clientOperationId,
      p_expected_body: body,
      p_expected_reply_intent: replyIntent,
    });
    if (error || data !== true) {
      throw new Error(`Failed to release sent message claim: ${error?.message || "claim_not_releasable"}`);
    }
  }

  async recordPlatformSentMessagePreflight(ticketId: string, clientOperationId: string, platform: "mercari" | "rakuten", platformMessageIds: string[]): Promise<void> {
    const { data, error } = await this.supabase
      .from("sent_messages")
      .update({ platform_message_ids_before_send: platformMessageIds })
      .eq("ticket_id", ticketId)
      .eq("platform", platform)
      .eq("client_operation_id", clientOperationId)
      .eq("delivery_status", "sending")
      .select("id")
      .maybeSingle();
    if (error || !data) throw new Error(`Failed to persist outbound preflight: ${error?.message || "claim_not_active"}`);
  }

  async markPlatformSentMessageAmbiguous(ticketId: string, clientOperationId: string, platform: "mercari" | "rakuten", message: string): Promise<void> {
    const { error } = await this.supabase
      .from("sent_messages")
      .update({ delivery_status: "ambiguous", delivery_error: message.slice(0, 500) })
      .eq("ticket_id", ticketId)
      .eq("platform", platform)
      .eq("client_operation_id", clientOperationId)
      .eq("delivery_status", "sending");
    if (error) throw new Error(`Failed to mark sent message ambiguous: ${error.message}`);
  }

  async releaseAmazonMailSentMessageClaim(ticketId: string, clientOperationId: string, leaseGeneration: number): Promise<void> {
    const { error } = await this.supabase
      .from("sent_messages")
      .delete()
      .eq("ticket_id", ticketId)
      .eq("platform", "amazon")
      .eq("client_operation_id", clientOperationId)
      .eq("delivery_status", "sending")
      .is("provider_mutation_started_at", null)
      .is("platform_message_id", null)
      .eq("lease_generation", leaseGeneration);
    if (error) throw new Error(`Failed to release Amazon sent message claim: ${error.message}`);
  }

  async recordAmazonMailSentMessagePreflight(ticketId: string, clientOperationId: string, platformMessageIds: string[], leaseGeneration: number): Promise<void> {
    const { data, error } = await this.supabase
      .from("sent_messages")
      .update({ platform_message_ids_before_send: platformMessageIds })
      .eq("ticket_id", ticketId)
      .eq("platform", "amazon")
      .eq("client_operation_id", clientOperationId)
      .eq("delivery_status", "sending")
      .is("provider_mutation_started_at", null)
      .eq("lease_generation", leaseGeneration)
      .select("id")
      .maybeSingle();
    if (error || !data) throw new Error(`Failed to persist Amazon outbound preflight: ${error?.message || "claim_not_active"}`);
  }

  async markAmazonMailSentMessageAmbiguous(ticketId: string, clientOperationId: string, message: string, leaseGeneration: number): Promise<void> {
    const { error } = await this.supabase
      .from("sent_messages")
      .update({ delivery_status: "ambiguous", delivery_error: message.slice(0, 500) })
      .eq("ticket_id", ticketId)
      .eq("platform", "amazon")
      .eq("client_operation_id", clientOperationId)
      .eq("delivery_status", "sending")
      .eq("lease_generation", leaseGeneration);
    if (error) throw new Error(`Failed to mark Amazon sent message ambiguous: ${error.message}`);
  }

  async markSentMessageProviderMutationStarted(ticketId: string, clientOperationId: string, leaseGeneration: number): Promise<string> {
    const { data, error } = await this.supabase.rpc("begin_amazon_mail_provider_mutation", {
      p_ticket_id: ticketId,
      p_client_operation_id: clientOperationId,
      p_lease_generation: leaseGeneration,
    });
    if (error || typeof data !== "string") {
      throw new Error(`Failed to begin provider mutation: ${error?.message || "claim_not_active"}`);
    }
    return data;
  }

  async logCopywriting(input: {
    ticket_id: string;
    ticket_number?: string | null;
    model: string;
    prompt_version?: string;
    resolution_guide?: string | null;
    generated_reply?: string | null;
    reply_char_count?: number | null;
    latency_ms?: number | null;
    status: "success" | "error";
    error_message?: string | null;
    customer_message?: string | null;
    ticket_description?: string | null;
    created_by?: string | null;
  }): Promise<CopywritingLog> {
    const { data, error } = await this.supabase
      .from("copywriting_logs")
      .insert({
        ticket_id: input.ticket_id,
        ticket_number: input.ticket_number ?? null,
        model: input.model,
        prompt_version: input.prompt_version ?? "default",
        resolution_guide: input.resolution_guide ?? null,
        generated_reply: input.generated_reply ?? null,
        reply_char_count: input.reply_char_count ?? null,
        latency_ms: input.latency_ms ?? null,
        status: input.status,
        error_message: input.error_message ?? null,
        customer_message: input.customer_message ?? null,
        ticket_description: input.ticket_description ?? null,
        created_by: input.created_by ?? null,
      })
      .select()
      .single();

    if (error) {
      // Log failures are non-fatal — don't throw, just return a minimal record
      console.error(`Copywriting log failed: ${error.message}`);
      return {
        id: "log-failed",
        ticket_id: input.ticket_id,
        ticket_number: input.ticket_number ?? null,
        model: input.model,
        prompt_version: input.prompt_version ?? "default",
        resolution_guide: input.resolution_guide ?? null,
        generated_reply: input.generated_reply ?? null,
        reply_char_count: input.reply_char_count ?? null,
        latency_ms: input.latency_ms ?? null,
        status: input.status,
        error_message: input.error_message ?? null,
        customer_message: input.customer_message ?? null,
        ticket_description: input.ticket_description ?? null,
        created_by: input.created_by ?? null,
        created_at: new Date().toISOString(),
      };
    }

    return this.mapCopywritingLog(data as Record<string, unknown>);
  }

  // ── Mappers ──

  private mapDraft(row: Record<string, unknown>): MessageDraft {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      body: (row.body as string) ?? "",
      resolution_guide: (row.resolution_guide as string) ?? "",
      created_by: row.created_by as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  private mapSentMessage(row: Record<string, unknown>): SentMessage {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      platform: row.platform as string,
      platform_message_id: row.platform_message_id as string | null,
      body: row.body as string,
      reply_intent: row.reply_intent as "terminal" | "holding",
      sent_by: row.sent_by as string | null,
      sent_at: row.sent_at as string,
      created_at: row.created_at as string,
      client_operation_id: row.client_operation_id as string | null,
      delivery_status: (row.delivery_status as SentMessage["delivery_status"]) ?? "sent",
      delivery_error: row.delivery_error as string | null,
      platform_message_ids_before_send: Array.isArray(row.platform_message_ids_before_send)
        ? row.platform_message_ids_before_send.map(String)
        : null,
      provider_mutation_started_at: row.provider_mutation_started_at as string | null,
      lease_generation: Number(row.lease_generation ?? 1),
    };
  }

  private mapTicketMessage(row: Record<string, unknown>): TicketMessage {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      platform: row.platform as string,
      external_message_id: row.external_message_id as string | null,
      sender_type: row.sender_type as string,
      sender_display_name: row.sender_display_name as string | null,
      body: row.body as string,
      sent_at: row.sent_at as string,
      raw_payload: (row.raw_payload as Record<string, unknown>) ?? {},
      created_at: row.created_at as string,
    };
  }

  private mapCopywritingLog(row: Record<string, unknown>): CopywritingLog {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string | null,
      ticket_number: row.ticket_number as string | null,
      model: row.model as string,
      prompt_version: (row.prompt_version as string) ?? "default",
      resolution_guide: row.resolution_guide as string | null,
      generated_reply: row.generated_reply as string | null,
      reply_char_count: row.reply_char_count as number | null,
      latency_ms: row.latency_ms as number | null,
      status: row.status as "success" | "error",
      error_message: row.error_message as string | null,
      customer_message: row.customer_message as string | null,
      ticket_description: row.ticket_description as string | null,
      created_by: row.created_by as string | null,
      created_at: row.created_at as string,
    };
  }
}
