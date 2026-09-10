import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeStructuredListingDescription,
  LISTING_ENRICHMENT_PROMPT,
  normalizeInquiryPlatform,
  resolveExactListing,
} from "../listing-optimization";
import type { DashboardConfig } from "../config";
import type { InquiryDetailRow } from "../supabase";

const config = {
  supabase: { url: "https://catalog.test", restUrl: "", serviceRoleKey: "secret" },
} as DashboardConfig;

function inquiry(): InquiryDetailRow {
  return {
    source: "mercari_shops", shop_key: "shop2",
    linked_products: [{ id: "variant-1", linkRowId: 1, itemCode: "SKU", productName: "Product", isPrimary: true, linkSource: "operator", confidence: null }],
  } as InquiryDetailRow;
}

afterEach(() => vi.restoreAllMocks());

describe("exact listing resolution", () => {
  it("normalizes Mercari Shops inquiry sources", () => {
    expect(normalizeInquiryPlatform("mercari_shops")).toBe("mercari");
    expect(normalizeInquiryPlatform("mercari-shops")).toBe("mercari");
  });

  it("uses an exact direct listing when the projection link is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("product_platform_links")) return Response.json([]);
      expect(url).toContain("platform=eq.mercari");
      expect(url).toContain("shop_code=eq.shop2");
      expect(url).toContain("variant_id=eq.variant-1");
      return Response.json([{ id: "listing-1", external_listing_id: "external-1", platform: "mercari", shop_code: "shop2", title: "Title", description: "Description", content_revision: 3, score_total: 80, scored_content_revision: 3 }]);
    }));
    const result = await resolveExactListing(config, inquiry());
    expect(result.status).toBe("ready");
    expect(result.listing?.externalListingId).toBe("external-1");
  });

  it("fails closed when link and direct paths identify different listings", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("product_platform_links")
      ? Response.json([{ platform: "mercari", shop_code: "shop2", platform_listings: { id: "listing-a", external_listing_id: "a" } }])
      : Response.json([{ id: "listing-b", external_listing_id: "b", platform: "mercari", shop_code: "shop2" }])));
    expect((await resolveExactListing(config, inquiry())).status).toBe("mapping_conflict");
  });
});

describe("preserve-first listing enrichment", () => {
  it("keeps existing copy and merges additions into the five standard sections", () => {
    const source = "既存の商品説明です。\n【商品仕様】\n素材：スチール";
    const enrichment = [
      "【商品概要】", "既存の商品説明です。", "省スペースで使いやすい設計です。",
      "【特徴・ベネフィット】", "収納物を整理しやすくします。",
      "【商品仕様】", "素材：スチール",
      "【使用シーン・おすすめ】", "リビングや書斎におすすめです。",
      "【お手入れ・注意事項】", "乾いた布でお手入れしてください。",
    ].join("\n");

    const result = composeStructuredListingDescription(source, enrichment);

    expect(result).toContain("【商品概要】\n既存の商品説明です。\n省スペースで使いやすい設計です。");
    expect(result.match(/既存の商品説明です。/g)).toHaveLength(1);
    expect(result.match(/素材：スチール/g)).toHaveLength(1);
    expect([...result.matchAll(/【([^】]+)】/g)].map((match) => match[1])).toEqual([
      "商品概要", "特徴・ベネフィット", "商品仕様", "使用シーン・おすすめ", "お手入れ・注意事項",
    ]);
  });

  it("instructs the model to enrich instead of rewrite", () => {
    expect(LISTING_ENRICHMENT_PROMPT).toContain("Do not rewrite or summarize");
    expect(LISTING_ENRICHMENT_PROMPT).toContain("title set to null");
    expect(LISTING_ENRICHMENT_PROMPT).toContain("【商品概要】");
  });
});
