/**
 * Normalized Mercari inquiry/message types.
 *
 * These describe the *readback* facts returned by the Mercari Inquiry GraphQL
 * API (through the ConoHa relay), not the webhook notification payload. The
 * webhook is only a "this thread may have changed" trigger; body, direction,
 * status, target and delete state are authoritative only after readback.
 */

export const MERCARI_SOURCE = "mercari_shops";

export const WEBHOOK_TOPICS = [
  "INQUIRY_MESSAGE_CREATED",
  "INQUIRY_RESOLVED",
  "INQUIRY_MESSAGE_ADMIN_DELETED",
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export function isWebhookTopic(value: string): value is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly string[]).includes(value);
}

/** Mercari target typenames. */
export type MercariTargetTypename =
  | "InquiryProductTarget"
  | "InquiryShopTarget"
  | "InquiryOrderTransactionTarget";

export interface MercariOrderTransaction {
  id?: string | null;
}

export interface MercariTarget {
  __typename?: string | null;
  productId?: string | null;
  productVariantId?: string | null;
  shopId?: string | null;
  /** Authority for presales vs post-order routing. */
  orderTransaction?: MercariOrderTransaction | null;
}

export interface MercariInquiry {
  /** Mercari inquiry ID — canonical external_inquiry_id. */
  id: string;
  status?: string | null;
  salesChannel?: string | null;
  firstOpenedAt?: string | null;
  lastActivityAt?: string | null;
  userInfo?: {
    nickname?: string | null;
  } | null;
  target?: MercariTarget | null;
}

export interface MercariMessage {
  /** Mercari message ID — canonical external_message_id. */
  id: string;
  inquiryId?: string | null;
  body?: string | null;
  from?: "BUYER" | "SELLER" | "ADMIN" | (string & {}) | null;
  sentAt?: string | null;
  status?: "ACTIVE" | "DELETED" | (string & {}) | null;
  attachments?: unknown[] | null;
}

export type DeliverySource = "webhook" | "daily_audit" | "backfill";

export type RouteTarget = "inquiry" | "ticketing" | "quarantine";

export interface RouteDecision {
  route: RouteTarget;
  reason?: string;
}

/** Canonical `inquiries` column subset written by the ingestion contract. */
export interface CanonicalInquiryInput {
  shop_key: string;
  source: string;
  external_inquiry_id: string;
  external_status: string | null;
  external_sales_channel: string | null;
  external_first_opened_at: string | null;
  external_last_activity_at: string | null;
  external_target_type: string | null;
  external_product_id: string | null;
  external_product_variant_id: string | null;
  external_order_transaction_id: string | null;
  external_shop_id: string | null;
  source_observed_at: string;
  source_payload: Record<string, unknown>;
  inquiry_date: string | null;
  inquiry_body: string | null;
  customer_nickname: string | null;
  last_inbound_time: string | null;
  last_custom_message: string | null;
}

/** Canonical `inquiry_messages` column subset. */
export interface CanonicalMessageInput {
  inquiry_id: number;
  shop_key: string;
  source: string;
  external_inquiry_id: string | null;
  external_message_id: string;
  external_from: string | null;
  direction: "inbound" | "outbound";
  body: string | null;
  sent_at: string | null;
  external_status: string | null;
  deleted_at: string | null;
  attachments_metadata: unknown[];
  source_observed_at: string;
  source_payload_hash: string;
}

export interface WebhookEventRecord {
  event_identity: string;
  shop_key: string;
  topic: WebhookTopic;
  external_event_id: string | null;
  external_inquiry_id: string | null;
  external_message_id: string | null;
  schema_version: string | null;
  occurred_at: string | null;
  received_at: string;
  delivery_source: DeliverySource;
  raw_payload: Record<string, unknown>;
  processing_status: "pending";
  attempts: number;
}

export interface WebhookEventRow extends Omit<WebhookEventRecord, "processing_status" | "attempts"> {
  id: number;
  processing_status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  processed_at: string | null;
}
