#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const MERCARI_RUNNER_BASE = String(process.env.MERCARI_RUNNER_BASE_URL || "https://worker-order.homesbliss.net").replace(/\/+$/, "");
  const MERCARI_RELAY_SECRET = String(process.env.MERCARI_RELAY_SECRET || "").trim();
  const BASEROW_DATABASE_TOKEN = String(process.env.BASEROW_DATABASE_TOKEN || "").trim();
  const BASEROW_API_BASE = String(process.env.BASEROW_API_BASE || "https://api.baserow.io/api").replace(/\/+$/, "");
  const SALES_TABLE_ID = process.env.BASEROW_MERCARI_SALES_ORDER_TABLE_ID || "903318";

  if (!BASEROW_DATABASE_TOKEN) {
    console.error("Missing BASEROW_DATABASE_TOKEN");
    process.exit(1);
  }
  if (!MERCARI_RELAY_SECRET) {
    console.error("Missing MERCARI_RELAY_SECRET — call from VPS or set env");
    process.exit(1);
  }

  console.log("=== Backfill Missing Addresses ===");
  console.log("");

  // ── 1. Find stuck orders in Baserow ──────────────────────
  console.log("── 1. Querying Baserow for WFS orders with empty shipping_name ──");
  const stuck = await findStuckOrders(BASEROW_API_BASE, SALES_TABLE_ID, BASEROW_DATABASE_TOKEN);
  if (stuck.length === 0) {
    console.log("  ✅ No stuck orders found. Nothing to backfill.");
    return;
  }

  console.log(`  Found ${stuck.length} stuck rows across ${new Set(stuck.map((r) => r.order_id)).size} unique orders.`);

  // ── 2. Group by shop ─────────────────────────────────────
  const byShop = {};
  for (const row of stuck) {
    const shopId = row.shop_id || "unknown";
    const shop = shopLabel(shopId);
    if (!byShop[shop]) byShop[shop] = [];
    byShop[shop].push(row);
  }

  console.log(`  Affected shops: ${Object.keys(byShop).join(", ")}`);
  for (const [shop, rows] of Object.entries(byShop)) {
    const orderCount = new Set(rows.map((r) => r.order_id)).size;
    console.log(`    ${shop}: ${rows.length} rows (${orderCount} orders)`);
  }
  console.log("");

  // ── 3. Trigger re-ingest per shop ─────────────────────────
  console.log("── 2. Triggering re-ingest for affected shops ──");
  for (const [shop, rows] of Object.entries(byShop)) {
    const orderCount = new Set(rows.map((r) => r.order_id)).size;
    console.log(`  ${shop}: ${orderCount} orders affected — triggering re-ingest...`);
    try {
      const result = await triggerIngest(MERCARI_RUNNER_BASE, MERCARI_RELAY_SECRET, shop);
      if (result.ok) {
        console.log(`    ✅ Re-ingest started (PID: ${result.pid})`);
      } else {
        console.error(`    ❌ Failed: ${result.error || "unknown"}`);
      }
    } catch (err) {
      console.error(`    ❌ Error: ${err.message}`);
    }
  }
  console.log("");

  // ── 4. Summary ───────────────────────────────────────────
  console.log("── 3. Summary ──");
  console.log(`  Stuck rows found: ${stuck.length}`);
  console.log(`  Unique orders:    ${new Set(stuck.map((r) => r.order_id)).size}`);
  console.log(`  Shops triggered:  ${Object.keys(byShop).length}`);
  console.log("");
  console.log("Re-ingest jobs are running in background on the relay.");
  console.log("After completion, verify addresses are populated in the portal.");
}

function shopLabel(shopId) {
  const map = { "Shop1": "Shop1", "Shop2": "Shop2", "Shop3": "Shop3", "Shop4": "Shop4" };
  return map[shopId] || shopId;
}

async function findStuckOrders(apiBase, tableId, token) {
  const url = `${apiBase}/database/rows/table/${tableId}/?user_field_names=true&size=200&filter__field__shipping_name__empty&filter__field__order_status__single_select_equal&filter__filter_type=AND`;

  const params = new URLSearchParams({
    "user_field_names": "true",
    "size": "200",
    "filter__field__shipping_name__empty": "",
    "filter__field__order_status__single_select_equal": "WAITING_FOR_SHIPPING",
    "filter__filter_type": "AND",
  });

  const allRows = [];
  let page = 1;

  while (true) {
    const url = `${apiBase}/database/rows/table/${tableId}/?${params.toString()}&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Baserow query failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const rows = data.results || [];
    allRows.push(...rows);
    if (!data.next) break;
    page++;
  }

  return allRows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    shop_id: r.shop_id,
  }));
}

async function triggerIngest(baseUrl, relaySecret, shopLabel) {
  const url = `${baseUrl}/admin/ingest`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-relay-secret": relaySecret,
    },
    body: JSON.stringify({
      shops: [shopLabel],
      statuses: ["WAITING_FOR_SHIPPING", "WAITING_FOR_PAYMENT"],
    }),
  });
  const body = await res.json();
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true, pid: body.pid };
}
