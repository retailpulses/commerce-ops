#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const DEFAULT_TOKENS = "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md";
const DEFAULT_SSH_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const orderId = process.env.MERCARI_ORDER_ID || "2JPDfQ5MRbUFVsc3ZLH4FR";
  const shopLabel = process.env.MERCARI_SHOP_LABEL || "Shop4";
  const tokensPath = process.env.MERCARI_TOKENS_PATH || DEFAULT_TOKENS;
  const host = process.env.MERCARI_SSH_HOST || DEFAULT_SSH_HOST;
  const sshKey = process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY;
  const token = await loadShopToken(tokensPath, shopLabel);

  const query = {
    query: `query orderTransactions($first: Int!, $statuses: [OrderTransactionStatusFilter!]) {
      orderTransactions(first: $first, statuses: $statuses) {
        edges {
          node {
            id
            status
            products {
              productId
              purchasedQuantity
              unshippedQuantity
              shippingMethod
              variant { id skuCode }
            }
            shipping {
              id
              status
              method
              trackingCode
              completedAt
              shippedAt
            }
          }
        }
      }
    }`,
    variables: {
      first: 10,
      statuses: ["WAITING_FOR_SHIPPING", "COMPLETED", "WAITING_FOR_PAYMENT", "COMPLETING"],
    },
  };

  const response = await mercariRequest({ host, sshKey, token, body: JSON.stringify(query) });
  const nodes = (((response.data || {}).orderTransactions || {}).edges || []).map((edge) => edge && edge.node).filter(Boolean);
  const match = nodes.find((node) => String(node.id) === String(orderId));
  if (!match) {
    console.log(JSON.stringify({ orderId, found: false, nodes }, null, 2));
    return;
  }

  console.log(JSON.stringify({ orderId, found: true, node: match }, null, 2));
}

async function loadShopToken(filePath, shopLabel) {
  const text = await fs.readFile(filePath, "utf8");
  const section = text.split(/\n##\s+/).find((chunk) => chunk.startsWith(shopLabel));
  if (!section) throw new Error(`Missing ${shopLabel} in token file`);
  const match = section.match(/- API token:\s*`([^`]+)`/);
  if (!match) throw new Error(`Missing API token for ${shopLabel}`);
  return match[1];
}

function mercariRequest({ host, sshKey, token, body }) {
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
      `MERCARI_API_CLIENT_NAME=Inhouse_ERP`,
      `MERCARI_API_CLIENT_VERSION=0.0.1`,
      `REQUEST_BODY=${body}`,
      "bash",
      "-s",
    ],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      input: `set -euo pipefail
curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql' \
  -H "Authorization: Bearer $MERCARI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $MERCARI_API_CLIENT_NAME/$MERCARI_API_CLIENT_VERSION" \
  --data-binary "$REQUEST_BODY"
`,
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `exit ${result.status}`);
  }
  return JSON.parse(result.stdout);
}
