#!/usr/bin/env node
import os from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBaserowClient } from "./lib/db.mjs";
import { buildRunId, executePhase, extractCounts, parseInteger, runMercariMessageSyncPhase, runPhase } from "./lib/pipeline-runner.mjs";
import { runMercariIngest } from "./lib/mercari-ingest.mjs";
import { runMercariCloseLocal } from "./lib/mercari-close-local.mjs";
import { fetchMercariOrderMessages, fetchMercariOrderStatuses, sendMercariOrderReply } from "./lib/mercari-local-api.mjs";
import { reconcileMercariLifecycle } from "./lib/lifecycle-reconciler.mjs";
import { sendPaymentReminders } from "./lib/payment-reminders.mjs";
import { ingestRakutenOrders } from "./lib/rakuten-ingest.mjs";
import { findConfirmedRakutenOrders } from "./lib/rakuten-confirmer.mjs";
import { runRakutenConfirmOperations } from "./lib/rakuten-confirm-operation.mjs";
import { reconcileRakutenLifecycle } from "./lib/rakuten-lifecycle-reconciler.mjs";
import { closeRakutenOrders } from "./lib/rakuten-closer.mjs";
import { runRakutenCloseLocal, runRakutenConfirmLocal, runRakutenIngestLocal, runRakutenOrderStatusesLocal } from "./lib/rakuten-local-api.mjs";
import { PHASE_WORKLOAD_IDS, verifyVpsLiveOwnership } from "./lib/scheduler-runtime-fence.mjs";

export const ORDER_PIPELINE_DAG = Object.freeze([
  { name: "message_ingestion", workloadId: PHASE_WORKLOAD_IDS.sync_mercari_messages, phases: ["sync_mercari_messages"], liveFlag: "ORCHESTRATOR_ENABLE_MESSAGE_INGESTION" },
  { name: "mercari_discovery", workloadId: PHASE_WORKLOAD_IDS.pull_shop_orders, phases: ["pull_shop_orders"], liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_LIFECYCLE" },
  { name: "mercari_lifecycle", workloadId: PHASE_WORKLOAD_IDS.reconcile_order_lifecycle, phases: ["reconcile_order_lifecycle"], dependsOn: ["mercari_discovery"], liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_LIFECYCLE" },
  { name: "rakuten_discovery", workloadId: "ordermgmt_rakuten_order_pull", phases: ["pull_rakuten_orders"], liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_LIFECYCLE" },
  { name: "rakuten_lifecycle", workloadId: "ordermgmt_rakuten_order_pull", phases: ["reconcile_rakuten_lifecycle"], dependsOn: ["rakuten_discovery"], liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_LIFECYCLE" },
  { name: "mercari_eligibility", workloadId: "ordermgmt_auto_approve_orders", phases: ["auto_approve_orders"], dependsOn: ["mercari_lifecycle"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_ELIGIBILITY" },
  { name: "mercari_projection", workloadId: "ordermgmt_giga_shipment_build", phases: ["build_giga_shipments"], dependsOn: ["mercari_eligibility"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_PROJECTION" },
  { name: "rakuten_confirmation", workloadId: "ordermgmt_rakuten_order_confirm", phases: ["confirm_rakuten_orders"], dependsOn: ["rakuten_lifecycle"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_CONFIRMATION" },
  { name: "rakuten_projection", workloadId: "ordermgmt_rakuten_shipment_build", phases: ["build_rakuten_shipments"], dependsOn: ["rakuten_confirmation"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_PROJECTION" },
  { name: "mercari_giga_outbound", workloadId: "ordermgmt_giga_order_push", phases: ["push_orders_to_giga"], dependsOn: ["mercari_projection"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_GIGA_OUTBOUND" },
  { name: "rakuten_giga_outbound", workloadId: "ordermgmt_rakuten_order_push", phases: ["push_rakuten_orders_to_giga"], dependsOn: ["rakuten_projection"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_GIGA_OUTBOUND" },
  { name: "mercari_tracking", workloadId: "ordermgmt_giga_tracking_pull", phases: ["pull_giga_tracking"], dependsOn: ["mercari_giga_outbound"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_TRACKING" },
  { name: "rakuten_tracking", workloadId: "ordermgmt_rakuten_tracking_sync", phases: ["sync_rakuten_tracking"], dependsOn: ["rakuten_giga_outbound"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_TRACKING" },
  { name: "mercari_close", workloadId: "ordermgmt_shop_order_close", phases: ["close_shop_orders"], dependsOn: ["mercari_tracking"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_MERCARI_CLOSE" },
  { name: "rakuten_close", workloadId: "ordermgmt_rakuten_order_close", phases: ["close_rakuten_orders"], dependsOn: ["rakuten_tracking"], shadow: "skip", liveFlag: "ORCHESTRATOR_ENABLE_RAKUTEN_CLOSE" },
  { name: "integrity_audit", workloadId: "ordermgmt_end_to_end_reconcile", phases: ["audit_pipeline_integrity"], liveFlag: "ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT" },
  { name: "payment_reminders", workloadId: "ordermgmt_payment_reminder", phases: ["send_payment_reminders"], dependsOn: ["mercari_lifecycle"], liveFlag: "ORCHESTRATOR_ENABLE_PAYMENT_REMINDERS" },
]);
// Compatibility export for callers/tests; the DAG is now cross-platform.
export const MERCARI_DAG = ORDER_PIPELINE_DAG;
export const LIVE_CAPABILITY_FLAGS = Object.freeze([...new Set(ORDER_PIPELINE_DAG.map((unit) => unit.liveFlag))]);
const MERCARI_CANARY_SCOPE = "shop_order_id";
const RAKUTEN_CANARY_SCOPE = "order_id";
const PLATFORM_CANARY_SCOPE = "platform_order_id";
const EXACT_CANARY_SCOPES = Object.freeze(Object.fromEntries([
  ["mercari_lifecycle", MERCARI_CANARY_SCOPE],
  ["mercari_discovery", MERCARI_CANARY_SCOPE],
  ["rakuten_lifecycle", RAKUTEN_CANARY_SCOPE],
  ["rakuten_discovery", RAKUTEN_CANARY_SCOPE],
  ["message_ingestion", MERCARI_CANARY_SCOPE],
  ["mercari_eligibility", MERCARI_CANARY_SCOPE],
  ["mercari_projection", MERCARI_CANARY_SCOPE],
  ["rakuten_confirmation", RAKUTEN_CANARY_SCOPE],
  ["rakuten_projection", RAKUTEN_CANARY_SCOPE],
  ["mercari_giga_outbound", MERCARI_CANARY_SCOPE],
  ["rakuten_giga_outbound", RAKUTEN_CANARY_SCOPE],
  ["mercari_tracking", MERCARI_CANARY_SCOPE],
  ["rakuten_tracking", RAKUTEN_CANARY_SCOPE],
  ["mercari_close", MERCARI_CANARY_SCOPE],
  ["rakuten_close", RAKUTEN_CANARY_SCOPE],
  ["payment_reminders", MERCARI_CANARY_SCOPE],
  ["integrity_audit", PLATFORM_CANARY_SCOPE],
]));
const EXTERNAL_WRITE_CAPABILITIES = new Set([
  "mercari_eligibility", "rakuten_confirmation", "mercari_giga_outbound", "rakuten_giga_outbound",
  "mercari_close", "rakuten_close", "payment_reminders",
]);
export const CANARY_CAPABILITY_MATRIX = Object.freeze(ORDER_PIPELINE_DAG.map((unit) => Object.freeze({
  name: unit.name,
  phase: unit.phases[0],
  workloadId: unit.workloadId,
  liveFlag: unit.liveFlag,
  requiredScope: EXACT_CANARY_SCOPES[unit.name] || null,
  exactCanarySupported: Boolean(EXACT_CANARY_SCOPES[unit.name]),
  externalWrite: EXTERNAL_WRITE_CAPABILITIES.has(unit.name),
})));
export const CANARY_CAPABILITIES = Object.freeze(Object.fromEntries(
  CANARY_CAPABILITY_MATRIX.map((capability) => [capability.name, capability]),
));

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const LEASE_NAME = "ordermgmt-primary";
const LEASE_TTL_SECONDS = 3600;

export function resolveExecutionMode(argv, env) {
  const valueFlags = new Set(["--canary", "--order-id", "--shop", "--platform", "--limit"]);
  const known = new Set(["--shadow", "--live", ...valueFlags]);
  const unknown = argv.filter((arg, index) => index === 0 || !valueFlags.has(argv[index - 1]) ? !known.has(arg) : false);
  if (unknown.length) throw new Error(`unknown_orchestrator_arguments:${unknown.join(",")}`);
  if (argv.includes("--shadow") && argv.includes("--live")) throw new Error("conflicting_orchestrator_modes");
  const envMode = String(env.ORCHESTRATOR_MODE || "").trim().toLowerCase();
  if (envMode && !["shadow", "live"].includes(envMode)) throw new Error("invalid_ORCHESTRATOR_MODE");
  const argMode = argv.includes("--live") ? "live" : (argv.includes("--shadow") ? "shadow" : "");
  if (argMode && envMode && argMode !== envMode) throw new Error("conflicting_orchestrator_mode_sources");
  const requestedLive = (argMode || envMode || "shadow") === "live";
  const liveEnabled = enabled(env.ORCHESTRATOR_LIVE_ENABLED);
  if (requestedLive && !liveEnabled) throw new Error("live_mode_requires_ORCHESTRATOR_LIVE_ENABLED=true");
  if (requestedLive && !LIVE_CAPABILITY_FLAGS.some((flag) => enabled(env[flag]))) {
    throw new Error("live_mode_requires_at_least_one_capability_flag");
  }
  return requestedLive ? "live" : "shadow";
}

export function resolveOrchestratorRequest(argv, env) {
  const mode = resolveExecutionMode(argv, env);
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!["--canary", "--order-id", "--shop", "--platform", "--limit"].includes(flag)) continue;
    if (values.has(flag)) throw new Error(`duplicate_orchestrator_argument:${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing_orchestrator_argument_value:${flag}`);
    values.set(flag, value.trim());
    index++;
  }
  const capabilityName = values.get("--canary") || "";
  if (!capabilityName) {
    if (values.size) throw new Error("scoped_arguments_require_canary");
    return { mode, canary: null };
  }
  if (mode !== "live" || !argv.includes("--live")) throw new Error("canary_requires_explicit_live_mode");
  const capability = CANARY_CAPABILITIES[capabilityName];
  if (!capability?.exactCanarySupported) throw new Error(`unsupported_canary_capability:${capabilityName}`);
  const orderId = values.get("--order-id") || "";
  if (!orderId) throw new Error("canary_requires_order_id");
  if (values.get("--limit") !== "1") throw new Error("canary_requires_limit_1");
  const shop = values.get("--shop") || "";
  const platform = (values.get("--platform") || "").toLowerCase();
  if (capability.requiredScope === MERCARI_CANARY_SCOPE && !["Shop1", "Shop2", "Shop3", "Shop4"].includes(shop)) {
    throw new Error("mercari_canary_requires_valid_shop");
  }
  if (capability.requiredScope === RAKUTEN_CANARY_SCOPE && shop) throw new Error("rakuten_canary_rejects_shop_scope");
  if (capability.requiredScope === PLATFORM_CANARY_SCOPE) {
    if (!["mercari", "rakuten"].includes(platform)) throw new Error("integrity_canary_requires_platform");
    if (platform === "mercari" && !["Shop1", "Shop2", "Shop3", "Shop4"].includes(shop)) throw new Error("mercari_canary_requires_valid_shop");
    if (platform === "rakuten" && shop) throw new Error("rakuten_canary_rejects_shop_scope");
  } else if (platform) throw new Error("platform_scope_only_valid_for_integrity_canary");
  if (!enabled(env[capability.liveFlag])) throw new Error(`canary_capability_flag_disabled:${capability.liveFlag}`);
  return { mode, canary: { ...capability, orderId, shop, platform, limit: 1 } };
}

export function resolvePhaseLimit(env, mode) {
  // Canonical contract: null means unbounded/full accounting. Do not use 0:
  // legacy phase implementations historically interpreted it inconsistently.
  if (mode === "live") return null;
  return Math.max(1, parseInteger(env.ORCHESTRATOR_SHADOW_LIMIT, 100));
}

export function verifyImmutableRuntime(env, injected = {}) {
  if (!enabled(env.ORCHESTRATOR_REQUIRE_IMMUTABLE_RELEASE)) return { ok: true, enforced: false };
  const release = String(env.RELEASE_VERSION || "").trim();
  if (!/^[0-9a-f]{40}$/.test(release)) throw new Error("immutable_runtime_requires_exact_release_sha");
  const resolve = injected.realpath || realpathSync;
  const modulePath = resolve(injected.modulePath || fileURLToPath(import.meta.url));
  const releaseDir = path.dirname(path.dirname(modulePath));
  const currentPath = resolve(injected.currentPath || env.ORCHESTRATOR_RELEASE_CURRENT || "/opt/order-mgmt-orchestrator/current");
  if (path.basename(releaseDir) !== release) throw new Error("immutable_runtime_source_release_mismatch");
  if (currentPath !== releaseDir) throw new Error("immutable_runtime_current_pointer_mismatch");
  return { ok: true, enforced: true, release_version: release, release_dir: releaseDir };
}

export function isMainModule(importMetaUrl, argvPath, resolve = realpathSync) {
  if (!argvPath) return false;
  return resolve(fileURLToPath(importMetaUrl)) === resolve(argvPath);
}

export function summarizeStepResults(unit, phaseResults) {
  return {
    phases: phaseResults.length,
    by_phase: Object.fromEntries(phaseResults.map((result, index) => [
      unit.phases[index],
      {
        ok: result?.ok === true,
        completion_state: result?.completion_state || (result?.ok === false ? "failed" : "completed"),
        counts: extractCounts(result?.summary),
        ...(result?.error ? { error_code: String(result.error).slice(0, 200) } : {}),
      },
    ])),
  };
}

function assertSingleRow(data, expected, operation) {
  if (!data || typeof data !== "object") throw new Error(`${operation}:readback_missing`);
  for (const [key, value] of Object.entries(expected)) {
    if (data[key] !== value) throw new Error(`${operation}:readback_mismatch:${key}`);
  }
}

export const verifyLiveSchedulerOwnership = verifyVpsLiveOwnership;

export async function runLocalOrchestratorPhase(phase, env, options) {
  if (phase === "sync_mercari_messages") return await runMercariMessageSyncPhase(env, options, fetchMercariOrderMessages);
  if (phase === "send_payment_reminders") return await sendPaymentReminders(env, {
    ...options, fetchOrderMessages: fetchMercariOrderMessages, sendOrderReply: sendMercariOrderReply,
  });
  if (phase === "pull_shop_orders") return await runMercariIngest(env, options);
  if (phase === "reconcile_order_lifecycle") return await reconcileMercariLifecycle(env, {
    ...options, runId: env.ORDERMGMT_RUN_ID, fetchOrderStatuses: fetchMercariOrderStatuses,
  });
  if (phase === "close_shop_orders") return await runMercariCloseLocal(env, options);
  if (phase === "pull_rakuten_orders") {
    const exactOrderId = String(options.orderId || "").trim();
    const rms = await runRakutenIngestLocal(env, {
      limit: options.limit,
      ...(exactOrderId ? { orderNumber: exactOrderId } : {}),
    });
    if (!rms.ok || !Array.isArray(rms.body?.orders)) return { ok: false, error: "rakuten_ingest_local_failed", rms };
    const orders = exactOrderId ? selectExactRakutenDiscoveryOrders(rms.body.orders, exactOrderId) : rms.body.orders;
    if (exactOrderId && orders.length !== 1) {
      return { ok: false, error: orders.length ? "rakuten_exact_discovery_ambiguous" : "rakuten_exact_discovery_target_not_found" };
    }
    return await ingestRakutenOrders(env, orders, { dryRun: options.dryRun });
  }
  if (phase === "reconcile_rakuten_lifecycle") return await reconcileRakutenLifecycle(env, {
    ...options, runId: env.ORDERMGMT_RUN_ID, fetchOrderStatuses: runRakutenOrderStatusesLocal,
  });
  if (phase === "confirm_rakuten_orders") {
    const found = await findConfirmedRakutenOrders(env, { limit: options.limit, orderId: options.orderId, dryRun: options.dryRun });
    if (found.candidates === 0) return { ok: true, ...found, note: "no_candidates" };
    const operations = await runRakutenConfirmOperations(env, found, {
      dryRun: options.dryRun, runId: env.ORDERMGMT_RUN_ID,
      _inject: { runRelay: runRakutenConfirmLocal, readStatuses: runRakutenOrderStatusesLocal },
    });
    return { ok: operations.ok, found, operations };
  }
  if (phase === "close_rakuten_orders") return await closeRakutenOrders(env, {
    ...options, _inject: { runRakutenCloseViaRelay: runRakutenCloseLocal, runRakutenIngestViaRelay: runRakutenIngestLocal },
  });
  return await runPhase(phase, env, options);
}

export function selectExactRakutenDiscoveryOrders(orders, orderId) {
  const exactOrderId = String(orderId || "").trim();
  if (!exactOrderId) return [];
  return (orders || []).filter((order) => [order?.orderNumber, order?.orderNo, order?.orderId]
    .some((value) => String(value || "").trim() === exactOrderId));
}

async function insertRun(db, row) {
  const { data, error } = await db.supabase.from("pipeline_orchestration_runs")
    .insert(row).select("run_id,status,execution_mode").single();
  if (error) throw new Error(`pipeline_run_insert_failed:${error.message}`);
  assertSingleRow(data, { run_id: row.run_id, status: row.status, execution_mode: row.execution_mode }, "pipeline_run_insert_failed");
}

async function finishRun(db, runId, status, summary) {
  const { data, error } = await db.supabase.from("pipeline_orchestration_runs")
    .update({ status, ended_at: new Date().toISOString(), summary })
    .eq("run_id", runId).select("run_id,status").single();
  if (error) throw new Error(`pipeline_run_update_failed:${error.message}`);
  assertSingleRow(data, { run_id: runId, status }, "pipeline_run_update_failed");
}

async function heartbeatLease(db, ownerId, runId) {
  const { data, error } = await db.supabase.rpc("heartbeat_order_orchestrator_lease", {
    p_lease_name: LEASE_NAME, p_owner_id: ownerId, p_run_id: runId,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error || data !== true) throw new Error(error?.message || "orchestrator_lease_lost");
}

export async function runOrchestrator({
  argv = [], env = process.env, db = createBaserowClient(env), execute = executePhase,
  runId = buildRunId(), ownerId = `${os.hostname()}:${process.pid}`,
} = {}) {
  verifyImmutableRuntime(env);
  const request = resolveOrchestratorRequest(argv, env);
  const { mode, canary } = request;
  if (db.type !== "supabase") throw new Error("orchestrator_requires_supabase");
  const release = env.RELEASE_VERSION || "unknown";
  const runtimeHost = env.ORCHESTRATOR_RUNTIME_HOST || os.hostname();
  const { data: claimed, error: leaseError } = await db.supabase.rpc("acquire_order_orchestrator_lease", {
    p_lease_name: LEASE_NAME, p_owner_id: ownerId, p_run_id: runId,
    p_release_version: release, p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseError || claimed !== true) throw new Error(leaseError?.message || "orchestrator_lease_unavailable");

  let runCreationAttempted = false;
  const results = [];
  try {
    runCreationAttempted = true;
    await insertRun(db, {
      run_id: runId, owner_id: ownerId, release_version: release,
      trigger_type: canary ? "manual_canary" : (env.ORCHESTRATOR_TRIGGER_TYPE || "systemd"),
      execution_mode: mode, status: "RUNNING",
    });
    const stepState = new Map();
    for (let index = 0; index < ORDER_PIPELINE_DAG.length; index++) {
      await heartbeatLease(db, ownerId, runId);
      const unit = ORDER_PIPELINE_DAG[index];
      if (canary && unit.name !== canary.name) {
        await writeStep(db, runId, unit.name, index, "SKIPPED", { canary_not_selected: 1 });
        results.push({ step: unit.name, ok: true, canary_not_selected: true });
        stepState.set(unit.name, "NOT_SELECTED");
        continue;
      }
      if (mode === "live" && !enabled(env[unit.liveFlag])) {
        await writeStep(db, runId, unit.name, index, "SKIPPED", { capability_disabled: 1 });
        results.push({ step: unit.name, ok: true, capability_disabled: true });
        stepState.set(unit.name, "DISABLED");
        continue;
      }
      if (mode === "live") {
        const ownership = await verifyLiveSchedulerOwnership(db.supabase, unit, { release, runtimeHost });
        if (!ownership.ok) {
          await writeStep(db, runId, unit.name, index, "BLOCKED", { scheduler_ownership_gate: ownership.reason });
          results.push({ step: unit.name, ok: false, blocked: true, blocked_by: [ownership.reason] });
          stepState.set(unit.name, "BLOCKED");
          continue;
        }
      }
      const blockedBy = canary ? [] : (unit.dependsOn || []).filter((dependency) => stepState.get(dependency) !== "SUCCEEDED");
      if (blockedBy.length) {
        await writeStep(db, runId, unit.name, index, "BLOCKED", { blocked_by_dependency: blockedBy });
        results.push({ step: unit.name, ok: false, blocked: true, blocked_by: blockedBy });
        stepState.set(unit.name, "BLOCKED");
        continue;
      }
      await writeStep(db, runId, unit.name, index, "RUNNING", {});
      if (mode === "shadow" && unit.shadow === "skip") {
        await finishStep(db, runId, unit.name, "SKIPPED", { shadow_external_or_business_write: unit.phases.length });
        results.push({ step: unit.name, ok: true, shadow_skipped: true });
        stepState.set(unit.name, "SUCCEEDED");
        continue;
      }
      const phaseResults = [];
      for (const phase of unit.phases) {
        phaseResults.push(await execute(env, {
          phase, shops: canary?.shop ? [canary.shop] : ["Shop1", "Shop2", "Shop3", "Shop4"],
          limit: canary?.limit ?? resolvePhaseLimit(env, mode),
          orderId: canary?.orderId || "", dryRun: mode === "shadow", runId,
          platform: canary?.platform || "",
          mode: canary ? "orchestrator_live_canary" : `orchestrator_${mode}`,
          triggerType: canary ? "manual_canary" : (env.ORCHESTRATOR_TRIGGER_TYPE || "systemd"), cron: "",
          phaseRunner: runLocalOrchestratorPhase, localTransport: true,
          ...(mode === "shadow"
            && unit.name === "payment_reminders"
            && stepState.get("mercari_lifecycle") === "SUCCEEDED"
            ? { lifecycleFreshnessEvidence: {
                run_id: runId, execution_mode: "shadow", platform: "mercari", completion_state: "accounting_complete",
              } }
            : {}),
        }));
      }
      const ok = phaseResults.every((result) => result.ok);
      await finishStep(db, runId, unit.name, ok ? "SUCCEEDED" : "FAILED", summarizeStepResults(unit, phaseResults));
      results.push({ step: unit.name, ok, phases: phaseResults });
      stepState.set(unit.name, ok ? "SUCCEEDED" : "FAILED");
    }
    const ok = results.every((result) => result.ok);
    await finishRun(db, runId, ok ? "SUCCEEDED" : "PARTIAL", {
      steps: results.length, failed: results.filter((result) => !result.ok).length,
      ...(canary ? { canary_capability: canary.name } : {}),
    });
    return { ok, run_id: runId, mode, ...(canary ? { canary: canary.name } : {}), results };
  } catch (error) {
    if (runCreationAttempted) {
      try {
        await finishRun(db, runId, "FAILED", { error_code: String(error?.message || error).slice(0, 500), steps: results.length });
      } catch (finishError) {
        error.cause = finishError;
      }
    }
    throw error;
  } finally {
    const { data: released, error: releaseError } = await db.supabase.rpc("release_order_orchestrator_lease", {
      p_lease_name: LEASE_NAME, p_owner_id: ownerId, p_run_id: runId,
    });
    if (releaseError) console.error(`orchestrator_lease_release_failed:${releaseError.message}`);
    else if (released !== true) console.error("orchestrator_lease_release_not_owned");
  }
}

async function writeStep(db, runId, name, sequence, status, counts) {
  const blockedReason = status === "BLOCKED"
    ? (counts?.scheduler_ownership_gate
      || (Array.isArray(counts?.blocked_by_dependency) ? `blocked_by_dependency:${counts.blocked_by_dependency.join(",")}` : null))
    : null;
  const row = {
    run_id: runId, step_name: name, sequence, status,
    started_at: status === "RUNNING" ? new Date().toISOString() : null,
    ended_at: ["BLOCKED", "SKIPPED"].includes(status) ? new Date().toISOString() : null,
    result_counts: counts, error_code: blockedReason,
  };
  const { data, error } = await db.supabase.from("pipeline_steps")
    .insert(row).select("run_id,step_name,attempt,status").single();
  if (error) throw new Error(`pipeline_step_insert_failed:${error.message}`);
  assertSingleRow(data, { run_id: runId, step_name: name, attempt: 1, status }, "pipeline_step_insert_failed");
}

async function finishStep(db, runId, name, status, counts) {
  const { data, error } = await db.supabase.from("pipeline_steps")
    .update({ status, ended_at: new Date().toISOString(), result_counts: counts })
    .eq("run_id", runId).eq("step_name", name).eq("attempt", 1)
    .select("run_id,step_name,attempt,status").single();
  if (error) throw new Error(`pipeline_step_update_failed:${error.message}`);
  assertSingleRow(data, { run_id: runId, step_name: name, attempt: 1, status }, "pipeline_step_update_failed");
}

if (isMainModule(import.meta.url, process.argv[1])) runOrchestrator({ argv: process.argv.slice(2) })
  .then((result) => { if (!result.ok) process.exitCode = 1; })
  .catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
