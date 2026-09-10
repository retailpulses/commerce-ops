import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFreshness, parseFreshnessScopes } from "../src/lib/lifecycle-freshness.mjs";
import { normalizeMercariLifecycleStatus } from "../src/lib/lifecycle-reconciler.mjs";

const NOW = new Date("2026-09-07T00:00:00.000Z");

test("freshness accepts complete observations inside SLA", () => {
  const result = evaluateFreshness([{
    platform: "mercari", source_store_id: "shop1", completion_state: "accounting_complete",
    observed_at: "2026-09-06T23:30:00.000Z",
  }], ["mercari:shop1"], { now: NOW, maxAgeMinutes: 60 });
  assert.equal(result.ok, true);
});

test("freshness fails closed for missing, partial, stale, and future evidence", () => {
  const result = evaluateFreshness([
    { platform: "mercari", source_store_id: "partial", completion_state: "partial", observed_at: "2026-09-06T23:50:00.000Z" },
    { platform: "mercari", source_store_id: "stale", completion_state: "accounting_complete", observed_at: "2026-09-06T20:00:00.000Z" },
    { platform: "mercari", source_store_id: "future", completion_state: "accounting_complete", observed_at: "2026-09-07T00:01:00.000Z" },
  ], ["mercari:missing", "mercari:partial", "mercari:stale", "mercari:future"], { now: NOW, maxAgeMinutes: 60 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((item) => item.reason), ["missing", "partial", "stale", "future"]);
});

test("scope parsing is normalized and deterministic", () => {
  assert.deepEqual(parseFreshnessScopes(" Mercari:Shop1,mercari:shop1,Rakuten:main "), ["mercari:shop1", "rakuten:main"]);
});

test("Mercari lifecycle mapping accepts only governed statuses", () => {
  assert.equal(normalizeMercariLifecycleStatus(" waiting_for_shipping "), "WAITING_FOR_SHIPPING");
  assert.equal(normalizeMercariLifecycleStatus("COMPLETED"), "COMPLETED");
  assert.equal(normalizeMercariLifecycleStatus("NEW_UNMAPPED_STATUS"), null);
  assert.equal(normalizeMercariLifecycleStatus(null), null);
});
