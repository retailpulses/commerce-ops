#!/usr/bin/env node

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBaserowClient, listAllRows } from "../src/lib/baserow.mjs";
import { projectMercariSalesOrdersToShipment } from "../src/lib/shipment-projector.mjs";
import { runOutboundSync } from "../src/lib/outbound-sync.mjs";
import { reconcileShippingInfo } from "../src/lib/tracking-reconciler.mjs";

const DEFAULT_SHOPS = ["Shop1", "Shop2", "Shop3", "Shop4"];
const DEFAULT_STATUSES = ["WAITING_FOR_PAYMENT", "WAITING_FOR_SHIPPING"];
const DEFAULT_ENV_PATH = "/Users/user/Documents/April 2026/.env";
const DEFAULT_TOKENS_PATH = "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md";
const DEFAULT_BASEROW_DATABASE_TOKEN = "MhbpMifxj7XOL4V7lzoGSJA6Ju9Vp4Ub";
const DEFAULT_GIGA_CLIENT_ID = "83142311_JPN_release";
const DEFAULT_GIGA_CLIENT_SECRET = "995ade0b4e544a7aac92902c97a2e0bf";
const DEFAULT_GIGA_API_BASE_URL = "https://openapi.gigab2b.com";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = path.resolve(SCRIPT_DIR, "./sync_mercari_sales_orders_multi_shop_2026_04_01.mjs");
const CLOSE_SCRIPT = path.resolve(SCRIPT_DIR, "./close_all_shipped_orders.mjs");
const DEFAULT_REPAIR_SCRIPT = path.resolve(SCRIPT_DIR, "./repair_shipment_integrity.mjs");

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

  loadEnvFileIfPresent(process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_ENV_PATH);
  const explicitBaserowToken = readEnvValue(DEFAULT_ENV_PATH, "Baserow database token") || DEFAULT_BASEROW_DATABASE_TOKEN;
  if (explicitBaserowToken) process.env.BASEROW_DATABASE_TOKEN = explicitBaserowToken;
  if (!pathExists(process.env.MERCARI_TOKENS_PATH)) process.env.MERCARI_TOKENS_PATH = DEFAULT_TOKENS_PATH;
  if (!process.env.GIGA_CLIENT_ID) process.env.GIGA_CLIENT_ID = DEFAULT_GIGA_CLIENT_ID;
  if (!process.env.GIGA_CLIENT_SECRET) process.env.GIGA_CLIENT_SECRET = DEFAULT_GIGA_CLIENT_SECRET;
  if (!process.env.GIGA_API_BASE_URL) process.env.GIGA_API_BASE_URL = DEFAULT_GIGA_API_BASE_URL;

  const shops = normalizeShops(args.shops || process.env.MERCARI_SHOPS || DEFAULT_SHOPS.join(","));
  const inputLimit = parseInteger(args.limit || args["input-limit"] || process.env.ORDER_MGMT_LIMIT, 100);
  const trackingLimit = parseInteger(args["tracking-limit"] || process.env.ORDER_MGMT_TRACKING_LIMIT, 0);
  const closeLimit = parseInteger(args["close-limit"] || process.env.ORDER_MGMT_CLOSE_LIMIT, 0);
  const statuses = normalizeStatuses(args.statuses || process.env.MERCARI_ORDER_STATUSES || DEFAULT_STATUSES.join(","));
  const reportDir = path.resolve(args["report-dir"] || buildDefaultReportDir());
  const env = process.env;

  const stepSummaries = [];
  const steps = [
    ["pull_shop_orders", async () => runNodeScript(INGEST_SCRIPT, env, ["--shops", shops.join(","), "--statuses", statuses.join(","), "--limit", String(inputLimit)])],
    ["repair_shipment_integrity", async () => runNodeScript(DEFAULT_REPAIR_SCRIPT, env)],
    ["build_giga_shipments", async () => projectMercariSalesOrdersToShipment(env, { shops, limit: inputLimit })],
    ["push_orders_to_giga", async () => runOutboundSync(env, { shops, limit: inputLimit })],
    ["pull_giga_tracking", async () => reconcileShippingInfo(env, { shops, limit: trackingLimit })],
    ["close_shop_orders", async () => runNodeScript(CLOSE_SCRIPT, env, ["--shops", shops.join(","), "--limit", String(closeLimit)])],
  ];
  for (const [stepName, stepFn] of steps) {
    console.error(`[backfill] start ${stepName}`);
    const stepResult = await runStep(stepName, stepFn);
    stepSummaries.push(stepResult);
    console.error(`[backfill] done ${stepName}: ${stepResult.ok ? "ok" : "failed"}`);
    if (!stepResult.ok) break;
  }

  let verification;
  try {
    verification = await verifyAlignment(env, { shops });
  } catch (error) {
    verification = {
      error: error && error.stack ? String(error.stack) : String(error),
    };
  }
  const report = {
    ok: stepSummaries.every((step) => step.ok),
    run_at: new Date().toISOString(),
    report_dir: reportDir,
    shops,
    statuses,
    limit: inputLimit,
    tracking_limit: trackingLimit,
    close_limit: closeLimit,
    steps: stepSummaries,
    verification,
  };

  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `backfill_report_${dateStamp()}.md`);
  const jsonPath = path.join(reportDir, `backfill_report_${dateStamp()}.json`);
  await fs.writeFile(reportPath, buildMarkdownReport(report), "utf8");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({ ...report, report_path: reportPath, json_path: jsonPath }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

async function verifyAlignment(env, { shops }) {
  const baserow = createBaserowClient(env);
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId);
  const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId);
  const selectedShopIds = new Set(resolveShops(shops).map((shop) => SHOP_IDS[shop]).filter(Boolean));

  const salesInScope = salesRows.filter((row) => {
    const shopId = text(row.shop_id);
    return selectedShopIds.size ? selectedShopIds.has(shopId) : true;
  });
  const shipmentsInScope = shipmentRows.filter((row) => {
    const storeId = text(row.SourceStoreID);
    const salesChannel = text(row.SalesChannel);
    return salesChannel === "Mercari" && (selectedShopIds.size ? selectedShopIds.has(storeId) : true);
  });

  const shipmentByOrderId = new Map();
  for (const row of shipmentsInScope) {
    const orderId = normalizeOrderIdCandidate(row.OrderId);
    if (!orderId) continue;
    if (!shipmentByOrderId.has(orderId)) shipmentByOrderId.set(orderId, []);
    shipmentByOrderId.get(orderId).push(row);
  }

  const missingShipments = salesInScope.filter((row) => {
    if (text(row.order_status) !== "WAITING_FOR_SHIPPING") return false;
    if (shouldSkipProductName(row.product_name)) return false;
    const orderId = normalizeOrderIdCandidate(row.order_id);
    return orderId && !shipmentByOrderId.has(orderId);
  }).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.order_id),
    sales_row_id: row.id,
    shop_id: text(row.shop_id),
    order_status: text(row.order_status),
  }));

  const unsyncedShipments = shipmentsInScope.filter((row) => {
    const status = readSelectValue(row.giga_sync_status);
    return !status && !text(row.giga_sync_attempted_at);
  }).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.OrderId),
    shipment_row_id: row.id,
    shop_id: text(row.SourceStoreID),
    order_date: text(row.OrderDate) || null,
  }));

  const shippedNotClosed = salesInScope.filter((row) => {
    return text(row.shipping_completed_at) && text(row.shop_close_status) !== "Completed";
  }).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.order_id),
    sales_row_id: row.id,
    shop_id: text(row.shop_id),
    shipping_completed_at: text(row.shipping_completed_at),
    shop_close_status: text(row.shop_close_status) || null,
  }));

  return {
    sales_rows: salesInScope.length,
    shipment_rows: shipmentsInScope.length,
    missing_shipments_count: missingShipments.length,
    unsynced_shipments_count: unsyncedShipments.length,
    shipped_not_closed_count: shippedNotClosed.length,
    missing_shipments: missingShipments.slice(0, 50),
    unsynced_shipments: unsyncedShipments.slice(0, 50),
    shipped_not_closed: shippedNotClosed.slice(0, 50),
  };
}

async function runStep(step, fn) {
  const startedAt = new Date().toISOString();
  try {
    const summary = await fn();
    return {
      step,
      ok: summary && summary.ok !== false,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      summary,
    };
  } catch (error) {
    return {
      step,
      ok: false,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      error: error && error.stack ? String(error.stack) : String(error),
    };
  }
}

function runNodeScript(scriptPath, env, args = []) {
  const baserowToken = env.BASEROW_DATABASE_TOKEN || readEnvValue(DEFAULT_ENV_PATH, "Baserow database token") || DEFAULT_BASEROW_DATABASE_TOKEN;
  const result = spawnSync("node", [scriptPath, ...args], {
    env: {
      ...env,
      BASEROW_DATABASE_TOKEN: baserowToken,
      BASEROW_API_BASE: env.BASEROW_API_BASE || "https://api.baserow.io/api",
      MERCARI_BASEROW_ENV_PATH: env.MERCARI_BASEROW_ENV_PATH || DEFAULT_ENV_PATH,
      MERCARI_TOKENS_PATH: env.MERCARI_TOKENS_PATH || DEFAULT_TOKENS_PATH,
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `node_exit_${result.status}`);
  }
  try {
    return result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    return { raw: String(result.stdout || "").trim() };
  }
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push(`# Backfill Report`);
  lines.push("");
  lines.push(`- Run at: ${report.run_at}`);
  lines.push(`- Shops: ${report.shops.join(", ")}`);
  lines.push(`- Statuses: ${report.statuses.join(", ")}`);
  lines.push(`- Limit: ${report.limit}`);
  lines.push(`- Tracking limit: ${report.tracking_limit}`);
  lines.push(`- Close limit: ${report.close_limit}`);
  lines.push(`- Result: ${report.ok ? "ok" : "failed"}`);
  lines.push("");
  lines.push("## Steps");
  for (const step of report.steps) {
    lines.push(`- ${step.step}: ${step.ok ? "ok" : "failed"}${step.summary ? ` (${compactSummary(step.summary)})` : ""}`);
    if (step.error) lines.push(`  - error: ${step.error}`);
  }
  lines.push("");
  lines.push("## Verification");
  if (report.verification && report.verification.error) {
    lines.push(`- error: ${report.verification.error}`);
  } else {
    lines.push(`- sales_rows: ${report.verification.sales_rows}`);
    lines.push(`- shipment_rows: ${report.verification.shipment_rows}`);
    lines.push(`- missing_shipments_count: ${report.verification.missing_shipments_count}`);
    lines.push(`- unsynced_shipments_count: ${report.verification.unsynced_shipments_count}`);
    lines.push(`- shipped_not_closed_count: ${report.verification.shipped_not_closed_count}`);
    if (report.verification.missing_shipments_count > 0) {
      lines.push("- missing_shipments:");
      for (const item of report.verification.missing_shipments.slice(0, 10)) {
        lines.push(`  - ${item.order_id} / ${item.shop_id} / ${item.order_status}`);
      }
    }
    if (report.verification.unsynced_shipments_count > 0) {
      lines.push("- unsynced_shipments:");
      for (const item of report.verification.unsynced_shipments.slice(0, 10)) {
        lines.push(`  - ${item.order_id} / ${item.shop_id}`);
      }
    }
    if (report.verification.shipped_not_closed_count > 0) {
      lines.push("- shipped_not_closed:");
      for (const item of report.verification.shipped_not_closed.slice(0, 10)) {
        lines.push(`  - ${item.order_id} / ${item.shop_id}`);
      }
    }
  }
  lines.push("");
  lines.push("## Version Log");
  lines.push(`- ${dateStamp()}: Backfill executed across Mercari, Baserow, and GigaB2B alignment path with stage-specific limits.`);
  return lines.join("\n");
}

function compactSummary(summary) {
  if (!summary || typeof summary !== "object") return "";
  if (typeof summary.ok === "boolean" && Object.prototype.hasOwnProperty.call(summary, "results")) {
    const count = Array.isArray(summary.results) ? summary.results.length : 0;
    return `ok=${summary.ok}; results=${count}`;
  }
  if (typeof summary.ok === "boolean") return `ok=${summary.ok}`;
  return "summary";
}

function buildDefaultReportDir() {
  return path.join("/Users/user/Documents/April 2026/Mercari API testing/reports", `order_pipeline_backfill_${dateStamp()}`);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
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

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/backfill_shop_orders.mjs",
    "",
    "Optional:",
    "  --shops Shop1,Shop2,Shop3,Shop4",
    "  --statuses WAITING_FOR_PAYMENT,WAITING_FOR_SHIPPING",
    "  --limit 100",
    "  --tracking-limit 0",
    "  --close-limit 0",
    "  --report-dir /path/to/report-folder",
  ].join("\n"));
}

function loadEnvFileIfPresent(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = normalizeEnvKey(trimmed.slice(0, idx).trim());
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // no-op
  }
}

function pathExists(filePath) {
  try {
    return Boolean(filePath) && typeof filePath === "string" && readFileSync(filePath, "utf8") !== undefined;
  } catch {
    return false;
  }
}

function normalizeEnvKey(key) {
  const normalized = String(key || "").trim();
  if (normalized === "Baserow base URL") return "BASEROW_BASE_URL";
  if (normalized === "Baserow database token") return "BASEROW_DATABASE_TOKEN";
  return normalized;
}

function readEnvValue(filePath, desiredKey) {
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (key !== desiredKey && normalizeEnvKey(key) !== normalizeEnvKey(desiredKey)) continue;
      return trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    return "";
  }
  return "";
}

function normalizeShops(raw) {
  return String(raw || "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shop) => DEFAULT_SHOPS.includes(shop));
}

function resolveShops(raw) {
  return normalizeShops(raw);
}

function normalizeStatuses(raw) {
  return String(raw || "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function readSelectValue(value) {
  if (value == null) return "";
  if (typeof value === "object" && value) return text(value.value || value.name || value.label);
  return text(value);
}

function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

function shouldSkipProductName(value) {
  const normalized = text(value);
  return normalized.includes("各種手数料") || normalized === "追加支払い・追加送料専用";
}

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};
