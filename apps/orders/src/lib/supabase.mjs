// Supabase adapter — drop-in replacement for baserow.mjs.
// Exports the same 7 function signatures as baserow.mjs for interface
// compatibility. Used via db.mjs facade when DATABASE_BACKEND=supabase.
//
// Filter format: accepts the same filter key convention as baserow.mjs
//   filter__field_{columnName}__{operator}=value
// Internally translates to Supabase JS client query methods.

// Node 18 compat: supabase-js requires WebSocket for its realtime transport.
// Node 18 lacks native WebSocket; polyfill before supabase-js imports execute.
if (!globalThis.WebSocket) {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    globalThis.WebSocket = require("ws");
  } catch {
    // ws not installed or not on Node — supabase-js will use native WebSocket
    // or throw if unavailable.
  }
}

import { FIELD, OPTION } from "./db-fields.mjs";
import { decodedJsonByteLength } from "./egress-metrics.mjs";

// Dynamic import so the polyfill above executes first
const { createClient } = await import("@supabase/supabase-js");

// Re-export field/option constants (needed by db.mjs re-export chain)
export { FIELD as BASEROW_FIELD } from "./db-fields.mjs";
export { OPTION as BASEROW_OPTION } from "./db-fields.mjs";

// ============================================================================
// 1. createBaserowClient — factory (named for interface compatibility)
// ============================================================================

export function createBaserowClient(env) {
  const url = trimStr(env.SUPABASE_URL);
  const serviceKey = trimStr(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  // Workload-identifying x-client-info header: stable ordermgmt identity,
  // optionally suffixed with the release version. Never includes credentials.
  const releaseVersion = trimStr(env.RELEASE_VERSION);
  const workloadId = trimStr(env.ORDERMGMT_WORKLOAD_ID);
  const identityParts = ["ordermgmt", workloadId, releaseVersion].filter(Boolean);
  const clientInfo = identityParts.join("/");
  const metrics = env.EGRESS_METRICS;
  const measuredFetch = typeof metrics?.recordResponse === "function"
    ? async (input, init) => {
        const response = await fetch(input, init);
        metrics.recordResponse({
          url: typeof input === "string" ? input : input?.url,
          status: response.status,
          contentLength: response.headers.get("content-length"),
        });
        return response;
      }
    : undefined;

  const supabase = createClient(url, serviceKey, {
    realtime: {
      // Disable WebSocket — portal-api runs on Node 18 without native
      // WebSocket, and the order-mgmt pipeline never uses realtime.
      enabled: false,
    },
    global: {
      ...(measuredFetch ? { fetch: measuredFetch } : {}),
      headers: {
        "x-client-info": clientInfo,
      },
    },
  });

  return {
    type: "supabase",
    supabase,
    url,
    serviceKey,
    metrics,
    clientInfo,
    // Table names — mirror baserow client shape so consumers can use
    // client.salesOrderTableId / client.shipmentOrderTableId unchanged
    salesOrderTableId:         "sales_orders",
    shipmentOrderTableId:      "giga_shipment_projections",
    rakutenSalesOrderTableId:  "sales_orders",
  };
}

// ============================================================================
// 2. clientForRakuten — returns Rakuten-scoped client view
// ============================================================================

export function clientForRakuten(client) {
  // Rakuten orders live in the same sales_orders table.
  // Consumer modules add sales_channel='rakuten' filter separately.
  // The Rakuten-specific token/DB separation from Baserow does not
  // apply to Supabase (single project, single database).
  return {
    ...client,
    salesOrderTableId: "sales_orders",
    salesChannelScope: "rakuten",
  };
}

// ============================================================================
// 3. listAllRows — paginated full read
// ============================================================================

export async function listAllRows(client, tableName, filterParams = {}, options = {}) {
  const rows = [];
  const pageSize = 1000;
  const selectColumns = options && options.select ? options.select : "*";
  let from = 0;

  while (true) {
    let query = client.supabase.from(tableName).select(selectColumns);
    query = applyFilters(query, filterParams);
    query = query.range(from, from + pageSize - 1);

    const { data, error } = await query;
    if (error) throw new Error(`supabase_list_failed:${error.message}`);

    const page = Array.isArray(data) ? data.map((row) => toApplicationRow(tableName, row)) : [];
    client.metrics?.recordRows?.({
      resource: tableName,
      rows: Array.isArray(data) ? data.length : 0,
      decodedJsonBytes: decodedJsonByteLength(data),
    });
    rows.push(...page);

    if (page.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

// ============================================================================
// 4. listRowsWithLimit — bounded read (prevents Worker timeouts)
// ============================================================================

export async function listRowsWithLimit(client, tableName, filterParams = {}, maxRows = 100, options = {}) {
  // Optional projection narrows the SELECT column list. Defaults to "*" for
  // backward compatibility — existing callers pass only 3-4 positional args.
  const selectColumns = options && options.select ? options.select : "*";
  let query = client.supabase.from(tableName).select(selectColumns);
  query = applyFilters(query, filterParams);
  query = query.limit(maxRows);

  const { data, error } = await query;
  if (error) throw new Error(`supabase_list_failed:${error.message}`);

  client.metrics?.recordRows?.({
    resource: tableName,
    rows: Array.isArray(data) ? data.length : 0,
    decodedJsonBytes: decodedJsonByteLength(data),
  });
  return Array.isArray(data) ? data.map((row) => toApplicationRow(tableName, row)) : [];
}

// ============================================================================
// 5. patchRow — UPDATE
// ============================================================================

export async function patchRow(client, tableName, rowId, payload, { match = {} } = {}) {
  try {
    const dbPayload = toDatabasePayload(tableName, payload, client);
    let query = client.supabase
      .from(tableName)
      .update(dbPayload)
      .eq("id", rowId);
    for (const [column, value] of Object.entries(match)) {
      query = query.eq(column, normalizeDatabaseValue(column, value));
    }
    const { data, error } = await query.select();

    if (error) {
      return { ok: false, status: 400, body: null, error: error.message };
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length !== 1) {
      return {
        ok: false,
        status: rows.length === 0 ? 409 : 500,
        body: null,
        error: rows.length === 0 ? "supabase_patch_affected_zero_rows" : "supabase_patch_affected_multiple_rows",
      };
    }

    return { ok: true, status: 200, body: toApplicationRow(tableName, rows[0]), error: null };
  } catch (err) {
    return { ok: false, status: 500, body: null, error: err.message || "supabase_patch_failed" };
  }
}

// ============================================================================
// 6. createRow — INSERT
// ============================================================================

export async function createRow(client, tableName, payload) {
  try {
    const dbPayload = toDatabasePayload(tableName, payload, client);
    if (tableName === "giga_shipment_projections" && !dbPayload.sales_order_id) {
      // Fail closed: a projection must carry the exact source sales row id.
      // Never guess the first matching sales row (multi-line orders would all
      // collapse onto the anchor's id). Projectors set sales_order_id directly.
      return { ok: false, status: 400, body: null, error: "missing_sales_order_id_for_projection" };
    }
    const { data, error } = await client.supabase
      .from(tableName)
      .insert(dbPayload)
      .select();

    if (error) {
      return { ok: false, status: 400, body: null, error: error.message };
    }

    return { ok: true, status: 201, body: data?.[0] ? toApplicationRow(tableName, data[0]) : null, error: null };
  } catch (err) {
    return { ok: false, status: 500, body: null, error: err.message || "supabase_create_failed" };
  }
}

// ============================================================================
// 7. deleteRow — DELETE
// ============================================================================

export async function deleteRow(client, tableName, rowId) {
  try {
    const { error } = await client.supabase
      .from(tableName)
      .delete()
      .eq("id", rowId);

    if (error) {
      return { ok: false, status: 400, body: null, error: error.message };
    }

    return { ok: true, status: 204, body: null, error: null };
  } catch (err) {
    return { ok: false, status: 500, body: null, error: err.message || "supabase_delete_failed" };
  }
}

// ============================================================================
// Internal: filter translation
// ============================================================================
// Parses Baserow-style filter keys and applies them to a Supabase query.
//
// Filter key format: filter__field_{columnName}__{operator}
// Operators:
//   equal                → .eq(column, value)
//   single_select_equal  → .eq(column, value)
//   single_select_not_equal → .neq(column, value)
//   empty                → .is(column, null)
//   not_empty            → .not(column, 'is', null)
//   contains             → .ilike(column, '%value%')
//   boolean              → .eq(column, value === 'true' || value === '1')

function applyFilters(query, filterParams) {
  for (const [key, value] of Object.entries(filterParams)) {
    if (value == null) continue;

    const match = key.match(/^filter__field_(.+?)__(.+?)$/);
    if (!match) continue;

    const [, column, operator] = match;

    // Handle array values as IN clause (matching Baserow flat-map behavior)
    if (Array.isArray(value)) {
      if (operator === "equal" || operator === "single_select_equal") {
        query = query.in(column, value.map((item) => normalizeDatabaseValue(column, item)));
      }
      continue;
    }

    const strVal = normalizeDatabaseValue(column, value);

    switch (operator) {
      case "equal":
      case "single_select_equal":
        query = query.eq(column, strVal);
        break;
      case "single_select_not_equal":
        query = query.neq(column, strVal);
        break;
      case "empty":
        query = query.is(column, null);
        break;
      case "not_empty":
        query = query.not(column, "is", null);
        break;
      case "contains":
        query = query.ilike(column, `%${strVal}%`);
        break;
      case "boolean":
        query = query.eq(column, strVal === "true" || strVal === "1");
        break;
      // Unknown operators silently skipped (matching baserow behavior)
    }
  }

  return query;
}

const SALES_ALIASES = Object.freeze({
  shop_id: "source_store_id",
  B2BItemCode: "b2b_item_code",
  shipping_tracking_info: "tracking_number",
  has_buyer_messages: "has_unread_messages",
  latest_buyer_message_at: "last_message_at",
});

const SHIPMENT_ALIASES = Object.freeze({
  SalesChannel: "sales_channel",
  ShipFrom: "order_from",
  SourceStoreID: "source_store_id",
  OrderId: "order_id",
  B2BItemCode: "b2b_item_code",
  ShipToQty: "ship_to_qty",
  ShipToName: "ship_to_name",
  ShipToEmail: "ship_to_email",
  ShipToPhone: "ship_to_phone",
  ShipToPostalCode: "ship_to_postal_code",
  ShipToAddressDetail: "ship_to_address",
  ShipToCity: "ship_to_city",
  ShipToState: "ship_to_state",
  ShipToCountry: "ship_to_country",
  ShipToServiceLevel: "ship_to_service_level",
  OrderDate: "order_date",
  RequestedDeliveryDate: "requested_delivery_date",
  BuyerPlatformSku: "buyer_platform_sku",
  BuyerSkuDescription: "buyer_sku_description",
  BuyerSkuCommercialValue: "buyer_sku_commercial_value",
  OrderComments: "order_comments",
  giga_carrier_name: "tracking_carrier",
  giga_tracking_info: "tracking_number",
  giga_tracking_no: "tracking_number",
});

export const SALES_COLUMNS = new Set([
  "ai_copywrite_log", "auto_approval_rule", "auto_approved_at", "b2b_item_code",
  "billing_address_1", "billing_address_2", "billing_city", "billing_country", "billing_name",
  "billing_postal_code", "billing_state", "buyer_name", "confirm_in_progress", "confirm_started_at",
  "coupon_discount_amount", "coupon_id", "currency",
  "has_unread_messages", "last_message_at", "last_message_preview", "latest_buyer_message_id",
  "line_origin", "manage_number", "message_last_synced_at",
  "order_comments", "order_id", "order_status", "order_type", "original_product_id",
  "parent_line_id", "payment_date", "payment_method", "platform_account_id", "product_name", "product_price", "product_tax",
  "purchase_date", "quantity", "component_index",
  "requested_delivery_date", "requested_delivery_time", "review_status", "sales_channel",
  "shipping_address_1", "shipping_address_2", "shipping_carrier", "shipping_city",
  "shipping_completed_at", "shipping_country", "shipping_duration", "shipping_method",
  "shipping_name", "shipping_phone_number", "shipping_postal_code", "shipping_price",
  "shipping_state", "shipping_tax",
  "shop_close_attempted_at", "shop_close_completed_at", "shop_close_error", "shop_close_status",
  "source_store_id", "tracking_carrier", "tracking_number", "variant_id",
  // Rakuten lifecycle/audit columns (issue #161)
  "last_synced_at", "sync_error",
  "rms_confirm_result", "rms_confirmed_at",
  "rms_close_result", "rms_close_completed_at",
  "rakuten_order_progress", "rakuten_status_mapping_state",
  "rakuten_order_progress_observed_at",
]);

const SHIPMENT_COLUMNS = new Set([
  "sales_order_id", "order_id", "sales_channel", "source_store_id", "giga_sync_status", "giga_sync_attempted_at",
  "giga_sync_processed_at", "giga_sync_request_id", "giga_sync_error", "order_from", "b2b_item_code", "ship_to_qty",
  "ship_to_name", "ship_to_phone", "ship_to_postal_code", "ship_to_address", "ship_to_city", "ship_to_state",
  "ship_to_country", "ship_to_service_level", "ship_from", "requested_delivery_date", "buyer_platform_sku",
  "buyer_sku_description", "buyer_sku_commercial_value", "order_comments", "order_date", "shipping_completed_at",
  "tracking_carrier", "tracking_number",
]);

function aliasesForTable(tableName) {
  if (tableName === "giga_shipment_projections") return SHIPMENT_ALIASES;
  if (tableName === "sales_orders") return SALES_ALIASES;
  return {};
}

export function toApplicationRow(tableName, row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  const aliases = aliasesForTable(tableName);
  for (const [legacy, canonical] of Object.entries(aliases)) {
    if (out[legacy] == null && out[canonical] != null) out[legacy] = out[canonical];
  }
  if (tableName === "giga_shipment_projections") {
    if (out.SalesChannel) out.SalesChannel = titleCaseChannel(out.SalesChannel);
    if (out.giga_sync_status) out.giga_sync_status = legacyGigaSyncStatus(out.giga_sync_status);
    if (out.LineItemNumber == null) out.LineItemNumber = "1";
  }
  if (tableName === "sales_orders" && out.review_status) {
    out.review_status = canonicalToLegacyReviewStatus(out.review_status);
  }
  return out;
}

export function toDatabasePayload(tableName, payload, client) {
  const aliases = aliasesForTable(tableName);
  const allowed = tableName === "giga_shipment_projections"
    ? SHIPMENT_COLUMNS
    : tableName === "sales_orders"
      ? SALES_COLUMNS
      : null;
  const out = {};
  const explicitCanonicalKeys = new Set(
    Object.keys(payload || {}).filter((key) => !allowed || allowed.has(key)),
  );
  for (const [key, value] of Object.entries(payload || {})) {
    const canonical = aliases[key] || key;
    if (allowed && !allowed.has(canonical)) continue;
    if (canonical !== key && explicitCanonicalKeys.has(canonical)) continue;
    out[canonical] = normalizeDatabaseValue(canonical, value);
  }
  if (tableName === "sales_orders" && client?.salesChannelScope === "rakuten") {
    out.sales_channel ||= "rakuten";
    out.source_store_id ||= "Rakuten";
  }
  return out;
}

function normalizeDatabaseValue(column, value) {
  if (column === "review_status" && value == null) return null;
  const textValue = String(value);
  if (column === "sales_channel") return textValue.trim().toLowerCase();
  if (column === "giga_sync_status") return textValue.trim().replaceAll(" ", "_").toUpperCase();
  if (column === "review_status") return legacyToCanonicalReviewStatus(textValue);
  return value;
}

// ============================================================================
// Expected-field validation — prevents silent discard of owned fields
// ============================================================================
//
// toDatabasePayload() silently drops keys not in the allow-list for backward
// compatibility with legacy Baserow callers. Modules that own specific fields
// should call this before writing to catch configuration drift where expected
// columns haven't been added to SALES_COLUMNS yet.
//
// Returns { ok, discarded } where discarded lists the key names only (never
// values, to avoid logging PII or sensitive data).

/**
 * Validate that all owned expected fields survive the adapter allow-list.
 *
 * @param {object} payload — the payload that will be passed to patchRow/createRow
 * @param {Set<string>} allowedColumns — the allow-list Set (e.g. SALES_COLUMNS)
 * @param {string} label — human-readable label for error messages (e.g. "rakuten-confirm")
 * @returns {{ ok: boolean, discarded: string[] }}
 */
export function validateExpectedFields(payload, allowedColumns, label) {
  if (!payload || typeof payload !== "object") {
    return { ok: true, discarded: [] };
  }
  const discarded = Object.keys(payload).filter((key) => !allowedColumns.has(key));
  if (discarded.length > 0) {
    console.log(JSON.stringify({
      warning: "expected_fields_discarded",
      label: label || "unknown",
      discarded_keys: discarded,
      hint: "Add these columns to SALES_COLUMNS in supabase.mjs if they are governed schema columns.",
    }));
  }
  return { ok: discarded.length === 0, discarded };
}

function titleCaseChannel(value) {
  const textValue = String(value || "").trim();
  return textValue ? textValue[0].toUpperCase() + textValue.slice(1).toLowerCase() : "";
}

function legacyGigaSyncStatus(value) {
  const normalized = String(value || "").trim().replaceAll(" ", "_").toUpperCase();
  const values = {
    SYNCED: "Synced",
    ALREADY_EXISTS: "Already Exists",
    INVALID: "Invalid",
    ERROR: "Error",
    ATTEMPTED: "Attempted",
  };
  return values[normalized] || value;
}

// ============================================================================
// Review status translation — canonical (Supabase enum) ↔ legacy (display)
// ============================================================================
//
// Supabase stores canonical review_status values matching the review_status
// PostgreSQL enum: PENDING_REVIEW, AUTO_APPROVED, APPROVED, ON_HOLD.
//
// Application business logic (order-state.mjs, review-gate.mjs, etc.) expects
// legacy display values: "Pending Review", "Auto-Approved", "Approved", "On Hold".
//
// Translation happens at the adapter boundary only:
//   toApplicationRow()  → canonical → legacy (for reads)
//   normalizeDatabaseValue() → legacy → canonical (for writes)
//
// This is the same pattern used for giga_sync_status above.

const REVIEW_STATUS_CANONICAL_TO_LEGACY = Object.freeze({
  PENDING_REVIEW: "Pending Review",
  AUTO_APPROVED: "Auto-Approved",
  APPROVED: "Approved",
  ON_HOLD: "On Hold",
  CANCELED: "Canceled",
});

const REVIEW_STATUS_LEGACY_TO_CANONICAL = Object.freeze({
  "pending review": "PENDING_REVIEW",
  "auto-approved": "AUTO_APPROVED",
  "approved": "APPROVED",
  "on hold": "ON_HOLD",
  "canceled": "CANCELED",
});

/**
 * Translate a canonical review_status value to its legacy display form.
 * Unknown/unrecognized values pass through unchanged.
 *
 * @param {string} value — canonical value from Supabase (e.g. "PENDING_REVIEW")
 * @returns {string} legacy display value (e.g. "Pending Review")
 */
function canonicalToLegacyReviewStatus(value) {
  const key = String(value || "").trim().replaceAll(" ", "_").toUpperCase();
  return REVIEW_STATUS_CANONICAL_TO_LEGACY[key] || value;
}

/**
 * Translate a legacy review_status display value to its canonical form.
 * Unknown/unrecognized values pass through unchanged.
 *
 * @param {string} value — legacy display value (e.g. "Pending Review")
 * @returns {string} canonical value (e.g. "PENDING_REVIEW")
 */
function legacyToCanonicalReviewStatus(value) {
  const key = String(value || "").trim().toLowerCase();
  return REVIEW_STATUS_LEGACY_TO_CANONICAL[key] || value;
}

// ============================================================================
// 8. setOrderReviewStatusViaRpc — transactional review-status mutation
// ============================================================================
//
// The single authoritative write path for every review mutation (Cancel,
// Approve, On-Hold, Auto-Approve). Delegates to the Supabase
// set_order_review_status(...) RPC which takes an order-scoped advisory lock
// and updates all non-fee lines of the order atomically, so Cancel always wins
// over a concurrent approve regardless of which line either operation touches.
//
// @param {Object} client — from createBaserowClient(); must be the Supabase backend
// @param {Object} params — RPC named params:
//   p_sales_channel, p_source_store_id, p_order_id (normalized), p_target
//   (canonical review status), p_audit, and optional p_auto_approval_rule /
//   p_auto_approved_at for AUTO_APPROVED.
// @returns {{ ok: boolean, updated?: number, error?: string, reason?: string }}
export async function setOrderReviewStatusViaRpc(client, params) {
  if (!client || client.type !== "supabase") {
    return { ok: false, error: "review_rpc_requires_supabase_backend" };
  }

  let data;
  let error;
  try {
    const hasCancellationReason = Object.prototype.hasOwnProperty.call(params, "p_cancellation_reason");
    const rpcName = hasCancellationReason ? "cancel_order_with_reason" : "set_order_review_status";
    const rpcParams = hasCancellationReason
      ? {
          p_sales_channel: params.p_sales_channel,
          p_source_store_id: params.p_source_store_id,
          p_order_id: params.p_order_id,
          p_audit: params.p_audit,
          p_cancellation_reason: params.p_cancellation_reason,
        }
      : params;
    const result = await client.supabase.rpc(rpcName, rpcParams);
    data = result.data;
    error = result.error;
  } catch (err) {
    return { ok: false, error: `review_rpc_failed:${err && err.message ? err.message : String(err)}` };
  }

  if (error) {
    const msg = String(error.message || "");
    if (/ALREADY_SYNCED_TO_GIGA/.test(msg)) {
      return { ok: false, error: "already_synced_to_giga", reason: "already_synced_to_giga" };
    }
    if (/ORDER_TERMINAL/.test(msg)) {
      return { ok: false, error: "terminal_lifecycle", reason: "terminal_lifecycle" };
    }
    if (/REVIEW_CANCELED/.test(msg)) {
      return { ok: false, error: "already_canceled", reason: "already_canceled" };
    }
    if (/REVIEW_STATUS_CHANGED/.test(msg)) {
      return { ok: false, error: "review_status_changed", reason: "review_status_changed" };
    }
    if (/ORDER_NOT_FOUND/.test(msg)) {
      return { ok: false, error: "order_not_found", reason: "order_not_found" };
    }
    if (/CANCELLATION_REASON_REQUIRED/.test(msg)) {
      return { ok: false, error: "cancellation_reason_required", reason: "cancellation_reason_required" };
    }
    if (/CANCELLATION_REASON_TOO_LONG/.test(msg)) {
      return { ok: false, error: "cancellation_reason_too_long", reason: "cancellation_reason_too_long" };
    }
    return { ok: false, error: `review_rpc_failed:${msg}` };
  }

  return {
    ok: true,
    updated: data && typeof data === "object" && "updated" in data ? data.updated : null,
  };
}

// ============================================================================
// 8. resolveProductsByItemCodes — bulk product resolution for portal
// ============================================================================
//
// Queries product_variants LEFT JOIN product_commercials to resolve product
// data (TCOGS, stock, restock notes) for a set of B2B item codes.
//
// Returns a Map<itemCode, ProductRow> where each row uses pseudo field_1–field_9
// keys so that existing readProductField / readProductNumber consumers work
// without changes. The field mapping matches what resolveProductFields would
// return from Baserow:
//
//   field_1 = item_code                       (Gigab2b Item Code)
//   field_2 = effective_tcogs                 (Effective TCOGS, includes shipping)
//   field_3 = owned_qty                       (Owned Qty)
//   field_4 = source_available_qty            (Qty Available)
//   field_5 = ""                              (seller — not in Supabase)
//   field_6 = audit_notes                     (Restock Info)
//   field_7 = manual_cost_price               (operator-set manual cost price)
//   field_8 = manual_presale_arrival_date     (operator-set manual restock date)
//   field_9 = presale_info_protect_until      (operator-set restock protection until)
//   field_10 = effective_cost_price           (Effective COGS, excludes shipping)
//   field_11 = source_unit_price              (GigaB2B product page /Unit price)
//

const PRODUCT_FIELD_IDS = Object.freeze({
  itemCode: 1,
  effectiveTcogs: 2,
  ownedQty: 3,
  qtyAvailable: 4,
  seller: 5,
  restockInfo: 6,
  manualCostPrice: 7,
  manualPresaleArrivalDate: 8,
  presaleInfoProtectUntil: 9,
  effectiveCostPrice: 10,
  sourceUnitPrice: 11,
});

/**
 * Resolve product data for a set of B2B item codes from Supabase.
 *
 * @param {Object} client — Supabase client from createBaserowClient()
 * @param {string[]} itemCodes — B2B item codes to look up
 * @returns {Promise<Map<string, Object>>} Map<itemCode, productRow>
 */
export async function resolveProductsByItemCodes(client, itemCodes) {
  const unique = [...new Set(itemCodes.filter(Boolean))];
  if (!unique.length) return new Map();

  // Supabase/PostgREST has a maximum IN clause length. Batch to stay safe.
  const BATCH_SIZE = 200;
  const map = new Map();

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);

    const { data, error } = await client.supabase
      .from("product_variants")
      .select("id, item_code, product_commercials(effective_cost_price, effective_tcogs, source_unit_price, owned_qty, source_available_qty, audit_notes, manual_cost_price, manual_presale_arrival_date, presale_info_protect_until)")
      .in("item_code", batch);

    if (error) {
      throw new Error(`supabase_product_resolve_failed:${error.message}`);
    }

    for (const row of Array.isArray(data) ? data : []) {
      // product_commercials returns as an array (one-to-many via FK), or as
      // a single object when the Supabase schema marks the FK as unique.
      // Take the first element defensively.
      const commercial = row.product_commercials;
      const comm = Array.isArray(commercial) && commercial.length > 0
        ? commercial[0]
        : (commercial && !Array.isArray(commercial) ? commercial : null);

      map.set(row.item_code, {
        [`field_${PRODUCT_FIELD_IDS.itemCode}`]: row.item_code,
        [`field_${PRODUCT_FIELD_IDS.effectiveTcogs}`]: comm?.effective_tcogs ?? comm?.effective_cost_price ?? null,
        [`field_${PRODUCT_FIELD_IDS.ownedQty}`]: comm?.owned_qty ?? null,
        [`field_${PRODUCT_FIELD_IDS.qtyAvailable}`]: comm?.source_available_qty ?? null,
        [`field_${PRODUCT_FIELD_IDS.seller}`]: "", // not in Supabase
        [`field_${PRODUCT_FIELD_IDS.restockInfo}`]: comm?.audit_notes ?? "",
        [`field_${PRODUCT_FIELD_IDS.manualCostPrice}`]: comm?.manual_cost_price ?? null,
        [`field_${PRODUCT_FIELD_IDS.manualPresaleArrivalDate}`]: comm?.manual_presale_arrival_date ?? null,
        [`field_${PRODUCT_FIELD_IDS.presaleInfoProtectUntil}`]: comm?.presale_info_protect_until ?? null,
        [`field_${PRODUCT_FIELD_IDS.effectiveCostPrice}`]: comm?.effective_cost_price ?? null,
        [`field_${PRODUCT_FIELD_IDS.sourceUnitPrice}`]: comm?.source_unit_price ?? null,
        // Canonical product identity (product_variants.id) — stored on
        // component lines as variant_id so the line links to the exact variant.
        variantId: row.id ?? null,
      });
    }
  }

  return map;
}

/**
 * Return hardcoded product field metadata for the Supabase backend.
 * Mirrors the shape returned by resolveProductFields() in product-resolver.mjs
 * so portal consumers can use the same field ID accessors unchanged.
 *
 * @returns {{
 *   itemCodeFieldId: number,
 *   effectiveTcogsFieldId: number,
 *   ownedQtyFieldId: number,
 *   qtyAvailableFieldId: number,
 *   sellerFieldId: number,
 *   restockInfoFieldId: number,
 *   manualCostPriceFieldId: number,
 *   manualPresaleArrivalDateFieldId: number,
 *   presaleInfoProtectUntilFieldId: number,
 *   itemCodeFieldName: string,
 *   effectiveTcogsFieldName: string,
 *   ownedQtyFieldName: string,
 *   qtyAvailableFieldName: string,
 *   sellerFieldName: string,
 *   restockInfoFieldName: string,
 *   manualCostPriceFieldName: string,
 *   manualPresaleArrivalDateFieldName: string,
 *   presaleInfoProtectUntilFieldName: string,
 * }}
 */
export function getSupabaseProductFields() {
  return {
    itemCodeFieldId: PRODUCT_FIELD_IDS.itemCode,
    effectiveTcogsFieldId: PRODUCT_FIELD_IDS.effectiveTcogs,
    effectiveCostPriceFieldId: PRODUCT_FIELD_IDS.effectiveCostPrice,
    sourceUnitPriceFieldId: PRODUCT_FIELD_IDS.sourceUnitPrice,
    ownedQtyFieldId: PRODUCT_FIELD_IDS.ownedQty,
    qtyAvailableFieldId: PRODUCT_FIELD_IDS.qtyAvailable,
    sellerFieldId: PRODUCT_FIELD_IDS.seller,
    restockInfoFieldId: PRODUCT_FIELD_IDS.restockInfo,
    manualCostPriceFieldId: PRODUCT_FIELD_IDS.manualCostPrice,
    manualPresaleArrivalDateFieldId: PRODUCT_FIELD_IDS.manualPresaleArrivalDate,
    presaleInfoProtectUntilFieldId: PRODUCT_FIELD_IDS.presaleInfoProtectUntil,
    itemCodeFieldName: "Gigab2b Item Code",
    effectiveTcogsFieldName: "Effective TCOGS",
    effectiveCostPriceFieldName: "Effective COGS",
    sourceUnitPriceFieldName: "Giga Unit Price",
    ownedQtyFieldName: "Owned Qty",
    qtyAvailableFieldName: "Qty Available",
    sellerFieldName: "seller",
    restockInfoFieldName: "Restock Info",
    manualCostPriceFieldName: "Manual Cost Price",
    manualPresaleArrivalDateFieldName: "Manual Presale Arrival Date",
    presaleInfoProtectUntilFieldName: "Presale Info Protect Until",
  };
}

// ============================================================================
// Internal: string trimming (mirrors baserow.mjs trimAndCollapse)
// ============================================================================

function trimStr(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
