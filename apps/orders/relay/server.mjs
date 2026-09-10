import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRakutenShippingUpdate } from "../src/lib/rakuten-relay.mjs";
import { createRakutenInquiryClient } from "../src/lib/rakuten-inquiry-relay.mjs";
import { requireRelaySecret as requireScopedRelaySecret } from "./relay-auth.mjs";

const PORT = parseInteger(process.env.PORT, 8787);
const HOST = String(process.env.HOST || "0.0.0.0").trim();
const RELAY_SECRET = String(process.env.MERCARI_RELAY_SECRET || "").trim();
const RAKUTEN_INGESTION_RELAY_SECRET = String(process.env.RAKUTEN_RMESSE_INGESTION_RELAY_SECRET || "").trim();
const RAKUTEN_SEND_RELAY_SECRET = String(process.env.RAKUTEN_RMESSE_SEND_RELAY_SECRET || "").trim();
const DEFAULT_EGRESS_IP = "160.251.141.110";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTAKE_SCRIPT = process.env.MERCARI_INGEST_SCRIPT_PATH
  || path.resolve(MODULE_DIR, "../scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs");
const SUPABASE_BRIDGE_SCRIPT = process.env.SUPABASE_BRIDGE_SCRIPT_PATH
  || path.resolve(MODULE_DIR, "../scripts/migrate-to-supabase.mjs");
const SHIPPING_CLOSE_BATCH_SCRIPT = process.env.MERCARI_SHIPPING_CLOSE_BATCH_SCRIPT_PATH
  || path.resolve(MODULE_DIR, "../scripts/close_all_shipped_orders.mjs");
const PRODUCT_QUERY_SCRIPT = process.env.MERCARI_PRODUCT_QUERY_SCRIPT_PATH
  || path.resolve(MODULE_DIR, "../scripts/mercari_shop_product_query.mjs");
const PRODUCT_UPDATE_SCRIPT = process.env.MERCARI_PRODUCT_UPDATE_SCRIPT_PATH
  || path.resolve(MODULE_DIR, "../scripts/mercari_shop_product_update.mjs");
const PRODUCTS_LIST_SCRIPT = process.env.MERCARI_PRODUCTS_LIST_SCRIPT_PATH
  || path.resolve(MODULE_DIR, "../scripts/list_shop4_products.mjs");

// Rakuten RMS API config
const RAKUTEN_RMS_BASE = String(
  process.env.RAKUTEN_RMS_BASE || "https://api.rms.rakuten.co.jp/es/2.0"
).trim();
const RAKUTEN_SERVICE_SECRET = String(process.env.RAKUTEN_SERVICE_SECRET || "").trim();
const RAKUTEN_LICENSE_KEY = String(process.env.RAKUTEN_LICENSE_KEY || "").trim();
const rakutenInquiryClient = RAKUTEN_SERVICE_SECRET && RAKUTEN_LICENSE_KEY
  ? createRakutenInquiryClient({ serviceSecret: RAKUTEN_SERVICE_SECRET, licenseKey: RAKUTEN_LICENSE_KEY })
  : null;

// Rate limiting — Rakuten RMS enforces strict QPS limits (GA0003).
// Python RakutenAPIClient uses 0.5s delay; we match that here.
const RMS_RATE_LIMIT_MS = 600; // ms between consecutive RMS API calls
let _rmsLastCallTime = 0;

// Cache for rmsSearchAllItems() — avoid repeated full-catalog scans.
// The shop has ~10 items so cache is small. TTL: 5 minutes.
let _rmsAllItemsCache = null;
let _rmsAllItemsCacheTime = 0;
const RMS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Rate-limit helper: waits until enough time has passed since last RMS call. */
async function rmsRateLimit() {
  const now = Date.now();
  const elapsed = now - _rmsLastCallTime;
  if (elapsed < RMS_RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RMS_RATE_LIMIT_MS - elapsed));
  }
  _rmsLastCallTime = Date.now();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const egressIp = await getEgressIp();
      const health = {
        ok: true,
        service: "rp-order-mgmt-relay",
        egress_ip: egressIp,
        expected_egress_ip: DEFAULT_EGRESS_IP,
        checks: {},
      };

      // Verify token file is readable (catches missing-secret regressions)
      const tokensPath = String(process.env.MERCARI_TOKENS_PATH || "").trim();
      if (tokensPath) {
        try {
          await fs.access(tokensPath, fs.constants.R_OK);
          health.checks.tokens = { ok: true, path: tokensPath };
        } catch (e) {
          health.checks.tokens = { ok: false, path: tokensPath, error: e.code || "ENOENT" };
        }
      } else {
        health.checks.tokens = { ok: false, path: null, error: "MERCARI_TOKENS_PATH not set" };
      }

      health.checks.rakuten_inquiry_auth = {
        ok: Boolean(RAKUTEN_INGESTION_RELAY_SECRET && RAKUTEN_SEND_RELAY_SECRET),
        ingestion_configured: Boolean(RAKUTEN_INGESTION_RELAY_SECRET),
        send_configured: Boolean(RAKUTEN_SEND_RELAY_SECRET),
      };

      // Degrade health if token file is missing
      if (!health.checks.tokens?.ok || !health.checks.rakuten_inquiry_auth.ok) {
        health.ok = false;
        health.error = !health.checks.tokens?.ok
          ? "token_file_unreadable"
          : "rakuten_inquiry_auth_not_configured";
      }

      return sendJson(res, health.ok ? 200 : 503, health);
    }

    if (req.method === "POST" && url.pathname === "/admin/ingest") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const summary = await runIngest(body || {});
      console.log(JSON.stringify({
        event: "ingest_completed",
        state: summary.state,
        dryRun: body.dryRun === true,
        shops: normalizeShops(body.shops).join(",") || "all",
        limit: body.limit === null ? 0 : parseInteger(body.limit, parseInteger(process.env.ORDER_MGMT_LIMIT, 100)),
        counts: summary.counts,
      }));
      return sendJson(res, summary.ok ? 200 : 500, summary);
    }

    if (req.method === "POST" && url.pathname === "/admin/close-shipped-orders") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const summary = await runShippingCloseBatch(body || {});
      console.log(JSON.stringify({
        event: "close_shipped_orders_completed",
        state: summary.state,
        dryRun: body.dryRun === true,
        shops: normalizeShops(body.shops).join(",") || "all",
        counts: summary.counts,
      }));
      return sendJson(res, summary.ok ? 200 : 500, summary);
    }

    if (req.method === "POST" && url.pathname === "/admin/mercari-product") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const summary = await runProductQuery(body || {});
      return sendJson(res, summary.ok ? 200 : 500, summary);
    }

    if (req.method === "POST" && url.pathname === "/admin/mercari-product-update") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const summary = await runProductUpdate(body || {});
      return sendJson(res, summary.ok ? 200 : 500, summary);
    }

    if (req.method === "POST" && url.pathname === "/admin/mercari-products-list") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const summary = await runProductsList(body || {});
      return sendJson(res, summary.ok ? 200 : 500, summary);
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-product") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await runRakutenProductQuery(body || {});
      // Use 500 for errors (matching Mercari pattern) — avoid 502 which CF Tunnel intercepts
      const status = result.ok ? 200 : 500;
      return sendJson(res, status, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-ingest") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await runRakutenIngest(body || {});
      const status = result.ok ? 200 : 500;
      return sendJson(res, status, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-confirm") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await runRakutenConfirm(body || {});
      const status = result.ok ? 200 : 500;
      return sendJson(res, status, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-close") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await runRakutenClose(body || {});
      const status = result.ok ? 200 : 500;
      return sendJson(res, status, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-inquiries") {
      requireRakutenIngestionRelaySecret(req);
      const body = await readJson(req);
      if (!rakutenInquiryClient) throw new Error("rakuten_rms_credentials_missing");
      await rmsRateLimit();
      const result = await rakutenInquiryClient.listInquiries(body || {});
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-inquiry") {
      requireRakutenIngestionRelaySecret(req);
      const body = await readJson(req);
      if (!rakutenInquiryClient) throw new Error("rakuten_rms_credentials_missing");
      await rmsRateLimit();
      const result = await rakutenInquiryClient.getInquiry(body?.inquiryNumber);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-inquiry-attachment") {
      requireRakutenIngestionRelaySecret(req);
      const body = await readJson(req);
      if (!rakutenInquiryClient) throw new Error("rakuten_rms_credentials_missing");
      await rmsRateLimit();
      const result = await rakutenInquiryClient.downloadAttachment(body || {});
      if (result.bytes.byteLength > 20 * 1024 * 1024) {
        throw new Error("rakuten_inquiry_attachment_too_large");
      }
      res.writeHead(200, {
        "content-type": result.contentType,
        "content-length": String(result.bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      return res.end(result.bytes);
    }

    if (req.method === "POST" && url.pathname === "/admin/rakuten-inquiry-reply") {
      requireRakutenSendRelaySecret(req);
      const body = await readJson(req);
      if (!rakutenInquiryClient) throw new Error("rakuten_rms_credentials_missing");
      await rmsRateLimit();
      const result = await rakutenInquiryClient.reply(body || {});
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/admin/order-messages") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await fetchOrderMessages(body || {});
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/order-statuses") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await fetchOrderStatuses(body || {});
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/order-reply") {
      requireRelaySecret(req);
      const body = await readJson(req);
      const result = await sendOrderReply(body || {});
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    return sendJson(res, 200, {
      ok: true,
      service: "rp-order-mgmt-relay",
      endpoints: ["/health", "/admin/ingest", "/admin/close-shipped-orders", "/admin/mercari-product", "/admin/mercari-product-update", "/admin/mercari-products-list", "/admin/rakuten-product", "/admin/rakuten-ingest", "/admin/rakuten-confirm", "/admin/rakuten-close", "/admin/rakuten-inquiries", "/admin/rakuten-inquiry", "/admin/rakuten-inquiry-attachment", "/admin/rakuten-inquiry-reply", "/admin/order-messages", "/admin/order-reply"],
    });
  } catch (error) {
    const status = error && error.message === "unauthorized"
      ? 401
      : error && error.message === "relay_secret_not_configured" ? 503 : 500;
    if (url.pathname.startsWith("/admin/rakuten-inquiry")) {
      console.error(JSON.stringify({
        event: "rakuten_inquiry_relay_error",
        endpoint: url.pathname,
        error_code: error && error.message ? error.message : "unknown",
        upstream_status: Number.isInteger(error?.status) ? error.status : null,
      }));
    }
    return sendJson(res, status, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    ok: true,
    service: "rp-order-mgmt-relay",
    host: HOST,
    port: PORT,
    ingest_script: INTAKE_SCRIPT,
  }));
});

async function runIngest(body) {
  const statuses = normalizeStatuses(body.statuses || body.statusesCsv || process.env.MERCARI_ORDER_STATUSES || "");
  const shops = normalizeShops(body.shops);
  const env = {
    ...process.env,
    MERCARI_SHOPS: shops.length ? shops.join(",") : String(process.env.MERCARI_SHOPS || "").trim(),
    ORDER_MGMT_LIMIT: String(body.limit === null ? 0 : parseInteger(body.limit, parseInteger(process.env.ORDER_MGMT_LIMIT, 100))),
    MERCARI_ORDER_STATUSES: statuses.length ? statuses.join(",") : String(process.env.MERCARI_ORDER_STATUSES || "").trim(),
    MERCARI_SHIPPING_DRY_RUN: body.dryRun === true ? "1" : "",
    MERCARI_BASEROW_ENV_PATH: String(process.env.MERCARI_BASEROW_ENV_PATH || "").trim(),
    MERCARI_TOKENS_PATH: String(process.env.MERCARI_TOKENS_PATH || "").trim(),
    MERCARI_EXEC_MODE: "direct",
    DATABASE_BACKEND: "supabase",
  };

  const args = body.dryRun === true ? ["--dry-run"] : [];
  if (statuses.length) {
    args.push("--statuses", statuses.join(","));
  }
  const result = await runNodeScript(INTAKE_SCRIPT, args, env);
  let supabaseBridge = null;
  // Bridge: copies Baserow -> Supabase. Preserved for rollback.
  // To disable: set SUPABASE_INGEST_BRIDGE_ENABLED=false in relay environment.
  // Remove entirely only after 2+ successful direct Supabase ingest cycles.
  const bridgeEnabled = String(process.env.SUPABASE_INGEST_BRIDGE_ENABLED || "").trim().toLowerCase() === "true";
  if (result.code === 0 && body.dryRun !== true && bridgeEnabled) {
    const bridgeResult = await runNodeScript(SUPABASE_BRIDGE_SCRIPT, [
      "--tables=sales_orders",
      "--dry-run=false",
      "--confirm",
      "--non-interactive",
      "--limit=0",
      "--propagate-terminal-statuses",
    ], env);
    supabaseBridge = {
      ok: bridgeResult.code === 0,
      status: bridgeResult.code,
      stderr: bridgeResult.stderr,
    };
  }
  const ok = result.code === 0 && result.parsed && result.parsed.ok !== false && (!supabaseBridge || supabaseBridge.ok);
  return {
    ok,
    state: ok ? "completed" : "failed",
    mode: "ingest",
    status: result.code,
    counts: ingestCounts(result.parsed),
    requested_statuses: statuses,
    stdout: result.parsed,
    stderr: result.stderr,
    supabase_bridge: supabaseBridge,
  };
}

async function runShippingCloseBatch(body) {
  const shops = normalizeShops(body.shops);
  const env = {
    ...process.env,
    MERCARI_SHOPS: shops.length ? shops.join(",") : String(process.env.MERCARI_SHOPS || "").trim(),
    ORDER_MGMT_LIMIT: String(body.limit === null ? 0 : parseInteger(body.limit, parseInteger(process.env.ORDER_MGMT_LIMIT, 100))),
    MERCARI_SHIPPING_DRY_RUN: body.dryRun === true ? "1" : "",
    MERCARI_BASEROW_ENV_PATH: String(process.env.MERCARI_BASEROW_ENV_PATH || "").trim(),
    MERCARI_TOKENS_PATH: String(process.env.MERCARI_TOKENS_PATH || "").trim(),
    MERCARI_EXEC_MODE: "direct",
  };
  const args = [];
  if (body.dryRun === true) args.push("--dry-run");
  if (body.limit != null && String(body.limit).trim() !== "") {
    args.push("--limit", String(parseInteger(body.limit, parseInteger(process.env.ORDER_MGMT_LIMIT, 100))));
  }
  if (shops.length) {
    args.push("--shops", shops.join(","));
  }
  const result = await runNodeScript(SHIPPING_CLOSE_BATCH_SCRIPT, args, env);
  const counts = closeCounts(result.parsed);
  const ok = result.code === 0 && result.parsed && result.parsed.ok !== false && counts.failed === 0;
  return {
    ok,
    state: ok ? "completed" : "failed",
    mode: "shipping-close-batch",
    status: result.code,
    counts,
    stdout: result.parsed,
    stderr: result.stderr,
  };
}

function ingestCounts(summary) {
  const totals = summary && typeof summary.totals === "object" ? summary.totals : {};
  return {
    candidates: Number(totals.transactions) || 0,
    processed: (Number(totals.created) || 0) + (Number(totals.updated) || 0) + (Number(totals.unchanged) || 0),
    skipped: Number(totals.skipped) || 0,
    failed: Number(totals.failed) || 0,
  };
}

function closeCounts(summary) {
  return {
    candidates: Number(summary && summary.candidates) || 0,
    processed: Number(summary && summary.processed) || 0,
    skipped: Number(summary && summary.skipped) || 0,
    failed: (Number(summary && summary.failed) || 0) + (Number(summary && summary.backfill_failed) || 0),
  };
}

async function runProductUpdate(body) {
  const shopProductId = String(body.shopProductId || "").trim();
  const shopLabel = String(body.shopLabel || "Shop4").trim();
  const productInput = body.productInput || {};

  if (!shopProductId) {
    return { ok: false, error: "shopProductId is required" };
  }

  const env = {
    ...process.env,
    MERCARI_SHOP_PRODUCT_ID: shopProductId,
    MERCARI_SHOP_LABEL: shopLabel,
    MERCARI_PRODUCT_INPUT: JSON.stringify(productInput),
    MERCARI_TOKENS_PATH: String(process.env.MERCARI_TOKENS_PATH || "").trim(),
    MERCARI_EXEC_MODE: "direct",
  };

  const result = await runNodeScript(PRODUCT_UPDATE_SCRIPT, [], env);
  return {
    ok: result.code === 0 && result.parsed && result.parsed.ok === true,
    mode: "mercari-product-update",
    status: result.code,
    product: result.parsed && result.parsed.ok ? result.parsed.product : null,
    error: result.parsed && result.parsed.error ? result.parsed.error : (result.stderr ? result.stderr.slice(0, 500) : null),
    stderr: result.stderr,
  };
}

async function runProductQuery(body) {
  const shopProductId = String(body.shopProductId || "").trim();
  const shopLabel = String(body.shopLabel || "Shop4").trim();

  if (!shopProductId) {
    return { ok: false, error: "shopProductId is required" };
  }

  const env = {
    ...process.env,
    MERCARI_SHOP_PRODUCT_ID: shopProductId,
    MERCARI_SHOP_LABEL: shopLabel,
    MERCARI_TOKENS_PATH: String(process.env.MERCARI_TOKENS_PATH || "").trim(),
    MERCARI_EXEC_MODE: "direct",
  };

  const result = await runNodeScript(PRODUCT_QUERY_SCRIPT, [], env);
  return {
    ok: result.code === 0 && result.parsed && result.parsed.ok === true,
    mode: "mercari-product",
    status: result.code,
    product: result.parsed && result.parsed.ok ? result.parsed.product : null,
    error: result.parsed && result.parsed.error ? result.parsed.error : null,
    stderr: result.stderr,
  };
}

async function runProductsList(body) {
  const shopLabel = String(body.shopLabel || "Shop4").trim();
  const env = {
    ...process.env,
    MERCARI_SHOP_LABEL: shopLabel,
    MERCARI_TOKENS_PATH: String(process.env.MERCARI_TOKENS_PATH || "").trim(),
    MERCARI_EXEC_MODE: "direct",
  };
  const result = await runNodeScript(PRODUCTS_LIST_SCRIPT, [], env);
  return {
    ok: result.code === 0 && result.parsed && result.parsed.ok === true,
    mode: "mercari-products-list",
    status: result.code,
    totalCount: result.parsed?.totalCount || 0,
    pages: result.parsed?.pages || 0,
    products: result.parsed?.products || [],
    error: result.parsed?.error || (result.stderr ? result.stderr.slice(0, 500) : null),
    stderr: result.stderr,
  };
}

// ── Rakuten RMS API ────────────────────────────────────────

/**
 * Query a Rakuten listing by manage number or item code via RMS es/2.0 API.
 * Body: { manageNumber?, itemCode?, shopLabel? }
 *
 * Priority:
 * 1. manageNumber — direct RMS search (fast, exact match)
 * 2. itemCode — fetch all RMS items, match by product code segment (fallback)
 *
 * Returns: { ok, found, item? } or { ok: false, error }
 */
async function runRakutenProductQuery(body) {
  const manageNumber = String(body.manageNumber || "").trim();
  const itemCode = String(body.itemCode || "").trim();

  if (!manageNumber && !itemCode) {
    return { ok: false, found: false, error: "manageNumber or itemCode is required" };
  }

  if (!RAKUTEN_SERVICE_SECRET || !RAKUTEN_LICENSE_KEY) {
    console.warn("Rakuten RMS credentials not configured on relay");
    return {
      ok: false,
      found: false,
      error: "Rakuten RMS credentials not configured on relay",
    };
  }

  try {
    // ── Priority 1: Direct manageNumber lookup ────────────
    if (manageNumber) {
      const item = await rmsGetItem(manageNumber);
      if (item) {
        console.log(JSON.stringify({
          event: "rakuten_product_fetched",
          by: "manageNumber",
          manageNumber,
          itemName: item.itemName || item.title || "(empty)",
          status: item.status || "(unknown)",
          variantCount: (item.variants || []).length,
        }));
        return { ok: true, found: true, item, _matchedBy: "manageNumber" };
      }
    }

    // ── Priority 2: Item code fuzzy match ─────────────────
    if (itemCode) {
      const matched = await rmsMatchByItemCode(itemCode);
      if (matched) {
        console.log(JSON.stringify({
          event: "rakuten_product_fetched",
          by: "itemCode",
          itemCode,
          manageNumber: matched.manageNumber,
          itemName: matched.itemName || matched.title || "(empty)",
          status: matched.status || "(unknown)",
        }));
        return { ok: true, found: true, item: matched, _matchedBy: "itemCode" };
      }
    }

    // Not found by either method
    return { ok: true, found: false, item: null };
  } catch (err) {
    console.error(JSON.stringify({
      event: "rakuten_product_error",
      manageNumber,
      itemCode,
      error: err.message,
    }));
    return { ok: false, found: false, error: err.message };
  }
}

/**
 * Look up a Rakuten item by manage number via the search endpoint.
 * GET /es/2.0/items/search?manageNumber={manageNumber}
 *
 * NOTE: The /items/manage-numbers/{manageNumber} single-item endpoint
 * returns 401 for all requests (likely deprecated/broken in es/2.0).
 * The search endpoint with a manageNumber query param is the working
 * alternative — confirmed via OpenCode investigation 2026-06-07.
 *
 * Returns the parsed item JSON on 200, null if not found, throws on errors.
 * Auth: ESA base64(serviceSecret:licenseKey) — same as Python RakutenAPIClient.
 */
function rmsGetItem(manageNumber) {
  return rmsRateLimit().then(() => new Promise((resolve, reject) => {
    const token = Buffer.from(
      `${RAKUTEN_SERVICE_SECRET}:${RAKUTEN_LICENSE_KEY}`
    ).toString("base64");

    const req = https.request(
      `${RAKUTEN_RMS_BASE}/items/search?manageNumber=${encodeURIComponent(manageNumber)}`,
      {
        method: "GET",
        headers: {
          Authorization: `ESA ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        timeout: 30000,
      },
      (res) => {
        res.setEncoding("utf8");
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const payload = JSON.parse(data);
              const results = payload.results || [];
              // Search response wraps each item: { results: [{ item: {...} }] }
              if (results.length > 0 && results[0].item) {
                resolve(results[0].item);
              } else {
                resolve(null); // No results — manage number not found
              }
            } catch (e) {
              reject(new Error(`RMS parse error: ${e.message}`));
            }
          } else {
            reject(
              new Error(
                `RMS API returned ${res.statusCode}: ${data.slice(0, 200)}`
              )
            );
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("RMS API request timed out after 30s"));
    });

    req.end();
  }));
}

/**
 * Match a Baserow item code against RMS manage numbers by extracting
 * the product code segment from each RMS manage number and comparing it
 * case-insensitively against the item code.
 *
 * RMS manage number format: {category}-{productCode}
 *   e.g. "chair-w3562p454" → product code = "w3562p454"
 *   e.g. "stool-n504s406006" → product code = "n504s406006"
 *
 * Baserow item code format: {ProductCode}{Suffix}
 *   e.g. "W3562P454561" → contains product code "W3562P454"
 *   e.g. "N504S406006A" → contains product code "N504S406006"
 *
 * Match: RMS product code (lowercase) is a case-insensitive substring
 *        of the Baserow item code.
 *
 * Only 10 RMS items in this shop — no pagination needed.
 */
async function rmsMatchByItemCode(itemCode) {
  // Fetch all RMS items
  const allItems = await rmsSearchAllItems();
  const upperItemCode = itemCode.toUpperCase();

  for (const item of allItems) {
    const mn = (item.manageNumber || "").toLowerCase();
    // Extract product code: everything after the last dash
    const dashIdx = mn.lastIndexOf("-");
    const productCode = dashIdx >= 0 ? mn.slice(dashIdx + 1) : mn;

    // Match: RMS product code is contained within Baserow item code (case-insensitive)
    if (productCode && upperItemCode.toUpperCase().includes(productCode.toUpperCase())) {
      return item;
    }
  }

  return null;
}

/**
 * Fetch all Rakuten items via paginated search.
 * Returns flat array of item objects (not wrapped in {item: {...}}).
 * Results are cached for RMS_CACHE_TTL_MS to avoid rate limiting.
 */
function rmsSearchAllItems() {
  // Check cache
  const now = Date.now();
  if (_rmsAllItemsCache && (now - _rmsAllItemsCacheTime) < RMS_CACHE_TTL_MS) {
    return Promise.resolve(_rmsAllItemsCache);
  }

  return rmsRateLimit().then(() => new Promise((resolve, reject) => {
    const token = Buffer.from(
      `${RAKUTEN_SERVICE_SECRET}:${RAKUTEN_LICENSE_KEY}`
    ).toString("base64");

    const allItems = [];
    let offset = 0;

    function fetchPage() {
      const req = https.request(
        `${RAKUTEN_RMS_BASE}/items/search?offset=${offset}&size=100`,
        {
          method: "GET",
          headers: {
            Authorization: `ESA ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          timeout: 30000,
        },
        (res) => {
          res.setEncoding("utf8");
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const payload = JSON.parse(data);
                const results = payload.results || [];
                for (const r of results) {
                  if (r.item) allItems.push(r.item);
                }
                offset += results.length;
                if (results.length > 0 && offset < (payload.numFound || 0)) {
                  rmsRateLimit().then(fetchPage); // next page (rate-limited)
                } else {
                  // Update cache
                  _rmsAllItemsCache = allItems;
                  _rmsAllItemsCacheTime = Date.now();
                  resolve(allItems);
                }
              } catch (e) {
                reject(new Error(`RMS parse error: ${e.message}`));
              }
            } else {
              reject(new Error(`RMS search failed ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("RMS search timed out"));
      });
      req.end();
    }

    fetchPage();
  }));
}

// ── Rakuten Order API ───────────────────────────────────────

/**
 * Search Rakuten orders via RMS REST API (two-step).
 *
 * Step 1 — POST /es/2.0/order/searchOrder
 *   Returns order NUMBER list (not full objects).  Accepts date range and
 *   optional status filter.
 *
 * Step 2 — POST /es/2.0/order/getOrder (version=7)
 *   Accepts orderNumberList and returns full OrderModel objects.
 *
 * Body: { startDate?, endDate?, status?, orderNumber?, limit? }
 * Returns: { ok, orders: OrderModel[], count: N }
 */
async function runRakutenIngest(body) {
  if (!RAKUTEN_SERVICE_SECRET || !RAKUTEN_LICENSE_KEY) {
    return { ok: false, error: "Rakuten RMS credentials not configured on relay" };
  }

  // ── Step 1: Search for order numbers ──────────────────────────────
  let orderNumbers = [];

  if (body.orderNumber) {
    // Direct lookup — skip search, use provided order number(s)
    orderNumbers = Array.isArray(body.orderNumber)
      ? body.orderNumber.map((s) => String(s).trim()).filter(Boolean)
      : [String(body.orderNumber).trim()].filter(Boolean);
  } else {
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const startDate = body.startDate || toRmsDatetime(defaultStart);
    const endDate = body.endDate || toRmsDatetime(now);

    const searchBody = {
      dateType: 1, // 1 = order date (受注日)
      startDatetime: startDate,
      endDatetime: endDate,
    };
    const status = String(body.status || "").trim();
    if (status) searchBody.status = status;
    const limit = parseInteger(body.limit, 0);
    if (limit > 0) searchBody.limit = limit;

    try {
      const searchResult = await rmsPostJson("/order/searchOrder", searchBody);
      const nums = Array.isArray(searchResult.orderNumberList) ? searchResult.orderNumberList : [];
      orderNumbers = nums.map((s) => String(s).trim()).filter(Boolean);
    } catch (err) {
      console.error(JSON.stringify({
        event: "rakuten_search_error",
        error: err.message,
      }));
      return { ok: false, error: err.message };
    }
  }

  if (orderNumbers.length === 0) {
    return { ok: true, count: 0, totalCount: 0, orders: [] };
  }

  // ── Step 2: Fetch full order details ───────────────────────────────
  try {
    const getResult = await rmsPostJson("/order/getOrder", {
      // Version 7 exposes ItemModel.SkuModelList with the exact SKU selected
      // by the buyer (variantId, merchantDefinedSkuId, and skuInfo).
      version: 7,
      orderNumberList: orderNumbers,
    });
    const orders = Array.isArray(getResult.OrderModelList)
      ? getResult.OrderModelList
      : [];
    return {
      ok: true,
      count: orders.length,
      totalCount: orders.length,
      orders,
    };
  } catch (err) {
    console.error(JSON.stringify({
      event: "rakuten_getorder_error",
      orderNumbers,
      error: err.message,
    }));
    return { ok: false, error: err.message, orderNumbers };
  }
}

/**
 * Confirm Rakuten orders on RMS.
 * Calls POST /es/2.0/order/confirmOrder with orderNumberList.
 *
 * Body: { orderNumberList: string[] }
 * Returns: { ok, confirmed: [], failed: [] }
 */
async function runRakutenConfirm(body) {
  if (!RAKUTEN_SERVICE_SECRET || !RAKUTEN_LICENSE_KEY) {
    return { ok: false, error: "Rakuten RMS credentials not configured on relay" };
  }

  const orderNumberList = Array.isArray(body.orderNumberList)
    ? body.orderNumberList.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (orderNumberList.length === 0) {
    return { ok: false, error: "orderNumberList is required" };
  }

  try {
    const result = await rmsPostJson("/order/confirmOrder", { orderNumberList });
    return {
      ok: true,
      confirmed: orderNumberList,
      result,
    };
  } catch (err) {
    console.error(JSON.stringify({
      event: "rakuten_confirm_error",
      orderNumberList,
      error: err.message,
    }));
    return { ok: false, error: err.message, failed: orderNumberList };
  }
}

/**
 * Close (mark as shipped) a Rakuten order on RMS.
 *
 * Two-step process (verified against RMS es/2.0 API 2026-07-17):
 *   1. GET /order/getOrder (version=7) → resolve every basket and existing detail
 *   2. POST /order/updateOrderShipping/ → register/update tracking + carrier + ship date
 *
 * Carrier names are mapped to RMS delivery-company codes (see mapCarrierToRmsCode).
 *
 * Body: { orderNumber, trackingNo, carrier, shippingDate? }
 * Returns: { ok, orderNumber, targets, rmsMessages, result }
 *
 * Reference: JakeJP/Rakuten.RMS.Api (MIT-licensed C# client library)
 *   - RakutenPayOrderService.UpdateOrderShipping
 *   - BasketidModel / ShippingModel
 */
async function runRakutenClose(body) {
  if (!RAKUTEN_SERVICE_SECRET || !RAKUTEN_LICENSE_KEY) {
    return { ok: false, error: "Rakuten RMS credentials not configured on relay" };
  }

  const orderNumber = String(body.orderNumber || "").trim();
  if (!orderNumber) {
    return { ok: false, error: "orderNumber is required" };
  }

  const trackingNo = String(body.trackingNo || "").trim();
  if (!trackingNo) {
    return { ok: false, error: "trackingNo is required" };
  }

  const carrier = String(body.carrier || "").trim();
  const rmsCarrierCode = mapCarrierToRmsCode(carrier);
  const shippingDate = String(body.shippingDate || "").trim();

  try {
    // ── Step 1: Get order to resolve basketId ──────────────────────
    const orderResult = await rmsPostJson("/order/getOrder", {
      orderNumberList: [orderNumber],
      version: 7,
    });

    const order = (orderResult.OrderModelList || [])[0];
    if (!order) {
      return { ok: false, error: "order not found on RMS", orderNumber };
    }

    const update = buildRakutenShippingUpdate(order, {
      orderNumber,
      trackingNo,
      deliveryCompany: rmsCarrierCode,
      shippingDate,
    });
    if (!update.ok) {
      return { ok: false, error: update.error, orderNumber, basketId: update.basketId ?? null };
    }

    // ── Step 2: Register/update shipping info ───────────────────────
    const result = await rmsPostJson("/order/updateOrderShipping/", update.body);
    const rmsMessages = Array.isArray(result?.MessageModelList)
      ? result.MessageModelList
      : Array.isArray(result?.messageModelList) ? result.messageModelList : [];

    console.log(JSON.stringify({
      event: "rakuten_close_order",
      orderNumber,
      targets: update.targets,
      trackingNo,
      carrierCode: rmsCarrierCode,
      ok: true,
    }));

    return {
      ok: true,
      orderNumber,
      targets: update.targets,
      rmsMessages,
      result,
    };
  } catch (err) {
    console.error(JSON.stringify({
      event: "rakuten_close_error",
      orderNumber,
      error: err.message,
    }));
    return { ok: false, error: err.message, orderNumber };
  }
}

/**
 * Map a carrier name string to a Rakuten RMS delivery-company code.
 *
 * Reference codes (Rakuten RMS es/2.0 convention):
 *   1001 = Yamato Transport (ヤマト運輸)
 *   1002 = Sagawa Express (佐川急便)
 *   1003 = Japan Post (日本郵便)
 *   1004 = Seino Transportation (西濃運輸)
 *   1005 = Fukuyama Transportation (福山通運)
 *
 * If the name is already a numeric code, return it as-is.
 * Unrecognized carriers default to "1002" (Sagawa) with a warning.
 *
 * @param {string} carrierName
 * @returns {string} RMS carrier code
 */
function mapCarrierToRmsCode(carrierName) {
  const name = (carrierName || "").trim().toLowerCase();
  if (!name) return "1002";

  // Already a numeric code
  if (/^\d+$/.test(name)) return name;

  if (name.includes("yamato") || name.includes("ヤマト") || name.includes("宅急便")) return "1001";
  if (name.includes("sagawa") || name.includes("佐川")) return "1002";
  if (name.includes("japan") || name.includes("日本郵便") || name.includes("郵便") || name.includes("ゆうパック")) return "1003";
  if (name.includes("seino") || name.includes("西濃")) return "1004";
  if (name.includes("fukuyama") || name.includes("福山")) return "1005";

  console.warn(JSON.stringify({
    event: "rakuten_unknown_carrier",
    carrier: carrierName,
    default: "1002",
  }));
  return "1002";
}

/**
 * Make an authenticated POST request to the Rakuten RMS es/2.0 REST API.
 * Uses ESA base64(serviceSecret:licenseKey) auth — same as the product API.
 */
function rmsPostJson(apiPath, body) {
  return rmsRateLimit().then(() => new Promise((resolve, reject) => {
    const token = Buffer.from(
      `${RAKUTEN_SERVICE_SECRET}:${RAKUTEN_LICENSE_KEY}`
    ).toString("base64");

    const payload = JSON.stringify(body || {});
    const req = https.request(
      `${RAKUTEN_RMS_BASE}${apiPath}`,
      {
        method: "POST",
        headers: {
          Authorization: `ESA ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(payload)),
        },
        timeout: 30000,
      },
      (res) => {
        res.setEncoding("utf8");
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`RMS parse error: ${e.message}`));
            }
          } else {
            reject(
              new Error(
                `RMS API returned ${res.statusCode}: ${data.slice(0, 500)}`
              )
            );
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`RMS API request timed out after 30s: ${apiPath}`));
    });

    req.write(payload);
    req.end();
  }));
}

// ── Helpers ─────────────────────────────────────────────────

function runNodeScript(scriptPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...(args || [])], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = stdout ? JSON.parse(stdout) : null;
      } catch {
        parsed = { raw: stdout.trim() };
      }
      resolve({ code, stdout, stderr, parsed });
  });
});
}

async function getEgressIp() {
  return await new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-4", "-fsS", "https://ifconfig.me"],
      { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`egress_ip_check_failed:${stderr || error.message}`));
          return;
        }
        resolve(String(stdout || "").trim());
      },
    );
  });
}

function requireRelaySecret(req) {
  requireScopedRelaySecret(req, RELAY_SECRET);
}

function requireRakutenIngestionRelaySecret(req) {
  requireScopedRelaySecret(req, RAKUTEN_INGESTION_RELAY_SECRET);
}

function requireRakutenSendRelaySecret(req) {
  requireScopedRelaySecret(req, RAKUTEN_SEND_RELAY_SECRET);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeShops(value) {
  return String(Array.isArray(value) ? value.join(",") : value || "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shop) => ["Shop1", "Shop2", "Shop3", "Shop4"].includes(shop));
}

function normalizeStatuses(value) {
  return String(Array.isArray(value) ? value.join(",") : value || "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Format a Date for Rakuten RMS API (yyyy-MM-ddTHH:mm:ss+0900).
 *  Timezone offset must NOT have a colon — +0900 works, +09:00 does not. */
function toRmsDatetime(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  const ss = String(jst.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+0900`;
}

// ── Mercari Order Messages & Reply ────────────────────────

const MERCARI_GRAPHQL_URL = "https://api.mercari-shops.com/v1/graphql";

/** Simple token cache: Map<shopLabel, { token, expires }> with 10-min TTL. */
const _shopTokenCache = new Map();
const SHOP_TOKEN_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Load Mercari access token for a shop from MERCARI_TOKENS_PATH.
 * Token file format (markdown):
 *   ## Shop4
 *   - API token: `xxxxx`
 */
async function loadMercariShopToken(tokensPath, shopLabel) {
  const now = Date.now();
  const cached = _shopTokenCache.get(shopLabel);
  if (cached && cached.expires > now) return cached.token;

  if (!tokensPath) throw new Error("MERCARI_TOKENS_PATH not configured on relay");

  const raw = await fs.readFile(tokensPath, "utf8");
  const sectionRe = /^##\s+(Shop\d+)\s*$/;
  const tokenRe = /-\s*API token:\s*`([^`]+)`/;

  let currentLabel = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(sectionRe);
    if (labelMatch) {
      currentLabel = labelMatch[1];
      continue;
    }
    const tokenMatch = line.match(tokenRe);
    if (tokenMatch && currentLabel === shopLabel) {
      const token = tokenMatch[1].trim();
      _shopTokenCache.set(shopLabel, { token, expires: now + SHOP_TOKEN_CACHE_TTL_MS });
      return token;
    }
  }

  throw new Error(`Token not found for ${shopLabel} in ${tokensPath}`);
}

/**
 * Make an authenticated GraphQL POST to the Mercari Shops API.
 * User-Agent is required (enforced by Mercari since 2026-06-22).
 */
function mercariGraphQL(token, query, variables) {
  const apiClientName = String(process.env.MERCARI_API_CLIENT_NAME || "Inhouse_ERP").trim();
  const apiClientVersion = String(process.env.MERCARI_API_CLIENT_VERSION || "0.0.1").trim();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables: variables || {} });
    const req = https.request(
      MERCARI_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          "User-Agent": `${apiClientName}/${apiClientVersion}`,
        },
        timeout: 30000,
      },
      (res) => {
        res.setEncoding("utf8");
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
              reject(new Error(`Mercari GraphQL error: ${JSON.stringify(parsed.errors)}`));
            } else {
              resolve(parsed.data || parsed);
            }
          } catch (e) {
            reject(new Error(`Mercari parse error: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Mercari GraphQL request timed out after 30s"));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * GET_TRANSACTION_QUERY: fetch messages for a given order transaction.
 */
const GET_TRANSACTION_QUERY = `
query GetTransaction($id: ID!) {
  orderTransaction(id: $id) {
    id
    status
    messages {
      id
      role
      message
      createdAt
    }
  }
}`;

const MAX_STATUS_BATCH = 50;

async function fetchOrderStatuses(body) {
  const shopLabel = String(body.shopLabel || "").trim();
  const orderIds = Array.isArray(body.orderIds)
    ? [...new Set(body.orderIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (!shopLabel) return { ok: false, error: "shopLabel is required" };
  if (!orderIds.length) return { ok: false, error: "orderIds is required" };
  if (orderIds.length > MAX_STATUS_BATCH) return { ok: false, error: `orderIds exceeds ${MAX_STATUS_BATCH}` };
  const tokensPath = String(process.env.MERCARI_TOKENS_PATH || "").trim();
  if (!tokensPath) return { ok: false, error: "MERCARI_TOKENS_PATH not configured on relay" };
  try {
    const token = await loadMercariShopToken(tokensPath, shopLabel);
    const variables = {};
    const declarations = [];
    const selections = orderIds.map((orderId, index) => {
      const variable = `id${index}`;
      variables[variable] = orderId;
      declarations.push(`$${variable}: ID!`);
      return `o${index}: orderTransaction(id: $${variable}) { id status }`;
    });
    const query = `query OrderStatuses(${declarations.join(", ")}) { ${selections.join("\n")} }`;
    const data = await mercariGraphQL(token, query, variables);
    const orders = orderIds.map((orderId, index) => {
      const transaction = data && data[`o${index}`];
      return transaction
        ? { orderId: String(transaction.id || orderId), status: String(transaction.status || "").trim() || null, found: true }
        : { orderId, status: null, found: false };
    });
    return { ok: true, shopLabel, orders };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch messages for an order via Mercari GraphQL.
 * Body: { shopLabel, orderId }
 * Returns: { ok, messages: [{ role, message, createdAt }] }
 */
async function fetchOrderMessages(body) {
  const shopLabel = String(body.shopLabel || "").trim();
  const orderId = String(body.orderId || "").trim();

  if (!shopLabel) return { ok: false, error: "shopLabel is required" };
  if (!orderId) return { ok: false, error: "orderId is required" };

  const tokensPath = String(process.env.MERCARI_TOKENS_PATH || "").trim();
  if (!tokensPath) return { ok: false, error: "MERCARI_TOKENS_PATH not configured on relay" };

  try {
    const token = await loadMercariShopToken(tokensPath, shopLabel);
    const data = await mercariGraphQL(token, GET_TRANSACTION_QUERY, { id: orderId });
    const transaction = data && data.orderTransaction;
    if (!transaction) {
      return { ok: false, error: "order_transaction_not_found", orderId };
    }
    const messages = (transaction.messages || []).map((m) => ({
      id: m.id ? String(m.id).trim() : null,
      role: String(m.role || "").trim().toUpperCase(),
      message: String(m.message || "").trim(),
      createdAt: String(m.createdAt || "").trim(),
    }));
    const status = transaction.status ? String(transaction.status).trim() : null;
    console.log(JSON.stringify({
      event: "mercari_messages_fetched",
      shopLabel,
      orderId,
      messageCount: messages.length,
      status,
    }));
    return { ok: true, messages, status };
  } catch (err) {
    console.error(JSON.stringify({
      event: "mercari_messages_error",
      shopLabel,
      orderId,
      error: err.message,
    }));
    return { ok: false, error: err.message };
  }
}

/**
 * SEND_MESSAGE_MUTATION: send a seller message on a transaction.
 */
const SEND_MESSAGE_MUTATION = `
mutation AddOrderTransactionMessage($input: AddOrderTransactionMessageInput!) {
  addOrderTransactionMessage(input: $input) {
    orderTransaction {
      id
      messages {
        id
        role
        message
        createdAt
      }
    }
  }
}`;

/**
 * Send a reply to a customer on a Mercari order transaction.
 * Body: { shopLabel, transactionId, text }
 * Returns: { ok, message: { role, message, createdAt } }
 */
async function sendOrderReply(body) {
  const shopLabel = String(body.shopLabel || "").trim();
  const transactionId = String(body.transactionId || "").trim();
  const text = String(body.text || "").trim();

  if (!shopLabel) return { ok: false, error: "shopLabel is required" };
  if (!transactionId) return { ok: false, error: "transactionId is required" };
  if (!text) return { ok: false, error: "text is required" };

  const tokensPath = String(process.env.MERCARI_TOKENS_PATH || "").trim();
  if (!tokensPath) return { ok: false, error: "MERCARI_TOKENS_PATH not configured on relay" };

  try {
    const token = await loadMercariShopToken(tokensPath, shopLabel);
    const data = await mercariGraphQL(token, SEND_MESSAGE_MUTATION, {
      input: { orderTransactionId: transactionId, message: text },
    });
    const result = data && data.addOrderTransactionMessage && data.addOrderTransactionMessage.orderTransaction;
    const messages = result ? result.messages : [];
    if (!result || !messages.length) {
      return { ok: false, error: "send_message_failed", transactionId };
    }
    const lastMessage = messages[messages.length - 1];
    const message = {
      id: lastMessage.id ? String(lastMessage.id).trim() : null,
      role: String(lastMessage.role || "SELLER").trim(),
      message: String(lastMessage.message || text).trim(),
      createdAt: String(lastMessage.createdAt || "").trim(),
    };
    console.log(JSON.stringify({
      event: "mercari_reply_sent",
      shopLabel,
      transactionId,
      textLength: text.length,
    }));
    return { ok: true, message };
  } catch (err) {
    console.error(JSON.stringify({
      event: "mercari_reply_error",
      shopLabel,
      transactionId,
      error: err.message,
    }));
    return { ok: false, error: err.message };
  }
}
