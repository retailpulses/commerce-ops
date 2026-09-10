import { describe, expect, it } from "vitest";

import { createSupabaseClient } from "../supabase";
import { getConfig } from "../config";

const restUrl = process.env.STAGE_C_REST_URL ?? "";
const serviceRoleKey = process.env.STAGE_C_SERVICE_ROLE_KEY ?? "";
const stageC = restUrl && serviceRoleKey ? it : it.skip;

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${restUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

describe("Stage C dashboard repository against local PostgREST", () => {
  stageC("reads Japanese data and preserves product-link ownership", async () => {
    const suffix = String(Date.now());
    const productVariantId = crypto.randomUUID();
    const itemCode = `DASH${suffix}`;
    let inquiryId: number | null = null;
    try {
      const unauthenticated = await fetch(`${restUrl}/inquiries?limit=1`);
      expect([401, 403]).toContain(unauthenticated.status);

      await api("/product_variants", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id: productVariantId,
          sku: itemCode,
          item_code: itemCode,
          variant_name: "日本語ダッシュボード商品",
          stock_qty: 7,
          status: "active",
        }),
      });
      const created = await api("/inquiries", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          source: "mercari_shops",
          external_inquiry_id: `dashboard-stage-c-${suffix}`,
          shop_key: "shop2",
          status: "received",
          automation_status: "new",
          inquiry_date: "2026-07-21T02:00:00Z",
          inquiry_body: "日本語検索の問い合わせ",
          customer_nickname: "検索顧客",
          product_name_snapshot: "日本語ダッシュボード商品",
        }),
      }) as { id: number }[];
      inquiryId = created[0].id;

      const client = createSupabaseClient(getConfig({
        SUPABASE_URL: restUrl,
        SUPABASE_REST_URL: restUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "true",
      }));
      const products = await client.searchProducts("日本語ダッシュボード", 20);
      expect(products.data.some((product) => product.id === productVariantId)).toBe(true);
      const inquiries = await client.listInquiries({ search: "検索顧客", pageSize: 20 });
      expect(inquiries.data.some((inquiry) => inquiry.id === inquiryId)).toBe(true);
      expect((await client.getInquiryDetail(inquiryId))?.customer_nickname).toBe("検索顧客");

      await client.setPrimaryProductLink({
        inquiry_id: inquiryId,
        product_variant_id: productVariantId,
        item_code_snapshot: itemCode,
        product_name_snapshot: "日本語ダッシュボード商品",
        is_primary: true,
        link_source: "operator",
      });
      const links = await api(`/inquiry_product_links?inquiry_id=eq.${inquiryId}&select=product_variant_id,link_source,is_primary`);
      expect(links).toEqual([{
        product_variant_id: productVariantId,
        link_source: "operator",
        is_primary: true,
      }]);

      await client.updateInquiry(inquiryId, { units: 2, expected_value: null });
      const updated = await api(`/inquiries?id=eq.${inquiryId}&select=units,expected_value`);
      expect(updated[0]).toEqual({ units: 2, expected_value: null });

      await client.deleteOperatorProductLinks(inquiryId);
      expect(await api(`/inquiry_product_links?inquiry_id=eq.${inquiryId}`)).toEqual([]);
    } finally {
      if (inquiryId !== null) await api(`/inquiries?id=eq.${inquiryId}`, { method: "DELETE" });
      await api(`/product_variants?id=eq.${productVariantId}`, { method: "DELETE" });
    }
  });
});
