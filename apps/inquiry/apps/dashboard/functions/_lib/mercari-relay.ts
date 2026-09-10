import type { DashboardConfig } from "./config";

export interface RelaySendResult { messageId: string; body: string | null; sentAt: string | null; from: string | null; status: string | null }
export class RelayUnavailableError extends Error { constructor(message: string) { super(message); this.name = "RelayUnavailableError"; } }
export class RelayError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = "RelayError"; }
}

/** Single-thread inquiry readback (fresh read before serving detail). */
export interface RelayInquiryTarget {
  __typename: string | null;
  productId: string | null;
  productVariantId: string | null;
  shopId: string | null;
  orderTransaction: { id: string | null } | null;
}

export interface RelayInquiry {
  id: string;
  status: string | null;
  salesChannel: string | null;
  firstOpenedAt: string | null;
  lastActivityAt: string | null;
  userInfo: { nickname: string | null } | null;
  target: RelayInquiryTarget | null;
}

export interface RelayPageInfo { hasNextPage: boolean; endCursor: string | null }
export interface RelayMessagePage { messages: RelaySendResult[]; pageInfo: RelayPageInfo }

export interface MercariRelayClient {
  inquiry(shopKey: string, inquiryId: string): Promise<RelayInquiry | null>;
  inquiryMessages(shopKey: string, inquiryId: string): Promise<RelaySendResult[]>;
  inquiryMessagesPage(shopKey: string, inquiryId: string, opts: { first?: number; after?: string | null }): Promise<RelayMessagePage>;
  addInquiryMessage(shopKey: string, input: { inquiryId: string; body: string; idempotencyKey: string }): Promise<RelaySendResult>;
}

const INQUIRY_FIELDS = `id status salesChannel firstOpenedAt lastActivityAt target {
  __typename
  ... on InquiryProductTarget { productId productVariantId }
  ... on InquiryShopTarget { shopId }
  ... on InquiryOrderTransactionTarget { orderTransaction { id } }
} userInfo { nickname }`;
const MESSAGE_FIELDS = `id inquiryId body from sentAt status`;

interface MessageNode { id?: string; body?: string; sentAt?: string; from?: string; status?: string }
interface PageInfoNode { hasNextPage?: boolean; endCursor?: string | null }

function normalizeTarget(target: unknown): RelayInquiryTarget | null {
  if (target === null || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  const orderTransaction =
    t.orderTransaction !== null && typeof t.orderTransaction === "object"
      ? (t.orderTransaction as Record<string, unknown>)
      : null;
  return {
    __typename: typeof t.__typename === "string" ? t.__typename : null,
    productId: typeof t.productId === "string" ? t.productId : null,
    productVariantId: typeof t.productVariantId === "string" ? t.productVariantId : null,
    shopId: typeof t.shopId === "string" ? t.shopId : null,
    orderTransaction: orderTransaction
      ? { id: typeof orderTransaction.id === "string" ? orderTransaction.id : null }
      : null,
  };
}

function normalizeInquiry(value: unknown): RelayInquiry | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return null;
  const userInfo =
    v.userInfo !== null && typeof v.userInfo === "object"
      ? (v.userInfo as Record<string, unknown>)
      : null;
  return {
    id: v.id,
    status: typeof v.status === "string" ? v.status : null,
    salesChannel: typeof v.salesChannel === "string" ? v.salesChannel : null,
    firstOpenedAt: typeof v.firstOpenedAt === "string" ? v.firstOpenedAt : null,
    lastActivityAt: typeof v.lastActivityAt === "string" ? v.lastActivityAt : null,
    userInfo: userInfo
      ? { nickname: typeof userInfo.nickname === "string" ? userInfo.nickname : null }
      : null,
    target: normalizeTarget(v.target),
  };
}

function mapMessages(value: unknown): { messages: RelaySendResult[]; pageInfo: RelayPageInfo } {
  const data = (value ?? {}) as { edges?: Array<{ node?: MessageNode }>; pageInfo?: PageInfoNode };
  const messages = (Array.isArray(data.edges) ? data.edges : [])
    .flatMap((edge) =>
      edge?.node?.id
        ? [{
            messageId: edge.node.id,
            body: edge.node.body ?? null,
            sentAt: edge.node.sentAt ?? null,
            from: edge.node.from ?? null,
            status: edge.node.status ?? null,
          }]
        : [],
    );
  return {
    messages,
    pageInfo: {
      hasNextPage: data.pageInfo?.hasNextPage === true,
      endCursor: data.pageInfo?.endCursor ?? null,
    },
  };
}

export function createMercariRelayClient(config: DashboardConfig): MercariRelayClient {
  const baseUrl = config.mercariRelay.url;
  async function run(shopKey: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = config.mercariRelay.shopTokens[shopKey as keyof typeof config.mercariRelay.shopTokens];
    if (!baseUrl || !token) throw new RelayUnavailableError(`Mercari transport unavailable for ${shopKey}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, query, variables }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
      if (!response.ok || payload.errors?.length) {
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || "unknown error";
        throw new RelayError(`Mercari GraphQL failed (${response.status}): ${detail}`, retryable);
      }
      return payload.data ?? {};
    } finally { clearTimeout(timer); }
  }

  async function inquiryMessagesPage(
    shopKey: string,
    inquiryId: string,
    opts: { first?: number; after?: string | null },
  ): Promise<RelayMessagePage> {
    const data = await run(shopKey, `query InquiryAutomationMessages($inquiryId: ID!, $first: Int, $after: String) {
      inquiryMessages(inquiryId: $inquiryId, first: $first, after: $after) {
        edges { node { ${MESSAGE_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { inquiryId, first: opts.first ?? 50, after: opts.after ?? null });
    return mapMessages(data.inquiryMessages);
  }

  return {
    async inquiry(shopKey, inquiryId) {
      const data = await run(shopKey, `query InquiryAutomationDetail($id: ID!) {
        inquiry(id: $id) { ${INQUIRY_FIELDS} }
      }`, { id: inquiryId });
      return normalizeInquiry(data.inquiry);
    },
    async inquiryMessages(shopKey, inquiryId) {
      const page = await inquiryMessagesPage(shopKey, inquiryId, { first: 100 });
      return page.messages;
    },
    inquiryMessagesPage,
    async addInquiryMessage(shopKey, input) {
      const data = await run(shopKey, `mutation InquiryOperatorSend($input: AddInquiryMessageInput!) {
        addInquiryMessage(input: $input) { inquiryMessage { ${MESSAGE_FIELDS} } }
      }`, { input });
      const payload = data.addInquiryMessage as { inquiryMessage?: { id?: string; body?: string; sentAt?: string; from?: string; status?: string } } | undefined;
      const message = payload?.inquiryMessage;
      if (!message?.id) throw new RelayError("addInquiryMessage returned no authoritative message", false);
      return { messageId: message.id, body: message.body ?? null, sentAt: message.sentAt ?? null, from: message.from ?? null, status: message.status ?? null };
    },
  };
}
