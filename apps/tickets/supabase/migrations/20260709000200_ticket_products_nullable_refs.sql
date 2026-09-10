-- ============================================================
-- Supabase Ticketing MVP — ticket_products nullable refs repair
--
-- Dropping the original composite primary key does not automatically
-- remove NOT NULL from its former columns. The relationship table must
-- allow product, variant, listing, or listing SKU links independently.
-- ============================================================

ALTER TABLE public.ticket_products
  ALTER COLUMN variant_id DROP NOT NULL,
  ALTER COLUMN listing_sku_id DROP NOT NULL;

