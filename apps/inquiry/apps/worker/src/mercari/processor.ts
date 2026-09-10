import { directionFor, mapInquiry, mapMessage } from "./mappers";
import type { MercariPersistence } from "./persistence";
import type { MercariTransport } from "./relay";
import { routeInquiryTarget } from "./router";
import type { MercariInquiry, MercariMessage, WebhookTopic } from "./types";

/**
 * Async processing contract shared by webhook, daily audit and backfill:
 *
 *   readback -> normalize identity/time/direction -> route -> idempotent
 *   canonical persistence -> classify/link dispatch (stub) -> finalize event
 *
 * The durable event is claimed first; a failed process marks the event failed
 * with exponential backoff rather than losing the notification.
 */

export interface ProcessorConfig {
  workerId: string;
  /** Canonical ingest write kill switch. */
  ingestWritesEnabled: boolean;
  /** Max retry delay for a failed event. */
  maxRetryDelayMs?: number;
  /** Max pages for a single thread readback. */
  maxThreadPages?: number;
}

export interface ProcessResult {
  claimed: boolean;
  paused?: boolean;
  eventId?: number;
  route?: string;
  recovered?: number;
  error?: string;
}

const DEFAULT_MAX_RETRY_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_MAX_THREAD_PAGES = 10;

function backoffDelay(attempts: number, maxMs: number): number {
  return Math.min(Math.pow(2, Math.max(attempts - 1, 0)) * 30_000, maxMs);
}

async function readFullThread(
  transport: MercariTransport,
  shopKey: string,
  inquiryId: string,
  maxPages: number,
): Promise<MercariMessage[]> {
  const messages: MercariMessage[] = [];
  let after: string | null = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await transport.inquiryMessages(shopKey, inquiryId, { first: 50, after });
    messages.push(...res.messages);
    if (!res.pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    after = res.pageInfo.endCursor ?? null;
    if (!after) throw new Error("message pagination returned hasNextPage without endCursor");
  }
  if (!complete) throw new Error(`message pagination exceeded ${maxPages} pages`);
  return messages;
}

export async function processNextEvent(
  config: ProcessorConfig,
  persistence: MercariPersistence,
  transport: MercariTransport,
): Promise<ProcessResult> {
  if (!config.ingestWritesEnabled) {
    return { claimed: false, paused: true };
  }

  const event = await persistence.claimWebhookEvent(config.workerId);
  if (!event) return { claimed: false };

  const maxThreadPages = config.maxThreadPages ?? DEFAULT_MAX_THREAD_PAGES;
  const maxRetry = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS;

  try {
    if (!event.external_inquiry_id) {
      // No thread identity to read back — quarantine, do not guess.
      await persistence.recordQuarantine({
        shop_key: event.shop_key,
        kind: "missing_inquiry_identity",
        event_identity: event.event_identity,
        reason: "webhook lacked external_inquiry_id",
        raw_payload: event.raw_payload,
      });
      await persistence.completeWebhookEvent(event.id, "completed");
      return { claimed: true, eventId: event.id, route: "quarantine" };
    }

    const inquiry: MercariInquiry | null = await transport.inquiry(
      event.shop_key,
      event.external_inquiry_id,
    );
    if (!inquiry) {
      await persistence.recordQuarantine({
        shop_key: event.shop_key,
        kind: "readback_missing",
        event_identity: event.event_identity,
        external_inquiry_id: event.external_inquiry_id,
        reason: "inquiry readback returned no thread",
        raw_payload: event.raw_payload,
      });
      await persistence.completeWebhookEvent(event.id, "completed");
      return { claimed: true, eventId: event.id, route: "quarantine" };
    }

    const messages = await readFullThread(
      transport,
      event.shop_key,
      event.external_inquiry_id,
      maxThreadPages,
    );

    const decision = routeInquiryTarget(inquiry.target, null);

    if (decision.route === "ticketing") {
      // Order-target: never project into the inquiry cohort. Record evidence
      // and hand off to the ticketing contract (bounded stub).
      await persistence.recordQuarantine({
        shop_key: event.shop_key,
        kind: "ticket_route",
        event_identity: event.event_identity,
        external_inquiry_id: event.external_inquiry_id,
        reason: decision.reason ?? "order_transaction_authority",
        raw_payload: event.raw_payload,
      });
      await persistence.completeWebhookEvent(event.id, "completed");
      return { claimed: true, eventId: event.id, route: "ticketing" };
    }

    if (decision.route === "quarantine") {
      await persistence.recordQuarantine({
        shop_key: event.shop_key,
        kind: "unroutable",
        event_identity: event.event_identity,
        external_inquiry_id: event.external_inquiry_id,
        reason: decision.reason ?? "unroutable_target",
        raw_payload: event.raw_payload,
      });
      await persistence.completeWebhookEvent(event.id, "completed");
      return { claimed: true, eventId: event.id, route: "quarantine" };
    }

    // Presales inquiry cohort.
    const latestBuyerMessage = [...messages]
      .filter((message) => message.from === "BUYER" && message.status !== "DELETED")
      .sort((a, b) => `${a.sentAt ?? ""}:${a.id}`.localeCompare(`${b.sentAt ?? ""}:${b.id}`))
      .at(-1) ?? null;
    const canonicalInquiry = await mapInquiry(
      inquiry,
      event.shop_key,
      "webhook",
      null,
      latestBuyerMessage,
    );
    const canonicalMessages = [];
    for (const message of messages) {
      const canonical = await mapMessage(
        message,
        0, // resolved atomically by inquiry_reconcile_api_thread
        event.shop_key,
        event.external_inquiry_id,
        "webhook",
      );
      if (!canonical) continue;
      canonicalMessages.push(canonical);
    }

    const reconciled = await persistence.reconcileApiThread(canonicalInquiry, canonicalMessages);
    const inquiryId = reconciled.inquiryId;
    const recovered = reconciled.rowsWritten;

    const latestActive = [...messages]
      .filter((message) => message.status !== "DELETED")
      .sort((a, b) => `${a.sentAt ?? ""}:${a.id}`.localeCompare(`${b.sentAt ?? ""}:${b.id}`))
      .at(-1);
    await persistence.applyPlatformTransition(inquiryId, event.topic, latestActive?.from ?? null);

    // Admin-delete: the deleted message is typically absent from readback, so
    // tombstone the specific external message id from the notification.
    if ((event.topic as WebhookTopic) === "INQUIRY_MESSAGE_ADMIN_DELETED" && event.external_message_id) {
      await persistence.tombstoneMessage(event.shop_key, event.external_message_id);
    }

    await persistence.completeWebhookEvent(event.id, "completed");
    return {
      claimed: true,
      eventId: event.id,
      route: "inquiry",
      recovered,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = event.attempts + 1;
    await persistence.completeWebhookEvent(event.id, "failed", {
      error: message,
      nextRetryAt: new Date(Date.now() + backoffDelay(attempts, maxRetry)).toISOString(),
    });
    return { claimed: true, eventId: event.id, error: message };
  }
}

export { directionFor };
