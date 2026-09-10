import { checkRelayHealth } from "./mercari-relay.mjs";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function buildRelayHeaders(relaySecret) {
  const headers = { "content-type": "application/json" };
  if (text(relaySecret)) headers["x-relay-secret"] = text(relaySecret);
  return headers;
}

function resolveBaseUrl(env) {
  const base = text(env.MERCARI_RUNNER_BASE_URL);
  if (base) return base.replace(/\/+$/, "");
  const ingest = text(env.MERCARI_INGEST_RUNNER_URL);
  if (ingest && ingest.endsWith("/admin/ingest")) {
    return ingest.slice(0, -"/admin/ingest".length);
  }
  return "";
}

async function callRelayEndpoint(url, body, relaySecret) {
  const res = await fetch(url, {
    method: "POST",
    headers: buildRelayHeaders(relaySecret),
    body: JSON.stringify(body || {}),
  });
  const parsed = await res.json().catch(() => null);
  return {
    ok: res.ok && parsed && parsed.ok !== false,
    status: res.status,
    body: parsed,
  };
}

/**
 * Pull Rakuten orders from RMS via the VPS relay.
 * Worker → Relay (POST /admin/rakuten-ingest) → RMS searchOrder.
 */
export async function runRakutenIngestViaRelay(env, options = {}) {
  const baseUrl = resolveBaseUrl(env);
  const url = baseUrl ? `${baseUrl}/admin/rakuten-ingest` : "";
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  if (!url) {
    return {
      ok: false,
      statusCode: 500,
      error: "missing_rakuten_ingest_url",
      message: "Rakuten RMS access must go through the VPS relay.",
    };
  }

  const body = {};
  if (options.limit === null) body.limit = null;
  else body.limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 50;
  if (options.startDate) body.startDate = options.startDate;
  if (options.endDate) body.endDate = options.endDate;
  if (options.orderNumber) body.orderNumber = options.orderNumber;

  return await callRelayEndpoint(url, body, relaySecret);
}

/** Exact-ID lifecycle read for already-known orders; never performs discovery. */
export async function runRakutenOrderStatusesViaRelay(env, options = {}) {
  const baseUrl = resolveBaseUrl(env);
  const url = baseUrl ? `${baseUrl}/admin/rakuten-ingest` : "";
  if (!url) return { ok: false, statusCode: 500, error: "missing_rakuten_ingest_url" };
  const orderNumbers = Array.isArray(options.orderNumbers)
    ? options.orderNumbers.map((value) => text(value)).filter(Boolean)
    : [];
  if (!orderNumbers.length) return { ok: false, statusCode: 400, error: "order_numbers_required" };
  return await callRelayEndpoint(url, { orderNumber: orderNumbers }, text(env.MERCARI_RELAY_SECRET));
}

/**
 * Confirm Rakuten orders on RMS via the VPS relay.
 * Worker → Relay (POST /admin/rakuten-confirm) → RMS confirmOrder.
 */
export async function runRakutenConfirmViaRelay(env, options = {}) {
  const baseUrl = resolveBaseUrl(env);
  const url = baseUrl ? `${baseUrl}/admin/rakuten-confirm` : "";
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  if (!url) {
    return {
      ok: false,
      statusCode: 500,
      error: "missing_rakuten_confirm_url",
      message: "Rakuten RMS confirm must go through the VPS relay.",
    };
  }

  const orderNumberList = Array.isArray(options.orderNumberList)
    ? options.orderNumberList
    : [];
  return await callRelayEndpoint(url, { orderNumberList }, relaySecret);
}

/**
 * Close a Rakuten order on RMS (mark as shipped with tracking info).
 * Worker → Relay (POST /admin/rakuten-close) → RMS updateOrder.
 *
 * The relay implementation uses es/2.0 getOrder(version 7) plus
 * updateOrderShipping. Production activation still requires authoritative
 * contract verification, a governed exact-order canary, and RMS readback.
 */
export async function runRakutenCloseViaRelay(env, options = {}) {
  const baseUrl = resolveBaseUrl(env);
  const url = baseUrl ? `${baseUrl}/admin/rakuten-close` : "";
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  if (!url) {
    return {
      ok: false,
      statusCode: 500,
      error: "missing_rakuten_close_url",
      message: "Rakuten RMS close must go through the VPS relay.",
    };
  }

  return await callRelayEndpoint(url, {
    orderNumber: options.orderNumber,
    trackingNo: options.trackingNo,
    carrier: options.carrier,
    shippingDate: options.shippingDate,
  }, relaySecret);
}

/**
 * Build an idempotent updateOrderShipping request from a fresh RMS order.
 *
 * A single-destination order may create its first shipping detail. Otherwise
 * every basket must contain exactly one active detail matching trackingNo; the
 * existing shippingDetailId is then reused. Ambiguous or incomplete
 * multi-destination mappings fail before any RMS mutation is attempted.
 */
export function buildRakutenShippingUpdate(order, options = {}) {
  const orderNumber = text(options.orderNumber || order?.orderNumber);
  const trackingNo = text(options.trackingNo);
  const deliveryCompany = text(options.deliveryCompany);
  const shippingDate = text(options.shippingDate);
  const packages = Array.isArray(order?.PackageModelList) ? order.PackageModelList : [];

  if (!orderNumber) return { ok: false, error: "order_number_required" };
  if (!trackingNo) return { ok: false, error: "tracking_number_required" };
  if (!deliveryCompany) return { ok: false, error: "delivery_company_required" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shippingDate)) {
    return { ok: false, error: "shipping_date_required_yyyy_mm_dd" };
  }
  if (packages.length === 0) return { ok: false, error: "order_has_no_packages" };

  const targets = [];
  for (const pkg of packages) {
    const basketId = pkg?.basketId;
    if (basketId == null || text(basketId) === "") {
      return { ok: false, error: "package_missing_basket_id" };
    }

    const shippingModels = Array.isArray(pkg?.ShippingModelList) ? pkg.ShippingModelList : [];
    const activeModels = shippingModels.filter((item) => Number(item?.shippingDeleteFlag || 0) !== 1);
    const matches = activeModels.filter((item) => text(item?.shippingNumber) === trackingNo);

    if (matches.length > 1) {
      return { ok: false, error: "ambiguous_matching_shipping_details", basketId };
    }

    if (matches.length === 1) {
      const shippingDetailId = matches[0]?.shippingDetailId;
      if (shippingDetailId == null || text(shippingDetailId) === "") {
        return { ok: false, error: "matching_shipping_detail_missing_id", basketId };
      }
      targets.push({ basketId, shippingDetailId, action: "update" });
      continue;
    }

    // Creating the first detail is safe only for a single-destination order.
    // Existing non-matching details are never overwritten or duplicated.
    if (packages.length === 1 && activeModels.length === 0) {
      targets.push({ basketId, shippingDetailId: null, action: "create" });
      continue;
    }

    return {
      ok: false,
      error: packages.length > 1
        ? "unsafe_multi_destination_shipping_mapping"
        : "existing_shipping_detail_does_not_match_tracking",
      basketId,
    };
  }

  return {
    ok: true,
    orderNumber,
    targets,
    body: {
      orderNumber,
      BasketidModelList: targets.map((target) => ({
        basketId: target.basketId,
        ShippingModelList: [{
          shippingDetailId: target.shippingDetailId,
          shippingNumber: trackingNo,
          deliveryCompany,
          shippingDate,
          shippingDeleteFlag: 0,
        }],
      })),
    },
  };
}

export { checkRelayHealth };
