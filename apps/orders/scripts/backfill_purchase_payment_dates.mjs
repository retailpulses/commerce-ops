#!/usr/bin/env node

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toJstIso } from "../src/lib/timezone.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_PRIVATE_TOKENS_PATH = firstExistingPath([
  path.join(REPO_ROOT, "env", "Mercari_API_Tokens_Private_2026-04-01.md"),
  "/Users/user/Documents/Mercari/Techstack/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md",
  "/opt/rp-order-mgmt/env/Mercari_API_Tokens_Private_2026-04-01.md",
]);
const DEFAULT_DEV_ENV_PATH = firstExistingPath([
  path.join(REPO_ROOT, "env", "dev.env"),
  "/opt/rp-order-mgmt/env/dev.env",
  "/Users/user/Documents/ERP/Techstack/mail integration/dev.env",
]);
const DEFAULT_API_BASE = "https://api.baserow.io/api";
const DEFAULT_TABLE_ID = 903318;
const DEFAULT_SSH_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");
const DEFAULT_API_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_API_CLIENT_VERSION = "0.0.1";

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

const SHOP_LABEL_BY_ID = Object.fromEntries(Object.entries(SHOP_IDS).map(([label, id]) => [id, label]));

const ORDER_FIELD_NAMES = {
  orderId: "order_id",
  originalProductId: "original_product_id",
  purchaseDate: "purchase_date",
  paymentDate: "payment_date",
  shopId: "shop_id",
};

const ORDER_QUERY = `
query orderTransaction($id: ID!) {
  orderTransaction(id: $id) {
    id
    createdAt
    paidAt
    products {
      variant { skuCode }
    }
  }
}`;

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFileIfPresent(args["env-path"] || process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_DEV_ENV_PATH);

  const apiBase = String(process.env.BASEROW_API_BASE || DEFAULT_API_BASE).trim();
  const token = String(process.env.BASEROW_DATABASE_TOKEN || "").trim();
  const tableId = Number.parseInt(String(args["table-id"] || process.env.BASEROW_MERCARI_SALES_ORDER_TABLE_ID || DEFAULT_TABLE_ID), 10);
  const tokensPath = path.resolve(String(args["tokens-path"] || process.env.MERCARI_TOKENS_PATH || DEFAULT_PRIVATE_TOKENS_PATH));
  const host = String(process.env.MERCARI_SSH_HOST || DEFAULT_SSH_HOST).trim();
  const sshKey = String(process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY).trim();
  const clientName = String(process.env.MERCARI_API_CLIENT_NAME || DEFAULT_API_CLIENT_NAME).trim();
  const clientVersion = String(process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_API_CLIENT_VERSION).trim();
  const dryRun = args["dry-run"] === true;

  if (!token) throw new Error("Missing BASEROW_DATABASE_TOKEN");
  if (!Number.isFinite(tableId) || tableId <= 0) throw new Error("Invalid table id");

  const rows = await loadAllRows(apiBase, tableId, token);
  const rowById = new Map(rows.map((row) => [Number(row.id), row]));
  const candidates = rows.filter((row) => {
    const purchaseDate = normalizeText(row[ORDER_FIELD_NAMES.purchaseDate]);
    const paymentDate = normalizeText(row[ORDER_FIELD_NAMES.paymentDate]);
    return !purchaseDate || !paymentDate;
  });
  const byOrder = new Map();
  for (const row of candidates) {
    const orderId = normalizeOrderId(row[ORDER_FIELD_NAMES.orderId]);
    const sku = normalizeText(row[ORDER_FIELD_NAMES.originalProductId]);
    const shopId = normalizeText(row[ORDER_FIELD_NAMES.shopId]);
    if (!orderId || !sku || !shopId) continue;
    const key = `${shopId}::${orderId}`;
    if (!byOrder.has(key)) byOrder.set(key, { shopId, orderId, rowIdsBySku: new Map() });
    const bucket = byOrder.get(key);
    if (!bucket.rowIdsBySku.has(sku)) bucket.rowIdsBySku.set(sku, []);
    bucket.rowIdsBySku.get(sku).push(Number(row.id));
  }

  const secrets = await loadShopSecrets(tokensPath);
  const summary = {
    ok: true,
    dry_run: dryRun,
    candidates_rows: candidates.length,
    unique_orders: byOrder.size,
    updated_rows: 0,
    skipped_rows: 0,
    failed_orders: 0,
    failures: [],
  };

  for (const item of byOrder.values()) {
    const shopLabel = SHOP_LABEL_BY_ID[item.shopId];
    const secret = shopLabel ? secrets.get(shopLabel) : null;
    if (!shopLabel || !secret) {
      summary.failed_orders += 1;
      summary.failures.push({ order_id: item.orderId, shop_id: item.shopId, error: "missing_shop_token" });
      continue;
    }

    try {
      const res = await mercariGraphQLViaSsh({
        host,
        sshKey,
        token: secret.token,
        clientName,
        clientVersion,
        query: ORDER_QUERY,
        variables: { id: item.orderId },
      });
      const order = res && res.data ? res.data.orderTransaction : null;
      if (!order) {
        summary.failed_orders += 1;
        summary.failures.push({ order_id: item.orderId, shop: shopLabel, error: "order_not_found" });
        continue;
      }

      const purchaseDate = formatBaserowDateTime(order.createdAt);
      const paymentDate = formatBaserowDateTime(order.paidAt);
      const products = Array.isArray(order.products) ? order.products : [];
      const seen = new Set();
      for (const product of products) {
        const sku = normalizeText(product && product.variant ? product.variant.skuCode : "");
        if (!sku || seen.has(sku)) continue;
        seen.add(sku);
        const rowIds = item.rowIdsBySku.get(sku) || [];
        for (const rowId of rowIds) {
          const existing = rowById.get(Number(rowId));
          const existingPurchase = normalizeText(existing ? existing[ORDER_FIELD_NAMES.purchaseDate] : "");
          const existingPayment = normalizeText(existing ? existing[ORDER_FIELD_NAMES.paymentDate] : "");
          const payload = {};
          if (!existingPurchase) payload[ORDER_FIELD_NAMES.purchaseDate] = purchaseDate || null;
          if (!existingPayment) payload[ORDER_FIELD_NAMES.paymentDate] = paymentDate || null;
          if (!Object.keys(payload).length) {
            summary.skipped_rows += 1;
            continue;
          }
          if (dryRun) {
            summary.updated_rows += 1;
            continue;
          }
          const patched = await patchRow(apiBase, tableId, token, rowId, payload);
          if (patched.ok) summary.updated_rows += 1;
          else {
            summary.failed_orders += 1;
            summary.failures.push({ order_id: item.orderId, row_id: rowId, error: patched.error || `patch_${patched.status}` });
          }
        }
      }
    } catch (error) {
      summary.failed_orders += 1;
      summary.failures.push({ order_id: item.orderId, shop: shopLabel, error: error && error.message ? error.message : String(error) });
    }
  }

  if (summary.failures.length > 50) summary.failures = summary.failures.slice(0, 50);
  summary.ok = summary.failed_orders === 0;
  console.log(JSON.stringify(summary, null, 2));
}

function formatBaserowDateTime(value) {
  return toJstIso(value);
}

function normalizeOrderId(value) {
  return normalizeText(value).replace(/^order_/, "");
}

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
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

async function loadShopSecrets(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const shops = new Map();
  let currentLabel = "";
  let currentShopId = "";
  let currentToken = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(/^##\s+(Shop\d+)\s*$/);
    if (labelMatch) {
      if (currentLabel && currentShopId && currentToken) shops.set(currentLabel, { shopId: currentShopId, token: currentToken });
      currentLabel = labelMatch[1];
      currentShopId = "";
      currentToken = "";
      continue;
    }
    const idMatch = line.match(/-\s*Shop ID:\s*`([^`]+)`/);
    if (idMatch) {
      currentShopId = idMatch[1].trim();
      continue;
    }
    const tokenMatch = line.match(/-\s*API token:\s*`([^`]+)`/);
    if (tokenMatch) {
      currentToken = tokenMatch[1].trim();
      continue;
    }
  }
  if (currentLabel && currentShopId && currentToken) shops.set(currentLabel, { shopId: currentShopId, token: currentToken });
  return shops;
}

async function loadAllRows(apiBase, tableId, token) {
  const rows = [];
  let next = `${apiBase}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true&size=200`;
  while (next) {
    const res = await baserowRequest(next, token);
    if (!res.ok) throw new Error(`baserow_list_failed:${res.status}`);
    const body = res.body && typeof res.body === "object" ? res.body : {};
    rows.push(...(Array.isArray(body.results) ? body.results : []));
    next = body.next ? normalizeNextUrl(body.next) : null;
  }
  return rows;
}

function normalizeNextUrl(url) {
  const parsed = new URL(String(url || "").trim());
  if (parsed.hostname === "api.baserow.io" && parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.toString();
}

async function baserowRequest(url, token, method = "GET", body = null) {
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
  return { ok: res.ok, status: res.status, body: parsed, error: res.ok ? null : String(text || "") };
}

async function patchRow(apiBase, tableId, token, rowId, payload) {
  return baserowRequest(
    `${apiBase}/database/rows/table/${encodeURIComponent(tableId)}/${encodeURIComponent(rowId)}/?user_field_names=true`,
    token,
    "PATCH",
    payload,
  );
}

async function mercariGraphQLViaSsh({ host, sshKey, token, clientName, clientVersion, query, variables }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const payload = JSON.stringify({ query, variables });
      const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
      const args = [
        "-i",
        sshKey,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        host,
        "bash",
        "-s",
      ];
      const stdinScript = `set -euo pipefail
payload="$(printf '%s' '${payloadBase64}' | base64 -d)"
curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql' \\
  -H ${shellQuote(`Authorization: Bearer ${token}`)} \\
  -H 'Content-Type: application/json' \\
  -H ${shellQuote(`User-Agent: ${clientName}/${clientVersion}`)} \\
  --data "$payload"`;
      const result = spawnSync("ssh", args, {
        encoding: "utf8",
        input: stdinScript,
        maxBuffer: 5 * 1024 * 1024,
      });
      if (result.status !== 0) {
        throw new Error(`mercari_ssh_failed:${result.stderr || result.stdout || `exit_${result.status}`}`);
      }
      const output = String(result.stdout || "").trim();
      const parsed = output ? JSON.parse(output) : {};
      if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length) {
        throw new Error(`mercari_graphql_error:${JSON.stringify(parsed.errors)}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt >= 4) break;
      const waitMs = 500 * attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError || new Error("mercari_graphql_failed");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}
