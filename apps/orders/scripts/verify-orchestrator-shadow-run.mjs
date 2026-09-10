#!/usr/bin/env node
import process from "node:process";
import { createBaserowClient } from "../src/lib/db.mjs";
import { validateShadowRunAcceptance } from "../src/lib/shadow-run-acceptance.mjs";

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 160) }));
  process.exitCode = 1;
});

export async function main(argv = process.argv.slice(2), env = process.env, injected = {}) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  const client = injected.client || createBaserowClient({ ...env, DATABASE_BACKEND: "supabase" });
  if (client.type !== "supabase") throw new Error("shadow_acceptance_requires_supabase");
  let query = client.supabase.from("pipeline_orchestration_runs")
    .select("run_id,owner_id,release_version,execution_mode,status,started_at,ended_at,summary")
    .eq("execution_mode", "shadow").eq("release_version", args.releaseVersion)
    .gte("started_at", new Date(Date.now() - args.sinceMinutes * 60000).toISOString())
    .order("started_at", { ascending: false }).limit(1);
  if (args.runId) query = query.eq("run_id", args.runId);
  const { data: runs, error: runError } = await query;
  if (runError) throw new Error(`shadow_run_read_failed:${runError.message}`);
  const run = Array.isArray(runs) ? runs[0] : null;
  if (!run) return finish(validateShadowRunAcceptance({ run: null, steps: [], releaseVersion: args.releaseVersion, runtimeHost: args.runtimeHost }));
  const [{ data: steps, error: stepError }, { data: lease, error: leaseError }, { data: audits, error: auditError }] = await Promise.all([
    client.supabase.from("pipeline_steps").select("run_id,step_name,sequence,status,ended_at,result_counts,error_code").eq("run_id", run.run_id).order("sequence", { ascending: true }),
    client.supabase.from("order_orchestrator_lease").select("lease_name,owner_id,run_id,expires_at").eq("run_id", run.run_id).maybeSingle(),
    client.supabase.from("pipeline_run_log").select("id,run_id").eq("run_id", run.run_id).limit(1),
  ]);
  if (stepError) throw new Error(`shadow_steps_read_failed:${stepError.message}`);
  if (leaseError) throw new Error(`shadow_lease_read_failed:${leaseError.message}`);
  if (auditError) throw new Error(`shadow_legacy_audit_read_failed:${auditError.message}`);
  return finish(validateShadowRunAcceptance({ run, steps, lease, legacyAuditRows: audits, releaseVersion: args.releaseVersion, runtimeHost: args.runtimeHost }));
}

function finish(result) {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  return result;
}

export function parseArgs(argv) {
  const out = { sinceMinutes: 60, runId: "", help: false };
  const values = new Map([["--release-version", "releaseVersion"], ["--runtime-host", "runtimeHost"], ["--run-id", "runId"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--since-minutes") {
      out.sinceMinutes = Number.parseInt(argv[++index], 10);
      if (!Number.isInteger(out.sinceMinutes) || out.sinceMinutes < 1 || out.sinceMinutes > 1440) throw new Error("invalid_since_minutes");
    } else if (values.has(token)) {
      const value = String(argv[++index] || "").trim();
      if (!value || value.startsWith("--")) throw new Error(`missing_value:${token.slice(2)}`);
      out[values.get(token)] = value;
    } else throw new Error("unknown_argument");
  }
  if (!out.help && !/^[0-9a-f]{40}$/.test(out.releaseVersion || "")) throw new Error("exact_release_version_required");
  if (!out.help && !out.runtimeHost) throw new Error("runtime_host_required");
  return out;
}

function printUsage() {
  console.log("Usage: node scripts/verify-orchestrator-shadow-run.mjs --release-version <40-char-sha> --runtime-host <host> [--run-id <id>] [--since-minutes 60]");
}
