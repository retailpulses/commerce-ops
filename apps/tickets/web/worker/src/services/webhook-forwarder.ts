/** OrderMgmt webhook forwarding — Issue #131.
 *
 * Ticket Handling owns the single registered order_transaction_message_created
 * webhook. After it durably inserts an inbound_ticket_messages row, the raw
 * validated event is forwarded to OrderMgmt's /webhooks/mercari-message
 * endpoint so OrderMgmt can detect buyer messages near-real-time without
 * registering a competing webhook.
 *
 * Forwarding contract (see OrderMgmt docs/webhook/webhook-architecture-adr.md):
 *   POST <ORDERMGMT_WEBHOOK_ENDPOINT>
 *   Authorization: Bearer <ORDERMGMT_WEBHOOK_FORWARD_SECRET>
 *   { topic, shop_id, order_transaction_id, created_at }
 *
 * Forwarding is best-effort from ctx.waitUntil for latency and durably
 * retried by the scheduled retry worker. The claim RPC atomically moves a
 * row to 'forwarding' while bumping the attempt counter, and reclaims rows
 * left in-flight by a crashed worker after a staleness window (terminalizing
 * them when attempts are exhausted). The secret is header-only — it never
 * appears in the URL or in logs.
 */

import { getSupabaseClient } from "../repositories/supabase";
import type { Env } from "../types";

const DEFAULT_MAX_FORWARD_ATTEMPTS = 5;
const FORWARD_TIMEOUT_MS = 10_000;

export interface ForwardResult {
  ok: boolean;
  status?: number;
  retryable: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ForwardStats {
  claimed: number;
  forwarded: number;
  failed: number;
  skipped: number;
}

/** Minimal client surface used by the forwarder (test-injectable). */
export interface ForwarderDbClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(col: string, value: string): Promise<{ error: { message: string } | null }>;
    };
    select(columns: string): {
      eq(col: string, value: string): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export interface ForwarderDeps {
  fetchImpl?: typeof fetch;
  supabase?: ForwarderDbClient;
}

interface ForwardRow {
  id: string;
  shop_id: string;
  order_transaction_id: string;
  webhook_received_at?: string | null;
  forwarding_status?: string;
  forwarding_attempts?: number;
}

export function isForwardingConfigured(env: Env): boolean {
  return Boolean(
    String(env.ORDERMGMT_WEBHOOK_ENDPOINT || "").trim() &&
      String(env.ORDERMGMT_WEBHOOK_FORWARD_SECRET || "").trim()
  );
}

export function maxForwardAttempts(env: Env): number {
  const parsed = Number.parseInt(String(env.ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FORWARD_ATTEMPTS;
}

/**
 * Build the forwarding payload from a durable inbound row.
 * Returns null when required fields are missing (never forward garbage).
 */
export function buildForwardPayload(row: {
  shop_id: string;
  order_transaction_id: string;
  webhook_received_at?: string | null;
}): Record<string, string> | null {
  const shopId = String(row.shop_id || "").trim();
  const txId = String(row.order_transaction_id || "").trim();
  const createdAt = String(row.webhook_received_at || "").trim();
  if (!shopId || !txId || !createdAt) return null;
  return {
    topic: "ORDER_TRANSACTION_MESSAGE_CREATED",
    shop_id: shopId,
    order_transaction_id: txId,
    created_at: createdAt,
  };
}

/** Classify an OrderMgmt response as retryable or terminal. */
function classifyForwardFailure(status: number): { retryable: boolean; error: string } {
  const error = `forward_rejected_${status}`;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413) {
    // Permanent contract failures — retrying cannot succeed (bad payload,
    // mismatched secret, unknown shop). Terminal.
    return { retryable: false, error };
  }
  // 429 / 5xx (including OrderMgmt DISABLED=503): transient — retry later.
  return { retryable: true, error };
}

/** POST the event to OrderMgmt. Pure network + config; no DB access. */
export async function forwardToOrderMgmt(
  env: Env,
  row: ForwardRow,
  deps: ForwarderDeps = {}
): Promise<ForwardResult> {
  if (!isForwardingConfigured(env)) {
    return { ok: false, retryable: false, skipped: true };
  }

  const payload = buildForwardPayload(row);
  if (!payload) {
    return { ok: false, retryable: false, error: "missing_forward_fields" };
  }

  const endpoint = String(env.ORDERMGMT_WEBHOOK_ENDPOINT).trim();
  const secret = String(env.ORDERMGMT_WEBHOOK_FORWARD_SECRET).trim();
  const fetchImpl = deps.fetchImpl || fetch;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const errMsg = (e as Error).message ?? String(e);
    return { ok: false, retryable: true, error: `forward_fetch_failed:${errMsg}` };
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    return { ok: true, status, retryable: false };
  }
  const failure = classifyForwardFailure(status);
  return { ok: false, status, retryable: failure.retryable, error: failure.error };
}

/** Persist the outcome of a forwarding attempt on the inbound row. */
async function applyForwardOutcome(
  env: Env,
  id: string,
  result: ForwardResult,
  attempts: number,
  deps: ForwarderDeps
): Promise<void> {
  if (result.skipped) return; // config off — leave the row untouched

  const now = new Date().toISOString();
  const terminal = !result.retryable || attempts >= maxForwardAttempts(env);
  const supabase = deps.supabase || (getSupabaseClient(env) as unknown as ForwarderDbClient);

  const patch: Record<string, unknown> = {
    forwarding_attempts: attempts,
    last_forward_attempt_at: now,
  };
  if (result.ok) {
    patch.forwarding_status = "forwarded";
    patch.forwarded_at = now;
    patch.forward_error = null;
  } else {
    patch.forwarding_status = terminal ? "failed" : "not_forwarded";
    patch.forward_error = String(result.error || "forward_failed").slice(0, 1000);
  }

  const { error } = await supabase
    .from("inbound_ticket_messages")
    .update(patch)
    .eq("id", id);
  if (error) {
    console.error(`[Forwarder] State update failed: ${error.message}`);
  }
}

/**
 * Forward a single inbound row (used from the webhook handler's waitUntil).
 * Returns immediately without touching the row when forwarding is unconfigured.
 */
export async function forwardSingleInboundMessage(
  env: Env,
  inboundId: string,
  deps: ForwarderDeps = {}
): Promise<ForwardResult> {
  if (!isForwardingConfigured(env)) {
    return { ok: false, retryable: false, skipped: true };
  }

  const supabase = deps.supabase || (getSupabaseClient(env) as unknown as ForwarderDbClient);
  const { data, error } = await supabase
    .from("inbound_ticket_messages")
    .select("id, shop_id, order_transaction_id, webhook_received_at, forwarding_status, forwarding_attempts")
    .eq("id", inboundId)
    .maybeSingle();

  if (error || !data) {
    console.error("[Forwarder] Inbound row not found for forwarding");
    return { ok: false, retryable: true, error: "row_not_found" };
  }

  const row = data as unknown as ForwardRow;
  if (
    row.forwarding_status === "forwarded" ||
    row.forwarding_status === "failed" ||
    row.forwarding_status === "forwarding"
  ) {
    // Already terminal or claimed in-flight elsewhere — skip (idempotent
    // re-entry, e.g. duplicate claim race / concurrent cron claim).
    return { ok: true, status: 200, retryable: false };
  }

  const result = await forwardToOrderMgmt(env, row, deps);
  const attempts = (row.forwarding_attempts ?? 0) + 1;
  await applyForwardOutcome(env, row.id, result, attempts, deps);
  return result;
}

/**
 * Cron entry point: claim and forward rows pending or reclaimed from a stale
 * claim. The claim_pending_webhook_forwarding RPC atomically moves each row
 * to 'forwarding' (bounded by attempts and the lookback window) and returns
 * the claimed rows; each outcome is then applied back to the row.
 */
export async function forwardPendingInboundMessages(
  env: Env,
  limit = 10,
  deps: ForwarderDeps = {}
): Promise<ForwardStats> {
  if (!isForwardingConfigured(env)) {
    return { claimed: 0, forwarded: 0, failed: 0, skipped: 1 };
  }

  const supabase = deps.supabase || (getSupabaseClient(env) as unknown as ForwarderDbClient);
  const { data, error } = await supabase.rpc("claim_pending_webhook_forwarding", {
    claim_limit: limit,
    max_attempts: maxForwardAttempts(env),
  });

  if (error) {
    console.error(`[Forwarder] Claim failed: ${error.message}`);
    return { claimed: 0, forwarded: 0, failed: 0, skipped: 0 };
  }

  const rows = (data ?? []) as unknown as ForwardRow[];
  if (!rows.length) return { claimed: 0, forwarded: 0, failed: 0, skipped: 0 };

  console.log(`[Forwarder] Claimed ${rows.length} rows for forwarding`);

  let forwarded = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await forwardToOrderMgmt(env, row, deps);
    const attempts = row.forwarding_attempts ?? 0; // RPC already incremented
    await applyForwardOutcome(env, row.id, result, attempts, deps);
    if (result.ok) forwarded++;
    else if (!result.skipped) failed++;
  }

  console.log(`[Forwarder] Batch complete — ${forwarded} forwarded, ${failed} failed`);
  return { claimed: rows.length, forwarded, failed, skipped: 0 };
}
