const SUPABASE_TABLE = "sales_orders";
const SUPABASE_SELECT = "order_id,sales_channel,order_status,quantity,product_price,shipping_price,source_store_id,purchase_date";

const SHOP4_ID = "2JMLHBxjiFHDr55jMwA7fs";

const PLATFORMS = ["Mercari", "Rakuten", "Amazon"];
const SALES_GROUPS = ["Mercari Shop 4", "Other Mercari", "Rakuten", "Amazon"];

function revenue(row) {
  const productPrice = Number(row.product_price) || 0;
  const shippingPrice = Number(row.shipping_price) || 0;
  const quantity = Math.max(1, Number(row.quantity) || 1);
  return row.sales_channel === "rakuten"
    ? productPrice * quantity + shippingPrice
    : productPrice + shippingPrice;
}

function classifyOrder(row) {
  const channel = (row.sales_channel || "").trim();
  const status = (row.order_status || "").trim();
  const rev = revenue(row);

  if (channel === "mercari") {
    if (status === "CANCELED") return null;
    return {
      platform: "Mercari",
      group: row.source_store_id === SHOP4_ID ? "Mercari Shop 4" : "Other Mercari",
      isPaid: status !== "WAITING_FOR_PAYMENT",
      isWaiting: status === "WAITING_FOR_PAYMENT",
      revenue: rev,
    };
  }

  if (channel === "rakuten") {
    if (status === "CANCELED") return null;
    return {
      platform: "Rakuten",
      group: "Rakuten",
      isPaid: status === "PENDING_CONFIRMATION" || status === "CONFIRMED" || status === "RMS_CONFIRMED",
      isWaiting: false,
      revenue: rev,
    };
  }

  if (channel === "amazon") {
    if (status === "CANCELED") return null;
    return {
      platform: "Amazon",
      group: "Amazon",
      isPaid: status !== "PENDING",
      isWaiting: status === "PENDING",
      revenue: rev,
    };
  }

  return null;
}

function jstDateStr(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function jstDateParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const out = {};
  for (const p of parts) {
    if (p.type === "year") out.year = Number(p.value);
    if (p.type === "month") out.month = Number(p.value);
    if (p.type === "day") out.day = Number(p.value);
  }
  return out;
}

function todayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function monthStartUtc() {
  const parts = jstDateParts(new Date());
  return new Date(Date.UTC(parts.year, parts.month - 1, 1)).toISOString();
}

function nextMonthStartUtc() {
  const parts = jstDateParts(new Date());
  return new Date(Date.UTC(parts.year, parts.month, 1)).toISOString();
}

async function querySupabase(env, params) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`);
  url.search = params.toString();
  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`supabase_${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.json();
}

async function fetchOrders(env) {
  const params = new URLSearchParams();
  params.set("select", SUPABASE_SELECT);
  params.set("sales_channel", "in.(mercari,rakuten,amazon)");
  params.append("purchase_date", `gte.${monthStartUtc()}`);
  params.append("purchase_date", `lt.${nextMonthStartUtc()}`);
  params.set("order", "purchase_date.asc");
  params.set("limit", "10000");
  return querySupabase(env, params);
}

function buildSummary(rows) {
  const todayKey = todayJst();

  const init = () => ({ paidCount: 0, paidRevenue: 0, waitingCount: 0, waitingRevenue: 0 });

  const total = init();
  const byPlatform = Object.fromEntries(PLATFORMS.map(p => [p, init()]));
  const byGroup = Object.fromEntries(SALES_GROUPS.map(g => [g, init()]));

  for (const row of rows) {
    const c = classifyOrder(row);
    if (!c) continue;

    const s = c.isPaid ? "paid" : "waiting";
    const isToday = c.isPaid && jstDateStr(row.purchase_date) === todayKey;
    const isTodayWaiting = c.isWaiting && jstDateStr(row.purchase_date) === todayKey;

    total[s + "Count"] += 1;
    total[s + "Revenue"] += c.revenue;

    if (byPlatform[c.platform]) {
      byPlatform[c.platform][s + "Count"] += 1;
      byPlatform[c.platform][s + "Revenue"] += c.revenue;
    }

    if (byGroup[c.group]) {
      byGroup[c.group][s + "Count"] += 1;
      byGroup[c.group][s + "Revenue"] += c.revenue;
    }

    if (isToday) {
      total.paidTodayCount = (total.paidTodayCount || 0) + 1;
      total.paidTodayRevenue = (total.paidTodayRevenue || 0) + c.revenue;
      if (byPlatform[c.platform]) {
        byPlatform[c.platform].paidTodayCount = (byPlatform[c.platform].paidTodayCount || 0) + 1;
        byPlatform[c.platform].paidTodayRevenue = (byPlatform[c.platform].paidTodayRevenue || 0) + c.revenue;
      }
      if (byGroup[c.group]) {
        byGroup[c.group].paidTodayCount = (byGroup[c.group].paidTodayCount || 0) + 1;
        byGroup[c.group].paidTodayRevenue = (byGroup[c.group].paidTodayRevenue || 0) + c.revenue;
      }
    }

    if (isTodayWaiting) {
      total.waitingTodayRevenue = (total.waitingTodayRevenue || 0) + c.revenue;
    }
  }

  return {
    monthLabel: todayKey.slice(0, 7),
    timestampJst: formatJstDateTime(new Date()),
    total,
    byPlatform,
    byGroup,
  };
}

function formatJstDateTime(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date).replace(",", "").replace(/(\d{4})-(\d{2})-(\d{2})/, "$1-$2-$3") + " JST";
}

function fmtYen(v) {
  return `¥${Math.round(v || 0).toLocaleString("en-US")}`;
}

function platformLine(key, p, isToday) {
  const c = isToday ? (p.paidTodayCount || 0) : p.paidCount;
  const r = isToday ? (p.paidTodayRevenue || 0) : p.paidRevenue;
  return `- ${key}: ${c} orders / ${fmtYen(r)}`;
}

function groupLine(key, g, isToday) {
  const c = isToday ? (g.paidTodayCount || 0) : g.paidCount;
  const r = isToday ? (g.paidTodayRevenue || 0) : g.paidRevenue;
  return `- ${key}: ${c} orders / ${fmtYen(r)}`;
}

function formatBrief(s) {
  const t = s.total;
  const todayPaid = t.paidTodayCount || 0;
  const todayRev = t.paidTodayRevenue || 0;
  const todayAov = todayPaid ? Math.round(todayRev / todayPaid) : 0;
  const todayWaiting = t.waitingTodayRevenue || 0;

  const mtdPaid = t.paidCount;
  const mtdRev = t.paidRevenue;
  const mtdAov = mtdPaid ? Math.round(mtdRev / mtdPaid) : 0;

  const lines = [
    "### Multi-Platform Sales Brief",
    `Push time: ${s.timestampJst}`,
    `Month: ${s.monthLabel}`,
    "",
    "#### Total",
    `- Paid/completed orders: ${todayPaid}`,
    `- Paid/completed sales: ${fmtYen(todayRev)}`,
    `- Paid/completed AOV: ${fmtYen(todayAov)}`,
    `- Waiting payment: ${fmtYen(todayWaiting)}`,
    "",
    "##### Month To Date",
    `- Paid/completed orders: ${mtdPaid}`,
    `- Paid/completed sales: ${fmtYen(mtdRev)}`,
    `- Paid/completed AOV: ${fmtYen(mtdAov)}`,
    `- Waiting payment: ${fmtYen(t.waitingRevenue)}`,
    "",
    "#### By Platform Today",
    ...PLATFORMS.map(p => platformLine(p, s.byPlatform[p], true)),
    "",
    "#### By Platform Month To Date",
    ...PLATFORMS.map(p => platformLine(p, s.byPlatform[p], false)),
    "",
    "#### By Sales Group Today",
    ...SALES_GROUPS.map(g => groupLine(g, s.byGroup[g], true)),
    "",
    "#### By Sales Group Month To Date",
    ...SALES_GROUPS.map(g => groupLine(g, s.byGroup[g], false)),
    "",
    "#### Scope",
    "- Paid/completed excludes `CANCELED` on all platforms and `WAITING_FOR_PAYMENT` on Mercari. Rakuten `PENDING_CONFIRMATION` is included because payment is complete and only shop acknowledgement remains.",
    "- Waiting payment includes only a genuine customer-payment-pending status.",
  ];
  return lines.join("\n");
}

export async function runSalesBrief(env, options = {}) {
  const startedAt = new Date();
  const runId = `sales-brief-${startedAt.toISOString().replace(/[:.]/g, "")}`;
  try {
    const rows = await fetchOrders(env);
    const summary = buildSummary(rows);
    const markdown = formatBrief(summary);

    return {
      ok: true,
      job: "sales-brief",
      runId,
      trigger: options.trigger || "manual",
      dryRun: !!options.dryRun,
      startedAt: startedAt.toISOString(),
      rowsFetched: rows.length,
      metrics: summary.total,
      preview: markdown,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 500,
      job: "sales-brief",
      runId,
      trigger: options.trigger || "manual",
      dryRun: !!options.dryRun,
      startedAt: startedAt.toISOString(),
      error: error.stack || String(error),
    };
  }
}
