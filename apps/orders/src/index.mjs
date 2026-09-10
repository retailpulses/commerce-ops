// CLI entrypoint for local pipeline execution.
// Uses shared pipeline runner (src/lib/pipeline-runner.mjs) — same as Worker.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  runPipeline,
  resolveShops,
  parseInteger,
  text,
  DEFAULT_SHOPS,
} from "./lib/pipeline-runner.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENV_PATH = path.join(REPO_ROOT, ".env");

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFileIfPresent(process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_ENV_PATH);

  const shops = resolveShops(args.shops || process.env.MERCARI_SHOPS);
  const mode = String(args.mode || "hourly").trim().toLowerCase();
  const limit = parseInteger(args.limit || process.env.ORDER_MGMT_LIMIT, 100);
  const orderId = text(args["order-id"] || args.order_id || args.orderId || process.env.ORDER_MGMT_ORDER_ID || "");
  const dryRun = args["dry-run"] === true || isTruthy(process.env.ORDER_MGMT_DRY_RUN);
  const result = await runPipeline(process.env, {
    mode,
    shops,
    limit,
    orderId,
    dryRun,
    triggerType: "cli",
  });
  result.ok = result.steps.every((step) => step.ok !== false);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

// ── CLI-specific helpers (not in pipeline-runner) ────────────────

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
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
    // Optional local env file.
  }
}
