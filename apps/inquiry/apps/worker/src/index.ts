import type { Env } from "./env";
import type { MasterHandlerOptions } from "./jobs/master-handler";
import { runMasterHandler } from "./jobs/master-handler";
import { getConfig } from "./config";
import { createSupabaseAdapter } from "./adapters/supabase";
import { createLogger } from "./utils/logger";
import { STATUS_RECEIVED } from "./config";
import { createRunResult, resolveRunStatus, addErrorSample } from "./jobs/run-result";
import { createMercariPersistence } from "./mercari/persistence";
import { createMercariRelay } from "./mercari/relay";
import { ingestWebhook } from "./mercari/webhook";
import { processNextEvent } from "./mercari/processor";
import { runDailyAudit } from "./mercari/audit";
import { timingSafeEqual } from "./mercari/identity";

const MERCARI_SHOP_KEYS = ["shop1", "shop2", "shop3", "shop4"];

/** Maximum replay window in hours. */
const MAX_REPLAY_HOURS = 72;
/** Maximum replay pages. */
const MAX_REPLAY_PAGES = 20;
/** Default replay batch size per page. */
const REPLAY_PAGE_SIZE = 50;

export { JobStateDO } from "./state/JobStateDO";

function authGuard(request: Request, env: Env): boolean {
  const config = getConfig(env);
  if (!config.runtime.adminToken) return false;
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === config.runtime.adminToken;
}

function authError(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function auditAuthGuard(request: Request, env: Env): boolean {
  if (authGuard(request, env)) return true;
  const configured = env.INQUIRY_AUDIT_ADMIN_TOKEN?.trim() ?? "";
  const token = (request.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "");
  return Boolean(configured) && timingSafeEqual(token, configured);
}

function parseInquiryIds(url: URL): number[] | undefined {
  const raw = url.searchParams.get("inquiryIds");
  if (!raw) return undefined;
  return raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
}

async function handleHealth(env: Env): Promise<Response> {
  return new Response(
    JSON.stringify({
      ok: true,
      name: "inquiry-automation-worker",
      version: "0.1.0",
      dryRun: getConfig(env).runtime.dryRun,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function handleRun(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authGuard(request, env)) return authError();

  const url = new URL(request.url);
  const dryRunParam = url.searchParams.get("dryRun");
  const step = url.searchParams.get("step") ?? "all";
  const limitParam = url.searchParams.get("limit");
  const inquiryIds = parseInquiryIds(url);
  const forceParam = url.searchParams.get("force");

  const dryRun = dryRunParam !== null ? dryRunParam !== "false" : undefined;
  const limit = limitParam !== null ? parseInt(limitParam, 10) : undefined;
  const forceRegenerate = forceParam !== null ? forceParam === "true" : undefined;

  if (!["classify", "all"].includes(step)) {
    return new Response(
      JSON.stringify({ error: "invalid step", allowed: ["classify", "all"] }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const masterOpts: MasterHandlerOptions = { dryRun, limit, inquiryIds, forceRegenerate };

  try {
    let classifyResult: unknown = null;

    if (step === "classify" || step === "all") {
      classifyResult = await runMasterHandler(env, masterOpts);
    }

    // Use classify result as the primary structured response
    const primary = classifyResult as Record<string, unknown> | null;

    return new Response(
      JSON.stringify({
        status: primary?.status ?? "completed",
        runId: primary?.runId ?? `run-${Date.now()}`,
        step,
        classify: classifyResult,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Authenticated replay: re-process inquiries in a bounded time window.
 *
 * Deduplication remains enabled by default. The existing DO lock prevents
 * overlap with scheduled ingestion. Returns structured run results.
 *
 * Production invocation (without secrets in shell history):
 *   curl -X POST "https://<worker>/admin/replay?recentHours=24&dryRun=false&maxPages=3" \
 *     -H "Authorization: Bearer $ADMIN_TOKEN"
 */
async function handleReplay(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const config = getConfig(env);
  const supabase = createSupabaseAdapter(config.supabase);

  const recentHours = parseInt(url.searchParams.get("recentHours") ?? "24", 10);
  const sinceParam = url.searchParams.get("since");
  const dryRun = url.searchParams.get("dryRun") !== "false";
  const maxPages = Math.min(
    parseInt(url.searchParams.get("maxPages") ?? "5", 10),
    MAX_REPLAY_PAGES,
  );

  // Enforce max window
  if (recentHours > MAX_REPLAY_HOURS && !sinceParam) {
    return new Response(
      JSON.stringify({
        error: `recentHours exceeds maximum of ${MAX_REPLAY_HOURS}`,
        maxAllowed: MAX_REPLAY_HOURS,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Resolve the `since` timestamp
  let sinceISO: string;
  if (sinceParam) {
    sinceISO = new Date(sinceParam).toISOString();
    const maxAgo = new Date(Date.now() - MAX_REPLAY_HOURS * 3600 * 1000);
    if (new Date(sinceISO).getTime() < maxAgo.getTime()) {
      return new Response(
        JSON.stringify({
          error: `since exceeds maximum window of ${MAX_REPLAY_HOURS}h ago`,
          earliest: maxAgo.toISOString(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  } else {
    sinceISO = new Date(Date.now() - recentHours * 3600 * 1000).toISOString();
  }

  const runId = `replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const log = createLogger(runId, "replay");
  const jobState = env.JOB_STATE.get(env.JOB_STATE.idFromName("master-handler"));
  const LOCK_TTL_MS = 300000;

  // Prevent overlap with scheduled ingestion
  const locked = await jobState.acquireLock(LOCK_TTL_MS);
  if (!locked) {
    return new Response(
      JSON.stringify({ error: "Lock held — try again later" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  const overallResult = createRunResult(runId, "replay", {
    dryRun,
    window: { type: "replay", sinceHours: recentHours, maxPages },
    totalPages: maxPages,
    cursorBefore: await jobState.getCompoundCursor(),
  });

  let totalFetched = 0;
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalFailed = 0;
  let totalDeduplicated = 0;
  const allSkippedReasons: Record<string, number> = {};
  const allErrorSamples: string[] = [];

  try {
    for (let page = 1; page <= maxPages; page++) {
      log.info("Replay page", { page, maxPages, sinceISO, dryRun });

      const rows = await supabase.fetchInquiriesByWindow(
        STATUS_RECEIVED,
        REPLAY_PAGE_SIZE,
        sinceISO,
        undefined, // untilISO — not enforced
        page,
      );

      if (rows.length === 0) {
        log.info("Replay — no more rows", { page });
        overallResult.totalPages = page - 1;
        break;
      }

      totalFetched += rows.length;

      // Reuse master-handler processing on each row
      for (const row of rows) {
        // Run the normal master handler with explicit inquiry IDs
        // This preserves all deduplication and classification logic
        const pageResult = await runMasterHandler(env, {
          inquiryIds: [row.id],
          dryRun,
          limit: 1,
          skipLock: true, // replay handler already holds the lock
        });

        totalProcessed += pageResult.processed;
        totalUpdated += pageResult.updated;
        totalFailed += pageResult.failed;
        totalDeduplicated += pageResult.deduplicated;

        for (const [reason, count] of Object.entries(pageResult.skippedByReason)) {
          allSkippedReasons[reason] = (allSkippedReasons[reason] ?? 0) + count;
        }
        for (const err of pageResult.errorSamples) {
          if (allErrorSamples.length < 5) allErrorSamples.push(err);
        }
      }

      // Renew the lock after each page to prevent expiration during long replays
      await jobState.renewLock();

      if (rows.length < REPLAY_PAGE_SIZE) {
        // Last page
        overallResult.totalPages = page;
        break;
      }
    }

    overallResult.rowsFetched = totalFetched;
    overallResult.processed = totalProcessed;
    overallResult.updated = totalUpdated;
    overallResult.failed = totalFailed;
    overallResult.deduplicated = totalDeduplicated;
    overallResult.skippedByReason = allSkippedReasons;
    overallResult.errorSamples = allErrorSamples;
    overallResult.cursorAfter = await jobState.getCompoundCursor();
    overallResult.status = resolveRunStatus(totalFailed, null);
    overallResult.finishedAt = new Date().toISOString();

    await jobState.appendRunHistory(overallResult);

    log.info("Replay complete", {
      pages: overallResult.totalPages,
      fetched: totalFetched,
      processed: totalProcessed,
      updated: totalUpdated,
      failed: totalFailed,
      deduplicated: totalDeduplicated,
    });

    return new Response(JSON.stringify(overallResult, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    overallResult.status = "error";
    overallResult.errorSamples = addErrorSample(allErrorSamples, message);
    overallResult.finishedAt = new Date().toISOString();
    await jobState.appendRunHistory(overallResult);

    return new Response(
      JSON.stringify({ error: message, result: overallResult }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    await jobState.releaseLock();
  }
}

async function handleAdminRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/")) return null;
  if (
    url.pathname === "/admin/mercari-audit" ||
    url.pathname === "/admin/mercari-webhook-status"
  ) {
    if (!auditAuthGuard(request, env)) return authError();
  } else if (!authGuard(request, env)) {
    return authError();
  }

  if (url.pathname === "/admin/reset-cursor" && request.method === "POST") {
    const jobName = url.searchParams.get("job") ?? "master-handler";
    const to = url.searchParams.get("to") ?? getConfig(env).cursor.defaultCursor;

    const jobState = env.JOB_STATE.get(env.JOB_STATE.idFromName(jobName));
    // Reset both legacy and compound cursor so getCompoundCursor()
    // picks up the new value (not the stale compound cursor).
    await jobState.setCursor(to);
    await jobState.setCompoundCursor({ inquiryDate: to, id: 0 });

    return new Response(
      JSON.stringify({ status: "ok", job: jobName, cursor: to, compoundCursor: { inquiryDate: to, id: 0 } }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  if (url.pathname === "/admin/state" && request.method === "GET") {
    const jobName = url.searchParams.get("job") ?? "master-handler";
    const jobState = env.JOB_STATE.get(env.JOB_STATE.idFromName(jobName));
    const state = await jobState.getState();

    return new Response(JSON.stringify(state, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/admin/release-lock" && request.method === "POST") {
    const jobName = url.searchParams.get("job") ?? "master-handler";
    const jobState = env.JOB_STATE.get(env.JOB_STATE.idFromName(jobName));
    await jobState.releaseLock();

    return new Response(
      JSON.stringify({ status: "ok", job: jobName, action: "lock-released" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  if (url.pathname === "/admin/replay" && request.method === "POST") {
    return handleReplay(request, env);
  }

  if (url.pathname === "/admin/mercari-audit" && request.method === "POST") {
    const shopKey = url.searchParams.get("shop") ?? "";
    if (!MERCARI_SHOP_KEYS.includes(shopKey)) {
      return new Response(
        JSON.stringify({ error: "invalid shop", allowed: MERCARI_SHOP_KEYS }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const config = getConfig(env);
    try {
      const result = await runDailyAudit(
        shopKey,
        { auditWritesEnabled: config.mercari.auditWritesEnabled },
        createMercariPersistence(config.supabase),
        createMercariRelay({
          url: config.mercari.relayUrl,
          shopTokens: config.mercari.shopTokens,
        }),
      );
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Mercari audit canary failed", {
        shopKey,
        errorType: err instanceof Error ? err.name : typeof err,
      });
      return new Response(
        JSON.stringify({ error: "Mercari audit failed", shopKey }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  if (url.pathname === "/admin/mercari-webhook-status" && request.method === "GET") {
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;
    try {
      const config = getConfig(env);
      const snapshot = await createMercariPersistence(config.supabase).getWebhookStatus(limit);
      const byStatus: Record<string, number> = {};
      const byShop: Record<string, number> = {};
      const byTopic: Record<string, number> = {};
      for (const row of snapshot.recent) {
        byStatus[row.processing_status] = (byStatus[row.processing_status] ?? 0) + 1;
        byShop[row.shop_key] = (byShop[row.shop_key] ?? 0) + 1;
        byTopic[row.topic] = (byTopic[row.topic] ?? 0) + 1;
      }
      return new Response(JSON.stringify({
        total: snapshot.total,
        sampleSize: snapshot.recent.length,
        byStatus,
        byShop,
        byTopic,
        recent: snapshot.recent,
      }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      console.error("Mercari webhook status failed", {
        errorType: err instanceof Error ? err.name : typeof err,
      });
      return new Response(
        JSON.stringify({ error: "Mercari webhook status failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  if (url.pathname === "/admin/status" && request.method === "GET") {
    const jobName = url.searchParams.get("job") ?? "master-handler";
    const limit = parseInt(url.searchParams.get("limit") ?? "5", 10);
    const jobState = env.JOB_STATE.get(env.JOB_STATE.idFromName(jobName));

    const recentRuns = await jobState.getRecentRunHistory(limit);
    const fullState = await jobState.getState();

    // Return operational status without secrets or message bodies
    return new Response(
      JSON.stringify({
        job: jobName,
        cursor: fullState.compoundCursor,
        locked: Boolean(fullState.lockedUntil),
        recentRuns: recentRuns.map((r) => ({
          runId: r.runId,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          status: r.status,
          processed: r.processed,
          updated: r.updated,
          created: r.created,
          failed: r.failed,
          deduplicated: r.deduplicated,
          rowsFetched: r.rowsFetched,
          llmCalls: r.llmCalls,
          skippedByReason: r.skippedByReason,
          errorSamples: r.errorSamples,
          dryRun: r.dryRun,
        })),
      }, null, 2),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}

async function handleMercariWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = getConfig(env);
  const persistence = createMercariPersistence(config.supabase);
  const result = await ingestWebhook(
    request,
    {
      webhookSecrets: config.mercari.webhookSecrets,
      shopKeyHeader: config.mercari.shopKeyHeader,
      signatureHeader: config.mercari.signatureHeader,
      replayWindowSeconds: config.mercari.replayWindowSeconds,
      sharedSecret: config.mercari.webhookSharedSecret,
      shopIdMap: config.mercari.shopIdMap,
    },
    persistence,
  );
  if (result.response.ok && config.mercari.ingestWritesEnabled) {
    ctx.waitUntil(handleMercariProcess(env).then(() => undefined));
  }
  return result.response;
}

async function handleMercariProcess(env: Env): Promise<Response> {
  const config = getConfig(env);
  const persistence = createMercariPersistence(config.supabase);
  const transport = createMercariRelay({
    url: config.mercari.relayUrl,
    shopTokens: config.mercari.shopTokens,
  });
  const result = await processNextEvent(
    {
      workerId: "inquiry-automation-worker",
      ingestWritesEnabled: config.mercari.ingestWritesEnabled,
    },
    persistence,
    transport,
  );
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
}

async function runAllShopAudits(
  env: Env,
  options: { maxDiscoveryPages?: number } = {},
): Promise<void> {
  const config = getConfig(env);
  for (const shopKey of MERCARI_SHOP_KEYS) {
    try {
      await runDailyAudit(
        shopKey,
        {
          auditWritesEnabled: config.mercari.auditWritesEnabled,
          ...options,
        },
        createMercariPersistence(config.supabase),
        createMercariRelay({
          url: config.mercari.relayUrl,
          shopTokens: config.mercari.shopTokens,
        }),
      );
    } catch (err) {
      console.log(`Completeness audit failed for ${shopKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const config = getConfig(env);

    switch (controller.cron) {
      case "*/30 * * * *": {
        if (config.runtime.dryRun || !config.runtime.writesEnabled) {
          console.log("Cron skipped — dry-run or write kill switch is active");
          return;
        }
        ctx.waitUntil(runMasterHandler(env, { dryRun: false }).then(() => undefined));
        break;
      }
      case "15 * * * *": {
        // Bounded recovery path for prolonged webhook-delivery gaps. The full
        // daily audit remains the final completeness boundary; this hourly run
        // only inspects the newest two discovery pages per shop.
        ctx.waitUntil(runAllShopAudits(env, { maxDiscoveryPages: 2 }));
        break;
      }
      case "0 16 * * *": {
        // Daily completeness audit (01:00 JST). Runs even when the master-handler
        // write switch is off; it is gated by its own audit write kill switch.
        ctx.waitUntil(runAllShopAudits(env));
        break;
      }
      default:
        console.log(`Unknown cron schedule: ${controller.cron}`);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname === "/run" && request.method === "POST") {
      return handleRun(request, env);
    }

    if (url.pathname === "/webhooks/mercari-inquiry" && request.method === "POST") {
      return handleMercariWebhook(request, env, ctx);
    }

    const adminResponse = await handleAdminRoutes(request, env, ctx);
    if (adminResponse) return adminResponse;

    if (url.pathname === "/admin/mercari-process" && request.method === "POST") {
      if (!authGuard(request, env)) return authError();
      return handleMercariProcess(env);
    }

    return new Response(
      JSON.stringify({
        name: "inquiry-automation-worker",
        version: "0.1.0",
        status: "ok",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};
