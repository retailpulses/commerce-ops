import { describe, expect, it } from "vitest";
import {
  buildMercariSellerInquiryUrl,
  validatedLegacyMercariUrl,
} from "../mercari-seller-link";

describe("Mercari Seller inquiry links", () => {
  it.each([
    ["shop1", "WMyisFmhbGWyVAPEwsfirn"],
    ["shop2", "ZaMyGWzp6hUdgDh5E9ADob"],
    ["shop3", "2JGrmZqojnBMfdWrtP2xk3"],
    ["shop4", "2JMLHBxjiFHDr55jMwA7fs"],
  ])("builds an allowlisted %s link", (shopKey, slug) => {
    expect(buildMercariSellerInquiryUrl(shopKey, "inq/1")).toBe(
      `https://mercari-shops.com/seller/shops/${slug}/inquiries/inq%2F1`,
    );
  });

  it("rejects unknown shops and unsafe legacy origins", () => {
    expect(buildMercariSellerInquiryUrl("shop5", "inq-1")).toBeNull();
    expect(validatedLegacyMercariUrl("https://evil.test/inquiries/1")).toBeNull();
    expect(validatedLegacyMercariUrl("javascript:alert(1)")).toBeNull();
  });
});
