/**
 * Mercari webhook handler — OrderMgmt webhook-primary message detection (Issue #131).
 *
 * POST /webhooks/mercari-message
 * Receives order_transaction_message_created events, validates, inserts
 * a durable row into Supabase immediately, returns 2xx, and then
 * fetches full conversation + writes message facts asynchronously via ctx.waitUntil.
 *
 * Ownership decision: Reuses Ticket Handling's single registered
 * order_transaction_message_created webhook and durable receipt.
 * No competing webhook registration — OrderMgmt becomes a consumer
 * of the shared event path. Ticket Handling forwards raw events
 * to this endpoint after its durable insert, authenticated with the
 * dedicated WEBHOOK_FORWARD_SECRET (header-only, constant-time compare).
 *
 * See: docs/webhook/mercari-event-contract.md
 *      docs/webhook/webhook-architecture-adr.md
 */

import { createBaserowClient } from "./db.mjs";
import { runMercariOrderMessagesViaRelay } from "./mercari-relay.mjs";
import { writeThroughMessageFacts, recordMessageSyncFailure } from "./buyer-messages.mjs";
import { MERCARI_CHANNEL } from "./channel-config.mjs";

// ── Constants ──────────────────────────────────────────────────────────

const MESSAGE_CREATED_TOPIC = "order_transaction_message_created";

const SCOPE_STATUSES = Object.freeze(new Set([
  "WAITING_FOR_PAYMENT",
  "WAITING_FOR_SHIPPING",
]));

const MAX_PROCESSING_ATTEMPTS = 3;

/** Upper bound on accepted webhook payload size (bytes). */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Shop ID → internal name, derived from channel-config (single source of truth).
 * No duplicate hardcoded map is kept in this module.
 */
const SHOP_ID_TO_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(MERCARI_CHANNEL.shopIds).map(([name, id]) => [id, name]),
  ),
);

// ── Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MercariWebhookPayload
 * @property {string} topic
 * @property {string} shop_id
 * @property {string} order_transaction_id
 * @property {string} created_at
 */

// ── Helpers ────────────────────────────────────────────────────────────

function text(value) {
  return String(value == null ? "" : value).trim();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function err(msg, code, status = 400, retryable = false) {
  return json(
    { success: false, error: { code, message: msg, retryable } },
    status
  );
}

/**
 * Truncate an arbitrary string for logs. Keeps log output bounded and
 * PII-free (message content must never reach logs — identifiers and
 * error codes only).
 */
function sanitizeForLog(value, maxLength = 300) {
  const s = String(value == null ? "" : value).trim();
  if (s.length <= maxLength) return s;
  return `${s.slice(0, maxLength)}…`;
}

/**
 * Constant-time string comparison for shared secrets.
 * Prevents timing side-channel attacks on auth tokens.
 */
export function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function normalizeWebhookTopic(topic) {
  const t = String(topic || "").trim();
  if (t === "ORDER_TRANSACTION_MESSAGE_CREATED") return MESSAGE_CREATED_TOPIC;
  return t;
}

function normalizeOrderId(value) {
  return String(value || "").trim().replace(/^order_/, "");
}

function isSupabaseBackend(env) {
  return String(env?.DATABASE_BACKEND || "").trim().toLowerCase() === "supabase";
}

function isFeatureEnabled(env, flag) {
  const val = String(env[flag] || "").trim().toLowerCase();
  return val === "true" || val === "1" || val === "yes";
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validate the raw webhook payload against the known contract.
 * @param {MercariWebhookPayload} body
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateWebhookPayload(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Invalid JSON" };
  }
  if (!body.topic || !body.shop_id || !body.order_transaction_id || !body.created_at) {
    return {
      valid: false,
      error: "Missing required fields: topic, shop_id, order_transaction_id, created_at",
    };
  }
  const topic = normalizeWebhookTopic(body.topic);
  if (topic !== MESSAGE_CREATED_TOPIC) {
    return { valid: false, error: `Unsupported topic: ${body.topic}` };
  }
  const shopName = SHOP_ID_TO_NAME[String(body.shop_id).trim()];
  if (!shopName) {
    return { valid: false, error: `Unknown shop_id: ${body.shop_id}` };
  }
  const createdAtMs = Date.parse(String(body.created_at).trim());
  if (!Number.isFinite(createdAtMs)) {
    return { valid: false, error: "created_at must be a valid ISO-8601 timestamp" };
  }
  return { valid: true, shopName, topic };
}

// ── Durable Insert ─────────────────────────────────────────────────────

/**
 * Insert a durable webhook event receipt with idempotency protection.
 * Returns the inserted row id or throws on duplicate (23505).
 *
 * @param {Object} supabase - Supabase client
 * @param {Object} payload - row data
 * @returns {Promise<string>} inserted row id
 */
async function insertWebhookEvent(supabase, payload) {
  const { data, error } = await supabase
    .from("order_management_message_webhook_event")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("DUPLICATE: Event already persisted"), { code: "DUPLICATE" });
    }
    throw new Error(`supabase_webhook_insert_failed:${error.message}`);
  }

  return data.id;
}

// ── Async Processing ──────────────────────────────────────────────────

/**
 * Fetch full order transaction messages via the VPS relay.
 * Handles the notification-only webhook contract.
 *
 * @param {Object} env - Worker env
 * @param {string} shopLabel - internal shop label (Shop1-4)
 * @param {string} orderTransactionId - Mercari order_transaction_id
 * @returns {Promise<{ ok: boolean, messages: Array, error?: string }>}
 */
async function fetchOrderTransaction(env, shopLabel, orderTransactionId) {
  const relayResult = await runMercariOrderMessagesViaRelay(env, {
    shopLabel,
    orderId: orderTransactionId,
  });

  if (!relayResult.ok || !relayResult.body || !relayResult.body.ok) {
    const errMsg = (relayResult.body && relayResult.body.error) || "mercari_graphql_error";
    return { ok: false, messages: [], error: errMsg };
  }

  return { ok: true, messages: relayResult.body.messages || [] };
}

/**
 * Process a webhook event asynchronously after durable receipt.
 *
 * 1. Claim the event row (pending → processing)
 * 2. Check feature flag WEBHOOK_INTAKE_ENABLED
 * 3. Resolve shop label via trusted config
 * 4. Look up order in sales_orders, check scope
 * 5. Fetch full conversation via relay
 * 6. writeThroughMessageFacts to persist facts
 * 7. Update webhook event row with result
 *
 * Returns an explicit outcome object so callers (retryStuckWebhookEvents)
 * can count true processed/failed/skipped results instead of assuming every
 * invocation completed:
 *
 *   { status: "processed" }     fully processed
 *   { status: "skipped" }       intake feature flag off
 *   { status: "out_of_scope" }  order not in the webhook scope
 *   { status: "failed" }        terminal failure (attempts exhausted / non-retryable)
 *   { status: "pending_retry" } retryable failure reset to pending
 *   { status: "lost_claim" }    another worker won the atomic claim
 *   { status: "claim_error" }   claim RPC failed
 *   { status: "unavailable" }   Supabase backend not configured
 *   { status: "error" }         unexpected exception during processing
 *
 * @param {Object} env - Worker env
 * @param {string} webhookEventId - UUID of the durable receipt row
 * @returns {Promise<{status: string, error?: string}>}
 */
export async function processWebhookEvent(env, webhookEventId) {
  if (!isSupabaseBackend(env)) {
    console.warn("[webhook] Supabase backend required for webhook processing");
    return { status: "unavailable" };
  }

  const client = createBaserowClient(env);
  const supabase = client.supabase;

  try {
    // 1. Atomically claim the event row via RPC. The RPC transitions
    //    pending → processing (and reclaims rows stuck in processing after
    //    the stale grace window) and returns the row only if THIS worker
    //    won the claim. A concurrent worker claiming the same id gets no
    //    row, and attempts-exhausted rows are never claimed again.
    const { data: claimed, error: claimError } = await supabase.rpc(
      "claim_order_mgmt_webhook_event",
      { event_id: webhookEventId, max_attempts: MAX_PROCESSING_ATTEMPTS },
    );

    if (claimError) {
      // Error-code only — never log event/row identifiers.
      const code = String(claimError.message || "claim_failed").slice(0, 300);
      console.error(`[webhook] Failed to claim event: ${code}`);
      return { status: "claim_error", error: code };
    }

    const row = Array.isArray(claimed) && claimed.length > 0 ? claimed[0] : null;
    if (!row) {
      // Already claimed by another worker, or retry attempts exhausted.
      return { status: "lost_claim" };
    }

    // 2. Feature flag check
    if (!isFeatureEnabled(env, "WEBHOOK_INTAKE_ENABLED")) {
      await supabase
        .from("order_management_message_webhook_event")
        .update({
          processing_status: "skipped",
          processing_completed_at: new Date().toISOString(),
          processing_error: "webhook_intake_disabled",
          metrics: { ...row.metrics, skipped_reason: "feature_flag_off" },
        })
        .eq("id", webhookEventId);
      return { status: "skipped" };
    }

    const {
      shop_id: shopId,
      order_transaction_id: orderTransactionId,
      shop_name: shopLabel,
    } = row;

    // 3. Resolve shop label from trusted config
    let resolvedLabel = shopLabel;
    if (!resolvedLabel) {
      resolvedLabel = SHOP_ID_TO_NAME[shopId];
    }

    if (!resolvedLabel) {
      const outcome = await markEventFailed(supabase, webhookEventId, "unknown_shop_id", false, row.metrics);
      return { status: outcome };
    }

    // 4. Check order scope
    const normalizedOrderId = normalizeOrderId(orderTransactionId);
    const { data: salesOrder, error: salesError } = await supabase
      .from("sales_orders")
      .select("id, order_status")
      .eq("sales_channel", "mercari")
      .eq("source_store_id", shopId)
      .eq("order_id", normalizedOrderId)
      .limit(1)
      .maybeSingle();

    if (salesError) {
      const outcome = await markEventFailed(supabase, webhookEventId,
        `sales_order_lookup_failed:${salesError.message}`, true, row.metrics);
      return { status: outcome };
    }

    if (!salesOrder) {
      await markEventOutOfScope(supabase, webhookEventId, "order_not_found_in_sales_orders", row.metrics);
      return { status: "out_of_scope" };
    }

    const orderStatus = String(salesOrder.order_status || "").trim().toUpperCase();
    const inScope = SCOPE_STATUSES.has(orderStatus);

    await supabase
      .from("order_management_message_webhook_event")
      .update({
        order_id: normalizedOrderId,
        order_status_at_event: orderStatus,
        in_scope: inScope,
      })
      .eq("id", webhookEventId);

    if (!inScope) {
      await markEventOutOfScope(supabase, webhookEventId, `order_status_${orderStatus}`, row.metrics);
      return { status: "out_of_scope" };
    }

    // 5. Fetch full conversation via relay (notification-only event)
    const fetchResult = await fetchOrderTransaction(env, resolvedLabel, orderTransactionId);

    if (!fetchResult.ok) {
      const outcome = await markEventFailed(supabase, webhookEventId,
        `fetch_conversation_failed:${fetchResult.error}`, true, row.metrics);
      return { status: outcome };
    }

    // 6. writeThroughMessageFacts — updates sales_orders + sales_order_message_state
    //    Never modifies read cursor (last_read_message_id)
    try {
      const writeResult = await writeThroughMessageFacts(
        env, shopId, normalizedOrderId, fetchResult.messages
      );

      const completedAt = new Date().toISOString();
      const latencyMs = new Date(completedAt).getTime() - new Date(row.server_received_at).getTime();

      const updatedMetrics = {
        ...row.metrics,
        latency_ms: latencyMs,
        messages_count: fetchResult.messages.length,
        facts: {
          has_buyer_messages: writeResult.facts.has_buyer_messages,
          latest_buyer_message_id: writeResult.facts.latest_buyer_message_id,
        },
      };

      await supabase
        .from("order_management_message_webhook_event")
        .update({
          processing_status: "processed",
          processing_completed_at: completedAt,
          processing_error: null,
          buyer_message_id: writeResult.facts.latest_buyer_message_id || null,
          metrics: updatedMetrics,
        })
        .eq("id", webhookEventId);

      // Update message_state with webhook timestamps
      await supabase
        .from("sales_order_message_state")
        .update({
          last_webhook_received_at: row.server_received_at,
          last_webhook_processed_at: completedAt,
        })
        .eq("source_store_id", shopId)
        .eq("order_transaction_id", normalizedOrderId);

      return { status: "processed" };
    } catch (writeError) {
      const errMsg = (writeError && (writeError.message || String(writeError))) || "write_facts_failed";
      const outcome = await markEventFailed(supabase, webhookEventId, errMsg, true, row.metrics);
      return { status: outcome };
    }
  } catch (e) {
    const errMsg = (e && (e.message || String(e))) || "process_event_failed";
    // Error-code only — never log event/row identifiers.
    console.error(`[webhook] Processing failed: ${sanitizeForLog(errMsg)}`);
    try {
      const outcome = await markEventFailed(
        supabase, webhookEventId, errMsg,
        e.code !== "DUPLICATE", (e.metrics || {})
      );
      return { status: outcome };
    } catch (_) { /* best effort */ }
    return { status: "error", error: sanitizeForLog(errMsg) };
  }
}

/**
 * Mark an event row failed. Retryable failures below the attempts cap are
 * reset to `pending` for the next scheduled retry; otherwise the row is
 * terminal `failed` and must never be reclaimed.
 *
 * @returns {Promise<"failed"|"pending_retry">} terminal or retry-pending outcome
 */
async function markEventFailed(supabase, webhookEventId, errorMessage, retryable, metrics = {}) {
  const attempts = await getCurrentAttempts(supabase, webhookEventId);
  // Terminal after MAX_PROCESSING_ATTEMPTS — the row must never be reclaimed
  // again. Retryable failures below the cap are reset to pending for the
  // next scheduled retry.
  const isTerminal = !(retryable && attempts < MAX_PROCESSING_ATTEMPTS);
  const completedAt = new Date().toISOString();

  await supabase
    .from("order_management_message_webhook_event")
    .update({
      processing_status: isTerminal ? "failed" : "pending",
      processing_completed_at: isTerminal ? completedAt : null,
      processing_error: String(errorMessage).slice(0, 1000),
      metrics: {
        ...metrics,
        failed_at: completedAt,
        retryable,
        attempts_before_reset: attempts,
        attempts_remaining: Math.max(0, MAX_PROCESSING_ATTEMPTS - attempts),
      },
    })
    .eq("id", webhookEventId);

  return isTerminal ? "failed" : "pending_retry";
}

async function markEventOutOfScope(supabase, webhookEventId, reason, metrics = {}) {
  await supabase
    .from("order_management_message_webhook_event")
    .update({
      processing_status: "out_of_scope",
      processing_completed_at: new Date().toISOString(),
      processing_error: reason,
      metrics: { ...metrics, out_of_scope_reason: reason },
    })
    .eq("id", webhookEventId);
}

async function getCurrentAttempts(supabase, webhookEventId) {
  try {
    const { data } = await supabase
      .from("order_management_message_webhook_event")
      .select("processing_attempts")
      .eq("id", webhookEventId)
      .single();
    return (data && data.processing_attempts) || 0;
  } catch {
    return 0;
  }
}

// ── Retry: Claim and process failed/pending rows ───────────────────────

/**
 * Claim and process up to `limit` stuck pending webhook event rows.
 * Each row is claimed atomically inside processWebhookEvent (RPC), so
 * concurrent retry runs cannot double-process a row.
 *
 * Counts are derived from processWebhookEvent's explicit outcome, never from
 * "the call returned". A worker that loses the claim, is skipped, or ends
 * pending/failed is counted as such — it is never counted as completed.
 *
 * Folded into the sync_mercari_messages phase: retry only runs when the
 * webhook intake feature is enabled (webhook-primary mode).
 *
 * @param {Object} env - Worker env
 * @param {number} [limit=10]
 * @returns {Promise<{ claimed: number, processed: number, failed: number, skipped: number, lost_claim: number }>}
 */
export async function retryStuckWebhookEvents(env, limit = 10) {
  if (!isSupabaseBackend(env)) {
    return { claimed: 0, processed: 0, failed: 0, skipped: 0, lost_claim: 0 };
  }
  if (!isFeatureEnabled(env, "WEBHOOK_INTAKE_ENABLED")) {
    return { claimed: 0, processed: 0, failed: 0, skipped: 0, lost_claim: 0 };
  }

  const client = createBaserowClient(env);
  const supabase = client.supabase;

  // Load pending rows (includes failed rows that were reset to pending for retry)
  const { data: candidates, error } = await supabase
    .from("order_management_message_webhook_event")
    .select("id, processing_attempts")
    .in("processing_status", ["pending"])
    .lt("processing_attempts", MAX_PROCESSING_ATTEMPTS)
    .order("server_received_at", { ascending: true })
    .limit(limit);

  if (error || !candidates || candidates.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, skipped: 0, lost_claim: 0 };
  }

  // Aggregate counts only — never log event/row identifiers.
  console.log(`[webhook-retry] Claiming ${candidates.length} rows for processing`);

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let lostClaim = 0;

  for (const row of candidates) {
    let outcome;
    try {
      outcome = await processWebhookEvent(env, row.id);
    } catch (e) {
      const errMsg = (e && (e.message || String(e))) || "process_event_threw";
      console.error(`[webhook-retry] Processing threw: ${sanitizeForLog(errMsg)}`);
      failed++;
      continue;
    }

    const status = outcome && outcome.status;
    switch (status) {
      case "processed":
        processed++;
        break;
      case "skipped":
      case "unavailable":
        skipped++;
        break;
      case "lost_claim":
        lostClaim++;
        break;
      case "failed":
      case "pending_retry":
      case "claim_error":
      case "error":
      default:
        failed++;
        break;
    }
  }

  console.log(
    `[webhook-retry] Batch complete — ${processed} processed, ${failed} failed, ${skipped} skipped, ${lostClaim} lost claims`
  );
  return { claimed: candidates.length, processed, failed, skipped, lost_claim: lostClaim };
}

// ── Reconcile: detect webhook misses from polling ──────────────────────

/**
 * Check if a webhook event covered a given buyer message discovered by polling.
 * Used by syncMercariMessages to report webhook delivery gaps.
 *
 * @param {Object} env - Worker env
 * @param {string} shopId
 * @param {string} orderId - normalized (no order_ prefix)
 * @param {string} buyerMessageId
 * @returns {Promise<{ covered: boolean, eventCount: number }>}
 */
export async function checkWebhookCoverage(env, shopId, orderId, buyerMessageId) {
  if (!buyerMessageId || !isSupabaseBackend(env)) {
    return { covered: false, eventCount: 0 };
  }

  const client = createBaserowClient(env);
  const { data, error } = await client.supabase
    .from("order_management_message_webhook_event")
    .select("id, buyer_message_id", { count: "exact", head: false })
    .eq("shop_id", shopId)
    .eq("order_id", orderId)
    .eq("processing_status", "processed")
    .order("server_received_at", { ascending: false });

  if (error) return { covered: false, eventCount: 0 };

  const events = Array.isArray(data) ? data : [];
  const covered = events.some((e) => e.buyer_message_id === buyerMessageId);

  return { covered, eventCount: events.length };
}

// ── Route handler ──────────────────────────────────────────────────────

/**
 * Handle POST /webhooks/mercari-message — the webhook intake endpoint.
 *
 * @param {Request} request
 * @param {Object} env - Worker env
 * @param {ExecutionContext} ctx - Worker execution context
 * @returns {Promise<Response>}
 */
export async function handleMercariMessageWebhook(request, env, ctx) {
  // 0. Auth guard — Bearer header, constant-time comparison, no query-string secret.
  //    Dedicated forward secret: Ticket Handling authenticates outbound forwards
  //    with the paired ORDERMGMT_WEBHOOK_FORWARD_SECRET.
  const expectedSecret = String(env.WEBHOOK_FORWARD_SECRET || "").trim();
  if (!expectedSecret) {
    return err("Webhook endpoint disabled — WEBHOOK_FORWARD_SECRET not configured", "DISABLED", 503);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = bearerMatch ? bearerMatch[1].trim() : "";

  if (!providedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return err("Unauthorized", "UNAUTHORIZED", 401);
  }

  // 1. Body-size bound — reject oversized payloads before parsing
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return err("Payload too large", "PAYLOAD_TOO_LARGE", 413);
  }

  // 2. Parse JSON
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON", "VALIDATION_ERROR", 400);
  }

  const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (bodyBytes > MAX_WEBHOOK_BODY_BYTES) {
    return err("Payload too large", "PAYLOAD_TOO_LARGE", 413);
  }

  // 3. Validate payload
  const validation = validateWebhookPayload(body);
  if (!validation.valid) {
    return err(validation.error, "VALIDATION_ERROR", 400);
  }

  const { shopName, topic } = validation;
  const shopId = String(body.shop_id).trim();
  const orderTransactionId = String(body.order_transaction_id).trim();
  const createdAt = String(body.created_at).trim();
  const idempotencyKey = `webhook:${shopId}:${orderTransactionId}:${createdAt}`;
  const serverReceivedAt = new Date().toISOString();

  // 3. Durable insert — idempotency backed by UNIQUE constraint
  if (!isSupabaseBackend(env)) {
    return err("Supabase backend required", "DB_UNAVAILABLE", 503);
  }

  const client = createBaserowClient(env);
  const supabase = client.supabase;

  let webhookEventId;
  try {
    webhookEventId = await insertWebhookEvent(supabase, {
      idempotency_key: idempotencyKey,
      source: "mercari_webhook",
      topic: topic,
      shop_id: shopId,
      shop_name: shopName,
      order_transaction_id: orderTransactionId,
      webhook_received_at: createdAt,
      server_received_at: serverReceivedAt,
      processing_status: "pending",
      processing_attempts: 0,
      is_duplicate: false,
      metrics: {},
    });
  } catch (e) {
    if (e.code === "DUPLICATE") {
      return json({ status: "duplicate", message: "Event already persisted" }, 200);
    }
    console.error(`[webhook] Supabase insert failed: ${sanitizeForLog(e.message)}`);
    return err(`Supabase insert failed: ${sanitizeForLog(e.message)}`, "DB_ERROR", 500, true);
  }

  // 4. Process asynchronously — runs after response is sent
  ctx.waitUntil(processWebhookEvent(env, webhookEventId));

  // 5. Return 2xx immediately — the event is durable
  return json(
    {
      success: true,
      status: "ok",
      transaction_id: orderTransactionId,
      event_id: webhookEventId,
    },
    200
  );
}
