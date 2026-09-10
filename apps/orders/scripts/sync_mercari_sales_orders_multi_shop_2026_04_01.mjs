#!/usr/bin/env node

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toJstIso } from "../src/lib/timezone.mjs";
import { mercariResolveItemCode } from "../src/lib/item-code-resolver.mjs";
import {
  filterPatchToOwnedFields,
  getOwnedFields,
} from "../src/lib/field-ownership.mjs";
import { statusEquals, MERCARI_API_STATUS } from "../src/lib/order-state.mjs";
import { needsBackfill, buildBackfillPayload } from "../src/lib/order-backfill.mjs";
import { extractBuyerMessageFacts } from "../src/lib/buyer-messages.mjs";
import { createBaserowClient, createRow, deleteRow, listAllRows, patchRow } from "../src/lib/db.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_PRIVATE_TOKENS_PATH = firstExistingPath([
  "/opt/secrets/Mercari_API_Tokens_Private_2026-04-01.md",
  path.join(REPO_ROOT, "knowledge", "Mercari_API_Tokens_Private_2026-04-01.md"),
  path.join(REPO_ROOT, "env", "Mercari_API_Tokens_Private_2026-04-01.md"),
  "/opt/rp-order-mgmt/env/Mercari_API_Tokens_Private_2026-04-01.md",
  "/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md",
]);
const DEFAULT_DEV_ENV_PATH = firstExistingPath([
  path.join(REPO_ROOT, "env", "dev.env"),
  "/opt/rp-order-mgmt/env/dev.env",
  "/Users/user/Documents/April 2026/.env",
  "/Users/user/Documents/vibe coding/mail integration/dev.env",
]);
const DEFAULT_SSH_HOST = "root@160.251.141.110";
const DEFAULT_SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519");
const DEFAULT_API_CLIENT_NAME = "Inhouse_ERP";
const DEFAULT_API_CLIENT_VERSION = "0.0.1";
const DEFAULT_API_BASE = "https://api.baserow.io/api";
const DEFAULT_TABLE_ID = 903318;
const DEFAULT_STATUSES = ["WAITING_FOR_SHIPPING", "WAITING_FOR_PAYMENT"];
const DEFAULT_SHOPS = ["Shop1", "Shop2", "Shop3", "Shop4"];

/** Statuses to query in the terminal-status sync step after the main sync. */
const TERMINAL_STATUSES = ["COMPLETED", "COMPLETING"];

const MERCARI_QUERY = `
query OrderTransactions($first: Int!, $after: String, $statuses: [OrderTransactionStatusFilter!]) {
  orderTransactions(first: $first, after: $after, statuses: $statuses) {
    edges {
      node {
        id
        createdAt
        paidAt
        orderType
        status
        totalPrice
        shippingAddress {
          address1
          address2
          city
          country
          firstName
          lastName
          phoneNumber
          postalCode
          state { name }
        }
        products {
          name
          buyerShippingFee
          purchasedQuantity
          shippingMethod
          unitPrice
          unshippedQuantity
          variant { skuCode }
        }
        messages {
          createdAt
          id
          message
          role
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const MERCARI_EXACT_QUERY = `
query OrderTransaction($id: ID!) {
  orderTransaction(id: $id) {
    id
    createdAt
    paidAt
    orderType
    status
    totalPrice
    shippingAddress {
      address1 address2 city country firstName lastName phoneNumber postalCode
      state { name }
    }
    products {
      name buyerShippingFee purchasedQuantity shippingMethod unitPrice unshippedQuantity
      variant { skuCode }
    }
    messages { createdAt id message role }
  }
}`;

const SHOP_FIELD_RE = /^##\s+(Shop\d+)\s*$/;
const SHOP_ID_RE = /-\s*Shop ID:\s*`([^`]+)`/;
const SHOP_TOKEN_RE = /-\s*API token:\s*`([^`]+)`/;

const ORDER_FIELD_NAMES = {
  orderId: "order_id",
  purchaseDate: "purchase_date",
  paymentDate: "payment_date",
  buyerName: "buyer_name",
  originalProductId: "original_product_id",
  b2bItemCode: "B2BItemCode",
  productName: "product_name",
  quantity: "quantity",
  currency: "currency",
  productPrice: "product_price",
  productTax: "product_tax",
  shippingPrice: "shipping_price",
  shippingTax: "shipping_tax",
  shippingMethod: "shipping_method",
  shippingCarrier: "shipping_carrier",
  shippingTrackingInfo: "shipping_tracking_info",
  shippingCompletedAt: "shipping_completed_at",
  shippingDuration: "shipping_duration",
  requestedDeliveryDate: "requested_delivery_date",
  requestedDeliveryTime: "requested_delivery_time",
  shippingCountry: "shipping_country",
  shippingPostalCode: "shipping_postal_code",
  shippingState: "shipping_state",
  shippingCity: "shipping_city",
  shippingAddress1: "shipping_address_1",
  shippingAddress2: "shipping_address_2",
  shippingName: "shipping_name",
  billingCountry: "billing_country",
  billingPostalCode: "billing_postal_code",
  billingState: "billing_state",
  billingCity: "billing_city",
  billingAddress1: "billing_address_1",
  billingAddress2: "billing_address_2",
  billingName: "billing_name",
  shippingPhoneNumber: "shipping_phone_number",
  couponDiscountAmount: "coupon_discount_amount",
  couponId: "coupon_id",
  orderType: "order_type",
  orderStatus: "order_status",
  shopId: "shop_id",
  shopCloseStatus: "shop_close_status",
  orderComments: "order_comments",
  reviewStatus: "review_status",
  latestBuyerMessageId: "latest_buyer_message_id",
  latestBuyerMessageAt: "latest_buyer_message_at",
  hasBuyerMessages: "has_buyer_messages",
  messageLastSyncedAt: "message_last_synced_at",
};

const SUMMARY_COLUMNS = [
  ORDER_FIELD_NAMES.orderId,
  ORDER_FIELD_NAMES.originalProductId,
  ORDER_FIELD_NAMES.productName,
  ORDER_FIELD_NAMES.quantity,
  ORDER_FIELD_NAMES.productPrice,
  ORDER_FIELD_NAMES.shippingPrice,
  ORDER_FIELD_NAMES.shippingMethod,
  ORDER_FIELD_NAMES.shippingCountry,
  ORDER_FIELD_NAMES.shippingPostalCode,
  ORDER_FIELD_NAMES.shippingState,
  ORDER_FIELD_NAMES.shippingCity,
  ORDER_FIELD_NAMES.shippingAddress1,
  ORDER_FIELD_NAMES.shippingAddress2,
  ORDER_FIELD_NAMES.shippingName,
  ORDER_FIELD_NAMES.shippingPhoneNumber,
  ORDER_FIELD_NAMES.orderType,
  ORDER_FIELD_NAMES.orderStatus,
  ORDER_FIELD_NAMES.shopId,
  ORDER_FIELD_NAMES.purchaseDate,
  ORDER_FIELD_NAMES.paymentDate,
  ORDER_FIELD_NAMES.orderComments,
];
const INGEST_PHASE = "pull_shop_orders";
const INGEST_TABLE = "sales";
const INGEST_SALES_CHANNEL = "Mercari";
const INGEST_OWNED_FIELDS = new Set(getOwnedFields({
  phase: INGEST_PHASE,
  table: INGEST_TABLE,
  salesChannel: INGEST_SALES_CHANNEL,
}));

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args["?"]) {
    printUsage();
    return;
  }

  loadEnvFileIfPresent(process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_DEV_ENV_PATH);

  const privateTokensPath = path.resolve(
    String(args["tokens-path"] || process.env.MERCARI_TOKENS_PATH || DEFAULT_PRIVATE_TOKENS_PATH)
  );
  const dryRun = args["dry-run"] === true || args.dryRun === true;
  const shopFilter = normalizeShopFilter(args.shops || process.env.MERCARI_SHOPS || "");
  const orderIdFilter = normalizeOrderIdCandidate(args["order-id"] || process.env.MERCARI_ORDER_ID || "");
  const statuses = normalizeStatusFilter(args.statuses || process.env.MERCARI_ORDER_STATUSES || DEFAULT_STATUSES.join(","));
  const backend = String(process.env.DATABASE_BACKEND || "").trim().toLowerCase();
  if (backend !== "supabase") {
    console.error(JSON.stringify({ event: "ingest_blocked", reason: "DATABASE_BACKEND is not supabase", backend: backend || "(unset)" }));
    process.exit(1);
  }
  const client = createBaserowClient(process.env);
  const tableId = client.salesOrderTableId;

  const shopSecrets = await loadShopSecrets(privateTokensPath);
  const selectedShops = DEFAULT_SHOPS.filter((shop) => !shopFilter.length || shopFilter.includes(shop.toLowerCase()));
  if (!selectedShops.length) {
    throw new Error("No shops selected");
  }
  if (orderIdFilter && selectedShops.length !== 1) {
    throw new Error("Exact Mercari discovery requires exactly one shop");
  }

  const existingFilters = {
    [`filter__field_sales_channel__equal`]: "mercari",
  };
  if (orderIdFilter) {
    const selectedSecret = shopSecrets.get(selectedShops[0]);
    if (!selectedSecret) throw new Error(`Missing token entry for ${selectedShops[0]} in private token file`);
    existingFilters[`filter__field_order_id__equal`] = orderIdFilter;
    existingFilters[`filter__field_source_store_id__equal`] = selectedSecret.shopId;
  }
  const existingRows = await listAllRows(client, tableId, existingFilters);
  const existingByKey = new Map();
  for (const row of existingRows) {
    const key = makeRowKey(row[ORDER_FIELD_NAMES.shopId], row[ORDER_FIELD_NAMES.orderId], row[ORDER_FIELD_NAMES.originalProductId]);
    if (!key) continue;
    existingByKey.set(key, row);
  }

  const totals = {
    shops: selectedShops.length,
    transactions: 0,
    lines: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    guarded_terminal_regressions: 0,
    terminal_status_candidates: 0,
  };

  const results = [];
  for (const shopLabel of selectedShops) {
    const secret = shopSecrets.get(shopLabel);
    if (!secret) {
      throw new Error(`Missing token entry for ${shopLabel} in private token file`);
    }
    const shopResult = await syncShop({
      shopLabel,
      shopId: secret.shopId,
      token: secret.token,
      client,
      tableId,
      existingByKey,
      statuses,
      orderIdFilter,
      dryRun,
    });
    results.push(shopResult);
    totals.transactions += shopResult.transactions;
    totals.lines += shopResult.lines;
    totals.created += shopResult.created;
    totals.updated += shopResult.updated;
    totals.unchanged += shopResult.unchanged;
    totals.skipped += shopResult.skipped;
    totals.failed += shopResult.failed;
    totals.guarded_terminal_regressions += shopResult.guarded_terminal_regressions || 0;
    totals.terminal_status_candidates += shopResult.terminal_status_candidates || 0;
  }

  const summary = {
    ok: totals.failed === 0,
    dry_run: dryRun,
    table_id: tableId,
    statuses,
    order_id_filter: orderIdFilter || null,
    totals,
    shops: results,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = totals.failed === 0 ? 0 : 1;
}

async function syncShop({ shopLabel, shopId, token, client, tableId, existingByKey, statuses, orderIdFilter = "", dryRun }) {
  console.error(`[mercari-pull] syncing ${shopLabel}`);
  const validation = await mercariGraphQL({
    token,
    query: "query shop { shop { id name businessKind } }",
    variables: {},
  });
  const actualShop = validation.data && validation.data.shop ? validation.data.shop : null;
  if (!actualShop || String(actualShop.id || "").trim() !== String(shopId || "").trim()) {
    throw new Error(`Shop validation failed for ${shopLabel}: expected ${shopId}, got ${actualShop ? actualShop.id : "null"}`);
  }

  let pages = [];
  if (orderIdFilter) {
    const exactResult = await mercariGraphQL({ token, query: MERCARI_EXACT_QUERY, variables: { id: orderIdFilter } });
    const exact = selectExactMercariTransaction(exactResult?.data?.orderTransaction, orderIdFilter);
    if (!exact) throw new Error(`Exact Mercari order not found or mismatched for ${shopLabel}`);
    pages = [exact];
  } else {
    let after = null;
    do {
    const res = await mercariGraphQL({
      token,
      query: MERCARI_QUERY,
      variables: {
        first: 100,
        after,
        statuses,
      },
    });
    const conn = res.data && res.data.orderTransactions ? res.data.orderTransactions : null;
    if (!conn) {
      throw new Error(`Missing orderTransactions connection for ${shopLabel}`);
    }
    const edges = Array.isArray(conn.edges) ? conn.edges : [];
    pages.push(...edges.map((edge) => edge && edge.node ? edge.node : null).filter(Boolean));
    after = conn.pageInfo && conn.pageInfo.hasNextPage ? String(conn.pageInfo.endCursor || "") : null;
    } while (after);
  }

  const seenKeys = new Set();
  const rows = [];
  const skuByOrderId = new Map();
  for (const transaction of pages) {
    const normalizedTransaction = normalizeTransaction(transaction, shopId);
    for (const line of normalizedTransaction.lines) {
      const key = line.line_key_proposed;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      rows.push(line);
    }
    if (!skuByOrderId.has(normalizedTransaction.transaction_id)) skuByOrderId.set(normalizedTransaction.transaction_id, new Set());
    const skuSet = skuByOrderId.get(normalizedTransaction.transaction_id);
    for (const line of normalizedTransaction.lines) {
      const sku = normalizeText(line && line.target_row ? line.target_row[ORDER_FIELD_NAMES.originalProductId] : "");
      if (sku) skuSet.add(sku);
    }
  }

  const writeSummary = {
    shop: shopLabel,
    shop_id: shopId,
    shop_name: actualShop.name || "",
    transactions: pages.length,
    lines: rows.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    backfilled: 0,
    skipped: 0,
    failed: 0,
    guarded_terminal_regressions: 0,
    terminal_status_candidates: 0,
    status_breakdown: {},
    sample: rows.slice(0, 3),
  };

  for (const line of rows) {
    const existing = existingByKey.get(line.line_key_proposed);

    // ---- Backfill address/review on unpaid→paid (retry-safe) ----
    // Runs before rowsEquivalent so a failed backfill retries on the next
    // sync even when order_status/payment_date are already in sync.
    let backfilled = false;
    if (existing && !dryRun) {
      if (needsBackfill(existing, line.target_row)) {
        const bfPayload = buildBackfillPayload(existing, line.target_row);
        if (Object.keys(bfPayload).length > 0) {
          try {
            const bfRes = await patchRow(client, tableId, existing.id, bfPayload);
            if (!bfRes.ok) {
              throw new Error(
                `backfill PATCH failed for row ${existing.id} order ${existing[ORDER_FIELD_NAMES.orderId]}: HTTP ${bfRes.status} ${bfRes.error || ""}`,
              );
            }
            backfilled = true;
            writeSummary.backfilled += 1;
          } catch (error) {
            writeSummary.failed += 1;
            writeSummary.sample.push({
              line_key_proposed: line.line_key_proposed,
              error: error && error.message ? error.message : String(error),
            });
          }
        }
      }
    }

    if (existing && rowsEquivalent(existing, line.target_row)) {
      if (!backfilled) writeSummary.unchanged += 1;
      continue;
    }
    if (dryRun) {
      if (existing) writeSummary.updated += 1;
      else writeSummary.created += 1;
      continue;
    }
    try {
      if (existing) {
        const patchPayload = filterPatchToOwnedFields({
          phase: INGEST_PHASE,
          table: INGEST_TABLE,
          salesChannel: INGEST_SALES_CHANNEL,
          patch: line.target_row,
        });
        applyTerminalReviewInvariant(patchPayload);
        delete patchPayload[ORDER_FIELD_NAMES.shippingCarrier];
        delete patchPayload[ORDER_FIELD_NAMES.shippingTrackingInfo];
        if (guardTerminalOrderStatusRegression(existing, patchPayload)) {
          writeSummary.guarded_terminal_regressions += 1;
        }
        if (Object.keys(patchPayload).length === 0) {
          if (!backfilled) writeSummary.unchanged += 1;
          continue;
        }
        const res = await patchRow(client, tableId, existing.id, patchPayload);
        if (!res.ok) throw new Error(res.error || `patch_failed_${res.status}`);
        writeSummary.updated += 1;
        existingByKey.set(line.line_key_proposed, { ...existing, ...patchPayload });
      } else {
        const createPayload = { ...line.target_row, sales_channel: INGEST_SALES_CHANNEL.toLowerCase() };
        const res = await createRow(client, tableId, createPayload);
        if (!res.ok) throw new Error(res.error || `create_failed_${res.status}`);
        writeSummary.created += 1;
        const createdRow = res.body && typeof res.body === "object" ? { ...createPayload, id: res.body.id } : { ...createPayload };
        existingByKey.set(line.line_key_proposed, createdRow);
      }
    } catch (error) {
      writeSummary.failed += 1;
      writeSummary.sample.push({
        line_key_proposed: line.line_key_proposed,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  // Cleanup: remove stale lines for orders we just refreshed (prevents phantom extra SKUs)
  for (const [orderId, skuSet] of skuByOrderId.entries()) {
    if (!orderId || !skuSet || !skuSet.size) continue;
    const stale = [];
    for (const [key, existing] of existingByKey.entries()) {
      const existingOrderId = normalizeOrderIdCandidate(existing && existing[ORDER_FIELD_NAMES.orderId]);
      if (existingOrderId !== orderId) continue;
      if (!guardCrossShop(existing, shopId, ORDER_FIELD_NAMES)) continue;
      // Never delete operator-added component lines. Stale cleanup is only for
      // marketplace lines that Mercari no longer reports for this order.
      if (isOperatorComponentRow(existing)) continue;
      const existingSku = normalizeText(existing && existing[ORDER_FIELD_NAMES.originalProductId]);
      if (!existingSku || skuSet.has(existingSku)) continue;
      stale.push({ key, rowId: existing.id, sku: existingSku });
    }
    for (const item of stale) {
      if (dryRun) {
        totals.skipped += 1;
        continue;
      }
      const res = await deleteRow(client, tableId, item.rowId);
      if (!res.ok) {
        writeSummary.failed += 1;
        writeSummary.sample.push({ order_id: orderId, stale_sku: item.sku, error: res.error || `delete_failed_${res.status}` });
        continue;
      }
      existingByKey.delete(item.key);
      writeSummary.updated += 1;
    }
  }

  // ── Terminal status sync ──────────────────────────────────────────────
  // After syncing active orders, detect orders that completed on Mercari
  // but were invisible to the main query (WAITING_FOR_SHIPPING /
  // WAITING_FOR_PAYMENT).  This handles seller-fulfilled (Mercari-handled
  // shipping) orders and orders closed by a prior close_shop_orders run.
  if (!orderIdFilter) try {
    await syncTerminalOrderStatuses({
      shopLabel, shopId, token,
      client, tableId,
      existingByKey, dryRun, writeSummary,
    });
  } catch (error) {
    writeSummary.sample.push({
      error: `terminal_sync_failed:${error && error.message ? error.message : String(error)}`,
    });
  }

  return writeSummary;
}

export function selectExactMercariTransaction(transaction, orderId) {
  const expected = normalizeOrderIdCandidate(orderId);
  return expected && normalizeOrderIdCandidate(transaction?.id) === expected ? transaction : null;
}

/**
 * After the main sync of active orders, query Mercari for recently
 * COMPLETED (and COMPLETING) orders and patch any Baserow rows that are
 * still in a non-terminal status.  This catches orders that completed
 * outside the normal pipeline (seller-fulfilled Mercari shipping) or
 * orders that were closed by a prior close_shop_orders run and are no
 * longer visible to the WAITING_FOR_SHIPPING/WAITING_FOR_PAYMENT query.
 */
async function syncTerminalOrderStatuses({
  shopLabel, shopId, token,
  client, tableId,
  existingByKey, dryRun, writeSummary,
}) {
  const MAX_PAGES = 5; // safety cap; normally 1 page is enough
  const seenOrderIds = new Set();
  let after = null;
  let pageCount = 0;
  let matchCount = 0; // per-page match count for early-stop

  do {
    pageCount += 1;
    matchCount = 0;

    const res = await mercariGraphQL({
      token,
      query: MERCARI_QUERY,
      variables: { first: 100, after, statuses: TERMINAL_STATUSES },
    });

    const conn = res.data && res.data.orderTransactions
      ? res.data.orderTransactions : null;
    if (!conn) break;

    const edges = Array.isArray(conn.edges) ? conn.edges : [];

    for (const node of edges.map((e) => e && e.node).filter(Boolean)) {
      const mercariOrderId = normalizeOrderIdCandidate(node && node.id);
      if (!mercariOrderId || seenOrderIds.has(mercariOrderId)) continue;
      seenOrderIds.add(mercariOrderId);

      // Collect ALL Baserow rows sharing this orderId (multi-line orders)
      const orderRows = [];
      for (const [key, existing] of existingByKey.entries()) {
        const existingOrderId = normalizeOrderIdCandidate(
          existing && existing[ORDER_FIELD_NAMES.orderId],
        );
        if (existingOrderId === mercariOrderId) {
          if (!guardCrossShop(existing, shopId, ORDER_FIELD_NAMES)) continue;
          orderRows.push({ key, existing });
        }
      }
      if (orderRows.length === 0) {
        continue;
      }
      matchCount += orderRows.length;

      for (const { key, existing } of orderRows) {
        const existingStatus = normalizeComparable(
          existing[ORDER_FIELD_NAMES.orderStatus],
        );
        // Skip rows already in terminal states
        if (statusEquals(existingStatus, MERCARI_API_STATUS.COMPLETED) || statusEquals(existingStatus, MERCARI_API_STATUS.CANCELED)) {
          continue;
        }

        // COMPLETING → COMPLETED (no COMPLETING option in Baserow)
        const targetStatus = "COMPLETED";

        if (dryRun) {
          writeSummary.terminal_status_candidates += 1;
          continue;
        }

        // review_status is operator-owned while an order is active, but terminal
        // transitions clear it as part of the same lifecycle write.
        const statusPatch = buildTerminalStatusPatch(targetStatus);
        if (Object.keys(statusPatch).length === 0) continue;

        const statusRes = await patchRow(client, tableId, existing.id, statusPatch);
        if (!statusRes.ok) {
          writeSummary.failed += 1;
          writeSummary.sample.push({
            line_key_proposed: key,
            error: `terminal_status_patch_failed:${statusRes.error || statusRes.status}`,
          });
          continue;
        }
        existingByKey.set(key, { ...existing, ...statusPatch });
        writeSummary.updated += 1;

      }
    }

    after = conn.pageInfo && conn.pageInfo.hasNextPage
      ? String(conn.pageInfo.endCursor || "") : null;
    // Stop paginating if no more pages, or if this page found zero
    // matching Baserow rows (since Mercari returns most-recent-first,
    // older pages are unlikely to match).
  } while (after && pageCount < MAX_PAGES && matchCount > 0);
}

export function buildTerminalStatusPatch(targetStatus) {
  const statusPatch = filterPatchToOwnedFields({
    phase: INGEST_PHASE,
    table: INGEST_TABLE,
    salesChannel: INGEST_SALES_CHANNEL,
    patch: { [ORDER_FIELD_NAMES.orderStatus]: targetStatus },
  });
  return applyTerminalReviewInvariant(statusPatch);
}

export function applyTerminalReviewInvariant(patchPayload) {
  const status = patchPayload && patchPayload[ORDER_FIELD_NAMES.orderStatus];
  if (
    statusEquals(status, MERCARI_API_STATUS.COMPLETED)
    || statusEquals(status, MERCARI_API_STATUS.CANCELED)
  ) {
    patchPayload[ORDER_FIELD_NAMES.reviewStatus] = null;
  }
  return patchPayload;
}

function normalizeTransaction(transaction, shopId) {
  const lines = [];
  const orderId = normalizeOrderIdCandidate(transaction && transaction.id);
  const status = String(transaction && transaction.status ? transaction.status : "").trim();
  const resolvedShopId = normalizeText(shopId || (transaction && transaction.shop_id ? transaction.shop_id : ""));
  const purchaseDate = formatBaserowDateTime(transaction && transaction.createdAt);
  const paymentDate = transaction && transaction.paidAt ? formatBaserowDateTime(transaction.paidAt) : null;
  const shippingAddress = transaction && transaction.shippingAddress ? transaction.shippingAddress : null;
  const shippingName = buildFullName(shippingAddress);
  const billingName = shippingName;
  const products = Array.isArray(transaction && transaction.products) ? transaction.products : [];

  const msgFacts = extractBuyerMessageFacts(transaction && transaction.messages);
  const nowIso = toJstIso(new Date());

  for (const product of products) {
    const sku = normalizeSkuCandidate(product && product.variant ? product.variant.skuCode : "");
    const lineKeyProposed = makeRowKey(resolvedShopId, orderId, sku);
    lines.push({
      line_key_proposed: lineKeyProposed,
      target_row: {
        [ORDER_FIELD_NAMES.orderId]: orderId,
        [ORDER_FIELD_NAMES.purchaseDate]: purchaseDate,
        [ORDER_FIELD_NAMES.paymentDate]: paymentDate,
        [ORDER_FIELD_NAMES.buyerName]: shippingName,
        [ORDER_FIELD_NAMES.originalProductId]: sku,
        [ORDER_FIELD_NAMES.b2bItemCode]: mercariResolveItemCode(sku).code || "",
        [ORDER_FIELD_NAMES.productName]: normalizeText(product && product.name),
        [ORDER_FIELD_NAMES.quantity]: toStringOrEmpty(product && (product.unshippedQuantity ?? product.purchasedQuantity)),
        [ORDER_FIELD_NAMES.currency]: "JPY",
        [ORDER_FIELD_NAMES.productPrice]: toStringOrEmpty(product && product.unitPrice),
        [ORDER_FIELD_NAMES.productTax]: "0",
        [ORDER_FIELD_NAMES.shippingPrice]: toStringOrEmpty(product && product.buyerShippingFee),
        [ORDER_FIELD_NAMES.shippingTax]: "0",
        [ORDER_FIELD_NAMES.shippingMethod]: mapShippingMethod(product && product.shippingMethod),
        [ORDER_FIELD_NAMES.shippingCarrier]: "",
        [ORDER_FIELD_NAMES.shippingTrackingInfo]: "",
        [ORDER_FIELD_NAMES.shippingDuration]: "",
        [ORDER_FIELD_NAMES.requestedDeliveryDate]: "",
        [ORDER_FIELD_NAMES.requestedDeliveryTime]: "",
        [ORDER_FIELD_NAMES.shippingCountry]: normalizeCountryCode(shippingAddress && shippingAddress.country),
        [ORDER_FIELD_NAMES.shippingPostalCode]: normalizePostalCode(shippingAddress && shippingAddress.postalCode),
        [ORDER_FIELD_NAMES.shippingState]: normalizeText(shippingAddress && shippingAddress.state ? shippingAddress.state.name : ""),
        [ORDER_FIELD_NAMES.shippingCity]: normalizeText(shippingAddress && shippingAddress.city),
        [ORDER_FIELD_NAMES.shippingAddress1]: normalizeText(shippingAddress && shippingAddress.address1),
        [ORDER_FIELD_NAMES.shippingAddress2]: normalizeText(shippingAddress && shippingAddress.address2),
        [ORDER_FIELD_NAMES.shippingName]: shippingName,
        [ORDER_FIELD_NAMES.billingCountry]: normalizeCountryCode(shippingAddress && shippingAddress.country),
        [ORDER_FIELD_NAMES.billingPostalCode]: normalizePostalCode(shippingAddress && shippingAddress.postalCode),
        [ORDER_FIELD_NAMES.billingState]: normalizeText(shippingAddress && shippingAddress.state ? shippingAddress.state.name : ""),
        [ORDER_FIELD_NAMES.billingCity]: normalizeText(shippingAddress && shippingAddress.city),
        [ORDER_FIELD_NAMES.billingAddress1]: normalizeText(shippingAddress && shippingAddress.address1),
        [ORDER_FIELD_NAMES.billingAddress2]: normalizeText(shippingAddress && shippingAddress.address2),
        [ORDER_FIELD_NAMES.billingName]: billingName,
        [ORDER_FIELD_NAMES.shippingPhoneNumber]: normalizePhone(shippingAddress && shippingAddress.phoneNumber),
        [ORDER_FIELD_NAMES.couponDiscountAmount]: "0",
        [ORDER_FIELD_NAMES.couponId]: "",
        [ORDER_FIELD_NAMES.orderType]: normalizeText(transaction && transaction.orderType),
        [ORDER_FIELD_NAMES.orderStatus]: status,
        [ORDER_FIELD_NAMES.shopId]: resolvedShopId,
        [ORDER_FIELD_NAMES.orderComments]: "",
        [ORDER_FIELD_NAMES.reviewStatus]: statusEquals(status, MERCARI_API_STATUS.WAITING_FOR_PAYMENT) || statusEquals(status, MERCARI_API_STATUS.CANCELED) ? null : "Pending Review",
        [ORDER_FIELD_NAMES.latestBuyerMessageId]: msgFacts.latest_buyer_message_id,
        [ORDER_FIELD_NAMES.latestBuyerMessageAt]: msgFacts.latest_buyer_message_at,
        [ORDER_FIELD_NAMES.hasBuyerMessages]: msgFacts.has_buyer_messages ? "true" : "false",
        [ORDER_FIELD_NAMES.messageLastSyncedAt]: nowIso,
      },
      source_transaction_id: orderId,
      source_sku: sku,
      status,
    });
  }

  return {
    transaction_id: orderId,
    status,
    lines,
  };
}

function rowsEquivalent(existingRow, targetRow) {
  for (const key of Object.keys(targetRow)) {
    if (!INGEST_OWNED_FIELDS.has(key)) continue;
    const left = normalizeComparable(existingRow ? existingRow[key] : "");
    const right = normalizeComparable(targetRow[key]);
    if (left !== right) return false;
  }
  return true;
}

function guardTerminalOrderStatusRegression(existingRow, patchPayload) {
  if (!statusEquals(existingRow && existingRow[ORDER_FIELD_NAMES.orderStatus], MERCARI_API_STATUS.COMPLETED) ||
      !statusEquals(patchPayload && patchPayload[ORDER_FIELD_NAMES.orderStatus], MERCARI_API_STATUS.WAITING_FOR_SHIPPING)) {
    return false;
  }

  const existingShopCloseStatus = normalizeComparable(existingRow && existingRow[ORDER_FIELD_NAMES.shopCloseStatus]);
  const existingShippingCompletedAt = normalizeComparable(existingRow && existingRow[ORDER_FIELD_NAMES.shippingCompletedAt]);
  if (existingShopCloseStatus !== "Completed" && !existingShippingCompletedAt) return false;

  delete patchPayload[ORDER_FIELD_NAMES.orderStatus];
  return true;
}

function normalizeComparable(value) {
  if (value === null || value === undefined) return "";
  // Baserow single_select fields come as {id, value, color} objects
  if (typeof value === "object" && value.value !== undefined) return String(value.value).replace(/\r\n/g, "\n").trim();
  return String(value).replace(/\r\n/g, "\n").trim();
}

function mapShippingMethod(value) {
  const s = normalizeText(value);
  if (!s) return "";
  if (s === "UNDECIDED") return "未定(出品者が手配)";
  return s;
}

function normalizeCountryCode(value) {
  const s = normalizeText(value);
  if (!s) return "";
  return s.toUpperCase();
}

function normalizePostalCode(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function normalizePhone(value) {
  return normalizeText(value).replace(/[^\d+]/g, "");
}

function buildFullName(shippingAddress) {
  if (!shippingAddress || typeof shippingAddress !== "object") return "";
  const lastName = normalizeText(shippingAddress.lastName);
  const firstName = normalizeText(shippingAddress.firstName);
  return `${lastName}${firstName}`.trim();
}

export function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\r\n/g, "\n").trim();
}

/**
 * Cross-shop isolation guard.  Returns true when `existingRow` belongs to
 * `shopId`, false when it belongs to a different shop (or has no shop_id).
 *
 * Used by both the stale-cleanup deletion loop and the terminal-
 * reconciliation patch loop to prevent cross-shop mutation from an
 * order-ID collision.
 */
export function guardCrossShop(existingRow, shopId, fieldNames) {
  const existingShopId = normalizeText(existingRow && existingRow[fieldNames.shopId]);
  return existingShopId === normalizeText(shopId);
}

/**
 * Whether a sales row is an operator-added fulfillment component line.
 * Stale cleanup must never delete these rows — they are not Mercari-reported
 * marketplace lines and therefore never appear in a refreshed Mercari SKU set.
 */
export function isOperatorComponentRow(row) {
  return normalizeText(row && row.line_origin) === "operator_component";
}

function toStringOrEmpty(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeSkuCandidate(value) {
  return normalizeText(value);
}

function normalizeOrderIdCandidate(value) {
  const s = normalizeText(value);
  if (!s) return "";
  return s.replace(/^order_/, "");
}

export function makeRowKey(shopId, orderId, sku) {
  const shop = normalizeText(shopId);
  const left = normalizeOrderIdCandidate(orderId);
  const right = normalizeSkuCandidate(sku);
  if (!left || !right) return "";
  return `${shop}::${left}::${right}`;
}

function formatBaserowDateTime(value) {
  return toJstIso(value);
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

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs",
    "  node scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs --dry-run",
    "",
    "Optional:",
    "  --shops Shop1,Shop2,Shop3,Shop4",
    "  --statuses WAITING_FOR_SHIPPING,WAITING_FOR_PAYMENT",
    "  --order-id <exact-order-id> (requires exactly one --shops value)",
    "  --table-id 903318",
    "  --tokens-path /path/to/Mercari_API_Tokens_Private_2026-04-01.md",
    "",
    "Environment:",
    "  BASEROW_DATABASE_TOKEN",
    "  BASEROW_API_BASE",
    "  BASEROW_MERCARI_SALES_ORDER_TABLE_ID",
    "  MERCARI_BASEROW_ENV_PATH",
    "  MERCARI_TOKENS_PATH",
    "  MERCARI_SSH_HOST",
    "  MERCARI_SSH_KEY",
    "  MERCARI_API_CLIENT_NAME",
    "  MERCARI_API_CLIENT_VERSION",
  ].join("\n"));
}

function normalizeShopFilter(value) {
  return String(value || "")
    .split(/[,\s;]+/g)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeStatusFilter(value) {
  const items = String(value || "")
    .split(/[,\s;]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : DEFAULT_STATUSES.slice();
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    const resolved = String(candidate || "").trim();
    if (!resolved) continue;
    try {
      readFileSync(resolved, "utf8");
      return resolved;
    } catch {
      // continue
    }
  }
  return String(paths && paths[0] ? paths[0] : "").trim();
}

function loadEnvFileIfPresent(filePath) {
  try {
    if (process.env.SUPABASE_URL) return;
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

async function loadShopSecrets(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const shops = new Map();
  let currentLabel = "";
  let currentShopId = "";
  let currentToken = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(SHOP_FIELD_RE);
    if (labelMatch) {
      if (currentLabel && currentShopId && currentToken) {
        shops.set(currentLabel, { shopId: currentShopId, token: currentToken });
      }
      currentLabel = labelMatch[1];
      currentShopId = "";
      currentToken = "";
      continue;
    }
    const idMatch = line.match(SHOP_ID_RE);
    if (idMatch) {
      currentShopId = idMatch[1].trim();
      continue;
    }
    const tokenMatch = line.match(SHOP_TOKEN_RE);
    if (tokenMatch) {
      currentToken = tokenMatch[1].trim();
      continue;
    }
  }
  if (currentLabel && currentShopId && currentToken) {
    shops.set(currentLabel, { shopId: currentShopId, token: currentToken });
  }
  return shops;
}


async function mercariGraphQL({ token, query, variables }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await runRemoteGraphQL({
        token,
        query,
        variables,
      });
      if (response.errors && Array.isArray(response.errors) && response.errors.length) {
        throw new Error(`Mercari GraphQL error: ${JSON.stringify(response.errors)}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isRetryableMercariError(error)) {
        throw error;
      }
      await delay(1000 * attempt);
    }
  }
  throw lastError || new Error("Mercari GraphQL failed");
}

async function runRemoteGraphQL({ token, query, variables }) {
  const execMode = resolveMercariExecMode();
  if (execMode === "direct") {
    return await runDirectGraphQL({ token, query, variables });
  }

  const host = String(process.env.MERCARI_SSH_HOST || DEFAULT_SSH_HOST).trim();
  const sshKey = String(process.env.MERCARI_SSH_KEY || DEFAULT_SSH_KEY).trim();
  const clientName = String(process.env.MERCARI_API_CLIENT_NAME || DEFAULT_API_CLIENT_NAME).trim();
  const clientVersion = String(process.env.MERCARI_API_CLIENT_VERSION || DEFAULT_API_CLIENT_VERSION).trim();

  const remoteScript = [
    "curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql'",
    `-H ${shellQuote(`Authorization: Bearer ${token}`)}`,
    "-H 'Content-Type: application/json'",
    `-H ${shellQuote(`User-Agent: ${clientName}/${clientVersion}`)}`,
    "--data-binary @-",
  ].join(" ");

  const input = JSON.stringify({
    query,
    variables,
  });

  const output = await spawnPromise("ssh", ["-i", sshKey, "-o", "BatchMode=yes", host, remoteScript], input);
  const trimmed = String(output.stdout || "").trim();
  if (!trimmed) {
    throw new Error(`Empty Mercari response: ${String(output.stderr || "").trim() || "no output"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Mercari response was not JSON: ${trimmed.slice(0, 300)}`);
  }
  if (parsed && parsed.errors && parsed.errors.length) {
    throw new Error(`Mercari GraphQL returned errors: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed;
}

function resolveMercariExecMode() {
  const explicit = String(process.env.MERCARI_EXEC_MODE || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (SCRIPT_DIR.startsWith("/opt/rp-order-mgmt/")) return "direct";
  return "";
}

async function runDirectGraphQL({ token, query, variables }) {
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
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      input: payload,
    }
  );
  if (result.status !== 0) {
    throw new Error(`Mercari direct request failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  const trimmed = String(result.stdout || "").trim();
  if (!trimmed) {
    throw new Error("Mercari direct request returned empty body");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Mercari direct response was not JSON: ${trimmed.slice(0, 300)}`);
  }
  if (parsed && parsed.errors && parsed.errors.length) {
    throw new Error(`Mercari GraphQL returned errors: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed;
}

function isRetryableMercariError(error) {
  const message = String(error && error.message ? error.message : error || "");
  return (
    message.includes("not JSON") ||
    message.includes("upstream") ||
    message.includes("Not Found") ||
    message.includes("fetch failed") ||
    message.includes("Command failed")
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnPromise(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed (${command} ${args.join(" ")}): ${stderr.trim() || stdout.trim() || `exit_${code}`}`));
      }
    });
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}
