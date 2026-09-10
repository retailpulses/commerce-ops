#!/usr/bin/env node

/**
 * scripts/migrate-to-supabase.mjs
 *
 * Data migration: reads all rows from Baserow sales and shipment tables,
 * transforms to the Supabase schema, and writes via upsert.
 *
 * Usage:
 *   node scripts/migrate-to-supabase.mjs [--options]
 *
 * Environment variables (required):
 *   BASEROW_DATABASE_TOKEN     — Baserow API token
 *   SUPABASE_URL               — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service_role key (bypasses RLS)
 *
 * Environment variables (optional):
 *   BASEROW_API_BASE              — default https://api.baserow.io/api
 *   BASEROW_MERCARI_SALES_ORDER_TABLE_ID   — default 903318
 *   BASEROW_GIGA_SHIPMENT_ORDER_TABLE_ID  — default 903319
 *   BASEROW_RAKUTEN_SALES_ORDER_TABLE_ID  — default 1015675
 *   BASEROW_RAKUTEN_DATABASE_TOKEN        — separate token if Rakuten table
 *                                           is in a different Baserow DB
 *
 * CLI flags:
 *   --dry-run=true|false
 *                   Read and transform; show report; do NOT write to Supabase
 *   --limit N       Max rows to migrate per table (default 100, 0 = no limit)
 *   --confirm       Require explicit "yes" confirmation before writing
 *   --verbose       Show per-row diffs in dry-run mode
 *   --tables list   Comma-separated: sales_orders,giga_shipment_projections
 *                   (default: both)
 *   --overwrite-existing-sales
 *                   Allow Baserow values to replace existing Supabase sales
 *                   rows. Disabled by default after cutover.
 *   --propagate-terminal-statuses
 *                   Update only order_status and review_status on existing
 *                   terminal sales rows after the insert-only bridge pass.
 *
 * Safety:
 *   By default, the script operates in read-only mode (dry-run). To actually
 *   write data, pass BOTH --dry-run=false AND --confirm.
 */

import { parseArgs } from "node:util";
import { createBaserowClient as createBaserow, listAllRows, listRowsWithLimit } from "../src/lib/baserow.mjs";
import { createBaserowClient as createSupabase } from "../src/lib/supabase.mjs";
import { readSelectValue } from "../src/lib/order-state.mjs";

// ============================================================================
// CLI arg parsing
// ============================================================================

const { values: cli } = parseArgs({
  options: {
    "dry-run":  { type: "string", short: "d", default: "true" },
    limit:      { type: "string",  short: "l", default: "100" },
    confirm:    { type: "boolean", short: "c", default: false },
    "non-interactive": { type: "boolean", default: false },
    verbose:    { type: "boolean", short: "v", default: false },
    "overwrite-existing-sales": { type: "boolean", default: false },
    "propagate-terminal-statuses": { type: "boolean", default: false },
    tables:     { type: "string",  short: "t", default: "sales_orders,giga_shipment_projections" },
  },
});

function parseBooleanOption(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

const DRY_RUN  = parseBooleanOption(cli["dry-run"], true);
const LIMIT    = (() => { const v = parseInt(cli.limit ?? "100", 10); return Number.isFinite(v) ? Math.max(0, v) : 100; })();
const CONFIRM  = cli.confirm === true;
const NON_INTERACTIVE = cli["non-interactive"] === true;
const VERBOSE  = cli.verbose === true;
const OVERWRITE_EXISTING_SALES = cli["overwrite-existing-sales"] === true;
const PROPAGATE_TERMINAL_STATUSES = cli["propagate-terminal-statuses"] === true;
const TABLES   = new Set(
  (cli.tables || "sales_orders,giga_shipment_projections")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// ============================================================================
// Helpers
// ============================================================================

function text(value) {
  return value == null ? "" : String(value).trim();
}

function readNumeric(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readSelectOrText(raw) {
  // Baserow single-select: { id, value, color }
  // Plain text: anything else
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && raw !== null) {
    const v = readSelectValue(raw);
    return v || null;
  }
  return String(raw).trim() || null;
}

function toTimestamp(raw) {
  if (!raw || raw === "") return null;
  const str = typeof raw === "object" ? readSelectValue(raw) : String(raw).trim();
  if (!str) return null;
  const d = new Date(str);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toBoolean(raw) {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

// ============================================================================
// Status value mappers (Baserow display → Supabase enum)
// ============================================================================

const REVIEW_STATUS_MAP = {
  "pending review": "PENDING_REVIEW",
  "approved": "APPROVED",
  "auto-approved": "AUTO_APPROVED",
  "on hold": "ON_HOLD",
};

export function mapReviewStatus(raw, orderStatus) {
  const normalizedOrderStatus = String(readSelectOrText(orderStatus) || "").trim().toUpperCase();
  if (normalizedOrderStatus === "COMPLETED" || normalizedOrderStatus === "CANCELED") return null;
  const display = readSelectOrText(raw);
  if (!display) return "PENDING_REVIEW";
  const key = display.trim().toLowerCase();
  return REVIEW_STATUS_MAP[key] || "PENDING_REVIEW";
}

const GIGA_SYNC_STATUS_MAP = {
  "synced": "SYNCED",
  "already exists": "ALREADY_EXISTS",
  "invalid": "INVALID",
  "error": "ERROR",
  "attempted": "ATTEMPTED",
};

function mapGigaSyncStatus(raw) {
  const display = readSelectOrText(raw);
  if (!display) return "PENDING";
  const key = display.trim().toLowerCase();
  return GIGA_SYNC_STATUS_MAP[key] || display;
}

// ============================================================================
// Tracking info parser
// Extracts tracking numbers from "Carrier: 1234567890; Carrier2: 0987654321"
// ============================================================================

function parseTrackingNumbers(raw) {
  const s = text(raw);
  if (!s) return "";
  // Try splitting by semicolon first (the standard format)
  const semicolonParts = s.split(";");
  if (semicolonParts.length > 1) {
    const numbers = semicolonParts
      .map((part) => {
        // Each part: "Carrier: 1234567890" — extract after ": "
        const colonIdx = part.indexOf(":");
        if (colonIdx >= 0) return part.slice(colonIdx + 1).trim();
        return part.trim();
      })
      .filter(Boolean);
    if (numbers.length > 0) return numbers.join(" / ");
  }
  // If no semicolon, try "Carrier / Carrier" format (carrier summary in tracking detail)
  // This is the carrierSummary format — not a tracking number.
  // Return the raw value as-is
  return s;
}

// ============================================================================
// Review status parser — extract carrier + number from shipping_tracking_info
// and return { carrier, tracking_number }
// ============================================================================

function parseTrackingFields(carrierRaw, infoRaw) {
  return {
    tracking_carrier: text(carrierRaw) || null,
    tracking_number: parseTrackingNumbers(infoRaw) || null,
  };
}

// ============================================================================
// Transform: Baserow sales row → Supabase sales_orders row
// ============================================================================

export function transformSalesRow(row, salesChannel, accountMap, fieldSuffix) {
  // fieldSuffix is used so both Mercari and Rakuten can use this function
  // Both tables use the same snake_case field names

  const sourceStoreId = text(row.shop_id || row.source_store_id);
  const accountId = accountMap.get(sourceStoreId) || null;

  const tracking = parseTrackingFields(
    row.shipping_carrier,
    row.shipping_tracking_info,
  );

  const orderStatus = readSelectOrText(row.order_status) || "WAITING_FOR_PAYMENT";
  const mapped = {
    // Identity
    order_id: text(row.order_id) || null,
    sales_channel: salesChannel,
    source_store_id: sourceStoreId || null,
    platform_account_id: accountId,

    // Status
    order_status: orderStatus,
    review_status: mapReviewStatus(row.review_status, orderStatus),

    // Product
    product_name: text(row.product_name) || null,
    b2b_item_code: text(row.B2BItemCode) || text(row.b2b_item_code) || null,
    original_product_id: text(row.original_product_id) || null,
    quantity: readNumeric(row.quantity) ?? 1,
    product_price: readNumeric(row.product_price),
    shipping_price: readNumeric(row.shipping_price),

    // Shipping address
    shipping_name: text(row.shipping_name) || null,
    shipping_postal_code: text(row.shipping_postal_code) || null,
    shipping_state: text(row.shipping_state) || null,
    shipping_city: text(row.shipping_city) || null,
    shipping_address_1: text(row.shipping_address_1) || null,
    shipping_address_2: text(row.shipping_address_2) || null,
    shipping_phone_number: text(row.shipping_phone_number) || null,
    shipping_method: text(row.shipping_method) || null,

    // Tracking (from Giga tracking storage in Baserow)
    tracking_carrier: tracking.tracking_carrier,
    tracking_number: tracking.tracking_number,
    shipping_completed_at: toTimestamp(row.shipping_completed_at),

    // Delivery preferences
    requested_delivery_date: text(row.requested_delivery_date) || null,
    requested_delivery_time: text(row.requested_delivery_time) || null,

    // Buyer
    buyer_name: text(row.buyer_name) || null,
    order_comments: text(row.order_comments) || null,

    // Close status
    shop_close_status: text(row.shop_close_status) || null,
    shop_close_attempted_at: toTimestamp(row.shop_close_attempted_at),
    shop_close_completed_at: toTimestamp(row.shop_close_completed_at),
    shop_close_error: text(row.shop_close_error) || null,

    // Auto-approval
    auto_approval_rule: text(row.auto_approval_rule) || null,
    auto_approved_at: toTimestamp(row.auto_approved_at),

    // Purchase date
    purchase_date: toTimestamp(row.purchase_date),

    // Variant_id — not resolved here (post-migration)
    variant_id: null,
  };

  // Remove null/undefined fields that have defaults in the DB
  // to let Supabase apply its defaults (e.g. has_unread_messages defaults to false)
  return Object.fromEntries(
    Object.entries(mapped).filter(([k, v]) => {
      // Always include identity and review status. Terminal review_status must
      // remain an explicit null so upsert clears an existing queue value.
      if (k === "order_id" || k === "sales_channel" || k === "source_store_id" || k === "review_status") return true;
      // Keep non-null values
      if (v != null) return true;
      return false;
    }),
  );
}

function dedupeSalesRows(rows) {
  const byIdentity = new Map();
  for (const row of rows) {
    if (!row.order_id || !row.sales_channel) continue;
    const key = [
      row.sales_channel,
      row.order_id,
      row.source_store_id || "",
      row.product_name || "",
    ].join("\u0000");
    // Baserow can contain duplicate logical rows. Keep the last row from the
    // source ordering so each Postgres ON CONFLICT key occurs once per batch.
    byIdentity.set(key, row);
  }
  return [...byIdentity.values()];
}

// ============================================================================
// Transform: Baserow Rakuten sales row → Supabase sales_orders row
// ============================================================================

function transformRakutenSalesRow(row, accountMap) {
  // Rakuten doesn't have a shop_id; use "Rakuten" constant
  const sourceStoreId = "Rakuten";
  const accountId = accountMap.get(sourceStoreId) || null;

  const mapped = {
    order_id: text(row.order_id) || null,
    sales_channel: "rakuten",
    source_store_id: sourceStoreId,
    platform_account_id: accountId,

    order_status: readSelectOrText(row.order_status) || "PENDING_CONFIRMATION",
    review_status: mapReviewStatus(null, row.order_status),

    product_name: text(row.product_name) || null,
    b2b_item_code: text(row.b2b_item_code) || null,
    quantity: readNumeric(row.quantity) ?? 1,
    product_price: readNumeric(row.product_price),

    shipping_name: text(row.shipping_name) || null,
    shipping_postal_code: text(row.shipping_postal_code) || null,
    shipping_state: text(row.shipping_state) || null,
    shipping_city: text(row.shipping_city) || null,
    shipping_address_1: text(row.shipping_address_1) || null,
    shipping_address_2: text(row.shipping_address_2) || null,
    shipping_phone_number: text(row.shipping_phone_number) || null,

    shipping_completed_at: toTimestamp(row.shipping_completed_at),

    buyer_name: text(row.buyer_name) || null,
    order_comments: text(row.order_comments) || null,
    purchase_date: toTimestamp(row.purchase_date),

    variant_id: null,
  };

  return Object.fromEntries(
    Object.entries(mapped).filter(([k, v]) => {
      if (k === "order_id" || k === "sales_channel" || k === "source_store_id" || k === "review_status") return true;
      if (v != null) return true;
      return false;
    }),
  );
}

// ============================================================================
// Transform: Baserow shipment row → Supabase giga_shipment_projections row
// ============================================================================

function transformShipmentRow(row, salesOrderMap) {
  const orderId = text(row.OrderId) || "";
  const sourceStoreId = text(row.SourceStoreID) || "";
  const rawChannel = text(row.SalesChannel) || "Mercari";
  const channel = rawChannel.toLowerCase();
  const orderFrom = text(row.ShipFrom) || "";

  // Build lookup key for sales order
  const lookupKey = `${orderId}::${sourceStoreId}::${channel}`;
  const salesOrderId = salesOrderMap.get(lookupKey) || null;

  const tracking = parseTrackingFields(
    row.giga_carrier_name,
    row.giga_tracking_info,
  );

  const gigaStatus = mapGigaSyncStatus(row.giga_sync_status);

  const mapped = {
    sales_order_id: salesOrderId,
    order_id: orderId,
    sales_channel: channel,
    source_store_id: sourceStoreId,

    giga_sync_status: gigaStatus,
    giga_sync_attempted_at: toTimestamp(row.giga_sync_attempted_at),
    giga_sync_processed_at: toTimestamp(row.giga_sync_processed_at),
    giga_sync_request_id: text(row.giga_sync_request_id) || null,
    giga_sync_error: text(row.giga_sync_error) || null,

    // GigaB2B fields
    order_from: orderFrom,
    b2b_item_code: text(row.B2BItemCode) || null,
    ship_to_qty: readNumeric(row.ShipToQty),
    ship_to_name: text(row.ShipToName) || null,
    ship_to_phone: text(row.ShipToPhone) || null,
    ship_to_postal_code: text(row.ShipToPostalCode) || null,
    ship_to_address: text(row.ShipToAddressDetail) || null,
    ship_to_city: text(row.ShipToCity) || null,
    ship_to_state: text(row.ShipToState) || null,
    ship_to_country: text(row.ShipToCountry) || null,
    ship_to_service_level: text(row.ShipToServiceLevel) || null,
    buyer_platform_sku: text(row.BuyerPlatformSku) || null,
    buyer_sku_description: text(row.BuyerSkuDescription) || null,
    buyer_sku_commercial_value: readNumeric(row.BuyerSkuCommercialValue),
    order_comments: text(row.OrderComments) || null,
    order_date: toTimestamp(row.OrderDate),
    requested_delivery_date: text(row.RequestedDeliveryDate) || null,

    // Tracking
    tracking_carrier: tracking.tracking_carrier,
    tracking_number: tracking.tracking_number,
    shipping_completed_at: toTimestamp(row.shipping_completed_at),
  };

  return Object.fromEntries(
    Object.entries(mapped).filter(([k, v]) => {
      if (k === "order_id" || k === "sales_channel" || k === "source_store_id") return true;
      if (v != null) return true;
      return false;
    }),
  );
}

// ============================================================================
// Build lookup maps
// ============================================================================

/**
 * Build a map from Baserow sales row → Supabase upsert result.
 * Reads the transformed payload key from the row data and creates
 * a key → row mapping for sales order resolution.
 */
function buildSalesLookupMap(baserowSalesRows, channel, baserowIdToSupabaseId) {
  const map = new Map();
  for (const baserowRow of baserowSalesRows) {
    const orderId = text(baserowRow.order_id) || "";
    const sourceStoreId = text(baserowRow.shop_id || baserowRow.source_store_id) || "";
    const key = `${orderId}::${sourceStoreId}::${channel}`;
    // We can also map by Baserow numeric ID to find the Supabase UUID
    const baserowId = baserowRow.id;
    const supabaseId = baserowIdToSupabaseId.get(Number(baserowId)) || null;
    if (supabaseId) {
      map.set(key, supabaseId);
    }
  }
  return map;
}

/**
 * Build lookup after inserting into Supabase.
 * Returns Map<"orderId::sourceStoreId::channel" → sales_order_uuid>
 */
function buildSalesOrderLookupFromInserted(insertedRows) {
  const map = new Map();
  for (const row of Array.isArray(insertedRows) ? insertedRows : []) {
    if (!row || !row.id) continue;
    const orderId = text(row.order_id) || "";
    const sourceStoreId = text(row.source_store_id) || "";
    const channel = text(row.sales_channel) || "";
    const key = `${orderId}::${sourceStoreId}::${channel}`;
    map.set(key, row.id);
  }
  return map;
}

// ============================================================================
// Supabase platform_accounts loader
// ============================================================================

async function loadAccountMap(supabaseClient) {
  /** @type {{ data: Array<{ id: string, seller_account_id: string, shop_code: string, platform: string }> | null, error: any }} */
  const { data, error } = await supabaseClient
    .from("platform_accounts")
    .select("id, seller_account_id, shop_code, platform");

  if (error) {
    console.error("WARN: Could not load platform_accounts:", error.message);
    console.error("  → platform_account_id will be null for all rows.");
    return new Map();
  }

  const map = new Map();
  const platformCounts = new Map();
  for (const row of Array.isArray(data) ? data : []) {
    const sellerId = text(row.seller_account_id);
    const shopCode = text(row.shop_code);
    const platform = text(row.platform).toLowerCase();

    if (sellerId) map.set(sellerId, row.id);
    if (shopCode) map.set(shopCode, row.id);
    if (platform) {
      const rows = platformCounts.get(platform) || [];
      rows.push(row);
      platformCounts.set(platform, rows);
    }
  }

  for (const [platform, rows] of platformCounts.entries()) {
    if (rows.length !== 1) continue;
    map.set(platform, rows[0].id);
    map.set(platform[0].toUpperCase() + platform.slice(1), rows[0].id);
  }

  console.log(`Loaded ${map.size} platform_account mappings`);
  return map;
}

// ============================================================================
// Batch upsert
// ============================================================================

async function upsertBatch(supabaseClient, table, rows, onConflict, { overwriteExisting = true } = {}) {
  if (!rows.length) return { inserted: 0, errors: 0, errorItems: [] };

  const { data, error } = await supabaseClient
    .from(table)
    .upsert(rows, {
      onConflict,
      ignoreDuplicates: !overwriteExisting,
    })
    .select();

  if (error) {
    return { inserted: 0, errors: rows.length, errorItems: [{ error: error.message, count: rows.length }] };
  }

  return {
    inserted: Array.isArray(data) ? data.length : 0,
    errors: 0,
    errorItems: [],
    data: Array.isArray(data) ? data : [],
  };
}

export async function propagateTerminalSalesStatuses(supabaseClient, rows) {
  const terminalRows = rows
    .filter((row) => {
      const status = String(row?.order_status || "").trim().toUpperCase();
      return status === "COMPLETED" || status === "CANCELED";
    })
    .map((row) => ({ ...row, product_name: row.product_name ?? null }))
    .filter((row) => row.sales_channel && row.order_id && row.source_store_id);

  if (!terminalRows.length) return { updated: 0, errors: 0, errorItems: [], data: [] };

  const existingRows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data: page, error: readError } = await supabaseClient
      .from("sales_orders")
      .select("id,sales_channel,order_id,source_store_id,product_name,order_status,review_status")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (readError) {
      return {
        updated: 0,
        errors: terminalRows.length,
        errorItems: [{ error: `terminal_status_read_failed:${readError.message}`, count: terminalRows.length }],
        data: [],
      };
    }
    const pageRows = Array.isArray(page) ? page : [];
    existingRows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  const identityKey = (row) => [
    row.sales_channel,
    row.order_id,
    row.source_store_id,
    row.product_name ?? "",
  ].join("\u0000");
  const existingByIdentity = new Map(
    existingRows.map((row) => [identityKey(row), row]),
  );
  const updatesByStatus = new Map();
  for (const terminalRow of terminalRows) {
    const existing = existingByIdentity.get(identityKey(terminalRow));
    if (!existing?.id) continue;
    const targetStatus = String(terminalRow.order_status).trim().toUpperCase();
    const currentStatus = String(existing.order_status || "").trim().toUpperCase();
    if (currentStatus === targetStatus && existing.review_status == null) continue;
    const ids = updatesByStatus.get(targetStatus) || [];
    ids.push(existing.id);
    updatesByStatus.set(targetStatus, ids);
  }

  let updated = 0;
  const errorItems = [];
  const data = [];
  for (const [orderStatus, ids] of updatesByStatus) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const idBatch = ids.slice(offset, offset + 100);
      const { data: updatedRows, error } = await supabaseClient
        .from("sales_orders")
        .update({ order_status: orderStatus, review_status: null })
        .in("id", idBatch)
        .select();
      if (error) {
        errorItems.push({ error: error.message, count: idBatch.length });
        continue;
      }
      updated += Array.isArray(updatedRows) ? updatedRows.length : 0;
      if (Array.isArray(updatedRows)) data.push(...updatedRows);
    }
  }

  return {
    updated,
    errors: errorItems.reduce((sum, item) => sum + item.count, 0),
    errorItems,
    data,
  };
}

// ============================================================================
// Pretty printing
// ============================================================================

function formatRowPreview(row) {
  const preview = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "order_id" || k === "product_name" || k === "b2b_item_code" ||
        k === "source_store_id" || k === "sales_channel" || k === "order_status") {
      preview[k] = typeof v === "string" ? v.substring(0, 60) : v;
    }
  }
  return JSON.stringify(preview);
}

// ============================================================================
// Main migration logic
// ============================================================================

async function migrate() {
  console.log("=" .repeat(72));
  console.log("Baserow → Supabase Migration");
  console.log("=" .repeat(72));
  console.log();

  // Validate required env vars
  const requiredVars = ["BASEROW_DATABASE_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length) {
    console.error("ERROR: Missing required env vars:", missing.join(", "));
    console.error("  BASEROW_DATABASE_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }

  const env = process.env;

  console.log("Configuration:");
  console.log(`  Tables:       ${[...TABLES].join(", ") || "(none)"}`);
  console.log(`  Dry run:      ${DRY_RUN}`);
  console.log(`  Limit:        ${LIMIT > 0 ? LIMIT : "no limit"}`);
  console.log(`  Confirm:      ${CONFIRM}`);
  console.log(`  Overwrite existing sales: ${OVERWRITE_EXISTING_SALES}`);
  console.log(`  Propagate terminal statuses: ${PROPAGATE_TERMINAL_STATUSES}`);
  console.log(`  Verbose:      ${VERBOSE}`);
  console.log();

  if (!DRY_RUN && !CONFIRM) {
    console.error("ERROR: Refusing to write without --confirm.");
    console.error("  Default mode is dry-run. To write, pass BOTH --dry-run=false and --confirm.");
    process.exit(1);
  }

  // Initialize clients
  const baserow = createBaserow(env);
  const supabaseClient = createSupabase(env);
  const supabase = supabaseClient.supabase;

  console.log("Backends initialized:");
  console.log(`  Baserow:  ${baserow.apiBase}`);
  console.log(`  Supabase: ${supabaseClient.url}`);
  console.log(`  Sales table IDs:  Mercari=${baserow.salesOrderTableId}, Rakuten=${baserow.rakutenSalesOrderTableId}`);
  console.log(`  Shipment table:   ${baserow.shipmentOrderTableId}`);
  console.log();

  // Load platform_accounts from Supabase
  console.log("Loading platform_accounts from Supabase...");
  const accountMap = await loadAccountMap(supabase);
  console.log();

  // ===========================================================================
  // Reports accumulator
  // ===========================================================================

  const reports = [];

  // ===========================================================================
  // Phase 1: Migrate sales_orders
  // ===========================================================================

  let salesOrderLookup = new Map();

  if (TABLES.has("sales_orders") || TABLES.has("all")) {
    console.log("-".repeat(72));
    console.log("Phase 1: Migrate sales_orders");
    console.log("-".repeat(72));

    // Read Mercari sales
    console.log("Reading Mercari sales rows from Baserow...");
    let mercariSalesRows;
    try {
      mercariSalesRows = LIMIT > 0
        ? await listRowsWithLimit(baserow, baserow.salesOrderTableId, {}, LIMIT)
        : await listAllRows(baserow, baserow.salesOrderTableId);
    } catch (err) {
      console.error("ERROR reading Mercari sales rows:", err.message);
      mercariSalesRows = [];
    }
    console.log(`  Read ${mercariSalesRows.length} Mercari sales rows`);

    // Read Rakuten sales
    console.log("Reading Rakuten sales rows from Baserow...");
    let rakutenSalesRows = [];
    try {
      rakutenSalesRows = LIMIT > 0
        ? await listRowsWithLimit(baserow, baserow.rakutenSalesOrderTableId, {}, LIMIT)
        : await listAllRows(baserow, baserow.rakutenSalesOrderTableId, {});
    } catch (err) {
      console.error("  WARN: Could not read Rakuten sales rows:", err.message);
    }
    console.log(`  Read ${rakutenSalesRows.length} Rakuten sales rows`);

    // Transform
    console.log("Transforming rows...");
    const transformedMercari = mercariSalesRows.map((row) =>
      transformSalesRow(row, "mercari", accountMap),
    );
    const transformedRakuten = rakutenSalesRows.map((row) =>
      transformRakutenSalesRow(row, accountMap),
    );
    const allTransformedRaw = [...transformedMercari, ...transformedRakuten];
    const allTransformed = dedupeSalesRows(allTransformedRaw);
    console.log(`  Transformed ${allTransformed.length} rows (${transformedMercari.length} Mercari + ${transformedRakuten.length} Rakuten)`);
    if (allTransformed.length !== allTransformedRaw.length) {
      console.log(`  Deduplicated ${allTransformedRaw.length - allTransformed.length} duplicate logical sales rows`);
    }

    // Validate
    const invalidRows = allTransformed.filter((r) => !r.order_id || !r.sales_channel);
    if (invalidRows.length > 0) {
      console.warn(`  WARNING: ${invalidRows.length} rows have missing order_id or sales_channel (will be skipped)`);
    }

    if (DRY_RUN) {
      console.log();
      console.log("DRY RUN — Would upsert the following rows:");
      console.log(`  Mercari sales: ${transformedMercari.length} rows`);
      console.log(`  Rakuten sales: ${transformedRakuten.length} rows`);
      if (VERBOSE) {
        for (const row of allTransformed.slice(0, 10)) {
          console.log(`  ${formatRowPreview(row)}`);
        }
        if (allTransformed.length > 10) {
          console.log(`  ... and ${allTransformed.length - 10} more`);
        }
      }

      // Build mock lookup for shipment phase dry-run
      salesOrderLookup = buildSalesLookupMap(mercariSalesRows, "mercari", new Map());
      // Add Rakuten
      for (const row of rakutenSalesRows) {
        const orderId = text(row.order_id) || "";
        const key = `${orderId}::Rakuten::rakuten`;
        salesOrderLookup.set(key, "dry-run-mock-uuid");
      }

      reports.push({
        table: "sales_orders",
        read: mercariSalesRows.length + rakutenSalesRows.length,
        transformed: allTransformed.length,
        inserted: 0,
        errors: 0,
        skipped: invalidRows.length,
        dryRun: true,
      });

      console.log();
    } else {
      // Confirm before writing
      if (CONFIRM && !NON_INTERACTIVE) {
        console.log();
        console.log(`Ready to upsert ${allTransformed.length} rows to sales_orders`);
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve) => rl.question('Type "yes" to proceed: ', resolve));
        rl.close();
        if (answer.trim().toLowerCase() !== "yes") {
          console.log("Aborted by user.");
          process.exit(0);
        }
      }

      // Batch upsert
      const BATCH_SIZE = 100;
      let totalInserted = 0;
      let totalErrors = 0;
      let allInsertedData = [];

      for (let i = 0; i < allTransformed.length; i += BATCH_SIZE) {
        const batch = allTransformed.slice(i, i + BATCH_SIZE).filter((r) => r.order_id && r.sales_channel);
        if (!batch.length) continue;
        const result = await upsertBatch(
          supabase,
          "sales_orders",
          batch,
          "sales_channel,order_id,source_store_id,product_name",
          { overwriteExisting: OVERWRITE_EXISTING_SALES },
        );
        totalInserted += result.inserted;
        totalErrors += result.errors;
        if (result.data) allInsertedData.push(...result.data);
        if (result.errors > 0) {
          for (const ei of result.errorItems) {
            console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${ei.error}`);
          }
        }

        const pct = Math.min(100, Math.round(((i + BATCH_SIZE) / allTransformed.length) * 100));
        if (!result.errors) {
          process.stdout.write(`\r  Progress: ${pct}% (${totalInserted} upserted, ${totalErrors} errors)`);
        }
      }
      console.log();

      console.log(`  Upsert result: ${totalInserted} rows upserted, ${totalErrors} errors`);

      if (PROPAGATE_TERMINAL_STATUSES && totalErrors === 0) {
        const terminalResult = await propagateTerminalSalesStatuses(supabase, allTransformed);
        totalInserted += terminalResult.updated;
        totalErrors += terminalResult.errors;
        if (terminalResult.errors > 0) {
          for (const item of terminalResult.errorItems) {
            console.error(`  Terminal status propagation error: ${item.error}`);
          }
        }
        console.log(`  Terminal statuses propagated: ${terminalResult.updated}, errors: ${terminalResult.errors}`);
      }

      // Build sales order lookup map from inserted data
      salesOrderLookup = buildSalesOrderLookupFromInserted(allInsertedData);

      // If no rows were inserted (already all exist), try reading from Supabase
      if (salesOrderLookup.size === 0 && allTransformed.length > 0) {
        console.log("  No new rows inserted. Attempting to load existing sales orders for lookup...");
        try {
          const { data: existing } = await supabase
            .from("sales_orders")
            .select("id, order_id, source_store_id, sales_channel");
          salesOrderLookup = buildSalesOrderLookupFromInserted(existing);
          console.log(`  Loaded ${salesOrderLookup.size} existing sales orders`);
        } catch (err) {
          console.warn(`  WARN: Could not load existing sales orders: ${err.message}`);
        }
      } else {
        console.log(`  Sales order lookup map: ${salesOrderLookup.size} entries`);
      }

      reports.push({
        table: "sales_orders",
        read: mercariSalesRows.length + rakutenSalesRows.length,
        transformed: allTransformed.length,
        inserted: totalInserted,
        errors: totalErrors,
        skipped: invalidRows.length,
        dryRun: false,
      });
    }
  } else {
    // Need sales order lookup even if not migrating sales (e.g. only migrating shipments)
    // Try reading from Supabase
    console.log("Loading existing sales orders from Supabase for shipment lookup...");
    try {
      const { data: existing } = await supabase
        .from("sales_orders")
        .select("id, order_id, source_store_id, sales_channel");
      salesOrderLookup = buildSalesOrderLookupFromInserted(existing);
      console.log(`  Loaded ${salesOrderLookup.size} sales orders`);
    } catch (err) {
      console.warn(`  WARN: Could not load sales orders: ${err.message}`);
    }
  }

  console.log();

  // ===========================================================================
  // Phase 2: Migrate giga_shipment_projections
  // ===========================================================================

  if (TABLES.has("giga_shipment_projections") || TABLES.has("all")) {
    console.log("-".repeat(72));
    console.log("Phase 2: Migrate giga_shipment_projections");
    console.log("-".repeat(72));

    console.log("Reading shipment rows from Baserow...");
    let shipmentRows;
    try {
      shipmentRows = LIMIT > 0
        ? await listRowsWithLimit(baserow, baserow.shipmentOrderTableId, {}, LIMIT)
        : await listAllRows(baserow, baserow.shipmentOrderTableId);
    } catch (err) {
      console.error("ERROR reading shipment rows:", err.message);
      shipmentRows = [];
    }
    console.log(`  Read ${shipmentRows.length} shipment rows`);

    // Transform
    console.log("Transforming rows...");
    const transformedShipments = shipmentRows
      .map((row) => transformShipmentRow(row, salesOrderLookup))
      .filter((r) => r.order_id && r.sales_channel);

    console.log(`  Transformed ${transformedShipments.length} shipment rows`);

    // Count orphaned shipments (no matching sales order)
    const orphaned = transformedShipments.filter((r) => !r.sales_order_id);
    const insertableShipments = transformedShipments.filter((r) => r.sales_order_id);
    if (orphaned.length > 0) {
      console.warn(`  WARNING: ${orphaned.length} shipment rows have no matching sales order (sales_order_id = null)`);
      if (VERBOSE) {
        for (const row of orphaned.slice(0, 10)) {
          console.warn(`    order_id=${row.order_id} channel=${row.sales_channel} store=${row.source_store_id}`);
        }
        if (orphaned.length > 10) {
          console.warn(`    ... and ${orphaned.length - 10} more`);
        }
      }
    }

    if (DRY_RUN) {
      console.log();
      console.log("DRY RUN — Would insert the following shipment rows:");
      console.log(`  Total: ${transformedShipments.length} rows`);
      console.log(`  Orphaned (no sales_order_id): ${orphaned.length}`);
      if (VERBOSE) {
        for (const row of transformedShipments.slice(0, 10)) {
          console.log(`  ${formatRowPreview(row)}`);
        }
        if (transformedShipments.length > 10) {
          console.log(`  ... and ${transformedShipments.length - 10} more`);
        }
      }

      reports.push({
        table: "giga_shipment_projections",
        read: shipmentRows.length,
        transformed: transformedShipments.length,
        inserted: 0,
        errors: 0,
        skipped: shipmentRows.length - transformedShipments.length,
        orphaned: orphaned.length,
        dryRun: true,
      });

      console.log();
    } else {
      // Confirm
      if (CONFIRM && !NON_INTERACTIVE) {
        console.log();
        console.log(`Ready to insert ${insertableShipments.length} linked rows to giga_shipment_projections`);
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve) => rl.question('Type "yes" to proceed: ', resolve));
        rl.close();
        if (answer.trim().toLowerCase() !== "yes") {
          console.log("Aborted by user.");
          process.exit(0);
        }
      }

      // Since giga_shipment_projections has no unique constraint for upsert,
      // delete existing rows for the same sales_channel values first, then insert.
      const channels = [...new Set(insertableShipments.map((r) => r.sales_channel).filter(Boolean))];
      if (channels.length > 0) {
        console.log(`  Deleting existing projection rows for channels: ${channels.join(", ")}`);
        try {
          const { error: delErr } = await supabase
            .from("giga_shipment_projections")
            .delete()
            .in("sales_channel", channels);
          if (delErr) {
            console.warn(`  WARN: Delete had issue: ${delErr.message} (continuing with insert)`);
          } else {
            console.log("  Existing projections deleted successfully.");
          }
        } catch (err) {
          console.warn(`  WARN: Delete exception: ${err.message} (continuing with insert)`);
        }
      }

      // Batch insert (no upsert needed — we just deleted)
      const BATCH_SIZE = 100;
      let totalInserted = 0;
      let totalErrors = 0;

      for (let i = 0; i < insertableShipments.length; i += BATCH_SIZE) {
        const batch = insertableShipments.slice(i, i + BATCH_SIZE);
        if (!batch.length) continue;
        const { data, error } = await supabase
          .from("giga_shipment_projections")
          .insert(batch)
          .select();

        if (error) {
          totalErrors += batch.length;
          console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${error.message}`);
        } else {
          totalInserted += Array.isArray(data) ? data.length : 0;
        }

        const pct = Math.min(100, Math.round(((i + BATCH_SIZE) / insertableShipments.length) * 100));
        if (!error) {
          process.stdout.write(`\r  Progress: ${pct}% (${totalInserted} inserted, ${totalErrors} errors)`);
        }
      }
      console.log();

      console.log(`  Insert result: ${totalInserted} rows inserted, ${totalErrors} errors`);

      reports.push({
        table: "giga_shipment_projections",
        read: shipmentRows.length,
        transformed: transformedShipments.length,
        inserted: totalInserted,
        errors: totalErrors,
        skipped: shipmentRows.length - transformedShipments.length,
        orphaned: orphaned.length,
        dryRun: false,
      });
    }
  }

  // ===========================================================================
  // Final report
  // ===========================================================================

  console.log();
  console.log("=" .repeat(72));
  console.log("Migration Summary");
  console.log("=" .repeat(72));
  console.log();

  if (reports.length === 0) {
    console.log("No tables were migrated. Specify --tables to select tables.");
    return;
  }

  let totalRead = 0;
  let totalWritten = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (const r of reports) {
    const prefix = r.dryRun ? "[DRY RUN] " : "";
    console.log(`${prefix}${r.table}:`);
    console.log(`  Read:       ${r.read} rows from Baserow`);
    console.log(`  Transformed: ${r.transformed} rows`);
    if (r.orphaned !== undefined) {
      console.log(`  Orphaned:   ${r.orphaned} (no matching sales_order_id)`);
    }
    console.log(`  Written:    ${r.inserted} rows to Supabase`);
    console.log(`  Errors:     ${r.errors}`);
    console.log(`  Skipped:    ${r.skipped}`);

    totalRead += r.read;
    totalWritten += r.inserted;
    totalErrors += r.errors;
    totalSkipped += r.skipped;
    console.log();
  }

  console.log("-".repeat(72));
  console.log("Totals:");
  console.log(`  Rows read from Baserow:    ${totalRead}`);
  console.log(`  Rows written to Supabase:  ${totalWritten}`);
  console.log(`  Errors:                    ${totalErrors}`);
  console.log(`  Skipped:                   ${totalSkipped}`);
  console.log();

  if (DRY_RUN) {
    console.log("⚠  DRY RUN completed — no data was written to Supabase.");
    console.log("   To write, run with: --dry-run=false --confirm");
  } else {
    console.log("✓  Migration completed.");
    if (totalErrors > 0) {
      console.log(`   ${totalErrors} errors were reported. Review the output above.`);
    }
  }

  // Japanese text verification
  console.log();
  console.log("-".repeat(72));
  console.log("Japanese Text Verification");
  console.log("-".repeat(72));
  console.log("  Verify that Japanese text (Shift-JIS / UTF-8) round-trips correctly.");
  console.log("  Check for garbled characters in:");
  console.log("    - order_comments with Japanese content");
  console.log("    - product_name with Japanese product names");
  console.log("    - shipping_name with Japanese names");
  console.log("    - shipping_state/city/address fields");
  console.log("  If garbled, check terminal encoding (LANG=ja_JP.UTF-8) and");
  console.log("  Supabase column encoding (should be UTF-8).");
  console.log();

  console.log("Done.");
}

// ============================================================================
// Execute
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((err) => {
    console.error("FATAL:", err && err.message ? err.message : String(err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
