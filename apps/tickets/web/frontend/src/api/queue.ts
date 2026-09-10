import { api } from "./client";

// ── Types ──

export interface InboundMessage {
  id: string;
  queue_ref: string;
  platform: "mercari" | "rakuten" | "amazon";
  allowed_actions: Array<"mark_read" | "mark_unread" | "review" | "ignore" | "link" | "convert" | "view_ticket">;
  capability_status: "ready" | "read_only";
  source: string;
  account_id: string | null;
  external_order_id: string | null;
  external_thread_id: string | null;
  message_subject: string | null;
  source_received_at: string | null;
  provider_message_id: string | null;
  mail_auth_status: string | null;
  provider_metadata: {
    attachments?: Array<{ state?: string; declared_mime?: string | null; declared_size?: number | null }>;
    attachment_count?: number;
  };
  attachment_processing_status?: "none" | "pending" | "processing" | "completed" | "failed";
  shop_name: string | null;
  shop_id: string | null;
  order_transaction_id: string | null;
  customer_display_name: string | null;
  product_summary: Record<string, unknown>;
  order_summary: Record<string, unknown>;
  latest_buyer_message: string | null;
  linked_ticket_id: string | null;
  queue_status: "unread" | "read" | "linked" | "converted" | "ignored" | "archived";
  review_status: "needs_review" | "reviewed" | "automation_candidate" | "untrusted_review";
  classification: ClassificationMeta | null;
  classifier_version: string | null;
  webhook_received_at: string | null;
  received_at: string;
  read_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Computed Mercari seller order URL */
  order_url: string | null;
  // Enriched fields from joins
  linked_ticket_number?: string | null;
  linked_ticket_status?: string | null;
  linked_ticket_subject?: string | null;
}

export interface ClassificationMeta {
  classification: string;
  workflow_route: string;
  recommended_operator_action: string;
  recommended_for_manual_creation?: boolean;
  /** Historical compatibility alias; advisory only. */
  should_convert_to_ticket: boolean;
  suggested_ticket_type: string | null;
  suggested_category: string | null;
  suggested_priority: string;
  confidence: number;
  reasoning_summary: string;
  automation_eligible: boolean;
  automation_blockers: string[];
  model: string;
  prompt_version: string;
}

export interface QueueFilters {
  shop_name?: string;
  queue_status?: string;
  review_status?: string;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface UnreadCount {
  total: number;
  by_shop: Record<string, number>;
  partial?: boolean;
  source_errors?: Array<{ source: string; code: string }>;
}

// ── API Functions ──

export interface ListQueueResponse {
  items: InboundMessage[];
  total: number;
  partial: boolean;
  source_errors: Array<{ source: "mercari" | "rakuten" | "amazon"; code: "SOURCE_UNAVAILABLE" | "SOURCE_DEGRADED" }>;
  contract_version: 1;
  has_more: boolean;
  total_is_estimate: true;
}

export async function listQueue(filters: QueueFilters): Promise<ListQueueResponse> {
  const params = new URLSearchParams();
  if (filters.shop_name) params.set("shop_name", filters.shop_name);
  if (filters.queue_status) params.set("queue_status", filters.queue_status);
  if (filters.review_status) params.set("review_status", filters.review_status);
  if (filters.q) params.set("q", filters.q);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  const qs = params.toString();
  return api<ListQueueResponse>(`/tickets/api/ticketing/queue${qs ? `?${qs}` : ""}`);
}

export async function getQueueItem(id: string): Promise<InboundMessage> {
  return api<InboundMessage>(`/tickets/api/ticketing/queue/${encodeURIComponent(id)}`);
}

export async function updateQueueItem(
  id: string,
  patch: { queue_status?: string; review_status?: string },
): Promise<InboundMessage> {
  return api<InboundMessage>(`/tickets/api/ticketing/queue/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function ignoreQueueItem(id: string): Promise<InboundMessage> {
  return api<InboundMessage>(`/tickets/api/ticketing/queue/${encodeURIComponent(id)}/ignore`, {
    method: "POST",
  });
}

export async function linkQueueToTicket(id: string, ticketId: string): Promise<InboundMessage> {
  return api<InboundMessage>(`/tickets/api/ticketing/queue/${encodeURIComponent(id)}/link`, {
    method: "POST",
    body: JSON.stringify({ ticket_id: ticketId }),
  });
}

export async function convertQueueToTicket(
  id: string,
  overrides?: { subject?: string; description?: string; priority?: string },
): Promise<{ ticket: { id: string; ticket_number: string }; queueItem: InboundMessage }> {
  return api(`/tickets/api/ticketing/queue/${encodeURIComponent(id)}/convert`, {
    method: "POST",
    body: JSON.stringify(overrides ?? {}),
  });
}

export async function getUnreadCount(shopName?: string): Promise<UnreadCount> {
  const params = shopName ? `?shop_name=${encodeURIComponent(shopName)}` : "";
  return api<UnreadCount>(`/tickets/api/ticketing/queue/unread-count${params}`);
}

export async function getQueueByTicket(ticketId: string): Promise<{ items: InboundMessage[] }> {
  return api<{ items: InboundMessage[] }>(
    `/tickets/api/ticketing/queue/by-ticket/${encodeURIComponent(ticketId)}`,
  );
}

// Classification helpers
export function getClassificationLabel(meta: ClassificationMeta | null): string {
  if (!meta || !meta.classification) return "Unclassified";
  const classification = meta.classification.split("/")[0] || meta.classification;
  const map: Record<string, string> = {
    real_ticket: "Issue",
    quality_issue: "Quality",
    suspicious: "Suspicious",
    delivery_request: "Delivery",
    return_request: "Return",
    refund_request: "Refund",
    cancellation_request: "Cancel",
    greeting_only: "Greeting",
    information_only: "Info",
    unclear: "Unclear",
    unclassified: "Unclassified",
  };
  return map[classification] ?? meta.classification;
}

export function getClassificationColor(meta: ClassificationMeta | null): string {
  if (!meta || !meta.classification) return "bg-gray-100 text-gray-600";
  const c = meta.classification.split("/")[0] || meta.classification;
  if (c === "real_ticket" || c === "quality_issue") return "bg-red-100 text-red-700";
  if (c === "suspicious") return "bg-yellow-100 text-yellow-700";
  if (c === "delivery_request" || c === "logistic_issue") return "bg-blue-100 text-blue-700";
  if (c === "return_request" || c === "refund_request") return "bg-orange-100 text-orange-700";
  if (c === "greeting_only") return "bg-green-100 text-green-700";
  if (c === "cancellation_request") return "bg-purple-100 text-purple-700";
  return "bg-gray-100 text-gray-600";
}
