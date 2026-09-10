#!/usr/bin/env node

import process from "node:process";
import { createBaserowClient } from "../src/lib/db.mjs";
import { getSchedulerOwnership, recordSchedulerOwnership, validateSchedulerOwnership } from "../src/lib/scheduler-ownership.mjs";

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 160) }));
  process.exitCode = 1;
});

export async function main(argv = process.argv.slice(2), env = process.env, injected = {}) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  if (!("expectedOwner" in args)) throw new Error("expected_owner_required");
  const value = validateSchedulerOwnership(args);
  const client = injected.client || createBaserowClient({
    ...env, DATABASE_BACKEND: "supabase", ORDERMGMT_WORKLOAD_ID: "ordermgmt_scheduler_ownership",
  });
  const current = await (injected.getOwnership || getSchedulerOwnership)(client.supabase, value.workloadId);
  const proposal = { ...value, currentOwner: current?.scheduler_owner || null };
  if (!args.confirmWrite) {
    console.log(JSON.stringify({ ok: true, mode: "dry_run", proposal }, null, 2));
    return { ok: true, mode: "dry_run", proposal };
  }
  if ((current?.scheduler_owner || null) !== value.expectedOwner) throw new Error("scheduler_ownership_expected_owner_mismatch");
  const result = await (injected.recordOwnership || recordSchedulerOwnership)(client.supabase, value);
  console.log(JSON.stringify({ ok: true, mode: "write", ...result }, null, 2));
  return { ok: true, mode: "write", ...result };
}

export function parseArgs(argv) {
  const out = { confirmWrite: false, legacySchedulerDisabled: false, help: false };
  const options = new Map([
    ["--workload-id", "workloadId"], ["--expected-owner", "expectedOwner"], ["--scheduler-owner", "schedulerOwner"],
    ["--runtime-host", "runtimeHost"], ["--release-version", "releaseVersion"], ["--kill-switch-state", "killSwitchState"],
    ["--evidence-ref", "evidenceRef"], ["--evidence-observed-at", "evidenceObservedAt"], ["--verified-by", "verifiedBy"], ["--expires-at", "expiresAt"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--confirm-write") out.confirmWrite = true;
    else if (token === "--legacy-scheduler-disabled") out.legacySchedulerDisabled = true;
    else if (token === "--help" || token === "-h") out.help = true;
    else if (options.has(token)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`missing_value:${token.slice(2)}`);
      out[options.get(token)] = next; index += 1;
    } else throw new Error("unknown_argument");
  }
  return out;
}

function printUsage() {
  console.log("Usage: node scripts/record-scheduler-ownership.mjs --workload-id <id> --expected-owner <absent|owner> --scheduler-owner <owner> --runtime-host <host> --kill-switch-state <enabled|disabled|unverified> --evidence-ref <ref> --evidence-observed-at <ISO> --verified-by <actor> --expires-at <ISO> [--legacy-scheduler-disabled] [--confirm-write]");
}
