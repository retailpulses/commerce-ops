/**
 * Supabase PostgREST client (server-side only).
 *
 * All Supabase access happens server-side in Pages Functions using the
 * service_role key. The key is NEVER exposed to the browser.
 *
 * Uses direct fetch() against the Supabase REST API (PostgREST).
 * Query views for reads and the inquiries table for writes.
 *
 * All external calls must be mocked in tests.
 */

import type { DashboardConfig } from "./config";
import {
  needsCatalogFallback,
  resolveInquiryValues,
  selectPrimaryProductId,
  type ResolvedInquiryValues,
} from "./inquiry-value";
import { getProductPricing, type ProductPricing } from "./product-pricing";

const INQUIRY_LIST_BATCH_SIZE = 100;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function inquiryDayJst(value: string | null): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function compareRankedInquiries(
  a: InquiryListRow,
  aExpectedValue: number | null,
  b: InquiryListRow,
  bExpectedValue: number | null,
): number {
  const dayComparison = inquiryDayJst(b.inquiry_date).localeCompare(
    inquiryDayJst(a.inquiry_date),
  );
  if (dayComparison !== 0) return dayComparison;

  if (aExpectedValue === null && bExpectedValue !== null) return 1;
  if (aExpectedValue !== null && bExpectedValue === null) return -1;
  if (aExpectedValue !== null && bExpectedValue !== null) {
    const valueComparison = bExpectedValue - aExpectedValue;
    if (valueComparison !== 0) return valueComparison;
  }

  const timestampA = Date.parse(a.inquiry_date || "");
  const timestampB = Date.parse(b.inquiry_date || "");
  const safeTimestampA = Number.isFinite(timestampA) ? timestampA : -Infinity;
  const safeTimestampB = Number.isFinite(timestampB) ? timestampB : -Infinity;
  if (safeTimestampA !== safeTimestampB) return safeTimestampB - safeTimestampA;
  return b.id - a.id;
}

// -- Response shapes from views -------------------------------------------

/** Row shape returned by inquiry_list_vw. */
export interface InquiryListRow {
  id: number;
  status: string | null;
  automation_status: string | null;
  follow_up_status: string | null;
  inquiry_type: string | null;
  customer_nickname: string | null;
  product_name_snapshot: string | null;
  inquiry_date: string | null;
  url: string | null;
  shop_key: string | null;
  units: number | null;
  effective_price_excl_shipping: number | null;
  effective_price_incl_shipping: number | null;
  effective_tcogs: number | null;
  expected_value: number | null;
  sender_email: string | null;
  receiving_email: string | null;
  last_inbound_time: string | null;
  deleted_at: string | null;
  has_draft: boolean;
  has_copywrite: boolean;
  has_product: boolean;
  created_at: string;
  updated_at: string;
}

/** Row shape returned by inquiry_product_links (junction table). */
export interface InquiryProductLinkRow {
  id: number;
  inquiry_id: number;
  product_variant_id: string | null;
  is_primary: boolean;
  linked_at: string;
}

/** Row shape returned by inquiry_detail_vw. */
export interface InquiryDetailRow {
  id: number;
  legacy_mercari_inquiries_id: number | null;
  source: string | null;
  external_inquiry_id: string | null;
  external_thread_id: string | null;
  url: string | null;
  shop_key: string | null;
  platform_account_id: string | null;
  status: string | null;
  automation_status: string | null;
  follow_up_status: string | null;
  inquiry_type: string | null;
  deleted_at: string | null;
  inquiry_date: string | null;
  inquiry_body: string | null;
  customer_nickname: string | null;
  product_name_snapshot: string | null;
  sender_email: string | null;
  receiving_email: string | null;
  last_inbound_time: string | null;
  last_custom_message: string | null;
  message_log_raw: string | null;
  order_id: string | null;
  seller: string | null;
  draft_reply: string | null;
  reply_strategy: string | null;
  inquiry_skill_reply: string | null;
  reply_drafted_at: string | null;
  ai_copywritten_reply: string | null;
  ai_copywritten_at: string | null;
  reply_assist_status: string | null;
  reply_assist_request_id: string | null;
  reply_assist_last_result: string | null;
  mercari_product_id: string | null;
  mercari_variant_name: string | null;
  units: number | null;
  effective_price_excl_shipping: number | null;
  effective_price_incl_shipping: number | null;
  effective_tcogs: number | null;
  expected_value: number | null;
  follow_up_sent_at: string | null;
  notes: string | null;
  product_links_reviewed_at: string | null;
  linked_products: LinkedProductRow[];
  linked_knowledge: LinkedKnowledgeRow[];
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Shape of items in inquiry_detail_vw.linked_products JSONB array. */
export interface LinkedProductRow {
  id: string | null;
  linkRowId: number | null;
  itemCode: string | null;
  productName: string | null;
  isPrimary: boolean;
  linkSource: string | null;
  confidence: number | null;
}

/** Shape of items in inquiry_detail_vw.linked_knowledge JSONB array. */
export interface LinkedKnowledgeRow {
  id: number;
  title: string | null;
  tag: string | null;
}

/** Product row from the product catalog. */
export interface ProductCatalogRow {
  id: string;
  item_code: string | null;
  variant_name: string | null;
  /** Canonical GigaB2B sellerInfo fields synced from the price endpoint. */
  store_name?: string | null;
  store_code?: string | null;
  seller_type?: string | null;
  giga_index?: string | number | null;
  /** Legacy compatibility only. Never use this as supplier inventory. */
  stock_qty?: number | null;
  raw_payload?: Record<string, unknown> | null;
  product_commercials?: {
    source_available_qty: number | string | null;
    owned_qty: number | string | null;
    restock_date: string | null;
    last_sync_success_at: string | null;
  } | null;
  product_platform_links?: Array<{
    shop_code: string | null;
    platform: string;
    platform_listing_skus:
      | { stock_qty: number | string | null }
      | Array<{ stock_qty: number | string | null }>
      | null;
  }>;
  [key: string]: unknown;
}

/** List inquiry filter parameters. */
export interface ListInquiryParams {
  status?: string;
  search?: string;
  shop?: string;
  inquiryType?: string;
  pageSize?: number;
  cursor?: number; // for keyset pagination: "after id"
  minExpectedValue?: number;
  maxExpectedValue?: number;
}

// -- Client ---------------------------------------------------------------

/** Standard error wrapper for Supabase API calls. */
export class SupabaseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

export interface SupabaseClient {
  listInquiries(
    params: ListInquiryParams,
  ): Promise<{
    data: InquiryListRow[];
    totalCount: number | null;
    hasMore: boolean;
    nextCursor: number | null;
  }>;

  getInquiryDetail(id: number): Promise<InquiryDetailRow | null>;

  updateInquiry(
    id: number,
    data: Record<string, unknown>,
  ): Promise<void>;

  /** Generic PostgREST RPC caller. */
  rpc<T>(fnName: string, params: Record<string, unknown>): Promise<T>;

  /** Atomic RPC: demote existing primaries, upsert operator link, set review marker. */
  operatorSetPrimaryLink(params: {
    inquiryId: number;
    productVariantId: string;
    itemCodeSnapshot: string;
    productNameSnapshot: string;
  }): Promise<void>;

  /** Atomic RPC: delete link row, promote next primary if needed, set review marker. */
  operatorUnlinkProduct(inquiryId: number, linkId: number): Promise<void>;

  /** Legacy: source-agnostic delete by variant ID (retained for backward compat). */
  deleteProductLink(
    inquiryId: number,
    productVariantId: string,
  ): Promise<void>;

  searchProducts(
    query: string,
    pageSize?: number,
    shopKey?: string | null,
  ): Promise<{
    data: ProductCatalogRow[];
    hasMore: boolean;
  }>;

  lookupProduct(
    variantId: string,
    shopKey?: string | null,
  ): Promise<ProductCatalogRow | null>;
}

/**
 * Create a Supabase PostgREST client bound to the given config.
 * All methods use the service_role key for full access.
 */
export function createSupabaseClient(
  config: DashboardConfig,
): SupabaseClient {
  const { url, restUrl, serviceRoleKey } = config.supabase;
  const catalogTable = config.productCatalog.table;
  const restBaseUrl = restUrl
    ? restUrl.replace(/\/$/, "")
    : `${url.replace(/\/$/, "")}/rest/v1`;

  const headers: Record<string, string> = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    // Ask PostgREST to return the total count in the response headers
    Prefer: "count=exact",
  };

  /** Base fetch wrapper against the Supabase REST API. */
  async function apiFetch<T>(
    path: string,
    options?: { init?: RequestInit; timeoutMs?: number },
  ): Promise<{ data: T; count: number | null }> {
    const restPath = path.replace(/^\/rest\/v1/, "");
    const fullUrl = `${restBaseUrl}${restPath}`;
    const timeoutMs = options?.timeoutMs ?? 15_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(fullUrl, {
        ...options?.init,
        headers: { ...headers, ...options?.init?.headers },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const detail = extractPostgrestError(body);
        throw new SupabaseError(
          `Supabase request failed (${res.status}): ${detail}`,
          res.status,
        );
      }

      // Parse total count from Content-Range if available
      let count: number | null = null;
      const contentRange = res.headers.get("content-range");
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) count = parseInt(match[1], 10);
      }

      // Handle 204 No Content (common for PATCH, DELETE responses)
      if (res.status === 204 || res.headers.get("content-length") === "0") {
        return { data: undefined as unknown as T, count };
      }

      // Try to parse JSON body; gracefully return empty for empty responses
      const text = await res.text();
      if (!text) {
        return { data: undefined as unknown as T, count };
      }
      const data = JSON.parse(text) as T;
      return { data, count };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Escape a value for ILIKE: wrap in wildcards and escape PostgREST
   * special characters (%, _, *).
   */
  function escapeLike(val: string): string {
    return val
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_")
      .replace(/\*/g, "\\*");
  }

  /** Bulk-fetch product links for a set of inquiry IDs (single PostgREST call). */
  async function fetchProductLinks(
    inquiryIds: number[],
  ): Promise<InquiryProductLinkRow[]> {
    const qs = new URLSearchParams();
    qs.set("select", "id,inquiry_id,product_variant_id,is_primary,linked_at");
    qs.set("inquiry_id", `in.(${inquiryIds.join(",")})`);
    qs.set("order", "is_primary.desc,linked_at.asc,id.asc");

    const { data } = await apiFetch<InquiryProductLinkRow[]>(
      `/rest/v1/inquiry_product_links?${qs.toString()}`,
    );
    return data ?? [];
  }

  /** Bulk-fetch product catalog rows by variant ID (single PostgREST call). */
  async function fetchProductsByIds(
    variantIds: string[],
  ): Promise<ProductCatalogRow[]> {
    const qs = new URLSearchParams();
    qs.set("select", "id,item_code,variant_name,raw_payload");
    qs.set("id", `in.(${variantIds.join(",")})`);

    const { data } = await apiFetch<ProductCatalogRow[]>(
      `/rest/v1/${catalogTable}?${qs.toString()}`,
    );
    return data ?? [];
  }

  return {
    /**
     * Call a PostgREST RPC function.
     * POST /rest/v1/rpc/<fnName> with JSON body.
     */
    async rpc<T>(fnName: string, params: Record<string, unknown>): Promise<T> {
      const { data } = await apiFetch<T>(`/rest/v1/rpc/${fnName}`, {
        init: {
          method: "POST",
          body: JSON.stringify(params),
        },
      });
      return data;
    },

    async listInquiries(params) {
      const pageSize = params.pageSize ?? 20;
      const currentOffset = params.cursor ?? 0;
      const minExpectedValue = params.minExpectedValue;
      const maxExpectedValue = params.maxExpectedValue;
      const rangeActive =
        minExpectedValue !== undefined || maxExpectedValue !== undefined;

      // Build PostgREST query parameters
      const qs = new URLSearchParams();

      // PostgREST first groups rows chronologically. Fetch through the JST day
      // that contains the requested page so value ranking remains correct even
      // when one day's inquiries cross a pagination boundary.
      qs.set("order", "inquiry_date.desc.nullslast,id.desc");

      // Status filter
      if (params.status && params.status !== "_all") {
        qs.set("status", `eq.${params.status}`);
      }

      // Shop filter
      if (params.shop && params.shop !== "_all") {
        qs.set("shop_key", `eq.${params.shop}`);
      }

      // Inquiry type filter
      if (params.inquiryType && params.inquiryType !== "_all") {
        qs.set("inquiry_type", `eq.${params.inquiryType}`);
      }

      // Search: ILIKE across customer_nickname and product_name_snapshot
      if (params.search && params.search.trim()) {
        const term = params.search.trim();
        const escaped = escapeLike(term);
        qs.set(
          "or",
          `(customer_nickname.ilike.*${escaped}*,product_name_snapshot.ilike.*${escaped}*)`,
        );
      }

      const requiredMatches = currentOffset + pageSize + 1;
      const allRows: InquiryListRow[] = [];
      const resolvedValues = new Map<number, ResolvedInquiryValues>();
      let rawOffset = 0;
      let totalCount: number | null = null;

      /**
       * Resolve effective values for any accumulated rows not yet hydrated.
       * Rows with persisted values resolve with no extra calls; rows needing a
       * catalog fallback are hydrated with one bulk link fetch and one bulk
       * product fetch (never per-inquiry or per-product).
       */
      async function hydrateNewRows() {
        const candidateIds: number[] = [];
        for (const row of allRows) {
          if (!resolvedValues.has(row.id) && needsCatalogFallback(row)) {
            candidateIds.push(row.id);
          }
        }

        const pricingByInquiry = new Map<number, ProductPricing | null>();
        if (candidateIds.length > 0) {
          const links = await fetchProductLinks(candidateIds);
          const linksByInquiry = new Map<number, InquiryProductLinkRow[]>();
          for (const link of links) {
            const bucket = linksByInquiry.get(link.inquiry_id);
            if (bucket) bucket.push(link);
            else linksByInquiry.set(link.inquiry_id, [link]);
          }

          const variantIds = new Set<string>();
          const variantByInquiry = new Map<number, string | null>();
          for (const id of candidateIds) {
            const variantId = selectPrimaryProductId(linksByInquiry.get(id) ?? []);
            variantByInquiry.set(id, variantId);
            if (variantId) variantIds.add(variantId);
          }

          const products =
            variantIds.size > 0
              ? await fetchProductsByIds([...variantIds])
              : [];
          const pricingById = new Map<string, ProductPricing>();
          for (const product of products) {
            pricingById.set(product.id, getProductPricing(product));
          }

          for (const id of candidateIds) {
            const variantId = variantByInquiry.get(id) ?? null;
            pricingByInquiry.set(
              id,
              variantId ? pricingById.get(variantId) ?? null : null,
            );
          }
        }

        for (const row of allRows) {
          if (resolvedValues.has(row.id)) continue;
          resolvedValues.set(
            row.id,
            resolveInquiryValues(row, pricingByInquiry.get(row.id) ?? null),
          );
        }
      }

      /** Sorted, then range-filtered (null excluded when a bound is active). */
      function rankedEntries() {
        const entries = allRows.map((row) => ({
          row,
          values: resolvedValues.get(row.id) as ResolvedInquiryValues,
        }));
        entries.sort((a, b) =>
          compareRankedInquiries(
            a.row,
            a.values.expectedValue,
            b.row,
            b.values.expectedValue,
          ),
        );
        if (!rangeActive) return entries;
        return entries.filter(({ values }) => {
          const expectedValue = values.expectedValue;
          if (expectedValue === null) return false;
          if (minExpectedValue !== undefined && expectedValue < minExpectedValue)
            return false;
          if (maxExpectedValue !== undefined && expectedValue > maxExpectedValue)
            return false;
          return true;
        });
      }

      while (true) {
        qs.set("limit", String(INQUIRY_LIST_BATCH_SIZE));
        if (rawOffset > 0) qs.set("offset", String(rawOffset));
        else qs.delete("offset");

        const path = `/rest/v1/inquiry_list_vw?${qs.toString()}`;
        const { data, count } = await apiFetch<InquiryListRow[]>(path);
        if (totalCount === null) totalCount = count;
        allRows.push(...data);

        if (data.length < INQUIRY_LIST_BATCH_SIZE) break;
        rawOffset += data.length;

        await hydrateNewRows();
        const matching = rankedEntries();
        if (matching.length >= requiredMatches) {
          const pageLastDay = inquiryDayJst(
            matching[requiredMatches - 2]?.row.inquiry_date ?? null,
          );
          const lastFetchedDay = inquiryDayJst(
            allRows[allRows.length - 1]?.inquiry_date ?? null,
          );
          if (lastFetchedDay !== pageLastDay) break;
        }
      }

      await hydrateNewRows();
      const matching = rankedEntries();

      const hasMore = matching.length > currentOffset + pageSize;
      const data = matching
        .slice(currentOffset, currentOffset + pageSize)
        .map(({ row, values }) => ({
          ...row,
          effective_price_excl_shipping: values.effectivePriceExclShipping,
          effective_price_incl_shipping: values.effectivePriceInclShipping,
          effective_tcogs: values.effectiveTCOGS,
          expected_value: values.expectedValue,
        }));
      const nextCursor = hasMore ? currentOffset + pageSize : null;

      return { data, totalCount, hasMore, nextCursor };
    },

    async getInquiryDetail(id) {
      const qs = new URLSearchParams();
      qs.set("id", `eq.${id}`);

      const path = `/rest/v1/inquiry_detail_vw?${qs.toString()}`;
      const { data } = await apiFetch<InquiryDetailRow[]>(path);

      if (!data || data.length === 0) return null;
      return data[0];
    },

    async updateInquiry(id, data) {
      const qs = new URLSearchParams();
      qs.set("id", `eq.${id}`);

      await apiFetch<unknown>(`/rest/v1/inquiries?${qs.toString()}`, {
        init: {
          method: "PATCH",
          body: JSON.stringify(data),
        },
      });
    },

    async operatorSetPrimaryLink(params) {
      await this.rpc("operator_set_primary_link", {
        p_inquiry_id: params.inquiryId,
        p_product_variant_id: params.productVariantId,
        p_item_code_snapshot: params.itemCodeSnapshot,
        p_product_name_snapshot: params.productNameSnapshot,
      });
    },

    async operatorUnlinkProduct(inquiryId, linkId) {
      await this.rpc("operator_unlink_product", {
        p_inquiry_id: inquiryId,
        p_link_id: linkId,
      });
    },

    async deleteProductLink(inquiryId, productVariantId) {
      const qs = new URLSearchParams();
      qs.set("inquiry_id", `eq.${inquiryId}`);
      qs.set("product_variant_id", `eq.${productVariantId}`);

      await apiFetch<unknown>(
        `/rest/v1/inquiry_product_links?${qs.toString()}`,
        {
          init: { method: "DELETE" },
        },
      );
    },

    async searchProducts(query, pageSize = 20, shopKey = null) {
      const term = query.trim();
      if (!term) return { data: [], hasMore: false };

      const escaped = escapeLike(term);
      const qs = new URLSearchParams();
      qs.set(
        "select",
        "id,item_code,variant_name,store_name,store_code,seller_type,giga_index,raw_payload,product_commercials(source_available_qty,owned_qty,restock_date,last_sync_success_at),product_platform_links(shop_code,platform,platform_listing_skus(stock_qty))",
      );
      qs.set("product_platform_links.platform", "eq.mercari");
      if (shopKey) {
        qs.set("product_platform_links.shop_code", `eq.${shopKey}`);
      }
      qs.set("order", "variant_name.asc");
      qs.set("limit", String(pageSize + 1));
      qs.set(
        "or",
        `(item_code.ilike.*${escaped}*,variant_name.ilike.*${escaped}*)`,
      );

      const path = `/rest/v1/${catalogTable}?${qs.toString()}`;
      const { data } = await apiFetch<ProductCatalogRow[]>(path);

      const hasMore = data.length > pageSize;
      if (hasMore) data.pop();

      return { data, hasMore };
    },

    async lookupProduct(variantId, shopKey = null) {
      const qs = new URLSearchParams();
      qs.set(
        "select",
        "id,item_code,variant_name,store_name,store_code,seller_type,giga_index,raw_payload,product_commercials(source_available_qty,owned_qty,restock_date,last_sync_success_at),product_platform_links(shop_code,platform,platform_listing_skus(stock_qty))",
      );
      qs.set("product_platform_links.platform", "eq.mercari");
      if (shopKey) {
        qs.set("product_platform_links.shop_code", `eq.${shopKey}`);
      }
      qs.set("id", `eq.${variantId}`);

      const path = `/rest/v1/${catalogTable}?${qs.toString()}`;
      const { data } = await apiFetch<ProductCatalogRow[]>(path);

      if (!data || data.length === 0) return null;
      return data[0];
    },
  };
}

// -- Helpers ---------------------------------------------------------------

/**
 * Extract a meaningful error message from a PostgREST error response body.
 * PostgREST typically returns: { message: "...", details: "...", hint: "..." }
 */
function extractPostgrestError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed.message) {
      let msg = parsed.message;
      if (parsed.details) msg += ` (${parsed.details})`;
      return msg;
    }
    return body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
