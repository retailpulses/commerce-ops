#!/usr/bin/env node

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  orderStatus: "order_status",
  shopId: "shop_id",
};

const ORDER_QUERY = `
query orderTransaction($id: ID!) {
  orderTransaction(id: $id) {
    id
    status
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
  const limit = parseInteger(args.limit || args["order-limit"] || "0", 0);

  if (!token) throw new Error("Missing BASEROW_DATABASE_TOKEN");
  if (!Number.isFinite(tableId) || tableId <= 0) throw new Error("Invalid table id");

  const rows = await loadAllRows(apiBase, tableId, token);
  const candidates = rows.filter((row) => {
    if (normalizeText(row[ORDER_FIELD_NAMES.orderStatus])) return false;
    const orderId = normalizeOrderId(row[ORDER_FIELD_NAMES.orderId]);
    const shopId = normalizeText(row[ORDER_FIELD_NAMES.shopId]);
    return Boolean(orderId && shopId && SHOP_LABEL_BY_ID[shopId]);
  });

  const grouped = new Map();
  for (const row of candidates) {
    const orderId = normalizeOrderId(row[ORDER_FIELD_NAMES.orderId]);
    const shopId = normalizeText(row[ORDER_FIELD_NAMES.shopId]);
    const key = `${shopId}::${orderId}`;
    if (!grouped.has(key)) grouped.set(key, { shopId, orderId, rowIds: [] });
    grouped.get(key).rowIds.push(Number(row.id));
  }

  const secrets = await loadShopSecrets(tokensPath);
  const summary = {
    ok: true,
    dry_run: dryRun,
    candidate_rows: candidates.length,
    unique_orders: grouped.size,
    updated_rows: 0,
    skipped_orders: 0,
    failed_orders: 0,
    failures: [],
    samples: [],
  };

  let processed = 0;
  for (const item of grouped.values()) {
    if (limit > 0 && processed >= limit) break;
    processed += 1;
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
      const status = normalizeText(order ? order.status : "");
      if (!status) {
        summary.skipped_orders += 1;
        continue;
      }
      if (summary.samples.length < 20) {
        summary.samples.push({ order_id: item.orderId, shop: shopLabel, status, row_ids: item.rowIds.slice(0, 5) });
      }
      for (const rowId of item.rowIds) {
        const payload = { [ORDER_FIELD_NAMES.orderStatus]: status };
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
    } catch (error) {
      summary.failed_orders += 1;
      summary.failures.push({ order_id: item.orderId, shop: shopLabel, error: error && error.message ? error.message : String(error) });
    }
  }

  if (summary.failures.length > 50) summary.failures = summary.failures.slice(0, 50);
  summary.ok = summary.failed_orders === 0;
  summary.processed_orders = processed;
  console.log(JSON.stringify(summary, null, 2));
}

function normalizeOrderId(value) {
  return normalizeText(value).replace(/^order_/, "");
}

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function parseInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
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

async function loadShopSecrets(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const shops = new Map();
  let currentLabel = "";
  let currentShopId = "";
  let currentToken = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(/^##\s+(Shop\d+)\s*$/);
    if (labelMatch) {
      if (currentLabel && currentShopId && currentToken) {
        shops.set(currentLabel, { shopId: currentShopId, token: currentToken });
      }
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
  if (currentLabel && currentShopId && currentToken) {
    shops.set(currentLabel, { shopId: currentShopId, token: currentToken });
  }
  return shops;
}

async function loadAllRows(apiBase, tableId, token) {
  const out = [];
  let next = `${apiBase}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true&size=200`;
  while (next) {
    const res = await fetch(next, { headers: { authorization: `Token ${token}`, accept: "application/json" } });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || body.detail || `baserow_list_${res.status}`);
    out.push(...(Array.isArray(body.results) ? body.results : []));
    next = body.next ? normalizeNextUrl(String(body.next)) : "";
  }
  return out;
}

function normalizeNextUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === "api.baserow.io" && parsed.protocol === "http:") parsed.protocol = "https:";
    return parsed.toString();
  } catch {
    return raw.replace(/^http:\/\//i, "https://");
  }
}

async function patchRow(apiBase, tableId, token, rowId, payload) {
  const url = `${apiBase}/database/rows/table/${encodeURIComponent(tableId)}/${encodeURIComponent(rowId)}/?user_field_names=true`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { authorization: `Token ${token}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  const ok = res.ok && !body.error;
  return { ok, status: res.status, body, error: ok ? null : body.error || body.detail || `patch_${res.status}` };
}

async function mercariGraphQLViaSsh({ host, sshKey, token, clientName, clientVersion, query, variables }) {
  const payload = JSON.stringify({ query, variables });
  const script = buildCurlScript({
    token,
    clientName,
    clientVersion,
    payload,
  });
  const result = spawnSync("ssh", ["-i", sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", host, "bash", "-s"], {
    encoding: "utf8",
    input: script,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `ssh_exit_${result.status}`);
  }
  const raw = String(result.stdout || "").trim();
  const parsed = raw ? JSON.parse(raw) : null;
  if (parsed && parsed.errors && parsed.errors.length) {
    throw new Error(parsed.errors[0].message || "mercari_graphql_error");
  }
  return parsed;
}

function buildCurlScript({ token, clientName, clientVersion, payload }) {
  const safePayload = payload.replace(/'/g, "'\"'\"'");
  return [
    "set -euo pipefail",
    `curl -sS -4 -X POST 'https://api.mercari-shops.com/v1/graphql' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Accept: application/json' \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'User-Agent: ${clientName}/${clientVersion}' \\`,
    `  --data '${safePayload}'`,
  ].join("\n");
}
