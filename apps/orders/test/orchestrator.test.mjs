import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CANARY_CAPABILITIES, CANARY_CAPABILITY_MATRIX, LIVE_CAPABILITY_FLAGS, MERCARI_DAG, isMainModule, resolveExecutionMode, resolveOrchestratorRequest, resolvePhaseLimit, runOrchestrator, selectExactRakutenDiscoveryOrders, summarizeStepResults, verifyImmutableRuntime, verifyLiveSchedulerOwnership } from "../src/orchestrator.mjs";

test("main-module detection follows the immutable current symlink", () => {
  const resolve = (value) => value.includes("/current/")
    ? value.replace("/current/", "/releases/abc123/")
    : value;
  assert.equal(isMainModule("file:///opt/order-mgmt-orchestrator/releases/abc123/src/orchestrator.mjs", "/opt/order-mgmt-orchestrator/current/src/orchestrator.mjs", resolve), true);
  assert.equal(isMainModule("file:///opt/order-mgmt-orchestrator/releases/abc123/src/orchestrator.mjs", "/tmp/other.mjs", resolve), false);
  assert.equal(isMainModule("file:///opt/order-mgmt-orchestrator/releases/abc123/src/orchestrator.mjs", undefined, resolve), false);
});

function ownershipRowsFor(env, release = "test", runtimeHost = "vps-test") {
  return MERCARI_DAG.filter((unit) => ["1", "true", "yes", "on"].includes(String(env[unit.liveFlag] || "").toLowerCase()))
    .map((unit) => ({
      workload_id: unit.workloadId, scheduler_owner: "vps_order_orchestrator",
      runtime_host: runtimeHost, release_version: release, kill_switch_state: "enabled",
      legacy_scheduler_disabled: true, evidence_observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }));
}

function fakeDb({ ownershipRows = [] } = {}) {
  const runs = new Map();
  const steps = new Map();
  const rpcCalls = [];
  const ownership = new Map(ownershipRows.map((row) => [row.workload_id, row]));
  function resultFor(table, operation, payload, filters) {
    if (table === "pipeline_orchestration_runs") {
      if (operation === "insert") runs.set(payload.run_id, { ...payload });
      if (operation === "update") {
        const row = runs.get(filters.run_id);
        Object.assign(row, payload);
        return row;
      }
      return runs.get(payload.run_id);
    }
    const key = operation === "insert" ? `${payload.run_id}:${payload.step_name}:1` : `${filters.run_id}:${filters.step_name}:${filters.attempt}`;
    if (operation === "insert") steps.set(key, { ...payload, attempt: 1 });
    else Object.assign(steps.get(key), payload);
    return steps.get(key);
  }
  const db = {
    type: "supabase",
    supabase: {
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        return { data: true, error: null };
      },
      from(table) {
        if (table === "order_scheduler_ownership") {
          const filters = {};
          const builder = {
            eq(key, value) { filters[key] = value; return builder; },
            async maybeSingle() { return { data: ownership.get(filters.workload_id) || null, error: null }; },
          };
          return { select() { return builder; } };
        }
        return {
          insert(payload) { return mutation(table, "insert", payload); },
          update(payload) { return mutation(table, "update", payload); },
        };
      },
    },
  };
  function mutation(table, operation, payload) {
    const filters = {};
    const builder = {
      eq(key, value) { filters[key] = value; return builder; },
      select() { return builder; },
      async single() { return { data: resultFor(table, operation, payload, filters), error: null }; },
    };
    return builder;
  }
  return { db, runs, steps, rpcCalls };
}

test("orchestrator DAG encodes business dependencies", () => {
  assert.deepEqual(MERCARI_DAG.map((unit) => unit.name), [
    "message_ingestion", "mercari_discovery", "mercari_lifecycle", "rakuten_discovery", "rakuten_lifecycle",
    "mercari_eligibility", "mercari_projection", "rakuten_confirmation", "rakuten_projection",
    "mercari_giga_outbound", "rakuten_giga_outbound", "mercari_tracking", "rakuten_tracking", "mercari_close", "rakuten_close",
    "integrity_audit", "payment_reminders",
  ]);
  assert.deepEqual(MERCARI_DAG[2].dependsOn, ["mercari_discovery"]);
  assert.deepEqual(MERCARI_DAG[4].dependsOn, ["rakuten_discovery"]);
  assert.deepEqual(MERCARI_DAG.find((unit) => unit.name === "mercari_close").dependsOn, ["mercari_tracking"]);
  assert.deepEqual(MERCARI_DAG.find((unit) => unit.name === "rakuten_close").dependsOn, ["rakuten_tracking"]);
  assert.deepEqual(MERCARI_DAG.find((unit) => unit.name === "payment_reminders").dependsOn, ["mercari_lifecycle"]);
});

test("orchestrator defaults to shadow and live requires a double opt-in", () => {
  assert.equal(resolveExecutionMode([], {}), "shadow");
  assert.equal(resolveExecutionMode(["--shadow"], {}), "shadow");
  assert.equal(resolveExecutionMode([], { ORCHESTRATOR_MODE: "shadow" }), "shadow");
  assert.throws(() => resolveExecutionMode(["--live"], {}), /ORCHESTRATOR_LIVE_ENABLED/);
  assert.throws(() => resolveExecutionMode(["--live"], { ORCHESTRATOR_LIVE_ENABLED: "true" }), /capability_flag/);
  assert.equal(resolveExecutionMode(["--live"], { ORCHESTRATOR_LIVE_ENABLED: "true", ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT: "true" }), "live");
  assert.equal(resolveExecutionMode([], { ORCHESTRATOR_MODE: "live", ORCHESTRATOR_LIVE_ENABLED: "true", ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT: "true" }), "live");
  assert.throws(() => resolveExecutionMode(["--shadow", "--live"], { ORCHESTRATOR_LIVE_ENABLED: "true" }), /conflicting/);
  assert.throws(() => resolveExecutionMode(["--shadow"], { ORCHESTRATOR_MODE: "live" }), /conflicting_orchestrator_mode_sources/);
  assert.throws(() => resolveExecutionMode([], { ORCHESTRATOR_MODE: "wat" }), /invalid_ORCHESTRATOR_MODE/);
  assert.throws(() => resolveExecutionMode(["--wat"], {}), /unknown_orchestrator_arguments/);
});

test("live orchestration is unbounded while shadow runs are bounded", () => {
  assert.equal(resolvePhaseLimit({}, "live"), null);
  assert.equal(resolvePhaseLimit({}, "shadow"), 100);
  assert.equal(resolvePhaseLimit({ ORCHESTRATOR_SHADOW_LIMIT: "7" }, "shadow"), 7);
});

test("Rakuten discovery exact selection rejects neighboring provider rows", () => {
  const orders = [
    { orderNumber: "neighbor" }, { orderNumber: "target" }, { orderNo: "legacy-target" },
  ];
  assert.deepEqual(selectExactRakutenDiscoveryOrders(orders, "target"), [{ orderNumber: "target" }]);
  assert.deepEqual(selectExactRakutenDiscoveryOrders(orders, "missing"), []);
});

test("canonical live canary CLI is exact, bounded and fail closed", () => {
  const env = {
    ORCHESTRATOR_LIVE_ENABLED: "true",
    ORCHESTRATOR_ENABLE_MERCARI_TRACKING: "true",
  };
  assert.equal(CANARY_CAPABILITY_MATRIX.length, MERCARI_DAG.length);
  assert.equal(CANARY_CAPABILITIES.mercari_tracking.requiredScope, "shop_order_id");
  assert.equal(CANARY_CAPABILITIES.mercari_tracking.exactCanarySupported, true);
  assert.equal(CANARY_CAPABILITIES.mercari_tracking.externalWrite, false);
  assert.equal(CANARY_CAPABILITIES.mercari_eligibility.exactCanarySupported, true);
  assert.equal(CANARY_CAPABILITIES.mercari_eligibility.externalWrite, true);
  assert.equal(CANARY_CAPABILITIES.payment_reminders.exactCanarySupported, true);
  assert.equal(CANARY_CAPABILITIES.payment_reminders.externalWrite, true);
  assert.equal(CANARY_CAPABILITIES.message_ingestion.exactCanarySupported, true);
  assert.equal(CANARY_CAPABILITIES.rakuten_discovery.exactCanarySupported, true);
  assert.equal(CANARY_CAPABILITIES.mercari_discovery.exactCanarySupported, true);
  assert.ok(CANARY_CAPABILITY_MATRIX.every((capability) => capability.exactCanarySupported));
  assert.deepEqual(resolveOrchestratorRequest([
    "--live", "--canary", "mercari_tracking", "--shop", "Shop2", "--order-id", "order-1", "--limit", "1",
  ], env).canary, {
    ...CANARY_CAPABILITIES.mercari_tracking, orderId: "order-1", shop: "Shop2", platform: "", limit: 1,
  });
  assert.throws(() => resolveOrchestratorRequest(["--live", "--canary", "mercari_tracking", "--shop", "Shop2", "--limit", "1"], env), /requires_order_id/);
  assert.throws(() => resolveOrchestratorRequest(["--live", "--canary", "mercari_tracking", "--shop", "Shop2", "--order-id", "order-1", "--limit", "2"], env), /requires_limit_1/);
  assert.throws(() => resolveOrchestratorRequest(["--live", "--canary", "mercari_tracking", "--order-id", "order-1", "--limit", "1"], env), /requires_valid_shop/);
  assert.throws(() => resolveOrchestratorRequest(["--live", "--canary", "unknown_capability", "--shop", "Shop2", "--order-id", "order-1", "--limit", "1"], env), /unsupported_canary_capability/);
  assert.throws(() => resolveOrchestratorRequest(["--shadow", "--canary", "mercari_tracking", "--shop", "Shop2", "--order-id", "order-1", "--limit", "1"], env), /explicit_live_mode/);
  assert.throws(() => resolveOrchestratorRequest(["--live", "--order-id", "order-1"], env), /scoped_arguments_require_canary/);
  const integrityEnv = { ORCHESTRATOR_LIVE_ENABLED: "true", ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT: "true" };
  assert.equal(resolveOrchestratorRequest([
    "--live", "--canary", "integrity_audit", "--platform", "rakuten", "--order-id", "r-1", "--limit", "1",
  ], integrityEnv).canary.platform, "rakuten");
  assert.throws(() => resolveOrchestratorRequest([
    "--live", "--canary", "integrity_audit", "--order-id", "r-1", "--limit", "1",
  ], integrityEnv), /requires_platform/);
  assert.throws(() => resolveOrchestratorRequest([
    "--live", "--canary", "integrity_audit", "--platform", "rakuten", "--shop", "Shop1", "--order-id", "r-1", "--limit", "1",
  ], integrityEnv), /rakuten_canary_rejects_shop_scope/);
});

test("immutable runtime gate binds loaded source, current pointer and release identity", () => {
  assert.deepEqual(verifyImmutableRuntime({}), { ok: true, enforced: false });
  const sha = "a".repeat(40);
  const release = `/opt/order-mgmt-orchestrator/releases/${sha}`;
  const realpath = (value) => value === "/opt/order-mgmt-orchestrator/current" ? release : value;
  assert.equal(verifyImmutableRuntime(
    { ORCHESTRATOR_REQUIRE_IMMUTABLE_RELEASE: "true", RELEASE_VERSION: sha },
    { modulePath: `${release}/src/orchestrator.mjs`, realpath },
  ).enforced, true);
  assert.throws(() => verifyImmutableRuntime(
    { ORCHESTRATOR_REQUIRE_IMMUTABLE_RELEASE: "true", RELEASE_VERSION: "dev" },
  ), /exact_release_sha/);
  assert.throws(() => verifyImmutableRuntime(
    { ORCHESTRATOR_REQUIRE_IMMUTABLE_RELEASE: "true", RELEASE_VERSION: sha },
    { modulePath: `/opt/order-mgmt-orchestrator/releases/${"b".repeat(40)}/src/orchestrator.mjs`, realpath },
  ), /source_release_mismatch/);
  assert.throws(() => verifyImmutableRuntime(
    { ORCHESTRATOR_REQUIRE_IMMUTABLE_RELEASE: "true", RELEASE_VERSION: sha },
    { modulePath: `${release}/src/orchestrator.mjs`, realpath: (value) => value.includes("current") ? "/opt/other" : value },
  ), /current_pointer_mismatch/);
});

test("durable step summaries retain bounded non-PII phase accounting", () => {
  const summary = summarizeStepResults(
    { phases: ["auto_approve_orders"] },
    [{ ok: true, completion_state: "completed", summary: { candidates_loaded: 4, orders_evaluated: 4, orders_approved: 2, results: [{ order_id: "secret" }] } }],
  );
  assert.deepEqual(summary.by_phase.auto_approve_orders.counts, {
    candidates_loaded: 4, orders_evaluated: 4, orders_approved: 2,
    rows_approved: 0, patch_failures: 0, messages_sent: 0, messages_skipped: 0, message_failures: 0,
  });
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("shadow run persists read-backed run and step terminal states", async () => {
  const state = fakeDb();
  const executed = [];
  const executionTransports = [];
  const result = await runOrchestrator({
    argv: ["--shadow"], env: { RELEASE_VERSION: "test" }, db: state.db,
    runId: "run-test", ownerId: "owner-test",
    execute: async (_phaseEnv, context) => { executed.push(context); executionTransports.push(context.localTransport); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(state.runs.get("run-test").status, "SUCCEEDED");
  assert.deepEqual(executed.map((entry) => entry.phase), [
    "sync_mercari_messages", "pull_shop_orders", "reconcile_order_lifecycle",
    "pull_rakuten_orders", "reconcile_rakuten_lifecycle", "audit_pipeline_integrity",
    "send_payment_reminders",
  ]);
  assert.ok([...state.steps.values()].every((step) => ["SUCCEEDED", "SKIPPED"].includes(step.status)));
  assert.deepEqual(new Set(executionTransports), new Set([true]));
  assert.equal(state.rpcCalls.at(-1).name, "release_order_orchestrator_lease");
});

test("one channel failure blocks only its declared dependants", async () => {
  const state = fakeDb();
  const executed = [];
  const result = await runOrchestrator({
    argv: ["--shadow"], env: {}, db: state.db, runId: "run-isolation", ownerId: "owner-test",
    execute: async (_env, context) => {
      executed.push(context.phase);
      return { ok: context.phase !== "pull_shop_orders" };
    },
  });
  assert.equal(result.ok, false);
  assert.ok(executed.includes("pull_rakuten_orders"));
  assert.ok(executed.includes("reconcile_rakuten_lifecycle"));
  assert.ok(!executed.includes("reconcile_order_lifecycle"));
  assert.ok(!executed.includes("send_payment_reminders"));
});

test("live run passes the explicit unbounded contract to every phase", async () => {
  const env = {
      RELEASE_VERSION: "test", ORCHESTRATOR_LIVE_ENABLED: "true",
      ORCHESTRATOR_RUNTIME_HOST: "vps-test",
      ...Object.fromEntries(LIVE_CAPABILITY_FLAGS.map((flag) => [flag, "true"])),
  };
  const state = fakeDb({ ownershipRows: ownershipRowsFor(env) });
  const executed = [];
  const result = await runOrchestrator({
    argv: ["--live"], env, db: state.db,
    runId: "run-live", ownerId: "owner-live",
    execute: async (_env, context) => { executed.push(context); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(executed.length, MERCARI_DAG.flatMap((unit) => unit.phases).length);
  assert.ok(executed.every((entry) => entry.limit === null));
});

test("live cutover runs only enabled capabilities and blocks enabled dependants of disabled owners", async () => {
  const env = {
      RELEASE_VERSION: "test", ORCHESTRATOR_RUNTIME_HOST: "vps-test",
      ORCHESTRATOR_LIVE_ENABLED: "true",
      ORCHESTRATOR_ENABLE_MERCARI_PROJECTION: "true",
      ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT: "true",
  };
  const state = fakeDb({ ownershipRows: ownershipRowsFor(env) });
  const executed = [];
  const result = await runOrchestrator({
    argv: ["--live"], env,
    db: state.db, runId: "run-cutover", ownerId: "owner-live",
    execute: async (_env, context) => { executed.push(context.phase); return { ok: true }; },
  });
  assert.deepEqual(executed, ["audit_pipeline_integrity"]);
  assert.equal(result.ok, false);
  const projection = result.results.find((entry) => entry.step === "mercari_projection");
  assert.equal(projection.blocked, true);
  assert.deepEqual(projection.blocked_by, ["mercari_eligibility"]);
});

test("live canary executes only the selected owned capability with exact scope", async () => {
  const env = {
    RELEASE_VERSION: "test", ORCHESTRATOR_RUNTIME_HOST: "vps-test",
    ORCHESTRATOR_LIVE_ENABLED: "true", ORCHESTRATOR_ENABLE_MERCARI_TRACKING: "true",
  };
  const state = fakeDb({ ownershipRows: ownershipRowsFor(env) });
  const executed = [];
  const result = await runOrchestrator({
    argv: ["--live", "--canary", "mercari_tracking", "--shop", "Shop3", "--order-id", "order-123", "--limit", "1"],
    env, db: state.db, runId: "run-canary", ownerId: "owner-live",
    execute: async (_env, context) => { executed.push(context); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.canary, "mercari_tracking");
  assert.equal(state.runs.get("run-canary").trigger_type, "manual_canary");
  assert.equal(state.runs.get("run-canary").summary.canary_capability, "mercari_tracking");
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0], {
    phase: "pull_giga_tracking", shops: ["Shop3"], limit: 1, orderId: "order-123",
    platform: "",
    dryRun: false, runId: "run-canary", mode: "orchestrator_live_canary",
    triggerType: "manual_canary", cron: "", phaseRunner: executed[0].phaseRunner, localTransport: true,
  });
  assert.equal(typeof executed[0].phaseRunner, "function");
  assert.equal(result.results.filter((entry) => entry.canary_not_selected).length, MERCARI_DAG.length - 1);
});

test("live canary still requires exact durable ownership", async () => {
  const state = fakeDb();
  const executed = [];
  const result = await runOrchestrator({
    argv: ["--live", "--canary", "rakuten_close", "--order-id", "order-9", "--limit", "1"],
    env: {
      RELEASE_VERSION: "test", ORCHESTRATOR_RUNTIME_HOST: "vps-test",
      ORCHESTRATOR_LIVE_ENABLED: "true", ORCHESTRATOR_ENABLE_RAKUTEN_CLOSE: "true",
    },
    db: state.db, runId: "run-canary-unowned", ownerId: "owner-live",
    execute: async (_env, context) => { executed.push(context); return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(executed, []);
  assert.deepEqual(result.results.find((entry) => entry.step === "rakuten_close").blocked_by, ["scheduler_ownership_missing"]);
});

test("live capability is blocked before execution without matching durable ownership", async () => {
  const state = fakeDb();
  const executed = [];
  const result = await runOrchestrator({
    argv: ["--live"],
    env: {
      RELEASE_VERSION: "test", ORCHESTRATOR_RUNTIME_HOST: "vps-test",
      ORCHESTRATOR_LIVE_ENABLED: "true", ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT: "true",
    },
    db: state.db, runId: "run-unowned", ownerId: "owner-live",
    execute: async (_env, context) => { executed.push(context.phase); return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(executed, []);
  const audit = result.results.find((entry) => entry.step === "integrity_audit");
  assert.deepEqual(audit.blocked_by, ["scheduler_ownership_missing"]);
  const durableAudit = state.steps.get("run-unowned:integrity_audit:1");
  assert.equal(durableAudit.status, "BLOCKED");
  assert.equal(durableAudit.error_code, "scheduler_ownership_missing");
  assert.equal(durableAudit.result_counts.scheduler_ownership_gate, "scheduler_ownership_missing");
});

test("live ownership requires exact owner, host, release, enabled state and unexpired evidence", async () => {
  const unit = MERCARI_DAG.find((entry) => entry.name === "integrity_audit");
  const valid = ownershipRowsFor({ ORCHESTRATOR_ENABLE_INTEGRITY_AUDIT: "true" })[0];
  const check = async (patch = {}, now = new Date()) => verifyLiveSchedulerOwnership(
    fakeDb({ ownershipRows: [{ ...valid, ...patch }] }).db.supabase,
    unit, { release: "test", runtimeHost: "vps-test", now },
  );
  assert.deepEqual(await check(), { ok: true });
  assert.equal((await check({ scheduler_owner: "cloudflare_worker" })).reason, "scheduler_owner_mismatch");
  assert.equal((await check({ runtime_host: "other-vps" })).reason, "scheduler_runtime_host_mismatch");
  assert.equal((await check({ release_version: "old" })).reason, "scheduler_release_mismatch");
  assert.equal((await check({ kill_switch_state: "disabled" })).reason, "scheduler_not_enabled");
  assert.equal((await check({ legacy_scheduler_disabled: false })).reason, "legacy_scheduler_not_disabled");
  assert.equal((await check({ expires_at: new Date(Date.now() - 1_000).toISOString() })).reason, "scheduler_ownership_expired");
  assert.equal((await verifyLiveSchedulerOwnership(
    fakeDb({ ownershipRows: [valid] }).db.supabase, unit,
    { release: "<exact-deployed-git-sha>", runtimeHost: "vps-test" },
  )).reason, "scheduler_ownership_identity_incomplete");
});

test("unexpected execution failure marks the durable run FAILED and releases lease", async () => {
  const state = fakeDb();
  await assert.rejects(() => runOrchestrator({
    argv: ["--shadow"], env: {}, db: state.db, runId: "run-fail", ownerId: "owner-test",
    execute: async () => { throw new Error("relay_broke"); },
  }), /relay_broke/);
  assert.equal(state.runs.get("run-fail").status, "FAILED");
  assert.equal(state.runs.get("run-fail").summary.error_code, "relay_broke");
  assert.equal(state.rpcCalls.at(-1).name, "release_order_orchestrator_lease");
});

test("control-plane migration exposes only ownership-bound lease RPCs to service_role", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907100000_add_orchestrator_control_plane.sql", import.meta.url), "utf8");
  for (const fn of ["acquire_order_orchestrator_lease", "heartbeat_order_orchestrator_lease", "release_order_orchestrator_lease"]) {
    assert.match(sql, new RegExp(`SECURITY DEFINER[\\s\\S]*REVOKE ALL ON FUNCTION public\\.${fn}`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}`));
  }
  assert.match(sql, /heartbeat_order_orchestrator_lease[\s\S]*owner_id = p_owner_id[\s\S]*run_id = p_run_id[\s\S]*expires_at > now\(\)/);
  assert.match(sql, /REVOKE ALL ON pipeline_orchestration_runs, pipeline_steps, order_orchestrator_lease FROM anon, authenticated/);
});
