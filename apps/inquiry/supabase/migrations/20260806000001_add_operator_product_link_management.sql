-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiries, inquiry_product_links, inquiry_detail_vw
-- Change class: additive
-- Hosted write required: yes
-- Consumers: inquiry-automation dashboard (operator product link/unlink via RPC), worker (re-link guard)
--
-- Phase 1 MVP: operator-controlled product link management.
-- Adds:
--   1. inquiries.product_links_reviewed_at — worker re-link guard
--   2. operator_unlink_product RPC — atomic delete + primary promotion + review marker
--   3. operator_set_primary_link RPC — atomic demote + upsert + review marker
--   4. Updated inquiry_detail_vw — exposes linkRowId (junction PK) for delete targeting

-- =============================================================================
-- 1. Worker re-link guard column
-- =============================================================================

ALTER TABLE public.inquiries
ADD COLUMN IF NOT EXISTS product_links_reviewed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.inquiries.product_links_reviewed_at
IS 'Set when operator links or unlinks a product via dashboard. Worker skips auto product-matching when this is set.';

-- =============================================================================
-- 2. RPC: operator_unlink_product — atomic delete + primary promotion + guard
-- =============================================================================

CREATE OR REPLACE FUNCTION public.operator_unlink_product(
  p_inquiry_id BIGINT,
  p_link_id BIGINT
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_was_primary BOOLEAN;
  v_deleted_count INT;
BEGIN
  -- Lock the link row to prevent concurrent modification
  SELECT is_primary INTO v_was_primary
  FROM public.inquiry_product_links
  WHERE id = p_link_id AND inquiry_id = p_inquiry_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link row % not found for inquiry %', p_link_id, p_inquiry_id;
  END IF;

  DELETE FROM public.inquiry_product_links
  WHERE id = p_link_id AND inquiry_id = p_inquiry_id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  IF v_deleted_count = 0 THEN
    RAISE EXCEPTION 'Failed to delete link row % for inquiry %', p_link_id, p_inquiry_id;
  END IF;

  -- If we removed the primary, promote the next oldest link
  IF v_was_primary THEN
    UPDATE public.inquiry_product_links
    SET is_primary = true
    WHERE id = (
      SELECT id FROM public.inquiry_product_links
      WHERE inquiry_id = p_inquiry_id
      ORDER BY linked_at ASC, id ASC
      LIMIT 1
      FOR UPDATE
    );
  END IF;

  -- Mark inquiry as operator-reviewed (prevents worker re-linking)
  UPDATE public.inquiries
  SET product_links_reviewed_at = NOW()
  WHERE id = p_inquiry_id;
END;
$$;

COMMENT ON FUNCTION public.operator_unlink_product(BIGINT, BIGINT)
IS 'Atomically deletes a product link row, promotes the next primary if needed, and marks the inquiry as operator-reviewed.';

-- =============================================================================
-- 3. RPC: operator_set_primary_link — atomic demote + upsert + guard
-- =============================================================================

CREATE OR REPLACE FUNCTION public.operator_set_primary_link(
  p_inquiry_id BIGINT,
  p_product_variant_id UUID,
  p_item_code_snapshot TEXT,
  p_product_name_snapshot TEXT
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_existing_id BIGINT;
  v_snapshot TEXT;
BEGIN
  -- Treat empty strings as NULL for unique-constraint safety
  v_snapshot := NULLIF(p_item_code_snapshot, '');

  -- Lock existing links for this inquiry
  PERFORM id FROM public.inquiry_product_links
  WHERE inquiry_id = p_inquiry_id
  FOR UPDATE;

  -- Delete conflicting duplicate rows: if one row matches by UUID and another
  -- matches by item_code, keep the UUID match and remove the item_code match
  -- to avoid unique-constraint violations during upsert.
  DELETE FROM public.inquiry_product_links
  WHERE inquiry_id = p_inquiry_id
    AND id NOT IN (
      SELECT id FROM public.inquiry_product_links
      WHERE inquiry_id = p_inquiry_id
        AND (product_variant_id = p_product_variant_id OR item_code_snapshot = v_snapshot)
      ORDER BY
        CASE WHEN product_variant_id = p_product_variant_id THEN 0 ELSE 1 END
      LIMIT 1
    )
    AND (product_variant_id = p_product_variant_id OR item_code_snapshot = v_snapshot);

  -- Find existing link by variant ID or item code
  SELECT id INTO v_existing_id
  FROM public.inquiry_product_links
  WHERE inquiry_id = p_inquiry_id
    AND (product_variant_id = p_product_variant_id OR item_code_snapshot = v_snapshot)
  ORDER BY
    CASE WHEN product_variant_id = p_product_variant_id THEN 0 ELSE 1 END
  LIMIT 1;

  -- Demote all current primary links
  UPDATE public.inquiry_product_links
  SET is_primary = false
  WHERE inquiry_id = p_inquiry_id AND is_primary = true;

  -- Upsert the operator link as new primary
  IF v_existing_id IS NOT NULL THEN
    UPDATE public.inquiry_product_links
    SET product_variant_id = p_product_variant_id,
        item_code_snapshot = v_snapshot,
        product_name_snapshot = p_product_name_snapshot,
        is_primary = true,
        link_source = 'operator',
        confidence = NULL
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO public.inquiry_product_links
      (inquiry_id, product_variant_id, item_code_snapshot, product_name_snapshot,
       is_primary, link_source, confidence)
    VALUES
      (p_inquiry_id, p_product_variant_id, v_snapshot, p_product_name_snapshot,
       true, 'operator', NULL);
  END IF;

  -- Mark inquiry as operator-reviewed (prevents worker re-linking)
  UPDATE public.inquiries
  SET product_links_reviewed_at = NOW()
  WHERE id = p_inquiry_id;
END;
$$;

COMMENT ON FUNCTION public.operator_set_primary_link(BIGINT, UUID, TEXT, TEXT)
IS 'Atomically sets a product as the primary linked product for an inquiry. Demotes existing primaries, upserts the link as operator-owned, and marks the inquiry as operator-reviewed.';

-- =============================================================================
-- 4. Update inquiry_detail_vw to expose linkRowId, linkSource, confidence
-- =============================================================================

CREATE OR REPLACE VIEW public.inquiry_detail_vw
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  i.id,
  i.baserow_row_id,
  i.legacy_mercari_inquiries_id,
  i.source,
  i.external_inquiry_id,
  i.external_thread_id,
  i.url,
  i.shop_key,
  i.platform_account_id,
  i.status,
  i.automation_status,
  i.follow_up_status,
  i.inquiry_type,
  i.deleted_at,
  i.inquiry_date,
  i.inquiry_body,
  i.customer_nickname,
  i.product_name_snapshot,
  i.sender_email,
  i.receiving_email,
  i.last_inbound_time,
  i.last_custom_message,
  i.message_log_raw,
  i.order_id,
  i.seller,
  i.draft_reply,
  i.reply_strategy,
  i.inquiry_skill_reply,
  i.reply_drafted_at,
  i.ai_copywritten_reply,
  i.ai_copywritten_at,
  i.reply_assist_status,
  i.reply_assist_request_id,
  i.reply_assist_last_result,
  i.mercari_product_id,
  i.mercari_variant_name,
  i.units,
  i.effective_price_excl_shipping,
  i.effective_price_incl_shipping,
  i.effective_tcogs,
  i.expected_value,
  i.follow_up_sent_at,
  i.notes,
  -- Linked products as JSONB array with provenance + linkRowId for delete targeting
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', ipl.product_variant_id,          -- unchanged: UUID of product variant
          'linkRowId', ipl.id,                    -- NEW: junction table BIGINT PK for delete targeting
          'itemCode', ipl.item_code_snapshot,
          'productName', ipl.product_name_snapshot,
          'isPrimary', ipl.is_primary,
          'linkSource', ipl.link_source,
          'confidence', ipl.confidence
        ) ORDER BY ipl.is_primary DESC, ipl.linked_at ASC, ipl.id ASC
      )
      FROM public.inquiry_product_links ipl
      WHERE ipl.inquiry_id = i.id
    ),
    '[]'::jsonb
  ) AS linked_products,
  -- Linked knowledge articles as JSONB array
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', ka.id,
          'title', ka.title,
          'tag', ka.tag
        ) ORDER BY ka.title ASC
      )
      FROM public.inquiry_knowledge_links ikl
      JOIN public.knowledge_articles ka ON ikl.knowledge_article_id = ka.id
      WHERE ikl.inquiry_id = i.id
    ),
    '[]'::jsonb
  ) AS linked_knowledge,
  i.extra,
  i.created_at,
  i.updated_at,
  i.product_links_reviewed_at   -- NEW: worker re-link guard (appended to end for CREATE OR REPLACE compatibility)
FROM public.inquiries i
WHERE i.deleted_at IS NULL;

COMMENT ON VIEW public.inquiry_detail_vw
IS 'Phase 1 dashboard detail view. Pre-joined linked_products (with linkRowId and provenance) and linked_knowledge as JSONB arrays.';

-- Re-apply grants after CREATE OR REPLACE VIEW
REVOKE ALL ON TABLE public.inquiry_detail_vw FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inquiry_detail_vw TO service_role;

-- =============================================================================
-- 5. RPC security grants
-- =============================================================================

REVOKE ALL ON FUNCTION public.operator_unlink_product(BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operator_unlink_product(BIGINT, BIGINT) TO service_role;

REVOKE ALL ON FUNCTION public.operator_set_primary_link(BIGINT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operator_set_primary_link(BIGINT, UUID, TEXT, TEXT) TO service_role;
