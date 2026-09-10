/** Shared shop configuration — single source of truth.
 *
 *  Used by webhook ingestion, reconciliation, sending, and administration.
 */

import type { Env } from "../types";

/** Internal shop name → Mercari shop ID (used for order URLs) */
export const SHOP_IDS: Record<string, string> = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

/** Internal shop name → env key for that shop's API token */
export const SHOP_TOKENS: Record<string, keyof Env> = {
  Shop1: "SHOP1_API_TOKEN",
  Shop2: "SHOP2_API_TOKEN",
  Shop3: "SHOP3_API_TOKEN",
  Shop4: "SHOP4_API_TOKEN",
};

/** Normalize loose shop identifiers from DB/user input to canonical Shop1..Shop4. */
export function normalizeShopName(shop: string | null | undefined): string | null {
  const normalized = shop?.trim().toLowerCase();
  if (!normalized) return null;
  return Object.keys(SHOP_TOKENS).find((name) => name.toLowerCase() === normalized) ?? null;
}

/** Reverse lookup: Mercari shop ID → internal shop name.
 *  Used by webhook handler to map incoming shop_id to Shop1..Shop4.
 */
export const MERCARI_SHOP_ID_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SHOP_IDS).map(([name, id]) => [id, name])
);

/** Build a Mercari seller order URL from shop name + transaction ID. */
export function getMercariOrderUrl(shopName: string, transactionId: string): string | null {
  const shopWebId = SHOP_IDS[shopName];
  if (!shopWebId || !transactionId) return null;
  return `https://mercari-shops.com/seller/shops/${shopWebId}/orders/${transactionId}`;
}
