const MERCARI_SHOP_NAMES_BY_ID = Object.freeze({
  "2JGrmZqojnBMfdWrtP2xk3": "ホムブリス・リビング家具特化",
  "2JMLHBxjiFHDr55jMwA7fs": "ホムブリス本店・まとめ買い特化",
  "ZaMyGWzp6hUdgDh5E9ADob": "ホムブリズ・２号店",
  "WMyisFmhbGWyVAPEwsfirn": "ホムブリス・アウトレット",
});

const GIGA_ORDER_FROM_NAMES_BY_ID = Object.freeze({
  "WMyisFmhbGWyVAPEwsfirn": "Shop1",
  "ZaMyGWzp6hUdgDh5E9ADob": "Shop2",
  "2JGrmZqojnBMfdWrtP2xk3": "Shop3",
  "2JMLHBxjiFHDr55jMwA7fs": "Shop4",
});

export function getMercariShopName(shopId) {
  const normalizedShopId = String(shopId ?? "").trim();
  if (!normalizedShopId) {
    throw new Error("Missing Mercari shop_id");
  }

  const shopName = MERCARI_SHOP_NAMES_BY_ID[normalizedShopId];
  if (!shopName) {
    throw new Error(`Unknown Mercari shop_id: ${normalizedShopId}`);
  }

  return shopName;
}

export function getMercariShopOrderFromName(shopId) {
  const normalizedShopId = String(shopId ?? "").trim();
  if (!normalizedShopId) {
    throw new Error("Missing Mercari shop_id");
  }

  const orderFromName = GIGA_ORDER_FROM_NAMES_BY_ID[normalizedShopId];
  if (!orderFromName) {
    throw new Error(`Unknown Mercari shop_id for orderFrom: ${normalizedShopId}`);
  }

  return orderFromName;
}
