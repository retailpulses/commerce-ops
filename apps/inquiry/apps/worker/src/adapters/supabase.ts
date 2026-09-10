import { withRetry } from "../utils/retry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupabaseConfig {
  url: string;
  restUrl?: string;
  serviceRoleKey: string;
}

/** Compound cursor for lossless pagination over (inquiry_date, id). */
export interface CompoundCursor {
  inquiryDate: string; // ISO 8601 UTC string
  id: number; // last processed inquiry.id
}

export interface InquiryRow {
  id: number;
  status: string;
  automation_status: string;
  follow_up_status: string | null;
  inquiry_type: string | null;
  source: string;
  external_inquiry_id: string | null;
  url: string | null;
  shop_key: string;
  inquiry_date: string | null;
  inquiry_body: string | null;
  customer_nickname: string | null;
  product_name_snapshot: string | null;
  last_inbound_time: string | null;
  last_custom_message: string | null;
  message_log_raw: string | null;
  order_id: string | null;
  reply_strategy: string | null;
  draft_reply: string | null;
  inquiry_skill_reply: string | null;
  reply_drafted_at: string | null;
  ai_copywritten_reply: string | null;
  ai_copywritten_at: string | null;
  product_links_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

const STATEMENT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;

class SupabaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SupabaseRequestError";
  }
}

function isRetryable(error: Error): boolean {
  if (!(error instanceof SupabaseRequestError)) return true;
  return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
}

export function createSupabaseAdapter(config: SupabaseConfig) {
  const baseUrl = config.restUrl
    ? config.restUrl.replace(/\/$/, "")
    : `${config.url.replace(/\/$/, "")}/rest/v1`;
  const authHeaders: Record<string, string> = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
  };

  // ---- Low-level request helper with retry, timeout, and jitter ----

  async function request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: URLSearchParams;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<T> {
    const url = `${baseUrl}${path}${
      options?.params ? "?" + options.params.toString() : ""
    }`;

    return withRetry<T>(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), STATEMENT_TIMEOUT_MS);

        try {
          const res = await fetch(url, {
            method,
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              ...options?.extraHeaders,
            },
            body: options?.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "no body");
            throw new SupabaseRequestError(
              `Supabase ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
              res.status,
            );
          }

          // 204 No Content or empty body
          const contentLength = res.headers.get("content-length");
          if (res.status === 204 || contentLength === "0") {
            return undefined as T;
          }

          return (await res.json()) as T;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxAttempts: DEFAULT_MAX_RETRIES,
        backoffMs: DEFAULT_BACKOFF_MS,
        shouldRetry: isRetryable,
      },
    );
  }

  // ---- Build PostgREST URLSearchParams from filters ----

  function buildParams(options: {
    select?: string;
    filters?: Record<string, string>;
    order?: string;
    limit?: number;
    cursor?: { column: string; value: string };
    compoundCursor?: CompoundCursor;
    compoundDateColumn?: string;
    compoundIdColumn?: string;
  }): URLSearchParams {
    const sp = new URLSearchParams();
    sp.set("select", options.select ?? "*");

    if (options.filters) {
      for (const [key, val] of Object.entries(options.filters)) {
        sp.append(key, val);
      }
    }

    if (options.order) {
      sp.set("order", options.order);
    }

    if (options.limit != null) {
      sp.set("limit", String(options.limit));
    }

    if (options.compoundCursor) {
      // Tuple semantics: (date > cursorDate) OR (date = cursorDate AND id > cursorId)
      // URLSearchParams handles encoding — do NOT encodeURIComponent here (double-encoding risk)
      const { inquiryDate, id } = options.compoundCursor;
      const dateCol = options.compoundDateColumn ?? "inquiry_date";
      const idCol = options.compoundIdColumn ?? "id";
      sp.append(
        "or",
        `(${dateCol}.gt.${inquiryDate},and(${dateCol}.eq.${inquiryDate},${idCol}.gt.${id}))`,
      );
    } else if (options.cursor) {
      sp.append(options.cursor.column, `gt.${options.cursor.value}`);
    }

    return sp;
  }

  // ====================================================================
  // Column selection constants
  // ====================================================================

  const INQUIRY_SELECT =
    "id,status,automation_status,follow_up_status," +
    "inquiry_type,source,external_inquiry_id,url,shop_key," +
    "inquiry_date,inquiry_body,customer_nickname,product_name_snapshot," +
    "last_inbound_time,last_custom_message,message_log_raw,order_id," +
    "reply_strategy,draft_reply,inquiry_skill_reply,reply_drafted_at," +
    "ai_copywritten_reply,ai_copywritten_at,product_links_reviewed_at,created_at,updated_at";

  // ---- Public API ----

  return {
    // -----------------------------------------------------------------------
    // Generic helpers
    // -----------------------------------------------------------------------

    async query<T = Record<string, unknown>>(
      table: string,
      params: {
        select?: string;
        filters?: Record<string, string>;
        order?: string;
        limit?: number;
        cursor?: { column: string; value: string };
        compoundCursor?: CompoundCursor;
        compoundDateColumn?: string;
        compoundIdColumn?: string;
      },
    ): Promise<T[]> {
      return request<T[]>("GET", `/${table}`, {
        params: buildParams(params),
      });
    },

    async update(
      table: string,
      idColumn: string,
      idValue: unknown,
      data: Record<string, unknown>,
    ): Promise<void> {
      const params = new URLSearchParams();
      params.set(`${idColumn}`, `eq.${idValue}`);
      await request("PATCH", `/${table}`, {
        params,
        body: data,
        extraHeaders: { Prefer: "return=minimal" },
      });
    },

    async insert(
      table: string,
      data: Record<string, unknown> | Record<string, unknown>[],
    ): Promise<Record<string, unknown>[]> {
      return request<Record<string, unknown>[]>("POST", `/${table}`, {
        body: data,
        extraHeaders: { Prefer: "return=representation" },
      });
    },

    async upsert(
      table: string,
      data: Record<string, unknown> | Record<string, unknown>[],
      onConflict: string,
    ): Promise<Record<string, unknown>[]> {
      const params = new URLSearchParams({ on_conflict: onConflict });
      return request<Record<string, unknown>[]>("POST", `/${table}`, {
        params,
        body: data,
        extraHeaders: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
    },

    async updateWhere(
      table: string,
      filters: Record<string, string>,
      data: Record<string, unknown>,
    ): Promise<void> {
      const params = new URLSearchParams();
      for (const [key, val] of Object.entries(filters)) params.append(key, val);
      await request("PATCH", `/${table}`, {
        params,
        body: data,
        extraHeaders: { Prefer: "return=minimal" },
      });
    },

    async deleteWhere(
      table: string,
      filters: Record<string, string>,
    ): Promise<void> {
      const params = new URLSearchParams();
      for (const [key, val] of Object.entries(filters)) {
        params.append(key, val);
      }
      await request("DELETE", `/${table}`, { params });
    },

    // -----------------------------------------------------------------------
    // Inquiry-specific
    // -----------------------------------------------------------------------

    async fetchInquiries(
      status: string,
      limit: number,
      cursor?: string,
      compoundCursor?: CompoundCursor,
    ): Promise<InquiryRow[]> {
      const filters: Record<string, string> = {
        status: `eq.${status}`,
        deleted_at: "is.null",
      };

      return request<InquiryRow[]>("GET", "/inquiries", {
        params: buildParams({
          select: INQUIRY_SELECT,
          filters,
          order: "inquiry_date.asc.nullsfirst,id.asc",
          limit,
          compoundCursor,
          compoundDateColumn: "inquiry_date",
          compoundIdColumn: "id",
          // Fall back to legacy single-column cursor only when no compound cursor
          ...(compoundCursor
            ? {}
            : cursor
              ? { cursor: { column: "inquiry_date", value: cursor } }
              : {}),
        }),
      });
    },

    /**
     * Fetch inquiries within a bounded time window (for replay).
     * Does NOT use a cursor — always fetches from the start of the window.
     * Uses PostgREST `offset` for pagination.
     */
    async fetchInquiriesByWindow(
      status: string,
      limit: number,
      sinceISO: string, // UTC ISO 8601 — `inquiry_date >= sinceISO`
      untilISO?: string,
      page: number = 1,
    ): Promise<InquiryRow[]> {
      const filters: Record<string, string> = {
        status: `eq.${status}`,
        deleted_at: "is.null",
        inquiry_date: `gte.${sinceISO}`,
      };

      const params = buildParams({
        select: INQUIRY_SELECT,
        filters,
        order: "inquiry_date.asc.nullsfirst,id.asc",
        limit,
      });

      if (page > 1) {
        params.set("offset", String((page - 1) * limit));
      }

      return request<InquiryRow[]>("GET", "/inquiries", { params });
    },

    async fetchInquiryByIds(ids: number[]): Promise<InquiryRow[]> {
      return request<InquiryRow[]>("GET", "/inquiries", {
        params: buildParams({
          select: INQUIRY_SELECT,
          filters: { id: `in.(${ids.join(",")})` },
          limit: ids.length,
        }),
      });
    },

    async patchInquiry(
      id: number,
      data: Record<string, unknown>,
    ): Promise<void> {
      return this.update("inquiries", "id", id, data);
    },

    // -----------------------------------------------------------------------
    // Health check
    // -----------------------------------------------------------------------

    async ping(): Promise<boolean> {
      try {
        await request("GET", "/");
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type SupabaseAdapter = ReturnType<typeof createSupabaseAdapter>;
