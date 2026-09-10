import type { ProductPricing } from "./product-pricing";

/** Persisted inquiry value columns (snake_case to match PostgREST rows). */
export interface InquiryPricingFields {
  units: number | null;
  effective_price_excl_shipping: number | null;
  effective_price_incl_shipping: number | null;
  effective_tcogs: number | null;
  expected_value: number | null;
}

/** Fully resolved (persisted-or-catalog) inquiry value semantics. */
export interface ResolvedInquiryValues {
  effectivePriceExclShipping: number | null;
  effectivePriceInclShipping: number | null;
  effectiveTCOGS: number | null;
  expectedValue: number | null;
}

/** Shape of a link row needed to pick the fallback product. */
export interface ProductLinkChoice {
  product_variant_id: string | null;
  is_primary: boolean;
}

/**
 * True when a list row cannot compute its expected value from persisted columns
 * and must fall back to the linked primary product's catalog pricing.
 */
export function needsCatalogFallback(
  row: InquiryPricingFields & { has_product: boolean },
): boolean {
  return (
    row.expected_value === null &&
    row.effective_price_incl_shipping === null &&
    row.has_product === true
  );
}

/**
 * Resolve canonical pricing semantics: persisted inquiry values win, otherwise
 * fall back to the linked catalog product. Units default to 1 and Expected Value
 * falls back to units * effective price including shipping.
 */
export function resolveInquiryValues(
  persisted: InquiryPricingFields,
  pricing: ProductPricing | null,
): ResolvedInquiryValues {
  const effectivePriceExclShipping =
    persisted.effective_price_excl_shipping ??
    pricing?.effectivePriceExclShipping ??
    null;
  const effectivePriceInclShipping =
    persisted.effective_price_incl_shipping ??
    pricing?.effectivePriceInclShipping ??
    null;
  const effectiveTCOGS =
    persisted.effective_tcogs ?? pricing?.effectiveTCOGS ?? null;
  const units = persisted.units ?? 1;
  const expectedValue =
    persisted.expected_value ??
    (effectivePriceInclShipping !== null
      ? units * effectivePriceInclShipping
      : null);

  return {
    effectivePriceExclShipping,
    effectivePriceInclShipping,
    effectiveTCOGS,
    expectedValue,
  };
}

/**
 * Choose the primary link first, then the earliest linked product fallback.
 * Links are expected to arrive pre-ordered (primary desc, linked_at asc).
 */
export function selectPrimaryProductId(links: ProductLinkChoice[]): string | null {
  const chosen = links.find((link) => link.is_primary) ?? links[0];
  return chosen?.product_variant_id ?? null;
}
