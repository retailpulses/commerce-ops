#!/usr/bin/env node

// ── Mercari Shop GraphQL Schema Introspection ───────────────────
// Discovers available fields on the Product type.
// Used for POC: finding the SKU1_商品管理コード field.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_TOKENS_PATH = [
  path.join(REPO_ROOT, "knowledge", "Mercari_API_Tokens_Private_2026-04-01.md"),
  path.join(REPO_ROOT, "env", "Mercari_API_Tokens_Private_2026-04-01.md"),
  "/opt/rp-order-mgmt/env/Mercari_API_Tokens_Private_2026-04-01.md",
  "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md",
].find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });

const MERCARI_GRAPHQL_URL = "https://api.mercari-shops.com/v1/graphql";
const SHOP_FIELD_RE = /^##\s+(Shop\d+)\s*$/;
const SHOP_TOKEN_RE = /-\s*API token:\s*`([^`]+)`/;

const INTROSPECTION_QUERY = `
query IntrospectProduct {
  __type(name: "Product") {
    name
    kind
    fields {
      name
      type {
        name
        kind
        ofType {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
  }
}`;

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

  const result = await runGraphQL({ token, query: INTROSPECTION_QUERY, variables: {} });

  if (!result || result.errors) {
    return { ok: false, error: result?.errors ? JSON.stringify(result.errors) : "Empty response" };
  }

  const fields = result.data?.__type?.fields || [];

  // Also try to find any type that has "sku" or "management" in its name
  return {
    ok: true,
    productFields: fields.map(f => ({
      name: f.name,
      type: f.type?.name || f.type?.ofType?.name || f.type?.ofType?.ofType?.name || "unknown"
    })),
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
  const payload = JSON.stringify({ query, variables });
  const result = spawnSync("curl", [
    "-4", "-sS", "-X", "POST", MERCARI_GRAPHQL_URL,
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-Type: application/json",
    "--data-binary", "@-",
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, input: payload });
  if (result.status !== 0) {
    throw new Error(`Mercari request failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return JSON.parse(String(result.stdout || "").trim());
}

main()
  .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); })
  .catch((error) => { console.log(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exit(1); });
