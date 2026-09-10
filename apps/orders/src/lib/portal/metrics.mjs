import { createBaserowClient } from "../db.mjs";

const WINDOWS = new Set(["last_7_days", "last_30_days", "current_month"]);
const ZERO_SHA = "0000000000000000000000000000000000000000";

export function resolveMetricsWindow(key, now = new Date()) {
  if (!WINDOWS.has(key)) throw new Error("invalid_metrics_window");
  const end = new Date(now);
  let start;
  if (key === "last_7_days" || key === "last_30_days") {
    start = new Date(end.getTime() - Number(key === "last_7_days" ? 7 : 30) * 86400000);
  } else {
    const jst = new Date(end.getTime() + 9 * 3600000);
    start = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 3600000);
  }
  return { key, start: start.toISOString(), end: end.toISOString(), timezone: "Asia/Tokyo" };
}

function releaseSha(env) {
  const value = String(env.RELEASE_SHA || env.RELEASE_VERSION || "").trim();
  return /^[0-9a-f]{40}$/.test(value) ? value : ZERO_SHA;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rankedRows(map, limit) {
  return [...map.values()]
    .sort((a, b) => b.gross_sales_jpy - a.gross_sales_jpy || b.units_sold - a.units_sold)
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1, order_count: row.order_ids.size, order_ids: undefined }));
}

export function aggregateCommercialRows(rows) {
  const shops = new Map();
  const products = new Map();
  const suppliers = new Map();
  const totals = { order_ids: new Set(), units_sold: 0, gross_sales_jpy: 0 };
  let fulfillmentComponentUnits = 0;

  for (const row of rows) {
    const quantity = Math.max(0, num(row.quantity));
    if (String(row.line_origin || "") === "operator_component") {
      fulfillmentComponentUnits += quantity;
      continue;
    }
    const gross = Math.round(num(row.product_price) * quantity);
    const orderId = scopedOrderKey(row);
    totals.order_ids.add(orderId);
    totals.units_sold += quantity;
    totals.gross_sales_jpy += gross;

    const dimensions = [
      [shops, `${row.sales_channel || "unknown"}:${row.source_store_id || "unknown"}`, row.source_store_id || "Unknown shop"],
      [products, row.b2b_item_code || row.original_product_id || "unmapped_product", row.product_name || row.b2b_item_code || "Unmapped product"],
      [suppliers, "unmapped_supplier", "Unmapped GigaB2B supplier"],
    ];
    for (const [map, key, label] of dimensions) {
      const current = map.get(key) || { key, label, order_ids: new Set(), units_sold: 0, gross_sales_jpy: 0 };
      current.order_ids.add(orderId);
      current.units_sold += quantity;
      current.gross_sales_jpy += gross;
      map.set(key, current);
    }
  }

  return {
    totals: {
      order_count: totals.order_ids.size,
      units_sold: totals.units_sold,
      gross_sales_jpy: totals.gross_sales_jpy,
      ...(fulfillmentComponentUnits ? { fulfillment_component_units: fulfillmentComponentUnits } : {}),
    },
    by_shop_account: rankedRows(shops, Number.MAX_SAFE_INTEGER),
    top_products: rankedRows(products, 20).sort((a, b) => b.units_sold - a.units_sold || b.gross_sales_jpy - a.gross_sales_jpy).map((row, i) => ({ ...row, rank: i + 1 })),
    by_supplier: rankedRows(suppliers, 20),
  };
}

export async function handlePortalMetrics(env, searchParams, now = new Date()) {
  const window = resolveMetricsWindow(searchParams.get("window") || "last_30_days", now);
  const client = createBaserowClient(env);
  if (client.type !== "supabase") throw new Error("metrics_require_supabase");
  const sb = client.supabase;

  const [onHoldResult, currentWaitingResult, waitingWindowResult, commercialResult] = await Promise.all([
    sb.from("sales_orders").select("order_id,sales_channel,source_store_id").eq("review_status", "ON_HOLD").limit(5000),
    sb.from("sales_orders").select("order_id,sales_channel,source_store_id").eq("order_status", "WAITING_FOR_PAYMENT").limit(5000),
    sb.from("sales_orders").select("order_id,sales_channel,source_store_id").eq("order_status", "WAITING_FOR_PAYMENT").gte("created_at", window.start).lt("created_at", window.end).limit(5000),
    sb.from("sales_orders")
      .select("id,order_id,sales_channel,source_store_id,product_name,b2b_item_code,original_product_id,quantity,product_price,payment_date,order_status,line_origin")
      .gte("payment_date", window.start).lt("payment_date", window.end)
      .not("order_status", "in", '("WAITING_FOR_PAYMENT","CANCELED")')
      .limit(5000),
  ]);
  const error = onHoldResult.error || currentWaitingResult.error || waitingWindowResult.error || commercialResult.error;
  if (error) throw new Error(`order_metrics_query_failed:${error.message}`);

  const distinctOrders = (rows) => new Set((rows || []).map(scopedOrderKey).filter(Boolean)).size;
  const currentOnHold = distinctOrders(onHoldResult.data);
  const currentWaiting = distinctOrders(currentWaitingResult.data);
  const waitingWindow = distinctOrders(waitingWindowResult.data);

  const commercial = aggregateCommercialRows(commercialResult.data || []);
  const generatedAt = now.toISOString();
  return {
    contract_version: "1.1",
    domain: "orders",
    window,
    metrics: {
      on_hold: { kind: "window_flow", window_count: null, current_count: currentOnHold, status: "unavailable", warnings: ["durable_transition_history_missing"] },
      waiting_for_payment: { kind: "window_stock", window_count: waitingWindow, current_count: currentWaiting, status: "available", warnings: [] },
    },
    commercial: {
      ...commercial,
      dimension_as_of: generatedAt,
      status: "available",
      warnings: commercial.totals.units_sold > 0 ? ["supplier_mapping_unavailable"] : [],
    },
    generated_at: generatedAt,
    release_sha: releaseSha(env),
  };
}

function scopedOrderKey(row) {
  const channel = String(row && row.sales_channel || "").trim().toLowerCase();
  const store = String(row && row.source_store_id || "").trim().toLowerCase();
  const orderId = String(row && (row.order_id || row.id) || "").trim().replace(/^order_/, "").toLowerCase();
  return channel && store && orderId ? `${channel}\u0000${store}\u0000${orderId}` : "";
}
