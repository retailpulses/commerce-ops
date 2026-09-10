/** Mercari webhook handlers — Issue #59 Phase 2 + Issue #109 queue integration
 *  + Issue #126: Durable webhook ingestion with owner-fenced enrichment.
 *
 *  POST /api/webhooks/mercari-message
 *  Receives order_transaction_message_created events, validates, inserts
 *  a raw durable row into Supabase immediately and returns 2xx. Enrichment
 *  and forwarding are claimed later by the active ingestion owner.
 */

import { fetchOrderTransaction } from "../clients/mercari";
import { getSupabaseClient } from "../repositories/supabase";
import { SupabaseInboundMessageRepository } from "../repositories/inboundMessageRepository";
import { SupabaseTicketRepository } from "../repositories/supabaseTicketRepository";
import { InboundMessageService } from "../services/inboundMessageService";
import { SHOP_TOKENS, MERCARI_SHOP_ID_TO_NAME } from "../config/shops";
import { classifyInboundTransaction } from "../services/inboundClassificationService";
import {
  runTicketFormRequestAutomation,
  SupabaseTicketFormAutomationStore,
} from "../services/ticketFormRequestService";
import type { Env, MercariTransaction } from "../types";

// ── Types ──

interface MercariWebhookPayload {
  topic: string;
  shop_id: string;
  order_transaction_id: string;
  created_at: string;
}

const MESSAGE_CREATED_TOPIC = "order_transaction_message_created";

function normalizeWebhookTopic(topic: string): string {
  if (topic === "ORDER_TRANSACTION_MESSAGE_CREATED") return MESSAGE_CREATED_TOPIC;
  return topic;
}

// ── Helpers ──

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function err(msg: string, code: string, status = 400, retryable = false): Response {
  return json(
    {
      success: false,
      error: { code, message: msg, retryable },
    },
    status
  );
}

// ── Enrichment (Issue #126: async, retryable, after durable insert) ──

/**
 * Enrich a raw inbound message row with full Mercari transaction data,
 * LLM classification, and auto-linking. Designed to be called:
 *   - from ctx.waitUntil() immediately after webhook insert
 *   - from the scheduled retry worker for stuck/failed rows
 *
 * On failure, updates processing_status to 'failed' (or 'pending' for retry)
 * so the row remains durable and operators can see it in the queue.
 */
export async function enrichInboundMessage(env: Env, inboundId: string): Promise<void> {
  const supabase = getSupabaseClient(env);
  const queueRepo = new SupabaseInboundMessageRepository(supabase);
  const ticketRepo = new SupabaseTicketRepository(supabase);
  const queueService = new InboundMessageService(queueRepo, ticketRepo, supabase);

  // 1. Load the raw inbound row
  const inbound = await queueRepo.getById(inboundId);
  if (!inbound) {
    console.error(`[enrich] Inbound row not found: ${inboundId}`);
    return;
  }
  if (inbound.processing_status === "completed") {
    // Already enriched (e.g., duplicate claim race) — skip
    return;
  }

  const { shop_name: shop, order_transaction_id: txId, shop_id: shopId } = inbound;
  if (inbound.source !== "mercari_webhook" || !shop || !txId || !shopId) {
    await queueRepo.markProcessingFailed(inboundId, "Non-Mercari or incomplete row reached Mercari enrichment", false);
    return;
  }

  // 2. Resolve shop token
  const tokenKey = SHOP_TOKENS[shop];
  if (!tokenKey) {
    await queueRepo.markProcessingFailed(inboundId, `No token key for shop: ${shop}`, false);
    return;
  }
  const token = env[tokenKey] as string;
  if (!token) {
    await queueRepo.markProcessingFailed(inboundId, `No token for shop: ${shop}`, true);
    return;
  }

  // 3. Fetch full order transaction via Mercari API
  let tx: MercariTransaction | undefined;
  try {
    const resp = await fetchOrderTransaction(token, txId);
    tx = resp.data?.orderTransaction as MercariTransaction | undefined;
  } catch (e) {
    await queueRepo.markProcessingFailed(inboundId, `Failed to fetch order transaction: ${e}`, true);
    return;
  }
  if (!tx) {
    await queueRepo.markProcessingFailed(inboundId, "Order transaction not found", false);
    return;
  }

  // 4. Classify directly from the Mercari conversation. This path is
  // intentionally independent of Baserow and cannot send a reply.
  let classificationMeta;
  try {
    classificationMeta = await classifyInboundTransaction(env, tx);
  } catch (e) {
    await queueRepo.markProcessingFailed(inboundId, `Classification failed: ${e}`, true);
    return;
  }

  // 5. Extract buyer info from transaction
  const txRaw = tx as unknown as Record<string, unknown>;
  const buyer = txRaw?.buyer as Record<string, unknown> | undefined;
  const products = (tx.products || []).map((product) => ({
    product_id: product.productId ?? null,
    sku: product.variant?.skuCode ?? null,
    purchased_quantity: product.purchasedQuantity ?? null,
  }));
  const messages = txRaw?.messages as Array<Record<string, unknown>> | undefined;
  const buyerMessages = messages?.filter((m) => m.role === "BUYER") ?? [];
  const latestBuyerMsg = buyerMessages.length > 0 ? buyerMessages[buyerMessages.length - 1] : null;

  // 6. Update the inbound row with enrichment data
  try {
    const { error: updateError } = await supabase
      .from("inbound_ticket_messages")
      .update({
        external_thread_id: (txRaw?.threadId as string) ?? null,
        customer_display_name: buyer?.nickname as string | undefined ?? null,
        product_summary: { products },
        order_summary: { order_status: txRaw?.status as string },
        latest_buyer_message: latestBuyerMsg?.message as string | undefined ?? null,
        full_payload: {
          webhook: {
            topic: MESSAGE_CREATED_TOPIC,
            shop_id: shopId,
            order_transaction_id: txId,
          },
          transaction: txRaw,
          messages: messages ?? [],
        },
        classification: classificationMeta as unknown as Record<string, unknown>,
        classifier_version: `${classificationMeta.model}::${classificationMeta.prompt_version}`,
        processing_error: null,
      })
      .eq("id", inboundId);
    if (updateError) throw updateError;
  } catch (e) {
    await queueRepo.markProcessingFailed(inboundId, `Supabase enrich update failed: ${e}`, true);
    return;
  }

  // 7. Decide and (only when explicitly enabled) send a TicketForm request.
  // This service has no ticket repository and cannot create a ticket.
  try {
    const outcome = await runTicketFormRequestAutomation({
      env,
      inboundId,
      shopName: shop,
      transaction: tx,
      classification: classificationMeta,
      mercariToken: token,
      store: new SupabaseTicketFormAutomationStore(supabase),
    });
    if (outcome.replyStatus === "failed" && outcome.retryable) {
      await queueRepo.markProcessingFailed(inboundId, `TicketForm request failed: ${outcome.reason}`, true);
      return;
    }
  } catch (e) {
    await queueRepo.markProcessingFailed(inboundId, `TicketForm automation failed: ${e}`, true);
    return;
  }

  // 8. Auto-link to existing tickets (link only; never create).
  try {
    const updated = await queueRepo.getById(inboundId);
    if (updated) {
      await queueService.autoLink(updated);
    }
  } catch (e) {
    // Auto-link failure is non-fatal — the row is already enriched and completed
    console.error(`[enrich] Auto-link failed for ${inboundId}: ${e}`);
  }

  await queueRepo.markProcessingComplete(inboundId);
}

// ── Handler ──

export async function handleMercariMessageWebhook(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  // 0. Auth guard
  const expectedSecret = env.WEBHOOK_SHARED_SECRET;
  if (!expectedSecret) {
    return err("Webhook endpoint disabled — WEBHOOK_SHARED_SECRET not configured", "DISABLED", 503);
  }
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const querySecret = url.searchParams.get("secret") || "";
  if (bearerMatch?.[1] !== expectedSecret && querySecret !== expectedSecret) {
    return err("Unauthorized", "UNAUTHORIZED", 401);
  }

  // 1. Parse JSON
  let body: MercariWebhookPayload;
  try {
    body = (await request.json()) as MercariWebhookPayload;
  } catch {
    return err("Invalid JSON", "VALIDATION_ERROR", 400);
  }

  // 2. Validate required fields
  if (!body.topic || !body.shop_id || !body.order_transaction_id || !body.created_at) {
    return err(
      "Missing required fields: topic, shop_id, order_transaction_id, created_at",
      "VALIDATION_ERROR",
      400
    );
  }
  const topic = normalizeWebhookTopic(body.topic);
  if (topic !== MESSAGE_CREATED_TOPIC) {
    return err(`Unsupported topic: ${body.topic}`, "VALIDATION_ERROR", 400);
  }

  // 3. Map shop_id to internal name
  const shop = MERCARI_SHOP_ID_TO_NAME[body.shop_id];
  if (!shop) {
    return err(`Unknown shop_id: ${body.shop_id}`, "VALIDATION_ERROR", 400);
  }

  // 4. Durable insert — Supabase idempotency_key UNIQUE constraint replaces KV dedup.
  //    Insert immediately with raw event data, processing_status = 'pending'.
  const idempotencyKey = `webhook:${body.shop_id}:${body.order_transaction_id}:${body.created_at}`;
  const supabase = getSupabaseClient(env);
  const serverReceivedAt = new Date().toISOString();

  let inboundId: string;

  try {
    const { data, error } = await supabase.rpc("ingest_mercari_webhook_event_v1", {
      p_shop_name: shop,
      p_shop_id: body.shop_id,
      p_order_transaction_id: body.order_transaction_id,
      p_webhook_received_at: body.created_at,
      p_server_received_at: serverReceivedAt,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      console.error(`[Webhook] Supabase insert failed: ${error.message}`);
      return err(`Supabase insert failed: ${error.message}`, "DB_ERROR", 500, true);
    }
    const result = data as { id?: string; inserted?: boolean } | null;
    if (!result?.id) return err("Supabase insert returned no durable id", "DB_ERROR", 500, true);
    if (result.inserted === false) {
      return json({ status: "duplicate", message: "Event already persisted" }, 200);
    }
    inboundId = result.id;
  } catch (e: unknown) {
    const errMsg = (e as Error).message ?? String(e);
    if (errMsg.startsWith("DUPLICATE:")) {
      return json({ status: "duplicate", message: "Event already persisted" }, 200);
    }
    console.error(`[Webhook] Supabase insert failed: ${errMsg}`);
    return err(`Supabase insert failed: ${errMsg}`, "DB_ERROR", 500, true);
  }

  // 5. Return 2xx immediately. Do not start background work from the intake
  // lease: the active owner later claims enrichment/forwarding under a work
  // lease, so a stale version cannot continue after handoff.
  return json(
    {
      status: "ok",
      transaction_id: body.order_transaction_id,
      inbound_id: inboundId,
    },
    200
  );
}
