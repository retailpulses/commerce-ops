#!/usr/bin/env node
import process from "node:process";
import { createBaserowClient } from "../src/lib/db.mjs";
import { completeJstDates, evaluateShadowParity } from "../src/lib/shadow-parity.mjs";
import { compareShadowToProduction } from "../src/lib/shadow-output-comparison.mjs";

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 160) }));
  process.exitCode = 1;
});

export async function main(argv = process.argv.slice(2), env = process.env, injected = {}) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  const now = injected.now || new Date();
  const dates = completeJstDates(now, args.days);
  const since = new Date(`${dates[0]}T00:00:00+09:00`).toISOString();
  const until = new Date(`${dates.at(-1)}T23:59:59.999+09:00`).toISOString();
  const client = injected.client || createBaserowClient({ ...env, DATABASE_BACKEND: "supabase" });
  if (client.type !== "supabase") throw new Error("shadow_parity_requires_supabase");
  const { data: runs, error: runError } = await client.supabase.from("pipeline_orchestration_runs")
    .select("run_id,execution_mode,status,started_at,ended_at,release_version")
    .eq("execution_mode", "shadow").gte("started_at", since).lte("started_at", until)
    .order("started_at", { ascending: true }).limit(5000);
  if (runError) throw new Error(`shadow_runs_read_failed:${runError.message}`);
  const runIds = (runs || []).map((run) => run.run_id);
  const steps = [];
  for (let offset = 0; offset < runIds.length; offset += 50) {
    const { data, error } = await client.supabase.from("pipeline_steps")
      .select("run_id,step_name,status,error_code,result_counts").in("run_id", runIds.slice(offset, offset + 50)).limit(5000);
    if (error) throw new Error(`shadow_steps_read_failed:${error.message}`);
    steps.push(...(data || []));
  }
  const { data: productionLogs, error: productionError } = await client.supabase.from("pipeline_run_log")
    .select("run_id,step,ok,started_at,result_counts").eq("trigger_type", "cron")
    .gte("started_at", since).lte("started_at", until).order("started_at", { ascending: true }).limit(10000);
  if (productionError) throw new Error(`production_run_log_read_failed:${productionError.message}`);
  const window = evaluateShadowParity({ runs, steps, now, days: args.days, minRunsPerDay: args.minRunsPerDay });
  const output_comparison = compareShadowToProduction({ shadowSteps: steps, productionLogs: productionLogs || [] });
  const result = {
    ok: window.ok && output_comparison.ok,
    parity_proven: false,
    review_required: true,
    window,
    output_comparison,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  return result;
}

export function parseArgs(argv) {
  const args = { days: 7, minRunsPerDay: 20, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--days" || token === "--min-runs-per-day") {
      const value = Number.parseInt(argv[++index], 10);
      if (!Number.isInteger(value) || value < 1 || value > (token === "--days" ? 31 : 24)) throw new Error(`invalid_${token.slice(2).replaceAll("-", "_")}`);
      if (token === "--days") args.days = value; else args.minRunsPerDay = value;
    } else throw new Error("unknown_argument");
  }
  return args;
}

function printUsage() {
  console.log("Usage: node scripts/audit-orchestrator-shadow-parity.mjs [--days 7] [--min-runs-per-day 20]");
}
