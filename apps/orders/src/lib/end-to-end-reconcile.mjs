import { collectPipelineHealthSnapshot } from "./pipeline-health.mjs";

export async function runEndToEndReconcile({
  env,
  shops,
  inputLimit,
  trackingLimit = 0,
  closeLimit = 0,
  runPullShopOrders,
  runBuildShipments,
  runPushOrders,
  runPullTracking,
  runCloseOrders,
}) {
  const steps = [];
  // build_giga_shipments is intentionally NOT included in the reconciler sequence.
  // The standalone cron build at :3,:13,:23,:33,:43,:53 is the canonical projection
  // path. Including it here created a race window with the standalone build
  // (reconciler at :11 vs standalone at :13), producing duplicate shipment rows
  // for the same order+SKU. Newly ingested orders are projected by the next
  // standalone build (3 min gap to push, 5 min end-to-end SLA).
  // See: fix-plan-issue-2.md, shipment-projector.mjs findMatchingShipmentRows.
  const sequence = [
    ["pull_shop_orders", () => runPullShopOrders({ shops, limit: inputLimit, dryRun: false })],
    ["push_orders_to_giga", () => runPushOrders({ shops, limit: inputLimit })],
    ["pull_giga_tracking", () => runPullTracking({ shops, limit: trackingLimit })],
    ["close_shop_orders", () => runCloseOrders({ shops, limit: closeLimit, dryRun: false })],
  ];

  for (const [step, runner] of sequence) {
    const startedAt = new Date().toISOString();
    try {
      const summary = await runner();
      steps.push({
        step,
        ok: summary && summary.ok !== false,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        summary,
      });
      if (summary && summary.ok === false) break;
    } catch (error) {
      steps.push({
        step,
        ok: false,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        error: normalizeErrorMessage(error),
      });
      break;
    }
  }

  let healthSnapshot;
  try {
    healthSnapshot = await collectPipelineHealthSnapshot(env, { shops });
  } catch (error) {
    healthSnapshot = {
      ok: false,
      error: normalizeErrorMessage(error),
    };
  }

  const stepsOk = steps.every((step) => step.ok !== false);
  const endToEndComplete = isEndToEndComplete(healthSnapshot);
  return {
    ok: stepsOk && endToEndComplete,
    phase: "reconcile_end_to_end",
    input_limit: inputLimit,
    tracking_limit: trackingLimit,
    close_limit: closeLimit,
    end_to_end_complete: endToEndComplete,
    steps,
    health_snapshot: healthSnapshot,
  };
}

function isEndToEndComplete(snapshot) {
  if (!snapshot || snapshot.ok === false) return false;
  return Number(snapshot.missing_shipments_count || 0) === 0
    && Number(snapshot.unsynced_shipments_count || 0) === 0
    && Number(snapshot.shipped_not_closed_count || 0) === 0;
}

function normalizeErrorMessage(error) {
  if (!error) return "unknown_error";
  if (error && typeof error === "object" && error.stack) return String(error.stack);
  return String(error);
}
