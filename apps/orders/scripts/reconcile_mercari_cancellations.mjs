#!/usr/bin/env node

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { reconcileMercariCancellations } from "../src/lib/cancellation-reconciler.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DEV_ENV_PATH = firstExistingPath([
  path.join(REPO_ROOT, "env", "dev.env"),
  "/opt/rp-order-mgmt/env/dev.env",
  "/Users/user/Documents/April 2026/.env",
]);

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args["?"]) {
    printUsage();
    return;
  }

  loadEnvFileIfPresent(args["env-path"] || process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_DEV_ENV_PATH);

  const shops = normalizeCsv(args.shops || process.env.MERCARI_SHOPS || "");
  const limit = parseInteger(args.limit || "0", 0);
  const dryRun = args["dry-run"] === true || args.dryRun === true;
  const reportDir = path.resolve(args["report-dir"] || path.join(REPO_ROOT, "deliverables", "cancellation-reconcile"));

  const summary = await reconcileMercariCancellations(process.env, { shops, limit, dryRun });

  await fs.mkdir(reportDir, { recursive: true });
  const stamp = dateStamp();
  const jsonPath = path.join(reportDir, `reconcile_cancellations_${stamp}.json`);
  const mdPath = path.join(reportDir, `reconcile_cancellations_${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(mdPath, buildMarkdown(summary), "utf8");

  console.log(JSON.stringify({ ...summary, report_dir: reportDir, report_json: jsonPath, report_md: mdPath }, null, 2));
  process.exitCode = summary && summary.ok ? 0 : 1;
}

function buildMarkdown(summary) {
  const lines = [];
  lines.push(`# Mercari Cancellation Reconcile`);
  lines.push("");
  lines.push(`- Run at: ${new Date().toISOString()}`);
  lines.push(`- Dry run: ${summary.dry_run ? "yes" : "no"}`);
  lines.push(`- Candidate rows: ${summary.counts.candidates}`);
  lines.push(`- Shops run: ${summary.counts.shops_run}`);
  lines.push(`- Canceled after reconcile: ${summary.counts.canceled_after_reconcile}`);
  lines.push("");
  if (Array.isArray(summary.samples) && summary.samples.length) {
    lines.push(`## Samples`);
    for (const item of summary.samples) {
      lines.push(`- ${item.order_id} / ${item.shop_id} / ${item.order_status} (row ${item.row_id})`);
    }
    lines.push("");
  }
  if (Array.isArray(summary.shops) && summary.shops.length) {
    lines.push(`## Relay Runs`);
    for (const item of summary.shops) {
      lines.push(`- ${item.shop}: ${item.ok ? "ok" : "failed"} (status ${item.status ?? "n/a"})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function normalizeCsv(value) {
  return String(value || "")
    .split(/[,\s;]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    const resolved = String(candidate || "").trim();
    if (!resolved) continue;
    try {
      readFileSync(resolved, "utf8");
      return resolved;
    } catch {
      // continue
    }
  }
  return String(paths && paths[0] ? paths[0] : "").trim();
}

function loadEnvFileIfPresent(filePath) {
  try {
    if (process.env.BASEROW_DATABASE_TOKEN) return;
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key]) continue;
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // no-op
  }
}

function dateStamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}`;
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/reconcile_mercari_cancellations.mjs --shops Shop1,Shop2,Shop3,Shop4",
    "",
    "Optional:",
    "  --dry-run",
    "  --limit 0",
    "  --env-path /path/to/dev.env",
    "  --report-dir /path/to/out",
  ].join("\n"));
}
