#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBaserowClient } from "../src/lib/db.mjs";
import { getExternalOperation, resolveExternalOperation } from "../src/lib/external-operation-ledger.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: safeErrorCode(error) }));
    process.exitCode = 1;
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  loadEnvFileIfPresent(args.envPath || path.join(REPO_ROOT, "env", "dev.env"), env);
  const client = createBaserowClient({
    ...env,
    DATABASE_BACKEND: "supabase",
    ORDERMGMT_WORKLOAD_ID: "ordermgmt_external_operation_resolution",
  });
  const result = await reconcileExternalOperation({ supabase: client.supabase, ...args });
  console.log(JSON.stringify(result, null, 2));
}

export async function reconcileExternalOperation({
  supabase, operationKey, expectedStatus, outcome, evidenceRef, reason, resolvedBy,
  confirmWrite = false, _inject = {},
}) {
  if (!operationKey) throw codedError("operation_key_required");
  const normalized = validateResolutionInput({ expectedStatus, outcome, evidenceRef, reason, resolvedBy });
  const getOperation = _inject.getOperation || getExternalOperation;
  const resolveOperation = _inject.resolveOperation || resolveExternalOperation;
  const current = await getOperation(supabase, operationKey);
  const proposedStatus = normalized.outcome === "APPLIED" ? "ALREADY_APPLIED" : "RELEASED";
  const summary = {
    ok: true,
    mode: confirmWrite ? "write" : "dry_run",
    operation: publicOperation(current),
    proposal: {
      expected_status: normalized.expectedStatus,
      outcome: normalized.outcome,
      resulting_status: proposedStatus,
      evidence_ref: normalized.evidenceRef,
      reason: normalized.reason,
      resolved_by: normalized.resolvedBy,
    },
  };
  if (!confirmWrite) return summary;
  if (current.status !== normalized.expectedStatus) {
    throw codedError("expected_status_mismatch");
  }
  const resolved = await resolveOperation(supabase, {
    operationKey, expectedStatus: normalized.expectedStatus, outcome: normalized.outcome,
    evidenceRef: normalized.evidenceRef, reason: normalized.reason, resolvedBy: normalized.resolvedBy,
  });
  return {
    ...summary,
    operation: publicOperation(resolved.operation),
    resolution: resolved.resolution,
  };
}

function validateResolutionInput({ expectedStatus, outcome, evidenceRef, reason, resolvedBy }) {
  const value = {
    expectedStatus: String(expectedStatus || "").trim().toUpperCase(),
    outcome: String(outcome || "").trim().toUpperCase(),
    evidenceRef: String(evidenceRef || "").trim(),
    reason: String(reason || "").trim(),
    resolvedBy: String(resolvedBy || "").trim(),
  };
  if (!["RESERVED", "UNKNOWN_RESULT", "DEFINITIVE_FAILURE"].includes(value.expectedStatus)
      || !["APPLIED", "NOT_APPLIED"].includes(value.outcome)
      || value.evidenceRef.length < 3 || value.reason.length < 10 || value.resolvedBy.length < 2) {
    throw codedError("external_operation_resolution_invalid");
  }
  return value;
}

export function parseArgs(argv) {
  const args = { confirmWrite: false, help: false, envPath: "" };
  const valueOptions = new Map([
    ["--operation-key", "operationKey"], ["--expected-status", "expectedStatus"],
    ["--outcome", "outcome"], ["--evidence-ref", "evidenceRef"],
    ["--reason", "reason"], ["--resolved-by", "resolvedBy"], ["--env-path", "envPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--confirm-write") args.confirmWrite = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (valueOptions.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw codedError(`missing_value:${token.slice(2)}`);
      args[valueOptions.get(token)] = value;
      index += 1;
    } else throw codedError("unknown_argument");
  }
  return args;
}

function publicOperation(row) {
  return {
    operation_key: row.operation_key,
    capability: row.capability,
    platform: row.platform,
    source_store_id: row.source_store_id,
    order_id: row.order_id,
    run_id: row.run_id,
    status: row.status,
    reserved_at: row.reserved_at,
    finalized_at: row.finalized_at,
    error_code: row.error_code,
    reconciliation_note: row.reconciliation_note,
    updated_at: row.updated_at,
  };
}

function loadEnvFileIfPresent(filePath, env) {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] in env) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[match[1]] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function codedError(code) { const error = new Error(code); error.code = code; return error; }
function safeErrorCode(error) {
  const code = String(error?.code || error?.message || "external_operation_resolution_failed");
  return /^[a-z0-9_:-]+$/i.test(code) ? code.slice(0, 120) : "external_operation_resolution_failed";
}
function printUsage() {
  console.log(`Usage:
  Dry-run audit:
    node scripts/resolve-external-operation.mjs --operation-key <key> --expected-status <status> --outcome <APPLIED|NOT_APPLIED> --evidence-ref <ref> --reason <reason> --resolved-by <actor>
  Apply one reviewed resolution:
    add --confirm-write

Writes are single-operation, compare-and-set, service-role-only, and require authoritative external evidence. Age alone is never evidence.`);
}
