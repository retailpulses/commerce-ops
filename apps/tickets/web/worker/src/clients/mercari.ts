/** Mercari client — GraphQL via VPS HTTP proxy. */

import type { MercariGraphQLResponse, MercariMessage, MercariTransaction } from "../types";

const PROXY_URL = "https://mercari-proxy.homesbliss.net/graphql";
const MERCARI_API_SLEEP_MS = 600; // 0.6s between calls

/** Execute a GraphQL query/mutation against Mercari API via VPS proxy. */
export async function runGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<MercariGraphQLResponse> {
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, query, variables }),
  });

  const data: MercariGraphQLResponse = await resp.json();

  if (!resp.ok && resp.status !== 422) {
    // 422 = GraphQL app-level errors (returned in data.errors)
    throw new Error(
      `Mercari proxy error ${resp.status}: ${JSON.stringify(data.errors || "unknown")}`
    );
  }

  return data;
}

export interface DeepScanResult {
  transactions: MercariTransaction[];
  truncated: boolean;
  pagesScanned: number;
  oldestOrderDays: number | null; // age of oldest order found, in days
}

export function hasActionableLatestMessage(messages: MercariMessage[]): boolean {
  if (!messages.length) return false;
  const sorted = [...messages].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const lastMsg = sorted[sorted.length - 1];
  return lastMsg?.role === "BUYER" || (
    lastMsg?.role === "SELLER" &&
    isHoldingSellerMessage(lastMsg.message || "")
  );
}

/** Scan recent orders for unreplied buyer messages using cursor pagination.
 *  Returns truncation info so callers can detect when orders fall off the window. */
export async function getUnrepliedTransactions(
  token: string,
  maxPages = 10,
  maxAgeDays = 90,
  includeAllWithMessages = false
): Promise<DeepScanResult> {
  const query = `
    query orderTransactions($first: Int!, $after: String, $statuses: [OrderTransactionStatusFilter!]!) {
      orderTransactions(first: $first, after: $after, statuses: $statuses) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            status
            orderType
            createdAt
            products { productId variant { skuCode } purchasedQuantity }
            messages { id createdAt message role }
          }
        }
      }
    }
  `;

  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000);
  const unreplied: MercariTransaction[] = [];
  let cursor: string | null = null;
  let pagesScanned = 0;
  let hitAgeCutoff = false;
  let oldestOrderDays: number | null = null;

  for (let page = 0; page < maxPages; page++) {
    const variables: Record<string, unknown> = {
      first: 100,
      statuses: ["COMPLETED"],
    };
    if (cursor) variables.after = cursor;

    const resp = await runGraphQL(token, query, variables);
    const txData = resp.data?.orderTransactions as
      | { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: MercariTransaction }> }
      | undefined;

    if (!txData) break;
    pagesScanned++;

    for (const edge of txData.edges) {
      const node = edge.node;
      if (node.status === "CANCELED") continue;

      try {
        const createdAt = new Date(node.createdAt.replace("Z", "+00:00"));
        const ageDays = Math.round((Date.now() - createdAt.getTime()) / 86400_000);
        if (oldestOrderDays === null || ageDays > oldestOrderDays) {
          oldestOrderDays = ageDays;
        }
        if (createdAt < cutoff) {
          hitAgeCutoff = true;
          break;
        }
      } catch { /* keep going */ }

      const msgs = node.messages || [];
      if (!msgs.length) continue;

      const sorted = [...msgs].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

      if (includeAllWithMessages || hasActionableLatestMessage(sorted)) {
        unreplied.push(node);
      }
    }

    if (hitAgeCutoff || !txData.pageInfo.hasNextPage) break;
    cursor = txData.pageInfo.endCursor;
    await sleep(MERCARI_API_SLEEP_MS);
  }

  // Truncated = we scanned all maxPages and didn't hit the age cutoff or end of pages.
  // This means there are orders older than our scan window that we never examined.
  const truncated = pagesScanned >= maxPages && !hitAgeCutoff && !!(cursor);

  return { transactions: unreplied, truncated, pagesScanned, oldestOrderDays };
}

/** Fetch a single order transaction with messages (for backscan). */
export async function fetchOrderTransaction(
  token: string,
  transactionId: string
): Promise<MercariGraphQLResponse> {
  const query = `
    query orderTransaction($id: ID!) {
      orderTransaction(id: $id) {
        id status createdAt
        products { productId variant { skuCode } purchasedQuantity }
        messages { id createdAt message role }
      }
    }
  `;
  return runGraphQL(token, query, { id: transactionId });
}

/** Send a seller reply to a Mercari order transaction. */
export async function sendReply(
  token: string,
  transactionId: string,
  messageText: string,
  dryRun = false
): Promise<{ id: string; createdAt: string }> {
  if (dryRun) {
    return { id: "DRY_RUN", createdAt: new Date().toISOString().replace("+00:00", "Z") };
  }

  const mutation = `
    mutation addOrderTransactionMessage($input: AddOrderTransactionMessageInput!) {
      addOrderTransactionMessage(input: $input) {
        orderTransaction {
          id
          messages { id createdAt message role }
        }
      }
    }
  `;

  const resp = await runGraphQL(token, mutation, {
    input: { orderTransactionId: transactionId, message: messageText },
  });

  const tx = (resp.data?.addOrderTransactionMessage as { orderTransaction: { messages: MercariMessage[] } })
    ?.orderTransaction;
  if (!tx) throw new Error("No transaction in reply response");

  const sellerMsgs = tx.messages.filter((m) => m.role === "SELLER");
  const reply = sellerMsgs[sellerMsgs.length - 1];
  return { id: reply.id, createdAt: reply.createdAt };
}

const HOLDING_REPLY_MARKERS = [
  "内容を確認のうえ対応しております",
  "順次ご返信いたします",
  "今しばらくお待ちください",
  "確認結果につきましては",
  "1〜2営業日以内にご連絡",
  "お待ちしている状況",
  "まだご提出いただいていない場合",
];

export function isHoldingSellerMessage(message: string): boolean {
  return HOLDING_REPLY_MARKERS.some((marker) => message.includes(marker));
}

/** Check if a seller has replied after the most recent buyer message.
 *  Used as a defense-in-depth idempotency guard. Holding acknowledgements can
 *  be ignored for FUGUAI escalation because they do not resolve the case. */
export function hasSellerRepliedAfterLastBuyer(
  messages: MercariMessage[],
  options: { ignoreHoldingReplies?: boolean } = {}
): boolean {
  if (!messages.length) return false;

  const sorted = [...messages].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  let lastBuyerIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].role === "BUYER") {
      lastBuyerIdx = i;
      break;
    }
  }
  if (lastBuyerIdx === -1) return false;

  for (let i = lastBuyerIdx + 1; i < sorted.length; i++) {
    if (sorted[i].role === "SELLER") {
      if (options.ignoreHoldingReplies && isHoldingSellerMessage(sorted[i].message || "")) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
