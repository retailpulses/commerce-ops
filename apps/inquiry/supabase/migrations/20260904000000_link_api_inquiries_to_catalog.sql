-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiry_product_links, inquiries; reads product_catalog mappings
-- Change class: additive, idempotent
-- Hosted write required: yes; deploy function/trigger first, then bounded canary
-- Consumers: inquiry API ingestion trigger; operator Inquiry Portal detail/pricing
-- Purpose: deterministically link Mercari API product inquiries to canonical
-- product variants. No title/name matching is permitted.

CREATE OR REPLACE FUNCTION public.inquiry_link_catalog_product(
  p_inquiry_id BIGINT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inquiry public.inquiries%ROWTYPE;
  v_priority INTEGER;
  v_variant_count INTEGER;
  v_variant_id UUID;
  v_item_code TEXT;
  v_product_name TEXT;
BEGIN
  SELECT * INTO v_inquiry
  FROM public.inquiries
  WHERE id = p_inquiry_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN 'inquiry_not_found'; END IF;
  IF v_inquiry.deleted_at IS NOT NULL THEN RETURN 'deleted'; END IF;
  IF v_inquiry.external_target_type IS DISTINCT FROM 'InquiryProductTarget'
     OR v_inquiry.external_order_transaction_id IS NOT NULL THEN
    RETURN 'not_presales_product_target';
  END IF;
  IF v_inquiry.product_links_reviewed_at IS NOT NULL THEN
    RETURN 'operator_reviewed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inquiry_product_links
    WHERE inquiry_id = p_inquiry_id
  ) THEN
    RETURN 'already_linked';
  END IF;
  IF NULLIF(v_inquiry.shop_key, '') IS NULL
     OR NULLIF(v_inquiry.external_product_id, '') IS NULL THEN
    RETURN 'missing_external_identity';
  END IF;

  WITH candidates AS (
    -- Exact Mercari variant identity is authoritative when present.
    SELECT 1 AS priority, COALESCE(ppl.variant_id, pls.variant_id) AS variant_id
    FROM public.platform_listings pl
    JOIN public.platform_listing_skus pls ON pls.listing_id = pl.id
    LEFT JOIN public.product_platform_links ppl
      ON ppl.listing_sku_id = pls.id
     AND lower(btrim(ppl.platform)) = 'mercari'
     AND lower(btrim(ppl.shop_code)) = lower(btrim(v_inquiry.shop_key))
    WHERE lower(btrim(pl.platform)) = 'mercari'
      AND lower(btrim(pl.shop_code)) = lower(btrim(v_inquiry.shop_key))
      AND pl.external_listing_id = v_inquiry.external_product_id
      AND NULLIF(v_inquiry.external_product_variant_id, '') IS NOT NULL
      AND pls.external_sku_id = v_inquiry.external_product_variant_id

    UNION ALL

    -- Listing identity is a safe fallback only when it resolves to one variant.
    SELECT 2 AS priority, COALESCE(ppl.variant_id, pl.variant_id) AS variant_id
    FROM public.platform_listings pl
    LEFT JOIN public.product_platform_links ppl
      ON ppl.listing_id = pl.id
     AND lower(btrim(ppl.platform)) = 'mercari'
     AND lower(btrim(ppl.shop_code)) = lower(btrim(v_inquiry.shop_key))
    WHERE lower(btrim(pl.platform)) = 'mercari'
      AND lower(btrim(pl.shop_code)) = lower(btrim(v_inquiry.shop_key))
      AND pl.external_listing_id = v_inquiry.external_product_id
  ), chosen_priority AS (
    SELECT min(priority) AS priority
    FROM candidates
    WHERE variant_id IS NOT NULL
  ), chosen AS (
    SELECT DISTINCT c.variant_id
    FROM candidates c
    JOIN chosen_priority p ON p.priority = c.priority
    WHERE c.variant_id IS NOT NULL
  )
  SELECT p.priority, count(c.variant_id),
         (array_agg(c.variant_id ORDER BY c.variant_id) FILTER (WHERE c.variant_id IS NOT NULL))[1]
  INTO v_priority, v_variant_count, v_variant_id
  FROM chosen_priority p
  LEFT JOIN chosen c ON true
  GROUP BY p.priority;

  IF v_variant_count IS NULL OR v_variant_count = 0 THEN
    RETURN 'catalog_mapping_not_found';
  END IF;
  IF v_variant_count <> 1 THEN
    RETURN 'ambiguous_catalog_mapping';
  END IF;

  SELECT item_code, variant_name
  INTO v_item_code, v_product_name
  FROM public.product_variants
  WHERE id = v_variant_id;

  IF NOT FOUND THEN RETURN 'catalog_variant_not_found'; END IF;

  INSERT INTO public.inquiry_product_links (
    inquiry_id, product_variant_id, item_code_snapshot,
    product_name_snapshot, is_primary, link_source, confidence
  ) VALUES (
    p_inquiry_id, v_variant_id, NULLIF(v_item_code, ''),
    NULLIF(v_product_name, ''), true, 'worker_match', 1.00
  )
  ON CONFLICT (inquiry_id, product_variant_id)
    WHERE product_variant_id IS NOT NULL
  DO NOTHING;

  IF FOUND THEN
    RETURN CASE v_priority WHEN 1 THEN 'linked_by_variant_id' ELSE 'linked_by_product_id' END;
  END IF;
  RETURN 'already_linked';
END;
$$;

REVOKE ALL ON FUNCTION public.inquiry_link_catalog_product(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inquiry_link_catalog_product(BIGINT) TO service_role;

COMMENT ON FUNCTION public.inquiry_link_catalog_product(BIGINT) IS
  'Links one unreviewed presales Mercari product inquiry through exact shop + external variant/product IDs. Never uses names and never overrides existing/operator links.';

CREATE OR REPLACE FUNCTION public.inquiry_link_catalog_product_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.inquiry_link_catalog_product(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inquiries_link_catalog_product ON public.inquiries;
CREATE TRIGGER trg_inquiries_link_catalog_product
AFTER INSERT OR UPDATE OF
  external_target_type,
  external_product_id,
  external_product_variant_id,
  external_order_transaction_id,
  shop_key
ON public.inquiries
FOR EACH ROW
EXECUTE FUNCTION public.inquiry_link_catalog_product_trigger();

REVOKE ALL ON FUNCTION public.inquiry_link_catalog_product_trigger() FROM PUBLIC, anon, authenticated;

-- Bounded explicit backfill entrypoint. Callers advance by inquiry id and may
-- start with a small limit for a production canary/readback.
CREATE OR REPLACE FUNCTION public.inquiry_backfill_catalog_product_links(
  p_after_id BIGINT DEFAULT 0,
  p_limit INTEGER DEFAULT 10
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_result TEXT;
  v_scanned INTEGER := 0;
  v_linked INTEGER := 0;
  v_last_id BIGINT := p_after_id;
  v_results JSONB := '{}'::jsonb;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100';
  END IF;

  FOR v_row IN
    SELECT i.id
    FROM public.inquiries i
    WHERE i.id > p_after_id
      AND i.deleted_at IS NULL
      AND i.external_target_type = 'InquiryProductTarget'
      AND i.external_order_transaction_id IS NULL
      AND i.product_links_reviewed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.inquiry_product_links ipl
        WHERE ipl.inquiry_id = i.id
      )
    ORDER BY i.id
    LIMIT p_limit
  LOOP
    v_scanned := v_scanned + 1;
    v_last_id := v_row.id;
    v_result := public.inquiry_link_catalog_product(v_row.id);
    IF v_result IN ('linked_by_variant_id', 'linked_by_product_id') THEN
      v_linked := v_linked + 1;
    END IF;
    v_results := jsonb_set(
      v_results,
      ARRAY[v_result],
      to_jsonb(COALESCE((v_results->>v_result)::integer, 0) + 1),
      true
    );
  END LOOP;

  RETURN jsonb_build_object(
    'scanned', v_scanned,
    'linked', v_linked,
    'lastId', v_last_id,
    'results', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.inquiry_backfill_catalog_product_links(BIGINT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inquiry_backfill_catalog_product_links(BIGINT, INTEGER) TO service_role;

COMMENT ON FUNCTION public.inquiry_backfill_catalog_product_links(BIGINT, INTEGER) IS
  'Bounded idempotent backfill for unreviewed presales API inquiries. Returns counts only; use a small first batch as the production canary.';
