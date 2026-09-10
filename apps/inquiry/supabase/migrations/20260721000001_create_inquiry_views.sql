-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiry_list_vw, inquiry_detail_vw
-- Change class: additive
-- Hosted write required: yes
-- Consumers: inquiry-automation dashboard (server-side reads via PostgREST)
--
-- Phase 1 MVP dashboard views. Views use explicit schema qualification.
-- Security: views are queryable only by service_role (worker_only access class).
-- If non-service roles are later granted access, security_invoker behavior must be tested.

-- =============================================================================
-- 1. Inquiry list view (for dashboard list endpoint)
-- =============================================================================

CREATE OR REPLACE VIEW public.inquiry_list_vw
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  i.id,
  i.status,
  i.automation_status,
  i.follow_up_status,
  i.inquiry_type,
  i.customer_nickname,
  i.product_name_snapshot,
  i.inquiry_date,
  i.url,
  i.shop_key,
  i.units,
  i.effective_price_excl_shipping,
  i.effective_price_incl_shipping,
  i.effective_tcogs,
  i.expected_value,
  i.sender_email,
  i.receiving_email,
  i.last_inbound_time,
  i.deleted_at,
  -- Computed flags matching current dashboard behavior
  (i.draft_reply IS NOT NULL AND i.draft_reply != '') AS has_draft,
  (i.ai_copywritten_reply IS NOT NULL AND i.ai_copywritten_reply != '') AS has_copywrite,
  (EXISTS (
    SELECT 1 FROM public.inquiry_product_links ipl
    WHERE ipl.inquiry_id = i.id
  )) AS has_product,
  i.created_at,
  i.updated_at
FROM public.inquiries i
WHERE i.deleted_at IS NULL;

COMMENT ON VIEW public.inquiry_list_vw IS 'Phase 1 dashboard list view. Pre-joined flags for has_draft, has_copywrite, has_product.';

-- =============================================================================
-- 2. Inquiry detail view (for dashboard detail endpoint)
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
  -- Linked products as JSONB array (matching current dashboard ProductLink[] shape)
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', ipl.product_variant_id,
          'itemCode', ipl.item_code_snapshot,
          'productName', ipl.product_name_snapshot,
          'isPrimary', ipl.is_primary,
          'linkSource', ipl.link_source,
          'confidence', ipl.confidence
        ) ORDER BY ipl.is_primary DESC, ipl.linked_at ASC
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
  i.updated_at
FROM public.inquiries i
WHERE i.deleted_at IS NULL;

COMMENT ON VIEW public.inquiry_detail_vw IS 'Phase 1 dashboard detail view. Pre-joined linked_products and linked_knowledge as JSONB arrays.';

REVOKE ALL ON TABLE public.inquiry_list_vw FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_detail_vw FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inquiry_list_vw TO service_role;
GRANT SELECT ON TABLE public.inquiry_detail_vw TO service_role;
