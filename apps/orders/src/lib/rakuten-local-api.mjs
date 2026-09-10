import https from "node:https";
import { buildRakutenShippingUpdate } from "./rakuten-relay.mjs";

const DEFAULT_RMS_BASE = "https://api.rms.rakuten.co.jp/es/2.0";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXACT_ORDER_IDS = 50;
const RMS_RATE_LIMIT_MS = 600;
let rmsRequestQueue = Promise.resolve();
let rmsLastCallAt = 0;

function text(value) { return String(value == null ? "" : value).trim(); }

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function toRmsDatetime(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const part = (value) => String(value).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${part(jst.getUTCMonth() + 1)}-${part(jst.getUTCDate())}T${part(jst.getUTCHours())}:${part(jst.getUTCMinutes())}:${part(jst.getUTCSeconds())}+0900`;
}

export function mapCarrierToRmsCode(value) {
  const name = text(value).toLowerCase();
  if (!name) return "1002";
  if (/^\d+$/.test(name)) return name;
  if (name.includes("yamato") || name.includes("ヤマト") || name.includes("宅急便")) return "1001";
  if (name.includes("sagawa") || name.includes("佐川")) return "1002";
  if (name.includes("japan") || name.includes("日本郵便") || name.includes("郵便") || name.includes("ゆうパック")) return "1003";
  if (name.includes("seino") || name.includes("西濃")) return "1004";
  if (name.includes("fukuyama") || name.includes("福山")) return "1005";
  return "1002";
}

export async function runRakutenIngestLocal(env, options = {}, injected = {}) {
  const post = injected.postJson || rmsPostJson;
  const exact = options.orderNumber == null
    ? []
    : (Array.isArray(options.orderNumber) ? options.orderNumber : [options.orderNumber]).map(text).filter(Boolean);
  if (exact.length > MAX_EXACT_ORDER_IDS) return failure("rakuten_order_ids_exceed_50", 400);
  try {
    let orderNumbers = exact;
    if (!orderNumbers.length) {
      const now = injected.now ? new Date(injected.now) : new Date();
      const start = new Date(now.getTime() - 72 * 60 * 60 * 1000);
      const searchBody = {
        dateType: 1,
        startDatetime: options.startDate || toRmsDatetime(start),
        endDatetime: options.endDate || toRmsDatetime(now),
      };
      const limit = parsePositiveInteger(options.limit);
      if (limit) searchBody.limit = limit;
      if (text(options.status)) searchBody.status = text(options.status);
      const searched = await post(env, "/order/searchOrder", searchBody);
      orderNumbers = Array.isArray(searched.orderNumberList) ? searched.orderNumberList.map(text).filter(Boolean) : [];
    }
    if (!orderNumbers.length) return success({ count: 0, totalCount: 0, orders: [] });
    const result = await post(env, "/order/getOrder", { version: 7, orderNumberList: orderNumbers });
    const orders = Array.isArray(result.OrderModelList) ? result.OrderModelList : [];
    return success({ count: orders.length, totalCount: orders.length, orders });
  } catch (error) {
    return failure(errorCode(error));
  }
}

export async function runRakutenOrderStatusesLocal(env, options = {}, injected = {}) {
  const orderNumbers = Array.isArray(options.orderNumbers) ? options.orderNumbers.map(text).filter(Boolean) : [];
  if (!orderNumbers.length) return failure("order_numbers_required", 400);
  return runRakutenIngestLocal(env, { orderNumber: orderNumbers }, injected);
}

export async function runRakutenConfirmLocal(env, options = {}, injected = {}) {
  const orderNumberList = Array.isArray(options.orderNumberList) ? options.orderNumberList.map(text).filter(Boolean) : [];
  if (!orderNumberList.length) return failure("order_number_list_required", 400);
  if (orderNumberList.length > MAX_EXACT_ORDER_IDS) return failure("rakuten_order_ids_exceed_50", 400);
  try {
    const result = await (injected.postJson || rmsPostJson)(env, "/order/confirmOrder", { orderNumberList });
    return success({ confirmed: orderNumberList, result });
  } catch (error) {
    return failure(errorCode(error), 502, { failed: orderNumberList });
  }
}

export async function runRakutenCloseLocal(env, options = {}, injected = {}) {
  const orderNumber = text(options.orderNumber);
  const trackingNo = text(options.trackingNo);
  if (!orderNumber) return failure("order_number_required", 400);
  if (!trackingNo) return failure("tracking_number_required", 400);
  try {
    const post = injected.postJson || rmsPostJson;
    const current = await post(env, "/order/getOrder", { version: 7, orderNumberList: [orderNumber] });
    const order = Array.isArray(current.OrderModelList) ? current.OrderModelList[0] : null;
    if (!order) return failure("order_not_found", 404, { orderNumber });
    const update = buildRakutenShippingUpdate(order, {
      orderNumber,
      trackingNo,
      deliveryCompany: mapCarrierToRmsCode(options.carrier),
      shippingDate: text(options.shippingDate),
    });
    if (!update.ok) return failure(update.error, 400, { orderNumber, basketId: update.basketId ?? null });
    const result = await post(env, "/order/updateOrderShipping/", update.body);
    const rmsMessages = Array.isArray(result?.MessageModelList)
      ? result.MessageModelList
      : (Array.isArray(result?.messageModelList) ? result.messageModelList : []);
    return success({ orderNumber, targets: update.targets, rmsMessages, result });
  } catch (error) {
    return failure(errorCode(error), 502, { orderNumber });
  }
}

function success(body) { return { ok: true, status: 200, body: { ok: true, ...body } }; }
function failure(error, status = 502, extra = {}) { return { ok: false, status, error, body: { ok: false, error, ...extra } }; }
function errorCode(error) { return text(error?.message || error || "rakuten_rms_request_failed").slice(0, 200); }

async function rmsPostJson(env, apiPath, body) {
  const serviceSecret = text(env.RAKUTEN_SERVICE_SECRET);
  const licenseKey = text(env.RAKUTEN_LICENSE_KEY);
  if (!serviceSecret || !licenseKey) return Promise.reject(new Error("rakuten_rms_credentials_missing"));
  const base = text(env.RAKUTEN_RMS_BASE || DEFAULT_RMS_BASE).replace(/\/+$/, "");
  const payload = JSON.stringify(body || {});
  const authorization = `ESA ${Buffer.from(`${serviceSecret}:${licenseKey}`).toString("base64")}`;
  await rateLimitRmsRequests();
  return new Promise((resolve, reject) => {
    const request = https.request(`${base}${apiPath}`, {
      method: "POST", family: 4, timeout: 30000,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(payload)),
      },
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
        if (Buffer.byteLength(responseBody) > MAX_RESPONSE_BYTES) request.destroy(new Error("rakuten_rms_response_too_large"));
      });
      response.on("end", () => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) return reject(new Error(`rakuten_rms_http_${status}`));
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error("rakuten_rms_invalid_json")); }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("rakuten_rms_timeout")));
    request.end(payload);
  });
}

function rateLimitRmsRequests() {
  const turn = rmsRequestQueue.then(async () => {
    const remaining = RMS_RATE_LIMIT_MS - (Date.now() - rmsLastCallAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    rmsLastCallAt = Date.now();
  });
  rmsRequestQueue = turn.catch(() => {});
  return turn;
}
