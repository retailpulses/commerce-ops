/**
 * Deterministic identity and idempotency primitives.
 *
 * - Inquiry canonical identity: (shop_key, external_inquiry_id)
 * - Message canonical identity: (shop_key, external_message_id)
 * - Webhook event identity: prefer external event id; otherwise a deterministic
 *   sha256 fallback over schema_version/shop/topic/inquiry/message/occurred_at.
 * - Outbound idempotency key: sha256(shop_key + external_inquiry_id + cycle + version)
 *
 * `source` is deliberately absent from all identities (source-neutral).
 */

export const SCHEMA_VERSION = "mercari-inquiry-v1";
export const INITIAL_REPLY_CYCLE = "reply";

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface EventIdentityInput {
  shopKey: string;
  topic: string;
  externalEventId?: string | null;
  externalInquiryId?: string | null;
  externalMessageId?: string | null;
  occurredAt?: string | null;
  schemaVersion?: string | null;
}

/**
 * Stable, replayable webhook event identity.
 *
 * Preferred key is shop + topic + external event id. When the platform provides
 * no event id, fall back to a deterministic hash — never a hash of the whole
 * mutable payload.
 */
export async function eventIdentity(input: EventIdentityInput): Promise<string> {
  if (input.externalEventId) {
    return `evt:${input.shopKey}:${input.topic}:${input.externalEventId}`;
  }
  const material = [
    input.schemaVersion ?? SCHEMA_VERSION,
    input.shopKey,
    input.topic,
    input.externalInquiryId ?? "",
    input.externalMessageId ?? "",
    input.occurredAt ?? "",
  ].join("\0");
  return `sha256:${await sha256Hex(material)}`;
}

export interface OutboundIdempotencyInput {
  shopKey: string;
  externalInquiryId: string;
  /** follow_up_cycle_id, or null for the initial reply cycle. */
  cycleId: string | null;
  operationVersion: number;
}

/**
 * Stable client operation/idempotency key for `addInquiryMessage`.
 * Retries of the same logical send must reuse the identical key.
 */
export async function outboundIdempotencyKey(
  input: OutboundIdempotencyInput,
): Promise<string> {
  const material = [
    input.shopKey,
    input.externalInquiryId,
    input.cycleId ?? INITIAL_REPLY_CYCLE,
    String(input.operationVersion),
  ].join("\0");
  return sha256Hex(material);
}

/** Content hash for source payload / authoritative readback evidence. */
export async function contentHash(value: string): Promise<string> {
  return sha256Hex(value);
}

/** Constant-time string comparison (avoids timing side channels on secrets). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}
