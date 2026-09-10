import { withRetry } from "../utils/retry";
import type {
  CanonicalInquiryInput,
  CanonicalMessageInput,
  WebhookEventRecord,
  WebhookEventRow,
} from "./types";

/**
 * Idempotent Supabase persistence adapter for the Mercari inquiry contracts.
 *
 * All writes are idempotent on the source-neutral identity:
 *   - inquiries upsert by (shop_key, external_inquiry_id)
 *   - messages upsert by (shop_key, external_message_id)
 *   - webhook events insert by unique event_identity
 *
 * The durable event inbox write must succeed (or be a duplicate) before the
 * webhook receiver returns 2xx; database failure surfaces as a retryable error.
 */

export interface MercariPersistenceConfig {
  url: string;
  restUrl?: string;
  serviceRoleKey: string;
}

export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

interface PersistenceResult<T> {
  data: T;
  count: number | null;
}

export interface UpsertResult {
  id: number;
  created: boolean;
  changed: boolean;
}

export interface ReconcileThreadResult {
  inquiryId: number;
  inquiryCreated: boolean;
  inquiryChanged: boolean;
  messagesCreated: number;
  messagesChanged: number;
  rowsWritten: number;
}

export interface WebhookStatusRow {
  shop_key: string;
  topic: string;
  received_at: string;
  processing_status: string;
  attempts: number;
}

export interface WebhookStatusSnapshot {
  total: number | null;
  recent: WebhookStatusRow[];
}

export interface MercariPersistence {
  recordWebhookEvent(event: WebhookEventRecord): Promise<{ duplicate: boolean }>;
  claimWebhookEvent(worker: string): Promise<WebhookEventRow | null>;
  completeWebhookEvent(
    id: number,
    status: "completed" | "failed",
    opts?: { error?: string | null; nextRetryAt?: string | null },
  ): Promise<void>;
  upsertInquiry(input: CanonicalInquiryInput): Promise<UpsertResult>;
  upsertMessage(input: CanonicalMessageInput): Promise<{ created: boolean; changed: boolean }>;
  reconcileApiThread(
    inquiry: CanonicalInquiryInput,
    messages: CanonicalMessageInput[],
  ): Promise<ReconcileThreadResult>;
  tombstoneMessage(shopKey: string, externalMessageId: string): Promise<void>;
  recordQuarantine(record: Record<string, unknown>): Promise<void>;
  recordIngestionRun(record: Record<string, unknown>): Promise<void>;
  applyPlatformTransition(inquiryId: number, topic: string, latestMessageFrom?: string | null): Promise<void>;
  getWebhookStatus(limit: number): Promise<WebhookStatusSnapshot>;
}

const STATEMENT_TIMEOUT_MS = 30000;

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export function createMercariPersistence(
  config: MercariPersistenceConfig,
): MercariPersistence {
  const baseUrl = config.restUrl
    ? config.restUrl.replace(/\/$/, "")
    : `${config.url.replace(/\/$/, "")}/rest/v1`;
  const authHeaders: Record<string, string> = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
  };

  async function request<T>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      params?: URLSearchParams;
      extraHeaders?: Record<string, string>;
      preferCount?: boolean;
    },
  ): Promise<PersistenceResult<T>> {
    const url = `${baseUrl}${path}${
      opts?.params ? "?" + opts.params.toString() : ""
    }`;

    return withRetry<PersistenceResult<T>>(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STATEMENT_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            method,
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              ...(opts?.preferCount ? { Prefer: "count=exact" } : {}),
              ...opts?.extraHeaders,
            },
            body: opts?.body ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal,
          });

          let count: number | null = null;
          const contentRange = res.headers.get("content-range");
          if (contentRange) {
            const m = contentRange.match(/\/(\d+)$/);
            if (m) count = parseInt(m[1], 10);
          }

          if (!res.ok) {
            const text = await res.text().catch(() => "no body");
            throw new PersistenceError(
              `Supabase ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
              isRetryableStatus(res.status),
              res.status,
            );
          }

          if (res.status === 204 || res.headers.get("content-length") === "0") {
            return { data: undefined as T, count };
          }
          const text = await res.text();
          if (!text) return { data: undefined as T, count };
          return { data: JSON.parse(text) as T, count };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: 3,
        backoffMs: 1000,
        shouldRetry: (err) => (err instanceof PersistenceError ? err.retryable : true),
      },
    );
  }

  async function rpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
    const { data } = await request<T>("POST", `/rpc/${fn}`, { body: params });
    return data;
  }

  return {
    async recordWebhookEvent(event) {
      const params = new URLSearchParams({ on_conflict: "event_identity" });
      const res = await request<WebhookEventRow[]>("POST", "/inquiry_webhook_events", {
        params,
        body: event,
        extraHeaders: { Prefer: "resolution=ignore-duplicates,return=representation" },
      });
      // ignore-duplicates returns the existing row on conflict, or [] when
      // PostgREST suppresses the representation — either way it is a durable idempotent write.
      return { duplicate: (res.data?.length ?? 0) === 0 };
    },

    async claimWebhookEvent(worker) {
      return rpc<WebhookEventRow | null>("inquiry_claim_webhook_event", {
        p_worker: worker,
      });
    },

    async completeWebhookEvent(id, status, opts) {
      await rpc<void>("inquiry_complete_webhook_event", {
        p_event_id: id,
        p_status: status,
        p_error: opts?.error ?? null,
        p_next_retry_at: opts?.nextRetryAt ?? null,
      });
    },

    async upsertInquiry(input) {
      const params = new URLSearchParams({
        shop_key: `eq.${input.shop_key}`,
        external_inquiry_id: `eq.${input.external_inquiry_id}`,
        deleted_at: "is.null",
        select: "id,external_status,external_sales_channel,external_first_opened_at,external_last_activity_at,external_target_type,external_product_id,external_product_variant_id,external_order_transaction_id,external_shop_id,inquiry_date,inquiry_body,last_inbound_time,last_custom_message",
      });
      const existing = await request<Array<Record<string, unknown> & { id: number }>>("GET", "/inquiries", { params });

      if (existing.data && existing.data.length > 0) {
        const row = existing.data[0];
        const id = row.id;
        const comparableKeys = [
          "external_status", "external_sales_channel", "external_first_opened_at",
          "external_last_activity_at", "external_target_type", "external_product_id",
          "external_product_variant_id", "external_order_transaction_id", "external_shop_id",
          "inquiry_date", "inquiry_body", "last_inbound_time", "last_custom_message",
        ] as const;
        const changed = comparableKeys.some((key) => input[key] !== null && input[key] !== row[key]);
        if (!changed) return { id, created: false, changed: false };
        const update: Record<string, unknown> = {
          source: input.source,
          source_observed_at: input.source_observed_at,
          source_payload: input.source_payload,
        };
        for (const key of comparableKeys) {
          if (input[key] !== null) update[key] = input[key];
        }
        await request<void>("PATCH", `/inquiries`, {
          params: new URLSearchParams({ id: `eq.${id}` }),
          body: update,
          extraHeaders: { Prefer: "return=minimal" },
        });
        return { id, created: false, changed: true };
      }

      const inserted = await request<{ id: number }[]>("POST", "/inquiries", {
        body: input,
        extraHeaders: { Prefer: "return=representation" },
      });
      return { id: inserted.data[0].id, created: true, changed: true };
    },

    async upsertMessage(input) {
      const lookup = new URLSearchParams({
        shop_key: `eq.${input.shop_key}`,
        external_message_id: `eq.${input.external_message_id}`,
        select: "id,body,sent_at,external_status,deleted_at,attachments_metadata,source_payload_hash",
      });
      const existing = await request<Array<Record<string, unknown> & { id: number }>>("GET", "/inquiry_messages", { params: lookup });
      if (existing.data.length > 0) {
        const row = existing.data[0];
        const changed = row.body !== input.body || row.sent_at !== input.sent_at ||
          row.external_status !== input.external_status || row.deleted_at !== input.deleted_at ||
          row.source_payload_hash !== input.source_payload_hash ||
          JSON.stringify(row.attachments_metadata ?? []) !== JSON.stringify(input.attachments_metadata);
        if (!changed) return { created: false, changed: false };
        await request<void>("PATCH", "/inquiry_messages", {
          params: new URLSearchParams({ id: `eq.${row.id}` }),
          body: { ...input, last_observed_at: new Date().toISOString() },
          extraHeaders: { Prefer: "return=minimal" },
        });
        return { created: false, changed: true };
      }
      await request<void>("POST", "/inquiry_messages", {
        body: input,
        extraHeaders: { Prefer: "return=minimal" },
      });
      return { created: true, changed: true };
    },

    async reconcileApiThread(inquiry, messages) {
      return rpc<ReconcileThreadResult>("inquiry_reconcile_api_thread", {
        p_inquiry: inquiry,
        p_messages: messages,
      });
    },

    async tombstoneMessage(shopKey, externalMessageId) {
      await request<void>("PATCH", "/inquiry_messages", {
        params: new URLSearchParams({
          shop_key: `eq.${shopKey}`,
          external_message_id: `eq.${externalMessageId}`,
          deleted_at: "is.null",
        }),
        body: { deleted_at: new Date().toISOString(), external_status: "DELETED" },
        extraHeaders: { Prefer: "return=minimal" },
      });
    },

    async recordQuarantine(record) {
      await request<void>("POST", "/inquiry_quarantine", {
        body: record,
        extraHeaders: { Prefer: "return=minimal" },
      });
    },

    async recordIngestionRun(record) {
      await request<void>("POST", "/inquiry_ingestion_runs", {
        body: record,
        extraHeaders: { Prefer: "return=minimal" },
      });
    },

    async applyPlatformTransition(inquiryId, topic, latestMessageFrom) {
      await rpc<void>("inquiry_apply_platform_transition", {
        p_inquiry_id: inquiryId,
        p_topic: topic,
        p_latest_message_from: latestMessageFrom ?? null,
      });
    },

    async getWebhookStatus(limit) {
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const params = new URLSearchParams({
        select: "shop_key,topic,received_at,processing_status,attempts",
        order: "received_at.desc",
        limit: String(boundedLimit),
      });
      const result = await request<WebhookStatusRow[]>(
        "GET",
        "/inquiry_webhook_events",
        { params, preferCount: true },
      );
      return { total: result.count, recent: result.data ?? [] };
    },
  };
}

export type { PersistenceResult };
