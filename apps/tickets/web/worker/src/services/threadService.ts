/** Thread service — merges platform (Mercari) thread messages with
 *  Supabase ticket_messages for display in the composer.
 *
 *  Token resolution is done by the handler; this service is platform-agnostic.
 */

import type { TicketRepository, PlatformThreadMessage } from "../repositories/ticketRepository";
import type { TicketDetail } from "../repositories/ticketRepository";
import { fetchOrderTransaction } from "../clients/mercari";

/** Merged message entry for UI display. */
export interface MergedMessage {
  id: string;
  source: "platform" | "supabase";
  role: string; // "BUYER" | "SELLER" | "operator" | "system" | "automation"
  body: string;
  sentAt: string;
  displayName?: string;
  externalMessageId?: string;
}

export interface ThreadResult {
  messages: MergedMessage[];
  /** Timestamp of the latest buyer message in the thread (for freshness check) */
  latestBuyerMessageAt: string | null;
  latestBuyerMessageId: string | null;
  /** Error message if platform fetch failed */
  fetchError?: string;
}

export interface ThreadFetchOptions {
  /** Pre-resolved Mercari API token. If omitted, platform fetch is skipped. */
  mercariToken?: string;
}

export function mergeThreadMessages(
  platformMessages: PlatformThreadMessage[],
  storedMessages: TicketDetail["messages"],
): MergedMessage[] {
  const supabaseMessages = storedMessages ?? [];
  const storedByExternalId = new Map(
    supabaseMessages
      .filter((message) => message.external_message_id)
      .map((message) => [message.external_message_id!, message]),
  );

  const merged: MergedMessage[] = platformMessages.map((platformMessage) => {
    const storedMessage =
      platformMessage.role === "SELLER"
        ? storedByExternalId.get(platformMessage.id)
        : undefined;

    return {
      id: platformMessage.id,
      source: "platform",
      role: storedMessage?.sender_type ?? platformMessage.role,
      body: platformMessage.body,
      sentAt: platformMessage.sentAt,
      displayName: storedMessage?.sender_display_name ?? undefined,
      externalMessageId: storedMessage?.external_message_id ?? platformMessage.id,
    };
  });

  const platformIds = new Set(platformMessages.map((message) => message.id));
  for (const storedMessage of supabaseMessages) {
    if (
      storedMessage.external_message_id &&
      platformIds.has(storedMessage.external_message_id)
    ) {
      continue;
    }
    merged.push({
      id: storedMessage.id,
      source: "supabase",
      role: storedMessage.sender_type,
      body: storedMessage.body,
      sentAt: storedMessage.sent_at ?? storedMessage.created_at,
      displayName: storedMessage.sender_display_name ?? undefined,
      externalMessageId: storedMessage.external_message_id ?? undefined,
    });
  }

  return merged.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export class ThreadService {
  constructor(private ticketRepo: TicketRepository) {}

  /** Merge platform thread + Supabase messages into a unified timeline. */
  async getMergedThread(
    ticket: TicketDetail,
    opts: ThreadFetchOptions = {},
  ): Promise<ThreadResult> {
    const platformMessages: PlatformThreadMessage[] = [];
    let fetchError: string | undefined;

    // Try to fetch platform thread if ticket has external_order_id + is Mercari + has token
    if (ticket.external_order_id && ticket.platform === "mercari" && opts.mercariToken) {
      try {
        const txId = normalizeOrderTxId(ticket.external_order_id);
        if (txId) {
          const txResp = await fetchOrderTransaction(opts.mercariToken, txId);
          const tx = txResp.data?.orderTransaction as {
            messages?: Array<{
              id: string;
              createdAt: string;
              message: string;
              role: string;
            }>;
          } | undefined;

          if (tx?.messages) {
            for (const m of tx.messages) {
              platformMessages.push({
                id: m.id,
                body: m.message || "",
                role: m.role as "BUYER" | "SELLER",
                sentAt: m.createdAt || "",
              });
            }
          }
        }
      } catch (e) {
        console.error(`Failed to fetch platform thread: ${e}`);
        fetchError = "Could not load Mercari thread. Showing manual messages only.";
      }
    }

    const merged = mergeThreadMessages(platformMessages, ticket.messages);

    // Find latest buyer message timestamp
    let latestBuyerMessageAt: string | null = null;
    let latestBuyerMessageId: string | null = null;
    for (const m of merged) {
      if (m.role === "BUYER" || m.role === "customer") {
        if (!latestBuyerMessageAt || m.sentAt > latestBuyerMessageAt) {
          latestBuyerMessageAt = m.sentAt;
          latestBuyerMessageId = m.externalMessageId ?? null;
        }
      }
    }

    return { messages: merged, latestBuyerMessageAt, latestBuyerMessageId, fetchError };
  }
}

/** Normalize an order ID to a Mercari transaction ID format. */
function normalizeOrderTxId(orderId: string): string | null {
  const trimmed = orderId.trim();
  if (!trimmed) return null;
  // Mercari transaction IDs start with "m"
  if (/^m\d+$/i.test(trimmed)) return trimmed;
  // If it's a URL, try extracting
  if (trimmed.includes("order_transaction")) {
    const match = trimmed.match(/order_transaction\/([^/?]+)/);
    if (match) return match[1];
  }
  // If it's a numeric ID, prepend "m"
  if (/^\d+$/.test(trimmed)) return `m${trimmed}`;
  return trimmed;
}
