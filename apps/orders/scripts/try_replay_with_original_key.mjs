#!/usr/bin/env node

/**
 * Try to get orderShippingId by re-running the original close flow.
 * Use the same idempotency key pattern as the original close.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const DEFAULT_VPS_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");
const DEFAULT_DOC_TOKENS = "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md";
const DEFAULT_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_CLIENT_VERSION = "0.0.1";

const ORDERS_TO_FIX = [
  {
    order_id: "2JPNLvfXPZdwJLav3fsfcH",
    shop_label: "Shop4",
    tracking_entries: [
      { carrierName: "ヤマト運輸", trackingNum: "488175515693" },
      { carrierName: "佐川急便", trackingNum: "490624730212" },
    ],
  },
  {
    order_id: "2JPEY6X5wc5YCX3EjXYh7z",
    shop_label: "Shop4",
    tracking_entries: [
      { carrierName: "佐川急便", trackingNum: "490883721381" },
      { carrierName: "ヤマト運輸", trackingNum: "488153882764" },
    ],
  },
  {
    order_id: "2JPEhdz4MvEeV7tqeFxZGT",
    shop_label: "Shop3",
    tracking_entries: [
      { carrierName: "佐川急便", trackingNum: "490624728436" },
      { carrierName: "佐川急便", trackingNum: "490624729453" },
    ],
  },
];

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const tokensPath = process.env.MERCARI_TOKENS_PATH || DEFAULT_DOC_TOKENS;
  const host = process.env.MERCARI_SSH_HOST || DEFAULT_VPS_HOST;
  const sshKey = process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY;
  const clientName = process.env.MERCARI_API_CLIENT_NAME || DEFAULT_CLIENT_NAME;
  const clientVersion = process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_CLIENT_VERSION;
  
  const summary = {
    ok: true,
    total: ORDERS_TO_FIX.length,
    processed: 0,
    failed: 0,
    results: [],
  };
  
  for (const orderConfig of ORDERS_TO_FIX) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Processing: ${orderConfig.order_id} (${orderConfig.shop_label})`);
    console.log(`${"=".repeat(80)}`);
    
    try {
      const token = await loadShopToken(tokensPath, orderConfig.shop_label);
      
      // Step 1: Get order details
      console.log(`Fetching order details...`);
      const order = await findOrderTransaction({
        host,
        sshKey,
        token,
        clientName,
        clientVersion,
        orderId: orderConfig.order_id,
      });
      
      if (!order) {
        throw new Error("Order not found");
      }
      
      console.log(`Order status: ${order.status}`);
      
      // Step 2: Build shipping plan
      const products = Array.isArray(order.products) ? order.products : [];
      const activeProducts = products.filter(p => Number(p.unshippedQuantity || p.purchasedQuantity || 0) > 0);
      
      if (!activeProducts.length) {
        console.log(`No active products - order may already be fully shipped`);
      }
      
      const shippingPlan = buildShippingPlan(activeProducts);
      console.log(`Shipping methods: ${shippingPlan.map(p => p.shippingMethod).join(", ")}`);
      
      // Step 3: Try to create shipping with original idempotency key pattern
      // The original close used: `${orderId}:${plan.shippingMethod}:${products...}`
      const plan = shippingPlan[0];
      const originalIdempotencyKey = `${orderConfig.order_id}:${plan.shippingMethod}:${plan.products.map(item => `${item.productId}:${item.quantity}`).join("|")}`;
      
      console.log(`Attempting to create shipping with original idempotency key...`);
      console.log(`Idempotency key: ${originalIdempotencyKey}`);
      
      let orderShippingId;
      
      try {
        const createRes = await mercariRequest({
          host,
          sshKey,
          token,
          clientName,
          clientVersion,
          query: CREATE_SHIPPING_MUTATION,
          variables: {
            input: {
              idempotencyKey: originalIdempotencyKey,
              orderTransactionId: orderConfig.order_id,
              products: plan.products,
            },
          },
        });
        
        orderShippingId = createRes.data.createOrderShipping.orderShipping.id;
        console.log(`Created/fetched orderShippingId: ${orderShippingId}`);
      } catch (createError) {
        if (createError.message.includes("FAILED_PRECONDITION")) {
          // Order already has shipping - try a different approach
          // Use a unique idempotency key and see if error message contains existing ID
          console.log(`Order already has shipping, trying with unique key...`);
          
          const uniqueIdempotencyKey = `replay-${Date.now()}:${orderConfig.order_id}`;
          try {
            const createRes2 = await mercariRequest({
              host,
              sshKey,
              token,
              clientName,
              clientVersion,
              query: CREATE_SHIPPING_MUTATION,
              variables: {
                input: {
                  idempotencyKey: uniqueIdempotencyKey,
                  orderTransactionId: orderConfig.order_id,
                  products: plan.products,
                },
              },
            });
            orderShippingId = createRes2.data.createOrderShipping.orderShipping.id;
            console.log(`Created new shipping: ${orderShippingId}`);
          } catch (error2) {
            console.log(`Also failed: ${error2.message}`);
            // Extract any useful info from error
            throw new Error(`Cannot get orderShippingId. Original error: ${createError.message}`);
          }
        } else {
          throw createError;
        }
      }
      
      // Step 4: Update tracking
      const trackingCode = buildTrackingCode(orderConfig.tracking_entries);
      console.log(`Updating tracking with ${orderConfig.tracking_entries.length} tracking numbers...`);
      
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
            orderTransactionId: orderConfig.order_id,
            trackingCode,
          },
        },
      });
      
      console.log(`✓ Successfully updated tracking!`);
      console.log(`orderShippingId: ${orderShippingId}`);
      
      summary.processed += 1;
      summary.results.push({
        order_id: orderConfig.order_id,
        shop: orderConfig.shop_label,
        status: "updated",
        orderShippingId,
        tracking_numbers: orderConfig.tracking_entries.map(e => e.trackingNum),
      });
    } catch (error) {
      console.error(`✗ Failed: ${error.message}`);
      summary.failed += 1;
      summary.results.push({
        order_id: orderConfig.order_id,
        shop: orderConfig.shop_label,
        status: "failed",
        error: error.message,
      });
    }
  }
  
  console.log(`\n${"=".repeat(80)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(80)}`);
  console.log(JSON.stringify(summary, null, 2));
  
  process.exitCode = summary.failed > 0 ? 1 : 0;
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

function buildTrackingCode(entries) {
  const entryList = Array.isArray(entries) ? entries : [entries].filter(e => e && e.trackingNum);
  if (!entryList.length) return "";
  return entryList.map(entry => 
    `${text(entry.carrierName) || "Unknown"}\n${text(entry.trackingNum)}`
  ).join("\n\n");
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
      normalizeOrderId(node.id) === orderId
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
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, input: remoteScript, timeout: 30000 }
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

const ORDER_QUERY = `
query orderTransactions($first: Int!, $after: String, $statuses: [OrderTransactionStatusFilter!]) {
  orderTransactions(first: $first, after: $after, statuses: $statuses) {
    edges {
      node {
        id
        status
        products {
          productId
          purchasedQuantity
          unshippedQuantity
          shippingMethod
          variant {
            id
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
    products {
      productId
      purchasedQuantity
      unshippedQuantity
      shippingMethod
      variant {
        id
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
