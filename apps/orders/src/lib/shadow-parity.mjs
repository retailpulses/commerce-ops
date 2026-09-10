const SHADOW_SKIPPED_STEPS = Object.freeze([
  "mercari_eligibility", "mercari_projection", "rakuten_confirmation", "rakuten_projection",
  "mercari_giga_outbound", "rakuten_giga_outbound", "mercari_tracking", "rakuten_tracking",
  "mercari_close", "rakuten_close",
]);

const SHADOW_EXECUTED_STEPS = Object.freeze([
  "message_ingestion", "mercari_discovery", "mercari_lifecycle", "rakuten_discovery",
  "rakuten_lifecycle", "integrity_audit", "payment_reminders",
]);

export function completeJstDates(now, days) {
  const count = Math.max(1, Number(days) || 7);
  const shifted = new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000);
  const currentDayUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return Array.from({ length: count }, (_, index) =>
    new Date(currentDayUtc - (count - index) * 86400000).toISOString().slice(0, 10));
}

export function evaluateShadowParity({ runs, steps, now = new Date(), days = 7, minRunsPerDay = 20 }) {
  const dates = completeJstDates(now, days);
  const dateSet = new Set(dates);
  const relevantRuns = (runs || []).filter((run) => run.execution_mode === "shadow" && dateSet.has(jstDate(run.started_at)));
  const stepsByRun = new Map();
  for (const step of steps || []) {
    if (!stepsByRun.has(step.run_id)) stepsByRun.set(step.run_id, new Map());
    stepsByRun.get(step.run_id).set(step.step_name, step);
  }
  const daily = dates.map((date) => {
    const dayRuns = relevantRuns.filter((run) => jstDate(run.started_at) === date);
    const failures = [];
    for (const run of dayRuns) {
      if (run.status !== "SUCCEEDED" || !run.ended_at) failures.push({ run_id: run.run_id, reason: `run_${String(run.status || "missing").toLowerCase()}` });
      const byName = stepsByRun.get(run.run_id) || new Map();
      for (const name of SHADOW_EXECUTED_STEPS) {
        const status = byName.get(name)?.status;
        if (status !== "SUCCEEDED") failures.push({ run_id: run.run_id, step: name, reason: `expected_succeeded_got_${status || "missing"}` });
      }
      for (const name of SHADOW_SKIPPED_STEPS) {
        const status = byName.get(name)?.status;
        if (status !== "SKIPPED") failures.push({ run_id: run.run_id, step: name, reason: `external_write_not_skipped:${status || "missing"}` });
      }
    }
    if (dayRuns.length < minRunsPerDay) failures.unshift({ reason: "insufficient_daily_runs", observed: dayRuns.length, required: minRunsPerDay });
    return { date, runs: dayRuns.length, ok: failures.length === 0, failures };
  });
  const qualifyingDays = daily.filter((day) => day.ok).length;
  return {
    ok: qualifyingDays === dates.length,
    completion_state: qualifyingDays === dates.length ? "shadow_window_healthy" : "shadow_window_incomplete",
    parity_proven: false,
    parity_note: "This gate proves shadow cadence/terminal states/skip safety only; production-output comparison remains required.",
    required_days: dates.length,
    qualifying_days: qualifyingDays,
    min_runs_per_day: minRunsPerDay,
    daily,
  };
}

function jstDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export { SHADOW_EXECUTED_STEPS, SHADOW_SKIPPED_STEPS };
