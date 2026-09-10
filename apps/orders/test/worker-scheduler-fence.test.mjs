import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdminRunRequest, runScheduledPipelineWithOwnership } from "../worker/index.js";

function clientWithRows(rows = {}, readError = null) {
  return {
    type: "supabase",
    supabase: {
      from(table) {
        assert.equal(table, "order_scheduler_ownership");
        const filters = {};
        const builder = {
          eq(key, value) { filters[key] = value; return builder; },
          async maybeSingle() { return { data: rows[filters.workload_id] || null, error: readError }; },
        };
        return { select() { return builder; } };
      },
    },
  };
}

function row(workloadId, owner = "cloudflare_worker") {
  return {
    workload_id: workloadId, scheduler_owner: owner,
    runtime_host: owner === "cloudflare_worker" ? "cloudflare" : "vps-test",
    release_version: "release-1", kill_switch_state: "enabled",
    legacy_scheduler_disabled: owner !== "cloudflare_worker",
    evidence_observed_at: "2026-09-07T06:00:00.000Z",
    expires_at: "2026-09-08T06:00:00.000Z",
  };
}

test("scheduled Worker executes only phases still owned by Cloudflare", async () => {
  const rows = {
    ordermgmt_mercari_message_sync: row("ordermgmt_mercari_message_sync", "vps_order_orchestrator"),
    ordermgmt_auto_approve_orders: row("ordermgmt_auto_approve_orders"),
    ordermgmt_giga_shipment_build: row("ordermgmt_giga_shipment_build"),
  };
  let invocation = null;
  const result = await runScheduledPipelineWithOwnership({ RELEASE_VERSION: "release-1" }, "3,13,23,33,43,53 * * * *", {
    now: new Date("2026-09-07T07:00:00.000Z"),
    createClient: () => clientWithRows(rows),
    runPipeline: async (_env, input) => { invocation = input; return { ok: true, completion_state: "completed" }; },
  });
  assert.deepEqual(invocation.phases, ["auto_approve_orders", "build_giga_shipments"]);
  assert.equal(result.scheduler_ownership_blocked[0].phase, "sync_mercari_messages");
  assert.equal(result.scheduler_ownership_blocked[0].reason, "scheduler_owner_transferred");
});

test("scheduled Worker dispatches nothing when registry read fails", async () => {
  let invoked = false;
  const result = await runScheduledPipelineWithOwnership({ RELEASE_VERSION: "release-1" }, "6,16,26,36,46,56 * * * *", {
    createClient: () => clientWithRows({}, { message: "database unavailable" }),
    runPipeline: async () => { invoked = true; return { ok: true }; },
  });
  assert.equal(invoked, false);
  assert.equal(result.ok, false);
  assert.equal(result.completion_state, "blocked_by_scheduler_ownership");
  assert.equal(result.scheduler_ownership_blocked[0].reason, "scheduler_ownership_read_failed");
});

test("admin run defaults to dry-run and rejects direct write confirmation", () => {
  assert.deepEqual(resolveAdminRunRequest({ mode: "pull_shop_orders" }), {
    ok: true,
    body: { mode: "pull_shop_orders", dryRun: true, triggerType: "admin_dry_run" },
  });
  assert.deepEqual(resolveAdminRunRequest({ mode: "push_orders_to_giga", confirm_write: true }), {
    ok: false, statusCode: 409, error: "manual_write_requires_governed_orchestrator",
  });
});
