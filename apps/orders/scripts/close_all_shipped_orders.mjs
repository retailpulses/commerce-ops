#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createBaserowClient, listAllRows, patchRow } from "../src/lib/db.mjs";
import { toJstIso } from "../src/lib/timezone.mjs";
import { runMercariCloseOperation } from "../src/lib/mercari-close-operation.mjs";

const DEFAULT_VPS_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");
const DEFAULT_DOC_TOKENS = [
  "/opt/secrets/Mercari_API_Tokens_Private_2026-04-01.md",
  "/opt/OrderMgmt/env/Mercari_API_Tokens_Private_2026-04-01.md",
  "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md",
].find((candidate) => existsSync(candidate));
const DEFAULT_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_CLIENT_VERSION = "0.0.1";
const DEFAULT_SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};
const SHOP_LABEL_BY_ID = Object.fromEntries(Object.entries(DEFAULT_SHOP_IDS).map(([label, id]) => [id, label]));

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  loadEnvFileIfPresent(process.env.MERCARI_BASEROW_ENV_PATH || "/Users/user/Documents/vibe coding/mail integration/dev.env");

  const args = parseArgs(process.argv.slice(2));
  const dryRun = isTruthy(args["dry-run"]) || isTruthy(process.env.MERCARI_SHIPPING_DRY_RUN);
  const limit = parseInteger(args.limit || process.env.ORDER_MGMT_LIMIT, 0);
  const orderIdFilter = normalizeOrderIdCandidate(args["order-id"] || process.env.MERCARI_ORDER_ID || "");
  const shops = resolveShops(args.shops || process.env.MERCARI_SHOPS || "");
  const selectedShopIds = new Set(shops.map((shop) => DEFAULT_SHOP_IDS[shop]).filter(Boolean));
  const tokensPath = process.env.MERCARI_TOKENS_PATH || DEFAULT_DOC_TOKENS;
  const host = process.env.MERCARI_SSH_HOST || DEFAULT_VPS_HOST;
  const sshKey = process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY;
  const clientName = process.env.MERCARI_API_CLIENT_NAME || DEFAULT_CLIENT_NAME;
  const clientVersion = process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_CLIENT_VERSION;
  const baserow = createBaserowClient(process.env);
  if (!dryRun && baserow.type !== "supabase") {
    throw new Error("external_operation_ledger_requires_supabase");
  }
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId);
  const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId);
  let candidates = buildShipmentCloseCandidates(shipmentRows, selectedShopIds);

  if (orderIdFilter) {
    candidates = candidates.filter((candidate) => candidate.orderId === orderIdFilter);
  }

  candidates = excludeTerminalSalesCandidates(candidates, salesRows);

  const summary = {
    ok: true,
    dry_run: dryRun,
    total_sales_rows: salesRows.length,
    total_shipment_rows: shipmentRows.length,
    candidates: candidates.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    backfill_processed: 0,
    backfill_failed: 0,
    by_shop: {},
    shops,
    order_id_filter: orderIdFilter || null,
    results: [],
  };

  const boundedCandidates = limit > 0 ? candidates.slice(0, limit) : candidates;
  const tokenCache = new Map();

  for (const candidate of boundedCandidates) {
    const { orderId, shopId, rows: candidateShipmentRows, trackingEntries } = candidate;
    const shopLabel = SHOP_LABEL_BY_ID[shopId];
    if (!orderId || !shopLabel) {
      summary.failed += 1;
      summary.results.push({ shipment_row_ids: candidateShipmentRows.map((row) => row.id), order_id: orderId, shop_id: shopId, error: "missing_order_or_shop" });
      continue;
    }

    const bucket = summary.by_shop[shopLabel] || { candidates: 0, processed: 0, skipped: 0, failed: 0 };
    bucket.candidates += 1;
    summary.by_shop[shopLabel] = bucket;

    try {
      const token = await loadShopTokenCached(tokenCache, tokensPath, shopLabel);
      const order = await findOrderTransaction({ host, sshKey, token, clientName, clientVersion, orderId });
      if (!order) {
        summary.failed += 1;
        bucket.failed += 1;
        summary.results.push({ shipment_row_ids: candidateShipmentRows.map((row) => row.id), order_id: orderId, shop: shopLabel, error: "order_not_found" });
        continue;
      }

      const activeProducts = Array.isArray(order.products)
        ? order.products.filter((product) => Number(product.unshippedQuantity || product.purchasedQuantity || 0) > 0)
        : [];

      const shippingPlan = buildShippingPlan(activeProducts);
      const mercariStatus = String(order.status || "").toUpperCase();
      const alreadyCompleted = mercariStatus === "COMPLETED";

      const result = {
        shipment_row_ids: candidateShipmentRows.map((row) => row.id),
        order_id: orderId,
        shop: shopLabel,
        shipping_plan: shippingPlan.map((plan) => ({ shippingMethod: plan.shippingMethod, quantity: plan.products.length })),
        tracking_entries: trackingEntries,
        mercari_order_status: order.status,
        mercari_shipping_status: "",
        actions: [],
      };

      if (!dryRun) {
        if (["CANCELED", "CANCELING"].includes(mercariStatus)) {
          const nowIso = toJstIso(new Date());
          await patchSalesRowsCloseOutcome(baserow, salesRows, orderId, shopId, nowIso, "Not Applicable", mercariStatus);
          summary.skipped += 1;
          bucket.skipped += 1;
          result.skipped = true;
          result.actions.push({ step: "terminal_order_no_close", status: mercariStatus });
          summary.results.push(result);
          continue;
        }
        if (!alreadyCompleted && !["WAITING_FOR_SHIPPING", "COMPLETING"].includes(mercariStatus)) {
          throw new Error(`unsupported_mercari_order_status:${mercariStatus || "UNKNOWN"}`);
        }
        const trackingCode = buildTrackingCode(trackingEntries);
        if (!alreadyCompleted && mercariStatus === "WAITING_FOR_SHIPPING") {
          if (!shippingPlan.length) {
            throw new Error("no_active_products_to_ship");
          }
          if (!trackingCode) {
            throw new Error("no_valid_tracking_entries");
          }
        }

        const closeOutcome = await runMercariCloseOperation({
          supabase: baserow.supabase,
          orderId,
          sourceStoreId: shopId,
          initialStatus: mercariStatus,
          runId: text(process.env.ORDERMGMT_RUN_ID) || `mercari_close_${Date.now()}`,
        }, {
          execute: async () => {
            for (const plan of shippingPlan) {
              const orderShippingId = await ensureShipping({
                host, sshKey, token, clientName, clientVersion, orderId, plan,
              });
              await mercariRequest({
                host, sshKey, token, clientName, clientVersion,
                query: UPDATE_TRACKING_MUTATION,
                variables: { input: { orderShippingId, orderTransactionId: orderId, trackingCode } },
              });
              await mercariRequest({
                host, sshKey, token, clientName, clientVersion,
                query: COMPLETE_SHIPPING_MUTATION,
                variables: { input: { orderShippingId, orderTransactionId: orderId } },
              });
              result.actions.push({ step: "complete", shippingMethod: plan.shippingMethod, trackingCode, orderShippingId });
            }
          },
          readStatus: async () => {
            const readback = await findOrderTransaction({ host, sshKey, token, clientName, clientVersion, orderId });
            return readback?.status || "";
          },
        });
        result.operation_action = closeOutcome.action;
        if (!closeOutcome.completed) {
          const nowIso = toJstIso(new Date());
          const pending = closeOutcome.action === "submitted_awaiting_completion" || closeOutcome.action === "preexisting_completion_in_progress";
          await patchSalesRowsCloseOutcome(
            baserow, salesRows, orderId, shopId, nowIso,
            pending ? "Submitted" : "Failed",
            `mercari_close_${closeOutcome.action}`.slice(0, 500),
          );
          const closeError = String(closeOutcome.error || "").trim().slice(0, 300);
          throw new Error([
            `mercari_close_${closeOutcome.action}`,
            closeError,
          ].filter(Boolean).join(":"));
        }
        const nowIso = toJstIso(new Date());
        await completeMercariClose(baserow, salesRows, orderId, shopId, trackingEntries, nowIso);
      }

      summary.processed += 1;
      bucket.processed += 1;
      summary.results.push(result);
    } catch (error) {
      summary.failed += 1;
      bucket.failed += 1;
      summary.results.push({
        shipment_row_ids: candidateShipmentRows.map((row) => row.id),
        order_id: orderId,
        shop: shopLabel,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.failed === 0 ? 0 : 1;
}

export async function completeMercariClose(client, salesRows, orderId, shopId, trackingEntries, completedAt) {
  const expectedRows = (salesRows || []).filter((row) =>
    normalizeOrderIdCandidate(row.order_id) === normalizeOrderIdCandidate(orderId)
    && text(row.source_store_id || row.shop_id) === shopId
    && text(row.sales_channel).toLowerCase() === "mercari",
  );
  if (!expectedRows.length) throw new Error(`sales_rows_not_found:${shopId}:${normalizeOrderIdCandidate(orderId)}`);
  const { richPayload } = buildSalesTrackingPatches(trackingEntries, completedAt);
  const { data, error } = await client.supabase.rpc("complete_mercari_order_close", {
    p_order_id: normalizeOrderIdCandidate(orderId),
    p_source_store_id: shopId,
    p_completed_at: completedAt,
    p_tracking_carrier: richPayload.tracking_carrier,
    p_tracking_number: richPayload.tracking_number,
    p_tracking_detail: richPayload.shipping_tracking_info,
  });
  if (error || Number(data) !== expectedRows.length) {
    throw new Error(`mercari_close_completion_cas_failed:${error?.message || data}`);
  }
  const normalized = normalizeOrderIdCandidate(orderId);
  const { data: rows, error: readError } = await client.supabase.from("sales_orders")
    .select("id,order_id,order_status,review_status,shop_close_status,shop_close_completed_at,tracking_carrier,tracking_number")
    .eq("sales_channel", "mercari")
    .eq("source_store_id", shopId)
    .in("order_id", [normalized, `order_${normalized}`]);
  const valid = !readError && Array.isArray(rows) && rows.length === expectedRows.length
    && rows.every((row) => row.order_status === "COMPLETED"
      && row.review_status == null
      && row.shop_close_status === "Completed"
      && sameInstant(row.shop_close_completed_at, completedAt)
      && row.tracking_carrier === richPayload.tracking_carrier
      && row.tracking_number === richPayload.tracking_number);
  if (!valid) throw new Error(`mercari_close_completion_readback_failed:${readError?.message || "mismatch"}`);
  return rows;
}

function sameInstant(left, right) {
  const leftMs = Date.parse(String(left || ""));
  const rightMs = Date.parse(String(right || ""));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

export function buildShipmentCloseCandidates(shipmentRows, selectedShopIds = new Set()) {
  return buildShipmentTrackingGroups(shipmentRows, selectedShopIds, false);
}

export function excludeTerminalSalesCandidates(candidates, salesRows) {
  const terminalOrderKeys = new Set();
  for (const row of salesRows || []) {
    const closeStatus = text(row.shop_close_status).toLowerCase();
    if (!["completed", "not applicable"].includes(closeStatus) && !row.shop_close_completed_at) continue;
    const orderId = normalizeOrderIdCandidate(row.order_id);
    const shopId = text(row.source_store_id || row.shop_id);
    if (orderId && shopId) terminalOrderKeys.add(`${shopId}::${orderId}`);
  }
  return (candidates || []).filter(
    (candidate) => !terminalOrderKeys.has(`${text(candidate.shopId)}::${normalizeOrderIdCandidate(candidate.orderId)}`),
  );
}

export function buildShipmentTrackingGroups(shipmentRows, selectedShopIds = new Set(), includeClosed = true) {
  const groups = new Map();
  for (const row of shipmentRows || []) {
    const orderId = normalizeOrderIdCandidate(row.order_id);
    const shopId = text(row.source_store_id);
    if (text(row.sales_channel).toLowerCase() !== "mercari" || !orderId || !SHOP_LABEL_BY_ID[shopId]) continue;
    if (selectedShopIds.size && !selectedShopIds.has(shopId)) continue;
    // Close state is canonical on sales_orders.shop_close_completed_at (Supabase migration)
    const canonicalEntries = mapCanonicalTracking(row.tracking_carrier, row.tracking_number);
    const entries = canonicalEntries.length ? canonicalEntries : parseTrackingEntries(row.giga_tracking_raw, row.giga_tracking_info);
    if (!entries.length) continue;
    const key = `${shopId}::${orderId}`;
    const group = groups.get(key) || { orderId, shopId, rows: [], trackingEntries: [] };
    group.rows.push(row);
    group.trackingEntries.push(...entries);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, trackingEntries: dedupeTrackingEntries(group.trackingEntries) }))
    .sort((left, right) => {
      const leftMs = oldestShipmentTimestamp(left.rows);
      const rightMs = oldestShipmentTimestamp(right.rows);
      if (leftMs !== rightMs) return leftMs - rightMs;
      return left.orderId.localeCompare(right.orderId);
    });
}

async function patchMatchingSalesRows(baserow, salesRows, orderId, shopId, trackingEntries, nowIso) {
  const matchingRows = salesRows.filter((row) =>
    normalizeOrderIdCandidate(row.order_id) === normalizeOrderIdCandidate(orderId) &&
    text(row.source_store_id || row.shop_id) === shopId,
  );
  if (!matchingRows.length) throw new Error(`sales_rows_not_found:${shopId}:${normalizeOrderIdCandidate(orderId)}`);
  for (const row of matchingRows) {
    await patchSalesRow(baserow, row, trackingEntries, nowIso);
  }
}

async function patchSalesRow(baserow, row, trackingEntries, nowIso) {
  const { richPayload, fallbackPayload } = buildSalesTrackingPatches(trackingEntries, nowIso);
  const response = await patchRowWithFallback(baserow, baserow.salesOrderTableId, row.id, richPayload, fallbackPayload);
  if (!response.ok) {
    throw new Error(`sales_patch_failed:${response.error || response.status}`);
  }
}

export function buildSalesTrackingPatches(trackingEntries, nowIso) {
  const carrierSummary = Array.from(new Set(trackingEntries.map((entry) => text(entry.carrierName)).filter(Boolean))).join(" / ");
  const trackingNumberSummary = Array.from(new Set(trackingEntries.map((entry) => text(entry.trackingNum)).filter(Boolean))).join(" / ");
  const trackingDetail = trackingEntries.map((entry) => `${text(entry.carrierName) || "Unknown"}: ${text(entry.trackingNum)}`).join("; ");
  return {
    richPayload: {
      shipping_completed_at: nowIso,
      order_status: "COMPLETED",
      review_status: null,
      shipping_carrier: carrierSummary,
      shipping_tracking_info: trackingDetail,
      tracking_carrier: carrierSummary,
      tracking_number: trackingNumberSummary,
      shop_close_status: "Completed",
      shop_close_attempted_at: nowIso,
      shop_close_completed_at: nowIso,
      shop_close_error: "",
    },
    fallbackPayload: {
      shipping_completed_at: nowIso,
      order_status: "COMPLETED",
      review_status: null,
      shipping_carrier: carrierSummary,
      shipping_tracking_info: trackingDetail,
    },
  };
}

export async function patchSalesRowsCloseOutcome(baserow, salesRows, orderId, shopId, nowIso, status, error) {
  const matching = salesRows.filter(
    (row) => normalizeOrderIdCandidate(text(row.order_id)) === normalizeOrderIdCandidate(orderId) &&
             text(row.source_store_id || row.shop_id) === shopId,
  );
  if (!matching.length) throw new Error(`sales_rows_not_found:${shopId}:${normalizeOrderIdCandidate(orderId)}`);
  const { richPayload, fallbackPayload } = buildSalesCloseOutcomePatches(nowIso, status, error);
  for (const row of matching) {
    const response = await patchRowWithFallback(
      baserow, baserow.salesOrderTableId, row.id,
      richPayload,
      fallbackPayload,
    );
    if (!response.ok) {
      throw new Error(`sales_patch_failed:${response.error || response.status}`);
    }
  }
}

export function buildSalesCloseOutcomePatches(nowIso, status, error) {
  const completed = status === "Completed";
  return {
    richPayload: {
      shop_close_status: status,
      shop_close_attempted_at: nowIso,
      shop_close_completed_at: completed ? nowIso : null,
      shop_close_error: error,
      order_status: completed ? "COMPLETED" : undefined,
      review_status: completed ? null : undefined,
      shipping_completed_at: completed ? nowIso : undefined,
    },
    fallbackPayload: {
      shop_close_status: status,
      shop_close_attempted_at: nowIso,
      shop_close_error: error,
    },
  };
}

async function patchShipmentRowsCloseOutcome(baserow, rows, nowIso, status, error) {
  for (const row of rows) {
    const response = await patchRow(baserow, baserow.shipmentOrderTableId, row.id, {
      shop_close_status: status,
      shop_close_attempted_at: nowIso,
      shop_close_completed_at: status === "Completed" ? nowIso : null,
      shop_close_error: error,
    });
    if (!response.ok) {
      throw new Error(`shipment_patch_failed:${response.error || response.status}`);
    }
  }
}

function dedupeTrackingEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${text(entry.carrierName)}::${text(entry.trackingNum)}`;
    if (!text(entry.trackingNum) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function oldestShipmentTimestamp(rows) {
  const timestamps = rows
    .map((row) => Date.parse(text(row.shipping_completed_at || row.order_date || "")))
    .filter(Number.isFinite);
  return timestamps.length ? Math.min(...timestamps) : 0;
}

async function patchRowWithFallback(client, tableId, rowId, richPatch, fallbackPatch) {
  const richResult = await patchRow(client, tableId, rowId, richPatch);
  if (richResult.ok) {
    return richResult;
  }
  if (!fallbackPatch) {
    return richResult;
  }
  return await patchRow(client, tableId, rowId, fallbackPatch);
}

async function ensureShipping({ host, sshKey, token, clientName, clientVersion, orderId, plan }) {
  const createRes = await mercariRequest({
    host,
    sshKey,
    token,
    clientName,
    clientVersion,
    query: CREATE_SHIPPING_MUTATION,
    variables: {
      input: {
        idempotencyKey: `${orderId}:${plan.shippingMethod}:${plan.products.map((item) => `${item.productId}:${item.quantity}`).join("|")}`,
        orderTransactionId: orderId,
        products: plan.products,
      },
    },
  });
  return createRes.data.createOrderShipping.orderShipping.id;
}

async function findOrderTransaction({ host, sshKey, token, clientName, clientVersion, orderId }) {
  try {
    const directResult = await mercariRequest({
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
    const found = edges.map((edge) => edge && edge.node).find((node) => node && normalizeOrderIdCandidate(node.id) === orderId);
    if (found) return found;
    const pageInfo = result.data && result.data.orderTransactions && result.data.orderTransactions.pageInfo;
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return null;
}

function buildShippingPlan(products) {
  const grouped = groupBy(products, (product) => text(product.shippingMethod) || "UNKNOWN");
  const plans = [];
  for (const [shippingMethod, groupProducts] of Object.entries(grouped)) {
    const normalizedProducts = groupProducts.map((product) => ({
      productId: product.productId,
      quantity: Number(product.unshippedQuantity || product.purchasedQuantity || 0),
      variantId: product.variant && product.variant.id ? product.variant.id : null,
    }));
    if (normalizedProducts.some((item) => !item.productId || !item.quantity || !item.variantId)) {
      throw new Error(`missing_product_fields_for_${shippingMethod}`);
    }
    plans.push({ shippingMethod, products: normalizedProducts });
  }
  return plans;
}

export function mapCanonicalTracking(trackingCarrier, trackingNumber) {
  const trackingNumbers = splitTrackingSummary(trackingNumber);
  if (!trackingNumbers.length) return [];

  const carriers = splitTrackingSummary(trackingCarrier);
  return trackingNumbers.map((trackingNum, index) => {
    const carrierName = text(carriers.length === 1 ? carriers[0] : carriers[index]) || "Unknown";
    return {
      carrierName,
      trackingNum: stripMatchingCarrierPrefix(trackingNum, carrierName),
    };
  });
}

function splitTrackingSummary(value) {
  return text(value).split(/\s+\/\s+/g).map(text).filter(Boolean);
}

function stripMatchingCarrierPrefix(trackingNum, carrierName) {
  const match = text(trackingNum).match(/^(.+?)[：:]\s*(.+)$/);
  if (!match || text(match[1]) !== text(carrierName)) return text(trackingNum);
  return text(match[2]);
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

async function loadShopTokenCached(cache, filePath, shopLabel) {
  if (cache.has(shopLabel)) return cache.get(shopLabel);
  const token = await loadShopToken(filePath, shopLabel);
  cache.set(shopLabel, token);
  return token;
}

async function loadShopToken(filePath, shopLabel) {
  const textContent = await fs.readFile(filePath, "utf8");
  const section = textContent.split(/\n##\s+/).find((chunk) => chunk.startsWith(shopLabel));
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
    throw new Error(`Direct Mercari request failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
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

function parseInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function resolveShops(value) {
  return String(Array.isArray(value) ? value.join(",") : value || "")
    .split(/[,\s;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shop) => ["Shop1", "Shop2", "Shop3", "Shop4"].includes(shop));
}

function text(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeOrderIdCandidate(value) {
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

const COMPLETE_SHIPPING_MUTATION = `
mutation completeOrderShipping($input: CompleteOrderShippingInput!) {
  completeOrderShipping(input: $input) {
    orderShippingId
  }
}
`;
