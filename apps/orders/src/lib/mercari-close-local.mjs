import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(MODULE_DIR, "../../scripts/close_all_shipped_orders.mjs");

export async function runMercariCloseLocal(env, options = {}) {
  const scriptPath = path.resolve(options.scriptPath || env.MERCARI_SHIPPING_CLOSE_BATCH_SCRIPT_PATH || DEFAULT_SCRIPT);
  const args = [scriptPath];
  const shops = Array.isArray(options.shops) ? options.shops.filter(Boolean) : [];
  if (shops.length) args.push("--shops", shops.join(","));
  const orderId = String(options.orderId || "").trim();
  if (orderId) args.push("--order-id", orderId);
  if (options.limit !== null && Number.isFinite(options.limit)) args.push("--limit", String(options.limit));
  if (options.dryRun === true) args.push("--dry-run");
  const childEnv = {
    ...env,
    MERCARI_SHOPS: shops.length ? shops.join(",") : String(env.MERCARI_SHOPS || ""),
    MERCARI_ORDER_ID: orderId,
    ORDER_MGMT_LIMIT: String(options.limit === null ? 0 : (Number.isFinite(options.limit) ? options.limit : env.ORDER_MGMT_LIMIT || 0)),
    MERCARI_SHIPPING_DRY_RUN: options.dryRun === true ? "1" : "",
    MERCARI_EXEC_MODE: "direct",
    DATABASE_BACKEND: "supabase",
  };
  const result = await (options._runNode || runNode)(args, childEnv);
  const summary = result.parsed && typeof result.parsed === "object" ? result.parsed : {};
  const counts = {
    candidates: Number(summary.candidates) || 0,
    processed: Number(summary.processed) || 0,
    skipped: Number(summary.skipped) || 0,
    failed: (Number(summary.failed) || 0) + (Number(summary.backfill_failed) || 0),
  };
  const ok = result.code === 0 && summary.ok !== false && counts.failed === 0;
  return { ok, status: result.code, body: { ...summary, counts, state: ok ? "completed" : "failed" } };
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed = null;
      try { parsed = stdout ? JSON.parse(stdout) : null; }
      catch { parsed = { raw: stdout.trim() }; }
      resolve({ code, stdout, stderr, parsed });
    });
  });
}
