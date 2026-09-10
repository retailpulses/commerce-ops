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
  const orderId = String(process.env.MERCARI_ORDER_ID || "2JPDfrQttQs8cC5oJgxRzY").trim();
  const shopLabel = String(process.env.MERCARI_SHOP_LABEL || "Shop4").trim();
  const tokensPath = process.env.MERCARI_TOKENS_PATH || DEFAULT_TOKENS;
  const host = process.env.MERCARI_SSH_HOST || DEFAULT_SSH_HOST;
  const sshKey = process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY;
  const token = await loadShopToken(tokensPath, shopLabel);

  const byId = await tryDirectById({ host, sshKey, token, orderId });
  const byPrefixedId = await tryDirectById({ host, sshKey, token, orderId: `order_${orderId}` });
  const typeInfo = await introspectType({ host, sshKey, token, typeName: "OrderTransaction" });
  const mutationInfo = await introspectType({ host, sshKey, token, typeName: "Mutation" });
  const byPaging = await tryPagedLookup({ host, sshKey, token, orderIds: [orderId, `order_${orderId}`] });

  console.log(JSON.stringify({
    shopLabel,
    orderId,
    direct_by_id: byId,
    direct_by_prefixed_id: byPrefixedId,
    order_transaction_type: typeInfo,
    mutation_type: mutationInfo,
    paged_lookup: byPaging,
  }, null, 2));
}

async function tryDirectById({ host, sshKey, token, orderId }) {
  const query = {
    query: `query orderTransaction($id: ID!) {
      orderTransaction(id: $id) {
        id
        status
        completedAt
        paidAt
        products {
          productId
          purchasedQuantity
          unshippedQuantity
          shippingMethod
          variant { id skuCode }
        }
      }
    }`,
    variables: { id: orderId },
  };
  return await mercariRequest({ host, sshKey, token, body: JSON.stringify(query) });
}

async function tryPagedLookup({ host, sshKey, token, orderIds }) {
  const query = {
    query: `query orderTransactions($first: Int!, $after: String, $statuses: [OrderTransactionStatusFilter!]) {
      orderTransactions(first: $first, after: $after, statuses: $statuses) {
        edges {
          node {
            id
            status
            completedAt
            paidAt
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
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`,
    variables: {
      first: 100,
      after: null,
      statuses: ["WAITING_FOR_SHIPPING", "COMPLETING", "COMPLETED", "WAITING_FOR_PAYMENT", "CANCELING", "CANCELED"],
    },
  };

  const found = [];
  let after = null;
  for (let page = 0; page < 50; page += 1) {
    query.variables.after = after;
    const response = await mercariRequest({ host, sshKey, token, body: JSON.stringify(query) });
    const edges = (((response.data || {}).orderTransactions || {}).edges || []).map((edge) => edge && edge.node).filter(Boolean);
    for (const node of edges) {
      if (orderIds.includes(String(node.id))) {
        found.push(node);
      }
    }
    const pageInfo = ((response.data || {}).orderTransactions || {}).pageInfo || {};
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return found;
}

async function introspectType({ host, sshKey, token, typeName }) {
  const query = {
    query: `query typeInfo($name: String!) {
      __type(name: $name) {
        name
        fields {
          name
          type {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }`,
    variables: { name: typeName },
  };
  return await mercariRequest({ host, sshKey, token, body: JSON.stringify(query) });
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
  const bodyBase64 = Buffer.from(body, "utf8").toString("base64");
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
      "MERCARI_API_CLIENT_NAME=Inhouse_ERP",
      "MERCARI_API_CLIENT_VERSION=0.0.1",
      `REQUEST_BODY_B64=${bodyBase64}`,
      "bash",
      "-s",
    ],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      input: `set -euo pipefail
REQUEST_BODY="$(printf '%s' "$REQUEST_BODY_B64" | base64 -d)"
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
