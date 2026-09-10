// Shared pipeline runner — used by both Cloudflare Worker and local CLI.
// Extracted from worker/index.js and src/index.mjs to eliminate duplication.
//
// Exports: runPipeline, runPhase, executePhase, resolvePhases,
//          writePipelineRunAudit, extractCounts, phasesAreHourlyCore,
//          buildRunId, normalizePhaseName, parseInteger, resolveShops,
//          DEFAULT_SHOPS, PHASE_ALIASES, CORE_PHASES, RELAY_DEPENDENT_PHASES

import { createBaserowClient, createRow } from "./db.mjs";
import { runMercariIngestViaRelay, runMercariOrderMessagesViaRelay, runMercariShippingCloseViaRelay, checkRelayHealth } from "./mercari-relay.mjs";
import { runRakutenIngestViaRelay } from "./rakuten-relay.mjs";
import { runEndToEndReconcile } from "./end-to-end-reconcile.mjs";
import { runOutboundSync } from "./outbound-sync.mjs";
import { collectPipelineHealthSnapshot } from "./pipeline-health.mjs";
import { projectMercariSalesOrdersToShipment } from "./shipment-projector.mjs";
import { projectRakutenSalesOrdersToShipment } from "./rakuten-projector.mjs";
import { autoApproveMercariOrders } from "./auto-approval.mjs";
import { reconcileShippingInfo } from "./tracking-reconciler.mjs";
import { reconcileMercariCancellations } from "./cancellation-reconciler.mjs";
import { ingestRakutenOrders } from "./rakuten-ingest.mjs";
import { findConfirmedRakutenOrders } from "./rakuten-confirmer.mjs";
import { runRakutenConfirmOperations } from "./rakuten-confirm-operation.mjs";
import { syncMercariMessages } from "./buyer-messages.mjs";
import { sendPaymentReminders } from "./payment-reminders.mjs";
import { reconcileMercariLifecycle } from "./lifecycle-reconciler.mjs";
import { reconcileRakutenLifecycle } from "./rakuten-lifecycle-reconciler.mjs";
import { retryStuckWebhookEvents } from "./webhook-handler.mjs";
import { createEgressMetricsCollector } from "./egress-metrics.mjs";
import { requireLifecycleFreshness } from "./lifecycle-freshness.mjs";
import { MERCARI_CHANNEL } from "./channel-config.mjs";

// ── Constants ────────────────────────────────────────────────────
export const DEFAULT_SHOPS = ["Shop1", "Shop2", "Shop3", "Shop4"];

export const PHASE_ALIASES = {
  ingest: "pull_shop_orders",
  pull_shop_orders: "pull_shop_orders",
  project: "build_giga_shipments",
  project_shipment: "build_giga_shipments",
  build_giga_shipments: "build_giga_shipments",
  reconcile: "pull_giga_tracking",
  pull_giga_tracking: "pull_giga_tracking",
  reconcile_end_to_end: "reconcile_end_to_end",
  end_to_end: "reconcile_end_to_end",
  heal: "reconcile_end_to_end",
  syncback: "close_shop_orders",
  marketplace_syncback: "close_shop_orders",
  close_shop_orders: "close_shop_orders",
  "sync-outbound": "push_orders_to_giga",
  sync_outbound: "push_orders_to_giga",
  push_orders_to_giga: "push_orders_to_giga",
  reconcile_cancellations: "reconcile_cancellations",
  cancellation_reconcile: "reconcile_cancellations",
  eod_cancellation_scan: "reconcile_cancellations",
  // Auto-approval
  auto_approve: "auto_approve_orders",
  auto_approve_orders: "auto_approve_orders",
  // Message sync
  sync_messages: "sync_mercari_messages",
  sync_mercari_messages: "sync_mercari_messages",
  // Rakuten phases
  pull_rakuten_orders: "pull_rakuten_orders",
  confirm_rakuten_orders: "confirm_rakuten_orders",
  build_rakuten_shipments: "build_rakuten_shipments",
  push_rakuten_orders_to_giga: "push_rakuten_orders_to_giga",
  sync_rakuten_tracking: "sync_rakuten_tracking",
  pull_rakuten_tracking: "sync_rakuten_tracking",
  close_rakuten_orders: "close_rakuten_orders",
  // Payment reminders
  payment_reminders: "send_payment_reminders",
  send_payment_reminders: "send_payment_reminders",
  reconcile_order_lifecycle: "reconcile_order_lifecycle",
  reconcile_rakuten_lifecycle: "reconcile_rakuten_lifecycle",
  audit_pipeline_integrity: "audit_pipeline_integrity",
};

export const CORE_PHASES = ["pull_shop_orders", "build_giga_shipments", "push_orders_to_giga"];
export const RELAY_DEPENDENT_PHASES = new Set([
  "pull_shop_orders", "close_shop_orders", "sync_mercari_messages",
  "pull_rakuten_orders", "confirm_rakuten_orders", "close_rakuten_orders",
  "send_payment_reminders",
  "reconcile_order_lifecycle",
  "reconcile_rakuten_lifecycle",
]);
const MERCARI_FRESHNESS_GATED_PHASES = new Set([
  "auto_approve_orders", "build_giga_shipments", "push_orders_to_giga", "pull_giga_tracking", "close_shop_orders",
]);
const RAKUTEN_FRESHNESS_GATED_PHASES = new Set([
  "confirm_rakuten_orders", "build_rakuten_shipments", "push_rakuten_orders_to_giga",
  "sync_rakuten_tracking", "close_rakuten_orders",
]);

// ── Helpers ──────────────────────────────────────────────────────
export function parseInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function text(value) {
  return String(value ?? "").trim();
}

export function normalizePhaseName(raw) {
  // Worker parity: replace hyphens with underscores before alias lookup.
  // Worker uses text(value).replace(/-/g, "_"). text() trims and handles null/undefined.
  const key = text(raw).replace(/-/g, "_");
  return PHASE_ALIASES[key] || key;
}

export function resolveShops(shops) {
  // Worker parity: filter to known Shop1-4 only, split on commas/whitespace/semicolons.
  // Returns [] for falsy input (callers supply fallback chain, as Worker does).
  if (!shops) return [];
  const toList = (raw) =>
    String(raw || "")
      .split(/[,\s;]+/g)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((shop) => DEFAULT_SHOPS.includes(shop));
  if (Array.isArray(shops)) return shops.flatMap((s) => toList(s));
  return toList(shops);
}

export function buildRunId() {
  // Worker parity: decimal (not base36) timestamp.
  const rand = Math.random().toString(36).slice(2, 10);
  return `run_${Date.now()}_${rand}`;
}

export function phasesAreHourlyCore(phases) {
  return Array.isArray(phases) && phases.length === CORE_PHASES.length
    && CORE_PHASES.every((phase, index) => phases[index] === phase);
}

export function extractCounts(summary) {
  if (!summary || typeof summary !== "object") return {};
  if (summary.completion_state) {
    return {
      completion_state: summary.completion_state,
      ...(summary.counts && typeof summary.counts === "object" ? summary.counts : {}),
    };
  }
  const counts = summary.counts && typeof summary.counts === "object" ? summary.counts : null;
  if (counts) return counts;

  // syncMercariMessages: orders_checked, orders_synced, orders_failed at top level
  if (typeof summary.orders_checked === "number") {
    return {
      orders_checked: summary.orders_checked || 0,
      orders_synced: summary.orders_synced || 0,
      orders_failed: summary.orders_failed || 0,
    };
  }

  // autoApproveMercariOrders: rich top-level summary fields
  if (typeof summary.orders_evaluated === "number") {
    return {
      candidates_loaded: summary.candidates_loaded || 0,
      orders_evaluated: summary.orders_evaluated || 0,
      orders_approved: summary.orders_approved || 0,
      rows_approved: summary.rows_approved || 0,
      patch_failures: summary.patch_failures || 0,
      messages_sent: summary.messages_sent || 0,
      messages_skipped: summary.messages_skipped || 0,
      message_failures: summary.message_failures || 0,
    };
  }

  // Shipment projector: preserve the action breakdown instead of reducing a
  // successful run to only the length of its results array.
  if (typeof summary.processed_orders === "number"
    && typeof summary.created === "number"
    && typeof summary.updated === "number") {
    return {
      sales_rows_loaded: summary.sales_rows_loaded || 0,
      candidate_source_rows: summary.candidate_source_rows || 0,
      grouped_orders: summary.grouped_orders || 0,
      processed_orders: summary.processed_orders || 0,
      created: summary.created || 0,
      updated: summary.updated || 0,
      unchanged: summary.unchanged || 0,
      skipped: summary.skipped || 0,
      failed: summary.failed || 0,
      deduplicated: summary.deduplicated || 0,
    };
  }

  // Rakuten ingest: input_count, created, updated, unchanged, skipped, failed
  if (typeof summary.input_count === "number") {
    return {
      input_count: summary.input_count || 0,
      created: summary.created || 0,
      updated: summary.updated || 0,
      unchanged: summary.unchanged || 0,
      skipped: summary.skipped || 0,
      failed: summary.failed || 0,
    };
  }

  // Rakuten confirmation: total_confirmed_rows, marked_in_progress, etc.
  if (typeof summary.total_confirmed_rows === "number" || typeof summary.marked_in_progress === "number") {
    return {
      total_confirmed_rows: summary.total_confirmed_rows || 0,
      already_in_progress: summary.already_in_progress || 0,
      candidates: summary.candidates || 0,
      marked_in_progress: summary.marked_in_progress || 0,
      updated: summary.updated || 0,
      failed: summary.failed || 0,
    };
  }

  // Rakuten projector: sales_rows_loaded, shipment_rows_loaded, candidate_rows,
  // processed, created, updated, unchanged, skipped, failed (note: processed not processed_orders)
  if (typeof summary.sales_rows_loaded === "number"
    && typeof summary.shipment_rows_loaded === "number"
    && typeof summary.candidate_rows === "number") {
    return {
      sales_rows_loaded: summary.sales_rows_loaded || 0,
      shipment_rows_loaded: summary.shipment_rows_loaded || 0,
      candidate_rows: summary.candidate_rows || 0,
      processed: summary.processed || 0,
      created: summary.created || 0,
      updated: summary.updated || 0,
      unchanged: summary.unchanged || 0,
      skipped: summary.skipped || 0,
      failed: summary.failed || 0,
    };
  }

  // Rakuten closer: candidates, closed, failed, persistence_failures
  if (typeof summary.platform === "string" && typeof summary.closed === "number") {
    return {
      platform: summary.platform,
      candidates: summary.candidates || 0,
      closed: summary.closed || 0,
      failed: summary.failed || 0,
      persistence_failures: summary.persistence_failures || 0,
    };
  }

  // Rakuten confirm relay result: nested confirm/marked structure
  if (summary.confirm && typeof summary.confirm === "object") {
    return {
      candidates: summary.found?.candidates || summary.found?.total_confirmed_rows || 0,
      marked_in_progress: summary.found?.marked_in_progress || 0,
      rms_confirmed: summary.marked?.updated || 0,
      confirm_failed: summary.marked?.failed || 0,
    };
  }

  // Durable Rakuten confirm operations: preserve business and ambiguity outcomes.
  if (summary.operations && Array.isArray(summary.operations.results)) {
    const operationResults = summary.operations.results;
    const count = (action) => operationResults.filter((item) => item.action === action).length;
    return {
      candidates: summary.operations.candidates || 0,
      confirmed: count("confirmed"),
      reconciled_applied: count("reconciled_applied"),
      ledger_already_applied: count("ledger_already_applied"),
      unknown_result: count("unknown_result"),
      ledger_blocked: count("ledger_blocked"),
      local_persistence_failed: count("local_persistence_failed"),
      operation_failed_closed: count("operation_failed_closed"),
    };
  }

  if (summary.health_snapshot && typeof summary.health_snapshot === "object") {
    const health = summary.health_snapshot;
    return {
      results: Array.isArray(summary.results) ? summary.results.length : 0,
      sales_rows: health.sales_rows || 0,
      shipment_rows: health.shipment_rows || 0,
      missing_shipments_count: health.missing_shipments_count || 0,
      unsynced_shipments_count: health.unsynced_shipments_count || 0,
      shipped_not_closed_count: health.shipped_not_closed_count || 0,
    };
  }
  if (Array.isArray(summary.results)) return { results: summary.results.length };
  return {};
}

// ── Phase Execution ──────────────────────────────────────────────

export async function runPhase(phase, env, { shops, limit, orderId, platform, dryRun }) {
  if (phase === "pull_shop_orders") return await runMercariIngestViaRelay(env, { shops, limit, dryRun });
  if (phase === "sync_mercari_messages") {
    return await runMercariMessageSyncPhase(env, { shops, limit, orderId, dryRun });
  }
  if (phase === "auto_approve_orders") return await autoApproveMercariOrders(env, { shops, limit, orderId, dryRun });
  if (phase === "build_giga_shipments") return await projectMercariSalesOrdersToShipment(env, {
    shops, limit, orderIds: orderId ? [orderId] : [], dryRun,
  });
  if (phase === "pull_giga_tracking") return await reconcileShippingInfo(env, { shops, limit, orderId, dryRun });
  if (phase === "close_shop_orders") return await runMercariShippingCloseViaRelay(env, { shops, limit, orderId, dryRun });
  if (phase === "push_orders_to_giga") return await runOutboundSync(env, { shops, limit, orderId: orderId || "", dryRun });
  if (phase === "reconcile_cancellations") return await reconcileMercariCancellations(env, { shops, limit, dryRun });

  // ── Rakuten phases ──
  if (phase === "pull_rakuten_orders") {
    const relayResult = await runRakutenIngestViaRelay(env, { limit, dryRun });
    if (!relayResult.ok || !relayResult.body || !relayResult.body.orders) {
      return { ok: false, error: "rakuten_ingest_relay_failed", relay: relayResult };
    }
    return await ingestRakutenOrders(env, relayResult.body.orders, { dryRun });
  }
  if (phase === "confirm_rakuten_orders") {
    const found = await findConfirmedRakutenOrders(env, { limit, orderId, dryRun });
    if (found.candidates === 0) return { ok: true, ...found, note: "no_candidates" };
    const operations = await runRakutenConfirmOperations(env, found, {
      dryRun, runId: env.ORDERMGMT_RUN_ID,
    });
    return { ok: operations.ok, found, operations };
  }
  if (phase === "build_rakuten_shipments") {
    return await projectRakutenSalesOrdersToShipment(env, { limit, orderId, dryRun });
  }
  if (phase === "push_rakuten_orders_to_giga") {
    return await runOutboundSync(env, { shops, limit, orderId: orderId || "", platform: "Rakuten", dryRun });
  }
  if (phase === "sync_rakuten_tracking") {
    return await reconcileShippingInfo(env, { shops, limit, orderId, salesChannel: "Rakuten", dryRun });
  }
  if (phase === "close_rakuten_orders") {
    // Dynamic import to avoid circular ref — rakuten-closer may import pipeline-runner
    const { closeRakutenOrders } = await import("./rakuten-closer.mjs");
    return await closeRakutenOrders(env, { limit, dryRun, orderId: orderId || "" });
  }
  if (phase === "send_payment_reminders") {
    return await sendPaymentReminders(env, { shops, limit, orderId, dryRun });
  }
  if (phase === "reconcile_order_lifecycle") {
    return await reconcileMercariLifecycle(env, {
      shops,
      limit: parseInteger(env.LIFECYCLE_RECONCILE_CANARY_LIMIT, 0),
      orderId,
      dryRun,
      runId: env.ORDERMGMT_RUN_ID,
    });
  }
  if (phase === "reconcile_rakuten_lifecycle") {
    return await reconcileRakutenLifecycle(env, {
      limit: parseInteger(env.RAKUTEN_LIFECYCLE_RECONCILE_CANARY_LIMIT, 0),
      orderId,
      dryRun,
      runId: env.ORDERMGMT_RUN_ID,
    });
  }
  if (phase === "audit_pipeline_integrity") {
    const selectedPlatform = String(platform || "").trim().toLowerCase();
    if (selectedPlatform === "mercari") {
      const mercari = await collectPipelineHealthSnapshot(env, { shops, salesChannel: "Mercari", orderId });
      return buildIntegrityAuditResult({ mercari });
    }
    if (selectedPlatform === "rakuten") {
      const rakuten = await collectPipelineHealthSnapshot(env, { shops: [], salesChannel: "Rakuten", orderId });
      return buildIntegrityAuditResult({ rakuten });
    }
    const [mercari, rakuten] = await Promise.all([
      collectPipelineHealthSnapshot(env, { shops, salesChannel: "Mercari" }),
      collectPipelineHealthSnapshot(env, { shops: [], salesChannel: "Rakuten" }),
    ]);
    return buildIntegrityAuditResult({ mercari, rakuten });
  }

  if (phase === "reconcile_end_to_end") {
    return await runEndToEndReconcile({
      env, shops, inputLimit: limit, trackingLimit: 0, closeLimit: 0,
      runPullShopOrders: ({ shops: s, limit: l, dryRun: d }) => runMercariIngestViaRelay(env, { shops: s, limit: l, dryRun: d }),
      runBuildShipments: ({ shops: s, limit: l }) => projectMercariSalesOrdersToShipment(env, { shops: s, limit: l }),
      runPushOrders: ({ shops: s, limit: l }) => runOutboundSync(env, { shops: s, limit: l }),
      runPullTracking: ({ shops: s, limit: l }) => reconcileShippingInfo(env, { shops: s, limit: l }),
      runCloseOrders: ({ shops: s, limit: l, dryRun: d }) => runMercariShippingCloseViaRelay(env, { shops: s, limit: l, dryRun: d }),
    });
  }

  return { ok: false, error: `unknown_phase:${phase}` };
}

function buildIntegrityAuditResult(snapshots) {
  const entries = Object.entries(snapshots);
  const ok = entries.every(([, snapshot]) => snapshot?.ok !== false);
  return {
    ok,
    completion_state: ok ? (entries.some(([, snapshot]) => snapshot?.scoped) ? "scoped_complete" : "accounting_complete") : "failed",
    counts: Object.fromEntries(entries.map(([name, health]) => [name, {
      sales_rows: health?.sales_rows || 0,
      shipment_rows: health?.shipment_rows || 0,
      missing_shipments: health?.missing_shipments_count || 0,
      unsynced_shipments: health?.unsynced_shipments_count || 0,
      shipped_not_closed: health?.shipped_not_closed_count || 0,
      ...(health?.error ? { error: health.error } : {}),
    }])),
  };
}

export async function runMercariMessageSyncPhase(env, { shops, limit, orderId, dryRun }, fetchMessages = runMercariOrderMessagesViaRelay) {
  const syncResult = await syncMercariMessages(env, {
    shops, limit, orderId, dryRun, _inject: { runMercariOrderMessagesViaRelay: fetchMessages },
  });
  const retryResult = dryRun || orderId
    ? { claimed: 0, processed: 0, failed: 0, skipped: 0, lost_claim: 0 }
    : await retryStuckWebhookEvents(env, limit || 10);
  return { ...syncResult, webhook_retry: retryResult, ...(orderId ? { scoped_webhook_retry_skipped: true } : {}) };
}

const DRY_RUN_UNSUPPORTED_PHASES = new Set([
  "reconcile_end_to_end",
]);

export function phaseSupportsDryRun(phase) {
  return !DRY_RUN_UNSUPPORTED_PHASES.has(normalizePhaseName(phase));
}

export async function executePhase(env, context) {
  const { phase, shops, limit, orderId, platform, dryRun, runId, mode, triggerType, cron } = context;
  const createDatabaseClient = context.createDatabaseClient || createBaserowClient;
  const startedAt = new Date().toISOString();
  const egressMetrics = createEgressMetricsCollector({
    workloadId: phase,
    releaseVersion: env.RELEASE_VERSION,
  });
  const phaseEnv = {
    ...env,
    ORDERMGMT_WORKLOAD_ID: phase,
    ORDERMGMT_RUN_ID: runId,
    EGRESS_METRICS: egressMetrics,
  };
  if (dryRun && !phaseSupportsDryRun(phase)) {
    const stepResult = {
      step: phase, ok: false, completion_state: "dry_run_unsupported",
      started_at: startedAt, ended_at: new Date().toISOString(),
      error: `dry_run_unsupported:${phase}`,
      summary: { ok: false, dry_run: true, side_effects: 0 },
    };
    await writePipelineRunAudit(phaseEnv, { runId, mode, triggerType, cron, phase, shops, stepResult, dryRun });
    return stepResult;
  }
  const phaseRunner = typeof context.phaseRunner === "function" ? context.phaseRunner : runPhase;
  const bypassRelayHealth = context.localTransport === true && [
    "sync_mercari_messages", "pull_shop_orders", "reconcile_order_lifecycle", "close_shop_orders", "send_payment_reminders",
    "pull_rakuten_orders", "reconcile_rakuten_lifecycle", "confirm_rakuten_orders", "close_rakuten_orders",
  ].includes(phase);
  if (RELAY_DEPENDENT_PHASES.has(phase) && !bypassRelayHealth) {
    const health = await checkRelayHealth(phaseEnv);
    if (!health.ok) {
      const stepResult = {
        step: phase, ok: false, started_at: startedAt, ended_at: new Date().toISOString(),
        error: `relay_unhealthy:${health.error || "unreachable"}`, relay_health: health,
      };
      await writePipelineRunAudit(env, { runId, mode, triggerType, cron, phase, shops, stepResult, dryRun });
      return stepResult;
    }
  }
  if (MERCARI_FRESHNESS_GATED_PHASES.has(phase)) {
    const scopes = (shops || DEFAULT_SHOPS)
      .map((shop) => MERCARI_CHANNEL.shopIds[shop])
      .filter(Boolean)
      .map((shopId) => `mercari:${shopId}`);
    let freshness;
    try {
      const db = createDatabaseClient(phaseEnv);
      freshness = db.type === "supabase"
        ? await requireLifecycleFreshness(db.supabase, {
            requiredScopes: scopes,
            maxAgeMinutes: phaseEnv.FULFILLMENT_MAX_FRESHNESS_MINUTES,
          })
        : { ok: false, failures: [{ scope: "database", reason: "supabase_required" }] };
    } catch {
      freshness = { ok: false, failures: [{ scope: "database", reason: "configuration_failed" }] };
    }
    if (!freshness.ok) {
      const stepResult = {
        step: phase, ok: false, completion_state: "blocked_by_freshness",
        started_at: startedAt, ended_at: new Date().toISOString(),
        error: "blocked_by_freshness", summary: { ok: false, freshness },
      };
      await writePipelineRunAudit(env, { runId, mode, triggerType, cron, phase, shops, stepResult, dryRun });
      return stepResult;
    }
  }
  if (RAKUTEN_FRESHNESS_GATED_PHASES.has(phase)) {
    let freshness;
    try {
      const db = createDatabaseClient(phaseEnv);
      freshness = db.type === "supabase"
        ? await requireLifecycleFreshness(db.supabase, {
            requiredScopes: ["rakuten:rakuten"],
            maxAgeMinutes: phaseEnv.FULFILLMENT_MAX_FRESHNESS_MINUTES,
          })
        : { ok: false, failures: [{ scope: "database", reason: "supabase_required" }] };
    } catch {
      freshness = { ok: false, failures: [{ scope: "database", reason: "configuration_failed" }] };
    }
    if (!freshness.ok) {
      const stepResult = {
        step: phase, ok: false, completion_state: "blocked_by_freshness",
        started_at: startedAt, ended_at: new Date().toISOString(),
        error: "blocked_by_freshness", summary: { ok: false, freshness },
      };
      await writePipelineRunAudit(env, { runId, mode, triggerType, cron, phase, shops, stepResult, dryRun });
      return stepResult;
    }
  }
  try {
    const summary = await phaseRunner(phase, phaseEnv, {
      shops, limit, orderId, platform, dryRun, runId,
      lifecycleFreshnessEvidence: context.lifecycleFreshnessEvidence || null,
    });
    const egressSnapshot = egressMetrics.snapshot();
    const stepResult = {
      step: phase, ok: summary && summary.ok !== false,
      completion_state: summary && summary.completion_state ? summary.completion_state : (summary && summary.ok === false ? "failed" : "completed"),
      started_at: startedAt, ended_at: new Date().toISOString(), summary,
      egress_metrics: egressSnapshot,
    };
    console.log(JSON.stringify({ supabase_egress: egressSnapshot }));
    await writePipelineRunAudit(phaseEnv, { runId, mode, triggerType, cron, phase, shops, stepResult, dryRun });
    return stepResult;
  } catch (error) {
    const stepResult = {
      step: phase, ok: false, started_at: startedAt, ended_at: new Date().toISOString(),
      error: normalizeErrorMessage(error),
      egress_metrics: egressMetrics.snapshot(),
    };
    console.log(JSON.stringify({ supabase_egress: stepResult.egress_metrics }));
    await writePipelineRunAudit(phaseEnv, { runId, mode, triggerType, cron, phase, shops, stepResult, dryRun });
    return stepResult;
  }
}

export function resolvePhases(mode, explicitPhases) {
  if (explicitPhases && explicitPhases.length) return explicitPhases.map(normalizePhaseName);
  if (mode === "hourly") return CORE_PHASES.slice();
  if (mode === "scheduled") return CORE_PHASES.slice();
  return [normalizePhaseName(mode)];
}

// ── Pipeline Orchestration ───────────────────────────────────────

export async function runPipeline(env, body = {}) {
  // Worker parity: shop resolution with fallback chain, body defaults to {}.
  const mode = String(body.mode || "hourly").trim().toLowerCase();
  const limit = parseInteger(body.limit || env.ORDER_MGMT_LIMIT, 100);
  const shops = resolveShops(body.shops || env.MERCARI_SHOPS || DEFAULT_SHOPS.join(","));
  const orderId = text(body.order_id || body.orderId || "");
  const dryRun = body.dryRun === true;
  const triggerType = text(body.triggerType) || "admin";
  const cron = text(body.cron);
  const explicitPhases = Array.isArray(body.phases)
    ? body.phases.map((item) => text(item)).filter(Boolean)
    : [];
  const phases = resolvePhases(mode, explicitPhases);
  const runId = buildRunId();
  const result = {
    ok: true, run_id: runId, mode, shops, order_id: orderId || null,
    dryRun, trigger_type: triggerType, cron: cron || null, steps: [],
  };
  for (const phase of phases) {
    const stepResult = await executePhase(env, { phase, shops, limit, orderId, dryRun, runId, mode, triggerType, cron });
    result.steps.push(stepResult);
  }
  if (phasesAreHourlyCore(phases)) {
    try {
      result.health_snapshot = await collectPipelineHealthSnapshot(env, { shops });
    } catch (error) {
      result.health_snapshot = { ok: false, error: normalizeErrorMessage(error) };
    }
  }
  result.ok = result.steps.every((step) => step.ok !== false);
  if (!result.ok && !result.statusCode) result.statusCode = 500;
  return result;
}

// ── Audit Logging ────────────────────────────────────────────────

export async function writePipelineRunAudit(env, context) {
  const tableId = parseInteger(env.BASEROW_PIPELINE_RUNS_TABLE_ID, 0);
  const counts = extractCounts(context.stepResult.summary);
  if (context.stepResult.egress_metrics) counts.egress = context.stepResult.egress_metrics;
  const consolePayload = {
    run_id: context.runId,
    trigger_type: context.triggerType,
    mode: context.mode,
    cron: text(context.cron) || null,
    step: context.phase,
    shop_scope: (context.shops || []).join(","),
    ok: context.stepResult.ok ? "true" : "false",
    started_at: context.stepResult.started_at,
    ended_at: context.stepResult.ended_at,
    error_message: context.stepResult.error || "",
    result_counts_json: JSON.stringify(counts),
  };
  console.log(JSON.stringify({ audit: consolePayload }));
  if (context.dryRun === true) return;
  try {
    const client = createBaserowClient({
      ...env,
      ORDERMGMT_WORKLOAD_ID: "pipeline_audit",
      EGRESS_METRICS: undefined,
    });
    console.log(JSON.stringify({
      audit_backend_configured: text(env.DATABASE_BACKEND) || "unset",
      audit_client_type: text(client.type) || "legacy",
    }));
    if (client.type === "supabase") {
      const result = await createRow(client, "pipeline_run_log", {
        run_id: context.runId,
        trigger_type: context.triggerType,
        mode: context.mode,
        cron: text(context.cron) || null,
        step: context.phase,
        shop_scope: (context.shops || []).join(","),
        ok: context.stepResult.ok === true,
        started_at: context.stepResult.started_at,
        ended_at: context.stepResult.ended_at,
        error_message: context.stepResult.error || "",
        result_counts: counts,
      });
      if (!result.ok) throw new Error(result.error || "supabase_audit_write_failed");
      console.log(JSON.stringify({
        audit_write_succeeded: true,
        run_id: context.runId,
        step: context.phase,
        audit_id: result.body?.id || null,
      }));
      return;
    }
    if (!tableId) return;
    const result = await createRow(client, tableId, consolePayload);
    if (!result.ok) throw new Error(result.error || "baserow_audit_write_failed");
  } catch (error) {
    console.log(JSON.stringify({
      audit_write_failed: true,
      run_id: context.runId, step: context.phase,
      error: normalizeErrorMessage(error),
    }));
  }
}

// ── Error Normalization ──────────────────────────────────────────

export function normalizeErrorMessage(error) {
  // Worker parity: return error.stack for Error objects (full trace),
  // bounded at 2000 chars for safety in audit logs.
  if (!error) return "unknown_error";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const value = error.stack || error.message || String(error);
    if (value.length < 2000) return value;
    return value.slice(0, 1997) + "...";
  }
  // Non-Error object with stack property (e.g., relay error payloads)
  if (error && typeof error === "object" && typeof error.stack === "string") {
    return error.stack;
  }
  try { return JSON.stringify(error); } catch {
    return String(error).slice(0, 2000);
  }
}
