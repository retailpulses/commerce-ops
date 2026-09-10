import { bodyHash } from "./follow-ups";
import type {
  MercariRelayClient,
  RelayInquiry,
  RelayInquiryTarget,
  RelaySendResult,
} from "./mercari-relay";
import type { SupabaseClient } from "./supabase";

/**
 * Fresh single-thread Mercari read before serving operator-visible detail.
 *
 * This mirrors the worker ingestion contract (docs/phases/mercari-inquiry-api-redesign):
 * readback -> normalize identity/time/direction -> route -> idempotent canonical
 * persistence. The dashboard is read-only here: it never mutates Mercari, never
 * writes a new table, and reuses the canonical `inquiry_reconcile_api_thread`
 * RPC to project the fresh read. Order-target threads stay out of the inquiry
 * cohort and fail closed.
 */

export const MERCARI_SOURCE = "mercari_shops";
export const DEFAULT_MAX_THREAD_PAGES = 10;
export const DEFAULT_PAGE_SIZE = 50;

export type Route = "inquiry" | "ticketing" | "quarantine";
export interface RouteDecision { route: Route; reason?: string }

export type FreshReadErrorCode =
  | "relay_unavailable"
  | "readback_failed"
  | "pagination_exceeded"
  | "order_target"
  | "unroutable_target"
  | "reconcile_failed";

export class InquiryFreshReadError extends Error {
  constructor(
    readonly code: FreshReadErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InquiryFreshReadError";
  }
}

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

/** True when a row is API-canonical and eligible for a fresh Mercari read. */
export function isMercariApiInquiry(row: {
  source?: string | null;
  shop_key?: string | null;
  external_inquiry_id?: string | null;
}): boolean {
  return (
    row.source === MERCARI_SOURCE &&
    !!row.shop_key &&
    !!row.external_inquiry_id
  );
}

/**
 * Domain router: product/shop targets reconcile into the inquiry cohort;
 * order-target threads stay out of the presales portal (fail closed).
 */
export function routeInquiryTarget(
  target: RelayInquiryTarget | null | undefined,
): RouteDecision {
  const typename = target?.__typename ?? "";
  const hasOrderTransaction = target?.orderTransaction != null;

  if (typename === "InquiryOrderTransactionTarget" || hasOrderTransaction) {
    return { route: "ticketing", reason: "order_transaction_authority" };
  }

  if (typename === "InquiryProductTarget" || typename === "InquiryShopTarget") {
    return { route: "inquiry" };
  }

  return { route: "quarantine", reason: `unknown_target:${typename || "missing"}` };
}

/** Read a single inquiry plus fully paginated messages, bounded by `maxPages`. */
export async function readFullThread(
  relay: MercariRelayClient,
  shopKey: string,
  externalInquiryId: string,
  maxPages: number = DEFAULT_MAX_THREAD_PAGES,
): Promise<{ inquiry: RelayInquiry; messages: RelaySendResult[] }> {
  const inquiry = await relay.inquiry(shopKey, externalInquiryId);
  if (!inquiry) {
    throw new InquiryFreshReadError("readback_failed", "Mercari thread not found", 502);
  }

  const messages: RelaySendResult[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await relay.inquiryMessagesPage(shopKey, externalInquiryId, {
      first: DEFAULT_PAGE_SIZE,
      after,
    });
    messages.push(...res.messages);
    if (!res.pageInfo.hasNextPage) return { inquiry, messages };
    after = res.pageInfo.endCursor ?? null;
    if (!after) {
      throw new InquiryFreshReadError(
        "pagination_exceeded",
        "Mercari message pagination is malformed",
        502,
      );
    }
  }

  throw new InquiryFreshReadError(
    "pagination_exceeded",
    `Mercari message pagination exceeded ${maxPages} pages`,
    502,
  );
}

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

export interface ReconcileThreadResult {
  inquiryId: number;
  inquiryCreated: boolean;
  inquiryChanged: boolean;
  messagesCreated: number;
  messagesChanged: number;
  rowsWritten: number;
}

/** Normalize a fresh inquiry read into the canonical `inquiries` write shape. */
export async function mapInquiryToCanonical(
  inquiry: RelayInquiry,
  shopKey: string,
  latestBuyerMessage: RelaySendResult | null,
): Promise<CanonicalInquiryInput> {
  const target = inquiry.target;
  const firstOpenedAt = toIso(inquiry.firstOpenedAt ?? null);

  return {
    shop_key: shopKey,
    source: MERCARI_SOURCE,
    external_inquiry_id: inquiry.id,
    external_status: nullable(inquiry.status),
    external_sales_channel: nullable(inquiry.salesChannel),
    external_first_opened_at: firstOpenedAt,
    external_last_activity_at: toIso(inquiry.lastActivityAt ?? null),
    external_target_type: nullable(target?.__typename),
    external_product_id: nullable(target?.productId),
    external_product_variant_id: nullable(target?.productVariantId),
    external_order_transaction_id: nullable(target?.orderTransaction?.id),
    external_shop_id: nullable(target?.shopId),
    source_observed_at: new Date().toISOString(),
    source_payload: inquiry as unknown as Record<string, unknown>,
    inquiry_date: firstOpenedAt,
    inquiry_body: latestBuyerMessage?.body ?? null,
    customer_nickname: null,
    last_inbound_time: toIso(latestBuyerMessage?.sentAt ?? null),
    last_custom_message: latestBuyerMessage?.body ?? null,
  };
}

/** Normalize fresh message reads into the canonical `inquiry_messages` shape. */
export async function mapMessagesToCanonical(
  messages: RelaySendResult[],
  shopKey: string,
  externalInquiryId: string,
): Promise<CanonicalMessageInput[]> {
  const canonical: CanonicalMessageInput[] = [];
  for (const message of messages) {
    if (!message.messageId) continue;
    const body = message.body ?? null;
    const deleted = message.status === "DELETED";
    canonical.push({
      inquiry_id: 0, // resolved atomically by inquiry_reconcile_api_thread
      shop_key: shopKey,
      source: MERCARI_SOURCE,
      external_inquiry_id: externalInquiryId,
      external_message_id: message.messageId,
      external_from: nullable(message.from),
      direction: message.from === "BUYER" ? "inbound" : "outbound",
      body,
      sent_at: toIso(message.sentAt ?? null),
      external_status: nullable(message.status),
      deleted_at: deleted ? new Date().toISOString() : null,
      attachments_metadata: [],
      source_observed_at: new Date().toISOString(),
      source_payload_hash: await bodyHash(body ?? ""),
    });
  }
  return canonical;
}

export interface FreshReadDeps {
  relay: MercariRelayClient;
  supabase: Pick<SupabaseClient, "rpc">;
}

export interface FreshReadResult {
  route: "inquiry";
  inquiryId: number;
  rowsWritten: number;
}

/**
 * Fresh read + route + reconcile for a single Mercari inquiry.
 *
 * Order-target threads and unroutable threads fail closed; they never enter
 * the inquiry cohort. Failures surface as `InquiryFreshReadError` with a
 * non-secret message, never as stale data.
 */
export async function refreshMercariInquiry(
  deps: FreshReadDeps,
  shopKey: string,
  externalInquiryId: string,
  opts?: { maxPages?: number },
): Promise<FreshReadResult> {
  let inquiry: RelayInquiry;
  let messages: RelaySendResult[];
  try {
    const read = await readFullThread(
      deps.relay,
      shopKey,
      externalInquiryId,
      opts?.maxPages ?? DEFAULT_MAX_THREAD_PAGES,
    );
    inquiry = read.inquiry;
    messages = read.messages;
  } catch (err) {
    if (err instanceof InquiryFreshReadError) throw err;
    // Relay errors may carry platform detail; keep the client message generic.
    console.error("Mercari fresh read failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
    throw new InquiryFreshReadError(
      "readback_failed",
      "Mercari fresh read failed",
      502,
    );
  }

  const decision = routeInquiryTarget(inquiry.target);
  if (decision.route === "ticketing") {
    throw new InquiryFreshReadError(
      "order_target",
      "Order-target threads are not part of the inquiry portal",
      409,
    );
  }
  if (decision.route === "quarantine") {
    throw new InquiryFreshReadError(
      "unroutable_target",
      "This thread cannot be routed to the inquiry portal",
      409,
    );
  }

  const latestBuyerMessage =
    [...messages]
      .filter((message) => message.from === "BUYER" && message.status !== "DELETED")
      .sort((a, b) => `${a.sentAt ?? ""}:${a.messageId}`.localeCompare(`${b.sentAt ?? ""}:${b.messageId}`))
      .at(-1) ?? null;

  const canonicalInquiry = await mapInquiryToCanonical(
    inquiry,
    shopKey,
    latestBuyerMessage,
  );
  const canonicalMessages = await mapMessagesToCanonical(
    messages,
    shopKey,
    externalInquiryId,
  );

  let reconciled: ReconcileThreadResult;
  try {
    reconciled = await deps.supabase.rpc<ReconcileThreadResult>(
      "inquiry_reconcile_api_thread",
      { p_inquiry: canonicalInquiry, p_messages: canonicalMessages },
    );
  } catch (err) {
    console.error("Inquiry reconcile failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
    throw new InquiryFreshReadError(
      "reconcile_failed",
      "Inquiry reconciliation failed",
      502,
    );
  }

  return {
    route: "inquiry",
    inquiryId: reconciled.inquiryId,
    rowsWritten: reconciled.rowsWritten,
  };
}
