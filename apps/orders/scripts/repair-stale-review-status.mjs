#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBaserowClient, listAllRows, FIELD, OPTION } from "../src/lib/db.mjs";
import { readSelectValue, statusEquals } from "../src/lib/order-state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ENV_PATHS = [
  path.join(REPO_ROOT, "env", "dev.env"),
  "/opt/OrderMgmt/.env",
];
const DEFAULT_BATCH_SIZE = 100;
const TERMINAL_STATUSES = [OPTION.ORDER_STATUS.COMPLETED, OPTION.ORDER_STATUS.CANCELED];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: safeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }

  loadEnvFileIfPresent(args.envPath || firstExistingPath(DEFAULT_ENV_PATHS), env);
  const client = createBaserowClient({ ...env, DATABASE_BACKEND: "supabase" });
  const summary = await repairStaleReviewStatuses({
    client,
    confirm: args.confirm,
    expectedCount: args.expectedCount,
    batchSize: args.batchSize,
  });
  console.log(JSON.stringify(summary, null, 2));
}

export async function repairStaleReviewStatuses({
  client,
  confirm = false,
  expectedCount,
  batchSize = DEFAULT_BATCH_SIZE,
  listRows = listAllRows,
  updateBatch = updateReviewStatusBatch,
}) {
  if (!client || client.type !== "supabase") {
    throw codedError("supabase_client_required");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw codedError("invalid_batch_size");
  }

  const audit = await auditTerminalReviewStatuses({ client, listRows });
  const baseCounts = {
    completed: audit.completed,
    canceled: audit.canceled,
    terminal: audit.terminal,
    stale: audit.rows.length,
    active_null: audit.activeNull,
  };

  if (!confirm) {
    return {
      ok: true,
      mode: "dry_run",
      counts: { ...baseCounts, updated: 0, batches: 0 },
    };
  }

  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    throw codedError("expected_count_required");
  }
  if (audit.rows.length !== expectedCount) {
    throw codedError("expected_count_mismatch");
  }

  let updated = 0;
  let batches = 0;
  for (const rows of chunk(audit.rows, batchSize)) {
    const affected = await updateBatch(client, rows);
    if (affected !== rows.length) {
      throw codedError("batch_affected_count_mismatch");
    }
    updated += affected;
    batches += 1;
  }

  return {
    ok: true,
    mode: "repair",
    counts: { ...baseCounts, updated, batches },
  };
}

export async function auditTerminalReviewStatuses({ client, listRows = listAllRows }) {
  const statusField = FIELD.SALES.ORDER_STATUS;
  const reviewField = FIELD.SALES.REVIEW_STATUS;
  const results = await Promise.all([
    ...TERMINAL_STATUSES.map((status) => listRows(
      client,
      client.salesOrderTableId,
      {
        [`filter__field_${statusField}__single_select_equal`]: status,
        [`filter__field_${reviewField}__not_empty`]: "1",
      },
    )),
    listRows(client, client.salesOrderTableId, {
      [`filter__field_${reviewField}__empty`]: "1",
    }),
  ]);

  const [completedRows, canceledRows, nullReviewRows] = results;
  const rows = [...completedRows, ...canceledRows].filter(
    (row) => row && row.id && row.review_status != null && String(row.review_status).trim() !== "",
  );
  const activeNullRows = nullReviewRows.filter((row) => {
    const status = readSelectValue(row && row.order_status);
    return !TERMINAL_STATUSES.some((terminalStatus) => statusEquals(status, terminalStatus));
  });
  return {
    completed: completedRows.length,
    canceled: canceledRows.length,
    terminal: completedRows.length + canceledRows.length,
    activeNull: activeNullRows.length,
    rows,
  };
}

export async function updateReviewStatusBatch(client, rows) {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return 0;

  const { data, error } = await client.supabase
    .from(client.salesOrderTableId)
    .update({ review_status: null })
    .in("id", ids)
    .in("order_status", TERMINAL_STATUSES)
    .not("review_status", "is", null)
    .select("id");
  if (error) throw codedError("supabase_batch_update_failed");
  return Array.isArray(data) ? data.length : 0;
}

export function parseArgs(argv) {
  const result = {
    confirm: false,
    expectedCount: undefined,
    batchSize: DEFAULT_BATCH_SIZE,
    envPath: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--confirm") {
      result.confirm = true;
    } else if (token === "--help" || token === "-h") {
      result.help = true;
    } else if (["--expected-count", "--batch-size", "--env-path"].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw codedError(`missing_value:${token.slice(2)}`);
      if (token === "--expected-count") result.expectedCount = parseNonNegativeInteger(value, "expected_count");
      if (token === "--batch-size") result.batchSize = parsePositiveInteger(value, "batch_size");
      if (token === "--env-path") result.envPath = value;
      index += 1;
    } else {
      throw codedError("unknown_argument");
    }
  }
  return result;
}

function chunk(rows, size) {
  const batches = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw codedError(`invalid_${name}`);
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = parseNonNegativeInteger(value, name);
  if (parsed < 1) throw codedError(`invalid_${name}`);
  return parsed;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  const code = String(error?.code || error?.message || "repair_failed");
  return /^[a-z0-9_:-]+$/i.test(code) ? code.slice(0, 120) : "repair_failed";
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next declared environment path.
    }
  }
  return "";
}

function loadEnvFileIfPresent(filePath, env) {
  if (!filePath || (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) return;
  try {
    const contents = readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && !(key in env)) env[key] = value;
    }
  } catch {
    // Credential validation in createBaserowClient reports missing values.
  }
}

function printUsage() {
  console.log(`Usage: node scripts/repair-stale-review-status.mjs [options]

Audits terminal stale and active null review statuses, then clears stale
terminal values in Supabase. Output contains aggregate counts only. Default
mode is read-only.

Options:
  --confirm              Apply the repair (requires --expected-count)
  --expected-count <n>   Exact stale-row count required before any update
  --batch-size <n>       Rows per update, 1-500 (default: ${DEFAULT_BATCH_SIZE})
  --env-path <path>      Optional environment file
  --help                 Show this help
`);
}
