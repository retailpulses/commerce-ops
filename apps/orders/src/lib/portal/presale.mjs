// ── Presale Dashboard ──────────────────────────────────────────────────
//
// Portal API handlers for the Presale tab. Detects presale (予約販売)
// orders via server-side filter on product_name containing "再入荷予定",
// then applies the full regex /「MM/DD再入荷予定」/ client-side to
// extract the restock date and validate the pattern. Results are grouped
// by B2BItemCode and enriched with product stock data and restock memos.
//
// Exports:
//   handlePortalPresale(env, searchParams)
//   handlePresaleMemo(env, itemCode, body)
//   PRESALE_PATTERN  — RegExp for reuse in tests
// ──────────────────────────────────────────────────────────────────────

import { createBaserowClient, listRowsWithLimit, FIELD, OPTION } from "../db.mjs";
import { createBaserowClient as createProductClient, patchRow as patchProductRow } from "../baserow.mjs";
import { getPortalProductFields, invalidatePortalListCache } from "./cache.mjs";
import { batchResolveProducts, findProductByItemCode, readProductField, readProductNumber } from "../product-resolver.mjs";
import { readSelectValue } from "../order-state.mjs";
import { text, PORTAL_PRODUCTS_TABLE_ID } from "./shared.mjs";

/** Max sales rows to load (after server-side pre-filter on product_name). */
const PRESALE_MAX_ROWS = 500;

/**
 * Regex matching the presale restock-date prefix in product names.
 *
 * Matches Japanese date format 「M月D日再入荷予定」.
 * Captures:
 *   [1] — month (1-2 digits)
 *   [2] — day   (1-2 digits)
 *
 * Examples:
 *   「5月3日再入荷予定」アクセサリーケース  →  month=5, day=3
 *   「6月25日再入荷予定」ロッカー          →  month=6, day=25
 */
export const PRESALE_PATTERN = /「(\d{1,2})月(\d{1,2})日再入荷予定」/;

/**
 * Parse a product_name for the presale restock-date prefix.
 * Returns { restockDate: "MM/DD" } or null if no match.
 *
 * @param {string} productName
 * @returns {{ restockDate: string } | null}
 */
function parsePresale(productName) {
  const m = PRESALE_PATTERN.exec(text(productName));
  if (!m) return null;
  const month = m[1].padStart(2, "0");
  const day = m[2].padStart(2, "0");
  return { restockDate: `${month}/${day}` };
}

/**
 * Compare two presale groups for sorting: soonest restock date first,
 * then by order count descending.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function comparePresaleGroups(a, b) {
  // Sort by restock_date ascending (soonest first)
  const dateA = a.restock_date || "99/99";
  const dateB = b.restock_date || "99/99";
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  // Then by order_count descending
  return (b.order_count || 0) - (a.order_count || 0);
}

// ── GET /api/portal/presale ───────────────────────────────────────────

/**
 * Load active sales rows, filter for presale pattern in product_name,
 * group by B2BItemCode, and enrich with product stock + restock info.
 *
 * @param {Object} env - Worker env
 * @param {URLSearchParams} _searchParams - Reserved for future filters
 * @returns {Promise<{ok: boolean, count?: number, results?: Array}>}
 */
export async function handlePortalPresale(env, _searchParams) {
  const baserow = createBaserowClient(env);

  // 1. Load product field metadata (cached, includes restockInfoFieldId)
  let productFields = null;
  try {
    productFields = await getPortalProductFields(env, PORTAL_PRODUCTS_TABLE_ID);
  } catch (_err) {
    // If product table is unavailable, degrade — presale data without enrichment
  }

  // 2. Load active sales rows with server-side pre-filter on product_name.
  //    The "再入荷予定" substring is a reliable indicator — the regex is still
  //    applied client-side to extract the MM/DD restock date and validate the
  //    full 「MM/DD再入荷予定」 pattern.
  let salesRows;
  try {
    salesRows = await listRowsWithLimit(
      baserow,
      baserow.salesOrderTableId,
      {
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_not_equal`]: [
          OPTION.ORDER_STATUS.COMPLETED,
          OPTION.ORDER_STATUS.CANCELED,
        ],
        [`filter__field_${FIELD.SALES.PRODUCT_NAME}__contains`]: "再入荷予定",
      },
      PRESALE_MAX_ROWS,
    );
  } catch (error) {
    return { ok: false, error: `sales_load_failed:${error.message}` };
  }

  // 3. Client-side filter: keep only rows with the presale pattern in product_name.
  //    Extract restock_date from the match.
  const presaleRows = [];
  const nonMatchSamples = []; // debug: collect product names that pass server filter but not regex
  for (const row of salesRows) {
    const pn = text(row.product_name);
    const parsed = parsePresale(pn);
    if (parsed) {
      presaleRows.push({
        row,
        restock_date: parsed.restockDate,
      });
    } else if (nonMatchSamples.length < 10) {
      nonMatchSamples.push(pn.substring(0, 80));
    }
  }

  // Fast path: no presale orders — include debug info
  if (!presaleRows.length) {
    return {
      ok: true,
      count: 0,
      results: [],
      _debug: {
        total_loaded: salesRows.length,
        server_filter: "product_name__contains=再入荷予定 AND order_status NOT IN (COMPLETED,CANCELED)",
        regex: PRESALE_PATTERN.source,
        non_match_samples: nonMatchSamples,
      },
    };
  }

  // 4. Group by B2BItemCode
  const groups = new Map(); // key → { B2BItemCode, rows, order_ids, total_quantity, ... }
  for (const { row, restock_date } of presaleRows) {
    const code = text(row.B2BItemCode) || "__unassigned__";
    let group = groups.get(code);
    if (!group) {
      group = {
        B2BItemCode: code === "__unassigned__" ? "" : code,
        product_name: text(row.product_name),
        restock_date,
        order_count: 0,
        total_quantity: 0,
        earliest_order_date: null,
        waiting_for_payment: 0,
        waiting_for_shipping: 0,
        order_ids: [],
      };
      groups.set(code, group);
    }
    group.order_count += 1;
    group.total_quantity += Number(row.quantity) || 0;
    group.order_ids.push(text(row.order_id));

    // Track earliest order date
    const purchaseDate = text(row.purchase_date);
    if (purchaseDate && (!group.earliest_order_date || purchaseDate < group.earliest_order_date)) {
      group.earliest_order_date = purchaseDate;
    }

    // Status breakdown
    const status = readSelectValue(row.order_status);
    if (status === "WAITING_FOR_PAYMENT") {
      group.waiting_for_payment += 1;
    } else {
      // All other active statuses (should be WAITING_FOR_SHIPPING)
      group.waiting_for_shipping += 1;
    }

    // Keep the earliest restock_date for this group
    if (restock_date < group.restock_date) {
      group.restock_date = restock_date;
    }
  }

  // 5. Load product snapshot map for stock + restock info enrichment
  /** @type {Map<string, object>} */
  let productMap = new Map();
  if (productFields && productFields.itemCodeFieldId) {
    try {
      productMap = await batchResolveProducts(
        env,
        PORTAL_PRODUCTS_TABLE_ID,
        productFields.itemCodeFieldId,
        [...groups.keys()].filter((code) => code !== "__unassigned__"),
      );
    } catch (_err) {
      // Degrade: no stock enrichment
    }
  }

  // 6. Build result array, merging product data
  const results = [];
  for (const [code, group] of groups) {
    const productRow = code !== "__unassigned__" ? productMap.get(code) : null;

    let ownedQty = null;
    let qtyAvailable = null;
    let restockInfo = "";

    if (productRow && productFields) {
      if (productFields.ownedQtyFieldId) {
        ownedQty = readProductNumber(productRow, productFields.ownedQtyFieldId);
      }
      if (productFields.qtyAvailableFieldId) {
        qtyAvailable = readProductNumber(productRow, productFields.qtyAvailableFieldId);
      }
      if (productFields.restockInfoFieldId) {
        restockInfo = readProductField(productRow, productFields.restockInfoFieldId);
      }
    }

    results.push({
      B2BItemCode: group.B2BItemCode,
      product_name: group.product_name,
      restock_date: group.restock_date,
      order_count: group.order_count,
      total_quantity: group.total_quantity,
      earliest_order_date: group.earliest_order_date,
      status_breakdown: {
        WAITING_FOR_PAYMENT: group.waiting_for_payment,
        WAITING_FOR_SHIPPING: group.waiting_for_shipping,
      },
      owned_qty: ownedQty,
      qty_available: qtyAvailable,
      restock_info: restockInfo,
      order_ids: group.order_ids,
    });
  }

  // 7. Sort: soonest restock date first, then by order count descending
  results.sort(comparePresaleGroups);

  return {
    ok: true,
    count: results.length,
    results,
    _debug: {
      total_loaded: salesRows.length,
      presale_matched: presaleRows.length,
      unique_b2b_codes: results.length,
      server_filter: "product_name__contains=再入荷予定 AND order_status NOT IN (COMPLETED,CANCELED)",
      regex: PRESALE_PATTERN.source,
    },
  };
}

// ── PATCH /api/portal/presale/:itemCode/memo ──────────────────────────

/**
 * Append a timestamped restock memo entry to the product's "Restock Info"
 * field on the Products table.
 *
 * @param {Object} env - Worker env
 * @param {string} itemCode - B2BItemCode identifying the product
 * @param {{ text?: string }} body - Request body with memo text
 * @returns {Promise<{ok: boolean, restock_info?: string, error?: string, statusCode?: number}>}
 */
export async function handlePresaleMemo(env, itemCode, body) {
  const memoText = text(body.text || "");

  if (!memoText) {
    return { ok: false, error: "memo_text_required", statusCode: 400 };
  }

  const decodedItemCode = decodeURIComponent(itemCode);
  if (!decodedItemCode) {
    return { ok: false, error: "item_code_required", statusCode: 400 };
  }

  // Get product field metadata to find the Restock Info field ID
  let productFields;
  try {
    productFields = await getPortalProductFields(env, PORTAL_PRODUCTS_TABLE_ID);
  } catch (_err) {
    return { ok: false, error: "product_fields_unavailable", statusCode: 500 };
  }

  if (!productFields.itemCodeFieldId) {
    return { ok: false, error: "product_item_code_field_not_found", statusCode: 500 };
  }
  if (!productFields.restockInfoFieldId) {
    return {
      ok: false,
      error: "restock_info_field_not_found",
      message: "Add a 'Restock Info' long-text field to the Products table (886994) in Baserow.",
      statusCode: 500,
    };
  }

  // Find the product row by B2BItemCode
  const productRow = await findProductByItemCode(
    env,
    PORTAL_PRODUCTS_TABLE_ID,
    productFields.itemCodeFieldId,
    decodedItemCode,
  );

  if (!productRow) {
    return { ok: false, error: "product_not_found", statusCode: 404 };
  }

  // Read current Restock Info value
  const existingLog = readProductField(productRow, productFields.restockInfoFieldId);
  const now = new Date().toISOString();
  const operatorName = "operator";
  const newEntry = `[${now}] ${operatorName}: ${memoText}`;
  const updatedLog = existingLog ? `${newEntry}\n\n${existingLog}` : newEntry;

  // PATCH the product row using the display field name
  const productClient = createProductClient(env);
  const patchResult = await patchProductRow(productClient, PORTAL_PRODUCTS_TABLE_ID, productRow.id, {
    [productFields.restockInfoFieldName]: updatedLog,
  });

  if (!patchResult.ok) {
    return { ok: false, error: `patch_failed:${patchResult.error}`, statusCode: patchResult.status };
  }

  // Invalidate portal list cache so the presale dashboard reloads fresh data
  invalidatePortalListCache();

  return {
    ok: true,
    item_code: decodedItemCode,
    restock_info: updatedLog,
  };
}
