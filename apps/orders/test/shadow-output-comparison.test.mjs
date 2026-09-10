import assert from "node:assert/strict";
import test from "node:test";
import { compareShadowToProduction } from "../src/lib/shadow-output-comparison.mjs";

test("compares only common numeric metrics and never auto-proves parity", () => {
  const result = compareShadowToProduction({
    shadowSteps: [{ status: "SUCCEEDED", result_counts: { by_phase: { pull_shop_orders: { ok: true, counts: { processed: 10, nested: { ignored: 1 } } } } } }],
    productionLogs: [{ step: "pull_shop_orders", ok: true, result_counts: { processed: 20, created: 2 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.parity_proven, false);
  assert.equal(result.review_required, true);
  assert.deepEqual(result.comparisons[0].comparable_metrics.processed, {
    shadow_total: 10, production_total: 20, shadow_per_run: 10, production_per_run: 20,
  });
  assert.equal("created" in result.comparisons[0].comparable_metrics, false);
});

test("fails readiness when either owner evidence, comparable metrics, or success is missing", () => {
  assert.equal(compareShadowToProduction({ shadowSteps: [], productionLogs: [] }).ok, false);
  const missingProduction = compareShadowToProduction({
    shadowSteps: [{ status: "SUCCEEDED", result_counts: { by_phase: { pull_shop_orders: { ok: true, counts: { processed: 1 } } } } }],
  });
  assert.equal(missingProduction.ok, false);
  const failed = compareShadowToProduction({
    shadowSteps: [{ status: "FAILED", result_counts: { by_phase: { pull_shop_orders: { ok: false, counts: { processed: 1 } } } } }],
    productionLogs: [{ step: "pull_shop_orders", ok: true, result_counts: { processed: 1 } }],
  });
  assert.equal(failed.ok, false);
});
