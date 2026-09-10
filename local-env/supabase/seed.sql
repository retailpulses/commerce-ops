-- Synthetic fixtures only. Stable UUIDs make reset output deterministic.
insert into public.platform_accounts (id, platform, shop_code)
values ('00000000-0000-4000-8000-000000000001', 'mercari', 'shop1');

insert into public.product_variants (id, item_code, variant_name)
values ('00000000-0000-4000-8000-000000000101', 'SYNTHETIC-SKU-001', 'Synthetic Blue');

insert into public.platform_listings (id, platform, shop_code, external_listing_id, variant_id)
values (
  '00000000-0000-4000-8000-000000000201',
  'mercari',
  'shop1',
  'synthetic-listing-001',
  '00000000-0000-4000-8000-000000000101'
);

insert into public.platform_listing_skus (id, listing_id, external_sku_id, variant_id)
values (
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000201',
  'synthetic-variant-001',
  '00000000-0000-4000-8000-000000000101'
);

insert into public.inquiries (
  source,
  external_inquiry_id,
  shop_key,
  platform_account_id,
  inquiry_date,
  inquiry_body,
  customer_nickname,
  product_name_snapshot,
  external_target_type,
  external_product_id,
  external_product_variant_id,
  external_status
) values (
  'mercari_shops',
  'synthetic-inquiry-001',
  'shop1',
  '00000000-0000-4000-8000-000000000001',
  '2026-01-02T03:04:05Z',
  'Synthetic fixture: Is this item available?',
  'synthetic-customer',
  'Synthetic Product',
  'InquiryProductTarget',
  'synthetic-listing-001',
  'synthetic-variant-001',
  'OPEN'
);
