/** Reconciliation scanner — Issue #126.
 *
 *  Compares recent Mercari transactions against inbound_ticket_messages
 *  and inserts any missing buyer-message events. Designed to catch
 *  webhook delivery gaps and provide a one-time backfill for July 11-current.
 *
 *  Called from:
 *    - handleCron: every scheduled run (lightweight rolling scan)
 *    - POST /api/admin/reconciliation-backfill: one-time deep backfill
 */

import { getUnrepliedTransactions } from "../clients/mercari";
import { getSupabaseClient } from "../repositories/supabase";
import { SHOP_IDS, SHOP_TOKENS } from "../config/shops";
import type { Env, MercariTransaction } from "../types";

export interface ReconciliationCounts {
  shop: string;
  scanned: number;
  inserted: number;
  duplicate: number;
  errors: number;
}

export interface ReconciliationReport {
  run_at: string;
  mode: "rolling" | "backfill";
  shops: ReconciliationCounts[];
  summary: {
    total_scanned: number;
    total_inserted: number;
    total_duplicate: number;
    total_errors: number;
    duration_ms: number;
  };
}

/**
 * Scan recent Mercari transactions and insert missing events.
 *
 * @param mode  "rolling" = lightweight (3 pages, 3-day lookback)
 *              "backfill" = deep (10 pages, 90-day lookback) for one-time recovery
 */
export async function reconcileMercariMessages(
  env: Env,
  mode: "rolling" | "backfill" = "rolling"
): Promise<ReconciliationReport> {
  const startTime = Date.now();
  const supabase = getSupabaseClient(env);
  const maxPages = mode === "backfill" ? 10 : 3;
  const maxAgeDays = mode === "backfill" ? 90 : 3;

  const shops: ReconciliationCounts[] = [];

  for (const [shop, envKey] of Object.entries(SHOP_TOKENS)) {
    const token = env[envKey] as string;
    if (!token) {
      console.log(`[Reconciliation] Skipping ${shop} — no token configured`);
      continue;
    }

    const counts: ReconciliationCounts = {
      shop,
      scanned: 0,
      inserted: 0,
      duplicate: 0,
      errors: 0,
    };

    try {
      // Reconciliation must include conversations where a seller already replied;
      // otherwise a buyer event can remain permanently absent from the audit trail.
      const result = await getUnrepliedTransactions(token, maxPages, maxAgeDays, true);

      const cutoffMs = Date.now() - (mode === "backfill" ? 3 : maxAgeDays) * 86_400_000;
      for (const tx of result.transactions) {
        if (!tx.id) continue;

        // Check if this transaction already has a buyer message in the queue
        const buyerMsgs = (tx.messages || []).filter((m) => m.role === "BUYER");
        if (!buyerMsgs.length) continue;

        for (const buyerMessage of buyerMsgs) {
          const messageAt = buyerMessage.createdAt || tx.createdAt;
          if (!messageAt || new Date(messageAt).getTime() < cutoffMs) continue;
          counts.scanned++;
          const shopId = SHOP_IDS[shop];
          const idempotencyKey = `webhook:${shopId}:${tx.id}:${messageAt}`;

          const { error: insertError } = await supabase
          .from("inbound_ticket_messages")
          .insert({
            source: "mercari_webhook",
            shop_name: shop,
            shop_id: shopId,
            order_transaction_id: tx.id,
            external_thread_id: null,
            customer_display_name: null,
            product_summary: {},
            order_summary: { order_status: tx.status },
            latest_buyer_message: buyerMessage.message || null,
            full_payload: {
              transaction: tx as unknown as Record<string, unknown>,
              messages: tx.messages || [],
            },
            classification: {},
            webhook_received_at: messageAt,
            server_received_at: new Date().toISOString(),
            idempotency_key: idempotencyKey,
            processing_status: "pending",
          });

          if (insertError) {
            if (insertError.code === "23505") {
              counts.duplicate++;
            } else {
              counts.errors++;
              console.error(`[Reconciliation] Insert failed for ${shop}/${tx.id}/${messageAt}: ${insertError.message}`);
            }
          } else {
            counts.inserted++;
          }
        }
      }

      console.log(
        `[Reconciliation] ${shop}: scanned=${counts.scanned} inserted=${counts.inserted} ` +
        `duplicate=${counts.duplicate} errors=${counts.errors}`
      );
    } catch (e) {
      console.error(`[Reconciliation] Error scanning ${shop}: ${e}`);
      counts.errors++;
    }

    shops.push(counts);
  }

  const durationMs = Date.now() - startTime;
  const summary = {
    total_scanned: shops.reduce((s, c) => s + c.scanned, 0),
    total_inserted: shops.reduce((s, c) => s + c.inserted, 0),
    total_duplicate: shops.reduce((s, c) => s + c.duplicate, 0),
    total_errors: shops.reduce((s, c) => s + c.errors, 0),
    duration_ms: durationMs,
  };

  console.log(
    `[Reconciliation] ${mode} complete — ${summary.total_inserted} inserted, ` +
    `${summary.total_duplicate} duplicate, ${summary.total_errors} errors, ${durationMs}ms`
  );

  return {
    run_at: new Date().toISOString(),
    mode,
    shops,
    summary,
  };
}
