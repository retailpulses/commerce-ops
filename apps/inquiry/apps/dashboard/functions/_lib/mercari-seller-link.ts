const SHOP_SLUGS: Record<string, string> = {
  shop1: "WMyisFmhbGWyVAPEwsfirn",
  shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  shop3: "2JGrmZqojnBMfdWrtP2xk3",
  shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

export function buildMercariSellerInquiryUrl(
  shopKey: string | null,
  externalInquiryId: string | null,
): string | null {
  if (!shopKey || !externalInquiryId) return null;
  const shopSlug = SHOP_SLUGS[shopKey];
  if (!shopSlug) return null;
  return `https://mercari-shops.com/seller/shops/${shopSlug}/inquiries/${encodeURIComponent(externalInquiryId)}`;
}

export function validatedLegacyMercariUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "mercari-shops.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
