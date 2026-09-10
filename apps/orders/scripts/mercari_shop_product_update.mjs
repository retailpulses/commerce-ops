#!/usr/bin/env node

// ── Mercari Shop Product Update Script ────────────────────────────
//
// Updates a Mercari Shop product's title, description, and/or price
// via GraphQL mutation. Called by the VPS relay in response to
// POST /admin/mercari-product-update.
//
// Input (via env vars):
//   MERCARI_SHOP_PRODUCT_ID  — Shop product ID (e.g. "2JS8EKsKW3VHSUbBTGMtcQ")
//   MERCARI_SHOP_LABEL       — Shop label (e.g. "Shop4")
//   MERCARI_TOKENS_PATH      — Path to Mercari API tokens file
//   MERCARI_EXEC_MODE        — "direct" to run curl locally (default from relay)
//   MERCARI_PRODUCT_INPUT    — JSON-encoded update payload: { title?, description?, price? }
//
// Output (stdout): JSON
//   { ok: true, product: { id, name, description, price, status } }
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

// GraphQL mutation to update a shop product's details.
// See catalog-sync/scripts/mercari/sync_mercari_pricing_up.py for reference.
const PRODUCT_UPDATE_MUTATION = `
mutation updateProduct($input: UpdateProductInput!) {
  updateProduct(input: $input) {
    product {
      id
      name
      description
      price
      status
      imageUrls
    }
  }
}`;

const SHOP_FIELD_RE = /^##\s+(Shop\d+)\s*$/;
const SHOP_TOKEN_RE = /-\s*API token:\s*`([^`]+)`/;

async function main() {
  const shopProductId = String(process.env.MERCARI_SHOP_PRODUCT_ID || "").trim();
  const shopLabel = String(process.env.MERCARI_SHOP_LABEL || "Shop4").trim();
  const tokensPath = String(process.env.MERCARI_TOKENS_PATH || DEFAULT_TOKENS_PATH || "").trim();
  const productInputRaw = String(process.env.MERCARI_PRODUCT_INPUT || "{}").trim();

  if (!shopProductId) {
    return { ok: false, error: "MERCARI_SHOP_PRODUCT_ID is required" };
  }
  if (!tokensPath) {
    return { ok: false, error: "Mercari tokens file not found" };
  }

  // Parse the product input
  let productInput;
  try {
    productInput = JSON.parse(productInputRaw);
  } catch {
    return { ok: false, error: "MERCARI_PRODUCT_INPUT is not valid JSON" };
  }

  if (!productInput.title && !productInput.description && !productInput.price && !productInput.imageUrls) {
    return { ok: false, error: "At least one of title, description, price, or imageUrls is required" };
  }

  // Build the mutation variables
  // Note: input.id is the Mercari Shop product ID (not "productId")
  const variables = {
    input: {
      id: shopProductId,
    },
  };
  if (productInput.title) variables.input.name = productInput.title;
  if (productInput.description) variables.input.description = productInput.description;
  if (productInput.price != null) variables.input.price = Number(productInput.price);
  if (productInput.imageUrls) variables.input.imageUrls = productInput.imageUrls;

  // Load shop API token
  const token = await loadShopToken(tokensPath, shopLabel);
  if (!token) {
    return { ok: false, error: `API token not found for ${shopLabel}` };
  }

  // Execute GraphQL mutation
  const result = await runGraphQL({
    token,
    query: PRODUCT_UPDATE_MUTATION,
    variables,
  });

  if (!result || result.errors) {
    const errMsg = result && result.errors
      ? JSON.stringify(result.errors)
      : "Empty response from Mercari API";
    return { ok: false, error: errMsg };
  }

  const product = result.data && result.data.updateProduct && result.data.updateProduct.product;
  if (!product) {
    // Check for GraphQL errors in the mutation response
    const errors = result.data && result.data.updateProduct && result.data.updateProduct.errors;
    if (errors && errors.length > 0) {
      return { ok: false, error: errors.map((e) => e.message).join("; ") };
    }
    return { ok: false, error: "Product not found in Mercari mutation response" };
  }

  return {
    ok: true,
    product: {
      id: product.id || shopProductId,
      name: product.name || "",
      description: product.description || "",
      price: product.price != null ? Number(product.price) : null,
      status: product.status || "",
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
