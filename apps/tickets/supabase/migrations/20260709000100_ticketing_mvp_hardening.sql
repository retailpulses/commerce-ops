-- ============================================================
-- Supabase Ticketing MVP — remote hardening follow-up
--
-- 20260709000000 was already applied to the linked Supabase
-- project before PR hardening. This migration repairs the remote
-- schema instead of relying on edits to an already-applied migration.
-- ============================================================

-- ── ticket_products: replace nullable composite PK with stable row ID ──

ALTER TABLE public.ticket_products
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

UPDATE public.ticket_products
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE public.ticket_products
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE ONLY public.ticket_products
  DROP CONSTRAINT IF EXISTS ticket_products_pkey;

ALTER TABLE ONLY public.ticket_products
  ADD CONSTRAINT ticket_products_pkey PRIMARY KEY (id);

ALTER TABLE public.ticket_products
  DROP CONSTRAINT IF EXISTS chk_ticket_products_has_ref;

ALTER TABLE public.ticket_products
  ADD CONSTRAINT chk_ticket_products_has_ref CHECK (
    product_id IS NOT NULL OR variant_id IS NOT NULL OR
    listing_id IS NOT NULL OR listing_sku_id IS NOT NULL
  ) NOT VALID;

ALTER TABLE public.ticket_products
  VALIDATE CONSTRAINT chk_ticket_products_has_ref;

CREATE INDEX IF NOT EXISTS idx_ticket_products_product_id
  ON public.ticket_products (product_id);

CREATE INDEX IF NOT EXISTS idx_ticket_products_variant_id
  ON public.ticket_products (variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_products_link
  ON public.ticket_products (
    ticket_id,
    COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(listing_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(listing_sku_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ── ticket_attachments: add missing Slice 1B evidence table ──

CREATE TABLE IF NOT EXISTS public.ticket_attachments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id              uuid REFERENCES public.tickets(id) ON DELETE CASCADE,
  customer_submission_id uuid,
  storage_bucket         text NOT NULL,
  storage_path           text NOT NULL,
  original_url           text,
  filename               text,
  mime_type              text,
  media_type             text NOT NULL CHECK (media_type IN ('image','video','file')),
  size_bytes             bigint,
  source                 text NOT NULL CHECK (source IN (
                           'customer_form','customer_submission','platform_message',
                           'operator_upload','imported_baserow'
                         )),
  metadata               jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ticket_attachments_parent CHECK (
    ticket_id IS NOT NULL OR customer_submission_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket
  ON public.ticket_attachments (ticket_id, created_at DESC);

ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

-- ── RLS: Worker uses service_role; do not expose broad authenticated access ──

DROP POLICY IF EXISTS "Allow all on tickets" ON public.tickets;
DROP POLICY IF EXISTS "Allow all on ticket_products" ON public.ticket_products;
DROP POLICY IF EXISTS "Allow all on ticket_events" ON public.ticket_events;
DROP POLICY IF EXISTS "Allow all on ticket_resolution_actions" ON public.ticket_resolution_actions;
DROP POLICY IF EXISTS "Allow all on ticket_messages" ON public.ticket_messages;
DROP POLICY IF EXISTS "Allow all on ticket_notes" ON public.ticket_notes;
DROP POLICY IF EXISTS "Allow all on ticket_attachments" ON public.ticket_attachments;

-- ── Views: include actual attachment counts and search columns ──
-- Keep the existing ticket_list_view column order stable for CREATE OR REPLACE.
-- Postgres allows appending columns to a view, but not dropping/renaming them.

CREATE OR REPLACE VIEW public.ticket_list_view AS
SELECT
  t.id AS ticket_id,
  t.ticket_number,
  t.platform,
  t.account_id,
  pa.display_name AS account_display_name,
  t.external_order_id,
  t.status,
  t.priority,
  t.issue_types,
  t.customer_display_name,
  t.subject AS product_name,
  tp.sku AS primary_sku,
  t.latest_message_at,
  t.latest_customer_message,
  t.needs_reply,
  t.external_url,
  t.assigned_user_id,
  t.assigned_display_name,
  t.origin,
  t.started_at,
  t.created_at,
  t.updated_at,
  COALESCE(ta.attachment_count, 0)::integer AS attachment_count,
  COALESCE(nt.note_count, 0) AS note_count,
  COALESCE(te.event_count, 0) AS event_count,
  t.subject,
  t.description
FROM public.tickets t
LEFT JOIN public.platform_accounts pa ON pa.id = t.account_id
LEFT JOIN public.ticket_products tp ON t.id = tp.ticket_id AND tp.role = 'primary'::text
LEFT JOIN LATERAL (
  SELECT count(*) AS note_count
  FROM public.ticket_notes
  WHERE ticket_id = t.id
) nt ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS attachment_count
  FROM public.ticket_attachments
  WHERE ticket_id = t.id
) ta ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS event_count
  FROM public.ticket_events
  WHERE ticket_id = t.id
) te ON true;

-- ── updated_at support for notes ──

DROP TRIGGER IF EXISTS trg_ticket_notes_updated_at ON public.ticket_notes;
CREATE TRIGGER trg_ticket_notes_updated_at
  BEFORE UPDATE ON public.ticket_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ── metadata ──

COMMENT ON TABLE public.tickets IS 'MVP ticketing — manual ticket creation, Mercari-first';
COMMENT ON TABLE public.ticket_products IS 'Links tickets to existing product/variant/listing master data';
COMMENT ON TABLE public.ticket_messages IS 'Customer/platform/operator-facing communication history';
COMMENT ON TABLE public.ticket_notes IS 'Internal operator notes';
COMMENT ON TABLE public.ticket_attachments IS 'Ticket evidence and uploaded files';
COMMENT ON TABLE public.ticket_events IS 'Immutable audit trail for all ticket workflow changes';
COMMENT ON TABLE public.ticket_resolution_actions IS 'Business outcomes: refunds, replacements, escalations';
