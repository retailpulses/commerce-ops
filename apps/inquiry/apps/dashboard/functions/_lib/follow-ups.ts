import type { DashboardConfig } from "./config";

/**
 * Follow-up queue + normalized message timeline client (server-side).
 *
 * Queue projections are Supabase views; mutations use the atomic claim /
 * finalize / schedule RPCs from the migration. The outbound idempotency key is
 * the same sha256 contract as the worker: sha256(shop_key + external_inquiry_id
 * + cycle_id-or-reply + operation_version). Retries of one logical send reuse
 * the identical key; ambiguous results must reconcile, never blind-retry.
 */

export type FollowUpBucket = "due" | "overdue" | "upcoming" | "history";

export interface FollowUpQueueRow {
  id: number;
  shop_key: string | null;
  external_inquiry_id: string | null;
  customer_nickname: string | null;
  product_name_snapshot: string | null;
  external_target_type: string | null;
  follow_up_state: string | null;
  follow_up_due_date: string | null;
  follow_up_date_source: string | null;
  follow_up_cycle_id: string | null;
  last_confirmed_outbound_message_id: string | null;
  last_confirmed_outbound_at: string | null;
  status: string | null;
  days_overdue?: number | null;
  days_until_due?: number | null;
  bucket?: string | null;
  latest_message_from?: string | null;
  latest_message_id?: string | null;
  latest_message_sent_at?: string | null;
}

export interface InquiryMessageRow {
  id: number;
  inquiry_id: number;
  shop_key: string;
  external_inquiry_id: string | null;
  external_message_id: string;
  external_from: string | null;
  direction: string | null;
  body: string | null;
  sent_at: string | null;
  external_status: string | null;
  deleted_at: string | null;
  attachments_metadata: unknown;
  source_payload_hash: string | null;
  outbound_operation_id: number | null;
  idempotency_key: string | null;
}

export interface SendEvidence {
  mercariMessageId: string;
  body: string;
  sentAt: string | null;
  bodyHash: string;
}

export interface OutboundContext {
  id: number;
  shop_key: string | null;
  external_inquiry_id: string | null;
  external_target_type: string | null;
  external_order_transaction_id: string | null;
  follow_up_cycle_id: string | null;
  follow_up_state: string | null;
  follow_up_due_date: string | null;
  follow_up_date_source: string | null;
}

export interface FollowUpClient {
  listFollowUps(bucket: FollowUpBucket, shop?: string | null): Promise<FollowUpQueueRow[]>;
  getMessages(inquiryId: number): Promise<InquiryMessageRow[]>;
  getOutboundContext(inquiryId: number): Promise<OutboundContext | null>;
  scheduleFollowUp(
    inquiryId: number,
    opts: { dueDate?: string | null; state?: string; actor?: string; reason?: string | null },
  ): Promise<Record<string, unknown>>;
  claimOutbound(
    inquiryId: number,
    cycleId: string | null,
    idempotencyKey: string,
    actor: string,
    requestedBody: string,
  ): Promise<Record<string, unknown>>;
  markOutboundResult(operationId: number, status: "sent" | "ambiguous" | "failed", error?: string | null): Promise<void>;
  finalizeOutbound(
    operationId: number,
    evidence: SendEvidence,
    opts?: { actor?: string; followUpDueDate?: string | null },
  ): Promise<Record<string, unknown>>;
}

export const INITIAL_REPLY_CYCLE = "reply";

export async function outboundIdempotencyKey(input: {
  shopKey: string;
  externalInquiryId: string;
  cycleId: string | null;
  operationVersion: number;
}): Promise<string> {
  const material = [
    input.shopKey,
    input.externalInquiryId,
    input.cycleId ?? INITIAL_REPLY_CYCLE,
    String(input.operationVersion),
  ].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function bodyHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VIEW_BY_BUCKET: Record<FollowUpBucket, string> = {
  due: "follow_up_review_queue_vw",
  overdue: "follow_up_review_queue_vw",
  upcoming: "follow_up_upcoming_vw",
  history: "follow_up_history_vw",
};

export function createFollowUpClient(config: DashboardConfig): FollowUpClient {
  const { url, restUrl, serviceRoleKey } = config.supabase;
  const baseUrl = restUrl
    ? restUrl.replace(/\/$/, "")
    : `${url.replace(/\/$/, "")}/rest/v1`;

  const headers: Record<string, string> = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function rpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
    return fetchJson<T>(`/rpc/${fn}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  return {
    async listFollowUps(bucket, shop) {
      const view = VIEW_BY_BUCKET[bucket];
      const qs = new URLSearchParams();
      qs.set("order", "follow_up_due_date.asc.nullsfirst,id.asc");
      if (shop && shop !== "_all") qs.set("shop_key", `eq.${shop}`);
      if (bucket === "due") qs.set("bucket", "eq.due");
      if (bucket === "overdue") qs.set("bucket", "eq.overdue");
      return fetchJson<FollowUpQueueRow[]>(`/${view}?${qs.toString()}`);
    },

    async getMessages(inquiryId) {
      const qs = new URLSearchParams();
      qs.set("inquiry_id", `eq.${inquiryId}`);
      qs.set("order", "sent_at.asc.nullsfirst,id.asc");
      return fetchJson<InquiryMessageRow[]>(`/inquiry_message_timeline_vw?${qs.toString()}`);
    },

    async getOutboundContext(inquiryId) {
      const qs = new URLSearchParams();
      qs.set(
        "select",
        "id,shop_key,external_inquiry_id,external_target_type,external_order_transaction_id,follow_up_cycle_id,follow_up_state,follow_up_due_date,follow_up_date_source",
      );
      qs.set("id", `eq.${inquiryId}`);
      const rows = await fetchJson<OutboundContext[]>(`/inquiries?${qs.toString()}`);
      return rows[0] ?? null;
    },

    async scheduleFollowUp(inquiryId, opts) {
      return rpc("inquiry_schedule_follow_up", {
        p_inquiry_id: inquiryId,
        p_follow_up_due_date: opts.dueDate ?? null,
        p_follow_up_state: opts.state ?? "scheduled",
        p_actor: opts.actor ?? null,
        p_reason: opts.reason ?? null,
      });
    },

    async claimOutbound(inquiryId, cycleId, idempotencyKey, actor, requestedBody) {
      return rpc("inquiry_claim_outbound_cycle", {
        p_inquiry_id: inquiryId,
        p_follow_up_cycle_id: cycleId,
        p_idempotency_key: idempotencyKey,
        p_actor: actor,
        p_requested_body: requestedBody,
      });
    },

    async markOutboundResult(operationId, status, error) {
      const qs = new URLSearchParams({ id: `eq.${operationId}` });
      await fetchJson<void>(`/inquiry_outbound_operations?${qs.toString()}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status, finalize_error: error ?? null }),
      });
    },

    async finalizeOutbound(operationId, evidence, opts) {
      return rpc("inquiry_finalize_outbound", {
        p_operation_id: operationId,
        p_mercari_message_id: evidence.mercariMessageId,
        p_message_body: evidence.body,
        p_readback_body_hash: evidence.bodyHash,
        p_sent_at: evidence.sentAt ?? null,
        p_actor: opts?.actor ?? null,
        p_follow_up_due_date: opts?.followUpDueDate ?? null,
      });
    },
  };
}
