#!/usr/bin/env node
import process from "node:process";
import { createBaserowClient } from "../src/lib/db.mjs";
import { validateShadowRunAcceptance } from "../src/lib/shadow-run-acceptance.mjs";
import { phasesForWorkload, validateWorkloadQuiescence } from "../src/lib/workload-quiescence.mjs";

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 160) }));
  process.exitCode = 1;
});

export async function main(argv = process.argv.slice(2), env = process.env, injected = {}) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  const client = injected.client || createBaserowClient({ ...env, DATABASE_BACKEND: "supabase" });
  if (client.type !== "supabase") throw new Error("quiescence_requires_supabase");
  const sb = client.supabase;
  const phases = phasesForWorkload(args.workloadId);
  if (!phases.length) throw new Error("unknown_workload_id");
  const since = new Date(Date.now() - 24 * 60 * 60000).toISOString();
  const [ownershipResult, phaseResult, openPhaseResult, leaseResult, operationResult, shadowRunResult] = await Promise.all([
    sb.from("order_scheduler_ownership").select("workload_id,scheduler_owner,kill_switch_state,evidence_observed_at,expires_at").eq("workload_id", args.workloadId).maybeSingle(),
    sb.from("pipeline_run_log").select("run_id,step,started_at,ended_at,ok").in("step", phases).gte("started_at", since).order("started_at", { ascending: false }).limit(5000),
    sb.from("pipeline_run_log").select("run_id,step,started_at,ended_at,ok").in("step", phases).is("ended_at", null).limit(5000),
    sb.from("order_orchestrator_lease").select("lease_name,owner_id,run_id,expires_at").limit(1),
    sb.from("external_operation_attempts").select("operation_key,capability,status").in("status", ["RESERVED", "UNKNOWN_RESULT", "DEFINITIVE_FAILURE"]).limit(1),
    sb.from("pipeline_orchestration_runs").select("run_id,owner_id,release_version,execution_mode,status,started_at,ended_at").eq("release_version", args.releaseVersion).eq("execution_mode", "shadow").order("started_at", { ascending: false }).limit(1),
  ]);
  for (const [name, result] of [["ownership", ownershipResult], ["phase_runs", phaseResult], ["open_phase_runs", openPhaseResult], ["lease", leaseResult], ["operations", operationResult], ["shadow_run", shadowRunResult]]) {
    if (result.error) throw new Error(`${name}_read_failed:${result.error.message}`);
  }
  const shadowRun = shadowRunResult.data?.[0] || null;
  let shadowSteps = [];
  let shadowAudits = [];
  if (shadowRun) {
    const [stepsResult, auditsResult] = await Promise.all([
      sb.from("pipeline_steps").select("run_id,step_name,sequence,status,ended_at,result_counts").eq("run_id", shadowRun.run_id).order("sequence", { ascending: true }),
      sb.from("pipeline_run_log").select("id,run_id").eq("run_id", shadowRun.run_id).limit(1),
    ]);
    if (stepsResult.error || auditsResult.error) throw new Error("shadow_acceptance_evidence_read_failed");
    shadowSteps = stepsResult.data || [];
    shadowAudits = auditsResult.data || [];
  }
  const shadowAcceptance = validateShadowRunAcceptance({
    run: shadowRun, steps: shadowSteps, lease: null, legacyAuditRows: shadowAudits,
    releaseVersion: args.releaseVersion, runtimeHost: args.runtimeHost,
  });
  const phaseRuns = [...new Map([...(phaseResult.data || []), ...(openPhaseResult.data || [])].map((row) => [`${row.run_id}:${row.step}`, row])).values()];
  const result = validateWorkloadQuiescence({
    ownership: ownershipResult.data, phaseRuns, lease: leaseResult.data?.[0] || null,
    openOperations: operationResult.data || [], shadowAcceptance, workloadId: args.workloadId,
    drainMinutes: args.drainMinutes,
  });
  const output = { ...result, shadow_acceptance: shadowAcceptance };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 2;
  return output;
}

export function parseArgs(argv) {
  const out = { drainMinutes: 40, help: false };
  const values = new Map([["--workload-id", "workloadId"], ["--release-version", "releaseVersion"], ["--runtime-host", "runtimeHost"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--drain-minutes") {
      out.drainMinutes = Number.parseInt(argv[++index], 10);
      if (!Number.isInteger(out.drainMinutes) || out.drainMinutes < 1 || out.drainMinutes > 1440) throw new Error("invalid_drain_minutes");
    } else if (values.has(token)) {
      const value = String(argv[++index] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`missing_value:${token.slice(2)}`);
      out[values.get(token)] = value;
    } else throw new Error("unknown_argument");
  }
  if (!out.help && !out.workloadId) throw new Error("workload_id_required");
  if (!out.help && !/^[0-9a-f]{40}$/.test(out.releaseVersion || "")) throw new Error("exact_release_version_required");
  if (!out.help && !out.runtimeHost) throw new Error("runtime_host_required");
  return out;
}

function printUsage() {
  console.log("Usage: node scripts/verify-workload-quiescence.mjs --workload-id <id> --release-version <40-char-sha> --runtime-host <host> [--drain-minutes 40]");
}
