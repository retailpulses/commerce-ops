import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundMessageService } from "./inboundMessageService";
import type { QueueFilters, UpdateInboundMessageInput } from "../repositories/inboundMessageRepository";

export type QueueSource = "mercari" | "rakuten" | "amazon";
export type QueueAction = "mark_read" | "mark_unread" | "review" | "ignore" | "link" | "convert" | "view_ticket";

export interface QueueSourceError {
  source: QueueSource;
  code: "SOURCE_UNAVAILABLE" | "SOURCE_DEGRADED";
}

export interface TicketInboundQueueItem {
  id: string;
  queue_ref: string;
  source: string;
  platform: QueueSource;
  allowed_actions: QueueAction[];
  capability_status: "ready" | "read_only";
  shop_name: string | null;
  shop_id: string | null;
  account_id: string | null;
  order_transaction_id: string | null;
  external_order_id: string | null;
  external_thread_id: string | null;
  provider_message_id: string | null;
  message_subject: string | null;
  source_received_at: string | null;
  customer_display_name: string | null;
  latest_buyer_message: string | null;
  product_summary: Record<string, unknown>;
  order_summary: Record<string, unknown>;
  provider_metadata: Record<string, unknown>;
  attachment_processing_status: string;
  mail_auth_status: string | null;
  linked_ticket_id: string | null;
  linked_ticket_number?: string | null;
  linked_ticket_status?: string | null;
  linked_ticket_subject?: string | null;
  queue_status: string;
  review_status: string;
  classification: Record<string, unknown> | null;
  classifier_version: string | null;
  webhook_received_at: string | null;
  received_at: string;
  read_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  order_url: string | null;
}

export interface QueueListResult {
  items: TicketInboundQueueItem[];
  total: number;
  partial: boolean;
  source_errors: QueueSourceError[];
  contract_version: 1;
  has_more: boolean;
  total_is_estimate: true;
}

const MERCARI_QUEUE_COLUMNS = [
  "id", "source", "shop_name", "shop_id", "order_transaction_id", "external_thread_id",
  "customer_display_name", "latest_buyer_message", "product_summary", "order_summary",
  "linked_ticket_id", "queue_status", "review_status", "classification", "classifier_version",
  "webhook_received_at", "received_at", "read_at", "reviewed_at", "created_at", "updated_at",
  "tickets!inbound_ticket_messages_linked_ticket_id_fkey(ticket_number,status,subject)",
].join(",");

const AMAZON_QUEUE_COLUMNS = [
  "id", "account_id", "ticket_id", "provider_account_id", "provider_message_id",
  "provider_thread_id", "external_order_id", "subject", "body", "source_received_at",
  "mail_auth_status", "review_status", "processing_status", "attachment_count",
  "attachment_summary", "queue_status", "read_at", "reviewed_at", "created_at", "updated_at",
  "tickets!amazon_mail_messages_ticket_id_fkey(ticket_number,status,subject)",
].join(",");

const LEGACY_AMAZON_QUEUE_COLUMNS = [
  "id", "account_id", "linked_ticket_id", "provider_account_id", "provider_message_id",
  "provider_thread_id", "external_order_id", "message_subject", "latest_buyer_message",
  "source_received_at", "mail_auth_status", "review_status", "processing_status",
  "attachment_processing_status", "provider_metadata", "queue_status", "read_at", "reviewed_at", "created_at", "updated_at",
  "tickets!inbound_ticket_messages_linked_ticket_id_fkey(ticket_number,status,subject)",
].join(",");

const RAKUTEN_QUEUE_COLUMNS = [
  "account_id", "inquiry_number", "shop_id", "order_number", "ticket_id",
  "last_update_date", "last_ingested_at", "created_at",
  "tickets!rakuten_rmesse_inquiries_ticket_id_fkey(ticket_number,status,subject)",
].join(",");

export function parseQueueRef(value: string): { source: QueueSource; nativeId: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("INVALID_QUEUE_REF");
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0 || separator === decoded.length - 1) throw new Error("INVALID_QUEUE_REF");
  const source = decoded.slice(0, separator);
  const nativeId = decoded.slice(separator + 1);
  if (source !== "mercari" && source !== "rakuten" && source !== "amazon") {
    throw new Error("INVALID_QUEUE_REF");
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(nativeId)) throw new Error("INVALID_QUEUE_REF");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (source === "mercari" && !uuid.test(nativeId)) throw new Error("INVALID_QUEUE_REF");
  if (source === "amazon") {
    const match = /^(v2|legacy)~(.+)$/.exec(nativeId);
    if (!match || !uuid.test(match[2]!)) throw new Error("INVALID_QUEUE_REF");
  }
  return { source, nativeId };
}

function ticketJoin(row: Record<string, unknown>): Record<string, unknown> | null {
  const joined = row.tickets;
  if (Array.isArray(joined)) return (joined[0] as Record<string, unknown>) ?? null;
  return joined && typeof joined === "object" ? joined as Record<string, unknown> : null;
}

function iso(value: unknown): string {
  return typeof value === "string" ? value : new Date(0).toISOString();
}

export function compareQueueItems(a: TicketInboundQueueItem, b: TicketInboundQueueItem): number {
  const byTime = b.received_at.localeCompare(a.received_at);
  if (byTime !== 0) return byTime;
  const bySource = a.platform.localeCompare(b.platform);
  return bySource !== 0 ? bySource : a.id.localeCompare(b.id);
}

export class TicketInboundQueueService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly mercari: InboundMessageService,
  ) {}

  async list(filters: QueueFilters): Promise<QueueListResult> {
    if (filters.q && (!/^[\p{L}\p{N}\s._~-]{1,100}$/u.test(filters.q))) throw new Error("INVALID_QUEUE_FILTER");
    if (filters.sort && filters.sort !== "received_at.desc") throw new Error("INVALID_QUEUE_FILTER");
    if (filters.limit !== undefined && !Number.isFinite(filters.limit)) throw new Error("INVALID_QUEUE_FILTER");
    if (filters.offset !== undefined && (!Number.isFinite(filters.offset) || filters.offset < 0 || filters.offset > 5000)) throw new Error("INVALID_QUEUE_FILTER");
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const offset = Math.max(filters.offset ?? 0, 0);
    const sourceLimit = offset + limit + 1;
    const requests: Array<{ source: QueueSource; run: Promise<{ items: TicketInboundQueueItem[]; error?: QueueSourceError }> }> = [
      { source: "mercari", run: this.listMercari(filters, sourceLimit).then((items) => ({ items })) },
    ];
    if (!filters.shop_name) {
      requests.push(
        { source: "rakuten", run: this.listRakuten(filters, sourceLimit).then((items) => ({ items })) },
        { source: "amazon", run: this.listAmazon(filters, sourceLimit) },
      );
    }
    const settled = await Promise.allSettled(requests.map(({ run }) => run));
    const items: TicketInboundQueueItem[] = [];
    const sourceErrors: QueueSourceError[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        items.push(...result.value.items);
        if (result.value.error) sourceErrors.push(result.value.error);
      }
      else sourceErrors.push({ source: requests[index]!.source, code: "SOURCE_UNAVAILABLE" });
    });
    const filtered = items.filter((item) => {
      if (filters.queue_status && item.queue_status !== filters.queue_status) return false;
      if (filters.review_status && item.review_status !== filters.review_status) return false;
      if (filters.shop_name && item.shop_name !== filters.shop_name) return false;
      return true;
    }).sort(compareQueueItems);
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      partial: sourceErrors.length > 0,
      source_errors: sourceErrors,
      contract_version: 1,
      has_more: filtered.length > offset + limit,
      total_is_estimate: true,
    };
  }

  async get(queueRef: string): Promise<TicketInboundQueueItem | null> {
    const { source, nativeId } = parseQueueRef(queueRef);
    if (source === "mercari") return this.getMercari(nativeId);
    if (source === "amazon") return this.getAmazon(nativeId);
    return this.getRakuten(nativeId);
  }

  async update(queueRef: string, input: UpdateInboundMessageInput): Promise<TicketInboundQueueItem> {
    const { source, nativeId } = parseQueueRef(queueRef);
    if (source === "rakuten") throw new Error("ACTION_UNSUPPORTED");
    if (input.linked_ticket_id !== undefined) throw new Error("ACTION_UNSUPPORTED");
    const keys = Object.keys(input).filter((key) => input[key as keyof UpdateInboundMessageInput] !== undefined);
    if (keys.some((key) => !["queue_status", "review_status"].includes(key))) throw new Error("ACTION_UNSUPPORTED");
    if (keys.length !== 1) throw new Error("ACTION_UNSUPPORTED");
    if (input.queue_status && !["read", "unread"].includes(input.queue_status)) throw new Error("ACTION_UNSUPPORTED");
    if (input.review_status && input.review_status !== "reviewed") throw new Error("ACTION_UNSUPPORTED");
    const action = input.queue_status === "read" ? "mark_read" : input.queue_status === "unread" ? "mark_unread" : "review";
    if (source === "amazon") return this.transitionAmazon(nativeId, action);
    await this.requireMercariAction(nativeId, input.queue_status === "read" ? "mark_read" : input.queue_status === "unread" ? "mark_unread" : "review");
    await this.transitionMercari(nativeId, action);
    const item = await this.getMercari(nativeId);
    if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
    return item;
  }

  async ignore(queueRef: string): Promise<TicketInboundQueueItem> {
    const { source, nativeId } = parseQueueRef(queueRef);
    if (source === "amazon") return this.transitionAmazon(nativeId, "ignore");
    if (source !== "mercari") throw new Error("ACTION_UNSUPPORTED");
    await this.requireMercariAction(nativeId, "ignore");
    await this.transitionMercari(nativeId, "ignore");
    const item = await this.getMercari(nativeId);
    if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
    return item;
  }

  async link(queueRef: string, ticketId: string): Promise<TicketInboundQueueItem> {
    const { source, nativeId } = parseQueueRef(queueRef);
    if (source === "amazon") return this.transitionAmazon(nativeId, "link", ticketId);
    if (source !== "mercari") throw new Error("ACTION_UNSUPPORTED");
    await this.requireMercariAction(nativeId, "link");
    await this.mercari.linkToTicket(nativeId, ticketId);
    const item = await this.getMercari(nativeId);
    if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
    return item;
  }

  async convert(queueRef: string, overrides: Record<string, unknown>) {
    const { source, nativeId } = parseQueueRef(queueRef);
    if (source === "amazon") {
      const item = await this.transitionAmazon(nativeId, "convert");
      if (!item.linked_ticket_id) throw new Error("SOURCE_UNAVAILABLE");
      return { ticket: { id: item.linked_ticket_id, ticket_number: item.linked_ticket_number }, queueItem: item };
    }
    if (source !== "mercari") throw new Error("ACTION_UNSUPPORTED");
    await this.requireMercariAction(nativeId, "convert");
    const safeOverrides = {
      subject: typeof overrides.subject === "string" ? overrides.subject : undefined,
      description: typeof overrides.description === "string" ? overrides.description : undefined,
      priority: typeof overrides.priority === "string" ? overrides.priority : undefined,
    };
    const result = await this.mercari.convertToTicket(nativeId, safeOverrides);
    return { ...result, queueItem: await this.getMercari(nativeId) };
  }

  async byTicket(ticketId: string): Promise<QueueListResult> {
    return this.list({ linked_ticket_id: ticketId, limit: 5000, offset: 0 });
  }

  async unreadCount(shopName?: string) {
    const requests: PromiseLike<unknown>[] = [
      this.supabase.rpc("count_mercari_queue_unread_v1", { p_shop_name: shopName ?? null }),
    ];
    if (!shopName) requests.push(this.supabase.rpc("count_amazon_mail_queue_unread_v1"));
    const settled = await Promise.allSettled(requests);
    const sourceErrors: QueueSourceError[] = [];
    const mercariResult = settled[0];
    const mercariValue = mercariResult.status === "fulfilled" ? mercariResult.value as { data?: unknown[] | null; error?: unknown } : null;
    const mercariRows = mercariValue && !mercariValue.error ? mercariValue.data ?? [] : [];
    if (!mercariValue || mercariValue.error) sourceErrors.push({ source: "mercari", code: "SOURCE_UNAVAILABLE" });
    const by_shop: Record<string, number> = {};
    for (const row of mercariRows) {
      const value = row as Record<string, unknown>;
      const key = String(value.shop_name ?? "mercari");
      by_shop[key] = Number(value.unread_count ?? 0);
    }
    const amazonResult = settled[1];
    if (amazonResult) {
      const amazonValue = amazonResult.status === "fulfilled" ? amazonResult.value as { data?: unknown; error?: unknown } : null;
      if (!amazonValue || amazonValue.error) {
        sourceErrors.push({ source: "amazon", code: "SOURCE_UNAVAILABLE" });
      } else {
        const row = (Array.isArray(amazonValue.data) ? amazonValue.data[0] : amazonValue.data) as Record<string, unknown> | null;
        by_shop.amazon = Number(row?.total ?? 0);
        if (row?.v2_available !== true || row?.legacy_available !== true) {
          sourceErrors.push({ source: "amazon", code: "SOURCE_DEGRADED" });
        }
      }
    }
    const total = Object.values(by_shop).reduce((sum, count) => sum + count, 0);
    return { total, by_shop, partial: sourceErrors.length > 0, source_errors: sourceErrors };
  }

  private async listMercari(filters: QueueFilters, limit: number): Promise<TicketInboundQueueItem[]> {
    const rows: Record<string, unknown>[] = [];
    for (let start = 0; start < limit; start += 1000) {
      let query = this.supabase.from("inbound_ticket_messages").select(MERCARI_QUEUE_COLUMNS).eq("source", "mercari_webhook");
      if (filters.shop_name) query = query.eq("shop_name", filters.shop_name);
      if (filters.queue_status) query = query.eq("queue_status", filters.queue_status);
      if (filters.review_status) query = query.eq("review_status", filters.review_status);
      if (filters.linked_ticket_id !== undefined) query = filters.linked_ticket_id === null ? query.is("linked_ticket_id", null) : query.eq("linked_ticket_id", filters.linked_ticket_id);
      if (filters.q) query = query.or(`customer_display_name.ilike.%${filters.q}%,order_transaction_id.ilike.%${filters.q}%,latest_buyer_message.ilike.%${filters.q}%`);
      const pageSize = Math.min(1000, limit - start);
      const { data, error } = await query.order("received_at", { ascending: false }).order("id", { ascending: true }).range(start, start + pageSize - 1);
      if (error) throw new Error("MERCARI_QUEUE_UNAVAILABLE");
      rows.push(...(data ?? []).map((row) => row as unknown as Record<string, unknown>));
      if ((data ?? []).length < pageSize) break;
    }
    return rows.map((row) => this.mapMercari(row));
  }

  private async listAmazon(filters: QueueFilters, limit: number): Promise<{ items: TicketInboundQueueItem[]; error?: QueueSourceError }> {
    if (filters.queue_status && !["unread", "read", "linked", "converted", "ignored"].includes(filters.queue_status)) {
      return { items: [] };
    }
    const [v2, legacy] = await Promise.allSettled([
      this.fetchAmazonGeneration("v2", filters, limit),
      this.fetchAmazonGeneration("legacy", filters, limit),
    ]);
    const v2Available = v2.status === "fulfilled";
    const legacyAvailable = legacy.status === "fulfilled";
    if (!v2Available && !legacyAvailable) throw new Error("AMAZON_QUEUE_UNAVAILABLE");
    const v2Rows = v2Available ? v2.value : [];
    const dedupeKey = (row: Record<string, unknown>) => `${String(row.provider_account_id ?? "")}\u0000${String(row.provider_message_id ?? "")}`;
    const keys = new Set(v2Rows.map(dedupeKey));
    const legacyRows = (legacyAvailable ? legacy.value : [])
      .filter((row) => !keys.has(dedupeKey(row)));
    const items = [
      ...v2Rows.map((row) => this.mapAmazon(row)),
      ...legacyRows.map((row) => this.mapLegacyAmazon(row)),
    ];
    return { items, ...(!v2Available || !legacyAvailable ? { error: { source: "amazon" as const, code: "SOURCE_DEGRADED" as const } } : {}) };
  }

  private async fetchAmazonGeneration(generation: "v2" | "legacy", filters: QueueFilters, limit: number): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let start = 0; start < limit; start += 1000) {
      let query = generation === "v2"
        ? this.supabase.from("amazon_mail_messages").select(AMAZON_QUEUE_COLUMNS)
        : this.supabase.from("inbound_ticket_messages").select(LEGACY_AMAZON_QUEUE_COLUMNS).eq("source", "amazon_zoho_mail");
      if (filters.queue_status) query = query.eq("queue_status", filters.queue_status);
      if (filters.review_status) query = query.eq("review_status", filters.review_status);
      if (filters.linked_ticket_id !== undefined) {
        const column = generation === "v2" ? "ticket_id" : "linked_ticket_id";
        query = filters.linked_ticket_id === null ? query.is(column, null) : query.eq(column, filters.linked_ticket_id);
      }
      if (filters.q) {
        query = generation === "v2"
          ? query.or(`subject.ilike.%${filters.q}%,external_order_id.ilike.%${filters.q}%`)
          : query.or(`message_subject.ilike.%${filters.q}%,external_order_id.ilike.%${filters.q}%`);
      }
      const pageSize = Math.min(1000, limit - start);
      const { data, error } = await query.order("source_received_at", { ascending: false }).order("id", { ascending: true }).range(start, start + pageSize - 1);
      if (error) throw new Error(`AMAZON_${generation.toUpperCase()}_QUEUE_UNAVAILABLE`);
      rows.push(...(data ?? []).map((row) => row as unknown as Record<string, unknown>));
      if ((data ?? []).length < pageSize) break;
    }
    return rows;
  }

  private async listRakuten(filters: QueueFilters, limit: number): Promise<TicketInboundQueueItem[]> {
    if (filters.queue_status && filters.queue_status !== "linked") return [];
    if (filters.review_status && filters.review_status !== "reviewed") return [];
    if (filters.linked_ticket_id === null) return [];
    const rows: Record<string, unknown>[] = [];
    for (let start = 0; start < limit; start += 1000) {
      let query = this.supabase.from("rakuten_rmesse_inquiries").select(RAKUTEN_QUEUE_COLUMNS);
      if (typeof filters.linked_ticket_id === "string") query = query.eq("ticket_id", filters.linked_ticket_id);
      if (filters.q) query = query.or(`inquiry_number.ilike.%${filters.q}%,order_number.ilike.%${filters.q}%`);
      const pageSize = Math.min(1000, limit - start);
      const { data, error } = await query.order("last_update_date", { ascending: false }).order("inquiry_number", { ascending: true }).range(start, start + pageSize - 1);
      if (error) throw new Error("RAKUTEN_QUEUE_UNAVAILABLE");
      rows.push(...(data ?? []).map((row) => row as unknown as Record<string, unknown>));
      if ((data ?? []).length < pageSize) break;
    }
    return rows.map((row) => this.mapRakuten(row));
  }

  private async getMercari(nativeId: string): Promise<TicketInboundQueueItem | null> {
    const { data, error } = await this.supabase.from("inbound_ticket_messages").select(MERCARI_QUEUE_COLUMNS).eq("source", "mercari_webhook").eq("id", nativeId).maybeSingle();
    if (error) throw new Error("MERCARI_QUEUE_UNAVAILABLE");
    return data ? this.mapMercari(data as unknown as Record<string, unknown>) : null;
  }

  private async getAmazon(nativeId: string): Promise<TicketInboundQueueItem | null> {
    const separator = nativeId.indexOf("~");
    if (separator <= 0) throw new Error("INVALID_QUEUE_REF");
    const generation = nativeId.slice(0, separator);
    const id = nativeId.slice(separator + 1);
    const table = generation === "v2" ? "amazon_mail_messages" : generation === "legacy" ? "inbound_ticket_messages" : null;
    if (!table) throw new Error("INVALID_QUEUE_REF");
    let query = this.supabase.from(table).select(generation === "v2" ? AMAZON_QUEUE_COLUMNS : LEGACY_AMAZON_QUEUE_COLUMNS).eq("id", id);
    if (generation === "legacy") query = query.eq("source", "amazon_zoho_mail");
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("AMAZON_QUEUE_UNAVAILABLE");
    if (!data) return null;
    const row = data as unknown as Record<string, unknown>;
    return generation === "v2" ? this.mapAmazon(row, "v2") : this.mapLegacyAmazon(row);
  }

  private async getRakuten(nativeId: string): Promise<TicketInboundQueueItem | null> {
    const separator = nativeId.indexOf("~");
    if (separator <= 0) throw new Error("INVALID_QUEUE_REF");
    const accountId = nativeId.slice(0, separator);
    const inquiryNumber = nativeId.slice(separator + 1);
    const { data, error } = await this.supabase.from("rakuten_rmesse_inquiries").select(RAKUTEN_QUEUE_COLUMNS).eq("account_id", accountId).eq("inquiry_number", inquiryNumber).maybeSingle();
    if (error) throw new Error("RAKUTEN_QUEUE_UNAVAILABLE");
    return data ? this.mapRakuten(data as unknown as Record<string, unknown>) : null;
  }

  private mapMercari(row: Record<string, unknown>): TicketInboundQueueItem {
    const nativeId = String(row.id);
    const ticket = ticketJoin(row);
    const queueStatus = String(row.queue_status ?? "unread");
    const actions: QueueAction[] = [];
    if (queueStatus === "unread") actions.push("mark_read");
    if (queueStatus === "read") actions.push("mark_unread");
    if (row.review_status === "needs_review") actions.push("review");
    if (!["linked", "converted", "ignored"].includes(queueStatus)) actions.push("ignore", "link", "convert");
    if (row.linked_ticket_id) actions.push("view_ticket");
    return {
      id: `mercari:${nativeId}`, queue_ref: `mercari:${nativeId}`, source: "mercari_webhook", platform: "mercari",
      allowed_actions: actions, capability_status: "ready", shop_name: row.shop_name as string ?? null,
      shop_id: row.shop_id as string ?? null, account_id: row.account_id as string ?? null,
      order_transaction_id: row.order_transaction_id as string ?? null, external_order_id: row.external_order_id as string ?? null,
      external_thread_id: row.external_thread_id as string ?? null, provider_message_id: row.provider_message_id as string ?? null,
      message_subject: row.message_subject as string ?? null, source_received_at: row.source_received_at as string ?? null,
      customer_display_name: row.customer_display_name as string ?? null, latest_buyer_message: row.latest_buyer_message as string ?? null,
      product_summary: row.product_summary as Record<string, unknown> ?? {}, order_summary: row.order_summary as Record<string, unknown> ?? {},
      provider_metadata: {}, attachment_processing_status: String(row.attachment_processing_status ?? "none"),
      mail_auth_status: null, linked_ticket_id: row.linked_ticket_id as string ?? null,
      linked_ticket_number: ticket?.ticket_number as string ?? null, linked_ticket_status: ticket?.status as string ?? null,
      linked_ticket_subject: ticket?.subject as string ?? null, queue_status: queueStatus,
      review_status: String(row.review_status ?? "needs_review"), classification: row.classification as Record<string, unknown> ?? null,
      classifier_version: row.classifier_version as string ?? null, webhook_received_at: row.webhook_received_at as string ?? null,
      received_at: iso(row.received_at), read_at: row.read_at as string ?? null, reviewed_at: row.reviewed_at as string ?? null,
      created_at: iso(row.created_at), updated_at: iso(row.updated_at), order_url: null,
    };
  }

  private async requireMercariAction(nativeId: string, action: QueueAction): Promise<TicketInboundQueueItem> {
    const item = await this.getMercari(nativeId);
    if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
    if (!item.allowed_actions.includes(action)) throw new Error("QUEUE_STATE_CONFLICT");
    return item;
  }

  private async transitionMercari(nativeId: string, action: "mark_read" | "mark_unread" | "review" | "ignore"): Promise<void> {
    const { error } = await this.supabase.rpc("transition_mercari_queue_v1", {
      p_inbound_message_id: nativeId,
      p_action: action,
    });
    if (error) throw new Error(error.message || "MERCARI_QUEUE_UNAVAILABLE");
  }

  private async transitionAmazon(nativeId: string, action: Exclude<QueueAction, "view_ticket">, ticketId?: string): Promise<TicketInboundQueueItem> {
    if (!nativeId.startsWith("v2~")) throw new Error("ACTION_UNSUPPORTED");
    const item = await this.getAmazon(nativeId);
    if (!item) throw new Error("QUEUE_ITEM_NOT_FOUND");
    if (!item.allowed_actions.includes(action)) throw new Error("QUEUE_STATE_CONFLICT");
    const messageId = nativeId.slice(3);
    const { error } = await this.supabase.rpc("transition_amazon_mail_queue_v1", {
      p_message_id: messageId,
      p_action: action,
      p_ticket_id: ticketId ?? null,
      p_actor_id: "portal_operator",
    });
    if (error) throw new Error(error.message || "AMAZON_QUEUE_UNAVAILABLE");
    const updated = await this.getAmazon(nativeId);
    if (!updated) throw new Error("QUEUE_ITEM_NOT_FOUND");
    return updated;
  }

  private mapAmazon(row: Record<string, unknown>, generation: "v2" | "legacy" = "v2"): TicketInboundQueueItem {
    const nativeId = String(row.id);
    const ticket = ticketJoin(row);
    const trusted = row.mail_auth_status === "pass";
    const queueStatus = String(row.queue_status ?? (row.ticket_id ? "linked" : "unread"));
    const actions: QueueAction[] = [];
    if (generation === "v2") {
      if (queueStatus === "unread") actions.push("mark_read");
      if (queueStatus === "read") actions.push("mark_unread");
      if (row.review_status === "needs_review" || (row.review_status === "untrusted_review" && !row.reviewed_at)) actions.push("review");
      if (["unread", "read"].includes(queueStatus) && !row.ticket_id) actions.push("ignore");
      if (trusted && !row.ticket_id && row.external_order_id) actions.push("link", "convert");
    }
    if (row.ticket_id) actions.push("view_ticket");
    return {
      id: `amazon:${generation}~${nativeId}`, queue_ref: `amazon:${generation}~${nativeId}`, source: "amazon_mail", platform: "amazon",
      allowed_actions: actions, capability_status: generation === "v2" ? "ready" : "read_only", shop_name: null, shop_id: null,
      account_id: row.account_id as string ?? null, order_transaction_id: null, external_order_id: row.external_order_id as string ?? null,
      external_thread_id: row.provider_thread_id as string ?? null, provider_message_id: row.provider_message_id as string ?? null,
      message_subject: trusted ? row.subject as string ?? null : null, source_received_at: row.source_received_at as string ?? null,
      customer_display_name: null, latest_buyer_message: trusted ? row.body as string ?? null : null,
      product_summary: {}, order_summary: {}, provider_metadata: { attachment_count: row.attachment_count ?? 0 },
      attachment_processing_status: String(row.processing_status ?? "pending"), mail_auth_status: row.mail_auth_status as string ?? null,
      linked_ticket_id: row.ticket_id as string ?? null, linked_ticket_number: ticket?.ticket_number as string ?? null,
      linked_ticket_status: ticket?.status as string ?? null, linked_ticket_subject: ticket?.subject as string ?? null,
      queue_status: queueStatus, review_status: String(row.review_status ?? "needs_review"),
      classification: null, classifier_version: null, webhook_received_at: null, received_at: iso(row.source_received_at),
      read_at: row.read_at as string ?? null, reviewed_at: row.reviewed_at as string ?? null, created_at: iso(row.created_at), updated_at: iso(row.updated_at), order_url: null,
    };
  }

  private mapLegacyAmazon(row: Record<string, unknown>): TicketInboundQueueItem {
    return this.mapAmazon({
      ...row,
      ticket_id: row.linked_ticket_id,
      subject: row.message_subject,
      body: row.latest_buyer_message,
      attachment_count: Array.isArray((row.provider_metadata as Record<string, unknown> | undefined)?.attachments)
        ? ((row.provider_metadata as Record<string, unknown>).attachments as unknown[]).length
        : 0,
      attachment_summary: {},
    }, "legacy");
  }

  private mapRakuten(row: Record<string, unknown>): TicketInboundQueueItem {
    const nativeId = `${String(row.account_id)}~${String(row.inquiry_number)}`;
    const ticket = ticketJoin(row);
    return {
      id: `rakuten:${nativeId}`, queue_ref: `rakuten:${nativeId}`, source: "rakuten_rmesse", platform: "rakuten",
      allowed_actions: ["view_ticket"], capability_status: "read_only", shop_name: null, shop_id: row.shop_id as string ?? null,
      account_id: row.account_id as string ?? null, order_transaction_id: row.order_number as string ?? null,
      external_order_id: row.order_number as string ?? null, external_thread_id: row.inquiry_number as string ?? null,
      provider_message_id: null, message_subject: ticket?.subject as string ?? "Rakuten R-Messe inquiry", source_received_at: iso(row.last_update_date),
      customer_display_name: null, latest_buyer_message: null, product_summary: {}, order_summary: {}, provider_metadata: {},
      attachment_processing_status: "none", mail_auth_status: null, linked_ticket_id: row.ticket_id as string ?? null,
      linked_ticket_number: ticket?.ticket_number as string ?? null, linked_ticket_status: ticket?.status as string ?? null,
      linked_ticket_subject: ticket?.subject as string ?? null, queue_status: "linked", review_status: "reviewed",
      classification: null, classifier_version: null, webhook_received_at: null, received_at: iso(row.last_update_date),
      read_at: null, reviewed_at: null, created_at: iso(row.created_at), updated_at: iso(row.last_ingested_at), order_url: null,
    };
  }
}
