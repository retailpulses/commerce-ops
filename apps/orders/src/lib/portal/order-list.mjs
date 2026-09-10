import { createBaserowClient, listRowsWithLimit, FIELD } from "../db.mjs";
import { MERCARI_CHANNEL } from "../channel-config.mjs";
import {
  createRakutenItemCodeBatchResolver,
  rakutenItemCodeResolutionKey,
} from "../item-code-resolver.mjs";
import { classifyUnreadStatus, readDurableState } from "../buyer-messages.mjs";
import {
  assessRiskBadges,
  batchResolveProducts,
  computeMargin,
  computeOrderEconomics,
  computeStockStatus,
  readProductNumber,
} from "../product-resolver.mjs";
import { formatJstDateTime, toJstIso } from "../timezone.mjs";
import { getPipelineState, readSelectValue } from "../order-state.mjs";
import { getCachedPortalList, getPortalProductFields, setCachedPortalList } from "./cache.mjs";
import {
  PORTAL_MAX_FEE_ROWS,
  PORTAL_MAX_SALES_ROWS,
  PORTAL_PAGE_SIZE,
  PORTAL_PRODUCTS_TABLE_ID,
  PORTAL_FEE_PATTERNS,
  PORTAL_SERVER_SEARCH_FIELD_IDS,
  LIFECYCLE,
  ATTENTION_FILTER,
  applyPortalOrderSearch,
  buildLifecycleFilters,
  buildPortalListCacheKey,
  buildReviewFilters,
  buildServerSearchFilterSets,
  comparePortalRows,
  getCustomerKey,
  isActivePipelineState,
  isFeeRow,
  mergeRowsById,
  parseInteger,
  shouldPaginateBeforeEnrichment,
  text,
  validatePortalParams,
} from "./shared.mjs";

export function filterPortalRowsByIssueType(rows, attention) {
  if (attention === ATTENTION_FILTER.NONE) {
    return rows.filter((row) => row.risk_badges.length === 0);
  }
  if (attention === ATTENTION_FILTER.LOW_MARGIN) {
    return rows.filter((row) => row.risk_badges.some((badge) => badge.type === "low_margin"));
  }
  if (attention === ATTENTION_FILTER.PRICE_CONFIRMATION_NEEDED) {
    return rows.filter((row) => row.risk_badges.some((badge) => badge.type === "cogs_unit_price_equal"));
  }
  if (attention === ATTENTION_FILTER.CRITICAL
    || attention === ATTENTION_FILTER.WARNING
    || attention === ATTENTION_FILTER.INFO) {
    return rows.filter((row) => row.risk_badges.some((badge) => badge.severity === attention));
  }
  if (attention === ATTENTION_FILTER.UNREAD) {
    return rows.filter((row) => row.has_unread === true);
  }
  if (attention === ATTENTION_FILTER.MESSAGE_CHECK_PENDING) {
    return rows.filter((row) => row.unread_classification === "unknown");
  }
  return rows;
}

/**
 * Build a reverse map from shop ID to shop label.
 * Used to construct KV keys from sales row shop_id fields.
 */
function buildShopIdToLabel() {
  const map = {};
  for (const [label, id] of Object.entries(MERCARI_CHANNEL.shopIds)) {
    map[String(id).trim()] = label;
  }
  return map;
}

const SHOP_LABEL_BY_ID = buildShopIdToLabel();

/**
 * Build server-side filter sets combining lifecycle, review, channel, shop, and search.
 * Returns an array of filter objects (one per OR branch for lifecycle + per search field).
 */
export function buildServerFilters({ lifecycle, review, shop, channel = "all" }) {
  const lifecycleFilterSets = buildLifecycleFilters(lifecycle, channel);
  const reviewFilters = buildReviewFilters(review);

  const shopFilter = {};
  if (channel === "mercari" && shop && MERCARI_CHANNEL.shopIds[shop]) {
    shopFilter[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = MERCARI_CHANNEL.shopIds[shop];
  }

  const channelFilter = {};
  if (channel === "rakuten") {
    channelFilter[`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`] = "rakuten";
  } else if (channel === "mercari") {
    // Channel isolation: prevent Rakuten rows from appearing in Mercari views
    channelFilter[`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`] = "mercari";
  }

  // Cross-product lifecycle OR branches with review, shop, and channel filters
  const filterSets = [];
  for (const lifecycleFilters of lifecycleFilterSets) {
    const combined = { ...lifecycleFilters, ...reviewFilters, ...shopFilter, ...channelFilter };
    // Only add non-empty filter sets (empty object is valid — means "all")
    filterSets.push(combined);
  }

  return filterSets;
}

export function buildPortalOrderSearchFilterSets(baseFilters, searchQuery) {
  return buildServerSearchFilterSets(baseFilters, searchQuery, PORTAL_SERVER_SEARCH_FIELD_IDS);
}

export async function listPortalSalesRows(baserow, baseFiltersList, searchQuery, maxRows, listFn = listRowsWithLimit) {
  if (!baseFiltersList.length) return [];

  // Build search filter sets per base filter × per search field
  const allFilterSets = [];
  for (const baseFilters of baseFiltersList) {
    const searchSets = buildServerSearchFilterSets(baseFilters, searchQuery, PORTAL_SERVER_SEARCH_FIELD_IDS);
    allFilterSets.push(...searchSets);
  }

  if (allFilterSets.length === 0) return [];
  if (allFilterSets.length === 1) {
    return listFn(baserow, baserow.salesOrderTableId, allFilterSets[0], maxRows);
  }

  // Multi-query: run all filter sets and merge by row ID
  const results = await Promise.all(
    allFilterSets.map((filters) =>
      listFn(baserow, baserow.salesOrderTableId, filters, maxRows)
    )
  );

  return mergeRowsById(results);
}

/**
 * Phase 2: Enrich a page of orders with unread classification by reading
 * buyer-message facts from Baserow row fields (written during Mercari ingest),
 * plus durable KV read-state (message-state:v1:*).
 *
 * The durable state key has no TTL. Missing durable state is classified as
 * `unknown`, but unknown/failed state is never included in the Unread filter.
 *
 * Returns a Map<orderId, {
 *   has_unread: boolean,
 *   classification: string,
 *   last_checked_at: string,
 *   last_check_status: string,
 *   last_check_error: string|null
 * }>.
 */
export async function enrichUnreadStatus(env, rows) {
  const result = new Map();
  if (!rows.length) return result;

  const kvEntries = [];
  for (const row of rows) {
    const orderId = text(row.order_id);
    const shopId = text(row.shop_id);
    if (!orderId || !shopId) {
      result.set(orderId, {
        has_unread: false,
        classification: "unknown",
        last_checked_at: "",
        last_check_status: "",
        last_check_error: null,
      });
      continue;
    }
    kvEntries.push({
      orderId,
      shopId,
    });
  }

  if (!kvEntries.length) return result;

  const reads = await Promise.all(
    kvEntries.map(async ({ orderId, shopId }) => {
      try {
        const cached = await readDurableState(env, shopId, orderId);
        return { orderId, kvReadState: cached };
      } catch (_) {
        return { orderId, kvReadState: null };
      }
    })
  );

  const readsByOrderId = new Map(
    reads.map((r) => [r.orderId, r.kvReadState])
  );

  for (const row of rows) {
    const orderId = text(row.order_id);
    const kvReadState = readsByOrderId.get(orderId) || null;
    const status = classifyUnreadStatus(row, kvReadState);
    result.set(orderId, {
      ...status,
      last_checked_at: text(kvReadState && kvReadState.last_checked_at),
      last_check_status: text(kvReadState && kvReadState.last_check_status),
      last_check_error: kvReadState && kvReadState.last_check_error != null
        ? String(kvReadState.last_check_error)
        : null,
    });
  }

  return result;
}

export async function handlePortalOrderList(env, searchParams) {
  const cacheKey = buildPortalListCacheKey("orders", searchParams);
  const cached = getCachedPortalList(cacheKey);
  if (cached) return cached;

  const baserow = createBaserowClient(env);
  const productsTableId = parseInteger(env.PORTAL_PRODUCTS_TABLE_ID, PORTAL_PRODUCTS_TABLE_ID);
  const commissionRate = parseFloat(String(env.PORTAL_COMMISSION_RATE_MERCARI || "0.10"));

  // Parse and validate new filter parameters with legacy translation
  let lifecycle, review, attention, channel, shop;
  try {
    const parsed = validatePortalParams(searchParams);
    lifecycle = parsed.lifecycle;
    review = parsed.review;
    attention = parsed.attention;
    channel = parsed.channel;
    shop = parsed.shop;
  } catch (error) {
    return { ok: false, error: error.message, statusCode: 400 };
  }

  // Build server-side filters from parsed params
  const baseFiltersList = buildServerFilters({ lifecycle, review, shop, channel });

  const searchQuery = text(searchParams.get("search") || "");
  let salesRows = await listPortalSalesRows(baserow, baseFiltersList, searchQuery, PORTAL_MAX_SALES_ROWS);
  const hasMoreSalesRows = salesRows.length >= PORTAL_MAX_SALES_ROWS;
  salesRows = salesRows.filter((row) => !isFeeRow(row.product_name));

  // Post-filter: enforce canonical Active pipeline state for Active lifecycle
  // (server-side loads WAITING_FOR_PAYMENT + WAITING_FOR_SHIPPING, but we must
  // exclude rows where the derived pipeline state is not active, e.g. UNKNOWN).
  // Skip for non-Mercari channels (pipeline_state is Mercari-specific).
  if (lifecycle === LIFECYCLE.ACTIVE && channel === "mercari") {
    salesRows = salesRows.filter((row) => {
      const state = getPipelineState(
        readSelectValue(row.order_status),
        readSelectValue(row.review_status)
      );
      return isActivePipelineState(state);
    });
  }
  salesRows = groupPortalOrderRows(salesRows);

  const sort = text(searchParams.get("sort") || "purchase_date");
  const order = text(searchParams.get("order") || "asc");
  const legacyRiskFilter = text(searchParams.get("risk") || "");
  const riskFilter = attention === ATTENTION_FILTER.CRITICAL
    || attention === ATTENTION_FILTER.WARNING
    || attention === ATTENTION_FILTER.INFO
    || attention === ATTENTION_FILTER.NONE
    || attention === ATTENTION_FILTER.LOW_MARGIN
    || attention === ATTENTION_FILTER.PRICE_CONFIRMATION_NEEDED
    ? attention
    : legacyRiskFilter;
  const unreadFilter = attention === ATTENTION_FILTER.UNREAD
    ? "1"
    : text(searchParams.get("unread") || "");
  const messageCheckPendingFilter = attention === ATTENTION_FILTER.MESSAGE_CHECK_PENDING;
  const limit = Math.min(parseInteger(searchParams.get("limit"), PORTAL_PAGE_SIZE), 200);
  const offset = parseInteger(searchParams.get("offset"), 0);
  const canPrePaginate = shouldPaginateBeforeEnrichment({
    riskFilter,
    unreadFilter: unreadFilter || (messageCheckPendingFilter ? "pending" : ""),
    sort,
  });

  let filteredRawRows = applyPortalOrderSearch(salesRows, searchQuery);
  if (sort !== "margin" && sort !== "margin_amount" && sort !== "margin_pct" && sort !== "risk") {
    filteredRawRows = [...filteredRawRows].sort((a, b) => comparePortalRows(a, b, sort, order));
  }

  const rawTotalCount = filteredRawRows.length;
  const rowsForEnrichment = canPrePaginate
    ? filteredRawRows.slice(offset, offset + limit)
    : filteredRawRows;

  let feeCustomerKeys = new Set();
  if (rowsForEnrichment.length) {
    try {
      const feeRowMap = new Map();
      for (const pattern of PORTAL_FEE_PATTERNS) {
        const feeFilters = {
          [`filter__field_${FIELD.SALES.PRODUCT_NAME}__contains`]: pattern,
        };
        if (channel === "mercari" && shop && MERCARI_CHANNEL.shopIds[shop]) {
          feeFilters[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = MERCARI_CHANNEL.shopIds[shop];
        }
        const feeRows = await listRowsWithLimit(baserow, baserow.salesOrderTableId, feeFilters, PORTAL_MAX_FEE_ROWS);
        for (const row of feeRows) {
          if (!feeRowMap.has(row.id)) {
            feeRowMap.set(row.id, row);
            const key = getCustomerKey(row);
            if (key) feeCustomerKeys.add(key);
          }
        }
      }
    } catch (error) {
      console.warn("portal_fee_badge_lookup_failed:", error.message);
    }
  }

  let productFields;
  try {
    productFields = await getPortalProductFields(env, productsTableId);
  } catch (error) {
    console.warn("portal_product_fields_failed:", error.message);
    const degradedResults = rowsForEnrichment.map((row) => buildDegradedPortalRow(row));
    const result = buildPortalOrderResponse({
      rawTotalCount,
      results: degradedResults,
      hasMoreSalesRows,
      offset,
      limit,
      canPrePaginate,
      appliedFilters: { lifecycle, review, attention, channel, shop },
    });
    setCachedPortalList(cacheKey, result);
    return result;
  }

  const itemCodes = rowsForEnrichment.flatMap((row) => (row.__order_lines || [row]).map((line) => text(line.B2BItemCode))).filter(Boolean);
  const productCache = await batchResolveProducts(
    env,
    productsTableId,
    productFields.itemCodeFieldId,
    [...new Set(itemCodes)],
  );

  // Resolve Rakuten manage_number → B2BItemCode via product_platform_links mapping.
  // Mutates rows in-place so enrichPortalOrderRow (sync) reads the resolved code.
  const newlyResolvedCodes = await resolveRakutenRowsB2BItemCodes(rowsForEnrichment, baserow.supabase);
  if (newlyResolvedCodes.length > 0) {
    // Add product data for newly resolved codes
    const newProductCache = await batchResolveProducts(
      env,
      productsTableId,
      productFields.itemCodeFieldId,
      newlyResolvedCodes,
    );
    for (const [code, product] of newProductCache) {
      if (!productCache.has(code)) productCache.set(code, product);
    }
  }

  const enriched = rowsForEnrichment.map((row) =>
    enrichPortalOrderRow(row, productCache, productFields, commissionRate, feeCustomerKeys)
  );

  // Enrich with unread classification (Phase 1: row fields + KV read-state)
  try {
    const unreadMap = await enrichUnreadStatus(env, enriched);
    for (const row of enriched) {
      const info = unreadMap.get(row.order_id) || { has_unread: false, classification: "unknown" };
      row.has_unread = info.has_unread;
      row.unread_classification = info.classification;
      row.message_last_checked_at = info.last_checked_at || "";
      row.message_check_status = info.last_check_status || "";
      row.message_check_error = info.last_check_error || null;
    }
  } catch (error) {
    console.warn("portal_unread_enrichment_failed:", error.message);
    for (const row of enriched) {
      row.has_unread = false;
      row.unread_classification = "unknown";
      row.message_last_checked_at = "";
      row.message_check_status = "";
      row.message_check_error = null;
    }
  }

  let finalResults = enriched;
  let totalCount = rawTotalCount;

  if (!canPrePaginate) {
    const issueTypeFilter = attention === ATTENTION_FILTER.ANY && riskFilter ? riskFilter : attention;
    finalResults = filterPortalRowsByIssueType(enriched, issueTypeFilter);

    finalResults.sort((a, b) => {
      if (sort === "margin" || sort === "margin_pct") {
        const aVal = a.margin && a.margin.marginPercent != null ? a.margin.marginPercent : -Infinity;
        const bVal = b.margin && b.margin.marginPercent != null ? b.margin.marginPercent : -Infinity;
        return order === "asc" ? aVal - bVal : bVal - aVal;
      }
      if (sort === "margin_amount") {
        const aVal = a.margin && a.margin.profit != null ? a.margin.profit : -Infinity;
        const bVal = b.margin && b.margin.profit != null ? b.margin.profit : -Infinity;
        return order === "asc" ? aVal - bVal : bVal - aVal;
      }
      if (sort === "risk") {
        const aVal = a.risk_badges.length;
        const bVal = b.risk_badges.length;
        return order === "asc" ? aVal - bVal : bVal - aVal;
      }
      return comparePortalRows(a, b, sort, order);
    });

    totalCount = finalResults.length;
    finalResults = finalResults.slice(offset, offset + limit);
  }

  const result = buildPortalOrderResponse({
    rawTotalCount: totalCount,
    results: finalResults,
    hasMoreSalesRows,
    offset,
    limit,
    canPrePaginate,
    appliedFilters: { lifecycle, review, attention, channel, shop },
  });
  setCachedPortalList(cacheKey, result);
  return result;
}

export function enrichPortalOrderRow(row, productCache, productFields, commissionRate, feeCustomerKeys) {
  const itemCode = text(row.B2BItemCode);
  const productData = itemCode ? (productCache.get(itemCode) || null) : null;
  const quantity = parseInteger(row.quantity, 0);
  let marginResult = computeMargin(row, productData, commissionRate, {
    effectiveTcogsFieldId: productFields.effectiveTcogsFieldId,
    effectiveCostPriceFieldId: productFields.effectiveCostPriceFieldId,
    sourceUnitPriceFieldId: productFields.sourceUnitPriceFieldId,
  });
  const orderLines = row.__order_lines || [row];
  if (orderLines.length > 1) {
    marginResult = computeOrderEconomics(row, orderLines, productCache, productFields, commissionRate);
  }
  const ownedQty = productData ? readProductNumber(productData, productFields.ownedQtyFieldId) : null;
  const qtyAvailable = productData ? readProductNumber(productData, productFields.qtyAvailableFieldId) : null;
  const stockResult = computeStockStatus(ownedQty, qtyAvailable, quantity);
  const badges = assessRiskBadges(row, productData, marginResult, stockResult);

  if (feeCustomerKeys.size > 0) {
    const rowKey = getCustomerKey(row);
    if (rowKey && feeCustomerKeys.has(rowKey)) {
      badges.push({ type: "has_fee_orders", label: "Fee Order", severity: "fee" });
    }
  }

  const rowOrderStatus = readSelectValue(row.order_status);
  const rowReviewStatus = readSelectValue(row.review_status);

  return {
    id: row.id,
    order_id: text(row.order_id),
    product_name: text(row.product_name),
    original_product_id: text(row.original_product_id),
    platform_sku: platformSkuForRow(row),
    B2BItemCode: itemCode,
    quantity,
    product_price: parseFloat(row.product_price) || 0,
    shipping_price: parseFloat(row.shipping_price) || 0,
    order_status: rowOrderStatus,
    shop_id: text(row.shop_id),
    review_status: rowReviewStatus,
    pipeline_state: getPipelineState(rowOrderStatus, rowReviewStatus),
    purchase_date: toJstIso(text(row.purchase_date)),
    purchase_date_jst: formatJstDateTime(text(row.purchase_date)),
    buyer_name: text(row.buyer_name),
    is_fee_row: false,
    has_buyer_messages: row.has_buyer_messages === true || row.has_buyer_messages === "true" || row.has_buyer_messages === 1 || row.has_buyer_messages === "1",
    latest_buyer_message_id: text(row.latest_buyer_message_id),
    latest_buyer_message_at: text(row.latest_buyer_message_at),
    message_last_synced_at: text(row.message_last_synced_at),
    message_last_checked_at: "",
    message_check_status: "",
    message_check_error: null,
    margin: marginResult,
    stock: stockResult,
    risk_badges: badges,
    commission_rate: commissionRate,
  };
}

export function portalOrderGroupKey(row) {
  const channel = text(row?.sales_channel).toLowerCase();
  const store = text(row?.source_store_id || row?.shop_id).toLowerCase();
  const orderId = text(row?.order_id).normalize("NFKC").trim().toLowerCase();
  return `${channel}\u0000${store}\u0000${orderId}`;
}

export function groupPortalOrderRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = portalOrderGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((lines) => {
    const anchor = lines.find((line) => text(line.line_origin) !== "operator_component") || lines[0];
    return { ...anchor, __order_lines: lines };
  });
}

export function buildDegradedPortalRow(row) {
  return {
    id: row.id,
    order_id: text(row.order_id),
    product_name: text(row.product_name),
    original_product_id: text(row.original_product_id),
    platform_sku: platformSkuForRow(row),
    B2BItemCode: text(row.B2BItemCode),
    quantity: parseInteger(row.quantity, 0),
    product_price: parseFloat(row.product_price) || 0,
    shipping_price: parseFloat(row.shipping_price) || 0,
    order_status: readSelectValue(row.order_status),
    shop_id: text(row.shop_id),
    review_status: readSelectValue(row.review_status),
    pipeline_state: getPipelineState(readSelectValue(row.order_status), readSelectValue(row.review_status)),
    purchase_date: toJstIso(text(row.purchase_date)),
    purchase_date_jst: formatJstDateTime(text(row.purchase_date)),
    buyer_name: text(row.buyer_name),
    is_fee_row: false,
    has_buyer_messages: false,
    latest_buyer_message_id: "",
    latest_buyer_message_at: "",
    message_last_synced_at: "",
    message_last_checked_at: "",
    message_check_status: "",
    message_check_error: null,
    margin: { revenue: null, shipping: null, commission: null, tcogs: null, profit: null, marginPercent: null, hasTcogs: false, tcogsSource: "product_field_error" },
    stock: { status: "unknown", label: "Product Field Error", ownedQty: null, qtyAvailable: null },
    risk_badges: [{ type: "product_field_error", label: "Product Field Error", severity: "warning" }],
    has_unread: false,
    unread_classification: "unknown",
  };
}

export function platformSkuForRow(row) {
  const isRakuten = text(row?.sales_channel).toLowerCase() === "rakuten"
    || text(row?.shop_id).toLowerCase() === "rakuten";
  return isRakuten ? text(row?.manage_number) : text(row?.original_product_id);
}

export async function resolveRakutenRowsB2BItemCodes(rows, supabase) {
  const rakutenRows = (rows || []).filter(
    (row) => !text(row.B2BItemCode)
      && platformSkuForRow(row) === text(row.manage_number)
      && text(row.manage_number),
  );
  if (rakutenRows.length === 0) return [];

  const contexts = rakutenRows.map((row) => ({
    manageNumber: text(row.manage_number),
    productName: text(row.product_name),
  }));
  const resolvedByContext = await createRakutenItemCodeBatchResolver({ supabase })(contexts);
  const resolvedCodes = new Set();
  for (const row of rakutenRows) {
    const key = rakutenItemCodeResolutionKey(row.manage_number, row.product_name);
    const resolved = resolvedByContext.get(key);
    if (resolved?.resolved && resolved.code) {
      row.B2BItemCode = resolved.code;
      resolvedCodes.add(resolved.code);
    }
  }
  return [...resolvedCodes];
}

function buildPortalOrderResponse({ rawTotalCount, results, hasMoreSalesRows, offset, limit, canPrePaginate, appliedFilters }) {
  const result = {
    ok: true,
    count: results.length,
    total: rawTotalCount,
    offset,
    limit,
    has_more: canPrePaginate ? (offset + limit) < rawTotalCount : hasMoreSalesRows,
    applied_filters: appliedFilters,
    results,
  };
  if (hasMoreSalesRows) {
    result.note = `Showing first ${PORTAL_MAX_SALES_ROWS} matching orders — narrow your filters if the target order is missing.`;
  }
  return result;
}
