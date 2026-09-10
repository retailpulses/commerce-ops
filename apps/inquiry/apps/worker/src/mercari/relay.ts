import type { MercariInquiry, MercariMessage } from "./types";

/** Stateless fixed-egress GraphQL transport already used by Ticket Management. */
export interface MercariRelayConfig {
  url?: string;
  shopTokens: Record<string, string | undefined>;
}

export interface PageInfo { hasNextPage: boolean; endCursor?: string | null }

export interface MercariTransport {
  inquiries(shopKey: string, opts: { first?: number; after?: string | null }): Promise<{ inquiries: MercariInquiry[]; pageInfo: PageInfo }>;
  inquiry(shopKey: string, inquiryId: string): Promise<MercariInquiry | null>;
  inquiryMessages(shopKey: string, inquiryId: string, opts: { first?: number; after?: string | null }): Promise<{ messages: MercariMessage[]; pageInfo: PageInfo }>;
  addInquiryMessage(shopKey: string, input: { inquiryId: string; body: string; idempotencyKey: string }): Promise<MercariMessage>;
}

export class MercariRelayError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "MercariRelayError";
  }
}

const RELAY_TIMEOUT_MS = 30_000;
const INQUIRY_FIELDS = `id status salesChannel firstOpenedAt lastActivityAt target {
  __typename
  ... on InquiryProductTarget { productId productVariantId }
  ... on InquiryShopTarget { shopId }
  ... on InquiryOrderTransactionTarget { orderTransaction { id status } }
}`;
const MESSAGE_FIELDS = `id inquiryId body from sentAt status attachments { __typename }`;

async function runGraphQL(config: MercariRelayConfig, shopKey: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = config.shopTokens[shopKey];
  if (!config.url || !token) throw new MercariRelayError(`Mercari transport unavailable for ${shopKey}`, false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, query, variables }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
    if (!response.ok || payload.errors?.length) {
      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || "unknown error";
      throw new MercariRelayError(`Mercari GraphQL failed (${response.status}): ${detail}`, retryable, response.status);
    }
    return payload.data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

type Connection<T> = { edges?: Array<{ node: T }>; pageInfo?: PageInfo };
function connection<T>(value: unknown): { nodes: T[]; pageInfo: PageInfo } {
  const data = (value ?? {}) as Connection<T>;
  return {
    nodes: Array.isArray(data.edges) ? data.edges.map((edge) => edge.node).filter(Boolean) : [],
    pageInfo: { hasNextPage: data.pageInfo?.hasNextPage === true, endCursor: data.pageInfo?.endCursor ?? null },
  };
}

export function createMercariRelay(config: MercariRelayConfig): MercariTransport {
  return {
    async inquiries(shopKey, opts) {
      const data = await runGraphQL(config, shopKey, `query InquiryAutomationList($first: Int, $after: String) {
        inquiries(first: $first, after: $after) { edges { node { ${INQUIRY_FIELDS} } } pageInfo { hasNextPage endCursor } }
      }`, { first: opts.first ?? 50, after: opts.after ?? null });
      const parsed = connection<MercariInquiry>(data.inquiries);
      return { inquiries: parsed.nodes, pageInfo: parsed.pageInfo };
    },
    async inquiry(shopKey, inquiryId) {
      const data = await runGraphQL(config, shopKey, `query InquiryAutomationDetail($id: ID!) { inquiry(id: $id) { ${INQUIRY_FIELDS} } }`, { id: inquiryId });
      return data.inquiry && typeof data.inquiry === "object" ? data.inquiry as MercariInquiry : null;
    },
    async inquiryMessages(shopKey, inquiryId, opts) {
      const data = await runGraphQL(config, shopKey, `query InquiryAutomationMessages($inquiryId: ID!, $first: Int, $after: String) {
        inquiryMessages(inquiryId: $inquiryId, first: $first, after: $after) { edges { node { ${MESSAGE_FIELDS} } } pageInfo { hasNextPage endCursor } }
      }`, { inquiryId, first: opts.first ?? 50, after: opts.after ?? null });
      const parsed = connection<MercariMessage>(data.inquiryMessages);
      return { messages: parsed.nodes, pageInfo: parsed.pageInfo };
    },
    async addInquiryMessage(shopKey, input) {
      const data = await runGraphQL(config, shopKey, `mutation InquiryAutomationSend($input: AddInquiryMessageInput!) {
        addInquiryMessage(input: $input) { inquiryMessage { ${MESSAGE_FIELDS} } }
      }`, { input });
      const result = data.addInquiryMessage as { inquiryMessage?: MercariMessage } | undefined;
      if (!result?.inquiryMessage?.id) throw new MercariRelayError("addInquiryMessage returned no authoritative message", false);
      return result.inquiryMessage;
    },
  };
}
