import type { ProductCatalogRow } from "./supabase";

export interface ProductPricing {
  effectivePriceExclShipping: number | null;
  effectivePriceInclShipping: number | null;
  effectiveTCOGS: number | null;
}

export interface ProductInventory {
  storeName: string | null;
  qtyAvailable: number | null;
  ownedQty: number | null;
  mercariQty: number | null;
  restockDate: string | null;
}

function parseQuantity(value: unknown): number | null {
  const parsed = parsePrice(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.replace(/[¥￥,\s]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read canonical Mercari commercial values from the catalog import payload. */
export function getProductPricing(product: ProductCatalogRow): ProductPricing {
  const payload = product.raw_payload ?? {};

  return {
    effectivePriceExclShipping: parsePrice(
      payload["mercari_effective_pricing_excl._shipping"],
    ),
    effectivePriceInclShipping: parsePrice(
      payload["mercari_effective_pricing_incl._shipping"],
    ),
    effectiveTCOGS: parsePrice(payload.effective_tcogs),
  };
}

function parseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Read operator-facing inventory details from the catalog import payload. */
export function getProductInventory(
  product: ProductCatalogRow,
): ProductInventory {
  const payload = product.raw_payload ?? {};
  const commercial = product.product_commercials ?? null;
  const listingSku = product.product_platform_links?.[0]?.platform_listing_skus;
  const mercariStock = Array.isArray(listingSku)
    ? listingSku[0]?.stock_qty
    : listingSku?.stock_qty;

  return {
    storeName: parseText(product.store_name) ?? parseText(payload.store_name),
    qtyAvailable: parseQuantity(commercial?.source_available_qty),
    ownedQty: parseQuantity(commercial?.owned_qty),
    mercariQty: parseQuantity(mercariStock),
    restockDate: parseText(commercial?.restock_date),
  };
}
