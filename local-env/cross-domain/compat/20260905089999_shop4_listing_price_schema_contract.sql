-- Local synthetic-only assembly contract for the schema portion of the
-- RPagentOS-owned 20260905090000_shop4_listing_prices.sql data migration.
--
-- The canonical owner migration embeds hundreds of real Shop4 listing IDs and
-- prices. Local staging must not ingest production-derived records, so the
-- assembly excludes that data migration and applies only its two unmodified,
-- additive schema statements. This file owns no product_catalog semantics.

alter table public.platform_listings
  add column if not exists mercari_before_discount_price numeric(12,2);

alter table public.platform_listings
  add constraint platform_listings_mercari_before_discount_price_positive
  check (mercari_before_discount_price is null or mercari_before_discount_price > 0);
