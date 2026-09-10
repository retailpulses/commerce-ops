import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSchedulerOwnership } from "../src/lib/scheduler-ownership.mjs";
import { main, parseArgs } from "../scripts/record-scheduler-ownership.mjs";

const now = new Date("2026-09-07T12:00:00Z");
const valid = {
  workloadId: "ordermgmt_mercari_order_pull", expectedOwner: "disabled",
  schedulerOwner: "vps_order_orchestrator", runtimeHost: "conoha-vps",
  releaseVersion: "abc123", killSwitchState: "enabled", legacySchedulerDisabled: true,
  evidenceRef: "cloudflare-trigger-readback:run-123", evidenceObservedAt: "2026-09-07T11:55:00Z",
  verifiedBy: "operator@example", expiresAt: "2026-09-08T12:00:00Z",
};

test("VPS ownership requires explicit legacy scheduler disable evidence", () => {
  assert.throws(() => validateSchedulerOwnership({ ...valid, legacySchedulerDisabled: false }, now), /input_invalid/);
  assert.equal(validateSchedulerOwnership(valid, now).schedulerOwner, "vps_order_orchestrator");
});

test("VPS ownership cannot bypass a prior disabled quiescence state", () => {
  assert.throws(() => validateSchedulerOwnership({ ...valid, expectedOwner: "cloudflare_worker" }, now), /input_invalid/);
  assert.throws(() => validateSchedulerOwnership({ ...valid, expectedOwner: null }, now), /input_invalid/);
  assert.equal(validateSchedulerOwnership({ ...valid, expectedOwner: "vps_order_orchestrator" }, now).expectedOwner, "vps_order_orchestrator");
  assert.throws(() => validateSchedulerOwnership({
    ...valid, schedulerOwner: "disabled", expectedOwner: "cloudflare_worker", killSwitchState: "enabled", legacySchedulerDisabled: false,
  }, now), /input_invalid/);
});

test("ownership evidence is time bounded", () => {
  assert.throws(() => validateSchedulerOwnership({ ...valid, expiresAt: "2026-10-01T00:00:00Z" }, now), /input_invalid/);
  assert.throws(() => validateSchedulerOwnership({ ...valid, evidenceObservedAt: "2026-09-05T00:00:00Z" }, now), /input_invalid/);
});

test("CLI defaults to dry-run and performs no ownership write", async () => {
  let writes = 0;
  const observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const argv = [
    "--workload-id", valid.workloadId, "--expected-owner", valid.expectedOwner,
    "--scheduler-owner", valid.schedulerOwner, "--runtime-host", valid.runtimeHost,
    "--release-version", valid.releaseVersion, "--kill-switch-state", valid.killSwitchState,
    "--legacy-scheduler-disabled", "--evidence-ref", valid.evidenceRef,
    "--evidence-observed-at", observedAt, "--verified-by", valid.verifiedBy,
    "--expires-at", expiresAt,
  ];
  const result = await main(argv, {}, {
    client: { supabase: {} }, getOwnership: async () => ({ scheduler_owner: "disabled" }),
    recordOwnership: async () => { writes += 1; },
  });
  assert.equal(result.mode, "dry_run");
  assert.equal(writes, 0);
});

test("ownership migration is service-role-only, CAS, audited, and evidence gated", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260907155000_add_scheduler_ownership_registry.sql", import.meta.url), "utf8");
  assert.match(sql, /REVOKE ALL ON order_scheduler_ownership, order_scheduler_ownership_events FROM anon, authenticated/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON order_scheduler_ownership, order_scheduler_ownership_events FROM service_role/);
  assert.match(sql, /GRANT SELECT ON order_scheduler_ownership, order_scheduler_ownership_events TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_order_scheduler_ownership[\s\S]*TO service_role/);
  assert.match(sql, /v_previous\.scheduler_owner <> p_expected_owner/);
  assert.match(sql, /vps ownership requires legacy scheduler disabled evidence/);
  assert.match(sql, /vps ownership requires prior disabled quiescence/);
  assert.match(sql, /disabled ownership requires disabled kill switch/);
  assert.match(sql, /INSERT INTO order_scheduler_ownership_events/);
});

test("CLI parses explicit absent owner as a value", () => {
  assert.equal(parseArgs(["--expected-owner", "absent"]).expectedOwner, "absent");
});
