// VPS pipeline scheduler — designed for systemd timer invocation.
// Calls the shared pipeline runner (same as Cloudflare Worker + CLI).
//
// Usage:
//   node vps/pipeline-scheduler.mjs --mode pull_shop_orders
//   node vps/pipeline-scheduler.mjs --mode hourly --dry-run --limit 10
//   node vps/pipeline-scheduler.mjs --mode pull_giga_tracking
//   node vps/pipeline-scheduler.mjs --mode close_shop_orders
//
// Systemd timer template:
//   pipeline-scheduler@.service  → ExecStart with --mode %i
//
// Loads .env from repo root if present (optional on VPS — env vars
// may come from systemd Environment= or an env file).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runPipeline, parseInteger } from "../src/lib/pipeline-runner.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENV_PATH = path.join(REPO_ROOT, ".env");

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFileIfPresent(DEFAULT_ENV_PATH);

  const mode = String(args.mode || "hourly").trim().toLowerCase();
  const dryRun = args["dry-run"] === true;
  const limit = parseInteger(args.limit || process.env.ORDER_MGMT_LIMIT, 100);

  const result = await runPipeline(process.env, {
    mode,
    dryRun,
    limit,
    triggerType: "systemd-timer",
  });

  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

// ── CLI arg parser (minimal — same pattern as src/index.mjs) ──

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function loadEnvFileIfPresent(filePath) {
  try {
    const textContent = fs.readFileSync(filePath, "utf8");
    for (const line of textContent.split(/\r?\n/g)) {
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
    // Optional local env file — silent skip if absent.
  }
}
