import { createSupabaseClient } from "../../_lib/supabase";
import { getConfig } from "../../_lib/config";
import { getProductInventory } from "../../_lib/product-pricing";

const SHOP_KEY_RE = /^shop[1-4]$/;

/** GET /api/products/search?q=... */
export async function onRequestGet(context: { request: Request; env: Record<string, string> }) {
  const config = getConfig(context.env);
  const supabase = createSupabaseClient(config);

  const url = new URL(context.request.url);
  const query = url.searchParams.get("q") || "";
  const requestedShop = url.searchParams.get("shop");
  const shopKey = requestedShop && SHOP_KEY_RE.test(requestedShop)
    ? requestedShop
    : null;

  if (!query || query.trim().length === 0) {
    return new Response(JSON.stringify({ data: [], pagination: { hasMore: false } }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const { data, hasMore } = await supabase.searchProducts(query.trim(), 20, shopKey);

    const results = data.map((p) => {
      const inventory = getProductInventory(p);
      return {
        id: p.id,
        itemCode: p.item_code || "",
        productName: p.variant_name || "",
        storeName: inventory.storeName || "",
        qtyAvailable: inventory.qtyAvailable,
        ownedQty: inventory.ownedQty,
        mercariQty: inventory.mercariQty,
      };
    });

    return new Response(JSON.stringify({ data: results, pagination: { hasMore } }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to search products";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
