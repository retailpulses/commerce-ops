#!/usr/bin/env node

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createBaserowClient, listAllRows } from "../src/lib/baserow.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ENV_PATH = "/Users/user/Documents/April 2026/.env";
const DEFAULT_TEMPLATE_PATH = path.resolve(REPO_ROOT, "templates", "price-seeking-helper.md");
const DEFAULT_OUTPUT_DIR = path.resolve(REPO_ROOT, "deliverables", "price-seeking-helper");

const DEFAULT_PRODUCTS_TABLE_ID = 886994;
const DEFAULT_SOP_TABLE_ID = 925626;
const DEFAULT_SOP_ROW_ID = 7;
const DEFAULT_JOB_LOG_TABLE_ID = 921591;

const SALES_FIELDS = {
  orderId: "order_id",
  productId: "original_product_id",
  productName: "product_name",
  quantity: "quantity",
  orderStatus: "order_status",
  shopId: "shop_id",
  shippingCompletedAt: "shipping_completed_at",
};

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

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

  const envPath = path.resolve(String(args["env-path"] || process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_ENV_PATH));
  loadEnvFileIfPresent(envPath);
  const baserowToken = trimAndCollapse(process.env.BASEROW_DATABASE_TOKEN || readEnvValue(envPath, "Baserow database token"));
  if (!baserowToken) throw new Error("Missing BASEROW_DATABASE_TOKEN");

  const env = {
    ...process.env,
    BASEROW_DATABASE_TOKEN: baserowToken,
    BASEROW_API_BASE: normalizeApiBase(
      process.env.BASEROW_API_BASE
        || process.env.BASEROW_BASE_URL
        || readEnvValue(envPath, "Baserow base URL")
        || "https://api.baserow.io/api"
    ),
  };

  const templatePath = path.resolve(String(args.template || DEFAULT_TEMPLATE_PATH));
  const outputDir = path.resolve(String(args["out-dir"] || DEFAULT_OUTPUT_DIR));
  const outPath = args.out ? path.resolve(String(args.out)) : path.join(outputDir, dateStamp(), `price-seeking-helper_${dateTimeStamp()}.md`);

  const shopScope = normalizeShops(args.shops || process.env.MERCARI_SHOPS || "");
  const selectedShopIds = new Set(shopScope.map((shop) => SHOP_IDS[shop]).filter(Boolean));
  const shouldWriteJobLog = args["no-job-log"] !== true && args.noJobLog !== true;
  const shouldUpdateSop = args["no-sop-update"] !== true && args.noSopUpdate !== true;

  const baserow = createBaserowClient(env);
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId);
  const backlog = salesRows.filter((row) => {
    if (trimAndCollapse(row[SALES_FIELDS.orderStatus]) !== "WAITING_FOR_SHIPPING") return false;
    if (trimAndCollapse(row[SALES_FIELDS.shippingCompletedAt])) return false;
    if (shouldSkipProductName(row[SALES_FIELDS.productName])) return false;
    const shopId = trimAndCollapse(row[SALES_FIELDS.shopId]);
    return selectedShopIds.size ? selectedShopIds.has(shopId) : true;
  });

  const purchaseQtyByItemCode = new Map();
  for (const row of backlog) {
    const itemCode = trimAndCollapse(row[SALES_FIELDS.productId]);
    if (!itemCode) continue;
    const qty = normalizePositiveInteger(row[SALES_FIELDS.quantity]) || 0;
    purchaseQtyByItemCode.set(itemCode, (purchaseQtyByItemCode.get(itemCode) || 0) + qty);
  }

  const itemCodes = Array.from(purchaseQtyByItemCode.keys()).sort((a, b) => a.localeCompare(b, "en"));
  const productsTableId = normalizePositiveInteger(args["products-table-id"] || process.env.BASEROW_PRODUCTS_TABLE_ID || DEFAULT_PRODUCTS_TABLE_ID);
  if (!productsTableId) throw new Error("Invalid products table id");

  const productFieldIds = await resolveProductFieldIds(env, productsTableId);
  const candidates = [];
  for (const itemCode of itemCodes) {
    const purchaseQty = purchaseQtyByItemCode.get(itemCode) || 0;
    const productRow = await findProductByItemCode(env, productsTableId, productFieldIds.itemCodeFieldId, itemCode);
    const evaluation = evaluateProductRow(productRow, productFieldIds);
    if (!evaluation.eligible) continue;
    candidates.push({
      item_code: itemCode,
      purchase_qty: purchaseQty,
      seller: evaluation.seller,
      qty_available: evaluation.qtyAvailable,
    });
  }

  const rendered = await renderMarkdown({
    templatePath,
    generatedAtJst: formatJstNow(),
    scope: shopScope.length ? shopScope.join(",") : "ALL",
    items: candidates,
  });

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, rendered, "utf8");

  const summary = {
    ok: true,
    out_path: outPath,
    scope: shopScope.length ? shopScope : DEFAULT_SHOPS(),
    waiting_for_shipping_rows: backlog.length,
    unique_item_codes: itemCodes.length,
    eligible_item_codes: candidates.length,
  };

  const jobLog = shouldWriteJobLog
    ? await writeJobLog(env, {
      outPath,
      scope: summary.scope,
      waitingForShippingRows: summary.waiting_for_shipping_rows,
      uniqueItemCodes: summary.unique_item_codes,
      eligibleItemCodes: summary.eligible_item_codes,
    })
    : null;

  const sopUpdate = shouldUpdateSop
    ? await updateSop(env, {
      outPath,
      sopTableId: normalizePositiveInteger(args["sop-table-id"] || process.env.BASEROW_SOP_TABLE_ID || DEFAULT_SOP_TABLE_ID) || DEFAULT_SOP_TABLE_ID,
      sopRowId: normalizePositiveInteger(args["sop-row-id"] || process.env.BASEROW_SOP_ROW_ID || DEFAULT_SOP_ROW_ID) || DEFAULT_SOP_ROW_ID,
    })
    : null;

  console.log(JSON.stringify({
    ...summary,
    job_log: jobLog,
    sop_update: sopUpdate,
  }, null, 2));
}

function DEFAULT_SHOPS() {
  return ["Shop1", "Shop2", "Shop3", "Shop4"];
}

async function renderMarkdown({ templatePath, generatedAtJst, scope, items }) {
  const template = await fs.readFile(templatePath, "utf8");
  const blocks = buildSellerBlocks(items);

  return template
    .replaceAll("{{GENERATED_AT_JST}}", generatedAtJst)
    .replaceAll("{{SCOPE}}", scope)
    .replaceAll("{{SELLER_BLOCKS}}", blocks || "_No eligible item codes._\n");
}

function buildSellerBlocks(items) {
  const groups = new Map(); // seller_key -> { display, rows: [] }
  for (const item of items || []) {
    const rawSeller = trimAndCollapse(item && item.seller ? item.seller : "");
    const displaySeller = rawSeller || "UNKNOWN";
    const sellerKey = normalizeSellerKey(displaySeller);
    if (!groups.has(sellerKey)) groups.set(sellerKey, { display: displaySeller, rows: [] });
    groups.get(sellerKey).rows.push(item);
  }
  const sellerKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    const da = groups.get(a)?.display || "";
    const db = groups.get(b)?.display || "";
    return String(da).localeCompare(String(db), "en");
  });
  const out = [];
  for (const sellerKey of sellerKeys) {
    const group = groups.get(sellerKey) || { display: "UNKNOWN", rows: [] };
    const seller = trimAndCollapse(group.display) || "UNKNOWN";
    const rows = (group.rows || []).slice().sort((a, b) => String(a.item_code || "").localeCompare(String(b.item_code || ""), "en"));
    const skuCount = rows.length;
    const totalQty = rows.reduce((sum, r) => sum + (normalizePositiveInteger(r.purchase_qty) || 0), 0);

    out.push(`## Seller: ${seller} (SKU: ${skuCount}, Qty: ${totalQty})`);
    out.push("麻烦帮忙下面产品设置价格，或者告知bid价格。谢谢");
    out.push("");
    out.push("| Item code | Qty Available | Purchase qty |");
    out.push("|---|---:|---:|");
    for (const row of rows) {
      const itemCode = trimAndCollapse(row.item_code) || "";
      const qtyAvail = trimAndCollapse(row.qty_available) || "";
      const purchaseQty = String(row.purchase_qty || 0);
      out.push(`| ${escapeTable(itemCode)} | ${escapeTable(qtyAvail)} | ${escapeTable(purchaseQty)} |`);
    }
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}

function normalizeSellerKey(value) {
  const raw = trimAndCollapse(value);
  if (!raw) return "unknown";
  // Merge same seller even if only casing differs (common in manual data).
  return raw.toLowerCase();
}

function escapeTable(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

async function resolveProductFieldIds(env, productsTableId) {
  const fields = await baserowListFields(env, productsTableId);
  const fieldIdByName = new Map(fields.map((f) => [String(f.name || "").trim(), Number(f.id)]));

  const itemCodeFieldId = findFieldId(fieldIdByName, [
    "Gigab2b Item Code",
    "GigaB2B Item Code",
    "Giga Item Code",
    "Item Code",
    "item code",
    "SKU1商品管理コード",
  ]);
  if (!itemCodeFieldId) throw new Error("Missing product field: Gigab2b Item Code");

  return {
    itemCodeFieldId,
    unitPriceFieldId: findFieldId(fieldIdByName, ["Unit Price", "Unit price", "unit_price"]),
    discountedUnitPriceFieldId: findFieldId(fieldIdByName, ["Discounted Unit Price", "Discounted Unit price", "Discount Unit price"]),
    exclusivePriceFieldId: findFieldId(fieldIdByName, ["Exclusive Price", "Exclusive price"]),
    ownedQtyFieldId: findFieldId(fieldIdByName, ["Owned Qty", "Owned quantity", "Owned Quantity"]),
    qtyAvailableFieldId: findFieldId(fieldIdByName, ["Qty Available", "Quantity Available", "Available Qty"]),
    sellerFieldId: findFieldId(fieldIdByName, ["seller", "Seller", "Vendor", "vendor", "Store Name", "Store Code", "Seller Type"]),
  };
}

function findFieldId(fieldIdByName, candidates) {
  for (const name of candidates) {
    const id = fieldIdByName.get(String(name || "").trim());
    if (Number.isFinite(id) && id > 0) return id;
  }
  return 0;
}

async function findProductByItemCode(env, productsTableId, itemCodeFieldId, itemCode) {
  if (!itemCodeFieldId) return null;
  const base = trimAndCollapse(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  const url = new URL(`${base}/database/rows/table/${encodeURIComponent(productsTableId)}/`);
  url.searchParams.set("size", "1");
  url.searchParams.set(`filter__field_${String(itemCodeFieldId)}__equal`, itemCode);
  const res = await baserowRequest(env, url.toString());
  if (!res.ok) throw new Error(`baserow_products_lookup_failed:${res.status}`);
  const body = res.body && typeof res.body === "object" ? res.body : {};
  const results = Array.isArray(body.results) ? body.results : [];
  return results.length ? results[0] : null;
}

function evaluateProductRow(row, fieldIds) {
  if (!row) return { eligible: false, seller: "", qtyAvailable: "" };
  const unitPrice = readNumber(row, fieldIds.unitPriceFieldId);
  const discounted = readNumber(row, fieldIds.discountedUnitPriceFieldId);
  const exclusive = readNumber(row, fieldIds.exclusivePriceFieldId);
  const ownedQty = readNumber(row, fieldIds.ownedQtyFieldId);
  const qtyAvailable = readText(row, fieldIds.qtyAvailableFieldId);
  const seller = readText(row, fieldIds.sellerFieldId);

  const discountOk = discounted == null || unitPrice == null || discounted === unitPrice;
  const exclusiveOk = exclusive == null;
  const ownedOk = ownedQty == null || ownedQty === 0;
  const eligible = discountOk && exclusiveOk && ownedOk;
  return { eligible, seller, qtyAvailable };
}

function readText(row, fieldId) {
  if (!fieldId || !row || typeof row !== "object") return "";
  const key = `field_${String(fieldId)}`;
  const value = row[key];
  if (value == null) return "";
  if (typeof value === "string") return trimAndCollapse(value);
  if (typeof value === "number" || typeof value === "boolean") return trimAndCollapse(String(value));
  if (Array.isArray(value)) return value.length ? readText({ [key]: value[0] }, fieldId) : "";
  if (typeof value === "object") {
    for (const k of ["value", "name", "label", "text", "displayName"]) {
      if (typeof value[k] === "string" && trimAndCollapse(value[k])) return trimAndCollapse(value[k]);
    }
  }
  return "";
}

function readNumber(row, fieldId) {
  const raw = readText(row, fieldId);
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

async function baserowListFields(env, tableId) {
  const base = trimAndCollapse(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  const url = `${base}/database/fields/table/${encodeURIComponent(tableId)}/`;
  const res = await baserowRequest(env, url);
  if (!res.ok) throw new Error(`baserow_fields_failed:${res.status}`);
  return Array.isArray(res.body) ? res.body : [];
}

async function baserowRequest(env, url, { method = "GET", body = null } = {}) {
  const token = trimAndCollapse(env.BASEROW_DATABASE_TOKEN);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

function shouldSkipProductName(value) {
  const normalized = trimAndCollapse(value);
  return normalized.includes("各種手数料") || normalized === "追加支払い・追加送料専用";
}

function formatJstNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function dateStamp() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function dateTimeStamp() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}${map.month}${map.day}_${map.hour}${map.minute}${map.second}`;
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/build_price_seeking_helper.mjs",
    "",
    "Optional:",
    "  --env-path /path/to/.env",
    "  --shops Shop1,Shop2,Shop3,Shop4",
    "  --products-table-id 886994",
    "  --template /path/to/templates/price-seeking-helper.md",
    "  --out /path/to/output.md",
    "  --out-dir /path/to/output/folder",
    "  --no-job-log (skip writing Baserow 921591 job log)",
    "  --no-sop-update (skip updating SOP row)",
  ].join("\n"));
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

function normalizeShops(raw) {
  return String(raw || "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shop) => Object.keys(SHOP_IDS).includes(shop));
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
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // no-op
  }
}

function normalizeEnvKey(key) {
  const normalized = String(key || "").trim();
  if (normalized === "Baserow base URL") return "BASEROW_API_BASE";
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

function normalizePositiveInteger(value) {
  const raw = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

function trimAndCollapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeApiBase(value) {
  const raw = trimAndCollapse(value);
  if (!raw) return "https://api.baserow.io/api";
  if (raw.endsWith("/api")) return raw;
  if (raw.endsWith("/api/")) return raw.slice(0, -1);
  return `${raw.replace(/\/+$/g, "")}/api`;
}

async function writeJobLog(env, { outPath, scope, waitingForShippingRows, uniqueItemCodes, eligibleItemCodes }) {
  const tableId = normalizePositiveInteger(process.env.BASEROW_JOB_LOG_TABLE_ID || DEFAULT_JOB_LOG_TABLE_ID) || DEFAULT_JOB_LOG_TABLE_ID;
  const payload = {
    "Log Title": "Run SOP: Order manual handling (@price-seeking helper)",
    Status: "Completed",
    "Work report": [
      `Output: ${outPath}`,
      `Scope: ${Array.isArray(scope) ? scope.join(",") : String(scope || "")}`,
      `waiting_for_shipping_rows=${waitingForShippingRows}`,
      `unique_item_codes=${uniqueItemCodes}`,
      `eligible_item_codes=${eligibleItemCodes}`,
      `Script: ${path.resolve(REPO_ROOT, "scripts", "build_price_seeking_helper.mjs")}`,
      `Template: ${path.resolve(REPO_ROOT, "templates", "price-seeking-helper.md")}`,
      `SOP: https://baserow.io/database/410074/table/925626/1816723/row/7`,
    ].join("\n"),
    "Deliverable file path": outPath,
    "Workspace Name": "order-mgmt",
  };
  const base = trimAndCollapse(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  const url = `${base}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true`;
  const res = await baserowRequest(env, url, { method: "POST", body: payload });
  if (!res.ok) throw new Error(`baserow_job_log_failed:${res.status}`);
  return { table_id: tableId, row_id: res.body && typeof res.body === "object" ? res.body.id : null };
}

async function updateSop(env, { outPath, sopTableId, sopRowId }) {
  const base = trimAndCollapse(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  const readUrl = `${base}/database/rows/table/${encodeURIComponent(sopTableId)}/${encodeURIComponent(sopRowId)}/?user_field_names=true`;
  const current = await baserowRequest(env, readUrl);
  if (!current.ok) throw new Error(`baserow_sop_read_failed:${current.status}`);
  const body = current.body && typeof current.body === "object" ? current.body : {};
  const description = String(body.Description || "").trim();
  const marker = "Automation (daily)";
  const latestPrefix = "- Latest output:";
  let nextDescription = description;
  if (description.includes(marker)) {
    const lines = description.split(/\r?\n/g);
    nextDescription = lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(latestPrefix)) return `${latestPrefix} ${outPath}`;
      return line;
    }).join("\n").trim();
  } else {
    nextDescription = [
      description,
      "",
      "---",
      "",
      marker,
      "",
      `- Script: ${path.resolve(REPO_ROOT, "scripts", "build_price_seeking_helper.mjs")}`,
      `- Template: ${path.resolve(REPO_ROOT, "templates", "price-seeking-helper.md")}`,
      `${latestPrefix} ${outPath}`,
      "- Run (example):",
      "  cd /Users/user/Documents/Retailpulses/20_REPOS/order-mgmt",
      "  BASEROW_DATABASE_TOKEN=... npm run price-seeking-helper -- --env-path '/Users/user/Documents/April 2026/.env' --shops Shop1,Shop2,Shop3,Shop4",
    ].join("\n").trim();
  }

  const patchUrl = `${base}/database/rows/table/${encodeURIComponent(sopTableId)}/${encodeURIComponent(sopRowId)}/?user_field_names=true`;
  const res = await baserowRequest(env, patchUrl, {
    method: "PATCH",
    body: { Description: nextDescription, Status: "Active" },
  });
  if (!res.ok) throw new Error(`baserow_sop_patch_failed:${res.status}`);
  return { table_id: sopTableId, row_id: sopRowId };
}
