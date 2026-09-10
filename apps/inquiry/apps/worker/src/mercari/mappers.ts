import { contentHash } from "./identity";
import type {
  CanonicalInquiryInput,
  CanonicalMessageInput,
  DeliverySource,
  MercariInquiry,
  MercariMessage,
} from "./types";
import { MERCARI_SOURCE } from "./types";

function nullable(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return String(value);
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** BUYER -> inbound; SELLER/ADMIN (seller-side) -> outbound. */
export function directionFor(from: string | null | undefined): "inbound" | "outbound" {
  return from === "BUYER" ? "inbound" : "outbound";
}

/**
 * Normalize a readback inquiry into the canonical `inquiries` write shape.
 * `orderIdHint` is optional regex-derived evidence; it is not trusted for
 * routing (see router.ts).
 */
export async function mapInquiry(
  inquiry: MercariInquiry,
  shopKey: string,
  deliverySource: DeliverySource,
  orderIdHint?: string | null,
  latestBuyerMessage?: MercariMessage | null,
): Promise<CanonicalInquiryInput> {
  const target = inquiry.target ?? {};
  const firstOpenedAt = toIso(inquiry.firstOpenedAt ?? null);
  const lastActivityAt = toIso(inquiry.lastActivityAt ?? null);

  // First buyer message body from readback is not part of the discovery read;
  // normalize only what the discovery contract selected. Body/customer info are
  // filled by the thread reconciliation mapper when a message readback happens.
  return {
    shop_key: shopKey,
    source: MERCARI_SOURCE,
    external_inquiry_id: inquiry.id,
    external_status: nullable(inquiry.status),
    external_sales_channel: nullable(inquiry.salesChannel),
    external_first_opened_at: firstOpenedAt,
    external_last_activity_at: lastActivityAt,
    external_target_type: nullable(target.__typename),
    external_product_id: nullable(target.productId),
    external_product_variant_id: nullable(target.productVariantId),
    external_order_transaction_id: nullable(target.orderTransaction?.id),
    external_shop_id: nullable(target.shopId),
    source_observed_at: new Date().toISOString(),
    source_payload: toJson(inquiry),
    inquiry_date: firstOpenedAt,
    inquiry_body: latestBuyerMessage?.body ?? null,
    customer_nickname: null,
    last_inbound_time: toIso(latestBuyerMessage?.sentAt ?? null),
    last_custom_message: latestBuyerMessage?.body ?? null,
  };
}

/**
 * Normalize a readback message into the canonical `inquiry_messages` shape.
 * Returns null for messages with no stable external identity (cannot be
 * idempotently persisted).
 */
export async function mapMessage(
  message: MercariMessage,
  inquiryId: number,
  shopKey: string,
  externalInquiryId: string,
  deliverySource: DeliverySource,
): Promise<CanonicalMessageInput | null> {
  if (!message.id) return null;
  const body = message.body ?? null;
  const deleted = message.status === "DELETED";

  return {
    inquiry_id: inquiryId,
    shop_key: shopKey,
    source: MERCARI_SOURCE,
    external_inquiry_id: externalInquiryId,
    external_message_id: message.id,
    external_from: nullable(message.from),
    direction: directionFor(message.from),
    body,
    sent_at: toIso(message.sentAt ?? null),
    external_status: nullable(message.status),
    deleted_at: deleted ? new Date().toISOString() : null,
    attachments_metadata: Array.isArray(message.attachments) ? message.attachments : [],
    source_observed_at: new Date().toISOString(),
    source_payload_hash: await contentHash(body ?? ""),
  };
}
