// ── Product Resolver ──────────────────────────────────────────────────
//
// Product-table field discovery, product lookup by B2B item code, and
// pure computation functions for margin, stock status, and risk badges.
//
// Used by the Order Review Portal (worker/index.js portal API handlers).
// Follows the same raw-fetch pattern as scripts/build_price_seeking_helper.mjs
// for the Products table (886994), which is not accessed through baserow.mjs.
//
// When DATABASE_BACKEND=supabase, delegates to the Supabase adapter for
// field metadata (hardcoded pseudo IDs) and bulk product resolution (single
// JOIN query instead of N individual HTTP calls).
//
// Exports:
//   Field discovery:
//     resolveProductFields(env, productsTableId)
//     baserowListFields(env, tableId)
//     findFieldId(fieldIdByName, candidates)
//   Product lookup:
//     findProductByItemCode(env, productsTableId, itemCodeFieldId, itemCode)
//     batchResolveProducts(env, productsTableId, itemCodeFieldId, itemCodes)
//     baserowRequest(env, url, options)
//   Row reading (numeric field ID access, user_field_names=false):
//     readProductField(row, fieldId)
//     readProductNumber(row, fieldId)
//     readSelectValue(value)  — re-exported from order-state.mjs
//   Pure computation:
//     computeMargin(salesRow, productData, commissionRate, fieldIds)
//     computeStockStatus(ownedQty, qtyAvailable, orderQty)
//     assessRiskBadges(salesRow, productData, marginResult, stockResult)
// ──────────────────────────────────────────────────────────────────────

import { statusEquals, getPipelineState, PIPELINE_STATE, ORDER_STATUS, REVIEW_STATUS, readSelectValue } from "./order-state.mjs";
export { readSelectValue } from "./order-state.mjs";

// ── Backend detection ─────────────────────────────────────────────────

function isSupabaseBackend(env) {
  return String(env?.DATABASE_BACKEND ?? "").trim().toLowerCase() === "supabase";
}

// ── Field discovery ──────────────────────────────────────────────────

/**
 * Discover product-table field IDs by listing all fields and matching
 * candidate names. Returns an object with numeric field IDs and resolved
 * field names for each discovered field.
 *
 * @param {Object} env - Worker env with BASEROW_DATABASE_TOKEN, BASEROW_API_BASE
 * @param {number} [productsTableId=886994]
 * @returns {Promise<{
 *   itemCodeFieldId: number,
 *   effectiveTcogsFieldId: number,
 *   effectiveCostPriceFieldId: number,
 *   sourceUnitPriceFieldId: number,
 *   ownedQtyFieldId: number,
 *   qtyAvailableFieldId: number,
 *   sellerFieldId: number,
 *   restockInfoFieldId: number|null,
 *   itemCodeFieldName: string,
 *   effectiveTcogsFieldName: string,
 *   ownedQtyFieldName: string,
 *   qtyAvailableFieldName: string,
 *   sellerFieldName: string,
 *   restockInfoFieldName: string,
 * }>}
 */
export async function resolveProductFields(env, productsTableId = 886994) {
  // Supabase: return hardcoded pseudo field IDs — no API call needed.
  if (isSupabaseBackend(env)) {
    const { getSupabaseProductFields } = await import("./db.mjs");
    return getSupabaseProductFields();
  }

  const fields = await baserowListFields(env, productsTableId);
  const fieldIdByName = new Map(
    fields.map((f) => [String(f.name || "").trim(), Number(f.id)])
  );

  const itemCodeFieldId = findFieldId(fieldIdByName, [
    "Gigab2b Item Code", "GigaB2B Item Code", "Giga Item Code",
    "Item Code", "item code", "SKU1商品管理コード",
  ]);
  if (!itemCodeFieldId) throw new Error("Missing product field: Gigab2b Item Code");

  const effectiveTcogsFieldId = findFieldId(fieldIdByName, [
    "Effective TCOGS", "Effective TCOGS (JPY)", "effective_tcogs",
    "TCOGS", "tcogs", "Cost of Goods", "COGS",
  ]);

  const effectiveCostPriceFieldId = findFieldId(fieldIdByName, [
    "Effective COGS", "Effective COGS (JPY)", "effective_cost_price",
  ]);

  const sourceUnitPriceFieldId = findFieldId(fieldIdByName, [
    "Unit Price", "Source Unit Price", "source_unit_price",
  ]);

  const ownedQtyFieldId = findFieldId(fieldIdByName, [
    "Owned Qty", "Owned quantity", "Owned Quantity",
  ]);

  const qtyAvailableFieldId = findFieldId(fieldIdByName, [
    "Qty Available", "Quantity Available", "Available Qty",
  ]);

  const sellerFieldId = findFieldId(fieldIdByName, [
    "seller", "Seller", "Vendor", "vendor",
    "Store Name", "Store Code", "Seller Type",
  ]);

  const restockInfoFieldId = findFieldId(fieldIdByName, [
    "Restock Info", "restock_info", "Restock Information",
  ]);

  // Resolve field names for display (reverse lookup)
  const idToName = new Map(fields.map((f) => [Number(f.id), String(f.name || "").trim()]));

  return {
    itemCodeFieldId,
    effectiveTcogsFieldId,
    effectiveCostPriceFieldId,
    sourceUnitPriceFieldId,
    ownedQtyFieldId,
    qtyAvailableFieldId,
    sellerFieldId,
    restockInfoFieldId,
    itemCodeFieldName: idToName.get(itemCodeFieldId) || "Gigab2b Item Code",
    effectiveTcogsFieldName: idToName.get(effectiveTcogsFieldId) || "",
    effectiveCostPriceFieldName: idToName.get(effectiveCostPriceFieldId) || "",
    sourceUnitPriceFieldName: idToName.get(sourceUnitPriceFieldId) || "",
    ownedQtyFieldName: idToName.get(ownedQtyFieldId) || "",
    qtyAvailableFieldName: idToName.get(qtyAvailableFieldId) || "",
    sellerFieldName: idToName.get(sellerFieldId) || "",
    restockInfoFieldName: idToName.get(restockInfoFieldId) || "Restock Info",
  };
}

/**
 * List all fields from a Baserow table.
 * GET /database/fields/table/{tableId}/
 *
 * @param {Object} env
 * @param {number} tableId
 * @returns {Promise<Array<{id: number, name: string, type: string}>>}
 */
export async function baserowListFields(env, tableId) {
  const base = trimText(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  const url = `${base}/database/fields/table/${encodeURIComponent(tableId)}/`;
  const res = await baserowRequest(env, url);
  if (!res.ok) throw new Error(`baserow_fields_failed:${res.status}`);
  return Array.isArray(res.body) ? res.body : [];
}

/**
 * Find the first matching numeric field ID from a map of field name → ID.
 * Returns 0 if no candidate matches.
 *
 * @param {Map<string, number>} fieldIdByName
 * @param {string[]} candidates
 * @returns {number}
 */
export function findFieldId(fieldIdByName, candidates) {
  for (const name of candidates) {
    const id = fieldIdByName.get(String(name || "").trim());
    if (Number.isFinite(id) && id > 0) return id;
  }
  return 0;
}

// ── Product lookup ───────────────────────────────────────────────────

/**
 * Find a single product row by B2B item code.
 * Uses filter__field_{id}__equal on the Products table.
 * Returns row data keyed by field_${id} (user_field_names=false).
 *
 * @param {Object} env
 * @param {number} productsTableId
 * @param {number} itemCodeFieldId - numeric field ID for item code column
 * @param {string} itemCode - exact item code to search
 * @returns {Promise<Object|null>} product row or null
 */
export async function findProductByItemCode(env, productsTableId, itemCodeFieldId, itemCode) {
  if (!itemCode) return null;

  // Supabase: single-product lookup via bulk resolver (deduplicates within
  // the single call — no overhead vs a dedicated single-lookup query).
  if (isSupabaseBackend(env)) {
    const { createBaserowClient, resolveProductsByItemCodes } = await import("./db.mjs");
    const client = createBaserowClient(env);
    const map = await resolveProductsByItemCodes(client, [itemCode]);
    return map.get(itemCode) || null;
  }

  if (!itemCodeFieldId) return null;
  const base = trimText(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  const url = new URL(
    `${base}/database/rows/table/${encodeURIComponent(productsTableId)}/`
  );
  url.searchParams.set("size", "1");
  url.searchParams.set(
    `filter__field_${String(itemCodeFieldId)}__equal`,
    itemCode
  );
  const res = await baserowRequest(env, url.toString());
  if (!res.ok) {
    console.warn(`findProductByItemCode failed: status=${res.status} itemCode=${itemCode} detail=${JSON.stringify(res.body).slice(0, 200)}`);
    return null;
  }
  const body = res.body && typeof res.body === "object" ? res.body : {};
  const results = Array.isArray(body.results) ? body.results : [];
  return results.length ? results[0] : null;
}

/**
 * Resolve products for multiple item codes. Deduplicates item codes and
 * returns a Map<itemCode, productRow|null>. Each unique item code is
 * looked up once; results are cached within the Map.
 *
 * Uses parallel fetches (concurrency-limited to avoid subrequest exhaustion)
 * instead of sequential — cuts lookup time from N×RTT to RTT×ceil(N/concurrency).
 *
 * @param {Object} env
 * @param {number} productsTableId
 * @param {number} itemCodeFieldId
 * @param {string[]} itemCodes
 * @param {number} [concurrency=10]
 * @returns {Promise<Map<string, Object|null>>}
 */
export async function batchResolveProducts(env, productsTableId, itemCodeFieldId, itemCodes, concurrency = 10) {
  // Supabase: single JOIN query instead of N individual HTTP calls.
  if (isSupabaseBackend(env)) {
    const { createBaserowClient, resolveProductsByItemCodes } = await import("./db.mjs");
    const client = createBaserowClient(env);
    return resolveProductsByItemCodes(client, itemCodes);
  }

  const cache = new Map();
  const unique = [...new Set(itemCodes.filter(Boolean))];

  // Process in parallel batches to stay under subrequest limits
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((code) =>
        findProductByItemCode(env, productsTableId, itemCodeFieldId, code)
          .then((row) => ({ code, row }))
          .catch(() => ({ code, row: null }))
      )
    );
    for (const { code, row } of results) {
      cache.set(code, row);
    }
  }
  return cache;
}

/**
 * Bulk-fetch all products from the Products table and build a lookup Map
 * keyed by item code. Uses paginated listAllRows (200 per page) to fetch
 * economically, then indexes in-memory — replaces N individual API calls
 * with ~(total_products / 200) calls.
 *
 * @param {Object} env
 * @param {number} productsTableId
 * @param {number} itemCodeFieldId - numeric field ID for the item code column
 * @param {number} [pageSize=200]
 * @returns {Promise<Map<string, Object>>} Map<itemCode, productRow>
 */
export async function bulkFetchProducts(env, productsTableId, itemCodeFieldId, pageSize = 200) {
  const map = new Map();
  const token = trimText(env.BASEROW_DATABASE_TOKEN);
  const base = trimText(env.BASEROW_API_BASE) || "https://api.baserow.io/api";
  // Match the URL pattern used by baserow.mjs listAllRows (without user_field_names
  // since readProductField accesses data via field_{id} numeric keys)
  const baseUrl = `${base}/database/rows/table/${encodeURIComponent(productsTableId)}/?size=${pageSize}`;
  let nextUrl = baseUrl;
  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`products_bulk_fetch_failed:${res.status} body=${errorText.slice(0, 200)}`);
    }
    const body = await res.json().catch(() => ({}));
    const pageRows = Array.isArray(body.results) ? body.results : [];
    for (const row of pageRows) {
      const code = readProductField(row, itemCodeFieldId);
      if (code) map.set(code, row);
    }
    nextUrl = body.next ? normalizeBaserowNextUrl(body.next) : "";
  }
  return map;
}

/**
 * Normalize a Baserow next-page URL. Baserow returns relative URLs like
 * "/api/database/rows/table/{id}/?page=2&size=200" — ensure they are
 * absolute so they work from any caller.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeBaserowNextUrl(rawUrl) {
  if (!rawUrl) return "";
  const trimmed = trimText(rawUrl);
  if (trimmed.startsWith("http://api.baserow.io/")) {
    return `https://${trimmed.slice("http://".length)}`;
  }
  if (trimmed.startsWith("http")) return trimmed;
  return `https://api.baserow.io${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

/**
 * Lightweight Baserow GET/POST request. Uses Token auth from env,
 * single-shot (no retry). For the Products table which is not accessed
 * through baserow.mjs.
 *
 * @param {Object} env
 * @param {string} url
 * @param {{ method?: string, body?: any }} [options]
 * @returns {Promise<{ok: boolean, status: number, body: any}>}
 */
export async function baserowRequest(env, url, { method = "GET", body = null } = {}) {
  const token = trimText(env.BASEROW_DATABASE_TOKEN);
  const headers = {
    Authorization: `Token ${token}`,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

// ── Row reading (numeric field ID access) ────────────────────────────

/**
 * Read a text value from a product row using numeric field ID.
 * Row is keyed by field_${id} (user_field_names=false from Baserow).
 *
 * Handles all Baserow field types: text, number, boolean, array (takes
 * first element), single-select objects (extracts .value).
 *
 * @param {Object} row
 * @param {number} fieldId
 * @returns {string}
 */
export function readProductField(row, fieldId) {
  if (!fieldId || !row || typeof row !== "object") return "";
  const key = `field_${String(fieldId)}`;
  const value = row[key];
  if (value == null) return "";
  if (typeof value === "string") return trimText(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return trimText(String(value));
  }
  if (Array.isArray(value)) {
    return value.length ? readProductField({ [key]: value[0] }, fieldId) : "";
  }
  if (typeof value === "object") {
    for (const k of ["value", "name", "label", "text", "displayName"]) {
      if (typeof value[k] === "string" && trimText(value[k])) {
        return trimText(value[k]);
      }
    }
  }
  return "";
}

/**
 * Read a numeric value from a product row. Returns null if the field
 * is missing or the value cannot be parsed as a finite number.
 *
 * @param {Object} row
 * @param {number} fieldId
 * @returns {number|null}
 */
export function readProductNumber(row, fieldId) {
  const raw = readProductField(row, fieldId);
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// ── Pure computation ─────────────────────────────────────────────────

/**
 * Compute estimated margin for a single sales order line.
 * Quantity-aware: multiplies per-unit values by quantity.
 *
 * Formula:
 *   totalRevenue  = product_price × quantity
 *   totalShipping = shipping_price
 *   commission    = (totalRevenue + totalShipping) × commissionRate
 *   totalTcogs    = effectiveTcogs × quantity
 *   profit        = totalRevenue + totalShipping − commission − totalTcogs
 *   marginPercent = profit / (totalRevenue + totalShipping) × 100
 *
 * Returns null for profit/marginPercent when critical data is missing.
 *
 * @param {Object} salesRow - with { product_price, quantity, shipping_price }
 * @param {Object|null} productData - product row or null
 * @param {number} commissionRate - e.g. 0.10 for 10%
 * @param {{ effectiveTcogsFieldId: number, effectiveCostPriceFieldId?: number, sourceUnitPriceFieldId?: number }} fieldIds
 * @returns {{
 *   revenue: number|null,
 *   shipping: number|null,
 *   commission: number|null,
 *   tcogs: number|null,
 *   profit: number|null,
 *   marginPercent: number|null,
 *   hasTcogs: boolean,
 *   tcogsSource: string,
 *   effectiveTcogsPerUnit: number|null,
 *   unitPrice: number|null,
 *   effectiveCogsPerUnit: number|null,
 *   sourceUnitPrice: number|null,
 *   cogsEqualsUnitPrice: boolean,
 * }}
 */
export function computeMargin(salesRow, productData, commissionRate, fieldIds) {
  const productPrice = parseFloatOrNull(salesRow && salesRow.product_price);
  const shippingPrice = parseFloatOrNull(salesRow && salesRow.shipping_price) || 0;
  const quantity = parsePositiveInt(salesRow && salesRow.quantity) || 0;

  const effectiveTcogs = productData
    ? readProductNumber(productData, fieldIds.effectiveTcogsFieldId)
    : null;
  const effectiveCogs = productData && fieldIds.effectiveCostPriceFieldId
    ? readProductNumber(productData, fieldIds.effectiveCostPriceFieldId)
    : null;
  const sourceUnitPrice = productData && fieldIds.sourceUnitPriceFieldId
    ? readProductNumber(productData, fieldIds.sourceUnitPriceFieldId)
    : null;
  const cogsEqualsUnitPrice = effectiveCogs != null && sourceUnitPrice != null && effectiveCogs === sourceUnitPrice;

  const totalRevenue = productPrice != null ? productPrice * quantity : null;
  const totalShipping = shippingPrice;
  const revenueBase = totalRevenue != null ? totalRevenue + totalShipping : null;
  const commission = revenueBase != null
    ? Math.round(revenueBase * commissionRate * 100) / 100
    : null;
  const totalTcogs = effectiveTcogs != null ? effectiveTcogs * quantity : null;

  const hasTcogs = effectiveTcogs != null;
  const tcogsSource = hasTcogs ? "product_table" : "missing";

  if (revenueBase == null || revenueBase === 0 || !hasTcogs) {
    return {
      revenue: totalRevenue,
      shipping: totalShipping,
      commission,
      tcogs: totalTcogs,
      profit: null,
      marginPercent: null,
      hasTcogs,
      tcogsSource,
      effectiveTcogsPerUnit: effectiveTcogs,
      effectiveCogsPerUnit: effectiveCogs,
      sourceUnitPrice,
      unitPrice: productPrice,
      cogsEqualsUnitPrice,
    };
  }

  const profit = totalRevenue + totalShipping - (commission || 0) - totalTcogs;
  const marginPercent = Math.round((profit / revenueBase) * 10000) / 100;

  return {
    revenue: totalRevenue,
    shipping: totalShipping,
    commission,
    tcogs: totalTcogs,
    profit: Math.round(profit * 100) / 100,
    marginPercent,
    hasTcogs,
    tcogsSource,
    effectiveTcogsPerUnit: effectiveTcogs,
    effectiveCogsPerUnit: effectiveCogs,
    sourceUnitPrice,
    unitPrice: productPrice,
    cogsEqualsUnitPrice,
  };
}

/**
 * Assess stock adequacy against order quantity.
 * Displays BOTH owned_qty and qty_available — never collapses to max().
 *
 * @param {number|null} ownedQty
 * @param {number|null} qtyAvailable
 * @param {number} orderQty
 * @returns {{ status: string, label: string, ownedQty: number|null, qtyAvailable: number|null }}
 */
export function computeStockStatus(ownedQty, qtyAvailable, orderQty) {
  const owned = ownedQty != null && Number.isFinite(ownedQty) ? ownedQty : null;
  const avail = qtyAvailable != null && Number.isFinite(qtyAvailable) ? qtyAvailable : null;
  const qty = orderQty > 0 ? orderQty : 0;

  if (owned == null && avail == null) {
    return { status: "unknown", label: "Stock Unknown", ownedQty: null, qtyAvailable: null };
  }

  // Own stock covers the order
  if (owned != null && owned >= qty) {
    return { status: "owned_ok", label: "Own Stock OK", ownedQty: owned, qtyAvailable: avail };
  }

  // Supplier can fulfill (even if own stock is low)
  if (avail != null && avail >= qty) {
    return { status: "supplier_ok", label: "Supplier OK", ownedQty: owned, qtyAvailable: avail };
  }

  // Some stock but not enough
  if ((owned != null && owned > 0) || (avail != null && avail > 0)) {
    return { status: "partial", label: "Partial Stock", ownedQty: owned, qtyAvailable: avail };
  }

  return { status: "needs_procurement", label: "Needs Procurement", ownedQty: owned, qtyAvailable: avail };
}

/**
 * Assess risk badges for an order. Returns array sorted by severity
 * (critical first, then warning, then info).
 *
 * @param {Object} salesRow - with { review_status }
 * @param {Object|null} productData
 * @param {{ marginPercent: number|null, hasTcogs: boolean }} marginResult
 * @param {{ status: string }} stockResult
 * @returns {Array<{ type: string, label: string, severity: string }>}
 */
export function assessRiskBadges(salesRow, productData, marginResult, stockResult) {
  const badges = [];

  // A locally-cancelled order is terminal — surface a single prominent badge
  // instead of the normal stock/margin/risk state.
  if (statusEquals(readSelectValue(salesRow && salesRow.review_status), REVIEW_STATUS.CANCELED)) {
    badges.push({ type: "locally_cancelled", label: "Locally Cancelled", severity: "critical" });
    return badges;
  }

  const { marginPercent, hasTcogs } = marginResult || {};
  const stockStatus = stockResult && stockResult.status;

  // Margin risks
  if (marginPercent != null && marginPercent < 0) {
    badges.push({ type: "negative_margin", label: "Negative Margin", severity: "critical" });
  } else if (marginPercent != null && marginPercent < 10) {
    badges.push({ type: "low_margin", label: "Low Margin", severity: "warning" });
  }

  // Stock risks
  if (stockStatus === "partial" || stockStatus === "needs_procurement") {
    badges.push({ type: "stock_shortage", label: "Stock Shortage", severity: "critical" });
  } else if (stockStatus === "unknown") {
    badges.push({ type: "stock_unknown", label: "Stock Unknown", severity: "warning" });
  }

  // Product/TCOGS risks
  if (!productData) {
    badges.push({ type: "no_product", label: "No Product Match", severity: "warning" });
  } else if (!hasTcogs) {
    badges.push({ type: "no_tcogs", label: "No COGS Data", severity: "warning" });
  }
  if (marginResult?.cogsEqualsUnitPrice) {
    badges.push({ type: "cogs_unit_price_equal", label: "Effective COGS = Giga Unit Price", severity: "warning" });
  }

  // Review / Order status
  const orderStatus = salesRow && salesRow.order_status ? (typeof salesRow.order_status === "object" ? salesRow.order_status.value : String(salesRow.order_status)) : "";
  const reviewStatus = readSelectValue(salesRow && salesRow.review_status);
  if (statusEquals(orderStatus, ORDER_STATUS.WAITING_FOR_PAYMENT)) {
    badges.push({ type: "waiting_payment", label: "Waiting for Payment", severity: "payment" });
  } else if (statusEquals(reviewStatus, REVIEW_STATUS.PENDING_REVIEW)) {
    badges.push({ type: "pending_review", label: "Pending Review", severity: "info" });
  }

  // Pipeline state (informational — low-risk active states only)
  const pipelineState = getPipelineState(salesRow?.order_status, salesRow?.review_status);
  if (pipelineState === PIPELINE_STATE.READY_TO_SHIP) {
    badges.push({ type: "pipeline_state", label: "Pipeline: Ready to Ship", severity: "info" });
  }

  // Sort: critical → warning → info → payment (stable sort by extracting groups)
  const severityOrder = { critical: 0, warning: 1, info: 2, payment: 3 };
  const sorted = [];
  for (const sev of ["critical", "warning", "info", "payment"]) {
    for (const b of badges) {
      if (b.severity === sev) sorted.push(b);
    }
  }

  return sorted;
}

// ── Order-level economics (multi-line component orders) ──────────────

/**
 * Compute the TCOGS total for a single sales line (per-unit TCOGS × qty).
 * Returns null when the line has no resolved product or no TCOGS data.
 *
 * @param {Object} row - sales line with { B2BItemCode, quantity }
 * @param {Map<string, Object|null>} productCache - itemCode → product row
 * @param {{ effectiveTcogsFieldId: number }} productFields
 * @returns {number|null}
 */
export function lineTcogs(row, productCache, productFields) {
  const itemCode = trimText(row && row.B2BItemCode);
  if (!itemCode) return null;
  const productData = productCache && productCache.get ? productCache.get(itemCode) : null;
  if (!productData) return null;
  const perUnit = readProductNumber(productData, productFields.effectiveTcogsFieldId);
  if (perUnit == null) return null;
  const qty = parsePositiveInt(row && row.quantity);
  return perUnit * qty;
}

/**
 * Aggregate economics across every non-fee line of an order.
 *
 * Revenue and shipping are counted once from the anchor line; commission is
 * computed on (revenue + shipping); TCOGS is the sum of per-line TCOGS (per-unit
 * × qty) across all lines that carry resolved product cost data. Lines without
 * product data (e.g. the anchor header of a manual-component order) contribute
 * zero TCOGS.
 *
 * profit/marginPercent are null (missing data) when the order has no TCOGS
 * data at all.
 *
 * @param {Object} anchor - anchor sales line ({ product_price, shipping_price, quantity })
 * @param {Object[]} lines - non-fee sales lines (incl. anchor)
 * @param {Map<string, Object|null>} productCache - itemCode → product row
 * @param {{ effectiveTcogsFieldId: number, effectiveCostPriceFieldId?: number, sourceUnitPriceFieldId?: number }} productFields
 * @param {number} commissionRate
 * @returns {{ revenue: number|null, shipping: number, commission: number|null, tcogs: number|null, profit: number|null, marginPercent: number|null, hasTcogs: boolean, tcogsSource: string, lineTcogs: Array<{ id: *, quantity: number, tcogs: number|null }> }}
 */
export function computeOrderEconomics(anchor, lines, productCache, productFields, commissionRate) {
  const productPrice = parseFloatOrNull(anchor && anchor.product_price);
  const shippingPrice = parseFloatOrNull(anchor && anchor.shipping_price) || 0;
  const anchorQty = parsePositiveInt(anchor && anchor.quantity);
  const revenue = productPrice != null ? productPrice * anchorQty : null;
  const revenueBase = revenue != null ? revenue + shippingPrice : null;
  const commission = revenueBase != null
    ? Math.round(revenueBase * commissionRate * 100) / 100
    : null;

  const safeLines = Array.isArray(lines) ? lines : [];
  const lineDetails = safeLines.map((row) => {
    const tcogs = lineTcogs(row, productCache, productFields);
    return { id: row && row.id, quantity: parsePositiveInt(row && row.quantity), tcogs };
  });

  const known = lineDetails.filter((line) => line.tcogs != null);
  const hasTcogs = known.length > 0;
  const totalTcogs = hasTcogs
    ? Math.round(known.reduce((sum, line) => sum + line.tcogs, 0) * 100) / 100
    : null;

  if (revenueBase == null || revenueBase === 0 || !hasTcogs) {
    return {
      revenue,
      shipping: shippingPrice,
      commission,
      tcogs: totalTcogs,
      profit: null,
      marginPercent: null,
      hasTcogs,
      tcogsSource: hasTcogs ? "product_table" : "missing",
      lineTcogs: lineDetails,
    };
  }

  const profit = Math.round((revenueBase - (commission || 0) - totalTcogs) * 100) / 100;
  const marginPercent = Math.round((profit / revenueBase) * 10000) / 100;

  return {
    revenue,
    shipping: shippingPrice,
    commission,
    tcogs: totalTcogs,
    profit,
    marginPercent,
    hasTcogs,
    tcogsSource: "product_table",
    lineTcogs: lineDetails,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

function trimText(value) {
  return String(value == null ? "" : value).trim();
}

function parseFloatOrNull(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parsePositiveInt(value) {
  if (value == null) return 0;
  const n = Number.parseInt(String(value).replace(/,/g, "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
