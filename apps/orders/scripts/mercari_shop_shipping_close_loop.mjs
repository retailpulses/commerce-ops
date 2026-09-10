#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createBaserowClient, listAllRows } from "../src/lib/baserow.mjs";

const DEFAULT_VPS_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");
const DEFAULT_DOC_TOKENS = [
  "/opt/secrets/Mercari_API_Tokens_Private_2026-04-01.md",
  "/opt/OrderMgmt/env/Mercari_API_Tokens_Private_2026-04-01.md",
  "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md",
].find((p) => { try { require("node:fs").accessSync(p); return true; } catch { return false; } });
const DEFAULT_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_CLIENT_VERSION = "0.0.1";
const DEFAULT_ORDER_ID = "2JPDfQ5MRbUFVsc3ZLH4FR";

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const orderId = normalizeOrderIdCandidate(process.env.MERCARI_ORDER_ID || DEFAULT_ORDER_ID);
  const tokensPath = process.env.MERCARI_TOKENS_PATH || DEFAULT_DOC_TOKENS;
  const shopLabel = process.env.MERCARI_SHOP_LABEL || "Shop4";
  const host = process.env.MERCARI_SSH_HOST || DEFAULT_VPS_HOST;
  const sshKey = process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY;
  const clientName = process.env.MERCARI_API_CLIENT_NAME || DEFAULT_CLIENT_NAME;
  const clientVersion = process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_CLIENT_VERSION;
  const dryRun = isTruthy(process.env.MERCARI_SHIPPING_DRY_RUN) || process.env.MERCARI_SHIPPING_MODE === "query-only";

  const token = await loadShopToken(tokensPath, shopLabel);
  
  // Load tracking info from Baserow for multi-package support
  const baserow = createBaserowClient(process.env);
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId);
  const matchingSalesRow = salesRows.find(row => 
    normalizeOrderIdCandidate(row.order_id) === orderId && 
    text(row.shop_id) === DEFAULT_SHOP_IDS[shopLabel]
  );
  
  const trackingEntries = matchingSalesRow 
    ? parseTrackingEntries(
        matchingSalesRow.shipping_tracking_raw, 
        matchingSalesRow.shipping_tracking_info
      )
    : [];

  if (!trackingEntries.length && !dryRun) {
    throw new Error(`No tracking entries found for order ${orderId} in Baserow`);
  }

  const listQuery = `
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
  const directQuery = `
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

  const order = await findOrderTransaction({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    listQuery,
    directQuery,
    orderId,
  });
  if (!order) {
    throw new Error(`orderTransaction/order not found for ${orderId}`);
  }

  const products = Array.isArray(order.products) ? order.products : [];
  const activeProducts = products.filter((product) => Number(product.unshippedQuantity || product.purchasedQuantity || 0) > 0);
  if (!activeProducts.length) {
    throw new Error(`No active products to ship for ${orderId}`);
  }

  const orderShippingsByMethod = groupBy(activeProducts, (product) => product.shippingMethod || "UNKNOWN");
  const shippingPlan = [];

  for (const [shippingMethod, groupProducts] of Object.entries(orderShippingsByMethod)) {
    const normalizedProducts = groupProducts.map((product) => ({
      productId: product.productId,
      quantity: Number(product.unshippedQuantity || product.purchasedQuantity || 0),
      variantId: product.variant && product.variant.id ? product.variant.id : null,
    }));

    if (normalizedProducts.some((item) => !item.productId || !item.quantity || !item.variantId)) {
      throw new Error(`Missing productId / quantity / variantId for ${orderId} shippingMethod=${shippingMethod}`);
    }

    shippingPlan.push({
      shippingMethod,
      products: normalizedProducts,
    });
  }

  const createMutation = `
mutation createOrderShipping($input: CreateOrderShippingInput!) {
  createOrderShipping(input: $input) {
    orderShipping {
      id
      status
      shippingMethod
      trackingCode
      completedAt
      shippedAt
    }
  }
}
`;
  const updateMutation = `
mutation updateOrderShippingTrackingCode($input: UpdateOrderShippingTrackingCodeInput!) {
  updateOrderShippingTrackingCode(input: $input) {
    orderShipping {
      id
      status
      shippingMethod
      trackingCode
      completedAt
      shippedAt
    }
  }
}
`;
  const completeMutation = `
mutation completeOrderShipping($input: CompleteOrderShippingInput!) {
  completeOrderShipping(input: $input) {
    orderShippingId
  }
}
`;

  const trackingCode = buildTrackingCode(trackingEntries);
  if (dryRun) {
    console.log(JSON.stringify({
      orderId,
      dryRun: true,
      order: {
        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        completedAt: order.completedAt,
        paidAt: order.paidAt,
      },
      shippingPlan,
      tracking_entries: trackingEntries,
      trackingCode,
    }, null, 2));
    return;
  }

  const results = [];
  for (const plan of shippingPlan) {
    const createRes = await mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: createMutation,
      variables: {
        input: {
          idempotencyKey: `${orderId}:${plan.shippingMethod}:${plan.products.map((item) => `${item.productId}:${item.quantity}`).join("|")}`,
          orderTransactionId: orderId,
          products: plan.products,
        },
      },
    });
    const orderShippingId = createRes.data.createOrderShipping.orderShipping.id;
    results.push({ step: "create", shippingMethod: plan.shippingMethod, orderShippingId, response: createRes.data.createOrderShipping.orderShipping });

    const updateRes = await mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: updateMutation,
      variables: {
        input: {
          orderShippingId,
          orderTransactionId: orderId,
          trackingCode,
        },
      },
    });
    results.push({ step: "tracking", shippingMethod: plan.shippingMethod, orderShippingId, response: updateRes.data.updateOrderShippingTrackingCode.orderShipping });

    const completeRes = await mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: completeMutation,
      variables: {
        input: {
          orderShippingId,
          orderTransactionId: orderId,
        },
      },
    });
    results.push({ step: "complete", shippingMethod: plan.shippingMethod, orderShippingId, response: completeRes.data.completeOrderShipping });
  }

  const finalOrder = await findOrderTransaction({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    listQuery,
    directQuery,
    orderId,
  });

  console.log(JSON.stringify({
    orderId,
    shippingPlan,
    results,
    finalOrder: finalOrder ? {
      id: finalOrder.id,
      status: finalOrder.status,
      completedAt: finalOrder.completedAt,
      shipping: finalOrder.shipping || null,
    } : null,
  }, null, 2));
}

function buildTrackingCodeFromEnv() {
  const raw = process.env.MERCARI_TRACKING_CODE || process.env.SHIPPING_TRACKING_CODE || "ヤマト運輸\n488145325846";
  return String(raw).trim();
}

function parseTrackingEntries(rawTracking, detailTracking) {
  const entries = [];
  const raw = text(rawTracking);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.shipTrackInfo) ? parsed.shipTrackInfo : [];
      for (const item of list) {
        const carrierName = text(item && item.carrierName);
        const trackingNum = text(item && item.trackingNum);
        if (carrierName || trackingNum) entries.push({ carrierName, trackingNum });
      }
    } catch {
      // fallback below
    }
  }
  if (!entries.length) {
    const detail = text(detailTracking);
    for (const chunk of detail.split(/[;；]/g)) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(.+?)[：:]\s*(.+)$/);
      if (match) {
        entries.push({ carrierName: match[1].trim(), trackingNum: match[2].trim() });
      }
    }
  }
  return entries.filter((entry) => entry.trackingNum);
}

function buildTrackingCode(entries) {
  const entryList = Array.isArray(entries) ? entries : [entries].filter(e => e && e.trackingNum);
  if (!entryList.length) return "";
  // Mercari API supports multi-line tracking codes (per official docs)
  // Each package is separated by double newline to preserve carrier:tracking pairs
  return entryList.map(entry => 
    `${text(entry.carrierName) || "Unknown"}\n${text(entry.trackingNum)}`
  ).join("\n\n");
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function normalizeOrderIdCandidate(value) {
  return String(value === null || value === undefined ? "" : value).trim().replace(/^order_/, "");
}

async function loadShopToken(filePath, shopLabel) {
  const text = await fs.readFile(filePath, "utf8");
  const section = text.split(/\n##\s+/).find((chunk) => chunk.startsWith(shopLabel));
  if (!section) {
    throw new Error(`Missing ${shopLabel} in token file: ${filePath}`);
  }
  const match = section.match(/- API token:\s*`([^`]+)`/);
  if (!match) {
    throw new Error(`Missing API token for ${shopLabel} in token file: ${filePath}`);
  }
  return match[1];
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

async function mercariRequest({ host, sshKey, token, clientName, clientVersion, query, variables }) {
  const execMode = String(process.env.MERCARI_EXEC_MODE || "").trim().toLowerCase();
  if (execMode === "direct") {
    return await mercariRequestDirect({ token, clientName, clientVersion, query, variables });
  }

  const payload = JSON.stringify({ query, variables });
  const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
  const remoteScript = `set -euo pipefail
REQUEST_BODY="$(printf '%s' "$REQUEST_BODY_B64" | base64 -d)"
curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql' \
  -H "Authorization: Bearer $MERCARI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $MERCARI_API_CLIENT_NAME/$MERCARI_API_CLIENT_VERSION" \
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
  } catch (error) {
    throw new Error(`Mercari response was not JSON: ${result.stdout.slice(0, 500)}`);
  }
  if (parsed.errors && parsed.errors.length) {
    throw new Error(`Mercari GraphQL error: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed;
}

async function mercariRequestDirect({ token, clientName, clientVersion, query, variables }) {
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
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, input: payload }
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

async function findOrderTransaction({ host, sshKey, token, clientName, clientVersion, listQuery, directQuery, orderId }) {
  try {
    const directResult = await mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: directQuery,
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

  let after = null;
  const statuses = ["WAITING_FOR_PAYMENT", "WAITING_FOR_SHIPPING", "COMPLETING", "COMPLETED", "CANCELING", "CANCELED"];
  for (let page = 0; page < 20; page += 1) {
    const result = await mercariRequest({
      host,
      sshKey,
      token,
      clientName,
      clientVersion,
      query: listQuery,
      variables: { first: 500, after, statuses },
    });
    const edges = (result.data && result.data.orderTransactions && result.data.orderTransactions.edges) || [];
    const found = edges.map((edge) => edge && edge.node).find((node) => node && normalizeOrderIdCandidate(node.id) === orderId);
    if (found) return found;
    const pageInfo = result.data && result.data.orderTransactions && result.data.orderTransactions.pageInfo;
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return null;
}

function text(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

const DEFAULT_SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};
