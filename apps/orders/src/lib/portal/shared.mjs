import { FIELD, OPTION } from "../db.mjs";

export const PORTAL_PRODUCTS_TABLE_ID = 886994;
export const PORTAL_PAGE_SIZE = 50;
export const PORTAL_MAX_SALES_ROWS = 100;
export const PORTAL_MAX_FEE_ROWS = 50;
export const PORTAL_FEE_PATTERNS = ["各種手数料", "追加支払い・追加送料専用"];

export { readSelectValue, isActivePipelineState, isTerminalPipelineState } from "../order-state.mjs";

/**
 * Searchable sales-order columns for server-side search.
 * The Baserow adapter translates these column names back to field IDs.
 */
export const PORTAL_SERVER_SEARCH_FIELD_IDS = Object.freeze([
  FIELD.SALES.ORDER_ID,
  FIELD.SALES.PRODUCT_NAME,
  FIELD.SALES.B2B_ITEM_CODE,
  FIELD.SALES.ORIGINAL_PRODUCT_ID,
]);

// ============================================================================
// Lifecycle filter constants
// ============================================================================

export const LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  WAITING_FOR_PAYMENT: "waiting_for_payment",
  WAITING_FOR_SHIPPING: "waiting_for_shipping",
  COMPLETED: "completed",
  CANCELED: "canceled",
  ALL: "all",
});

export const LIFECYCLE_VALUES = Object.freeze(Object.values(LIFECYCLE));

// Map lifecycle → Baserow order_status option IDs for server-side filtering.
// Active and All are special-cased and not in this map.
export const LIFECYCLE_ORDER_STATUS_MAP = Object.freeze({
  [LIFECYCLE.WAITING_FOR_PAYMENT]: { [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT },
  [LIFECYCLE.WAITING_FOR_SHIPPING]: { [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING },
  [LIFECYCLE.COMPLETED]: { [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.COMPLETED },
  [LIFECYCLE.CANCELED]: { [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.CANCELED },
});

// Active lifecycle includes known nonterminal source statuses.
// Using order_status option IDs for WAITING_FOR_PAYMENT (5982566) and
// WAITING_FOR_SHIPPING (5982565) as server-side inclusion filters.
export const ACTIVE_ORDER_STATUS_OPTION_IDS = Object.freeze(["5982566", "5982565"]);

// ============================================================================
// Review filter constants
// ============================================================================

export const REVIEW_FILTER = Object.freeze({
  ANY: "any",
  PENDING_REVIEW: "pending_review",
  AUTO_APPROVED: "auto_approved",
  APPROVED: "approved",
  ON_HOLD: "on_hold",
  CANCELED: "canceled",
});

export const REVIEW_FILTER_VALUES = Object.freeze(Object.values(REVIEW_FILTER));

// Map review filter value → Baserow single_select_equal option ID.
// `any` is special-cased and not in this map.
export const REVIEW_FILTER_OPTION_MAP = Object.freeze({
  [REVIEW_FILTER.PENDING_REVIEW]: { [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]: OPTION.REVIEW_STATUS.PENDING_REVIEW },
  [REVIEW_FILTER.AUTO_APPROVED]: { [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]: OPTION.REVIEW_STATUS.AUTO_APPROVED },
  [REVIEW_FILTER.APPROVED]: { [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]: OPTION.REVIEW_STATUS.APPROVED },
  [REVIEW_FILTER.ON_HOLD]: { [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]: OPTION.REVIEW_STATUS.ON_HOLD },
  [REVIEW_FILTER.CANCELED]: { [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]: OPTION.REVIEW_STATUS.CANCELED },
});

// ============================================================================
// Attention filter constants
// ============================================================================

export const ATTENTION_FILTER = Object.freeze({
  ANY: "any",
  UNREAD: "unread",
  MESSAGE_CHECK_PENDING: "message_check_pending",
  LOW_MARGIN: "low_margin",
  PRICE_CONFIRMATION_NEEDED: "price_confirmation_needed",
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info",
  NONE: "none",
});

export const ATTENTION_FILTER_VALUES = Object.freeze(Object.values(ATTENTION_FILTER));

// ============================================================================
// Legacy query translation
// ============================================================================

/**
 * Map of legacy review_status values to the new filter parameters.
 * Used for backward compatibility during migration.
 */
export const LEGACY_REVIEW_STATUS_MAP = Object.freeze({
  "Active": { lifecycle: LIFECYCLE.ACTIVE, review: REVIEW_FILTER.ANY },
  "all": { lifecycle: LIFECYCLE.ALL, review: REVIEW_FILTER.ANY },
  "Unread": { lifecycle: null, review: null, attention: ATTENTION_FILTER.UNREAD },
  "Pending Review": { review: REVIEW_FILTER.PENDING_REVIEW },
  "Auto-Approved": { review: REVIEW_FILTER.AUTO_APPROVED },
  "Approved": { review: REVIEW_FILTER.APPROVED },
  "On Hold": { review: REVIEW_FILTER.ON_HOLD },
  "Canceled": { review: REVIEW_FILTER.CANCELED },
  "Waiting for Payment": { lifecycle: LIFECYCLE.WAITING_FOR_PAYMENT },
});

// ============================================================================
// Query parsing and validation
// ============================================================================

/**
 * Parse and validate a lifecycle query parameter.
 * Returns the canonical value or a default.
 * Throws on unknown enum values.
 */
export function parseLifecycle(raw) {
  if (!raw) return LIFECYCLE.ACTIVE;
  const normalized = String(raw).trim().toLowerCase();
  if (LIFECYCLE_VALUES.includes(normalized)) return normalized;
  throw new Error(`invalid_lifecycle:${raw}`);
}

/**
 * Parse and validate a review query parameter.
 * Returns the canonical value or a default.
 * Throws on unknown enum values.
 */
export function parseReviewFilter(raw) {
  if (!raw) return REVIEW_FILTER.ANY;
  const normalized = String(raw).trim().toLowerCase();
  if (REVIEW_FILTER_VALUES.includes(normalized)) return normalized;
  throw new Error(`invalid_review:${raw}`);
}

/**
 * Parse and validate an attention query parameter.
 * Returns the canonical value or a default.
 * Throws on unknown enum values.
 */
export function parseAttentionFilter(raw) {
  if (!raw) return ATTENTION_FILTER.ANY;
  const normalized = String(raw).trim().toLowerCase();
  if (ATTENTION_FILTER_VALUES.includes(normalized)) return normalized;
  throw new Error(`invalid_attention:${raw}`);
}

/**
 * Translate legacy review_status query parameters to the new contract.
 * Used for backward compatibility during migration.
 */
export function translateLegacyParams(searchParams) {
  const legacyReview = searchParams.get("review_status");
  if (!legacyReview) return;

  const mapping = LEGACY_REVIEW_STATUS_MAP[legacyReview];
  if (!mapping) return;

  // Only apply legacy mapping when the new params are not already set
  if (!searchParams.has("lifecycle") && mapping.lifecycle) {
    searchParams.set("lifecycle", mapping.lifecycle);
  }
  if (!searchParams.has("review") && mapping.review) {
    searchParams.set("review", mapping.review);
  }
  if (!searchParams.has("attention") && mapping.attention) {
    searchParams.set("attention", mapping.attention);
  }
}

/**
 * Build normalized searchable-field IDs for server-side queries.
 * Includes all four searchable fields: order_id, product_name, B2BItemCode,
 * and original_product_id.
 */
export function buildServerSearchFilterSets(baseFilters, searchQuery, fieldIds) {
  const normalized = text(searchQuery);
  if (!normalized) return [{ ...baseFilters }];
  return fieldIds.map((fieldId) => ({
    ...baseFilters,
    [`filter__field_${fieldId}__contains`]: normalized,
  }));
}

/**
 * Merge multiple arrays of rows by their Baserow row `id`, preserving
 * the first occurrence of each row.
 */
export function mergeRowsById(rowArrays) {
  const rowsById = new Map();
  for (const rows of rowArrays) {
    for (const row of rows) {
      if (!rowsById.has(row.id)) rowsById.set(row.id, row);
    }
  }
  return [...rowsById.values()];
}

/**
 * Build lifecycle server-side filters for Baserow queries.
 * Returns an array of filter objects (to support OR queries, e.g. for Active).
 * When channel is "rakuten", uses Rakuten-specific order status values.
 */
export function buildLifecycleFilters(lifecycle, channel = "mercari") {
  if (lifecycle === LIFECYCLE.ALL) return [{}];

  if (channel === "all") {
    // Union of Mercari + Rakuten lifecycle branches.
    const mercari = buildLifecycleFilters(lifecycle, "mercari");
    const rakuten = buildLifecycleFilters(lifecycle, "rakuten");
    return [...mercari, ...rakuten];
  }

  if (channel === "rakuten") {
    if (lifecycle === LIFECYCLE.ACTIVE) {
      // Active includes all non-terminal Rakuten statuses
      return [
        {
          [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION,
        },
        {
          [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.RAKUTEN_ORDER_STATUS.CONFIRMED,
        },
        {
          [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED,
        },
      ];
    }
    if (lifecycle === LIFECYCLE.CANCELED) {
      return [{
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.RAKUTEN_ORDER_STATUS.CANCELED,
      }];
    }
    if (lifecycle === LIFECYCLE.COMPLETED) {
      return [{
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.COMPLETED,
      }];
    }
    // waiting_for_payment and waiting_for_shipping don't apply to Rakuten — return no results
    return [];
  }

  if (lifecycle === LIFECYCLE.ACTIVE) {
    // Active includes both WAITING_FOR_PAYMENT and WAITING_FOR_SHIPPING
    // These are OR'd via separate queries (Baserow doesn't support OR natively)
    return [
      {
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT,
      },
      {
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
      },
    ];
  }

  const directFilter = LIFECYCLE_ORDER_STATUS_MAP[lifecycle];
  if (directFilter) return [directFilter];

  return [{}];
}

/**
 * Build review server-side filters for Baserow queries.
 */
export function buildReviewFilters(review) {
  if (review === REVIEW_FILTER.ANY) return {};
  const directFilter = REVIEW_FILTER_OPTION_MAP[review];
  return directFilter ? { ...directFilter } : {};
}

/**
 * Validate all portal query parameters and return normalized values.
 * Throws HTTP 400 on unknown enum values.
 */
export function validatePortalParams(searchParams) {
  translateLegacyParams(searchParams);

  const lifecycle = parseLifecycle(searchParams.get("lifecycle"));
  const review = parseReviewFilter(searchParams.get("review"));
  const attention = parseAttentionFilter(searchParams.get("attention"));
  const channel = text(searchParams.get("channel") || "all").toLowerCase();
  const shop = text(searchParams.get("shop") || "");

  const VALID_CHANNELS = ["all", "mercari", "rakuten"];
  if (!VALID_CHANNELS.includes(channel)) {
    throw new Error(`invalid_channel:${searchParams.get("channel")}`);
  }
  if (shop && !["Shop1", "Shop2", "Shop3", "Shop4"].includes(shop) && shop !== "Rakuten") {
    throw new Error(`invalid_shop:${shop}`);
  }

  return { lifecycle, review, attention, channel, shop };
}

export function text(value) {
  return String(value == null ? "" : value).trim();
}

export function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isFeeRow(productName) {
  const normalized = text(productName);
  for (const pattern of PORTAL_FEE_PATTERNS) {
    if (normalized.includes(pattern)) return true;
    if (normalized === pattern) return true;
  }
  return false;
}

export const LINE_ORIGIN_OPERATOR_COMPONENT = "operator_component";

/**
 * Whether a sales row is an operator-added fulfillment component line.
 * Component lines render under their anchor order and must never be counted as
 * independent marketplace units/sales in list, summary, or metrics.
 */
export function isComponentRow(row) {
  return text(row && row.line_origin) === LINE_ORIGIN_OPERATOR_COMPONENT;
}

export function getCustomerKey(row) {
  const phone = String(row && row.shipping_phone_number || "").trim();
  const shop = String(row && row.shop_id || "").trim();
  if (phone && shop) return `phone:${phone}:${shop}`;
  const name = String(row && row.shipping_name || "").trim();
  const postal = String(row && row.shipping_postal_code || "").trim();
  if (name && postal && shop) return `name:${name}:${postal}:${shop}`;
  return null;
}

export function buildPortalListCacheKey(kind, searchParams) {
  const normalized = {};
  const keys = [...new Set([...searchParams.keys(), "kind"])].sort();
  for (const key of keys) {
    if (key === "kind") {
      normalized.kind = kind;
      continue;
    }
    normalized[key] = text(searchParams.get(key) || "");
  }
  return `${kind}:${JSON.stringify(normalized)}`;
}

export function applyPortalOrderSearch(rows, searchQuery) {
  const normalized = text(searchQuery).toLowerCase();
  if (!normalized) return rows;
  return rows.filter((row) =>
    text(row.order_id).toLowerCase().includes(normalized) ||
    text(row.product_name).toLowerCase().includes(normalized) ||
    text(row.B2BItemCode).toLowerCase().includes(normalized) ||
    text(row.original_product_id).toLowerCase().includes(normalized)
  );
}

export function shouldPaginateBeforeEnrichment({ riskFilter, unreadFilter, sort }) {
  return !text(riskFilter) && !text(unreadFilter) && sort !== "margin" && sort !== "margin_amount" && sort !== "margin_pct" && sort !== "risk";
}

export function comparePortalRows(a, b, sort, order) {
  let aVal;
  let bVal;

  if (sort === "quantity") {
    aVal = parseInteger(a.quantity, 0);
    bVal = parseInteger(b.quantity, 0);
    return order === "asc" ? aVal - bVal : bVal - aVal;
  }

  aVal = String(a[sort] || "");
  bVal = String(b[sort] || "");
  const cmp = aVal.localeCompare(bVal, "en");
  return order === "asc" ? cmp : -cmp;
}
