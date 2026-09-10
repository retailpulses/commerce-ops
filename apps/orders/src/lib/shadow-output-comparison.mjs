export function compareShadowToProduction({ shadowSteps = [], productionLogs = [] }) {
  const shadow = aggregateShadow(shadowSteps);
  const production = aggregateProduction(productionLogs);
  // Write-capable production phases are deliberately skipped in shadow and are
  // validated by the window gate. Compare only phases that shadow actually ran.
  const phases = [...shadow.keys()].sort();
  const comparisons = phases.map((phase) => {
    const left = shadow.get(phase) || emptyAggregate();
    const right = production.get(phase) || emptyAggregate();
    const comparableMetrics = [...new Set([...Object.keys(left.metric_totals), ...Object.keys(right.metric_totals)])]
      .filter((key) => key in left.metric_totals && key in right.metric_totals).sort();
    return {
      phase,
      shadow_runs: left.runs,
      production_runs: right.runs,
      shadow_failures: left.failures,
      production_failures: right.failures,
      comparable_metrics: Object.fromEntries(comparableMetrics.map((key) => [key, {
        shadow_total: left.metric_totals[key], production_total: right.metric_totals[key],
        shadow_per_run: average(left.metric_totals[key], left.runs),
        production_per_run: average(right.metric_totals[key], right.runs),
      }])),
      comparison_ready: left.runs > 0 && right.runs > 0 && comparableMetrics.length > 0,
    };
  });
  return {
    ok: comparisons.length > 0 && comparisons.every((item) => item.comparison_ready && item.shadow_failures === 0 && item.production_failures === 0),
    parity_proven: false,
    review_required: true,
    note: "Differences require capability-specific explanation; this report never auto-approves parity or cutover.",
    comparisons,
  };
}

function aggregateShadow(steps) {
  const map = new Map();
  for (const step of steps) {
    const byPhase = step?.result_counts?.by_phase;
    if (!byPhase || typeof byPhase !== "object") continue;
    for (const [phase, evidence] of Object.entries(byPhase)) {
      add(map, phase, evidence?.counts, evidence?.ok === false || step.status !== "SUCCEEDED");
    }
  }
  return map;
}

function aggregateProduction(logs) {
  const map = new Map();
  for (const log of logs) add(map, log.step, log.result_counts, log.ok !== true);
  return map;
}

function add(map, phase, counts, failed) {
  const key = String(phase || "").trim();
  if (!key) return;
  if (!map.has(key)) map.set(key, emptyAggregate());
  const entry = map.get(key);
  entry.runs += 1;
  if (failed) entry.failures += 1;
  for (const [metric, value] of Object.entries(counts || {})) {
    if (typeof value === "number" && Number.isFinite(value)) entry.metric_totals[metric] = (entry.metric_totals[metric] || 0) + value;
  }
}

function emptyAggregate() { return { runs: 0, failures: 0, metric_totals: {} }; }
function average(total, runs) { return runs ? Number((total / runs).toFixed(4)) : null; }
