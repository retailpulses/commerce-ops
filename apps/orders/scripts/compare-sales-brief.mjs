import { createClient } from "@supabase/supabase-js";

const NOW = new Date();
const JST_OFFSET = 9 * 60 * 60 * 1000;

const SHOP_MAP = {
  WMyisFmhbGWyVAPEwsfirn: "Shop 1",
  ZaMyGWzp6hUdgDh5E9ADob: "Shop 2",
  "2JGrmZqojnBMfdWrtP2xk3": "Shop 3",
  "2JMLHBxjiFHDr55jMwA7fs": "Shop 4",
};
const SHOP_NAMES = ["Shop 1", "Shop 2", "Shop 3", "Shop 4"];

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ── JST helpers ──────────────────────────────────────────────────
function nowJst() {
  return new Date(NOW.getTime() + JST_OFFSET);
}
function formatJstDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}
function formatJstDateTime(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date).replace(",", "") + " JST";
}
function startOfMonthJst() {
  const jst = nowJst();
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1, 0, 0, 0));
}
function startOfNextMonthJst() {
  const jst = nowJst();
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1, 0, 0, 0));
}

// ── Build sales brief summary from raw rows ──────────────────────
function buildSummary(rows) {
  const todayKey = formatJstDate(NOW);
  const monthLabel = todayKey.slice(0, 7);
  const s = {
    monthLabel, todayKey,
    totalRevenue: 0, totalOrders: 0,
    shopStats: Object.fromEntries(SHOP_NAMES.map(n => [n, 0])),
    waitingPaymentSum: 0,
    monthlyRevenue: 0, monthlyOrders: 0,
    monthlyShopStats: Object.fromEntries(SHOP_NAMES.map(n => [n, 0])),
    monthlyWaitingPaymentSum: 0,
  };

  for (const row of rows) {
    s.monthlyRevenue += row.revenue;
    s.monthlyOrders += 1;
    s.monthlyShopStats[row.shop] += row.revenue;

    if (row.dateKey === todayKey) {
      s.totalRevenue += row.revenue;
      s.totalOrders += 1;
      s.shopStats[row.shop] += row.revenue;
    }
    if (row.waitingPayment) {
      s.monthlyWaitingPaymentSum += row.revenue;
      if (row.dateKey === todayKey) {
        s.waitingPaymentSum += row.revenue;
      }
    }
  }

  s.todayAov = s.totalOrders ? Math.round(s.totalRevenue / s.totalOrders) : 0;
  s.monthlyAov = s.monthlyOrders ? Math.round(s.monthlyRevenue / s.monthlyOrders) : 0;
  return s;
}

function fmtYen(v) { return `¥${Math.round(v || 0).toLocaleString("en-US")}`; }
function printSummary(label, s) {
  console.log(`\n=== ${label} ===`);
  console.log(`Push time: ${formatJstDateTime(NOW)}`);
  console.log(`Month: ${s.monthLabel}`);
  console.log(`\nToday:`);
  console.log(`  Orders: ${s.totalOrders}`);
  console.log(`  Revenue: ${fmtYen(s.totalRevenue)}`);
  console.log(`  AOV: ${fmtYen(s.todayAov)}`);
  console.log(`  Waiting payment: ${fmtYen(s.waitingPaymentSum)}`);
  console.log(`\nBy Shop Today:`);
  for (const name of SHOP_NAMES) console.log(`  ${name}: ${fmtYen(s.shopStats[name])}`);
  console.log(`\nMonth To Date:`);
  console.log(`  Orders: ${s.monthlyOrders}`);
  console.log(`  Revenue: ${fmtYen(s.monthlyRevenue)}`);
  console.log(`  AOV: ${fmtYen(s.monthlyAov)}`);
  console.log(`  Waiting payment: ${fmtYen(s.monthlyWaitingPaymentSum)}`);
  console.log(`\nBy Shop Month To Date:`);
  for (const name of SHOP_NAMES) console.log(`  ${name}: ${fmtYen(s.monthlyShopStats[name])}`);
}

function printDiff(label, baserow, supabase) {
  const br = (v) => v !== undefined ? fmtYen(v) : "N/A";
  const sb = (v) => v !== undefined ? fmtYen(v) : "N/A";
  const diff = (b, s) => {
    if (b === undefined && s === undefined) return "N/A";
    const bv = b || 0, sv = s || 0;
    if (bv === sv) return "✓ match";
    const pct = bv ? ((sv - bv) / bv * 100).toFixed(2) : "∞";
    return `Δ ${fmtYen(sv - bv)} (${pct}%)`;
  };

  console.log(`\n=== ${label} ===`);
  console.log(`Metric                         Baserow          Supabase         Diff`);
  console.log(`─`.repeat(80));
  const metrics = [
    ["Today Orders", s => s.totalOrders, br, sb],
    ["Today Revenue", s => s.totalRevenue, br, sb],
    ["Today AOV", s => s.todayAov, br, sb],
    ["Today Waiting Payment", s => s.waitingPaymentSum, br, sb],
    ["MTD Orders", s => s.monthlyOrders, br, sb],
    ["MTD Revenue", s => s.monthlyRevenue, br, sb],
    ["MTD AOV", s => s.monthlyAov, br, sb],
    ["MTD Waiting Payment", s => s.monthlyWaitingPaymentSum, br, sb],
  ];
  for (const [name, get, fmt] of metrics) {
    const bv = get(baserow), sv = get(supabase);
    console.log(`${name.padEnd(30)} ${fmt(bv).padStart(16)} ${fmt(sv).padStart(16)}  ${diff(bv, sv)}`);
  }
  console.log(`\nBy Shop Today:`);
  for (const name of SHOP_NAMES) {
    const bv = baserow.shopStats[name], sv = supabase.shopStats[name];
    console.log(`  ${name.padEnd(10)} ${fmtYen(bv).padStart(16)} ${fmtYen(sv).padStart(16)}  ${diff(bv, sv)}`);
  }
  console.log(`\nBy Shop MTD:`);
  for (const name of SHOP_NAMES) {
    const bv = baserow.monthlyShopStats[name], sv = supabase.monthlyShopStats[name];
    console.log(`  ${name.padEnd(10)} ${fmtYen(bv).padStart(16)} ${fmtYen(sv).padStart(16)}  ${diff(bv, sv)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. Baserow — fetch from table 903318
// ═══════════════════════════════════════════════════════════════════
async function fetchBaserow() {
  const BASE = String(process.env.BASEROW_API_BASE || "https://api.baserow.io/api").trim();
  const TOKEN = requireEnv("BASEROW_DATABASE_TOKEN");
  const TABLE_ID = 903318;
  const FIELD_ID = 7824210; // purchase_date field

  const monthStart = formatJstDate(startOfMonthJst());
  const nextMonthStart = formatJstDate(startOfNextMonthJst());
  const todayKey = formatJstDate(NOW);
  const monthLabel = todayKey.slice(0, 7);

  const rows = [];
  let nextUrl = `${BASE}/database/rows/table/${TABLE_ID}/?user_field_names=true&size=200&filter__field_${FIELD_ID}__date_after_or_equal=${monthStart}&filter__field_${FIELD_ID}__date_before=${nextMonthStart}`;

  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: { authorization: `Token ${TOKEN}`, accept: "application/json" }
    });
    if (!resp.ok) throw new Error(`Baserow ${resp.status}: ${await resp.text()}`);
    const body = await resp.json();
    const pageRows = body.results || [];
    for (const r of pageRows) {
      let rawDate = r.purchase_date;
      if (!rawDate) continue;
      if (typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        rawDate = new Date(rawDate + "T00:00:00+09:00");
      } else if (typeof rawDate === "string") {
        rawDate = new Date(rawDate);
      }
      if (!(rawDate instanceof Date) || isNaN(rawDate.getTime())) {
        console.warn(`  SKIP row with bad purchase_date: ${JSON.stringify(r.purchase_date)} (order_id: ${r.order_id || "?"})`);
        continue;
      }
      const dateKey = formatJstDate(rawDate);
      if (!dateKey || !dateKey.startsWith(monthLabel)) continue;

      const statusObj = r.order_status;
      const status = statusObj && typeof statusObj === "object" ? String(statusObj.value || "").trim() : "";
      const price = Number.parseFloat(String(r["Total price"] ?? "").replace(/,/g, "").trim() || "0");
      const shop = SHOP_MAP[String(r.shop_id || "").trim()] || "Unknown";

      if (status === "CANCELED") continue;

      rows.push({
        dateKey,
        revenue: Number.isFinite(price) ? price : 0,
        shop,
        waitingPayment: status === "WAITING_FOR_PAYMENT",
      });
    }
    nextUrl = body.next ? (() => {
      const u = new URL(body.next);
      if (u.hostname === "api.baserow.io" && u.protocol === "http:") u.protocol = "https:";
      return u.toString();
    })() : "";
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// 2. Supabase — fetch from sales_orders table
// ═══════════════════════════════════════════════════════════════════
async function fetchSupabase() {
  const URL = String(process.env.SUPABASE_URL || "https://gqeyfhshxdiyhugvmbuk.supabase.co").trim();
  const KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(URL, KEY, { realtime: { enabled: false } });

  const monthStart = startOfMonthJst().toISOString();
  const nextMonthStart = startOfNextMonthJst().toISOString();
  const todayKey = formatJstDate(NOW);
  const monthLabel = todayKey.slice(0, 7);

  // Fetch all Mercari sales_orders for this month
  let allRows = [];
  let from = 0, size = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("sales_orders")
      .select("purchase_date, order_status, product_price, shipping_price, source_store_id, sales_channel")
      .eq("sales_channel", "mercari")
      .gte("purchase_date", monthStart)
      .lt("purchase_date", nextMonthStart)
      .order("purchase_date", { ascending: true })
      .range(from, from + size - 1);

    if (error) throw new Error(`Supabase ${error.code}: ${error.message}`);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    from += size;
  }

  const rows = [];
  for (const r of allRows) {
    if (!r.purchase_date) continue;
    const rawDate = new Date(r.purchase_date);
    if (isNaN(rawDate.getTime())) {
      console.warn(`  SKIP Supabase row with bad purchase_date: ${r.purchase_date} (order_id: ${r.order_id || "?"})`);
      continue;
    }
    const dateKey = formatJstDate(rawDate);
    if (!dateKey || !dateKey.startsWith(monthLabel)) continue;

    const status = String(r.order_status || "").trim();
    const revenue = (Number(r.product_price) || 0) + (Number(r.shipping_price) || 0);
    const shop = SHOP_MAP[String(r.source_store_id || "").trim()] || "Unknown";

    if (status === "CANCELED") continue;

    rows.push({
      dateKey,
      revenue,
      shop,
      waitingPayment: status === "WAITING_FOR_PAYMENT",
    });
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log(`Sales Brief Comparison — ${formatJstDateTime(NOW)}\n`);

  console.log("Fetching Baserow data...");
  const baserowRows = await fetchBaserow();
  console.log(`  → ${baserowRows.length} rows (${baserowRows.filter(r => !r.waitingPayment).length} paid, ${baserowRows.filter(r => r.waitingPayment).length} waiting)`);

  console.log("Fetching Supabase data...");
  const supabaseRows = await fetchSupabase();
  console.log(`  → ${supabaseRows.length} rows (${supabaseRows.filter(r => !r.waitingPayment).length} paid, ${supabaseRows.filter(r => r.waitingPayment).length} waiting)`);

  const baserowSummary = buildSummary(baserowRows);
  const supabaseSummary = buildSummary(supabaseRows);

  printSummary("BASEROW", baserowSummary);
  printSummary("SUPABASE", supabaseSummary);
  printDiff("COMPARISON", baserowSummary, supabaseSummary);

  // Show detailed row comparison
  console.log(`\n\n=== DETAILED ROW COMPARISON ===`);
  console.log(`Total Baserow rows: ${baserowRows.length}`);
  console.log(`Total Supabase rows: ${supabaseRows.length}`);
  if (baserowRows.length !== supabaseRows.length) {
    console.log(`\n⚠️  Row count MISMATCH: ${baserowRows.length - supabaseRows.length} row difference`);
  }

  // Check individual order revenue differences
  // Note: can't join by order_id since we don't have it in the brief data
  // But we can compare distributions
  console.log(`\nToday's rows (${baserowSummary.todayKey}):`);
  console.log(`  Baserow paid: ${baserowRows.filter(r => r.dateKey === baserowSummary.todayKey && !r.waitingPayment).length}`);
  console.log(`  Supabase paid: ${supabaseRows.filter(r => r.dateKey === supabaseSummary.todayKey && !r.waitingPayment).length}`);
  console.log(`  Baserow waiting: ${baserowRows.filter(r => r.dateKey === baserowSummary.todayKey && r.waitingPayment).length}`);
  console.log(`  Supabase waiting: ${supabaseRows.filter(r => r.dateKey === supabaseSummary.todayKey && r.waitingPayment).length}`);

  const verdict = (
    baserowSummary.totalOrders === supabaseSummary.totalOrders &&
    baserowSummary.totalRevenue === supabaseSummary.totalRevenue &&
    baserowSummary.monthlyOrders === supabaseSummary.monthlyOrders &&
    baserowSummary.monthlyRevenue === supabaseSummary.monthlyRevenue &&
    baserowSummary.monthlyWaitingPaymentSum === supabaseSummary.monthlyWaitingPaymentSum
  );
  console.log(`\n${"═".repeat(60)}`);
  console.log(verdict ? "✅ VERDICT: MATCH — Both data sources produce identical sales brief" : "❌ VERDICT: MISMATCH — Differences found (see above)");
  console.log(`${"═".repeat(60)}`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
