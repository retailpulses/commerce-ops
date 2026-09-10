#!/usr/bin/env node

// ── Mercari Shop Product Query Script ──────────────────────────────
//
// Fetches Mercari Shop product details via GraphQL.
// Called by the VPS relay in response to POST /admin/mercari-product.
//
// Input (via env vars):
//   MERCARI_SHOP_PRODUCT_ID  — Shop product ID (e.g. "2JS8EKsKW3VHSUbBTGMtcQ")
//   MERCARI_SHOP_LABEL       — Shop label (e.g. "Shop4")
//   MERCARI_TOKENS_PATH      — Path to Mercari API tokens file
//   MERCARI_EXEC_MODE        — "direct" to run curl locally (default from relay)
//
// Output (stdout): JSON
//   { ok: true, product: { title, description, price, category, condition,
//     shippingDuration, shippingMethod, shippingPayer, status, images,
//     listingUrl } }
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

// GraphQL query to fetch a shop product's details (core fields).
// Based on Mercari Shops GraphQL API schema.
const PRODUCT_QUERY = `
query GetProduct($id: String!) {
  product(id: $id) {
    id
    name
    description
    price
    status
    categories { name }
    condition
    shippingDuration
    shippingMethod
    shippingPayer
    imageUrls
    createdAt
    updatedAt
    variants {
      skuCode
    }
  }
}`;


const SHOP_FIELD_RE = /^##\s+(Shop\d+)\s*$/;
const SHOP_TOKEN_RE = /-\s*API token:\s*`([^`]+)`/;

async function main() {
  const shopProductId = String(process.env.MERCARI_SHOP_PRODUCT_ID || "").trim();
  const shopLabel = String(process.env.MERCARI_SHOP_LABEL || "Shop4").trim();
  const tokensPath = String(process.env.MERCARI_TOKENS_PATH || DEFAULT_TOKENS_PATH || "").trim();

  if (!shopProductId) {
    return { ok: false, error: "MERCARI_SHOP_PRODUCT_ID is required" };
  }
  if (!tokensPath) {
    return { ok: false, error: "Mercari tokens file not found" };
  }

  // Load Shop4 API token
  const token = await loadShopToken(tokensPath, shopLabel);
  if (!token) {
    return { ok: false, error: `API token not found for ${shopLabel}` };
  }

  // Execute GraphQL query
  const result = await runGraphQL({
    token,
    query: PRODUCT_QUERY,
    variables: { id: shopProductId },
  });

  if (!result || result.errors) {
    const errMsg = result && result.errors
      ? JSON.stringify(result.errors)
      : "Empty response from Mercari API";
    return { ok: false, error: errMsg };
  }

  const product = result.data && result.data.product;
  if (!product) {
    return { ok: false, error: "Product not found in Mercari response" };
  }

  // Transform to our standard output format
  return {
    ok: true,
    product: {
      title: product.name || "",
      description: product.description || "",
      price: product.price != null ? Number(product.price) : null,
      category: Array.isArray(product.categories)
        ? product.categories.map((c) => c.name).join(" > ")
        : "",
      condition: product.condition || "",
      shippingDuration: product.shippingDuration || "",
      shippingMethod: product.shippingMethod || "",
      shippingPayer: product.shippingPayer || "",
      shippingConfigurationId: product.shippingConfigurationId || "",
      status: product.status || "",
      stockStatus: product.status || "",
      images: Array.isArray(product.imageUrls)
        ? product.imageUrls.map((url, i) => ({
            url: url || "",
            role: i === 0 ? "hero" : `img${i + 1}`,
          }))
        : [],
      listingUrl: "", // Not available via API
      _rawId: product.id || shopProductId,
      // SKU code mapping: SKU1_商品管理コード = Item Code
      variants: Array.isArray(product.variants)
        ? product.variants.map((v) => ({ skuCode: v.skuCode || "" }))
        : [],
    },
  };
}

async function loadShopToken(filePath, shopLabel) {
  const raw = await fsp.readFile(filePath, "utf8");
  let currentLabel = "";
  let currentToken = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(SHOP_FIELD_RE);
    if (labelMatch) {
      if (currentLabel === shopLabel && currentToken) {
        return currentToken;
      }
      currentLabel = labelMatch[1];
      currentToken = "";
      continue;
    }
    const tokenMatch = line.match(SHOP_TOKEN_RE);
    if (tokenMatch && currentLabel === shopLabel) {
      currentToken = tokenMatch[1].trim();
    }
  }
  // Check last entry
  if (currentLabel === shopLabel && currentToken) {
    return currentToken;
  }
  return null;
}

function runGraphQL({ token, query, variables }) {
  const clientName = String(process.env.MERCARI_API_CLIENT_NAME || DEFAULT_API_CLIENT_NAME).trim();
  const clientVersion = String(process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_API_CLIENT_VERSION).trim();
  const payload = JSON.stringify({ query, variables });
  const result = spawnSync(
    "curl",
    [
      "-4",
      "-sS",
      "-X",
      "POST",
      MERCARI_GRAPHQL_URL,
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-H",
      `User-Agent: ${clientName}/${clientVersion}`,
      "--data-binary",
      "@-",
    ],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      input: payload,
    }
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
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })
  .catch((error) => {
    console.log(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
