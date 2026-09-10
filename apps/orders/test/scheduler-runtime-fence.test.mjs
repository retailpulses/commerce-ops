import assert from "node:assert/strict";
import test from "node:test";
import {
  fenceCloudflareScheduledPhases,
  validateVpsOwnership,
  workloadIdForPhase,
} from "../src/lib/scheduler-runtime-fence.mjs";

function fakeSupabase(rows = {}, readError = null) {
  return {
    from(table) {
      assert.equal(table, "order_scheduler_ownership");
      const filters = {};
      const builder = {
        eq(key, value) { filters[key] = value; return builder; },
        async maybeSingle() { return { data: rows[filters.workload_id] || null, error: readError }; },
      };
      return { select() { return builder; } };
    },
  };
}

function ownership(overrides = {}) {
  return {
    workload_id: "ordermgmt_giga_order_push",
    scheduler_owner: "cloudflare_worker",
    runtime_host: "cloudflare",
    release_version: "release-1",
    kill_switch_state: "enabled",
    legacy_scheduler_disabled: false,
    evidence_observed_at: "2026-09-07T06:00:00.000Z",
    expires_at: "2026-09-08T06:00:00.000Z",
    ...overrides,
  };
}

test("phase mapping is explicit for current and target reconciliation paths", () => {
  assert.equal(workloadIdForPhase("push_orders_to_giga"), "ordermgmt_giga_order_push");
  assert.equal(workloadIdForPhase("reconcile_end_to_end"), "ordermgmt_end_to_end_reconcile");
  assert.equal(workloadIdForPhase("audit_pipeline_integrity"), "ordermgmt_end_to_end_reconcile");
  assert.equal(workloadIdForPhase("unknown"), null);
});

test("Cloudflare preserves pre-cutover unregistered workloads", async () => {
  const result = await fenceCloudflareScheduledPhases(fakeSupabase(), ["push_orders_to_giga"], {
    release: "release-1", now: new Date("2026-09-07T07:00:00.000Z"),
  });
  assert.deepEqual(result, { allowed: ["push_orders_to_giga"], blocked: [] });
});

test("Cloudflare steps down when durable ownership transfers to VPS", async () => {
  const row = ownership({ scheduler_owner: "vps_order_orchestrator", legacy_scheduler_disabled: true });
  const result = await fenceCloudflareScheduledPhases(fakeSupabase({ [row.workload_id]: row }), ["push_orders_to_giga"], {
    release: "release-1", now: new Date("2026-09-07T07:00:00.000Z"),
  });
  assert.deepEqual(result.allowed, []);
  assert.equal(result.blocked[0].reason, "scheduler_owner_transferred");
});

test("Cloudflare fails closed on ownership read failure and stale registered ownership", async () => {
  const readFailure = await fenceCloudflareScheduledPhases(fakeSupabase({}, { message: "down" }), ["push_orders_to_giga"]);
  assert.equal(readFailure.blocked[0].reason, "scheduler_ownership_read_failed");

  const row = ownership({ expires_at: "2026-09-07T06:59:59.000Z" });
  const expired = await fenceCloudflareScheduledPhases(fakeSupabase({ [row.workload_id]: row }), ["push_orders_to_giga"], {
    release: "release-1", now: new Date("2026-09-07T07:00:00.000Z"),
  });
  assert.equal(expired.blocked[0].reason, "scheduler_ownership_expired");
});

test("Cloudflare registered ownership requires enabled state and exact release", async () => {
  const row = ownership();
  const valid = await fenceCloudflareScheduledPhases(fakeSupabase({ [row.workload_id]: row }), ["push_orders_to_giga"], {
    release: "release-1", now: new Date("2026-09-07T07:00:00.000Z"),
  });
  assert.deepEqual(valid.allowed, ["push_orders_to_giga"]);

  const mismatch = await fenceCloudflareScheduledPhases(fakeSupabase({ [row.workload_id]: row }), ["push_orders_to_giga"], {
    release: "release-2", now: new Date("2026-09-07T07:00:00.000Z"),
  });
  assert.equal(mismatch.blocked[0].reason, "scheduler_release_mismatch");
});

test("VPS ownership rejects evidence older than 24 hours even when unexpired", () => {
  const reason = validateVpsOwnership(ownership({
    scheduler_owner: "vps_order_orchestrator",
    runtime_host: "vps-test",
    legacy_scheduler_disabled: true,
    evidence_observed_at: "2026-09-06T06:59:59.000Z",
    expires_at: "2026-09-08T06:00:00.000Z",
  }), {
    workloadId: "ordermgmt_giga_order_push", release: "release-1", runtimeHost: "vps-test",
    now: new Date("2026-09-07T07:00:00.000Z"),
  });
  assert.equal(reason, "scheduler_ownership_evidence_stale");
});
