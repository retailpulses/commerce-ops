/** Retry worker for stuck inbound message enrichment — Issue #126.
 *
 *  Called from handleCron every scheduled run to pick up rows where
 *  ctx.waitUntil() enrichment failed (e.g., timeout, transient error).
 *  Uses the same enrichInboundMessage function as the webhook path.
 *
 *  Row claiming (processing_status = 'processing') prevents concurrent
 *  webhook and cron enrichment from racing on the same row.
 */

import { SupabaseInboundMessageRepository } from "../repositories/inboundMessageRepository";
import { getSupabaseClient } from "../repositories/supabase";
import { enrichInboundMessage } from "./webhooks";
import { forwardPendingInboundMessages } from "../services/webhook-forwarder";
import type { Env } from "../types";
import type { ForwardStats } from "../services/webhook-forwarder";

export interface RetryStats {
  claimed: number;
  completed: number;
  failed: number;
}

/**
 * Claim and process up to `limit` stuck pending/failed inbound rows.
 * Safe to call concurrently — row-level claiming via processing_status update.
 */
export async function processStuckInboundMessages(
  env: Env,
  limit = 10
): Promise<RetryStats> {
  const supabase = getSupabaseClient(env);
  const repo = new SupabaseInboundMessageRepository(supabase);

  const claimed = await repo.claimPendingMercariForProcessing(limit);
  if (!claimed.length) {
    return { claimed: 0, completed: 0, failed: 0 };
  }

  console.log(`[RetryWorker] Claimed ${claimed.length} rows for enrichment`);

  let completed = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      await enrichInboundMessage(env, row.id);
      completed++;
    } catch (e) {
      failed++;
      const errMsg = (e as Error).message ?? String(e);
      console.error(`[RetryWorker] Enrichment threw for ${row.id}: ${errMsg}`);
      // Attempt to mark as failed — but don't let a repo error abort the batch
      try {
        await repo.markProcessingFailed(row.id, errMsg, true);
      } catch {
        // row may already be in a terminal state from enrichInboundMessage
      }
    }
  }

  console.log(`[RetryWorker] Batch complete — ${completed} completed, ${failed} failed`);
  return { claimed: claimed.length, completed, failed };
}

/**
 * Retry stuck OrderMgmt webhook forwarding (Issue #131).
 * Runs after enrichment retry so recovered rows also get forwarded.
 */
export async function processStuckWebhookForwarding(
  env: Env,
  limit = 10
): Promise<ForwardStats> {
  return forwardPendingInboundMessages(env, limit);
}
