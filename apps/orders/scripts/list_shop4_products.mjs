#!/usr/bin/env node

// ── Mercari Shop Products List Script ────────────────────────────────
//
// Lists ALL Shop4 products with their variant SKU codes (商品管理コード).
// Called by the VPS relay in response to POST /admin/mercari-products-list.
//
// Input (via env vars):
//   MERCARI_SHOP_LABEL       — Shop label (e.g. "Shop4")
//   MERCARI_TOKENS_PATH      — Path to Mercari API tokens file
//   MERCARI_EXEC_MODE        — "direct" to run curl locally
//
// Output (stdout): JSON
//   { ok: true, products: [{ id, name, status, variantSkuCodes: [...] }],
//     totalCount: N, pages: N }
//   or { ok: false, error: "..." }

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_TOKENS_PATH = [
  "/opt/secrets/Mercari_API_Tokens_Private_2026-04-01.md",
  path.join(REPO_ROOT, "knowledge", "Mercari_API_Tokens_Private_2026-04-01.md"),
  path.join(REPO_ROOT, "env", "Mercari_API_Tokens_Private_2026-04-01.md"),
  "/opt/rp-order-mgmt/env/Mercari_API_Tokens_Private_2026-04-01.md",
  "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md",
].find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });

const DEFAULT_API_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_API_CLIENT_VERSION = "0.0.1";
const MERCARI_GRAPHQL_URL = "https://api.mercari-shops.com/v1/graphql";

// Paginated products query — lists all products with variant SKU codes.
const PRODUCTS_LIST_QUERY = `
query ListProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    edges {
      node {
        id
        name
        status
        price
        variants {
          skuCode
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const SHOP_FIELD_RE = /^##\s+(Shop\d+)\s*$/;
const SHOP_TOKEN_RE = /-\s*API token:\s*`([^`]+)`/;

async function main() {
  const shopLabel = String(process.env.MERCARI_SHOP_LABEL || "Shop4").trim();
  const tokensPath = String(process.env.MERCARI_TOKENS_PATH || DEFAULT_TOKENS_PATH || "").trim();

  if (!tokensPath) {
    return { ok: false, error: "Mercari tokens file not found" };
  }

  const token = await loadShopToken(tokensPath, shopLabel);
  if (!token) {
    return { ok: false, error: `API token not found for ${shopLabel}` };
  }

  // Paginate through all products
  const allProducts = [];
  let after = null;
  let page = 0;
  const PAGE_SIZE = 50;

  while (true) {
    page++;
    const result = await runGraphQL({
      token,
      query: PRODUCTS_LIST_QUERY,
      variables: { first: PAGE_SIZE, after },
    });

    if (!result || result.errors) {
      const errMsg = result?.errors ? JSON.stringify(result.errors) : "Empty response from Mercari API";
      return { ok: false, error: `Page ${page}: ${errMsg}` };
    }

    const connection = result.data?.products;
    if (!connection) {
      return { ok: false, error: `Page ${page}: no products connection in response` };
    }

    const edges = connection.edges || [];
    for (const edge of edges) {
      const node = edge.node;
      if (!node) continue;
      allProducts.push({
        id: node.id || "",
        name: node.name || "",
        status: node.status || "",
        price: node.price != null ? Number(node.price) : null,
        variantSkuCodes: Array.isArray(node.variants)
          ? node.variants.map((v) => v.skuCode || "").filter(Boolean)
          : [],
      });
    }
    // Log progress to stderr (only used for debugging; relay ignores stderr on success)
    process.stderr.write(`Page ${page}: ${edges.length} products (total: ${allProducts.length})\n`);

    const hasNext = connection.pageInfo?.hasNextPage;
    const endCursor = connection.pageInfo?.endCursor;

    if (!hasNext || !endCursor) break;
    after = endCursor;
  }

  return {
    ok: true,
    totalCount: allProducts.length,
    pages: page,
    products: allProducts,
  };
}

async function loadShopToken(filePath, shopLabel) {
  const raw = await fsp.readFile(filePath, "utf8");
  let currentLabel = "";
  let currentToken = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(SHOP_FIELD_RE);
    if (labelMatch) {
      if (currentLabel === shopLabel && currentToken) return currentToken;
      currentLabel = labelMatch[1];
      currentToken = "";
      continue;
    }
    const tokenMatch = line.match(SHOP_TOKEN_RE);
    if (tokenMatch && currentLabel === shopLabel) currentToken = tokenMatch[1].trim();
  }
  if (currentLabel === shopLabel && currentToken) return currentToken;
  return null;
}

function runGraphQL({ token, query, variables }) {
  const clientName = String(process.env.MERCARI_API_CLIENT_NAME || DEFAULT_API_CLIENT_NAME).trim();
  const clientVersion = String(process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_API_CLIENT_VERSION).trim();
  const payload = JSON.stringify({ query, variables });
  const result = spawnSync(
    "curl",
    [
      "-4", "-sS", "-X", "POST", MERCARI_GRAPHQL_URL,
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json",
      "-H", `User-Agent: ${clientName}/${clientVersion}`,
      "--data-binary", "@-",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, input: payload }
  );
  if (result.status !== 0) {
    throw new Error(`Mercari request failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  const trimmed = String(result.stdout || "").trim();
  if (!trimmed) {
    throw new Error("Mercari request returned empty body");
  }
  return JSON.parse(trimmed);
}

// ── Execute ────────────────────────────────────────────────────
main()
  .then((result) => {
    // Write full data to stdout as JSON
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })
  .catch((error) => {
    console.log(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
