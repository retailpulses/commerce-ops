import { eventIdentity, timingSafeEqual } from "./identity";
import type { MercariPersistence } from "./persistence";
import type { WebhookTopic } from "./types";
import { isWebhookTopic } from "./types";

/**
 * Mercari webhook intake.
 *
 * Order of operations is fixed: validate -> durable insert -> 2xx. The webhook
 * payload is a change notification only; enrichment/readback happens
 * asynchronously and must never delay (or fail) the durable receipt.
 *
 * Secret/signature/timestamp handling is config-driven and fail-closed: an
 * unverifiable request is rejected, never ingested.
 */

export interface WebhookConfig {
  /** Per-shop webhook secrets. Missing secret for a shop => reject. */
  webhookSecrets: Record<string, string>;
  /** Header that carries the shop key. */
  shopKeyHeader: string;
  /** Header that carries the hex HMAC signature. */
  signatureHeader: string;
  /** Replay window in seconds. */
  replayWindowSeconds: number;
  /** Proven Mercari endpoint-capability auth fallback (Bearer or ?secret=). */
  sharedSecret?: string;
  /** External Mercari shop_id -> canonical shop_key. */
  shopIdMap?: Record<string, string>;
}

export interface ParsedWebhook {
  shopKey: string;
  topic: WebhookTopic;
  externalEventId: string | null;
  externalInquiryId: string | null;
  externalMessageId: string | null;
  occurredAt: string | null;
  schemaVersion: string | null;
  raw: Record<string, unknown>;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function rawBodyText(request: Request): Promise<string> {
  return request.text();
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** HMAC-SHA256 verify of the raw body against the per-shop secret. */
export async function verifySignature(
  secret: string,
  signatureHeaderValue: string,
  body: string,
): Promise<boolean> {
  const match = signatureHeaderValue.match(/^sha256=([0-9a-fA-F]+)$/);
  if (!match) return false;
  const provided = hexToBytes(match[1]);
  if (!provided) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    provided.buffer as ArrayBuffer,
    new TextEncoder().encode(body).buffer as ArrayBuffer,
  );
  return verified;
}

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Parse a webhook body into a normalized, unverified notification shape. */
export function parseWebhookBody(
  body: Record<string, unknown>,
  shopKey: string,
): ParsedWebhook | { error: string } {
  const topic = readString(body.topic);
  if (!topic || !isWebhookTopic(topic)) {
    return { error: `unsupported or missing topic: ${topic ?? "none"}` };
  }
  const payload = (body.payload ?? body) as Record<string, unknown>;
  return {
    shopKey,
    topic,
    externalEventId: readString(body.eventId ?? body.event_id ?? body.id ?? payload.eventId ?? payload.event_id),
    externalInquiryId: readString(payload.inquiryId ?? payload.inquiry_id ?? body.inquiryId ?? body.inquiry_id),
    externalMessageId: readString(payload.messageId ?? payload.message_id ?? body.messageId ?? body.message_id),
    occurredAt: readString(payload.occurredAt ?? payload.created_at ?? body.occurredAt ?? body.created_at ?? body.timestamp),
    schemaVersion: readString(body.schemaVersion ?? body.schema_version ?? payload.schemaVersion ?? payload.schema_version),
    raw: body,
  };
}

function withinReplayWindow(occurredAt: string | null, windowSeconds: number, nowMs: number): boolean {
  if (!occurredAt) return true; // no timestamp; signature still gates, but do not hard-fail window
  const ms = Date.parse(occurredAt);
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms <= windowSeconds * 1000 && ms - nowMs <= windowSeconds * 1000;
}

export interface IngestWebhookResult {
  response: Response;
  duplicate: boolean;
}

/**
 * Validate and durably store a webhook notification.
 * Returns a 2xx when the event is new or a duplicate; a retryable 5xx when the
 * database could not persist; 4xx for unverifiable requests.
 */
export async function ingestWebhook(
  request: Request,
  config: WebhookConfig,
  persistence: MercariPersistence,
): Promise<IngestWebhookResult> {
  if (request.method !== "POST") {
    return { response: jsonError(405, "Method not allowed"), duplicate: false };
  }

  const rawBody = await rawBodyText(request);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { response: jsonError(400, "Invalid JSON body"), duplicate: false };
  }

  const externalShopId = readString(body.shop_id ?? body.shopId);
  const shopKey = request.headers.get(config.shopKeyHeader)?.trim()
    || (externalShopId ? config.shopIdMap?.[externalShopId] : undefined);
  if (!shopKey) return { response: jsonError(400, "Unknown or missing shop identity"), duplicate: false };

  const signature = request.headers.get(config.signatureHeader) ?? "";
  const hmacSecret = config.webhookSecrets[shopKey];
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const endpointSecret = new URL(request.url).searchParams.get("secret") ?? "";
  const sharedValid = Boolean(config.sharedSecret) &&
    (timingSafeEqual(bearer, config.sharedSecret!) || timingSafeEqual(endpointSecret, config.sharedSecret!));
  const signatureValid = Boolean(hmacSecret && signature) && await verifySignature(hmacSecret!, signature, rawBody);
  if (!sharedValid && !signatureValid) {
    return { response: jsonError(401, "Invalid webhook authentication"), duplicate: false };
  }

  const parsed = parseWebhookBody(body, shopKey);
  if ("error" in parsed) {
    return { response: jsonError(400, parsed.error), duplicate: false };
  }

  if (!parsed.externalInquiryId) {
    return { response: jsonError(400, "Missing inquiry identity"), duplicate: false };
  }
  if (!parsed.externalEventId && !parsed.occurredAt) {
    return { response: jsonError(400, "Missing stable event identity fields"), duplicate: false };
  }

  if (!withinReplayWindow(parsed.occurredAt, config.replayWindowSeconds, Date.now())) {
    return { response: jsonError(400, "Webhook timestamp outside replay window"), duplicate: false };
  }

  const identity = await eventIdentity({
    shopKey: parsed.shopKey,
    topic: parsed.topic,
    externalEventId: parsed.externalEventId,
    externalInquiryId: parsed.externalInquiryId,
    externalMessageId: parsed.externalMessageId,
    occurredAt: parsed.occurredAt,
    schemaVersion: parsed.schemaVersion,
  });

  try {
    const { duplicate } = await persistence.recordWebhookEvent({
      event_identity: identity,
      shop_key: parsed.shopKey,
      topic: parsed.topic,
      external_event_id: parsed.externalEventId,
      external_inquiry_id: parsed.externalInquiryId,
      external_message_id: parsed.externalMessageId,
      schema_version: parsed.schemaVersion,
      occurred_at: parsed.occurredAt
        ? (Number.isFinite(Date.parse(parsed.occurredAt))
          ? new Date(parsed.occurredAt).toISOString()
          : null)
        : null,
      received_at: new Date().toISOString(),
      delivery_source: "webhook",
      raw_payload: parsed.raw,
      processing_status: "pending",
      attempts: 0,
    });
    return {
      response: new Response(JSON.stringify({ ok: true, duplicate }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
      duplicate,
    };
  } catch (err) {
    // Durable insert failed — retryable for the platform redelivery.
    return {
      response: jsonError(503, "Webhook could not be durably persisted; retry"),
      duplicate: false,
    };
  }
}

export { timingSafeEqual };
