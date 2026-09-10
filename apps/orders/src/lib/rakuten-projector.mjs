import { createBaserowClient, createRow, listAllRows, patchRow, deleteRow, FIELD, OPTION } from "./db.mjs";
import { RAKUTEN_ORDER_STATUS, readSelectValue, statusEquals } from "./order-state.mjs";
import { buildRequestedDeliveryDateText } from "./shipment-projector.mjs";
import { extractRmsCustomerRemarks } from "./rakuten-order-fields.mjs";
import { isRakutenShipmentReady } from "./rakuten-status-gates.mjs";
import { resolveCandidateLimit } from "./phase-limit.mjs";

// ── Rakuten → Giga field mapping ──────────────────────────────────

const RAKUTEN_SALES_FIELDS = {
  orderId: "order_id",
  purchaseDate: "purchase_date",
  productName: "product_name",
  manageNumber: "manage_number",
  b2bItemCode: "b2b_item_code",
  quantity: "quantity",
  productPrice: "product_price",
  shippingName: "shipping_name",
  shippingPostalCode: "shipping_postal_code",
  shippingState: "shipping_state",
  shippingCity: "shipping_city",
  shippingAddress1: "shipping_address_1",
  shippingAddress2: "shipping_address_2",
  shippingPhoneNumber: "shipping_phone_number",
  orderStatus: "order_status",
  requestedDeliveryDate: "requested_delivery_date",
  requestedDeliveryTime: "requested_delivery_time",
  orderComments: "order_comments",
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

const RAKUTEN_SHIP_FROM = "HomesBliss Rakuten";
const RAKUTEN_STORE_ID = "Rakuten"; // Single store — used as SourceStoreID

/**
 * Project Rakuten sales rows with status RMS_CONFIRMED into Giga shipment rows.
 * Follows the same pattern as projectMercariSalesOrdersToShipment.
 *
 * @param {object} env
 * @param {object} [options]
 * @param {number} [options.limit=100]
 * @returns {object} summary
 */
export async function projectRakutenSalesOrdersToShipment(env, options = {}, injected = {}) {
  const baserow = injected.client || createBaserowClient(env);
  const listRows = injected.listAllRows || listAllRows;
  const createShipmentRow = injected.createRow || createRow;
  const patchShipmentRow = injected.patchRow || patchRow;
  const dryRun = options.dryRun === true;
  const limit = resolveCandidateLimit(options.limit, 100);
  const selectedOrderId = normalizeOrderId(text(options.orderId || options.order_id));

  // Fetch Rakuten sales rows with status RMS_CONFIRMED
  const salesFilter = {
    [`filter__field_${FIELD.RAKUTEN_SALES.ORDER_STATUS}__single_select_equal`]:
      OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED,
  };
  const salesRows = await listRows(baserow, baserow.rakutenSalesOrderTableId, salesFilter);

  // Re-fetch shipment rows for dedup (same pattern as Mercari projector)
  let liveShipmentRows = await listRows(baserow, baserow.shipmentOrderTableId);

  const candidateRows = salesRows.filter((row) => {
    const status = readSelectValue(row[RAKUTEN_SALES_FIELDS.orderStatus]);
    const orderId = normalizeOrderId(text(row[RAKUTEN_SALES_FIELDS.orderId]));
    return (!selectedOrderId || orderId === selectedOrderId)
      && statusEquals(status, RAKUTEN_ORDER_STATUS.RMS_CONFIRMED) && isRakutenShipmentReady(row);
  });

  const limitedRows = candidateRows.slice(0, limit);

  const summary = {
    ok: true,
    mode: dryRun ? "dry_run" : "sync",
    side_effects: 0,
    sales_rows_loaded: salesRows.length,
    shipment_rows_loaded: liveShipmentRows.length,
    candidate_rows: candidateRows.length,
    processed: limitedRows.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    planned_created: 0,
    planned_updated: 0,
    order_filter: selectedOrderId || null,
    results: [],
  };

  for (const sourceRow of limitedRows) {
    // Each Rakuten order maps to 1 shipment row (1 line item per order)
    const orderId = normalizeOrderId(text(sourceRow[RAKUTEN_SALES_FIELDS.orderId]));
    const manageNumber = normalizeSku(text(sourceRow[RAKUTEN_SALES_FIELDS.manageNumber]));
    const b2bItemCode = normalizeSku(text(sourceRow[RAKUTEN_SALES_FIELDS.b2bItemCode]));
    const validation = validateRakutenProjectionSource(sourceRow);

    if (!validation.valid) {
      summary.skipped += 1;
      summary.results.push({
        order_id: orderId || "(empty)",
        source_row_id: Number(sourceRow.id),
        action: validation.reason,
      });
      continue;
    }

    const payload = buildRakutenShipmentPayload(sourceRow);
    const matches = findMatchingShipmentRows(liveShipmentRows, payload);
    const existing = selectCanonicalShipmentRow(matches, payload);
    const resultItem = {
      order_id: orderId,
      source_row_id: Number(sourceRow.id),
      sku: manageNumber,
      b2b_item_code: b2bItemCode,
    };

    try {
      if (existing && rowsEquivalent(existing, payload)) {
        summary.unchanged += 1;
        summary.results.push({ ...resultItem, action: "unchanged", shipment_row_id: Number(existing.id) });
        continue;
      }

      if (existing) {
        if (dryRun) {
          summary.planned_updated += 1;
          summary.results.push({ ...resultItem, action: "would_update", shipment_row_id: Number(existing.id) });
          continue;
        }
        const res = await patchShipmentRow(baserow, baserow.shipmentOrderTableId, existing.id, payload);
        if (!res.ok) throw new Error(res.error || `shipment_patch_failed_${res.status}`);
        Object.assign(existing, payload);
        summary.updated += 1;
        summary.results.push({ ...resultItem, action: "updated", shipment_row_id: Number(existing.id) });
        continue;
      }

      // Pre-create idempotency guard: re-check liveShipmentRows for a row
      // matching the same (orderId + SKU + salesChannel). This catches rows
      // created by a concurrent projector run after our initial snapshot was taken.
      const concurrentMatches = findMatchingShipmentRows(liveShipmentRows, payload);
      const concurrentMatch = concurrentMatches.length > 0 ? concurrentMatches[0] : null;
      if (concurrentMatch) {
        if (dryRun) {
          summary.planned_updated += 1;
          summary.results.push({ ...resultItem, action: "would_update_concurrent", shipment_row_id: Number(concurrentMatch.id) });
          continue;
        }
        const res = await patchShipmentRow(baserow, baserow.shipmentOrderTableId, concurrentMatch.id, payload);
        if (!res.ok) throw new Error(res.error || `shipment_patch_failed_${res.status}`);
        Object.assign(concurrentMatch, payload);
        summary.updated += 1;
        summary.results.push({ ...resultItem, action: "updated_concurrent", shipment_row_id: Number(concurrentMatch.id) });
        continue;
      }

      if (dryRun) {
        summary.planned_created += 1;
        summary.results.push({ ...resultItem, action: "would_create", shipment_row_id: null });
        continue;
      }
      const res = await createShipmentRow(baserow, baserow.shipmentOrderTableId, payload);
      if (!res.ok) throw new Error(res.error || `shipment_create_failed_${res.status}`);
      const createdRow = { ...(res.body || {}), ...payload };
      liveShipmentRows.push(createdRow);
      summary.created += 1;
      summary.results.push({
        ...resultItem,
        action: "created",
        shipment_row_id: Number(createdRow.id || 0) || null,
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        ...resultItem,
        action: "failed",
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  summary.ok = summary.failed === 0;
  summary.side_effects = summary.created + summary.updated;
  return summary;
}

export function buildRakutenShipmentPayload(sourceRow) {
  const orderId = normalizeOrderId(text(sourceRow[RAKUTEN_SALES_FIELDS.orderId]));
  const sku = normalizeSku(text(sourceRow[RAKUTEN_SALES_FIELDS.manageNumber]));
  const b2bItemCode = normalizeSku(text(sourceRow[RAKUTEN_SALES_FIELDS.b2bItemCode]));

  return {
    sales_order_id: sourceRow && sourceRow.id != null ? String(sourceRow.id) : null,
    [SHIPMENT_FIELDS.salesChannel]: "Rakuten",
    [SHIPMENT_FIELDS.shipFrom]: RAKUTEN_SHIP_FROM,
    [SHIPMENT_FIELDS.sourceStoreId]: RAKUTEN_STORE_ID,
    [SHIPMENT_FIELDS.orderId]: orderId,
    [SHIPMENT_FIELDS.lineItemNumber]: "1",
    [SHIPMENT_FIELDS.b2bItemCode]: b2bItemCode,
    [SHIPMENT_FIELDS.shipToQty]: parsePositiveInteger(sourceRow[RAKUTEN_SALES_FIELDS.quantity]),
    [SHIPMENT_FIELDS.deliveryToFbaWarehouse]: "No",
    [SHIPMENT_FIELDS.shipToName]: text(sourceRow[RAKUTEN_SALES_FIELDS.shippingName]),
    [SHIPMENT_FIELDS.shipToEmail]: "",
    [SHIPMENT_FIELDS.shipToPhone]: normalizePhone(sourceRow[RAKUTEN_SALES_FIELDS.shippingPhoneNumber]),
    [SHIPMENT_FIELDS.shipToPostalCode]: formatPostalCode(sourceRow[RAKUTEN_SALES_FIELDS.shippingPostalCode]),
    [SHIPMENT_FIELDS.shipToAddressDetail]: joinAddress(
      text(sourceRow[RAKUTEN_SALES_FIELDS.shippingAddress1]),
      text(sourceRow[RAKUTEN_SALES_FIELDS.shippingAddress2]),
    ),
    [SHIPMENT_FIELDS.shipToCity]: text(sourceRow[RAKUTEN_SALES_FIELDS.shippingCity]),
    [SHIPMENT_FIELDS.shipToState]: text(sourceRow[RAKUTEN_SALES_FIELDS.shippingState]),
    [SHIPMENT_FIELDS.shipToCountry]: "JP",
    [SHIPMENT_FIELDS.shipToServiceLevel]: "",
    [SHIPMENT_FIELDS.shipToAttachmentUrl]: "",
    [SHIPMENT_FIELDS.orderDate]: toDateOnly(sourceRow[RAKUTEN_SALES_FIELDS.purchaseDate]),
    [SHIPMENT_FIELDS.requestedDeliveryDate]: buildRequestedDeliveryDateText(
      sourceRow[RAKUTEN_SALES_FIELDS.requestedDeliveryDate],
      sourceRow[RAKUTEN_SALES_FIELDS.requestedDeliveryTime],
    ),
    [SHIPMENT_FIELDS.buyerBrand]: "",
    [SHIPMENT_FIELDS.buyerPlatformSku]: sku,
    [SHIPMENT_FIELDS.buyerSkuDescription]: text(sourceRow[RAKUTEN_SALES_FIELDS.productName]),
    [SHIPMENT_FIELDS.buyerSkuCommercialValue]: parseDecimalNumber(sourceRow[RAKUTEN_SALES_FIELDS.productPrice]),
    [SHIPMENT_FIELDS.buyerSkuLink]: "",
    [SHIPMENT_FIELDS.orderComments]: extractRmsCustomerRemarks(
      sourceRow[RAKUTEN_SALES_FIELDS.orderComments],
    ),
  };
}

export function validateRakutenProjectionSource(sourceRow) {
  const orderId = normalizeOrderId(text(sourceRow?.[RAKUTEN_SALES_FIELDS.orderId]));
  const manageNumber = normalizeSku(text(sourceRow?.[RAKUTEN_SALES_FIELDS.manageNumber]));
  const b2bItemCode = normalizeSku(text(sourceRow?.[RAKUTEN_SALES_FIELDS.b2bItemCode]));
  if (!b2bItemCode) return { valid: false, reason: "skipped_missing_b2b_item_code" };
  if (!orderId || !manageNumber) return { valid: false, reason: "skipped_missing_key" };
  return { valid: true, reason: null };
}

function findMatchingShipmentRows(rows, payload) {
  const orderId = normalizeOrderId(payload[SHIPMENT_FIELDS.orderId]);
  const sku = normalizeSku(payload[SHIPMENT_FIELDS.buyerPlatformSku]);
  const channel = text(payload[SHIPMENT_FIELDS.salesChannel]);

  return rows.filter((row) => {
    // Must be same order ID and same SalesChannel
    if (normalizeOrderId(row[SHIPMENT_FIELDS.orderId]) !== orderId) return false;
    if (text(row[SHIPMENT_FIELDS.salesChannel]) !== channel) return false;
    const rowSku = normalizeSku(row[SHIPMENT_FIELDS.buyerPlatformSku] || row[SHIPMENT_FIELDS.b2bItemCode]);
    return rowSku === sku;
  });
}

function selectCanonicalShipmentRow(rows, _payload) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Prefer the row with the lowest ID (first created)
  return rows.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
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

// ── Helpers ────────────────────────────────────────────────────────

function text(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeOrderId(value) {
  return text(value).replace(/^order[_-\s]*/i, "");
}

function normalizeSku(value) {
  return text(value).toUpperCase();
}

function parsePositiveInteger(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseDecimalNumber(value) {
  const n = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function formatPostalCode(value) {
  const t = text(value).replace(/[〒\-\s]/g, "");
  if (t.length === 7) return `${t.slice(0, 3)}-${t.slice(3)}`;
  return t;
}

function normalizePhone(value) {
  return text(value).replace(/[^\d+\-]/g, "");
}

function joinAddress(line1, line2) {
  const a = text(line1);
  const b = text(line2);
  if (a && b) return `${a} ${b}`;
  return a || b;
}

function toDateOnly(value) {
  const t = text(value);
  if (!t) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
