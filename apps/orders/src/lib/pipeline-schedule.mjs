// Pipeline schedule — cron-to-phases map extracted from worker/index.js.
// TRANSITIONAL: per-platform cron map. Will be consolidated in Phase B
// (channel-stage timers). Systemd timers become authoritative in Phase 3.
//
// Exports: SCHEDULED_CRON_MODES, phasesForCron, shouldHandleCron

/**
 * Cron expression → phase array map.
 *
 * Each key is a cron expression as configured in wrangler.toml.
 * Values are arrays of canonical phase names.
 *
 * close_rakuten_orders is intentionally unscheduled — RMS close endpoint
 * contract remains unverified. Run manually with --dry-run.
 */
export const SCHEDULED_CRON_MODES = {
  "1 * * * *": ["pull_shop_orders", "reconcile_order_lifecycle"],
  "2 * * * *": ["pull_rakuten_orders", "reconcile_rakuten_lifecycle"],
  "3,13,23,33,43,53 * * * *": ["sync_mercari_messages", "auto_approve_orders", "build_giga_shipments"],
  "4,14,24,34,44,54 * * * *": ["confirm_rakuten_orders"],
  "6,16,26,36,46,56 * * * *": ["push_orders_to_giga"],
  "7,17,27,37,47,57 * * * *": ["build_rakuten_shipments"],
  "8,18,28,38,48,58 * * * *": ["push_rakuten_orders_to_giga"],
  "5,15,25,35,45,55 * * * *": ["pull_giga_tracking"],
  "9,19,29,39,49,59 * * * *": ["close_shop_orders"],
  // RMS close remains disabled until endpoint/payload and historical mutation
  // evidence are authoritatively verified.
  "10,20,30,40,50 * * * *": ["sync_rakuten_tracking"],
  // 0 23 * * * = 08:00 JST — payment reminders fire once per morning
  "0 23 * * *": ["send_payment_reminders"],
};

/**
 * Return the phase array for a given cron expression.
 *
 * @param {string} cron — raw cron expression from the scheduled event
 * @returns {string[]} phase array, or [] for unknown cron (caller must short-circuit)
 */
export function phasesForCron(cron) {
  const key = String(cron || "").trim();
  if (!key) return [];
  const phases = SCHEDULED_CRON_MODES[key];
  return phases ? phases.slice() : [];
}

/**
 * Return true if the cron expression maps to at least one phase.
 *
 * Used by the scheduled handler to gate runPipeline. Extracted as a pure
 * function so the short-circuit decision is independently testable.
 *
 * @param {string} cron
 * @returns {boolean}
 */
export function shouldHandleCron(cron) {
  return phasesForCron(cron).length > 0;
}
