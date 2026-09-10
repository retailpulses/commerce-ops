/** Inbound message queue repository — interface and Supabase implementation.
 *  Covers the inbound_ticket_messages table for webhook message triage.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMercariOrderUrl } from "../config/shops";

// ── Domain Types ──

export interface InboundMessage {
  id: string;
  source: string;
  shop_name: string | null;
  shop_id: string | null;
  order_transaction_id: string | null;
  account_id: string | null;
  external_order_id: string | null;
  message_subject: string | null;
  source_received_at: string | null;
  provider_account_id: string | null;
  provider_folder_id: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  mail_auth_status: string | null;
  mail_auth_domain: string | null;
  provider_metadata: Record<string, unknown>;
  attachment_processing_status: string;
  attachment_processing_attempts: number;
  attachment_error_code: string | null;
  external_thread_id: string | null;
  customer_display_name: string | null;
  product_summary: Record<string, unknown>;
  order_summary: Record<string, unknown>;
  latest_buyer_message: string | null;
  full_payload: Record<string, unknown>;
  linked_ticket_id: string | null;
  queue_status: string;
  review_status: string;
  classification: Record<string, unknown>;
  classifier_version: string | null;
  automation_decision: string;
  automation_reason: string | null;
  reply_status: string;
  reply_platform_message_id: string | null;
  reply_attempted_at: string | null;
  reply_sent_at: string | null;
  reply_error: string | null;
  submission_token_id: string | null;
  webhook_received_at: string | null;
  received_at: string;
  read_at: string | null;
  reviewed_at: string | null;
  idempotency_key: string;
  processing_status: string;
  processing_attempts: number;
  processing_error: string | null;
  processing_started_at: string | null;
  processed_at: string | null;
  next_retry_at: string | null;
  last_attempt_at: string | null;
  server_received_at: string;
  created_at: string;
  updated_at: string;
  /** Computed Mercari seller order URL */
  order_url: string | null;
}

export interface InboundMessageListRow extends InboundMessage {
  // Enriched fields from joins
  linked_ticket_number?: string | null;
  linked_ticket_status?: string | null;
  linked_ticket_subject?: string | null;
}

export interface CreateInboundMessageInput {
  source?: string;
  shop_name: string;
  shop_id: string;
  order_transaction_id: string;
  external_thread_id?: string | null;
  customer_display_name?: string | null;
  product_summary?: Record<string, unknown>;
  order_summary?: Record<string, unknown>;
  latest_buyer_message?: string | null;
  full_payload?: Record<string, unknown>;
  classification?: Record<string, unknown>;
  classifier_version?: string | null;
  webhook_received_at: string;
  idempotency_key: string;
}

export interface UpdateInboundMessageInput {
  queue_status?: string;
  review_status?: string;
  linked_ticket_id?: string | null;
  read_at?: string | null;
  reviewed_at?: string | null;
}

export interface QueueFilters {
  shop_name?: string;
  queue_status?: string;
  review_status?: string;
  classification?: string;
  linked_ticket_id?: string | null;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface UnreadCount {
  total: number;
  by_shop: Record<string, number>;
}

export interface ProcessingStats {
  pending: number;
  processing: number;
  failed: number;
  completed: number;
}

export interface ShopProcessingStats extends ProcessingStats {
  shop_name: string;
  newest_received: string | null;
  newest_processed: string | null;
}

// ── Repository Interface ──

export interface InboundMessageRepository {
  create(input: CreateInboundMessageInput): Promise<InboundMessage>;
  getById(id: string): Promise<InboundMessageListRow | null>;
  list(filters: QueueFilters): Promise<{ rows: InboundMessageListRow[]; total: number }>;
  update(id: string, input: UpdateInboundMessageInput): Promise<InboundMessage>;
  linkMercariToTicket(id: string, ticketId: string, actorId: string): Promise<InboundMessage>;
  getByTicketId(ticketId: string): Promise<InboundMessage[]>;
  getUnreadCount(shopName?: string): Promise<UnreadCount>;
  getByIdempotencyKey(key: string): Promise<InboundMessage | null>;
  /** Claim up to `limit` pending/failed rows for enrichment (row-level lock via status update) */
  claimPendingMercariForProcessing(limit?: number): Promise<InboundMessage[]>;
  /** Mark enrichment as successfully completed */
  markProcessingComplete(id: string): Promise<void>;
  /** Mark enrichment as failed with error and retry backoff */
  markProcessingFailed(id: string, error: string, retryable: boolean): Promise<void>;
  /** Get aggregate processing stats across all shops */
  getProcessingStats(): Promise<ProcessingStats>;
  /** Get per-shop processing stats with freshness timestamps */
  getShopProcessingStats(): Promise<ShopProcessingStats[]>;
}

// ── Supabase Implementation ──

export class SupabaseInboundMessageRepository implements InboundMessageRepository {
  constructor(private supabase: SupabaseClient) {}

  async create(input: CreateInboundMessageInput): Promise<InboundMessage> {
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .insert({
        source: input.source ?? "mercari_webhook",
        shop_name: input.shop_name,
        shop_id: input.shop_id,
        order_transaction_id: input.order_transaction_id,
        external_thread_id: input.external_thread_id ?? null,
        customer_display_name: input.customer_display_name ?? null,
        product_summary: input.product_summary ?? {},
        order_summary: input.order_summary ?? {},
        latest_buyer_message: input.latest_buyer_message ?? null,
        full_payload: input.full_payload ?? {},
        classification: input.classification ?? {},
        classifier_version: input.classifier_version ?? null,
        webhook_received_at: input.webhook_received_at,
        idempotency_key: input.idempotency_key,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        throw new Error(`DUPLICATE: ${input.idempotency_key}`);
      }
      throw new Error(`Failed to create inbound message: ${error.message}`);
    }

    return this.mapRow(data);
  }

  async getById(id: string): Promise<InboundMessageListRow | null> {
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .select("*, tickets!inbound_ticket_messages_linked_ticket_id_fkey(ticket_number, status, subject)")
      .eq("id", id)
      .single();

    if (error || !data) return null;
    return this.mapListRow(data);
  }

  async list(filters: QueueFilters): Promise<{ rows: InboundMessageListRow[]; total: number }> {
    let query = this.supabase
      .from("inbound_ticket_messages")
      .select("*, tickets!inbound_ticket_messages_linked_ticket_id_fkey(ticket_number, status, subject)", { count: "exact" });

    if (filters.shop_name) query = query.eq("shop_name", filters.shop_name);
    if (filters.queue_status) query = query.eq("queue_status", filters.queue_status);
    if (filters.review_status) query = query.eq("review_status", filters.review_status);
    if (filters.linked_ticket_id !== undefined) {
      query = filters.linked_ticket_id === null
        ? query.is("linked_ticket_id", null)
        : query.eq("linked_ticket_id", filters.linked_ticket_id);
    }
    if (filters.q) {
      query = query.or(
        `customer_display_name.ilike.%${filters.q}%,order_transaction_id.ilike.%${filters.q}%,latest_buyer_message.ilike.%${filters.q}%`
      );
    }

    // Sort
    const sort = filters.sort ?? "received_at.desc";
    const [col, dir] = sort.split(".");
    if (col && dir) {
      query = query.order(col, { ascending: dir === "asc" });
    }

    // Pagination
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) throw new Error(`Failed to list inbound messages: ${error.message}`);

    return {
      rows: (data ?? []).map((d: Record<string, unknown>) => this.mapListRow(d)),
      total: count ?? 0,
    };
  }

  async update(id: string, input: UpdateInboundMessageInput): Promise<InboundMessage> {
    const patch: Record<string, unknown> = {};
    if (input.queue_status !== undefined) patch.queue_status = input.queue_status;
    if (input.review_status !== undefined) patch.review_status = input.review_status;
    if (input.linked_ticket_id !== undefined) patch.linked_ticket_id = input.linked_ticket_id;
    if (input.read_at !== undefined) patch.read_at = input.read_at;
    if (input.reviewed_at !== undefined) patch.reviewed_at = input.reviewed_at;

    let query = this.supabase
      .from("inbound_ticket_messages")
      .update(patch)
      .eq("id", id)
      .eq("source", "mercari_webhook");
    if (input.queue_status === "read") query = query.eq("queue_status", "unread");
    if (input.queue_status === "unread") query = query.eq("queue_status", "read");
    if (input.queue_status && ["ignored", "linked", "converted"].includes(input.queue_status)) {
      query = query.in("queue_status", ["unread", "read"]);
    }
    if (input.review_status === "reviewed") query = query.eq("review_status", "needs_review");
    const { data, error } = await query.select().single();

    if (error) throw new Error(`Failed to update inbound message: ${error.message}`);
    return this.mapRow(data);
  }

  async linkMercariToTicket(id: string, ticketId: string, actorId: string): Promise<InboundMessage> {
    const { data, error } = await this.supabase.rpc("link_mercari_inbound_message_to_ticket", {
      p_inbound_message_id: id,
      p_ticket_id: ticketId,
      p_actor_id: actorId,
    });
    if (error) {
      const code = typeof error.message === "string" ? error.message : "mercari_queue_link_failed";
      throw new Error(code);
    }
    if (!data) throw new Error("mercari_queue_link_failed");
    return this.mapRow(data as Record<string, unknown>);
  }

  async getByTicketId(ticketId: string): Promise<InboundMessage[]> {
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .select("*")
      .eq("linked_ticket_id", ticketId)
      .order("received_at", { ascending: false });

    if (error) throw new Error(`Failed to get inbound messages by ticket: ${error.message}`);
    return (data ?? []).map((d: Record<string, unknown>) => this.mapRow(d));
  }

  async getUnreadCount(shopName?: string): Promise<UnreadCount> {
    let query = this.supabase
      .from("inbound_ticket_messages")
      .select("shop_name")
      .eq("queue_status", "unread");

    if (shopName) query = query.eq("shop_name", shopName);

    const { data, error } = await query;

    if (error) throw new Error(`Failed to get unread count: ${error.message}`);

    const by_shop: Record<string, number> = {};
    for (const row of data ?? []) {
      const sn = row.shop_name as string;
      by_shop[sn] = (by_shop[sn] ?? 0) + 1;
    }

    return {
      total: (data ?? []).length,
      by_shop,
    };
  }

  async getByIdempotencyKey(key: string): Promise<InboundMessage | null> {
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .select("*")
      .eq("idempotency_key", key)
      .maybeSingle();

    if (error) return null;
    return data ? this.mapRow(data) : null;
  }

  // ── Processing Status Operations (Issue #126) ──

  async claimPendingMercariForProcessing(limit = 10): Promise<InboundMessage[]> {
    const { data: claimed, error } = await this.supabase
      .rpc("claim_pending_mercari_webhook_messages", { claim_limit: limit });
    if (error) {
      throw new Error(`mercari_retry_claim_unavailable: ${error.message}`);
    }
    const rows = (claimed ?? []).map((d: Record<string, unknown>) => this.mapRow(d));
    if (rows.some((row: InboundMessage) => row.source !== "mercari_webhook")) {
      throw new Error("mercari_retry_claim_returned_non_mercari_source");
    }
    return rows;
  }

  async markProcessingComplete(id: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from("inbound_ticket_messages")
      .update({
        processing_status: "completed",
        processed_at: now,
        processing_error: null,
        next_retry_at: null,
      })
      .eq("id", id);

    if (error) {
      console.error(`[InboundRepo] markProcessingComplete failed for ${id}: ${error.message}`);
    }
  }

  async markProcessingFailed(id: string, error: string, retryable: boolean): Promise<void> {
    const now = new Date().toISOString();
    const MAX_ATTEMPTS = 5;

    // Read current attempts count
    const { data: row } = await this.supabase
      .from("inbound_ticket_messages")
      .select("processing_attempts")
      .eq("id", id)
      .maybeSingle();

    const attempts = ((row?.processing_attempts as number) ?? 0) + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;

    // Exponential backoff: 1min, 2min, 4min, 8min, 16min
    const backoffMinutes = Math.pow(2, attempts - 1);
    const nextRetryAt = !retryable || exhausted
      ? null
      : new Date(Date.now() + backoffMinutes * 60_000).toISOString();

    const { error: updateError } = await this.supabase
      .from("inbound_ticket_messages")
      .update({
        processing_status: exhausted ? "failed" : "pending",
        processing_attempts: attempts,
        processing_error: error,
        next_retry_at: nextRetryAt,
        last_attempt_at: now,
      })
      .eq("id", id);

    if (updateError) {
      console.error(`[InboundRepo] markProcessingFailed update failed for ${id}: ${updateError.message}`);
    }
  }

  async getProcessingStats(): Promise<ProcessingStats> {
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .select("processing_status");

    if (error) return { pending: 0, processing: 0, failed: 0, completed: 0 };

    const rows = data ?? [];
    return {
      pending: rows.filter((r: Record<string, unknown>) => r.processing_status === "pending").length,
      processing: rows.filter((r: Record<string, unknown>) => r.processing_status === "processing").length,
      failed: rows.filter((r: Record<string, unknown>) => r.processing_status === "failed").length,
      completed: rows.filter((r: Record<string, unknown>) => r.processing_status === "completed").length,
    };
  }

  async getShopProcessingStats(): Promise<ShopProcessingStats[]> {
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .select("shop_name, processing_status, server_received_at, processed_at");

    if (error || !data?.length) return [];

    const byShop = new Map<string, {
      pending: number; processing: number; failed: number; completed: number;
      newest_received: string | null; newest_processed: string | null;
    }>();

    for (const row of data) {
      const r = row as Record<string, unknown>;
      const shop = (r.shop_name as string) ?? "unknown";
      let entry = byShop.get(shop);
      if (!entry) {
        entry = { pending: 0, processing: 0, failed: 0, completed: 0, newest_received: null, newest_processed: null };
        byShop.set(shop, entry);
      }
      const status = r.processing_status as string;
      if (status === "pending") entry.pending++;
      else if (status === "processing") entry.processing++;
      else if (status === "failed") entry.failed++;
      else if (status === "completed") entry.completed++;

      const received = r.server_received_at as string | null;
      if (received && (!entry.newest_received || received > entry.newest_received)) {
        entry.newest_received = received;
      }
      const processed = r.processed_at as string | null;
      if (processed && (!entry.newest_processed || processed > entry.newest_processed)) {
        entry.newest_processed = processed;
      }
    }

    return Array.from(byShop.entries()).map(([shop_name, stats]) => ({ shop_name, ...stats }));
  }

  // ── Mappers ──

  private mapRow(data: Record<string, unknown>): InboundMessage {
    return {
      id: data.id as string,
      source: data.source as string,
      shop_name: (data.shop_name as string | null) ?? (data.source === "amazon_zoho_mail" ? "Amazon" : ""),
      shop_id: (data.shop_id as string | null) ?? (data.account_id as string | null) ?? "",
      order_transaction_id: (data.order_transaction_id as string | null)
        ?? (data.external_order_id as string | null)
        ?? (data.provider_message_id as string | null)
        ?? "",
      account_id: data.account_id as string | null,
      external_order_id: data.external_order_id as string | null,
      message_subject: data.message_subject as string | null,
      source_received_at: data.source_received_at as string | null,
      provider_account_id: data.provider_account_id as string | null,
      provider_folder_id: data.provider_folder_id as string | null,
      provider_message_id: data.provider_message_id as string | null,
      provider_thread_id: data.provider_thread_id as string | null,
      mail_auth_status: data.mail_auth_status as string | null,
      mail_auth_domain: data.mail_auth_domain as string | null,
      provider_metadata: (data.provider_metadata as Record<string, unknown>) ?? {},
      attachment_processing_status: (data.attachment_processing_status as string) ?? "none",
      attachment_processing_attempts: Number(data.attachment_processing_attempts || 0),
      attachment_error_code: data.attachment_error_code as string | null,
      external_thread_id: data.external_thread_id as string | null,
      customer_display_name: data.customer_display_name as string | null,
      product_summary: (data.product_summary as Record<string, unknown>) ?? {},
      order_summary: (data.order_summary as Record<string, unknown>) ?? {},
      latest_buyer_message: data.latest_buyer_message as string | null,
      full_payload: (data.full_payload as Record<string, unknown>) ?? {},
      linked_ticket_id: data.linked_ticket_id as string | null,
      queue_status: data.queue_status as string,
      review_status: data.review_status as string,
      classification: (data.classification as Record<string, unknown>) ?? {},
      classifier_version: data.classifier_version as string | null,
      automation_decision: (data.automation_decision as string) ?? "operator_review",
      automation_reason: data.automation_reason as string | null,
      reply_status: (data.reply_status as string) ?? "not_attempted",
      reply_platform_message_id: data.reply_platform_message_id as string | null,
      reply_attempted_at: data.reply_attempted_at as string | null,
      reply_sent_at: data.reply_sent_at as string | null,
      reply_error: data.reply_error as string | null,
      submission_token_id: data.submission_token_id as string | null,
      webhook_received_at: (data.webhook_received_at as string | null)
        ?? (data.source_received_at as string | null)
        ?? (data.received_at as string),
      received_at: data.received_at as string,
      read_at: data.read_at as string | null,
      reviewed_at: data.reviewed_at as string | null,
      idempotency_key: data.idempotency_key as string,
      processing_status: data.processing_status as string,
      processing_attempts: data.processing_attempts as number,
      processing_error: data.processing_error as string | null,
      processing_started_at: data.processing_started_at as string | null,
      processed_at: data.processed_at as string | null,
      next_retry_at: data.next_retry_at as string | null,
      last_attempt_at: data.last_attempt_at as string | null,
      server_received_at: data.server_received_at as string,
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
      order_url: data.source === "mercari_webhook" && data.shop_name && data.order_transaction_id
        ? getMercariOrderUrl(String(data.shop_name), String(data.order_transaction_id))
        : null,
    };
  }

  private mapListRow(data: Record<string, unknown>): InboundMessageListRow {
    const base = this.mapRow(data);
    const tickets = data.tickets as Record<string, unknown> | null;
    return {
      ...base,
      linked_ticket_number: tickets?.ticket_number as string | null,
      linked_ticket_status: tickets?.status as string | null,
      linked_ticket_subject: tickets?.subject as string | null,
    };
  }
}
