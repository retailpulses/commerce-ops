/**
 * Portal API handler functions and helpers.
 *
 * Extracted from worker/index.js for sharing between the Cloudflare Worker
 * and the future Node.js-based portal API server.
 */

import { createBaserowClient, createRow, listAllRows, listRowsWithLimit, patchRow, setOrderReviewStatusViaRpc, FIELD, OPTION } from "../db.mjs";
import { runMercariOrderMessagesViaRelay, runMercariOrderReplyViaRelay } from "../mercari-relay.mjs";
import { getPortalProductFields, invalidatePortalListCache } from "./cache.mjs";
import { MERCARI_CHANNEL } from "../channel-config.mjs";
import { createRakutenItemCodeResolver } from "../item-code-resolver.mjs";
import { allocateLineCommercialValues } from "../line-allocation.mjs";
import {
  listTemplates as sbListTemplates,
  getTemplate as sbGetTemplate,
  createTemplate as sbCreateTemplate,
  updateTemplate as sbUpdateTemplate,
  deleteTemplate as sbDeleteTemplate,
  reorderTemplates as sbReorderTemplates,
} from "./templates-store.mjs";
import {
  findProductByItemCode,
  batchResolveProducts,
  computeMargin,
  computeOrderEconomics,
  computeStockStatus,
  assessRiskBadges,
  lineTcogs,
  readProductField,
  readProductNumber,
} from "../product-resolver.mjs";
import { classifyUnreadStatus, markAsRead, readDurableState, buildDurableStateKey, writeThroughMessageFacts } from "../buyer-messages.mjs";
import { setIdempotencyGuard, deleteIdempotencyGuard } from "../idempotency.mjs";
import {
  getJstEarliestDeliveryDate,
  toJstIso,
  formatJstDateTime,
} from "../timezone.mjs";
import {
  GIGA_SYNC_STATUS,
  ORDER_STATUS,
  REVIEW_STATUS,
  getPipelineState,
  readSelectValue,
  statusEquals,
  isValidReviewMutation,
} from "../order-state.mjs";
import {
  LIFECYCLE,
  REVIEW_FILTER,
  applyPortalOrderSearch,
  isActivePipelineState,
  validatePortalParams,
  text as sharedText,
} from "./shared.mjs";
import { buildServerFilters, listPortalSalesRows, platformSkuForRow } from "./order-list.mjs";
import { fetchPortalProductManualFields } from "./product-update.mjs";
import { text, parseInteger, normalizeOrderIdCandidate, normalizeErrorMessage } from "../worker-helpers.mjs";
import {
  isRakutenShipmentReady,
  planRakutenConfirmation,
  rakutenBlockingReason,
} from "../rakuten-status-gates.mjs";

// ═══════════════════════════════════════════════════════════════════
// Portal helpers & API handlers (order review portal)
// ═══════════════════════════════════════════════════════════════════

const PORTAL_PRODUCTS_TABLE_ID = 886994;
const PORTAL_PAGE_SIZE = 50;
const PORTAL_MAX_SALES_ROWS = 100;  // Hard cap to prevent Worker timeout (product lookups ~1-2s each)
const PORTAL_MAX_FEE_ROWS = 50;    // Fee rows are rare — cap at 50 to prevent timeout on degenerate cases
const PORTAL_FEE_PATTERNS = ["各種手数料", "追加支払い・追加送料専用"];

/**
 * Payment is a hard prerequisite for approval on every sales channel.
 * Keeping this check at the write boundary protects single and bulk portal
 * actions even when a client renders a stale Approve button.
 */
export function isApprovalBlockedByPaymentStatus(orderStatus, targetReviewStatus) {
  return statusEquals(orderStatus, ORDER_STATUS.WAITING_FOR_PAYMENT)
    && statusEquals(targetReviewStatus, REVIEW_STATUS.APPROVED);
}

// ── Portal caches (module-level, shared across requests) ──────────

async function getProductFields(env, productsTableId) {
  return getPortalProductFields(env, productsTableId);
}

// Summary cache: scoped by query params, 30-second TTL.
// Degraded results have shorter TTL to retry faster.

/**
 * Validate Bearer token against PORTAL_ACCESS_TOKEN env secret.
 * Constant-time comparison to prevent timing attacks.
 */
export function requirePortalAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  const expected = text(env.PORTAL_ACCESS_TOKEN);
  if (!expected || !token) return false;
  if (token.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

export function requireTicketOrderContextAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  const expected = text(env.TICKET_ORDER_CONTEXT_SECRET);
  if (!expected || !token || token.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return result === 0;
}

/**
 * Check if a product_name value indicates a fee/adjustment row.
 * Matches the shouldSkipFeeRow / shouldSkipProductName pattern from
 * outbound-sync.mjs and pipeline-health.mjs.
 */
function isFeeRow(productName) {
  const normalized = text(productName);
  for (const pattern of PORTAL_FEE_PATTERNS) {
    if (normalized.includes(pattern)) return true;
    if (normalized === pattern) return true;
  }
  return false;
}

/**
 * Build a customer identity key for linking fee orders to main orders.
 * Primary: shipping_phone_number + shop_id (unique per customer).
 * Fallback: shipping_name + shipping_postal_code + shop_id (when phone empty).
 * Returns null when customer fields are empty (can't match).
 */
function getCustomerKey(row) {
  const phone = String(row.shipping_phone_number || "").trim();
  const shop = String(row.shop_id || "").trim();
  if (phone && shop) return `phone:${phone}:${shop}`;
  const name = String(row.shipping_name || "").trim();
  const postal = String(row.shipping_postal_code || "").trim();
  if (name && postal && shop) return `name:${name}:${postal}:${shop}`;
  return null;
}

// ── GET /api/portal/orders ──────────────────────────────────────────

// ── GET /api/portal/orders ──────────────────────────────────────────

// ── GET /api/portal/orders/:id ─────────────────────────────────────

export async function handlePortalOrderDetail(env, orderId) {
  const baserow = createBaserowClient(env);
  const commissionRate = parseFloat(String(env.PORTAL_COMMISSION_RATE_MERCARI || "0.10"));

  const row = await findSalesOrderByOrderId(baserow, orderId);

  if (!row) {
    return { ok: false, error: "order_not_found", statusCode: 404 };
  }

  const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
  const productFields = await getProductFields(env, productsTableId);
  const order = await enrichOrderDetail(env, row, productFields, commissionRate);
  const orderLineRows = (await findSalesOrderLinesByOrderId(baserow, orderId, text(row.shop_id)))
    .filter((candidate) => !isFeeRow(candidate.product_name));
  const lineItemCodes = [...new Set(orderLineRows.map((candidate) => text(candidate.B2BItemCode)).filter(Boolean))];
  const lineProductCache = lineItemCodes.length > 0
    ? await batchResolveProducts(
      env,
      productsTableId,
      productFields.itemCodeFieldId,
      lineItemCodes,
    )
    : new Map();
  const order_lines = orderLineRows.map((candidate) =>
    toPortalOrderLine(candidate, lineProductCache, productFields, commissionRate));

  // Order-scoped economics: revenue/shipping counted once from the anchor;
  // commission on order revenue; TCOGS summed per-line by qty; profit/margin
  // derived at order level (replaces the single-line margin).
  const economics = computeOrderEconomics(row, orderLineRows, lineProductCache, productFields, commissionRate);
  order.margin = {
    revenue: economics.revenue,
    shipping: economics.shipping,
    commission: economics.commission,
    tcogs: economics.tcogs,
    profit: economics.profit,
    marginPercent: economics.marginPercent,
    hasTcogs: economics.hasTcogs,
    tcogsSource: economics.tcogsSource,
  };

  const priceMatchLines = order_lines.filter((line) => line.cogs_unit_price_equal);
  if (priceMatchLines.length > 0) {
    if (!order.risk_badges.some((badge) => badge.type === "cogs_unit_price_equal")) {
      order.risk_badges.push({ type: "cogs_unit_price_equal", label: "Effective COGS = Giga Unit Price", severity: "warning" });
    }
    order.cogs_price_match_lines = priceMatchLines.map((line) => ({
      id: line.id,
      platform_sku: line.platform_sku,
      source_unit_price: line.source_unit_price,
      effective_cogs: line.effective_cogs,
    }));
  } else {
    order.cogs_price_match_lines = [];
  }

  // Look up linked fee/main orders via customer identity.
  // Uses targeted field-equality queries (phone or name+postal) instead
  // of broad `search` to avoid missing rows for common names/phones.
  const customerKey = getCustomerKey(row);
  const isFee = isFeeRow(row.product_name);
  let linked_orders = [];

  if (customerKey) {
    try {
      const linkedFilters = {
        [`filter__field_${FIELD.SALES.SHOP_ID}__equal`]: text(row.shop_id),
      };
      if (customerKey.startsWith("phone:")) {
        const phone = String(row.shipping_phone_number || "").trim();
        if (phone) linkedFilters[`filter__field_${FIELD.SALES.SHIPPING_PHONE_NUMBER}__equal`] = phone;
      } else {
        const name = String(row.shipping_name || "").trim();
        const postal = String(row.shipping_postal_code || "").trim();
        if (name) linkedFilters[`filter__field_${FIELD.SALES.SHIPPING_NAME}__equal`] = name;
        if (postal) linkedFilters[`filter__field_${FIELD.SALES.SHIPPING_POSTAL_CODE}__equal`] = postal;
      }
      const linkedRows = await listRowsWithLimit(baserow, baserow.salesOrderTableId, linkedFilters, 50);
      // Filter to rows that share the same customer key and are the opposite type
      linked_orders = linkedRows
        .filter((r) => {
          if (r.id === row.id) return false; // exclude self
          const rKey = getCustomerKey(r);
          if (rKey !== customerKey) return false;
          // If this is a fee row, find main orders; if main, find fee rows
          const rIsFee = isFeeRow(r.product_name);
          return isFee ? !rIsFee : rIsFee;
        })
        .map((r) => ({
          id: r.id,
          order_id: text(r.order_id),
          product_name: text(r.product_name),
          order_status: readSelectValue(r.order_status),
          review_status: readSelectValue(r.review_status),
          pipeline_state: getPipelineState(readSelectValue(r.order_status), readSelectValue(r.review_status)),
          is_fee: isFeeRow(r.product_name),
        }))
        .slice(0, 10); // cap at 10 linked orders
    } catch (e) {
      // Non-critical — degrade gracefully
      console.warn("portal_linked_orders_failed:", e.message);
    }
  }

  const shipmentSyncStatus = await getShipmentSyncStatusForOrder(baserow, row);

  // Attach shipment sync status to the order object
  if (order && shipmentSyncStatus) {
    order.shipment_sync_status = shipmentSyncStatus;
  }

  // Enrich with unread status from KV (same as list enrichment)
  if (order) {
    const orderShopId = text(row.shop_id);
    const orderOrderId = text(row.order_id);
    if (orderShopId && orderOrderId) {
      try {
        const kvReadState = await readDurableState(env, orderShopId, orderOrderId);
        const unreadStatus = classifyUnreadStatus(row, kvReadState);
        order.has_unread = unreadStatus.has_unread;
        order.unread_classification = unreadStatus.classification;
      } catch (_) {
        order.has_unread = false;
        order.unread_classification = "unknown";
      }
    } else {
      order.has_unread = false;
      order.unread_classification = "unknown";
    }
  }

  return {
    ok: true,
    order,
    order_lines,
    ...(linked_orders.length > 0 ? { linked_orders } : {}),
  };
}

// ── POST /api/portal/orders/:id/lines ───────────────────────────────

export function buildManualOrderLinePayload(anchor, body = {}) {
  const b2bItemCode = text(body.b2b_item_code);
  const quantity = Number(body.quantity);
  if (!b2bItemCode) return { ok: false, error: "b2b_item_code_required", statusCode: 400 };
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: "invalid_quantity", statusCode: 400 };
  }

  const orderStatus = readSelectValue(anchor?.order_status);
  const reviewStatus = readSelectValue(anchor?.review_status);
  if (["COMPLETED", "CANCELED", "CANCELING"].includes(orderStatus)) {
    return { ok: false, error: "order_lines_locked_for_terminal_order", statusCode: 409 };
  }
  if (["Approved", "Auto-Approved", "APPROVED", "AUTO_APPROVED"].includes(reviewStatus)) {
    return { ok: false, error: "order_lines_locked_after_approval", statusCode: 409 };
  }

  const payload = {
    order_id: text(anchor.order_id),
    sales_channel: text(anchor.sales_channel),
    platform_account_id: anchor.platform_account_id || null,
    shop_id: text(anchor.shop_id),
    order_status: orderStatus,
    review_status: reviewStatus,
    line_origin: "operator_component",
    parent_line_id: anchor.id != null ? String(anchor.id) : null,
    product_name: `Manual order line: ${b2bItemCode}`,
    original_product_id: b2bItemCode,
    B2BItemCode: b2bItemCode,
    quantity,
    product_price: 0,
    shipping_price: 0,
    purchase_date: anchor.purchase_date || null,
    payment_date: anchor.payment_date || null,
    payment_method: anchor.payment_method || null,
    currency: anchor.currency || null,
    shipping_name: anchor.shipping_name || null,
    shipping_postal_code: anchor.shipping_postal_code || null,
    shipping_state: anchor.shipping_state || null,
    shipping_city: anchor.shipping_city || null,
    shipping_address_1: anchor.shipping_address_1 || null,
    shipping_address_2: anchor.shipping_address_2 || null,
    shipping_phone_number: anchor.shipping_phone_number || null,
    shipping_method: anchor.shipping_method || null,
    shipping_carrier: anchor.shipping_carrier || null,
    requested_delivery_date: anchor.requested_delivery_date || null,
    requested_delivery_time: anchor.requested_delivery_time || null,
    buyer_name: anchor.buyer_name || null,
  };
  return { ok: true, payload };
}

export async function handlePortalOrderLineCreate(env, orderId, body = {}) {
  const baserow = createBaserowClient(env);
  const anchor = await findSalesOrderByOrderId(baserow, orderId);
  if (!anchor) return { ok: false, error: "order_not_found", statusCode: 404 };

  const planned = buildManualOrderLinePayload(anchor, body);
  if (!planned.ok) return planned;

  const existing = (await findSalesOrderLinesByOrderId(baserow, orderId, text(anchor.shop_id)))
    .filter((candidate) => !isFeeRow(candidate.product_name));
  const requestedCode = text(planned.payload.B2BItemCode);
  const normalizedCode = requestedCode.toLowerCase();
  if (existing.some((candidate) => text(candidate.B2BItemCode).toLowerCase() === normalizedCode)) {
    return { ok: false, error: "duplicate_b2b_item_code", statusCode: 409 };
  }

  // Validate the B2B item code resolves via the product/Catalog read path.
  const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
  const productFields = await getProductFields(env, productsTableId);
  const productData = await findProductByItemCode(env, productsTableId, productFields.itemCodeFieldId, requestedCode);
  if (!productData) {
    return { ok: false, error: "b2b_item_code_not_found", statusCode: 422 };
  }
  if (productData.variantId != null) planned.payload.variant_id = productData.variantId;
  const canonicalCode = text(readProductField(productData, productFields.itemCodeFieldId)) || requestedCode;
  planned.payload.B2BItemCode = canonicalCode;
  planned.payload.original_product_id = canonicalCode;
  planned.payload.product_name = `Manual order line: ${canonicalCode}`;

  // Deterministic component index: one past the highest existing component.
  const existingComponents = existing.filter((candidate) => text(candidate.line_origin) === "operator_component");
  const nextIndex = existingComponents.reduce(
    (max, candidate) => Math.max(max, parseInteger(candidate.component_index, 0)),
    0,
  ) + 1;
  planned.payload.component_index = nextIndex;

  const created = await createRow(baserow, baserow.salesOrderTableId, planned.payload);
  if (!created.ok) {
    return { ok: false, error: `order_line_create_failed:${normalizeErrorMessage(created.error)}`, statusCode: created.status || 500 };
  }
  invalidatePortalListCache();
  return { ok: true, order_line: toPortalOrderLine(created.body), statusCode: 201 };
}

export async function handleTicketOrderContext(env, orderId, expected = {}) {
  const result = await handlePortalOrderDetail(env, orderId);
  if (!result.ok) return result;
  const order = result.order;
  const expectedPlatform = text(expected.platform).toLowerCase();
  const expectedAccountId = text(expected.accountId);
  if (expectedPlatform && text(order.sales_channel).toLowerCase() !== expectedPlatform) {
    return { ok: false, error: "order_scope_mismatch", statusCode: 404 };
  }
  if (expectedAccountId && text(order.platform_account_id) !== expectedAccountId) {
    return { ok: false, error: "order_scope_mismatch", statusCode: 404 };
  }
  return {
    ok: true,
    order: {
      order_id: order.order_id,
      sales_channel: order.sales_channel,
      order_status: order.order_status,
      review_status: order.review_status,
      pipeline_state: order.pipeline_state,
      purchase_date_jst: order.purchase_date_jst,
      buyer_name: order.buyer_name,
      shipping_name: order.shipping_name,
      shipping_postal_code: order.shipping_postal_code,
      shipping_state: order.shipping_state,
      shipping_city: order.shipping_city,
      shipping_address_1: order.shipping_address_1,
      shipping_address_2: order.shipping_address_2,
      shipping_method: order.shipping_method,
      shipping_carrier: order.shipping_carrier,
      tracking_number: order.tracking_number,
      payment_method: order.payment_method,
      rakuten_order_progress: order.rakuten_order_progress,
      rakuten_status_mapping_state: order.rakuten_status_mapping_state,
      rms_confirmed_at: order.rms_confirmed_at,
      lines: (result.order_lines || []).map((line) => ({
        product_name: line.product_name,
        platform_sku: line.platform_sku,
        b2b_item_code: line.B2BItemCode,
        quantity: line.quantity,
      })),
    },
  };
}

export async function getShipmentSyncStatusForOrder(baserow, salesRow) {
  try {
    const normalizedOrderId = normalizeOrderIdCandidate(salesRow && salesRow.order_id);
    const shopId = text(salesRow && salesRow.shop_id);
    if (!normalizedOrderId || !shopId) return null;

    const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId, {
      [`filter__field_${FIELD.SHIPMENT.ORDER_ID}__contains`]: normalizedOrderId,
      [`filter__field_${FIELD.SHIPMENT.SOURCE_STORE_ID}__equal`]: shopId,
    });
    const matchingShipments = shipmentRows.filter((sr) =>
      normalizeOrderIdCandidate(sr.OrderId) === normalizedOrderId &&
      text(sr.SourceStoreID) === shopId
    );
    if (!matchingShipments.length) return null;

    const statuses = matchingShipments.map((sr) => readSelectValue(sr.giga_sync_status)).filter(Boolean);
    if (statuses.some((s) => statusEquals(s, GIGA_SYNC_STATUS.SYNCED))) return "Synced";
    if (statuses.some((s) => statusEquals(s, GIGA_SYNC_STATUS.ALREADY_EXISTS))) return "Already Exists";
    if (statuses.some((s) => statusEquals(s, GIGA_SYNC_STATUS.ERROR))) return "Error";
    return statuses[0] || null;
  } catch (e) {
    // Non-critical — degrade gracefully
    console.warn("portal_shipment_sync_lookup_failed:", e.message);
    return null;
  }
}

// ── Shared order enrichment helper ─────────────────────────────────

/**
 * Enrich a raw Baserow sales row with margin, stock, risk badges, and
 * product lookup data. Used by detail endpoint and write endpoints that
 * need to return refreshed order state after a mutation.
 *
 * @param {Object} env
 * @param {Object} row - raw Baserow row (user_field_names=true)
 * @param {Object} productFields - from getProductFields()
 * @param {number} commissionRate - e.g. 0.10
 * @returns {Promise<Object>} enriched order object
 */
async function enrichOrderDetail(env, row, productFields, commissionRate) {
  const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
  const productName = text(row.product_name);
  const isFee = isFeeRow(productName);

  let itemCode = text(row.B2BItemCode);

  // Fallback: resolve Rakuten manage_number → B2BItemCode via mapping table
  if (!itemCode && platformSkuForRow(row) === text(row.manage_number) && text(row.manage_number)) {
    try {
      const baserow = createBaserowClient(env);
      const resolver = createRakutenItemCodeResolver({ supabase: baserow.supabase });
      const resolved = await resolver(text(row.manage_number), productName);
      if (resolved.resolved && resolved.code) itemCode = resolved.code;
    } catch (_) { /* non-fatal */ }
  }

  const productData = itemCode
    ? await findProductByItemCode(env, productsTableId, productFields.itemCodeFieldId, itemCode)
    : null;
  const ownerProductResult = itemCode
    ? await fetchPortalProductManualFields(env, itemCode)
    : { ok: false };
  const ownerProduct = ownerProductResult.ok ? ownerProductResult.product : null;

  const quantity = parseInteger(row.quantity, 0);
  const marginResult = computeMargin(row, productData, commissionRate, {
    effectiveTcogsFieldId: productFields.effectiveTcogsFieldId,
    effectiveCostPriceFieldId: productFields.effectiveCostPriceFieldId,
    sourceUnitPriceFieldId: productFields.sourceUnitPriceFieldId,
  });
  const ownedQty = productData
    ? readProductNumber(productData, productFields.ownedQtyFieldId)
    : null;
  const qtyAvailable = productData
    ? readProductNumber(productData, productFields.qtyAvailableFieldId)
    : null;
  const stockResult = computeStockStatus(ownedQty, qtyAvailable, quantity);
  const badges = assessRiskBadges(row, productData, marginResult, stockResult);
  if (isFee) {
    const priceMatchIndex = badges.findIndex((badge) => badge.type === "cogs_unit_price_equal");
    if (priceMatchIndex >= 0) badges.splice(priceMatchIndex, 1);
  }

  const orderStatus = readSelectValue(row.order_status);
  const reviewStatusRaw = readSelectValue(row.review_status);

  return {
    id: row.id,
    order_id: text(row.order_id),
    portal_target_id: buildPortalTargetId(row),
    product_name: productName,
    original_product_id: text(row.original_product_id),
    platform_sku: platformSkuForRow(row),
    B2BItemCode: itemCode,
    quantity,
    product_price: parseFloat(row.product_price) || 0,
    shipping_price: parseFloat(row.shipping_price) || 0,
    order_status: orderStatus,
    shop_id: text(row.shop_id),
    platform_account_id: text(row.platform_account_id),
    sales_channel: text(row.sales_channel).toLowerCase(),
    review_status: (statusEquals(orderStatus, ORDER_STATUS.WAITING_FOR_PAYMENT) && !statusEquals(reviewStatusRaw, REVIEW_STATUS.CANCELED))
      ? ORDER_STATUS.WAITING_FOR_PAYMENT
      : reviewStatusRaw,
    pipeline_state: getPipelineState(orderStatus, reviewStatusRaw),
    purchase_date: toJstIso(text(row.purchase_date)),
    purchase_date_jst: formatJstDateTime(text(row.purchase_date)),
    buyer_name: text(row.buyer_name),
    shipping_name: text(row.shipping_name),
    shipping_postal_code: text(row.shipping_postal_code),
    shipping_state: text(row.shipping_state),
    shipping_city: text(row.shipping_city),
    shipping_address_1: text(row.shipping_address_1),
    shipping_address_2: text(row.shipping_address_2),
    shipping_phone_number: text(row.shipping_phone_number),
    shipping_method: text(row.shipping_method),
    payment_method: text(row.payment_method),
    rakuten_order_progress: text(row.rakuten_order_progress) || null,
    rakuten_status_mapping_state: readSelectValue(row.rakuten_status_mapping_state) || null,
    rakuten_order_progress_observed_at: text(row.rakuten_order_progress_observed_at) || null,
    rms_confirm_result: text(row.rms_confirm_result) || null,
    rms_confirmed_at: text(row.rms_confirmed_at) || null,
    rakuten_shipment_ready: isRakutenShipmentReady(row),
    rakuten_blocking_reason: rakutenBlockingReason(row),
    shipping_carrier: text(row.shipping_carrier),
    tracking_number: text(row.tracking_number),
    requested_delivery_date: text(row.requested_delivery_date),
    requested_delivery_time: text(row.requested_delivery_time),
    order_comments: text(row.order_comments),
    review_memo_log: text(row.order_comments),
    is_fee_row: isFee,
    margin: marginResult,
    stock: stockResult,
    risk_badges: badges,
    commission_rate: commissionRate,
    product: productData
      ? {
          effective_tcogs: readProductNumber(productData, productFields.effectiveTcogsFieldId),
          effective_cogs: readProductNumber(productData, productFields.effectiveCostPriceFieldId),
          source_unit_price: readProductNumber(productData, productFields.sourceUnitPriceFieldId),
          owned_qty: ownedQty,
          qty_available: qtyAvailable,
          seller: readProductField(productData, productFields.sellerFieldId),
          manual_fields_available: Boolean(ownerProduct),
          manual_cost_price: ownerProduct?.manual_cost_price ?? null,
          manual_presale_arrival_date: ownerProduct?.manual_presale_arrival_date ?? null,
          presale_info_protect_until: ownerProduct?.presale_info_protect_until ?? null,
          restock_info: readProductField(productData, productFields.restockInfoFieldId),
        }
      : null,
  };
}

// ── GET /api/portal/summary ────────────────────────────────────────

export async function handlePortalSummary(env, searchParams = new URLSearchParams()) {
  const cachedKey = buildSummaryCacheKey(searchParams);
  const cached = getCachedSummaryByKey(cachedKey);
  if (cached) return cached;

  let lifecycle, shop, channel;
  try {
    ({ lifecycle, shop, channel } = validatePortalParams(searchParams));
  } catch (error) {
    return { ok: false, error: error.message, statusCode: 400 };
  }

  const baserow = createBaserowClient(env);
  const searchQuery = sharedText(searchParams.get("search") || "");
  const baseFilters = buildServerFilters({ lifecycle, review: REVIEW_FILTER.ANY, shop, channel });
  let rows = await listPortalSalesRows(baserow, baseFilters, searchQuery, 2000);
  rows = applyPortalOrderSearch(rows, searchQuery).filter((row) => !isFeeRow(row.product_name));
  if (lifecycle === LIFECYCLE.ACTIVE && channel === "mercari") {
    rows = rows.filter((row) => isActivePipelineState(getPipelineState(row.order_status, row.review_status)));
  }
  rows = groupSummaryOrderRows(rows);

  const byReview = {
    pending_review: 0,
    auto_approved: 0,
    approved: 0,
    on_hold: 0,
    canceled: 0,
    unset: 0,
  };
  for (const row of rows) {
    const reviewStatus = readSelectValue(row.review_status);
    if (statusEquals(reviewStatus, REVIEW_STATUS.PENDING_REVIEW)) byReview.pending_review += 1;
    else if (statusEquals(reviewStatus, REVIEW_STATUS.AUTO_APPROVED)) byReview.auto_approved += 1;
    else if (statusEquals(reviewStatus, REVIEW_STATUS.APPROVED)) byReview.approved += 1;
    else if (statusEquals(reviewStatus, REVIEW_STATUS.ON_HOLD)) byReview.on_hold += 1;
    else if (statusEquals(reviewStatus, REVIEW_STATUS.CANCELED)) byReview.canceled += 1;
    else byReview.unset += 1;
  }

  const result = {
    ok: true,
    scope: {
      channel,
      shop: shop || "",
      lifecycle,
      search: searchQuery,
    },
    total: rows.length,
    by_review: byReview,
    degraded: false,
  };

  // For Rakuten, also return order_status breakdown
  if (channel === "rakuten") {
    const byStatus = {
      pending_confirmation: 0,
      confirmed: 0,
      rms_confirmed: 0,
      canceled: 0,
    };
    for (const row of rows) {
      const s = readSelectValue(row.order_status);
      if (statusEquals(s, OPTION.RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION)) byStatus.pending_confirmation += 1;
      else if (statusEquals(s, OPTION.RAKUTEN_ORDER_STATUS.CONFIRMED)) byStatus.confirmed += 1;
      else if (statusEquals(s, OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED)) byStatus.rms_confirmed += 1;
      else if (statusEquals(s, OPTION.RAKUTEN_ORDER_STATUS.CANCELED)) byStatus.canceled += 1;
    }
    result.by_status = byStatus;
  }

  setCachedSummaryByKey(cachedKey, result, false);
  return result;
}

function groupSummaryOrderRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = [text(row.sales_channel).toLowerCase(), text(row.source_store_id || row.shop_id).toLowerCase(), text(row.order_id).normalize("NFKC").trim().toLowerCase()].join("\u0000");
    if (!groups.has(key) || text(groups.get(key).line_origin) === "operator_component") groups.set(key, row);
  }
  return [...groups.values()];
}

// Scoped summary cache keyed by scope params
const _summaryCacheByKey = new Map();
const SUMMARY_CACHE_TTL_MS = 30 * 1000;
const SUMMARY_DEGRADED_CACHE_TTL_MS = 5 * 1000;

function buildSummaryCacheKey(searchParams) {
  const parts = [];
  for (const key of ["shop", "lifecycle", "search", "channel"]) {
    const val = searchParams.get(key) || "";
    parts.push(`${key}=${val}`);
  }
  return parts.join("&");
}

function getCachedSummaryByKey(key) {
  const cached = _summaryCacheByKey.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    _summaryCacheByKey.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedSummaryByKey(key, value, degraded) {
  const ttl = degraded ? SUMMARY_DEGRADED_CACHE_TTL_MS : SUMMARY_CACHE_TTL_MS;
  _summaryCacheByKey.set(key, { value, expiresAt: Date.now() + ttl });
}

function invalidateSummaryCache() {
  _summaryCacheByKey.clear();
}

// ── Review-mutation helpers ─────────────────────────────────────────

/** Resolve the order-scoped identity keys used by set_order_review_status. */
function resolveReviewMutationKeys(row) {
  return {
    salesChannel: sharedText(row.sales_channel).toLowerCase(),
    sourceStoreId: text(row.source_store_id || row.shop_id),
    normalizedOrderId: normalizeOrderIdCandidate(row.order_id),
  };
}

/** Map a legacy display review status to its canonical Supabase value. */
function canonicalReviewTarget(legacyStatus) {
  if (statusEquals(legacyStatus, REVIEW_STATUS.APPROVED)) return OPTION.REVIEW_STATUS.APPROVED;
  if (statusEquals(legacyStatus, REVIEW_STATUS.ON_HOLD)) return OPTION.REVIEW_STATUS.ON_HOLD;
  if (statusEquals(legacyStatus, REVIEW_STATUS.AUTO_APPROVED)) return OPTION.REVIEW_STATUS.AUTO_APPROVED;
  if (statusEquals(legacyStatus, REVIEW_STATUS.CANCELED)) return OPTION.REVIEW_STATUS.CANCELED;
  return OPTION.REVIEW_STATUS[legacyStatus] || legacyStatus;
}

/** Convert a setOrderReviewStatusViaRpc failure into an HTTP response. */
function reviewRpcErrorResponse(result) {
  if (result.error === "cancellation_reason_required" || result.error === "cancellation_reason_too_long") {
    return { ok: false, error: result.error, statusCode: 400, reason: result.reason };
  }
  if (result.error === "already_canceled") {
    return { ok: false, error: "already_canceled", statusCode: 409, reason: "terminal_review_canceled" };
  }
  if (result.error === "terminal_lifecycle") {
    return { ok: false, error: "terminal_lifecycle", statusCode: 409, reason: "terminal_lifecycle" };
  }
  if (result.error === "already_synced_to_giga") {
    return { ok: false, error: "already_synced_to_giga", statusCode: 409, reason: "already_synced_to_giga" };
  }
  return { ok: false, error: result.error, statusCode: 502 };
}

// ── PATCH /api/portal/orders/:id/review ─────────────────────────────

export async function handlePortalReview(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const status = text(body.status || "");

  if (!status || !(
    statusEquals(status, REVIEW_STATUS.APPROVED) || statusEquals(status, REVIEW_STATUS.ON_HOLD))
  ) {
    return { ok: false, error: "invalid_status", statusCode: 400, valid_values: [REVIEW_STATUS.APPROVED, REVIEW_STATUS.ON_HOLD] };
  }

  const row = await findSalesOrderByOrderId(baserow, orderId);

  if (!row) {
    return { ok: false, error: "order_not_found", statusCode: 404 };
  }

  const orderLines = (await findSalesOrderLinesByOrderId(baserow, orderId, text(row.shop_id)))
    .filter((candidate) => !isFeeRow(candidate.product_name));
  if (statusEquals(status, REVIEW_STATUS.APPROVED)) {
    const missingRowIds = findMissingB2bRowIds(orderLines);
    if (missingRowIds.length) {
      return {
        ok: false,
        error: "b2b_item_code_required_for_all_order_lines",
        statusCode: 409,
        missing_row_ids: missingRowIds,
      };
    }
  }

  // Use shared policy helper to validate the review mutation
  const currentOrderStatus = readSelectValue(row.order_status);
  const currentReviewStatus = readSelectValue(row.review_status);
  if (
    sharedText(row.sales_channel).toLowerCase() === "rakuten" &&
    statusEquals(status, REVIEW_STATUS.APPROVED) &&
    !isRakutenShipmentReady(row)
  ) {
    return {
      ok: false,
      error: "rakuten_not_shipment_ready",
      statusCode: 409,
      reason: rakutenBlockingReason(row),
    };
  }
  if (isApprovalBlockedByPaymentStatus(currentOrderStatus, status)) {
    return {
      ok: false,
      error: "payment_required_before_approval",
      statusCode: 409,
      reason: "payment_required_before_approval",
    };
  }
  const transitionCheck = isValidReviewMutation(currentOrderStatus, currentReviewStatus, status);

  if (!transitionCheck.valid) {
    return { ok: false, error: transitionCheck.reason, statusCode: 409, reason: transitionCheck.reason };
  }

  if (baserow.type === "supabase") {
    // Authoritative write: route through the transactional RPC so the review
    // mutation shares the order-scoped mutex with Cancel and updates all lines.
    const keys = resolveReviewMutationKeys(row);
    const rpcResult = await setOrderReviewStatusViaRpc(baserow, {
      p_sales_channel: keys.salesChannel,
      p_source_store_id: keys.sourceStoreId,
      p_order_id: keys.normalizedOrderId,
      p_target: canonicalReviewTarget(status),
      p_audit: "",
    });
    if (!rpcResult.ok) {
      return reviewRpcErrorResponse(rpcResult);
    }
  } else {
    const patchResult = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
      review_status: status,
    }, {
      // Prevent a paid/order lifecycle transition racing between validation and
      // the write on the Supabase backend.
      match: {
        order_status: currentOrderStatus,
        review_status: currentReviewStatus,
      },
    });

    if (!patchResult.ok) {
      return { ok: false, error: `patch_failed:${patchResult.error}`, statusCode: patchResult.status };
    }
  }

  // Invalidate summary and list caches after review status change
  invalidateSummaryCache();
  invalidatePortalListCache();

  return {
    ok: true,
    order_id: text(row.order_id),
    row_id: row.id,
    review_status: status,
    previous_status: currentReviewStatus,
  };
}

// ── POST /api/portal/orders/:id/cancel ─────────────────────────────

/**
 * Fail-closed "already pushed to Giga" check for the Cancel guard.
 *
 * Queries giga_shipment_projections directly for any SYNCED / ALREADY_EXISTS
 * row matching the order. On any query error we return true (reject Cancel) —
 * never treat a lookup failure as "not synced".
 */
async function isOrderAlreadySyncedToGiga(baserow, salesChannel, sourceStoreId, normalizedOrderId) {
  try {
    const { data, error } = await baserow.supabase
      .from(baserow.shipmentOrderTableId)
      .select("giga_sync_status")
      .eq("sales_channel", salesChannel)
      .eq("source_store_id", sourceStoreId)
      .eq("order_id", normalizedOrderId);
    if (error) return true;
    const rows = Array.isArray(data) ? data : [];
    return rows.some((r) => {
      const s = String(r.giga_sync_status || "").trim().toUpperCase();
      return s === "SYNCED" || s === "ALREADY_EXISTS";
    });
  } catch {
    return true;
  }
}

export async function handlePortalCancel(env, orderId, body = {}) {
  const cancellationReason = text(body?.cancellation_reason || "");

  if (!cancellationReason) {
    return { ok: false, error: "cancellation_reason_required", statusCode: 400 };
  }
  if (cancellationReason.length > 2000) {
    return { ok: false, error: "cancellation_reason_too_long", max_length: 2000, statusCode: 400 };
  }

  const baserow = createBaserowClient(env);

  // The Cancel action is backed by the Supabase transactional RPC; the
  // Baserow backend has no equivalent, so refuse rather than fall back to a
  // non-atomic multi-row patch.
  if (baserow.type !== "supabase") {
    return { ok: false, error: "cancel_requires_supabase_backend", statusCode: 501 };
  }

  const row = await findSalesOrderByOrderId(baserow, orderId);

  if (!row) {
    return { ok: false, error: "order_not_found", statusCode: 404 };
  }

  const currentOrderStatus = readSelectValue(row.order_status);
  const currentReviewStatus = readSelectValue(row.review_status);
  const salesChannel = sharedText(row.sales_channel).toLowerCase();
  const sourceStoreId = text(row.source_store_id || row.shop_id);
  const normalizedOrderId = normalizeOrderIdCandidate(row.order_id);

  // This issue targets Mercari sales orders only.
  if (salesChannel !== "mercari") {
    return { ok: false, error: "only_mercari_orders_can_be_cancelled", statusCode: 400 };
  }

  // Terminal lifecycle — nothing to cancel.
  if (
    statusEquals(currentOrderStatus, ORDER_STATUS.COMPLETED)
    || statusEquals(currentOrderStatus, ORDER_STATUS.CANCELED)
    || statusEquals(currentOrderStatus, "CANCELING")
  ) {
    return { ok: false, error: "terminal_lifecycle", statusCode: 409, reason: "terminal_lifecycle" };
  }

  // Idempotent — already cancelled locally.
  if (statusEquals(currentReviewStatus, REVIEW_STATUS.CANCELED)) {
    return { ok: false, error: "already_canceled", statusCode: 409, reason: "already_canceled" };
  }

  // Already pushed to Giga — refuse local Cancel (decision 4).
  const synced = await isOrderAlreadySyncedToGiga(baserow, salesChannel, sourceStoreId, normalizedOrderId);
  if (synced) {
    return { ok: false, error: "already_synced_to_giga", statusCode: 409, reason: "already_synced_to_giga" };
  }

  const audit = `[${toJstIso(new Date())}] PORTAL_OPERATOR: marked order cancelled — reason: ${cancellationReason}`;

  // Authoritative write: transactional RPC marks ALL non-fee lines CANCELED
  // atomically, with an order-scoped advisory lock so Cancel wins any race.
  const rpcResult = await setOrderReviewStatusViaRpc(baserow, {
    p_sales_channel: salesChannel,
    p_source_store_id: sourceStoreId,
    p_order_id: normalizedOrderId,
    p_target: OPTION.REVIEW_STATUS.CANCELED,
    p_audit: audit,
    p_cancellation_reason: cancellationReason,
  });

  if (!rpcResult.ok) {
    return reviewRpcErrorResponse(rpcResult);
  }

  // Invalidate summary and list caches after the review-status change.
  invalidateSummaryCache();
  invalidatePortalListCache();

  return {
    ok: true,
    order_id: text(row.order_id),
    review_status: REVIEW_STATUS.CANCELED,
    previous_status: currentReviewStatus,
    updated_lines: rpcResult.updated,
    cancellation_reason: cancellationReason,
  };
}

// ── POST /api/portal/orders/:id/confirm ───────────────────────────

export async function handlePortalConfirm(env, orderId) {
  const baserow = createBaserowClient(env);

  const row = await findSalesOrderByOrderId(baserow, orderId);

  if (!row) {
    return { ok: false, error: "order_not_found", statusCode: 404 };
  }

  const currentOrderStatus = readSelectValue(row.order_status);

  // Validate the latest authoritative RMS mapping before requesting confirm.
  const confirmationPlan = planRakutenConfirmation(row);
  if (!confirmationPlan.ok) {
    return {
      ok: false,
      error: confirmationPlan.error,
      reason: confirmationPlan.reason,
      current_status: currentOrderStatus,
      statusCode: confirmationPlan.error === "only_rakuten_orders_can_be_confirmed" ? 400 : 409,
    };
  }

  // Append audit timestamp to order_comments
  const now = toJstIso(new Date());
  const nextStatus = confirmationPlan.nextStatus;
  const auditEntry = `[${now}] PORTAL_OPERATOR: requested RMS confirmation (${currentOrderStatus} → ${nextStatus})`;
  const existingLog = sharedText(row.order_comments);
  const updatedLog = existingLog ? `${auditEntry}\n\n${existingLog}` : auditEntry;

  const patchResult = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
    order_status: nextStatus,
    rms_confirm_result: "requested",
    order_comments: updatedLog,
  });

  if (!patchResult.ok) {
    return { ok: false, error: `patch_failed:${patchResult.error}`, statusCode: patchResult.status };
  }

  invalidateSummaryCache();
  invalidatePortalListCache();

  // Enrich the refreshed order for the response
  let order = null;
  try {
    const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
    const commissionRate = parseFloat(String(env.PORTAL_COMMISSION_RATE_MERCARI || "0.10"));
    const productFields = await getPortalProductFields(env, productsTableId);
    const refreshedRow = { ...row, order_status: nextStatus, rms_confirm_result: "requested", order_comments: updatedLog };
    order = await enrichOrderDetail(env, refreshedRow, productFields, commissionRate);
    const shipmentSyncStatus = await getShipmentSyncStatusForOrder(baserow, refreshedRow);
    if (shipmentSyncStatus) order.shipment_sync_status = shipmentSyncStatus;
  } catch (_) { /* enrichment failed — non-fatal */ }

  return {
    ok: true,
    order_id: text(row.order_id),
    row_id: row.id,
    previous_status: currentOrderStatus,
    order_status: nextStatus,
    order,
  };
}

// ── PATCH /api/portal/orders/:id/memo ────────────────────────────────

export async function handlePortalMemo(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const memoText = text(body.text || "");

  if (!memoText) {
    return { ok: false, error: "memo_text_required", statusCode: 400 };
  }

  const row = await findSalesOrderByOrderId(baserow, orderId);

  if (!row) {
    return { ok: false, error: "order_not_found", statusCode: 404 };
  }

  const existingLog = text(row.order_comments);
  const now = new Date().toISOString();
  const operatorName = "operator";
  const newEntry = `[${now}] ${operatorName}: ${memoText}`;
  const updatedLog = existingLog ? `${newEntry}\n\n${existingLog}` : newEntry;

  const patchResult = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
    order_comments: updatedLog,
  });

  if (!patchResult.ok) {
    return { ok: false, error: `patch_failed:${patchResult.error}`, statusCode: patchResult.status };
  }

  return {
    ok: true,
    order_id: text(row.order_id),
    row_id: row.id,
    order_comments: updatedLog,
  };
}

// ── POST /api/portal/orders/bulk-approve ─────────────────────────────

export async function handlePortalBulkApprove(env, body) {
  const baserow = createBaserowClient(env);

  const targetResolution = resolveBulkOrderTargets(body);
  if (!targetResolution.ok) {
    return { ok: false, error: "invalid_order_scope", message: "order_targets must contain scoped Portal target IDs", statusCode: 400 };
  }
  const orderIds = targetResolution.targets;
  const rowIds = Array.isArray(body.row_ids) ? body.row_ids.filter((id) => Number.isFinite(Number(id))).map(Number) : [];

  if (!orderIds.length && !rowIds.length) {
    return { ok: false, error: "no_orders_specified", message: "Provide order_targets, order_ids or row_ids" };
  }

  // A raw row ID does not carry the lifecycle/payment facts required by the
  // approval policy. The Portal uses order_ids; reject the legacy shortcut so
  // callers cannot bypass payment validation.
  if (rowIds.length) {
    return {
      ok: false,
      error: "order_ids_required_for_safe_approval",
      message: "Use order_ids so payment and lifecycle status can be validated",
      statusCode: 400,
    };
  }

  let targetRowIds = rowIds.slice();
  const resolvedRowsById = new Map();
  const missingB2bByRowId = new Map();
  const approvalLineIssueByRowId = new Map();

  if (orderIds.length) {
    for (const id of orderIds) {
      const match = await findSalesOrderByOrderId(baserow, id);
      if (match && !targetRowIds.includes(match.id)) {
        targetRowIds.push(match.id);
      }
      if (match) resolvedRowsById.set(match.id, match);
      if (match) {
        const lines = (await findSalesOrderLinesByOrderId(baserow, id, text(match.shop_id)))
          .filter((candidate) => !isFeeRow(candidate.product_name));
        const missingRowIds = findMissingB2bRowIds(lines);
        if (missingRowIds.length) missingB2bByRowId.set(match.id, missingRowIds);
        if (!missingRowIds.length && lines.some((line) => text(line.line_origin) === "operator_component")) {
          const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
          const productFields = await getProductFields(env, productsTableId);
          const codes = [...new Set(lines.map((line) => text(line.B2BItemCode)))];
          const products = await batchResolveProducts(env, productsTableId, productFields.itemCodeFieldId, codes);
          const allocation = allocateLineCommercialValues(match.product_price, lines.map((line) => ({
            qty: parseInteger(line.quantity, 0),
            tcogs: (() => {
              const product = products.get(text(line.B2BItemCode));
              return product ? readProductNumber(product, productFields.effectiveTcogsFieldId) : null;
            })(),
          })));
          if (!allocation.ok) approvalLineIssueByRowId.set(match.id, allocation.reason);
        }
      }
    }
  }

  targetRowIds = [...new Set(targetRowIds)];

  if (!targetRowIds.length) {
    return { ok: false, error: "no_orders_found" };
  }

  // Cap at 50 to prevent Worker timeout
  const MAX_BULK = 50;
  if (targetRowIds.length > MAX_BULK) {
    targetRowIds = targetRowIds.slice(0, MAX_BULK);
  }

  const skipped = [];
  const effectiveRowIds = targetRowIds.filter((rowId) => {
    const row = resolvedRowsById.get(rowId);
    if (row) {
      const missingRowIds = missingB2bByRowId.get(rowId);
      if (missingRowIds?.length) {
        skipped.push({ row_id: rowId, reason: "b2b_item_code_required_for_all_order_lines", missing_row_ids: missingRowIds });
        return false;
      }
      const allocationIssue = approvalLineIssueByRowId.get(rowId);
      if (allocationIssue) {
        skipped.push({ row_id: rowId, reason: allocationIssue });
        return false;
      }
      const orderStatus = readSelectValue(row.order_status);
      const reviewStatus = readSelectValue(row.review_status);
      if (isApprovalBlockedByPaymentStatus(orderStatus, REVIEW_STATUS.APPROVED)) {
        skipped.push({ row_id: rowId, reason: "payment_required_before_approval" });
        return false;
      }
      const transitionCheck = isValidReviewMutation(orderStatus, reviewStatus, REVIEW_STATUS.APPROVED);
      if (!transitionCheck.valid) {
        skipped.push({ row_id: rowId, reason: transitionCheck.reason });
        return false;
      }
    }
    return true;
  });

  if (!effectiveRowIds.length) {
    return { ok: true, total: targetRowIds.length, approved: 0, skipped: skipped.length, failed: 0, skipped_details: skipped };
  }

  // Process in parallel batches of 10
  const BATCH_SIZE = 10;
  const results = [];

  const writeApprove = async (rowId) => {
    const row = resolvedRowsById.get(rowId);
    try {
      if (baserow.type === "supabase" && row) {
        // Route through the transactional RPC so the approve shares the
        // order-scoped mutex with Cancel and updates all non-fee lines.
        const keys = resolveReviewMutationKeys(row);
        const rpcResult = await setOrderReviewStatusViaRpc(baserow, {
          p_sales_channel: keys.salesChannel,
          p_source_store_id: keys.sourceStoreId,
          p_order_id: keys.normalizedOrderId,
          p_target: OPTION.REVIEW_STATUS.APPROVED,
          p_audit: "",
        });
        return { row_id: rowId, ok: rpcResult.ok, error: rpcResult.ok ? null : rpcResult.error };
      }
      const patchResult = await patchRow(baserow, baserow.salesOrderTableId, rowId, {
        review_status: REVIEW_STATUS.APPROVED,
      }, {
        match: row ? {
          order_status: readSelectValue(row.order_status),
          review_status: readSelectValue(row.review_status),
        } : {},
      });
      return { row_id: rowId, ok: patchResult.ok, error: patchResult.ok ? null : patchResult.error };
    } catch (error) {
      return { row_id: rowId, ok: false, error: normalizeErrorMessage(error) };
    }
  };

  for (let i = 0; i < effectiveRowIds.length; i += BATCH_SIZE) {
    const batch = effectiveRowIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(writeApprove));
    results.push(...batchResults);
  }

  const okCount = results.filter((r) => r.ok).length;

  // Invalidate summary cache after bulk review status changes
  if (okCount > 0) {
    invalidateSummaryCache();
    invalidatePortalListCache();
  }

  return {
    ok: okCount > 0 || skipped.length > 0,
    total: results.length + skipped.length,
    approved: okCount,
    skipped: skipped.length,
    failed: results.length - okCount,
    results,
    ...(skipped.length ? { skipped_details: skipped } : {}),
  };
}

// ── PATCH /api/portal/orders/:id/b2b-code ────────────────────────────

export async function handlePortalB2bCode(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const newCode = text(body.b2b_item_code || "");

  if (!newCode) {
    return { ok: false, error: "b2b_item_code_required", statusCode: 400 };
  }

  const anchor = await findSalesOrderByOrderId(baserow, orderId);

  if (!anchor) {
    return { ok: false, error: "order_not_found", statusCode: 404 };
  }

  const rows = (await findSalesOrderLinesByOrderId(baserow, orderId, text(anchor.shop_id)))
    .filter((candidate) => !isFeeRow(candidate.product_name));
  const selection = selectOrderLineTarget(rows, body.row_id);
  if (!selection.ok) return selection;
  const row = selection.row;

  const patchResult = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
    B2BItemCode: newCode,
  });

  if (!patchResult.ok) {
    return { ok: false, error: `patch_failed:${patchResult.error}`, statusCode: patchResult.status };
  }

  invalidatePortalListCache();

  // Enrich with fresh margin/stock/risk after B2B code change
  var order = null;
  var prevCode = text(row.B2BItemCode);
  try {
    const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
    const productFields = await getProductFields(env, productsTableId);
    const commissionRate = parseFloat(String(env.PORTAL_COMMISSION_RATE_MERCARI || "0.10"));
    row.B2BItemCode = newCode; // reflect the patch in the row for enrichment
    order = await enrichOrderDetail(env, row, productFields, commissionRate);
  } catch (_) { /* enrichment failed — non-fatal, client will fall back to re-fetch */ }

  // Audit log
  if (prevCode && prevCode !== newCode) {
    const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: B2BItemCode changed from ${prevCode} to ${newCode}`;
    await appendAuditLog(baserow, row.id, row.order_comments, auditEntry);
  }

  return {
    ok: true,
    order_id: text(row.order_id),
    row_id: row.id,
    B2BItemCode: newCode,
    order: order,
  };
}

// ── PATCH /api/portal/orders/:id/delivery-date ────────────────────────

/** GigaB2B time slots for requested delivery (JP Marketplace only). */
const GIGA_DELIVERY_TIME_SLOTS = [
  "08:00-12:00", "14:00-16:00", "16:00-18:00", "18:00-20:00", "19:00-21:00"
];

export async function handlePortalDeliveryPreferences(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const newDate = text(body.requested_delivery_date || "");
  const newTime = text(body.requested_delivery_time || "");

  if (Boolean(newDate) !== Boolean(newTime)) {
    return { ok: false, error: "delivery_date_and_time_required_together", statusCode: 400 };
  }
  if (newDate && !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return { ok: false, error: "invalid_date_format", expected: "YYYY-MM-DD", statusCode: 400 };
  }
  if (newDate) {
    const [y, m, d] = newDate.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
      return { ok: false, error: "invalid_calendar_date", requested_date: newDate, statusCode: 400 };
    }
  }
  if (newTime && !GIGA_DELIVERY_TIME_SLOTS.includes(newTime)) {
    return { ok: false, error: "invalid_time_slot", valid_slots: GIGA_DELIVERY_TIME_SLOTS, statusCode: 400 };
  }

  const earliestDate = getJstEarliestDeliveryDate();
  const override = Boolean(body.override);
  if (newDate && newDate < earliestDate && !override) {
    return { ok: false, error: "delivery_date_too_early", earliest_date: earliestDate, requested_date: newDate, hint: "pass override:true to bypass", statusCode: 400 };
  }

  const anchor = await findSalesOrderByOrderId(baserow, orderId);
  if (!anchor) return { ok: false, error: "order_not_found", statusCode: 404 };

  const normalizedId = normalizeOrderIdCandidate(anchor.order_id);
  const shopId = text(anchor.shop_id);
  const allRows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${FIELD.SALES.ORDER_ID}__contains`]: normalizedId,
  });
  const targetRows = allRows.filter((r) =>
    normalizeOrderIdCandidate(r.order_id) === normalizedId &&
    text(r.shop_id) === shopId &&
    !isFeeRow(r.product_name)
  );
  if (!targetRows.length) return { ok: false, error: "no_rows_found", statusCode: 404 };

  let patched = 0;
  let failed = 0;
  const results = [];
  for (const row of targetRows) {
    try {
      const pr = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
        requested_delivery_date: newDate,
        requested_delivery_time: newTime,
      });
      if (pr.ok) {
        patched++;
        results.push({ row_id: row.id, ok: true });
      } else {
        failed++;
        results.push({ row_id: row.id, ok: false, error: pr.error });
      }
    } catch (error) {
      failed++;
      results.push({ row_id: row.id, ok: false, error: normalizeErrorMessage(error) });
    }
  }

  invalidatePortalListCache();
  const prevDate = text(anchor.requested_delivery_date);
  const prevTime = text(anchor.requested_delivery_time);
  if (prevDate !== newDate || prevTime !== newTime) {
    const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: delivery preferences changed from ${prevDate || "(none)"} / ${prevTime || "(none)"} to ${newDate || "(none)"} / ${newTime || "(none)"}`;
    await appendAuditLog(baserow, anchor.id, anchor.order_comments, auditEntry);
  }

  return {
    ok: failed === 0,
    partial: failed > 0 ? true : undefined,
    order_id: normalizedId,
    rows_patched: patched,
    rows_failed: failed,
    rows_total: targetRows.length,
    requested_delivery_date: newDate,
    requested_delivery_time: newTime,
    delivery_preferences_complete: Boolean(newDate && newTime),
    ...(failed > 0 ? { results } : {}),
  };
}

export async function handlePortalDeliveryDate(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const newDate = text(body.requested_delivery_date || "");

  if (newDate && !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return { ok: false, error: "invalid_date_format", expected: "YYYY-MM-DD", statusCode: 400 };
  }

  // Validate that the date is a real calendar date (not 2026-99-99)
  if (newDate) {
    const [y, m, d] = newDate.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
      return { ok: false, error: "invalid_calendar_date", requested_date: newDate, statusCode: 400 };
    }
  }

  const earliestDate = getJstEarliestDeliveryDate();
  const override = Boolean(body.override);
  if (newDate && newDate < earliestDate && !override) {
    return { ok: false, error: "delivery_date_too_early", earliest_date: earliestDate, requested_date: newDate, hint: "pass override:true to bypass", statusCode: 400 };
  }

  const anchor = await findSalesOrderByOrderId(baserow, orderId);
  if (!anchor) return { ok: false, error: "order_not_found", statusCode: 404 };

  const normalizedId = normalizeOrderIdCandidate(anchor.order_id);
  const shopId = text(anchor.shop_id);

  const allRows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${FIELD.SALES.ORDER_ID}__contains`]: normalizedId,
  });
  const targetRows = allRows.filter((r) =>
    normalizeOrderIdCandidate(r.order_id) === normalizedId &&
    text(r.shop_id) === shopId &&
    !isFeeRow(r.product_name)
  );

  if (!targetRows.length) return { ok: false, error: "no_rows_found", statusCode: 404 };

  // Patch all rows, collect per-row results
  let patched = 0;
  let failed = 0;
  const results = [];
  for (const row of targetRows) {
    try {
      const pr = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
        requested_delivery_date: newDate,
      });
      if (pr.ok) {
        patched++;
        results.push({ row_id: row.id, ok: true });
      } else {
        failed++;
        results.push({ row_id: row.id, ok: false, error: pr.error });
      }
    } catch (e) {
      failed++;
      results.push({ row_id: row.id, ok: false, error: normalizeErrorMessage(e) });
    }
  }

  if (override && newDate && newDate < earliestDate) {
    const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: requested_delivery_date override set to ${newDate} (earliest was ${earliestDate})`;
    await appendAuditLog(baserow, anchor.id, anchor.order_comments, auditEntry);
  } else if (newDate) {
    const prevDate = text(anchor.requested_delivery_date);
    if (prevDate !== newDate) {
      const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: requested_delivery_date set to ${newDate} (previous: ${prevDate || "(none)"})`;
      await appendAuditLog(baserow, anchor.id, anchor.order_comments, auditEntry);
    }
  }

  // Compute delivery_preferences_complete from NEW values (not pre-patch stale data)
  const dateNow = text(newDate);
  const timeNow = text(anchor.requested_delivery_time);
  const deliveryComplete = !!(dateNow && timeNow);

  return {
    ok: failed === 0,
    partial: failed > 0 ? true : undefined,
    order_id: normalizedId,
    rows_patched: patched,
    rows_failed: failed,
    rows_total: targetRows.length,
    requested_delivery_date: newDate,
    delivery_preferences_complete: deliveryComplete,
    ...(failed > 0 ? { results } : {}),
  };
}

// ── PATCH /api/portal/orders/:id/delivery-time ────────────────────────

export async function handlePortalDeliveryTime(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const newTime = text(body.requested_delivery_time || "");

  if (newTime && !GIGA_DELIVERY_TIME_SLOTS.includes(newTime)) {
    return { ok: false, error: "invalid_time_slot", valid_slots: GIGA_DELIVERY_TIME_SLOTS, statusCode: 400 };
  }

  const anchor = await findSalesOrderByOrderId(baserow, orderId);
  if (!anchor) return { ok: false, error: "order_not_found", statusCode: 404 };

  const normalizedId = normalizeOrderIdCandidate(anchor.order_id);
  const shopId = text(anchor.shop_id);

  const allRows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${FIELD.SALES.ORDER_ID}__contains`]: normalizedId,
  });
  const targetRows = allRows.filter((r) =>
    normalizeOrderIdCandidate(r.order_id) === normalizedId &&
    text(r.shop_id) === shopId &&
    !isFeeRow(r.product_name)
  );

  if (!targetRows.length) return { ok: false, error: "no_rows_found", statusCode: 404 };

  // Patch all rows, collect per-row results
  let patched = 0;
  let failed = 0;
  const results = [];
  for (const row of targetRows) {
    try {
      const pr = await patchRow(baserow, baserow.salesOrderTableId, row.id, {
        requested_delivery_time: newTime,
      });
      if (pr.ok) {
        patched++;
        results.push({ row_id: row.id, ok: true });
      } else {
        failed++;
        results.push({ row_id: row.id, ok: false, error: pr.error });
      }
    } catch (e) {
      failed++;
      results.push({ row_id: row.id, ok: false, error: normalizeErrorMessage(e) });
    }
  }

  if (newTime) {
    const prevTime = text(anchor.requested_delivery_time);
    if (prevTime !== newTime) {
      const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: requested_delivery_time set to ${newTime} (previous: ${prevTime || "(none)"})`;
      await appendAuditLog(baserow, anchor.id, anchor.order_comments, auditEntry);
    }
  } else {
    const prevTime = text(anchor.requested_delivery_time);
    if (prevTime) {
      const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: requested_delivery_time cleared (was ${prevTime})`;
      await appendAuditLog(baserow, anchor.id, anchor.order_comments, auditEntry);
    }
  }

  // Compute delivery_preferences_complete from NEW values (not pre-patch stale data)
  const dateNow = text(anchor.requested_delivery_date);
  const timeNow = text(newTime);
  const deliveryComplete = !!(dateNow && timeNow);

  return {
    ok: failed === 0,
    partial: failed > 0 ? true : undefined,
    order_id: normalizedId,
    rows_patched: patched,
    rows_failed: failed,
    rows_total: targetRows.length,
    requested_delivery_time: newTime,
    delivery_preferences_complete: deliveryComplete,
    ...(failed > 0 ? { results } : {}),
  };
}

// ── PATCH /api/portal/orders/:id/address ────────────────────────────

const SHIPPING_ADDRESS_FIELDS = [
  "shipping_name",
  "shipping_postal_code",
  "shipping_state",
  "shipping_city",
  "shipping_address_1",
  "shipping_address_2",
  "shipping_phone_number",
];

export async function handlePortalAddress(env, orderId, body) {
  const baserow = createBaserowClient(env);

  const patchFields = {};
  for (const key of SHIPPING_ADDRESS_FIELDS) {
    if (key in body) patchFields[key] = text(body[key]);
  }

  if (!Object.keys(patchFields).length) {
    return { ok: false, error: "no_address_fields_to_update", valid_fields: SHIPPING_ADDRESS_FIELDS, statusCode: 400 };
  }

  const anchor = await findSalesOrderByOrderId(baserow, orderId);
  if (!anchor) return { ok: false, error: "order_not_found", statusCode: 404 };

  const normalizedId = normalizeOrderIdCandidate(anchor.order_id);
  const shopId = text(anchor.shop_id);

  const allRows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${FIELD.SALES.ORDER_ID}__contains`]: normalizedId,
  });
  const targetRows = allRows.filter((r) =>
    normalizeOrderIdCandidate(r.order_id) === normalizedId &&
    text(r.shop_id) === shopId &&
    !isFeeRow(r.product_name)
  );

  if (!targetRows.length) return { ok: false, error: "no_rows_found", statusCode: 404 };

  let patched = 0;
  let failed = 0;
  const results = [];
  for (const row of targetRows) {
    try {
      const pr = await patchRow(baserow, baserow.salesOrderTableId, row.id, patchFields);
      if (pr.ok) {
        patched++;
        results.push({ row_id: row.id, ok: true });
      } else {
        failed++;
        results.push({ row_id: row.id, ok: false, error: pr.error });
      }
    } catch (e) {
      failed++;
      results.push({ row_id: row.id, ok: false, error: normalizeErrorMessage(e) });
    }
  }

  invalidatePortalListCache();

  // Re-enrich the anchor row with patched fields (feedback: return fresh order, not stale)
  let enrichedOrder = null;
  const mergedAnchor = { ...anchor };
  for (const key of Object.keys(patchFields)) {
    mergedAnchor[key] = patchFields[key];
  }
  try {
    const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
    const productFields = await getPortalProductFields(env, productsTableId);
    const commissionRate = parseFloat(String(env.PORTAL_COMMISSION_RATE_MERCARI || "0.10"));
    enrichedOrder = await enrichOrderDetail(env, mergedAnchor, productFields, commissionRate);
    const shipmentSyncStatus = await getShipmentSyncStatusForOrder(baserow, mergedAnchor);
    if (shipmentSyncStatus) enrichedOrder.shipment_sync_status = shipmentSyncStatus;
  } catch (_) { /* enrichment failed — non-fatal */ }

  // Audit log on anchor row only (feedback: single audit entry per action)
  const changedFields = [];
  const diffParts = [];
  for (const key of Object.keys(patchFields)) {
    const prev = text(anchor[key]);
    const next = patchFields[key];
    if (prev !== next) {
      changedFields.push(key);
      diffParts.push(`${key}: "${prev || "(empty)"}" → "${next || "(empty)"}"`);
    }
  }
  if (changedFields.length) {
    const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: shipping_address updated (${diffParts.join(", ")})`;
    await appendAuditLog(baserow, anchor.id, anchor.order_comments, auditEntry);
  }

  return {
    ok: failed === 0,
    partial: failed > 0 ? true : undefined,
    order_id: normalizedId,
    rows_patched: patched,
    rows_failed: failed,
    rows_total: targetRows.length,
    updated_fields: changedFields,
    order: enrichedOrder,
    ...(failed > 0 ? { results } : {}),
  };
}

// ── PATCH /api/portal/orders/:id/quantity ──────────────────────────────

export async function handlePortalQuantity(env, orderId, body) {
  const baserow = createBaserowClient(env);
  const rawQty = body.quantity;
  const newQty = parseInt(rawQty, 10);

  if (Number.isNaN(newQty) || newQty < 1) {
    return { ok: false, error: "invalid_quantity", statusCode: 400 };
  }

  const anchor = await findSalesOrderByOrderId(baserow, orderId);
  if (!anchor) return { ok: false, error: "order_not_found", statusCode: 404 };

  const targetRows = (await findSalesOrderLinesByOrderId(baserow, orderId, text(anchor.shop_id)))
    .filter((candidate) => !isFeeRow(candidate.product_name));
  const selection = selectOrderLineTarget(targetRows, body.row_id);
  if (!selection.ok) return selection;
  const row = selection.row;

  const patchResult = await patchRow(baserow, baserow.salesOrderTableId, row.id, { quantity: newQty });
  if (!patchResult.ok) {
    return { ok: false, error: `patch_failed:${patchResult.error}`, statusCode: patchResult.status };
  }

  invalidatePortalListCache();

  // Audit log
  const prevQty = parseInt(row.quantity, 10);
  if (prevQty !== newQty) {
    const auditEntry = `[${toJstIso(new Date())}] PORTAL_OPERATOR: quantity changed from ${prevQty} to ${newQty}`;
    await appendAuditLog(baserow, row.id, row.order_comments, auditEntry);
  }

  // Enrich with fresh margin/stock after qty change
  let order = null;
  try {
    const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
    const productFields = await getPortalProductFields(env, productsTableId);
    const commissionRate = parseFloat(String(env.PORTAL_COMMISSION_RATE_MERCARI || "0.10"));
    row.quantity = newQty;
    order = await enrichOrderDetail(env, row, productFields, commissionRate);
    const shipmentSyncStatus = await getShipmentSyncStatusForOrder(baserow, row);
    if (shipmentSyncStatus) order.shipment_sync_status = shipmentSyncStatus;
  } catch (_) { /* enrichment failed — non-fatal */ }

  return {
    ok: true,
    order_id: text(row.order_id),
    row_id: row.id,
    quantity: newQty,
    order: order,
    rows_patched: 1,
    rows_total: 1,
    rows_failed: 0,
  };
}

// ── Helper: append audit entry to order_comments ────────────────────

async function appendAuditLog(baserow, rowId, existingLog, entry) {
  try {
    const updatedLog = existingLog ? `${entry}\n\n${text(existingLog)}` : entry;
    await patchRow(baserow, baserow.salesOrderTableId, rowId, {
      order_comments: updatedLog,
    });
  } catch (_) { /* audit write failed — non-fatal */ }
}

// ── GET /api/portal/orders/:id/messages ─────────────────────────────

export async function handlePortalOrderMessages(env, orderId, { refresh }) {
  const baserow = createBaserowClient(env);

  // Resolve the order to get shop_id
  const row = await findSalesOrderByOrderId(baserow, orderId);
  if (!row) return { ok: false, error: "order_not_found", statusCode: 404 };

  const shopId = text(row.shop_id);
  const shopLabel = Object.entries(MERCARI_CHANNEL.shopIds).find(([, id]) => id === shopId)?.[0] || shopId;
  const kvKey = `messages:${shopId}:${orderId}`;

  // If not a forced refresh, try KV cache first
  if (!refresh && env.PORTAL_KV) {
    try {
      const cached = await env.PORTAL_KV.get(kvKey, "json");
      // Legacy rows without persisted facts must go live once so the newly
      // added Baserow fields are populated instead of serving body cache only.
      if (cached && cached.messages && row.message_last_synced_at) {
        return { ok: true, messages: formatMessageTimestampsJst(cached.messages), source: "cache", fetched_at: cached.fetched_at };
      }
    } catch (_) { /* KV read failed, fall through to Mercari */ }
  }

  // Fetch from Mercari via relay
  const relayResult = await runMercariOrderMessagesViaRelay(env, { shopLabel, orderId });
  if (!relayResult.ok || !relayResult.body || !relayResult.body.ok) {
    // Try stale KV cache as fallback
    if (!refresh && env.PORTAL_KV) {
      try {
        const stale = await env.PORTAL_KV.get(kvKey, "json");
        if (stale && stale.messages) {
          return {
            ok: true, messages: formatMessageTimestampsJst(stale.messages), source: "cache", stale: true,
            warning: `Mercari unavailable, showing cached messages from ${stale.fetched_at ? formatJstDateTime(stale.fetched_at) : "unknown time"}`,
          };
        }
      } catch (_) { /* stale read failed */ }
    }
    const errMsg = relayResult.body && relayResult.body.error ? relayResult.body.error : "mercari_graphql_error";
    return { ok: false, error: "mercari_graphql_error", detail: errMsg, statusCode: 500 };
  }

  const messages = relayResult.body.messages || [];

  // Cache in KV with 24h TTL (body cache only — no read-state)
  if (env.PORTAL_KV) {
    const now = new Date().toISOString();
    try {
      const normalized = messages.map((m) => ({
        id: m.id || null,
        role: String(m.role || "").trim().toUpperCase(),
        message: String(m.message || "").trim(),
        createdAt: String(m.createdAt || "").trim(),
      }));
      await env.PORTAL_KV.put(kvKey, JSON.stringify({
        order_id: orderId,
        shop_id: shopId,
        fetched_at: now,
        messages: normalized,
      }), { expirationTtl: 86400 });
    } catch (_) { /* KV write failed — non-fatal */ }
  }

  // Persist the same buyer-message facts used by the list. Do not report a
  // successful refresh when the durable Baserow write failed.
  try {
    await writeThroughMessageFacts(env, shopId, orderId, messages);
    invalidatePortalListCache();
  } catch (error) {
    return { ok: false, error: "message_state_persist_failed", detail: error.message, statusCode: 500 };
  }

  return { ok: true, messages: formatMessageTimestampsJst(messages), source: "mercari" };
}

// ── POST /api/portal/orders/:id/messages/read ───────────────────────

export async function handlePortalOrderMarkRead(env, orderId) {
  const baserow = createBaserowClient(env);

  const row = await findSalesOrderByOrderId(baserow, orderId);
  if (!row) return { ok: false, error: "order_not_found", statusCode: 404 };

  const shopId = text(row.shop_id);
  if (!shopId) return { ok: false, error: "missing_shop_id", statusCode: 400 };

  // Read the latest buyer message ID from the Baserow row (written during ingest)
  const latestBuyerMessageId = text(row.latest_buyer_message_id || "");

  // Advance the durable read cursor to the latest buyer message
  await markAsRead(env, shopId, orderId, latestBuyerMessageId);

  // Re-read the updated state to return to caller
  const updated = await readDurableState(env, shopId, orderId);

  // Invalidate portal list cache so next load reflects the read state
  invalidatePortalListCache();

  return {
    ok: true,
    state: updated || {
      order_id: orderId,
      shop_id: shopId,
      last_read_message_id: latestBuyerMessageId,
      last_read_at: new Date().toISOString(),
    },
  };
}

// ── POST /api/portal/orders/:id/messages ────────────────────────────

export async function handlePortalOrderReply(env, orderId, body) {
  const replyText = text(body.text || "");
  if (!replyText) return { ok: false, error: "reply_text_required", statusCode: 400 };
  if (replyText.length > 1000) return { ok: false, error: "reply_text_too_long", max_length: 1000, statusCode: 400 };
  if (/^[\s\0-\x1F]+$/.test(replyText)) return { ok: false, error: "reply_text_invalid", statusCode: 400 };

  const baserow = createBaserowClient(env);

  // Resolve the order
  const row = await findSalesOrderByOrderId(baserow, orderId);
  if (!row) return { ok: false, error: "order_not_found", statusCode: 404 };

  const shopId = text(row.shop_id);
  const shopLabel = Object.entries(MERCARI_CHANNEL.shopIds).find(([, id]) => id === shopId)?.[0] || shopId;

  // Idempotency guard — acquire BEFORE sending (atomic via unique constraint).
  // Pattern: acquire → send → (on failure, release; on success, keep).
  let replyGuardKey = null;
  try {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(replyText));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const contentHash = hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    replyGuardKey = `reply-sent:${orderId}:${contentHash}`;
    const acquired = await setIdempotencyGuard(env, replyGuardKey, { ttlSeconds: 60 });
    if (acquired === "duplicate") {
      return { ok: false, error: "duplicate_reply", message: "Reply already sent (idempotent guard)", statusCode: 409 };
    }
    // "backend_error" → continue without guard (best-effort); "acquired" → proceed
  } catch (_) { /* guard acquisition failed — continue without guard */ }

  // Send via relay
  const relayResult = await runMercariOrderReplyViaRelay(env, {
    shopLabel,
    transactionId: orderId,
    text: replyText,
  });

  if (!relayResult.ok || !relayResult.body || !relayResult.body.ok) {
    // Release guard on delivery failure so retry works
    if (replyGuardKey) {
      try { await deleteIdempotencyGuard(env, replyGuardKey); } catch (_) { /* non-fatal */ }
    }
    const errMsg = relayResult.body && relayResult.body.error ? relayResult.body.error : "mercari_graphql_error";
    if (relayResult.status === 401 || (relayResult.body && relayResult.body.error === "mercari_auth_failed")) {
      return { ok: false, error: "mercari_auth_failed", detail: errMsg, statusCode: 500 };
    }
    return { ok: false, error: "mercari_graphql_error", detail: errMsg, statusCode: 500 };
  }

  const sentMessage = relayResult.body.message || {};

  // Advance durable read-state (operator has seen messages after replying)
  try {
    const latestBuyerMessageId = text(row.latest_buyer_message_id || "");
    await markAsRead(env, shopId, orderId, latestBuyerMessageId);
  } catch (_) { /* durable state write failed — reply already succeeded */ }

  return {
    ok: true,
    message: {
      id: sentMessage.id || null,
      role: sentMessage.role || "SELLER",
      message: sentMessage.message || replyText,
      createdAt: formatJstDateTime(sentMessage.createdAt || new Date().toISOString()),
    },
  };
}

// ── POST /api/portal/orders/:id/generate-reply ─────────────────────

export async function handlePortalGenerateReply(env, orderId, body = {}) {
  // 1. Check API key is configured
  const apiKey = text(env.OPENAI_API_KEY);
  if (!apiKey) {
    return { ok: false, error: "api_key_not_configured", message: "OPENAI_API_KEY secret is not set.", statusCode: 503 };
  }

  // 2. Extract and validate draft
  const draftText = text(body.draft || "");
  if (!draftText) {
    return { ok: false, error: "no_draft_provided", message: "No draft text to polish.", statusCode: 400 };
  }

  // 3. Resolve order for context
  const baserow = createBaserowClient(env);
  const row = await findSalesOrderByOrderId(baserow, orderId);
  if (!row) return { ok: false, error: "order_not_found", statusCode: 404 };

  const shopId = text(row.shop_id);
  const shopLabel = Object.entries(MERCARI_CHANNEL.shopIds).find(([, id]) => id === shopId)?.[0] || shopId;

  // 4. Build lightweight context (no message fetching — polish-only)
  const { buildContext, renderContextForPrompt, renderContextForLog } = await import("../copywrite-context.mjs");
  const { callOpenAI, buildSystemPrompt } = await import("../openai-client.mjs");

  const context = buildContext(row, [], { shopLabel });
  const systemPrompt = buildSystemPrompt();
  const userMessage = renderContextForPrompt(context, draftText);

  const model = text(env.LLM_MODEL) || "gpt-4o";
  const maxTokens = parseInteger(env.LLM_MAX_TOKENS, 1000);

  // 5. Call OpenAI
  const aiResult = await callOpenAI(apiKey, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ], {
    model,
    temperature: 0.3,
    maxTokens,
    timeoutMs: 30000,
    maxRetries: 3,
  });

  if (!aiResult.ok) {
    if (aiResult.status === 429) {
      return { ok: false, error: "openai_rate_limited", retry_after_seconds: 30, statusCode: 429 };
    }
    if (aiResult.status === 401) {
      return { ok: false, error: "openai_auth_failed", message: "OpenAI API key rejected.", statusCode: 500 };
    }
    return { ok: false, error: "openai_api_error", detail: aiResult.error?.message, statusCode: 500 };
  }

  // 6. Check for truncation (finish_reason === "length")
  if (aiResult.finish_reason === "length") {
    return { ok: false, error: "truncated_response", message: "AI response was truncated — please shorten the draft or try again.", statusCode: 500 };
  }

  const draft = (aiResult.choices && aiResult.choices[0] && aiResult.choices[0].message && aiResult.choices[0].message.content || "").trim();
  if (!draft) {
    return { ok: false, error: "empty_draft", message: "OpenAI returned an empty response.", statusCode: 500 };
  }

  // 7. Log to AI copywrite log field (prepend to existing content)
  try {
    const copywriteLogFieldName = "AI copywrite log";
    const existingLog = text(row[copywriteLogFieldName]);
    const now = toJstIso(new Date());
    const logEntry = renderContextForLog(context, {
      generatedAt: now,
      model: aiResult.model || model,
      temperature: 0.3,
      usage: aiResult.usage || {},
      generatedBy: "PORTAL_OPERATOR",
      draft,
    });
    const updatedLog = existingLog ? `${logEntry}\n\n${existingLog}` : logEntry;
    await patchRow(baserow, baserow.salesOrderTableId, row.id, {
      [copywriteLogFieldName]: updatedLog,
    });
  } catch (_) { /* log write failed — non-fatal */ }

  // 8. Return polished draft with lightweight context
  return {
    ok: true,
    draft,
    model: aiResult.model || model,
    usage: aiResult.usage || null,
    context: {
      customer_name: context.customerName,
      product_name: context.productName,
      order_status: context.orderStatus,
    },
  };
}

// ── Template CRUD handlers ──────────────────────────────────────────

export async function handlePortalTemplatesList(env) {
  // Prefer KV (Worker); fall back to Supabase (VPS Portal API)
  if (env.PORTAL_KV) {
    try {
      const list = await env.PORTAL_KV.list({ prefix: "template:" });
      const keys = list.keys || [];
      const templates = [];
      for (const key of keys) {
        try {
          const value = await env.PORTAL_KV.get(key.name, "json");
          if (value) templates.push({ id: key.name.replace("template:", ""), ...value });
        } catch (_) { /* skip corrupt entries */ }
      }
      templates.sort((a, b) => {
        const aSort = typeof a.sort_order === "number" ? a.sort_order : 0;
        const bSort = typeof b.sort_order === "number" ? b.sort_order : 0;
        if (aSort !== bSort) return bSort - aSort;
        return (b.created_at || "") > (a.created_at || "") ? 1 : -1;
      });
      return { ok: true, templates };
    } catch (_) {
      return { ok: false, error: "kv_unavailable", statusCode: 500 };
    }
  }

  // Supabase fallback
  try {
    return await sbListTemplates(env);
  } catch (_) {
    return { ok: false, error: "db_error", statusCode: 500 };
  }
}

export async function handlePortalTemplatesCreate(env, body) {
  const title = text(body.title || "");
  const bodyText = text(body.body || "");
  if (!title) return { ok: false, error: "template_title_required", statusCode: 400 };
  if (!bodyText) return { ok: false, error: "template_body_required", statusCode: 400 };

  // KV path (Worker)
  if (env.PORTAL_KV) {
    try {
      const existing = await handlePortalTemplatesList(env);
      if (existing.ok && existing.templates.some((t) => t.title === title)) {
        return { ok: false, error: "template_title_duplicate", statusCode: 400 };
      }
    } catch (_) { /* proceed */ }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let maxSort = 0;
    try {
      const list = await handlePortalTemplatesList(env);
      if (list.ok && list.templates.length) {
        maxSort = Math.max(...list.templates.map((t) => (typeof t.sort_order === "number" ? t.sort_order : 0)));
      }
    } catch (_) { /* best effort */ }

    const record = { title, body: bodyText, sort_order: maxSort + 1, created_at: now, updated_at: now };
    try {
      await env.PORTAL_KV.put(`template:${id}`, JSON.stringify(record));
      return { ok: true, template: { id, ...record } };
    } catch (_) {
      return { ok: false, error: "kv_unavailable", statusCode: 500 };
    }
  }

  // Supabase fallback (VPS Portal API)
  try {
    return await sbCreateTemplate(env, { title, body: bodyText });
  } catch (_) {
    return { ok: false, error: "db_error", statusCode: 500 };
  }
}

export async function handlePortalTemplatesUpdate(env, id, body) {
  const title = text(body.title || "");
  const bodyText = text(body.body || "");
  if (!title) return { ok: false, error: "template_title_required", statusCode: 400 };
  if (!bodyText) return { ok: false, error: "template_body_required", statusCode: 400 };

  // KV path (Worker)
  if (env.PORTAL_KV) {
    const key = `template:${id}`;
    try {
      const existing = await env.PORTAL_KV.get(key, "json");
      if (!existing) return { ok: false, error: "template_not_found", statusCode: 404 };
    } catch (_) {
      return { ok: false, error: "kv_unavailable", statusCode: 500 };
    }

    try {
      const list = await handlePortalTemplatesList(env);
      if (list.ok && list.templates.some((t) => t.title === title && t.id !== id)) {
        return { ok: false, error: "template_title_duplicate", statusCode: 400 };
      }
    } catch (_) { /* proceed */ }

    const row = await env.PORTAL_KV.get(key, "json");
    const now = new Date().toISOString();
    const record = { title, body: bodyText, sort_order: row.sort_order ?? 0, created_at: row.created_at || now, updated_at: now };
    try {
      await env.PORTAL_KV.put(key, JSON.stringify(record));
      return { ok: true, template: { id, ...record } };
    } catch (_) {
      return { ok: false, error: "kv_unavailable", statusCode: 500 };
    }
  }

  // Supabase fallback (VPS Portal API)
  try {
    return await sbUpdateTemplate(env, id, { title, body: bodyText });
  } catch (_) {
    return { ok: false, error: "db_error", statusCode: 500 };
  }
}

export async function handlePortalTemplatesDelete(env, id) {
  // KV path (Worker)
  if (env.PORTAL_KV) {
    const key = `template:${id}`;
    try {
      const existing = await env.PORTAL_KV.get(key, "json");
      if (!existing) return { ok: false, error: "template_not_found", statusCode: 404 };
      await env.PORTAL_KV.delete(key);
      return { ok: true };
    } catch (_) {
      return { ok: false, error: "kv_unavailable", statusCode: 500 };
    }
  }

  // Supabase fallback (VPS Portal API)
  try {
    return await sbDeleteTemplate(env, id);
  } catch (_) {
    return { ok: false, error: "db_error", statusCode: 500 };
  }
}

export async function handlePortalTemplatesReorder(env, body) {
  const id = text(body.id || "");
  const direction = text(body.direction || "");
  if (!id) return { ok: false, error: "template_id_required", statusCode: 400 };
  if (direction !== "up" && direction !== "down") {
    return { ok: false, error: "invalid_direction", statusCode: 400 };
  }

  // KV path (Worker)
  if (env.PORTAL_KV) {
    const listResult = await handlePortalTemplatesList(env);
    if (!listResult.ok || !listResult.templates.length) {
      return { ok: false, error: "no_templates", statusCode: 400 };
    }

    const templates = listResult.templates;
    const idx = templates.findIndex((t) => t.id === id);
    if (idx < 0) return { ok: false, error: "template_not_found", statusCode: 404 };

    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= templates.length) {
      return { ok: false, error: "already_at_edge", statusCode: 400 };
    }

    const current = templates[idx];
    const target = templates[targetIdx];
    const curSort = typeof current.sort_order === "number" ? current.sort_order : 0;
    const tgtSort = typeof target.sort_order === "number" ? target.sort_order : 0;

    let newCurSort, newTgtSort;
    if (curSort === tgtSort) {
      if (direction === "up") {
        newCurSort = tgtSort + 1;
        newTgtSort = tgtSort;
      } else {
        newCurSort = tgtSort - 1;
        newTgtSort = tgtSort;
      }
    } else {
      newCurSort = tgtSort;
      newTgtSort = curSort;
    }

    try {
      await Promise.all([
        env.PORTAL_KV.put(`template:${current.id}`, JSON.stringify({ ...current, sort_order: newCurSort })),
        env.PORTAL_KV.put(`template:${target.id}`, JSON.stringify({ ...target, sort_order: newTgtSort })),
      ]);
      return { ok: true };
    } catch (_) {
      return { ok: false, error: "kv_unavailable", statusCode: 500 };
    }
  }

  // Supabase fallback (VPS Portal API)
  try {
    return await sbReorderTemplates(env, id, direction);
  } catch (_) {
    return { ok: false, error: "db_error", statusCode: 500 };
  }
}

// ── Portal-only helpers ─────────────────────────────────────────────

function formatMessageTimestampsJst(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => ({
    ...m,
    createdAt: formatJstDateTime(m && m.createdAt),
    createdAtRaw: m && m.createdAt, // preserve original for any programmatic use
  }));
}

/**
 * Find a sales order row by order_id, trying exact match first before
 * falling back to a contains scan. This avoids expensive full-table
 * scans in the common case where order_id values are consistent.
 *
 * Phase 1: __equal with raw orderId (fastest — indexed lookup)
 * Phase 2: __equal with "order_" prefix swapped
 * Phase 3: __contains fallback (table scan — slow but correct)
 *
 * @param {Object} baserow - Baserow client
 * @param {string} orderId - Raw order ID from the request
 * @returns {Promise<Object|null>} matching sales row or null
 */
async function findSalesOrderByOrderId(baserow, orderId) {
  const fieldId = FIELD.SALES.ORDER_ID;
  const target = parsePortalTargetId(orderId);
  const lookupOrderId = target?.orderId || orderId;
  const normalizedTarget = normalizeOrderIdCandidate(lookupOrderId);
  const matchesTarget = (row) => normalizeOrderIdCandidate(row.order_id) === normalizedTarget
    && (!target || (
      text(row.sales_channel).toLowerCase() === target.channel
      && text(row.source_store_id || row.shop_id).toLowerCase() === target.storeId
    ));

  // Phase 1: try exact match with raw orderId
  let rows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${fieldId}__equal`]: lookupOrderId,
  });
  let match = selectMarketplaceAnchor(rows.filter(matchesTarget));
  if (match) return match;

  // Phase 2: try with "order_" prefix toggled (Mercari convention)
  const prefixed = lookupOrderId.startsWith("order_") ? lookupOrderId.slice(6) : `order_${lookupOrderId}`;
  if (prefixed !== lookupOrderId) {
    rows = await listAllRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${fieldId}__equal`]: prefixed,
    });
    match = selectMarketplaceAnchor(rows.filter(matchesTarget));
    if (match) return match;
  }

  // Phase 3: fallback to contains scan (catches case/whitespace variations)
  rows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${fieldId}__contains`]: lookupOrderId,
  });
  return selectMarketplaceAnchor(rows.filter(matchesTarget));
}

export function selectMarketplaceAnchor(rows) {
  const candidates = Array.isArray(rows) ? rows : [];
  const scopes = new Set(candidates.map((row) => {
    const channel = text(row.sales_channel).toLowerCase();
    const store = text(row.source_store_id || row.shop_id).toLowerCase();
    return channel && store ? `${channel}\u0000${store}` : "";
  }).filter(Boolean));
  if (scopes.size > 1) {
    const error = new Error("ambiguous_order_scope");
    error.code = "ambiguous_order_scope";
    throw error;
  }
  return candidates.find((row) => text(row.line_origin) !== "operator_component") || candidates[0] || null;
}

async function findSalesOrderLinesByOrderId(baserow, orderId, shopId = "") {
  const fieldId = FIELD.SALES.ORDER_ID;
  const target = parsePortalTargetId(orderId);
  const lookupOrderId = target?.orderId || orderId;
  const normalizedTarget = normalizeOrderIdCandidate(lookupOrderId);
  const effectiveShopId = target?.storeId || text(shopId).toLowerCase();
  const matchesTarget = (row) =>
    normalizeOrderIdCandidate(row.order_id) === normalizedTarget &&
    (!effectiveShopId || text(row.source_store_id || row.shop_id).toLowerCase() === effectiveShopId) &&
    (!target || text(row.sales_channel).toLowerCase() === target.channel);

  let rows = await listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${fieldId}__equal`]: lookupOrderId,
  });
  let matches = rows.filter(matchesTarget);

  if (!matches.length) {
    const alternate = lookupOrderId.startsWith("order_") ? lookupOrderId.slice(6) : `order_${lookupOrderId}`;
    rows = await listAllRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${fieldId}__equal`]: alternate,
    });
    matches = rows.filter(matchesTarget);
  }

  if (!matches.length) {
    rows = await listAllRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${fieldId}__contains`]: lookupOrderId,
    });
    matches = rows.filter(matchesTarget);
  }

  return [...new Map(matches.map((candidate) => [String(candidate.id), candidate])).values()]
    .sort((left, right) => {
      const leftComponent = text(left.line_origin) === "operator_component";
      const rightComponent = text(right.line_origin) === "operator_component";
      if (leftComponent !== rightComponent) return leftComponent ? 1 : -1;
      const indexDiff = parseInteger(left.component_index, 0) - parseInteger(right.component_index, 0);
      return indexDiff || String(left.id).localeCompare(String(right.id));
    });
}

export function buildPortalTargetId(row) {
  const channel = text(row?.sales_channel).toLowerCase();
  const storeId = text(row?.source_store_id || row?.shop_id).toLowerCase();
  const orderId = text(row?.order_id);
  if (!channel || !storeId || !orderId) return orderId;
  return `scope|${encodeURIComponent(channel)}|${encodeURIComponent(storeId)}|${encodeURIComponent(orderId)}`;
}

export function parsePortalTargetId(value) {
  const raw = text(value);
  if (!raw.startsWith("scope|")) return null;
  const parts = raw.split("|");
  if (parts.length !== 4) throw new Error("invalid_order_scope");
  const channel = decodeURIComponent(parts[1]).trim().toLowerCase();
  const storeId = decodeURIComponent(parts[2]).trim().toLowerCase();
  const orderId = decodeURIComponent(parts[3]).trim();
  if (!channel || !storeId || !orderId) throw new Error("invalid_order_scope");
  return { channel, storeId, orderId };
}

export function resolveBulkOrderTargets(body = {}) {
  const scopedTargets = Array.isArray(body.order_targets) ? body.order_targets.map(text).filter(Boolean) : [];
  if (scopedTargets.some((target) => !parsePortalTargetId(target))) return { ok: false, targets: [] };
  const legacyOrderIds = Array.isArray(body.order_ids) ? body.order_ids.map(text).filter(Boolean) : [];
  return { ok: true, targets: scopedTargets.length ? scopedTargets : legacyOrderIds };
}

function toPortalOrderLine(row, productCache = new Map(), productFields = {}, commissionRate = 0.10) {
  const itemCode = text(row.B2BItemCode);
  const productData = itemCode ? (productCache.get(itemCode) || null) : null;
  const margin = computeMargin(row, productData, commissionRate, {
    effectiveTcogsFieldId: productFields.effectiveTcogsFieldId,
    effectiveCostPriceFieldId: productFields.effectiveCostPriceFieldId,
    sourceUnitPriceFieldId: productFields.sourceUnitPriceFieldId,
  });
  const ownedQty = productData ? readProductNumber(productData, productFields.ownedQtyFieldId) : null;
  const qtyAvailable = productData ? readProductNumber(productData, productFields.qtyAvailableFieldId) : null;
  const stock = computeStockStatus(ownedQty, qtyAvailable, parseInteger(row.quantity, 0));
  return {
    id: row.id,
    platform_sku: platformSkuForRow(row),
    product_name: text(row.product_name),
    B2BItemCode: text(row.B2BItemCode),
    quantity: parseInteger(row.quantity, 0),
    line_origin: text(row.line_origin),
    component_index: parseInteger(row.component_index, 0) || null,
    unit_price: margin.unitPrice,
    effective_tcogs: margin.effectiveTcogsPerUnit,
    effective_cogs: margin.effectiveCogsPerUnit,
    source_unit_price: margin.sourceUnitPrice,
    line_tcogs: lineTcogs(row, productCache, productFields),
    stock,
    cogs_unit_price_equal: margin.cogsEqualsUnitPrice,
  };
}

export function selectOrderLineTarget(rows, requestedRowId) {
  const candidates = Array.isArray(rows) ? rows : [];
  if (requestedRowId !== undefined && requestedRowId !== null && String(requestedRowId).trim() !== "") {
    const target = candidates.find((candidate) => String(candidate.id) === String(requestedRowId));
    if (!target) return { ok: false, error: "order_line_not_found", statusCode: 404 };
    return { ok: true, row: target };
  }
  if (candidates.length === 1) return { ok: true, row: candidates[0] };
  if (candidates.length > 1) return { ok: false, error: "row_id_required_for_multi_line_order", statusCode: 400 };
  return { ok: false, error: "order_line_not_found", statusCode: 404 };
}

export function findMissingB2bRowIds(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((candidate) => !text(candidate.B2BItemCode))
    .map((candidate) => candidate.id);
}
