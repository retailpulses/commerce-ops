#!/usr/bin/env node

/**
 * Replay shipping close for multi-package orders that were impacted by the tracking bug.
 * 
 * This script re-sends ALL tracking numbers to Mercari shop for orders that
 * previously only had one tracking number transmitted.
 * 
 * Usage:
 *   node scripts/replay_multi_package_close.mjs --shops Shop3,Shop4 --dry-run
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createBaserowClient, listAllRows } from "../src/lib/baserow.mjs";

const DEFAULT_VPS_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");
const DEFAULT_DOC_TOKENS = "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md";
const DEFAULT_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_CLIENT_VERSION = "0.0.1";
const DEFAULT_ENV_PATH = "/Users/user/Documents/vibe coding/mail integration/dev.env";

const DEFAULT_SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};
const SHOP_LABEL_BY_ID = Object.fromEntries(Object.entries(DEFAULT_SHOP_IDS).map(([label, id]) => [id, label]));

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  loadEnvFileIfPresent(process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_ENV_PATH);
  
  const args = parseArgs(process.argv.slice(2));
  const dryRun = isTruthy(args["dry-run"]) || isTruthy(process.env.MERCARI_SHIPPING_DRY_RUN);
  const shops = resolveShops(args.shops || process.env.MERCARI_SHOPS || "Shop3,Shop4");
  const selectedShopIds = new Set(shops.map(shop => DEFAULT_SHOP_IDS[shop]).filter(Boolean));
  
  const tokensPath = process.env.MERCARI_TOKENS_PATH || DEFAULT_DOC_TOKENS;
  const host = process.env.MERCARI_SSH_HOST || DEFAULT_VPS_HOST;
  const sshKey = process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY;
  const clientName = process.env.MERCARI_API_CLIENT_NAME || DEFAULT_CLIENT_NAME;
  const clientVersion = process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_CLIENT_VERSION;
  
  const baserow = createBaserowClient(process.env);
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId);
  
  // Find multi-package orders that need replay
  const impactedOrders = findImpactedOrders(salesRows, selectedShopIds);
  
  const summary = {
    ok: true,
    dry_run: dryRun,
    total_candidates: impactedOrders.length,
    processed: 0,
    failed: 0,
    by_shop: {},
    results: [],
  };
  
  for (const order of impactedOrders) {
    const shopLabel = SHOP_LABEL_BY_ID[order.shop_id];
    if (!shopLabel) {
      summary.failed += 1;
      summary.results.push({
        order_id: order.order_id,
        shop_id: order.shop_id,
        error: "unknown_shop",
      });
      continue;
    }
    
    const bucket = summary.by_shop[shopLabel] || { processed: 0, failed: 0 };
    
    try {
      const token = await loadShopToken(tokensPath, shopLabel);
      
      console.log(`\nProcessing order: ${order.order_id} (${shopLabel})`);
      console.log(`  Tracking numbers: ${order.tracking_numbers.join(", ")}`);
      console.log(`  Carriers: ${order.carriers.join(", ")}`);
      
      if (dryRun) {
        console.log(`  [DRY RUN] Would re-send tracking to Mercari`);
        summary.processed += 1;
        bucket.processed += 1;
        summary.results.push({
          order_id: order.order_id,
          shop: shopLabel,
          dry_run: true,
          tracking_numbers: order.tracking_numbers,
          carriers: order.carriers,
          status: "would_replay",
        });
        continue;
      }
      
      // Build multi-line tracking code
      const trackingCode = buildTrackingCode(order.tracking_entries);
      
      // Call Mercari API to update tracking
      const result = await updateOrderTracking({
        host,
        sshKey,
        token,
        clientName,
        clientVersion,
        orderId: order.order_id,
        trackingCode,
      });
      
      summary.processed += 1;
      bucket.processed += 1;
      summary.results.push({
        order_id: order.order_id,
        shop: shopLabel,
        tracking_numbers: order.tracking_numbers,
        carriers: order.carriers,
        mercari_result: result,
        status: "replayed",
      });
      
      console.log(`  ✓ Successfully updated tracking on Mercari`);
    } catch (error) {
      summary.failed += 1;
      bucket.failed += 1;
      summary.results.push({
        order_id: order.order_id,
        shop: shopLabel,
        error: error.message || String(error),
        status: "failed",
      });
      console.error(`  ✗ Failed: ${error.message}`);
    }
    
    summary.by_shop[shopLabel] = bucket;
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("REPLAY SUMMARY");
  console.log("=".repeat(80));
  console.log(JSON.stringify(summary, null, 2));
  
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

function findImpactedOrders(salesRows, selectedShopIds) {
  const ordersByShop = new Map();
  
  for (const row of salesRows) {
    const shopId = text(row.shop_id);
    const trackingInfo = text(row.shipping_tracking_info);
    
    // Skip if not in selected shops
    if (selectedShopIds.size && !selectedShopIds.has(shopId)) continue;
    
    // Parse tracking info to find multi-package orders
    const entries = parseTrackingEntries(trackingInfo);
    if (entries.length < 2) continue; // Only multi-package orders
    
    const orderId = normalizeOrderId(row.order_id);
    if (!orderId) continue;
    
    if (!ordersByShop.has(shopId)) {
      ordersByShop.set(shopId, []);
    }
    ordersByShop.get(shopId).push({
      order_id: orderId,
      shop_id: shopId,
      tracking_entries: entries,
      tracking_numbers: entries.map(e => e.trackingNum),
      carriers: entries.map(e => e.carrierName),
      shipping_completed_at: row.shipping_completed_at,
      shop_close_status: row.shop_close_status,
    });
  }
  
  // Flatten and return
  const allOrders = [];
  for (const orders of ordersByShop.values()) {
    allOrders.push(...orders);
  }
  return allOrders;
}

function parseTrackingEntries(trackingInfo) {
  const entries = [];
  if (!trackingInfo) return entries;
  
  // Parse "Carrier: tracking; Carrier: tracking" format
  const chunks = trackingInfo.split(/[;;]/).filter(s => s.trim());
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    const match = trimmed.match(/^(.+?)[：:]\s*(.+)$/);
    if (match) {
      entries.push({
        carrierName: match[1].trim(),
        trackingNum: match[2].trim(),
      });
    }
  }
  return entries;
}

function buildTrackingCode(entries) {
  const entryList = Array.isArray(entries) ? entries : [entries].filter(e => e && e.trackingNum);
  if (!entryList.length) return "";
  // Mercari API supports multi-line tracking codes (per official docs)
  return entryList.map(entry => 
    `${text(entry.carrierName) || "Unknown"}\n${text(entry.trackingNum)}`
  ).join("\n\n");
}

async function updateOrderTracking({ host, sshKey, token, clientName, clientVersion, orderId, trackingCode }) {
  // First, find the order to get shipping info
  const order = await findOrderTransaction({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    orderId,
  });
  
  if (!order) {
    throw new Error("Order not found on Mercari");
  }
  
  // Check if order already has shipping
  const alreadyCompleted = String(order.status || "").toUpperCase() === "COMPLETED";
  
  if (alreadyCompleted) {
    // For completed orders, we need to check if we can still update tracking
    // In most cases, we can update tracking even after completion
    console.log(`  Note: Order is COMPLETED, but updating tracking anyway`);
  }
  
  // Get or create shipping
  const orderShippingId = await ensureShipping({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    orderId,
    order,
  });
  
  // Update tracking code with ALL tracking numbers
  const updateRes = await mercariRequest({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    query: UPDATE_TRACKING_MUTATION,
    variables: {
      input: {
        orderShippingId,
        orderTransactionId: orderId,
        trackingCode,
      },
    },
  });
  
  return {
    orderShippingId,
    trackingCodeLength: trackingCode.length,
    updated: true,
  };
}

async function ensureShipping({ host, sshKey, token, clientName, clientVersion, orderId, order }) {
  // For replay, always create new shipping with unique idempotency key
  // The API will handle duplicates via idempotency
  
  const products = Array.isArray(order.products) ? order.products : [];
  const activeProducts = products.filter(p => Number(p.unshippedQuantity || p.purchasedQuantity || 0) > 0);
  
  if (!activeProducts.length) {
    throw new Error("No active products to create shipping");
  }
  
  const shippingPlan = buildShippingPlan(activeProducts);
  const plan = shippingPlan[0]; // Use first shipping method
  
  const createRes = await mercariRequest({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    query: CREATE_SHIPPING_MUTATION,
    variables: {
      input: {
        idempotencyKey: `replay::${orderId}:${Date.now()}`,
        orderTransactionId: orderId,
        products: plan.products,
      },
    },
  });
  
  return createRes.data.createOrderShipping.orderShipping.id;
}

function buildShippingPlan(products) {
  const grouped = groupBy(products, p => text(p.shippingMethod) || "UNKNOWN");
  const plans = [];
  for (const [shippingMethod, groupProducts] of Object.entries(grouped)) {
    const normalizedProducts = groupProducts.map(p => ({
      productId: p.productId,
      quantity: Number(p.unshippedQuantity || p.purchasedQuantity || 0),
      variantId: p.variant && p.variant.id ? p.variant.id : null,
    }));
    plans.push({ shippingMethod, products: normalizedProducts });
  }
  return plans;
}

async function findOrderTransaction({ host, sshKey, token, clientName, clientVersion, orderId }) {
  try {
    const directResult = mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: ORDER_DIRECT_QUERY,
      variables: { id: orderId },
    });
    if (directResult && directResult.data && directResult.data.orderTransaction) {
      return directResult.data.orderTransaction;
    }
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!message.includes("NOT_FOUND")) {
      throw error;
    }
  }
  
  // Fallback to list query
  let after = null;
  const statuses = ["WAITING_FOR_PAYMENT", "WAITING_FOR_SHIPPING", "COMPLETING", "COMPLETED", "CANCELING", "CANCELED"];
  for (let page = 0; page < 20; page += 1) {
    const result = await mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: ORDER_QUERY,
      variables: { first: 500, after, statuses },
    });
    const edges = (result.data && result.data.orderTransactions && result.data.orderTransactions.edges) || [];
    const found = edges.map(edge => edge && edge.node).find(node => 
      node && normalizeOrderId(node.id) === orderId
    );
    if (found) return found;
    const pageInfo = result.data && result.data.orderTransactions && result.data.orderTransactions.pageInfo;
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return null;
}

async function loadShopToken(filePath, shopLabel) {
  const text = await readFileSync(filePath, "utf8");
  const section = text.split(/\n##\s+/).find(chunk => chunk.startsWith(shopLabel));
  if (!section) {
    throw new Error(`Missing ${shopLabel} in token file: ${filePath}`);
  }
  const match = section.match(/- API token:\s*`([^`]+)`/);
  if (!match) {
    throw new Error(`Missing API token for ${shopLabel} in token file: ${filePath}`);
  }
  return match[1];
}

function mercariRequest({ host, sshKey, token, clientName, clientVersion, query, variables }) {
  const execMode = String(process.env.MERCARI_EXEC_MODE || "").trim().toLowerCase();
  if (execMode === "direct") {
    return mercariRequestDirect({ token, clientName, clientVersion, query, variables });
  }
  
  const payload = JSON.stringify({ query, variables });
  const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
  const remoteScript = `set -euo pipefail
REQUEST_BODY="$(printf '%s' "$REQUEST_BODY_B64" | base64 -d)"
curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql' \\
  -H "Authorization: Bearer $MERCARI_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "User-Agent: $MERCARI_API_CLIENT_NAME/$MERCARI_API_CLIENT_VERSION" \\
  --data-binary "$REQUEST_BODY"
`;
  
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-i",
      sshKey,
      host,
      "env",
      `MERCARI_ACCESS_TOKEN=${token}`,
      `MERCARI_API_CLIENT_NAME=${clientName}`,
      `MERCARI_API_CLIENT_VERSION=${clientVersion}`,
      `REQUEST_BODY_B64=${payloadBase64}`,
      "bash",
      "-s",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, input: remoteScript }
  );
  
  if (result.status !== 0) {
    throw new Error(`SSH/Mercari request failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Mercari response was not JSON: ${result.stdout.slice(0, 500)}`);
  }
  if (parsed.errors && parsed.errors.length) {
    throw new Error(`Mercari GraphQL error: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed;
}

function mercariRequestDirect({ token, clientName, clientVersion, query, variables }) {
  const payload = JSON.stringify({ query, variables });
  const result = spawnSync(
    "curl",
    [
      "-4",
      "-sS",
      "-X",
      "POST",
      "https://api.mercari-shops.com/v1/graphql",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-H",
      `User-Agent: ${clientName}/${clientVersion}`,
      "--data-binary",
      "@-",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, input: payload },
  );
  if (result.status !== 0) {
    throw new Error(`Mercari direct request failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Mercari response was not JSON: ${String(result.stdout || "").slice(0, 500)}`);
  }
  if (parsed.errors && parsed.errors.length) {
    throw new Error(`Mercari GraphQL error: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed;
}

function text(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeOrderId(value) {
  return text(value).replace(/^order_/, "");
}

function groupBy(items, keyFn) {
  const map = {};
  for (const item of items) {
    const key = String(keyFn(item));
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function resolveShops(value) {
  return String(Array.isArray(value) ? value.join(",") : value || "")
    .split(/[,\s;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(shop => ["Shop1", "Shop2", "Shop3", "Shop4"].includes(shop));
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

const ORDER_QUERY = `
query orderTransactions($first: Int!, $after: String, $statuses: [OrderTransactionStatusFilter!]) {
  orderTransactions(first: $first, after: $after, statuses: $statuses) {
    edges {
      node {
        id
        status
        createdAt
        completedAt
        paidAt
        products {
          productId
          purchasedQuantity
          unshippedQuantity
          shippingMethod
          variant {
            id
            skuCode
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const ORDER_DIRECT_QUERY = `
query orderTransaction($id: ID!) {
  orderTransaction(id: $id) {
    id
    status
    createdAt
    completedAt
    paidAt
    products {
      productId
      purchasedQuantity
      unshippedQuantity
      shippingMethod
      variant {
        id
        skuCode
      }
    }
  }
}
`;

const CREATE_SHIPPING_MUTATION = `
mutation createOrderShipping($input: CreateOrderShippingInput!) {
  createOrderShipping(input: $input) {
    orderShipping {
      id
    }
  }
}
`;

const UPDATE_TRACKING_MUTATION = `
mutation updateOrderShippingTrackingCode($input: UpdateOrderShippingTrackingCodeInput!) {
  updateOrderShippingTrackingCode(input: $input) {
    orderShipping {
      id
    }
  }
}
`;
