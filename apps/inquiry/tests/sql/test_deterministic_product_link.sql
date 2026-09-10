\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.product_variants (
  id UUID PRIMARY KEY,
  item_code TEXT,
  variant_name TEXT
);
CREATE TABLE public.platform_listings (
  id UUID PRIMARY KEY,
  platform TEXT NOT NULL,
  shop_code TEXT NOT NULL,
  external_listing_id TEXT,
  variant_id UUID REFERENCES public.product_variants(id)
);
CREATE TABLE public.platform_listing_skus (
  id UUID PRIMARY KEY,
  listing_id UUID REFERENCES public.platform_listings(id),
  variant_id UUID REFERENCES public.product_variants(id),
  external_sku_id TEXT
);
CREATE TABLE public.product_platform_links (
  id UUID PRIMARY KEY,
  listing_id UUID REFERENCES public.platform_listings(id),
  listing_sku_id UUID REFERENCES public.platform_listing_skus(id),
  variant_id UUID REFERENCES public.product_variants(id),
  platform TEXT NOT NULL,
  shop_code TEXT NOT NULL
);
CREATE TABLE public.inquiries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_key TEXT,
  deleted_at TIMESTAMPTZ,
  external_target_type TEXT,
  external_product_id TEXT,
  external_product_variant_id TEXT,
  external_order_transaction_id TEXT,
  inquiry_date TIMESTAMPTZ,
  product_links_reviewed_at TIMESTAMPTZ
);
CREATE TABLE public.inquiry_product_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id BIGINT NOT NULL REFERENCES public.inquiries(id),
  product_variant_id UUID REFERENCES public.product_variants(id),
  item_code_snapshot TEXT,
  product_name_snapshot TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  link_source TEXT,
  confidence NUMERIC(3,2)
);
CREATE UNIQUE INDEX uq_inquiry_product_links_variant
  ON public.inquiry_product_links(inquiry_id, product_variant_id)
  WHERE product_variant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_inquiry_product_links_one_primary
  ON public.inquiry_product_links(inquiry_id) WHERE is_primary;

\ir ../../supabase/migrations/20260904000000_link_api_inquiries_to_catalog.sql

INSERT INTO public.product_variants(id, item_code, variant_name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'SKU-EXACT', 'Exact variant'),
  ('10000000-0000-4000-8000-000000000002', 'SKU-FALLBACK', 'Listing fallback'),
  ('10000000-0000-4000-8000-000000000003', 'SKU-OTHER', 'Other variant');

INSERT INTO public.platform_listings(id, platform, shop_code, external_listing_id, variant_id) VALUES
  ('20000000-0000-4000-8000-000000000001', 'mercari', 'shop4', 'PRODUCT-1', '10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000002', 'mercari', 'shop4', 'PRODUCT-2', NULL),
  ('20000000-0000-4000-8000-000000000003', 'mercari', 'shop4', 'PRODUCT-3', '10000000-0000-4000-8000-000000000002');
INSERT INTO public.platform_listing_skus(id, listing_id, variant_id, external_sku_id) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'VARIANT-1');
INSERT INTO public.product_platform_links(id, listing_id, listing_sku_id, variant_id, platform, shop_code) VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', NULL, '10000000-0000-4000-8000-000000000001', 'mercari', 'shop4'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', NULL, '10000000-0000-4000-8000-000000000003', 'mercari', 'shop4');

-- Exact shop + listing + variant identity wins over the listing fallback.
INSERT INTO public.inquiries(shop_key, external_target_type, external_product_id, external_product_variant_id)
VALUES ('Shop4', 'InquiryProductTarget', 'PRODUCT-1', 'VARIANT-1');

DO $$
DECLARE v public.inquiry_product_links%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v FROM public.inquiry_product_links WHERE inquiry_id = 1;
  IF v.product_variant_id <> '10000000-0000-4000-8000-000000000001'::uuid
     OR v.link_source <> 'worker_match' OR v.confidence <> 1.00 OR NOT v.is_primary THEN
    RAISE EXCEPTION 'exact variant link assertion failed: %', row_to_json(v);
  END IF;
END $$;

-- Ambiguous product-only mapping fails closed.
INSERT INTO public.inquiries(shop_key, external_target_type, external_product_id)
VALUES ('Shop4', 'InquiryProductTarget', 'PRODUCT-2');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.inquiry_product_links WHERE inquiry_id = 2) THEN
    RAISE EXCEPTION 'ambiguous product mapping must not link';
  END IF;
  IF public.inquiry_link_catalog_product(2) <> 'ambiguous_catalog_mapping' THEN
    RAISE EXCEPTION 'ambiguous result assertion failed';
  END IF;
END $$;

-- Order targets and operator-reviewed inquiries are never auto-linked.
INSERT INTO public.inquiries(shop_key, external_target_type, external_product_id, external_order_transaction_id)
VALUES ('Shop4', 'InquiryProductTarget', 'PRODUCT-3', 'ORDER-1');
INSERT INTO public.inquiries(shop_key, external_target_type, external_product_id, product_links_reviewed_at)
VALUES ('Shop4', 'InquiryProductTarget', 'PRODUCT-3', now());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.inquiry_product_links WHERE inquiry_id IN (3,4)) THEN
    RAISE EXCEPTION 'excluded inquiry was linked';
  END IF;
END $$;

-- Listing-only unique mapping links deterministically, and replay is idempotent.
INSERT INTO public.inquiries(shop_key, external_target_type, external_product_id)
VALUES ('Shop4', 'InquiryProductTarget', 'PRODUCT-3');
SELECT public.inquiry_link_catalog_product(5);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.inquiry_product_links WHERE inquiry_id = 5) <> 1 THEN
    RAISE EXCEPTION 'listing fallback/replay assertion failed';
  END IF;
END $$;

-- Production canary migration links exactly one latest eligible row.
ALTER TABLE public.inquiries DISABLE TRIGGER trg_inquiries_link_catalog_product;
INSERT INTO public.inquiries(shop_key, external_target_type, external_product_id)
VALUES ('Shop4', 'InquiryProductTarget', 'PRODUCT-3');
ALTER TABLE public.inquiries ENABLE TRIGGER trg_inquiries_link_catalog_product;
\ir ../../supabase/migrations/20260904000100_canary_latest_api_inquiry_product_link.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM public.inquiry_product_links WHERE inquiry_id = 6) <> 1 THEN
    RAISE EXCEPTION 'bounded production canary assertion failed';
  END IF;
END $$;
\ir ../../supabase/migrations/20260904000200_backfill_api_inquiry_product_links.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM public.inquiry_product_links) <> 3 THEN
    RAISE EXCEPTION 'bounded backfill changed an ineligible or ambiguous row';
  END IF;
END $$;

SELECT 'deterministic product link tests passed' AS result;
