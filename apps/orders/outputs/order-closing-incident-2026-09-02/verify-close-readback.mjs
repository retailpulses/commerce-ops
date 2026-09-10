#!/usr/bin/env node

import fs from "node:fs/promises";

const since = process.argv[2] || "2026-09-02T06:43:00Z";
const tokensPath = process.env.MERCARI_TOKENS_PATH;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!tokensPath || !supabaseUrl || !serviceKey) throw new Error("missing required production environment");

const shopById = {
  WMyisFmhbGWyVAPEwsfirn: "Shop1",
  ZaMyGWzp6hUdgDh5E9ADob: "Shop2",
  "2JGrmZqojnBMfdWrtP2xk3": "Shop3",
  "2JMLHBxjiFHDr55jMwA7fs": "Shop4",
};

const response = await fetch(
  `${supabaseUrl}/rest/v1/sales_orders?shop_close_completed_at=gte.${encodeURIComponent(since)}&shop_close_status=eq.Completed&select=order_id,source_store_id,order_status,shop_close_completed_at,shop_close_error`,
  { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
);
if (!response.ok) throw new Error(`supabase readback failed: ${response.status}`);
const salesRows = await response.json();
const rows = Array.from(new Map(
  salesRows.map((row) => [`${row.source_store_id}::${row.order_id}`, row]),
).values());
const tokenText = await fs.readFile(tokensPath, "utf8");
const tokenFor = (shop) => {
  const section = tokenText.split(/\n##\s+/).find((part) => part.startsWith(shop));
  const match = section && section.match(/- API token:\s*`([^`]+)`/);
  if (!match) throw new Error(`missing token for ${shop}`);
  return match[1];
};

const query = `query orderTransaction($id: ID!) { orderTransaction(id: $id) { id status completedAt } }`;
const results = [];
for (const row of rows) {
  const shop = shopById[row.source_store_id];
  try {
    const res = await fetch("https://api.mercari-shops.com/v1/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenFor(shop)}`,
        "content-type": "application/json",
        "user-agent": "Inhouse_ERP/0.0.1",
      },
      body: JSON.stringify({ query, variables: { id: row.order_id } }),
    });
    const body = await res.json();
    const order = body?.data?.orderTransaction;
    results.push({ order_id: row.order_id, shop, status: order?.status || null, completed_at: order?.completedAt || null, error: body?.errors?.[0]?.message || null });
  } catch (error) {
    results.push({ order_id: row.order_id, shop, status: null, completed_at: null, error: error.message });
  }
}

const counts = {};
for (const result of results) {
  const key = `${result.shop}:${result.status || "ERROR"}`;
  counts[key] = (counts[key] || 0) + 1;
}
console.log(JSON.stringify({ since, sales_rows: salesRows.length, unique_orders: results.length, counts, failures: results.filter((result) => result.status !== "COMPLETED" || result.error) }, null, 2));
