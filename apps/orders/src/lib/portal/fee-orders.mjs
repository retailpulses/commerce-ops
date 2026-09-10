import { createBaserowClient, listRowsWithLimit, FIELD, OPTION } from "../db.mjs";
import { MERCARI_CHANNEL } from "../channel-config.mjs";
import { getPipelineState } from "../order-state.mjs";
import { formatJstDateTime, toJstIso } from "../timezone.mjs";
import {
  PORTAL_FEE_PATTERNS,
  PORTAL_MAX_FEE_ROWS,
  PORTAL_PAGE_SIZE,
  LIFECYCLE,
  REVIEW_FILTER,
  buildLifecycleFilters,
  buildPortalListCacheKey,
  buildReviewFilters,
  getCustomerKey,
  isFeeRow,
  parseInteger,
  readSelectValue,
  text,
  translateLegacyParams,
  parseLifecycle,
  parseReviewFilter,
} from "./shared.mjs";
import { getCachedPortalList, setCachedPortalList } from "./cache.mjs";

export async function handlePortalFeeOrderList(env, searchParams) {
  const cacheKey = buildPortalListCacheKey("fee_orders", searchParams);
  const cached = getCachedPortalList(cacheKey);
  if (cached) return cached;

  const baserow = createBaserowClient(env);

  // Parse lifecycle and review using shared helpers (with legacy translation)
  translateLegacyParams(searchParams);

  let lifecycle, review;
  try {
    lifecycle = parseLifecycle(searchParams.get("lifecycle"));
    review = parseReviewFilter(searchParams.get("review"));
  } catch (error) {
    return { ok: false, error: error.message, statusCode: 400 };
  }

  // Fee Orders use a relaxed lifecycle: default "fee_active" excludes only CANCELED.
  // This preserves completed fee rows (operationally useful for historical matching).
  const feeLifecycleFilters = [];
  if (lifecycle === LIFECYCLE.ALL) {
    feeLifecycleFilters.push({});
  } else if (lifecycle === LIFECYCLE.ACTIVE) {
    // Fee Active: only exclude CANCELED. Completed fee rows remain visible.
    feeLifecycleFilters.push({
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_not_equal`]: OPTION.ORDER_STATUS.CANCELED,
    });
  } else {
    // Apply standard lifecycle filters for direct status matches
    feeLifecycleFilters.push(...buildLifecycleFilters(lifecycle));
  }

  const reviewFilters = buildReviewFilters(review);

  const shopFilter = {};
  const shopFilterValue = text(searchParams.get("shop") || "");
  if (shopFilterValue && MERCARI_CHANNEL.shopIds[shopFilterValue]) {
    shopFilter[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = MERCARI_CHANNEL.shopIds[shopFilterValue];
  }

  const feeRowMap = new Map();
  for (const pattern of PORTAL_FEE_PATTERNS) {
    // Combine lifecycle, review, and shop filters for each fee pattern
    const combinedFilters = { ...reviewFilters, ...shopFilter };
    combinedFilters[`filter__field_${FIELD.SALES.PRODUCT_NAME}__contains`] = pattern;

    // Apply all lifecycle filter branches
    const allPatternRows = [];
    for (const feeLifecycle of feeLifecycleFilters) {
      const filters = { ...feeLifecycle, ...combinedFilters };
      let patternRows;
      try {
        patternRows = await listRowsWithLimit(baserow, baserow.salesOrderTableId, filters, PORTAL_MAX_FEE_ROWS);
      } catch (error) {
        console.warn("portal_fee_pattern_fetch_failed:", pattern, error.message);
        continue;
      }
      allPatternRows.push(...patternRows);
    }
    for (const row of allPatternRows) {
      if (!feeRowMap.has(row.id)) feeRowMap.set(row.id, row);
    }
  }
  const feeRows = [...feeRowMap.values()];

  const mainOrderMap = new Map();
  const phoneLookups = new Map();
  const namePostalLookups = new Map();

  for (const row of feeRows) {
    const key = getCustomerKey(row);
    if (!key || mainOrderMap.has(key)) continue;

    if (key.startsWith("phone:")) {
      const phone = String(row.shipping_phone_number || "").trim();
      const shop = String(row.shop_id || "").trim();
      const lookupKey = `phone:${phone}:${shop}`;
      if (!phoneLookups.has(lookupKey)) phoneLookups.set(lookupKey, []);
      phoneLookups.get(lookupKey).push(key);
    } else {
      const name = String(row.shipping_name || "").trim();
      const postal = String(row.shipping_postal_code || "").trim();
      const shop = String(row.shop_id || "").trim();
      const lookupKey = `name:${name}:${postal}:${shop}`;
      if (!namePostalLookups.has(lookupKey)) namePostalLookups.set(lookupKey, []);
      namePostalLookups.get(lookupKey).push(key);
    }
  }

  for (const [lookupKey, keys] of phoneLookups) {
    const [, phone, shop] = lookupKey.split(":");
    const searchFilters = {
      [`filter__field_${FIELD.SALES.SHIPPING_PHONE_NUMBER}__equal`]: phone,
      [`filter__field_${FIELD.SALES.SHOP_ID}__equal`]: shop,
    };
    let candidates;
    try {
      candidates = await listRowsWithLimit(baserow, baserow.salesOrderTableId, searchFilters, 20);
    } catch (error) {
      console.warn("portal_main_lookup_failed:", lookupKey, error.message);
      continue;
    }
    const productRows = candidates.filter((row) => !isFeeRow(row.product_name));
    if (!productRows.length) continue;
    for (const key of keys) {
      const best = pickBestMainOrder(productRows, key, getCustomerKey);
      if (best) mainOrderMap.set(key, best);
    }
  }

  for (const [lookupKey, keys] of namePostalLookups) {
    const [, name, postal, shop] = lookupKey.split(":");
    const searchFilters = {
      [`filter__field_${FIELD.SALES.SHIPPING_NAME}__equal`]: name,
      [`filter__field_${FIELD.SALES.SHIPPING_POSTAL_CODE}__equal`]: postal,
      [`filter__field_${FIELD.SALES.SHOP_ID}__equal`]: shop,
    };
    let candidates;
    try {
      candidates = await listRowsWithLimit(baserow, baserow.salesOrderTableId, searchFilters, 20);
    } catch (error) {
      console.warn("portal_main_lookup_failed:", lookupKey, error.message);
      continue;
    }
    const productRows = candidates.filter((row) => !isFeeRow(row.product_name));
    if (!productRows.length) continue;
    for (const key of keys) {
      const best = pickBestMainOrder(productRows, key, getCustomerKey);
      if (best) mainOrderMap.set(key, best);
    }
  }

  const pairs = feeRows.map((feeRow) => {
    const key = getCustomerKey(feeRow);
    const main = key ? (mainOrderMap.get(key) || null) : null;
    return {
      fee: {
        id: feeRow.id,
        order_id: text(feeRow.order_id),
        product_name: text(feeRow.product_name),
        order_status: readSelectValue(feeRow.order_status),
        review_status: readSelectValue(feeRow.review_status),
        pipeline_state: getPipelineState(readSelectValue(feeRow.order_status), readSelectValue(feeRow.review_status)),
        purchase_date: toJstIso(text(feeRow.purchase_date)),
        purchase_date_jst: formatJstDateTime(text(feeRow.purchase_date)),
        shop_id: text(feeRow.shop_id),
      },
      main,
      main_shipped: !!(main && main.shipping_completed_at),
      customer_key_type: key ? (key.startsWith("phone:") ? "phone" : "name_postal") : null,
    };
  });

  const searchQuery = text(searchParams.get("search") || "").toLowerCase();
  let filtered = pairs;
  if (searchQuery) {
    filtered = pairs.filter((pair) => {
      const fee = pair.fee;
      if (fee.order_id.toLowerCase().includes(searchQuery)) return true;
      if (fee.product_name.toLowerCase().includes(searchQuery)) return true;
      if (pair.main) {
        if (pair.main.order_id.toLowerCase().includes(searchQuery)) return true;
        if (pair.main.product_name.toLowerCase().includes(searchQuery)) return true;
      }
      return false;
    });
  }

  filtered.sort((a, b) => {
    if (!a.main && b.main) return -1;
    if (a.main && !b.main) return 1;
    if (a.main_shipped !== b.main_shipped) return a.main_shipped ? 1 : -1;
    return (a.fee.purchase_date || "").localeCompare(b.fee.purchase_date || "");
  });

  const limit = Math.min(parseInteger(searchParams.get("limit"), PORTAL_PAGE_SIZE), 200);
  const offset = parseInteger(searchParams.get("offset"), 0);
  const paged = filtered.slice(offset, offset + limit);
  const hasMore = filtered.length >= PORTAL_MAX_FEE_ROWS;

  const result = {
    ok: true,
    count: paged.length,
    total: filtered.length,
    offset,
    limit,
    has_more: hasMore,
    results: paged,
    ...(hasMore ? { note: `Showing first ${PORTAL_MAX_FEE_ROWS} fee orders — narrow your filters if the target order is missing.` } : {}),
  };

  setCachedPortalList(cacheKey, result);
  return result;
}

export function pickBestMainOrder(candidates, targetKey, keyFn) {
  const matching = candidates.filter((row) => keyFn(row) === targetKey);
  if (!matching.length) return null;
  if (matching.length === 1) {
    return formatMainOrderPreview(matching[0]);
  }

  matching.sort((a, b) => {
    const aDate = text(a.purchase_date) || "";
    const bDate = text(b.purchase_date) || "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0);
  });

  return formatMainOrderPreview(matching[0]);
}

function formatMainOrderPreview(row) {
  return {
    order_id: text(row.order_id),
    product_name: text(row.product_name),
    order_status: readSelectValue(row.order_status),
    review_status: readSelectValue(row.review_status),
    shipping_completed_at: text(row.shipping_completed_at),
    purchase_date: toJstIso(text(row.purchase_date)),
    purchase_date_jst: formatJstDateTime(text(row.purchase_date)),
  };
}
