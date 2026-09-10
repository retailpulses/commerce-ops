import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(MODULE_DIR, "../../scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs");

export async function runMercariIngest(env, options = {}) {
  const scriptPath = path.resolve(options.scriptPath || env.MERCARI_INGEST_SCRIPT_PATH || DEFAULT_SCRIPT);
  const args = [scriptPath];
  const shops = Array.isArray(options.shops) ? options.shops.filter(Boolean) : [];
  if (shops.length) args.push("--shops", shops.join(","));
  const statuses = Array.isArray(options.statuses) ? options.statuses.filter(Boolean) : [];
  if (statuses.length) args.push("--statuses", statuses.join(","));
  const orderId = String(options.orderId || "").trim();
  if (orderId) args.push("--order-id", orderId);
  if (options.dryRun === true) args.push("--dry-run");
  const childEnv = {
    ...env,
    MERCARI_SHOPS: shops.length ? shops.join(",") : String(env.MERCARI_SHOPS || ""),
    MERCARI_ORDER_STATUSES: statuses.length ? statuses.join(",") : String(env.MERCARI_ORDER_STATUSES || ""),
    MERCARI_ORDER_ID: orderId,
    ORDER_MGMT_LIMIT: String(options.limit === null ? 0 : (Number.isFinite(options.limit) ? options.limit : env.ORDER_MGMT_LIMIT || 100)),
    MERCARI_EXEC_MODE: "direct",
    DATABASE_BACKEND: "supabase",
  };
  const result = await (options._runNode || runNode)(args, childEnv);
  const totals = result.parsed && typeof result.parsed.totals === "object" ? result.parsed.totals : {};
  const counts = {
    candidates: Number(totals.transactions) || 0,
    processed: (Number(totals.created) || 0) + (Number(totals.updated) || 0) + (Number(totals.unchanged) || 0),
    skipped: Number(totals.skipped) || 0,
    failed: Number(totals.failed) || 0,
  };
  const ok = result.code === 0 && result.parsed && result.parsed.ok !== false && counts.failed === 0;
  return { ok, status: result.code, body: { ...result.parsed, counts, state: ok ? "completed" : "failed" } };
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`mercari_ingest_failed:${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      let parsed = null;
      try {
        parsed = stdout ? JSON.parse(stdout) : null;
      } catch {
        parsed = { raw: stdout };
      }
      resolve({ code, stdout, stderr, parsed });
    });
  });
}
