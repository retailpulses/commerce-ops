#!/usr/bin/env node
// Diagnostic: Check Rakuten order manage_number vs product_variants item_code mapping
// Usage: node scripts/_diag_rakuten_sku.mjs
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const ORDER_ID = "440058-20260714-0379940609";

  // 1. Look up the specific order
  console.log("=== 1. ORDER ===");
  const { data: orderData, error: orderError } = await supabase
    .from("sales_orders")
    .select("order_id, manage_number, b2b_item_code, product_name, sales_channel, original_product_id")
    .eq("order_id", ORDER_ID);
  console.log(JSON.stringify(orderData, null, 2));
  if (orderError) console.error("orderError:", orderError);

  // 2. If manage_number exists, look up in product_variants (exact match)
  const mn = orderData?.[0]?.manage_number;
  if (mn) {
    console.log(`\n=== 2. PRODUCT_VARIANTS WHERE item_code = "${mn}" (exact) ===`);
    const { data: pvExact, error: pvExactErr } = await supabase
      .from("product_variants")
      .select("item_code, jan_code, product_name")
      .eq("item_code", mn);
    console.log(JSON.stringify(pvExact, null, 2));
    if (pvExactErr) console.error("pvExactErr:", pvExactErr);

    console.log(`\n=== 3. PRODUCT_VARIANTS WHERE item_code ILIKE "${mn}" ===`);
    const { data: pvILike, error: pvILikeErr } = await supabase
      .from("product_variants")
      .select("item_code, jan_code, product_name")
      .ilike("item_code", mn);
    console.log(JSON.stringify(pvILike, null, 2));
    if (pvILikeErr) console.error("pvILikeErr:", pvILikeErr);

    // Also check product_commercials
    console.log(`\n=== 4. PRODUCT_VARIANTS + COMMERCIALS (JOIN) ===`);
    const { data: pvJoin, error: pvJoinErr } = await supabase
      .from("product_variants")
      .select("item_code, jan_code, product_name, product_commercials(effective_tcogs, owned_qty, source_available_qty)")
      .eq("item_code", mn);
    console.log(JSON.stringify(pvJoin, null, 2));
    if (pvJoinErr) console.error("pvJoinErr:", pvJoinErr);
  }

  // 5. Sample recent Rakuten orders to see manage_number patterns
  console.log("\n=== 5. RECENT RAKUTEN ORDERS (last 5) ===");
  const { data: recent, error: recentErr } = await supabase
    .from("sales_orders")
    .select("order_id, manage_number, b2b_item_code, product_name")
    .eq("sales_channel", "Rakuten")
    .order("purchase_date", { ascending: false })
    .limit(5);
  console.log(JSON.stringify(recent, null, 2));
  if (recentErr) console.error("recentErr:", recentErr);

  // 6. Check if any Rakuten orders have b2b_item_code populated
  console.log("\n=== 6. RAKUTEN ORDERS WITH b2b_item_code POPULATED ===");
  const { data: withB2b, error: withB2bErr, count: withB2bCount } = await supabase
    .from("sales_orders")
    .select("order_id, manage_number, b2b_item_code", { count: "exact" })
    .eq("sales_channel", "Rakuten")
    .not("b2b_item_code", "is", null)
    .neq("b2b_item_code", "")
    .limit(5);
  console.log("count:", withB2bCount);
  console.log(JSON.stringify(withB2b, null, 2));
  if (withB2bErr) console.error("withB2bErr:", withB2bErr);

  // 7. Check all distinct manage_numbers from Rakuten orders
  console.log("\n=== 7. DISTINCT MANAGE_NUMBERS (Rakuten, sample 10) ===");
  const { data: distinctMn, error: distinctMnErr } = await supabase
    .from("sales_orders")
    .select("manage_number")
    .eq("sales_channel", "Rakuten")
    .not("manage_number", "is", null)
    .neq("manage_number", "")
    .limit(10);
  // Get unique
  const unique = [...new Set((distinctMn || []).map(r => r.manage_number))];
  console.log(JSON.stringify(unique, null, 2));
  if (distinctMnErr) console.error("distinctMnErr:", distinctMnErr);

  // 8. For each unique manage_number, check if it exists in product_variants
  if (unique.length > 0) {
    console.log("\n=== 8. MANAGE_NUMBER → PRODUCT_VARIANTS MATCH CHECK ===");
    const { data: pvMatches, error: pvMatchesErr } = await supabase
      .from("product_variants")
      .select("item_code")
      .in("item_code", unique);
    const matchedCodes = new Set((pvMatches || []).map(r => r.item_code));
    for (const u of unique) {
      console.log(`  ${u} → ${matchedCodes.has(u) ? "MATCH" : "NO MATCH"}`);
    }
    if (pvMatchesErr) console.error("pvMatchesErr:", pvMatchesErr);
  }

  console.log("\n=== DONE ===");
}

main().catch(e => { console.error(e); process.exit(1); });
