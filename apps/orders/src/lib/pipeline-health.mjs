import { createBaserowClient, listAllRows, FIELD } from "./db.mjs";
import { isPipelineApprovedReviewStatus } from "./review-gate.mjs";
import {
  ORDER_STATUS,
  GIGA_SYNC_STATUS,
  REVIEW_STATUS,
  SHOP_CLOSE_STATUS,
  readSelectValue,
  statusEquals,
} from "./order-state.mjs";

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

const HEALTH_SALES_SELECT = [
  "id",
  "order_id",
  "sales_channel",
  "source_store_id",
  "order_status",
  "review_status",
  "product_name",
  "shipping_completed_at",
  "shop_close_status",
].join(",");

const HEALTH_SHIPMENT_SELECT = [
  "id",
  "order_id",
  "sales_channel",
  "source_store_id",
  "order_date",
  "buyer_sku_description",
  "giga_sync_status",
  "giga_sync_attempted_at",
  "giga_sync_error",
].join(",");

export async function collectPipelineHealthSnapshot(env, { shops, salesChannel, orderId = "" }, injected = {}) {
  const platform = text(salesChannel) || "Mercari";
  const exactOrderId = normalizeOrderIdCandidate(orderId);
  const selectedShopIds = new Set((shops || []).map((shop) => SHOP_IDS[shop]).filter(Boolean));
  const exactStoreId = platform === "Rakuten" ? "Rakuten" : (selectedShopIds.size === 1 ? [...selectedShopIds][0] : "");
  if (exactOrderId && !exactStoreId) return { ok: false, error: "scoped_health_requires_exact_store" };
  const baserow = injected.client || createBaserowClient(env);
  const listRows = injected.listAllRows || listAllRows;
  const salesFilters = {
    [`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`]: platform.toLowerCase(),
  };
  if (exactOrderId) {
    salesFilters[`filter__field_${FIELD.SALES.ORDER_ID}__equal`] = exactOrderId;
    salesFilters[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = exactStoreId;
  }
  const salesRows = await listRows(
    baserow,
    baserow.salesOrderTableId,
    salesFilters,
    { select: HEALTH_SALES_SELECT },
  );
  // Shipments: filter to the target platform only
  const shipmentFilters = {
    [`filter__field_${FIELD.SHIPMENT.SALES_CHANNEL}__equal`]: platform,
  };
  if (exactOrderId) {
    shipmentFilters[`filter__field_${FIELD.SHIPMENT.ORDER_ID}__equal`] = exactOrderId;
    shipmentFilters[`filter__field_${FIELD.SHIPMENT.SOURCE_STORE_ID}__equal`] = exactStoreId;
  }
  const shipmentRows = await listRows(baserow, baserow.shipmentOrderTableId,
    shipmentFilters, { select: HEALTH_SHIPMENT_SELECT });
  const retryAfterMinutes = normalizePositiveInteger(env.GIGA_OUTBOUND_RETRY_AFTER_MINUTES) || 30;

  const salesInScope = filterHealthSalesRows(salesRows, { platform, selectedShopIds, orderId: exactOrderId });
  const shipmentsInScope = shipmentRows.filter((row) => {
    const storeId = text(row.SourceStoreID);
    const channel = text(row.SalesChannel);
    if (exactOrderId && normalizeOrderIdCandidate(row.OrderId) !== exactOrderId) return false;
    if (platform === "Rakuten") return channel === "Rakuten" && storeId === "Rakuten";
    return channel === "Mercari" && (selectedShopIds.size ? selectedShopIds.has(storeId) : true);
  });

  const shipmentByScope = new Map();
  for (const row of shipmentsInScope) {
    const scope = healthOrderScopeKey(row, platform);
    if (!scope) continue;
    if (!shipmentByScope.has(scope)) shipmentByScope.set(scope, []);
    shipmentByScope.get(scope).push(row);
  }

  const missingShipments = salesInScope.filter((row) => {
    if (!statusEquals(row.order_status, ORDER_STATUS.WAITING_FOR_SHIPPING)) return false;
    if (!isPipelineApprovedReviewStatus(readSelectValue(row.review_status))) return false;
    if (shouldSkipProductName(row.product_name)) return false;
    const scope = healthOrderScopeKey(row, platform);
    return scope && !shipmentByScope.has(scope);
  }).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.order_id),
    sales_row_id: row.id,
    shop_id: text(row.shop_id),
    order_status: text(row.order_status),
  }));

  const nowMs = Date.now();
  const gigaInFlight = [];
  const gigaInvalid = [];
  const unsyncedShipments = [];
  const syncStatusCounts = {};

  for (const row of shipmentsInScope) {
    if (shouldSkipFeeRow(row)) continue;
    const status = readSelectValue(row.giga_sync_status);
    const attemptedAtMs = parseTimestamp(row.giga_sync_attempted_at);
    const normalizedKey = status.toLowerCase();
    syncStatusCounts[normalizedKey] = (syncStatusCounts[normalizedKey] || 0) + 1;

    if (statusEquals(status, GIGA_SYNC_STATUS.SYNCED) || statusEquals(status, GIGA_SYNC_STATUS.ALREADY_EXISTS)) {
      continue;
    }

    if (statusEquals(status, GIGA_SYNC_STATUS.INVALID)) {
      gigaInvalid.push(row);
      continue;
    }

    if (statusEquals(status, GIGA_SYNC_STATUS.ATTEMPTED) && Number.isFinite(attemptedAtMs) && attemptedAtMs > (nowMs - retryAfterMinutes * 60 * 1000)) {
      gigaInFlight.push(row);
      continue;
    }
    unsyncedShipments.push(row);
  }

  const unsyncedShipmentsSummary = unsyncedShipments.map((row) => ({
    order_id: normalizeOrderIdCandidate(row.OrderId),
    shipment_row_id: row.id,
    shop_id: text(row.SourceStoreID),
    order_date: text(row.OrderDate) || null,
    giga_sync_status: text(readSelectValue(row.giga_sync_status)) || null,
    giga_sync_attempted_at: text(row.giga_sync_attempted_at) || null,
    giga_sync_error: text(row.giga_sync_error) || null,
  }));

  const invalidShipmentsSummary = gigaInvalid.map((row) => ({
    order_id: normalizeOrderIdCandidate(row.OrderId),
    shipment_row_id: row.id,
    shop_id: text(row.SourceStoreID),
    order_date: text(row.OrderDate) || null,
    giga_sync_status: text(readSelectValue(row.giga_sync_status)) || null,
    giga_sync_attempted_at: text(row.giga_sync_attempted_at) || null,
    giga_sync_error: text(row.giga_sync_error) || null,
  }));

  const errorCount = unsyncedShipments.filter((row) => statusEquals(row.giga_sync_status, GIGA_SYNC_STATUS.ERROR)).length;
  const invalidCount = gigaInvalid.length;

  const pendingReview = salesInScope.filter((row) =>
    statusEquals(row.order_status, ORDER_STATUS.WAITING_FOR_SHIPPING)
    && statusEquals(row.review_status, REVIEW_STATUS.PENDING_REVIEW)
  ).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.order_id),
    sales_row_id: row.id,
    shop_id: text(row.shop_id),
    order_status: text(row.order_status),
  }));

  const autoApproved = salesInScope.filter((row) =>
    statusEquals(row.order_status, ORDER_STATUS.WAITING_FOR_SHIPPING)
    && statusEquals(row.review_status, REVIEW_STATUS.AUTO_APPROVED)
  ).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.order_id),
    sales_row_id: row.id,
    shop_id: text(row.shop_id),
    order_status: text(row.order_status),
  }));

  const shippedNotClosed = salesInScope.filter(isShippedNotClosedCandidate).map((row) => ({
    order_id: normalizeOrderIdCandidate(row.order_id),
    sales_row_id: row.id,
    shop_id: text(row.shop_id),
    shipping_completed_at: text(row.shipping_completed_at),
    shop_close_status: text(row.shop_close_status) || null,
  }));

  return {
    ok: !exactOrderId || salesInScope.length > 0 || shipmentsInScope.length > 0,
    ...(exactOrderId && salesInScope.length === 0 && shipmentsInScope.length === 0
      ? { error: "scoped_health_target_not_found" } : {}),
    scoped: Boolean(exactOrderId),
    sales_rows: salesInScope.length,
    shipment_rows: shipmentsInScope.length,
    giga_retry_after_minutes: retryAfterMinutes,
    missing_shipments_count: missingShipments.length,
    unsynced_shipments_count: unsyncedShipments.length,
    giga_inflight_count: gigaInFlight.length,
    giga_error_count: errorCount,
    giga_invalid_count: invalidCount,
    giga_sync_status_counts: syncStatusCounts,
    invalid_shipments_count: gigaInvalid.length,
    shipped_not_closed_count: shippedNotClosed.length,
    pending_review_count: pendingReview.length,
    pending_review_orders: pendingReview.slice(0, 50),
    auto_approved_count: autoApproved.length,
    auto_approved_orders: autoApproved.slice(0, 50),
    missing_shipments: missingShipments.slice(0, 50),
    unsynced_shipments: unsyncedShipmentsSummary.slice(0, 50),
    invalid_shipments: invalidShipmentsSummary.slice(0, 50),
    shipped_not_closed: shippedNotClosed.slice(0, 50),
  };
}

export function filterHealthSalesRows(rows, { platform, selectedShopIds = new Set(), orderId = "" }) {
  const expectedChannel = text(platform).toLowerCase();
  return (rows || []).filter((row) => {
    const rowChannel = text(row.sales_channel).toLowerCase();
    if (rowChannel && rowChannel !== expectedChannel) return false;
    if (orderId && normalizeOrderIdCandidate(row.order_id) !== normalizeOrderIdCandidate(orderId)) return false;
    if (expectedChannel === "rakuten") {
      return ["rakuten", ""].includes(text(row.source_store_id).toLowerCase())
        || ["rakuten", ""].includes(text(row.shop_id).toLowerCase());
    }
    const shopId = text(row.source_store_id || row.shop_id);
    return selectedShopIds.size ? selectedShopIds.has(shopId) : true;
  });
}

export function isShippedNotClosedCandidate(row) {
  if (!text(row?.shipping_completed_at)) return false;
  if (statusEquals(row?.order_status, ORDER_STATUS.COMPLETED)
    || statusEquals(row?.order_status, ORDER_STATUS.CANCELED)) return false;
  return !statusEquals(row?.shop_close_status, SHOP_CLOSE_STATUS.COMPLETED);
}

export function healthOrderScopeKey(row, defaultPlatform = "") {
  const channel = text(row?.sales_channel || row?.SalesChannel || defaultPlatform).toLowerCase();
  const store = text(row?.source_store_id || row?.shop_id || row?.SourceStoreID).toLowerCase();
  const orderId = normalizeOrderIdCandidate(row?.order_id || row?.OrderId).toLowerCase();
  return channel && store && orderId ? `${channel}\u0000${store}\u0000${orderId}` : "";
}

function shouldSkipProductName(value) {
  const normalized = text(value);
  return normalized.includes("各種手数料") || normalized === "追加支払い・追加送料専用";
}

function shouldSkipFeeRow(row) {
  const productName = text(row.BuyerSkuDescription);
  return productName.includes("各種手数料") || productName === "追加支払い・追加送料専用";
}

function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

function parseTimestamp(value) {
  const raw = text(value);
  if (!raw) return NaN;
  return Date.parse(raw);
}

function normalizePositiveInteger(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}
