-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiry_product_links (one bounded production canary row)
-- Change class: bounded data repair, idempotent
-- Hosted write required: yes; exactly one latest eligible inquiry
-- Consumers: deployment verification only
-- Purpose: prove the deterministic API inquiry product resolver against one
-- recent production row before any wider backfill.

DO $$
DECLARE
  v_inquiry_id BIGINT;
  v_result TEXT;
BEGIN
  SELECT i.id INTO v_inquiry_id
  FROM public.inquiries i
  WHERE i.deleted_at IS NULL
    AND i.external_target_type = 'InquiryProductTarget'
    AND i.external_order_transaction_id IS NULL
    AND i.product_links_reviewed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.inquiry_product_links ipl
      WHERE ipl.inquiry_id = i.id
    )
  ORDER BY i.inquiry_date DESC NULLS LAST, i.id DESC
  LIMIT 1;

  IF v_inquiry_id IS NULL THEN
    RAISE NOTICE 'product link canary skipped: no eligible inquiry';
    RETURN;
  END IF;

  v_result := public.inquiry_link_catalog_product(v_inquiry_id);
  IF v_result NOT IN ('linked_by_variant_id', 'linked_by_product_id') THEN
    RAISE EXCEPTION 'product link canary failed: %', v_result;
  END IF;

  RAISE NOTICE 'product link canary completed: %', v_result;
END;
$$;
