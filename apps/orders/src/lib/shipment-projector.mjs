import { createBaserowClient, createRow, deleteRow, listAllRows, patchRow, FIELD, OPTION } from "./db.mjs";
import { isPipelineApprovedReviewStatus, PIPELINE_APPROVED_OPTION_IDS } from "./review-gate.mjs";
import { getMercariShopName } from "./mercari-shops.mjs";
import { ORDER_STATUS, readSelectValue, statusEquals } from "./order-state.mjs";
import { allocateLineCommercialValues } from "./line-allocation.mjs";
import { batchResolveProducts, readProductNumber, resolveProductFields } from "./product-resolver.mjs";


const SALES_FIELDS = {
  orderId: "order_id",
  purchaseDate: "purchase_date",
  originalProductId: "original_product_id",
  productName: "product_name",
  quantity: "quantity",
  productPrice: "product_price",
  requestedDeliveryDate: "requested_delivery_date",
  requestedDeliveryTime: "requested_delivery_time",
  shippingPostalCode: "shipping_postal_code",
  shippingState: "shipping_state",
  shippingCity: "shipping_city",
  shippingAddress1: "shipping_address_1",
  shippingAddress2: "shipping_address_2",
  shippingName: "shipping_name",
  shippingPhoneNumber: "shipping_phone_number",
  orderStatus: "order_status",
  shopId: "shop_id",
  orderComments: "order_comments",
  reviewStatus: "review_status",
  b2bItemCode: "B2BItemCode",
  shippingMethod: "shipping_method",
};

const SHIPMENT_FIELDS = {
  salesChannel: "SalesChannel",
  shipFrom: "ShipFrom",
  sourceStoreId: "SourceStoreID",
  orderId: "OrderId",
  lineItemNumber: "LineItemNumber",
  b2bItemCode: "B2BItemCode",
  shipToQty: "ShipToQty",
  deliveryToFbaWarehouse: "DeliveryToFBAWarehouse",
  shipToName: "ShipToName",
  shipToEmail: "ShipToEmail",
  shipToPhone: "ShipToPhone",
  shipToPostalCode: "ShipToPostalCode",
  shipToAddressDetail: "ShipToAddressDetail",
  shipToCity: "ShipToCity",
  shipToState: "ShipToState",
  shipToCountry: "ShipToCountry",
  shipToServiceLevel: "ShipToServiceLevel",
  shipToAttachmentUrl: "ShipToAttachmentUrl",
  orderDate: "OrderDate",
  requestedDeliveryDate: "RequestedDeliveryDate",
  buyerBrand: "BuyerBrand",
  buyerPlatformSku: "BuyerPlatformSku",
  buyerSkuDescription: "BuyerSkuDescription",
  buyerSkuCommercialValue: "BuyerSkuCommercialValue",
  buyerSkuLink: "BuyerSkuLink",
  orderComments: "OrderComments",
};

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

// Shipping methods that are fulfilled outside GigaB2B — orders with these
// methods must not be projected into Giga shipment rows.
const GIGA_INELIGIBLE_SHIPPING_METHODS = new Set(["MERCARI_SHIPPING_YAMATO"]);

function isGigaEligibleShippingMethod(value) {
  return !GIGA_INELIGIBLE_SHIPPING_METHODS.has(text(value));
}

export async function projectMercariSalesOrdersToShipment(env, { shops = [], limit = 100, orderIds = [], dryRun = false } = {}, injected = {}) {
  const baserow = injected.client || createBaserowClient(env);
  const listRows = injected.listAllRows || listAllRows;
  const createShipmentRow = injected.createRow || createRow;
  const patchShipmentRow = injected.patchRow || patchRow;
  const deleteShipmentRow = injected.deleteRow || deleteRow;
  const allocateCommercialValues = injected.allocateOrderCommercialValues || allocateOrderCommercialValues;

  // Base filter: WAITING_FOR_SHIPPING + optional single-shop
  const baseFilter = {
    [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
  };
  const effectiveShops = (shops || []).filter((s) => SHOP_IDS[s]);
  if (effectiveShops.length === 1) {
    baseFilter[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = SHOP_IDS[effectiveShops[0]];
  }

  // Two parallel server-side queries (Approved + Auto-Approved) merged,
  // instead of removing the review_status filter and scanning all rows.
  const reviewOptionIds = [...PIPELINE_APPROVED_OPTION_IDS];
  const results = await Promise.all(
    reviewOptionIds.map((optId) =>
      listRows(baserow, baserow.salesOrderTableId, {
        ...baseFilter,
        [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]: optId,
      }),
    ),
  );
  const salesRows = results.flat();

  const selectedShopIds = new Set((shops || []).map((shop) => SHOP_IDS[shop]).filter(Boolean));
  const selectedOrderIds = new Set((orderIds || []).map(normalizeOrderIdCandidate).filter(Boolean));

  const candidateRows = salesRows.filter((row) => {
    // Baserow single_select values are returned as objects like { id, value, color }.
    const orderStatus = readSelectValue(row[SALES_FIELDS.orderStatus]) || text(row[SALES_FIELDS.orderStatus]);
    const shopId = text(row[SALES_FIELDS.shopId]);
    const orderId = normalizeOrderIdCandidate(row[SALES_FIELDS.orderId]);
    if (!statusEquals(orderStatus, ORDER_STATUS.WAITING_FOR_SHIPPING)) return false;
    const reviewStatus = readSelectValue(row[SALES_FIELDS.reviewStatus]);
    if (!isPipelineApprovedReviewStatus(reviewStatus)) return false;
    if (selectedShopIds.size && !selectedShopIds.has(shopId)) return false;
    if (selectedOrderIds.size && !selectedOrderIds.has(orderId)) return false;
    if (!isGigaEligibleShippingMethod(row[SALES_FIELDS.shippingMethod])) return false;
    return true;
  });

  const groupedSourceRows = groupSalesRows(candidateRows);
  const orderGroups = Array.from(groupedSourceRows.values());
  const limitedOrderGroups = Number.isFinite(limit) && limit > 0 ? orderGroups.slice(0, limit) : orderGroups;

  // Re-fetch shipment rows to catch any rows created by a concurrent projector run
  // (e.g., reconciler at minute 11 overlapping with standalone projector at minute 13).
  // Without this, each invocation holds a stale snapshot and both can create rows
  // for the same order+SKU, which the outbound sync then groups into doubled qty.
  let liveShipmentRows = await listRows(baserow, baserow.shipmentOrderTableId);

  const summary = {
    ok: true,
    mode: dryRun ? "dry_run" : "sync",
    side_effects: 0,
    sales_rows_loaded: salesRows.length,
    shipment_rows_loaded: liveShipmentRows.length,
    candidate_source_rows: candidateRows.length,
    grouped_orders: orderGroups.length,
    processed_orders: limitedOrderGroups.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    deduplicated: 0,
    planned_created: 0,
    planned_updated: 0,
    planned_deduplicated: 0,
    results: [],
  };

  for (const group of limitedOrderGroups) {
    const orderedRows = group.rows.slice().sort(compareSalesRows);
    // Allocate the order product price across every fulfillment line
    // proportional to line TCOGS so no line is emitted with a zero
    // commercial value. Fails closed (skips components) when cost data is absent.
    const commercialByRowId = await allocateCommercialValues(env, orderedRows);
    for (let index = 0; index < orderedRows.length; index += 1) {
      const sourceRow = orderedRows[index];
      const productName = text(sourceRow[SALES_FIELDS.productName]);
      if (shouldSkipProductName(productName)) {
        summary.skipped += 1;
        summary.results.push({
          order_id: group.orderId,
          source_row_id: String(sourceRow.id),
          action: "skipped_fee_row",
        });
        continue;
      }

      const lineCommercial = commercialByRowId.get(String(sourceRow.id));
      if (lineCommercial && lineCommercial.skipped) {
        summary.skipped += 1;
        summary.results.push({
          order_id: group.orderId,
          source_row_id: String(sourceRow.id),
          action: "skipped_missing_tcogs_for_allocation",
          sku: text(sourceRow && sourceRow[SALES_FIELDS.originalProductId]),
        });
        continue;
      }

      const lineItemNumber = String(index + 1);
      const payload = buildShipmentPayload(sourceRow, lineItemNumber, lineCommercial ? lineCommercial.unitPrice : undefined);
      if (!payload) {
        summary.skipped += 1;
        summary.results.push({
          order_id: group.orderId,
          source_row_id: String(sourceRow.id),
          action: "skipped_missing_b2b_item_code",
          sku: text(sourceRow && sourceRow[SALES_FIELDS.originalProductId]),
        });
        continue;
      }

      const matches = findMatchingShipmentRows(liveShipmentRows, payload);
      const existing = selectCanonicalShipmentRow(matches, payload);
      const resultItem = {
        order_id: group.orderId,
        source_row_id: String(sourceRow.id),
        sku: payload[SHIPMENT_FIELDS.buyerPlatformSku],
        line_item_number: lineItemNumber,
      };

      try {
        if (matches.length > 1 && existing) {
          const duplicateRows = matches.filter((row) => String(row && row.id ? row.id : "") !== String(existing.id));
          for (const duplicateRow of duplicateRows) {
            if (dryRun) {
              summary.planned_deduplicated += 1;
              summary.results.push({
                ...resultItem,
                action: "would_deduplicate_duplicate_row",
                shipment_row_id: String(duplicateRow.id),
                canonical_shipment_row_id: String(existing.id),
              });
              continue;
            }
            const deleteResult = await deleteShipmentRow(baserow, baserow.shipmentOrderTableId, duplicateRow.id);
            if (!deleteResult.ok) throw new Error(deleteResult.error || `shipment_delete_failed_${deleteResult.status}`);
            removeShipmentRowInPlace(liveShipmentRows, duplicateRow.id);
            summary.deduplicated += 1;
            summary.results.push({
              ...resultItem,
              action: "deduplicated_duplicate_row",
              shipment_row_id: String(duplicateRow.id),
              canonical_shipment_row_id: String(existing.id),
            });
          }
        }

        if (existing && rowsEquivalent(existing, payload)) {
          summary.unchanged += 1;
          summary.results.push({ ...resultItem, action: "unchanged", shipment_row_id: String(existing.id) });
          continue;
        }

        if (existing) {
          if (dryRun) {
            summary.planned_updated += 1;
            summary.results.push({ ...resultItem, action: "would_update", shipment_row_id: String(existing.id) });
            continue;
          }
          const response = await patchShipmentRow(baserow, baserow.shipmentOrderTableId, existing.id, payload);
          if (!response.ok) throw new Error(response.error || `shipment_patch_failed_${response.status}`);
          Object.assign(existing, payload);
          summary.updated += 1;
          summary.results.push({ ...resultItem, action: "updated", shipment_row_id: String(existing.id) });
          continue;
        }

        // Pre-create idempotency guard: re-check liveShipmentRows for a row
        // matching the same (orderId + SKU + sourceStoreId). This catches
        // rows created by a concurrent projector run after our initial snapshot
        // (line 94) was taken. Without this, two overlapping runs would each
        // create a row for the same order+SKU, and the outbound sync would
        // push duplicate orderLines to GigaB2B.
        const concurrentMatch = findExistingByKey(liveShipmentRows, payload);
        if (concurrentMatch) {
          if (dryRun) {
            summary.planned_updated += 1;
            summary.results.push({ ...resultItem, action: "would_update_concurrent", shipment_row_id: String(concurrentMatch.id) });
            continue;
          }
          const response = await patchShipmentRow(baserow, baserow.shipmentOrderTableId, concurrentMatch.id, payload);
          if (!response.ok) throw new Error(response.error || `shipment_patch_failed_${response.status}`);
          Object.assign(concurrentMatch, payload);
          summary.updated += 1;
          summary.results.push({ ...resultItem, action: "updated_concurrent", shipment_row_id: String(concurrentMatch.id) });
          continue;
        }

        if (dryRun) {
          summary.planned_created += 1;
          summary.results.push({ ...resultItem, action: "would_create", shipment_row_id: null });
          continue;
        }
        const response = await createShipmentRow(baserow, baserow.shipmentOrderTableId, payload);
        if (!response.ok) throw new Error(response.error || `shipment_create_failed_${response.status}`);
        const createdRow = { ...(response.body || {}), ...payload };
        liveShipmentRows.push(createdRow);
        summary.created += 1;
        summary.results.push({ ...resultItem, action: "created", shipment_row_id: String(createdRow.id || "") || null });
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          ...resultItem,
          action: "failed",
          error: error && error.message ? error.message : String(error),
        });
      }
    }
  }

  summary.ok = summary.failed === 0;
  summary.side_effects = summary.created + summary.updated + summary.deduplicated;
  return summary;
}

function groupSalesRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const orderId = normalizeOrderIdCandidate(row[SALES_FIELDS.orderId]);
    const storeId = text(row[SALES_FIELDS.shopId]);
    if (!orderId || !storeId) continue;
    const scope = `mercari\u0000${storeId.toLowerCase()}\u0000${orderId.toLowerCase()}`;
    if (!map.has(scope)) map.set(scope, { orderId, storeId, rows: [] });
    map.get(scope).rows.push(row);
  }
  return map;
}

function compareSalesRows(left, right) {
  const leftIsComponent = text(left && left.line_origin) === "operator_component";
  const rightIsComponent = text(right && right.line_origin) === "operator_component";
  // Marketplace (anchor) lines first, then operator_component lines.
  if (leftIsComponent !== rightIsComponent) return leftIsComponent ? 1 : -1;
  if (leftIsComponent) {
    // Components: stable ordering by component_index, then by id (string-safe).
    const leftIndex = parsePositiveInteger(left && left.component_index) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = parsePositiveInteger(right && right.component_index) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return compareIds(left && left.id, right && right.id);
  }
  const leftSku = normalizeSku(left && left[SALES_FIELDS.originalProductId]);
  const rightSku = normalizeSku(right && right[SALES_FIELDS.originalProductId]);
  if (leftSku < rightSku) return -1;
  if (leftSku > rightSku) return 1;
  return compareIds(left && left.id, right && right.id);
}

function buildShipmentPayload(sourceRow, lineItemNumber, commercialValue) {
  const orderId = normalizeOrderIdCandidate(sourceRow && sourceRow[SALES_FIELDS.orderId]);

  // Guardrail: B2BItemCode must be set by ingest or operator before a
  // shipment row is created. Ingest owns item-code resolution; the projector
  // must not resolve on the fly. An empty B2BItemCode means the operator
  // hasn't reviewed this order yet — skip it.
  const preResolved = text(sourceRow && sourceRow[SALES_FIELDS.b2bItemCode]);
  if (!preResolved) return null; // skip — B2BItemCode not yet resolved
  const sku = normalizeSku(preResolved);

  const shopId = text(sourceRow && sourceRow[SALES_FIELDS.shopId]);
  const commercial = commercialValue !== undefined && commercialValue !== null
    ? commercialValue
    : parseDecimalNumber(sourceRow && sourceRow[SALES_FIELDS.productPrice]);
  return {
    // Exact source sales row id — never guessed. UUID-safe (string).
    sales_order_id: sourceRow && sourceRow.id != null ? String(sourceRow.id) : null,
    [SHIPMENT_FIELDS.salesChannel]: "Mercari",
    [SHIPMENT_FIELDS.shipFrom]: getMercariShopName(shopId),
    [SHIPMENT_FIELDS.sourceStoreId]: shopId,
    [SHIPMENT_FIELDS.orderId]: orderId,
    [SHIPMENT_FIELDS.lineItemNumber]: String(lineItemNumber || "1"),
    [SHIPMENT_FIELDS.b2bItemCode]: sku,
    [SHIPMENT_FIELDS.shipToQty]: parsePositiveInteger(sourceRow && sourceRow[SALES_FIELDS.quantity]),
    [SHIPMENT_FIELDS.deliveryToFbaWarehouse]: "No",
    [SHIPMENT_FIELDS.shipToName]: text(sourceRow && sourceRow[SALES_FIELDS.shippingName]),
    [SHIPMENT_FIELDS.shipToEmail]: "",
    [SHIPMENT_FIELDS.shipToPhone]: normalizePhone(sourceRow && sourceRow[SALES_FIELDS.shippingPhoneNumber]),
    [SHIPMENT_FIELDS.shipToPostalCode]: formatPostalCode(sourceRow && sourceRow[SALES_FIELDS.shippingPostalCode]),
    [SHIPMENT_FIELDS.shipToAddressDetail]: joinAddress(text(sourceRow && sourceRow[SALES_FIELDS.shippingAddress1]), text(sourceRow && sourceRow[SALES_FIELDS.shippingAddress2])),
    [SHIPMENT_FIELDS.shipToCity]: text(sourceRow && sourceRow[SALES_FIELDS.shippingCity]),
    [SHIPMENT_FIELDS.shipToState]: text(sourceRow && sourceRow[SALES_FIELDS.shippingState]),
    [SHIPMENT_FIELDS.shipToCountry]: "JP",
    [SHIPMENT_FIELDS.shipToServiceLevel]: "",
    [SHIPMENT_FIELDS.shipToAttachmentUrl]: "",
    [SHIPMENT_FIELDS.orderDate]: parseMercariSalesOrderDateTime(sourceRow && sourceRow[SALES_FIELDS.purchaseDate]),
    [SHIPMENT_FIELDS.requestedDeliveryDate]: buildRequestedDeliveryDateText(
      sourceRow && sourceRow[SALES_FIELDS.requestedDeliveryDate],
      sourceRow && sourceRow[SALES_FIELDS.requestedDeliveryTime],
    ),
    [SHIPMENT_FIELDS.buyerBrand]: "",
    [SHIPMENT_FIELDS.buyerPlatformSku]: sku,
    [SHIPMENT_FIELDS.buyerSkuDescription]: text(sourceRow && sourceRow[SALES_FIELDS.productName]),
    [SHIPMENT_FIELDS.buyerSkuCommercialValue]: commercial,
    [SHIPMENT_FIELDS.buyerSkuLink]: "",
  };
}

let _productFieldsCache = null;

/**
 * Resolve per-component TCOGS (per unit) for component lines. Returns
 * Map<rowId, { tcogsPerUnit: number|null }>. null means cost data unavailable.
 */
async function resolveLineTcogs(env, rows) {
  const productsTableId = parsePositiveInteger(env && env.PORTAL_PRODUCTS_TABLE_ID) || 886994;
  if (!_productFieldsCache) {
    _productFieldsCache = resolveProductFields(env, productsTableId);
  }
  const productFields = await _productFieldsCache;
  const codes = [...new Set(rows.map((r) => text(r && r[SALES_FIELDS.b2bItemCode])).filter(Boolean))];
  const productCache = await batchResolveProducts(env, productsTableId, productFields.itemCodeFieldId, codes);
  const map = new Map();
  for (const row of rows) {
    const code = text(row && row[SALES_FIELDS.b2bItemCode]);
    const productData = code ? productCache.get(code) : null;
    const tcogsPerUnit = productData ? readProductNumber(productData, productFields.effectiveTcogsFieldId) : null;
    map.set(String(row.id), { tcogsPerUnit });
  }
  return map;
}

/**
 * Allocate the anchor's order product price across all fulfillment lines
 * proportionally to line TCOGS. Returns Map<rowId, { unitPrice } | { skipped }>.
 * Fails closed (marks every component skipped) when cost data is unavailable.
 */
async function allocateOrderCommercialValues(env, orderedRows) {
  const map = new Map();
  const fulfillmentRows = orderedRows.filter((r) => !shouldSkipProductName(text(r && r[SALES_FIELDS.productName])));
  const hasComponents = fulfillmentRows.some((r) => text(r && r.line_origin) === "operator_component");
  if (!hasComponents) return map;

  const anchor = orderedRows.find((r) => text(r && r.line_origin) !== "operator_component");
  const anchorPrice = parseDecimalNumber(anchor && anchor[SALES_FIELDS.productPrice]);
  const fail = () => {
    for (const r of fulfillmentRows) map.set(String(r.id), { skipped: true });
    return map;
  };
  if (anchorPrice == null || anchorPrice <= 0) return fail();

  const tcogsByRowId = await resolveLineTcogs(env, fulfillmentRows);
  const allocInput = fulfillmentRows.map((r) => ({
    qty: parsePositiveInteger(r && r[SALES_FIELDS.quantity]),
    tcogs: tcogsByRowId.get(String(r.id))?.tcogsPerUnit ?? null,
  }));
  const alloc = allocateLineCommercialValues(anchorPrice, allocInput);
  if (!alloc.ok) return fail();

  alloc.lines.forEach((line, i) => map.set(String(fulfillmentRows[i].id), { unitPrice: line.unitPrice }));
  return map;
}

function findMatchingShipmentRows(rows, payload) {
  // Match by (orderId + SKU + sourceStoreId) using AND logic.
  // lineItemNumber is intentionally excluded from the match key: it is a derived
  // sequencing field that can shift when sales rows are added or removed.
  // Matching by lineItemNumber alone would false-match different SKUs at the same
  // index position, causing one to silently overwrite the other.
  const orderId = normalizeOrderIdCandidate(payload[SHIPMENT_FIELDS.orderId]);
  const sku = normalizeSku(payload[SHIPMENT_FIELDS.buyerPlatformSku]);
  const sourceStoreId = text(payload[SHIPMENT_FIELDS.sourceStoreId]);
  return rows.filter((row) => {
    if (normalizeOrderIdCandidate(row[SHIPMENT_FIELDS.orderId]) !== orderId) return false;
    if (sourceStoreId && text(row[SHIPMENT_FIELDS.sourceStoreId]) !== sourceStoreId) return false;
    const rowSku = normalizeSku(row[SHIPMENT_FIELDS.buyerPlatformSku] || row[SHIPMENT_FIELDS.b2bItemCode]);
    return rowSku && sku && rowSku === sku;
  });
}

/** Same match key as findMatchingShipmentRows — returns single row or null. */
function findExistingByKey(rows, payload) {
  const orderId = normalizeOrderIdCandidate(payload[SHIPMENT_FIELDS.orderId]);
  const sku = normalizeSku(payload[SHIPMENT_FIELDS.buyerPlatformSku]);
  const sourceStoreId = text(payload[SHIPMENT_FIELDS.sourceStoreId]);
  return rows.find((row) => {
    if (normalizeOrderIdCandidate(row[SHIPMENT_FIELDS.orderId]) !== orderId) return false;
    if (sourceStoreId && text(row[SHIPMENT_FIELDS.sourceStoreId]) !== sourceStoreId) return false;
    const rowSku = normalizeSku(row[SHIPMENT_FIELDS.buyerPlatformSku] || row[SHIPMENT_FIELDS.b2bItemCode]);
    return rowSku && sku && rowSku === sku;
  }) || null;
}

function selectCanonicalShipmentRow(rows, payload) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const targetSourceStoreId = text(payload[SHIPMENT_FIELDS.sourceStoreId]);
  const targetShipFrom = text(payload[SHIPMENT_FIELDS.shipFrom]);
  return rows
    .slice()
    .sort((left, right) => compareShipmentRowsForCanonical(left, right, { targetSourceStoreId, targetShipFrom }))[0];
}

function compareShipmentRowsForCanonical(left, right, target) {
  const scoreDiff = scoreShipmentRow(right, target) - scoreShipmentRow(left, target);
  if (scoreDiff !== 0) return scoreDiff;
  return compareIds(left && left.id, right && right.id);
}

function scoreShipmentRow(row, { targetSourceStoreId, targetShipFrom }) {
  let score = 0;
  const sourceStoreId = text(row && row[SHIPMENT_FIELDS.sourceStoreId]);
  const shipFrom = text(row && row[SHIPMENT_FIELDS.shipFrom]);
  const buyerSku = text(row && row[SHIPMENT_FIELDS.buyerPlatformSku]);
  const b2bItemCode = text(row && row[SHIPMENT_FIELDS.b2bItemCode]);
  if (sourceStoreId) score += 10;
  if (targetSourceStoreId && sourceStoreId === targetSourceStoreId) score += 20;
  if (shipFrom) score += 4;
  if (targetShipFrom && shipFrom === targetShipFrom) score += 8;
  if (buyerSku) score += 3;
  if (b2bItemCode) score += 2;
  return score;
}

function removeShipmentRowInPlace(rows, rowId) {
  const index = rows.findIndex((row) => compareIds(row && row.id, rowId) === 0);
  if (index >= 0) rows.splice(index, 1);
}

// String-safe id comparison (works for numeric Baserow ids and Supabase UUIDs).
function compareIds(left, right) {
  const a = String(left == null ? "" : left);
  const b = String(right == null ? "" : right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rowsEquivalent(existing, payload) {
  for (const [key, value] of Object.entries(payload)) {
    if (normalizeComparable(existing && existing[key]) !== normalizeComparable(value)) return false;
  }
  return true;
}

function normalizeComparable(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  return String(value).replace(/\r\n/g, "\n").trim();
}

function shouldSkipProductName(value) {
  const normalized = text(value);
  return normalized.includes("各種手数料") || normalized === "追加支払い・追加送料専用";
}

function parseMercariSalesOrderDateTime(value) {
  const raw = text(value);
  const isoParsed = Date.parse(raw);
  if (Number.isFinite(isoParsed)) {
    const d = new Date(isoParsed);
    return [
      d.getUTCFullYear(),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    ].join("-") + ` ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  }
  const match = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/u);
  if (!match) return raw || "";
  const [, year, month, day, hour, minute] = match;
  const parsedHour = Number.parseInt(hour, 10);
  const parsedMinute = Number.parseInt(minute, 10);
  if (!Number.isFinite(parsedHour) || !Number.isFinite(parsedMinute)) return raw || "";

  if (parsedHour === 24) {
    const rolled = new Date(Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10) + 1,
      0,
      parsedMinute,
      0,
      0,
    ));
    return `${rolled.getUTCFullYear()}-${String(rolled.getUTCMonth() + 1).padStart(2, "0")}-${String(rolled.getUTCDate()).padStart(2, "0")} 00:${String(parsedMinute).padStart(2, "0")}`;
  }

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute}`;
}

export function buildRequestedDeliveryDateText(dateValue, timeValue) {
  const dateText = text(dateValue);
  const timeText = text(timeValue);
  if (!dateText || !timeText) return "";
  return `${dateText}T${timeText}`;
}

function joinAddress(left, right) {
  return [left, right].filter(Boolean).join(" ").trim();
}

function formatPostalCode(value) {
  return text(value).replace(/\s+/g, "");
}

function normalizePhone(value) {
  return text(value).replace(/[^\d+]/g, "");
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDecimalNumber(value) {
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

function normalizeSku(value) {
  return text(value);
}

function multilineText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function text(value) {
  return String(value ?? "").trim();
}

// Exported for tests (not part of the public API surface)
export { buildShipmentPayload, findMatchingShipmentRows, GIGA_INELIGIBLE_SHIPPING_METHODS, isGigaEligibleShippingMethod };
