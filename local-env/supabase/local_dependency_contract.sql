-- LOCAL POC ONLY. Never apply this file to a hosted Supabase project.
--
-- Inquiry owns none of these objects. They are the smallest synthetic shape
-- needed to satisfy Inquiry's foreign keys and deterministic catalog-link
-- contract while the canonical RPagentOS migrations are absent from this repo.

create table public.platform_accounts (
  id uuid primary key,
  platform text,
  shop_code text
);

create table public.product_variants (
  id uuid primary key,
  item_code text,
  variant_name text
);

create table public.platform_listings (
  id uuid primary key,
  platform text not null,
  shop_code text not null,
  external_listing_id text not null,
  variant_id uuid references public.product_variants(id)
);

create table public.platform_listing_skus (
  id uuid primary key,
  listing_id uuid not null references public.platform_listings(id),
  external_sku_id text,
  variant_id uuid references public.product_variants(id)
);

create table public.product_platform_links (
  id uuid primary key,
  platform text not null,
  shop_code text not null,
  listing_id uuid references public.platform_listings(id),
  listing_sku_id uuid references public.platform_listing_skus(id),
  variant_id uuid not null references public.product_variants(id)
);
