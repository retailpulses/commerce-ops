-- Supabase Ticketing MVP — Core Schema Migration
-- Spec: docs/trd/supabase-ticketing-mvp-spec.md v0.3
-- Slice: 1A + 1B (Create/View Tickets, Communication, Evidence)
-- Tables: tickets, ticket_products, ticket_messages, ticket_notes, ticket_attachments,
--         ticket_events, ticket_resolution_actions
-- Views:  ticket_list_view, ticket_detail_view

-- ============================================================================
-- 1. Helper: ticket_number generation
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS ticket_number_seq;

CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS trigger AS $$
BEGIN
  NEW.ticket_number := 'T-' || to_char(COALESCE(NEW.created_at, now()), 'YYYYMMDD')
                    || '-' || lpad(nextval('ticket_number_seq')::text, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 2. tickets
-- ============================================================================

CREATE TABLE tickets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number             text UNIQUE NOT NULL,
  legacy_baserow_id         integer UNIQUE,
  platform                  text NOT NULL,
  account_id                uuid REFERENCES platform_accounts(id),
  external_order_id         text,
  external_thread_id        text,
  origin                    text NOT NULL DEFAULT 'manual',
  customer_display_name     text,
  customer_contact          text,
  subject                   text,
  description               text,
  status                    text NOT NULL DEFAULT 'open',
  priority                  text NOT NULL DEFAULT 'normal',
  issue_types               text[] NOT NULL DEFAULT '{}',
  assigned_user_id          uuid,
  assigned_display_name     text,
  latest_message_at         timestamptz,
  latest_customer_message   text,
  needs_reply               boolean NOT NULL DEFAULT false,
  external_url              text,
  raw_source_payload        jsonb NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  closed_at                 timestamptz
);

-- Check constraints (text-based, not enums — spec §7.2 MVP validation decision)
ALTER TABLE tickets ADD CONSTRAINT chk_tickets_platform
  CHECK (platform IN ('mercari', 'amazon', 'rakuten', 'other'));

ALTER TABLE tickets ADD CONSTRAINT chk_tickets_status
  CHECK (status IN ('open', 'in_progress', 'pending_customer', 'pending_third_party',
                    'resolved', 'closed', 'canceled'));

ALTER TABLE tickets ADD CONSTRAINT chk_tickets_priority
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

ALTER TABLE tickets ADD CONSTRAINT chk_tickets_origin
  CHECK (origin IN ('manual', 'platform_ingest', 'migrated_baserow', 'form_submission'));

-- Partial unique index: one ticket per platform order when external_order_id is known
CREATE UNIQUE INDEX uq_tickets_platform_order
  ON tickets (platform, account_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

-- Trigger for ticket_number auto-generation
CREATE TRIGGER trg_ticket_number
  BEFORE INSERT ON tickets
  FOR EACH ROW
  WHEN (NEW.ticket_number IS NULL)
  EXECUTE FUNCTION generate_ticket_number();

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Indexes for common query patterns
CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_tickets_platform ON tickets (platform);
CREATE INDEX idx_tickets_account_id ON tickets (account_id);
CREATE INDEX idx_tickets_assigned_user_id ON tickets (assigned_user_id);
CREATE INDEX idx_tickets_created_at_desc ON tickets (created_at DESC);
CREATE INDEX idx_tickets_needs_reply ON tickets (needs_reply) WHERE needs_reply = true;
CREATE INDEX idx_tickets_latest_message_at ON tickets (latest_message_at DESC);
CREATE INDEX idx_tickets_external_order_id ON tickets (external_order_id) WHERE external_order_id IS NOT NULL;

-- ============================================================================
-- 3. ticket_products — relationship table (spec §7.7)
-- ============================================================================

CREATE TABLE ticket_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES products(id),
  variant_id      uuid REFERENCES product_variants(id),
  listing_id      uuid REFERENCES platform_listings(id),
  listing_sku_id  uuid REFERENCES platform_listing_skus(id),
  sku             text NOT NULL,
  quantity        integer,
  role            text NOT NULL DEFAULT 'related',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- At least one product reference should be populated
  CONSTRAINT chk_ticket_products_has_ref CHECK (
    product_id IS NOT NULL OR variant_id IS NOT NULL OR
    listing_id IS NOT NULL OR listing_sku_id IS NOT NULL
  )
);

ALTER TABLE ticket_products ADD CONSTRAINT chk_ticket_products_role
  CHECK (role IN ('primary', 'related', 'replacement', 'returned'));

CREATE INDEX idx_ticket_products_ticket_id ON ticket_products (ticket_id);
CREATE INDEX idx_ticket_products_product_id ON ticket_products (product_id);
CREATE INDEX idx_ticket_products_variant_id ON ticket_products (variant_id);
CREATE INDEX idx_ticket_products_sku ON ticket_products (sku);

-- Prevent duplicate product links per ticket
CREATE UNIQUE INDEX uq_ticket_products_link
  ON ticket_products (ticket_id, COALESCE(product_id, '00000000-0000-0000-0000-000000000000'),
                      COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'),
                      COALESCE(listing_id, '00000000-0000-0000-0000-000000000000'),
                      COALESCE(listing_sku_id, '00000000-0000-0000-0000-000000000000'));

-- ============================================================================
-- 4. ticket_messages — customer/platform/operator-facing communication history
-- ============================================================================

CREATE TABLE ticket_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id            uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  platform             text NOT NULL,
  external_message_id  text,
  sender_type          text NOT NULL,
  sender_display_name  text,
  body                 text NOT NULL,
  sent_at              timestamptz NOT NULL DEFAULT now(),
  raw_payload          jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ticket_messages ADD CONSTRAINT chk_ticket_messages_platform
  CHECK (platform IN ('mercari', 'amazon', 'rakuten', 'other'));

ALTER TABLE ticket_messages ADD CONSTRAINT chk_ticket_messages_sender_type
  CHECK (sender_type IN ('customer', 'seller', 'operator', 'system', 'automation'));

CREATE INDEX idx_ticket_messages_ticket_id ON ticket_messages (ticket_id);
CREATE INDEX idx_ticket_messages_sent_at ON ticket_messages (ticket_id, sent_at DESC);
CREATE INDEX idx_ticket_messages_external_id ON ticket_messages (external_message_id)
  WHERE external_message_id IS NOT NULL;

-- ============================================================================
-- 5. ticket_notes — internal operator notes
-- ============================================================================

CREATE TABLE ticket_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

CREATE TRIGGER trg_ticket_notes_updated_at
  BEFORE UPDATE ON ticket_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_ticket_notes_ticket_id ON ticket_notes (ticket_id);
CREATE INDEX idx_ticket_notes_created_at ON ticket_notes (ticket_id, created_at DESC);

-- ============================================================================
-- 6. ticket_attachments — ticket/customer evidence files
-- ============================================================================

CREATE TABLE ticket_attachments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id               uuid REFERENCES tickets(id) ON DELETE CASCADE,
  customer_submission_id  uuid,
  storage_bucket          text NOT NULL,
  storage_path            text NOT NULL,
  original_url            text,
  filename                text,
  mime_type               text,
  media_type              text NOT NULL,
  size_bytes              bigint,
  source                  text NOT NULL,
  metadata                jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ticket_attachments_parent CHECK (
    ticket_id IS NOT NULL OR customer_submission_id IS NOT NULL
  )
);

ALTER TABLE ticket_attachments ADD CONSTRAINT chk_ticket_attachments_media_type
  CHECK (media_type IN ('image', 'video', 'file'));

ALTER TABLE ticket_attachments ADD CONSTRAINT chk_ticket_attachments_source
  CHECK (source IN ('customer_form', 'customer_submission', 'platform_message', 'operator_upload', 'imported_baserow'));

CREATE INDEX idx_ticket_attachments_ticket_id ON ticket_attachments (ticket_id);
CREATE INDEX idx_ticket_attachments_created_at ON ticket_attachments (ticket_id, created_at DESC);

-- ============================================================================
-- 7. ticket_events — audit trail (spec §7.4)
-- ============================================================================

CREATE TABLE ticket_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  actor_type  text NOT NULL DEFAULT 'system',
  actor_id    text,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ticket_events ADD CONSTRAINT chk_ticket_events_event_type
  CHECK (event_type IN (
    'ticket_created', 'ticket_reopened', 'message_added', 'message_received',
    'message_sent', 'status_changed', 'priority_changed', 'resolution_updated',
    'attachment_added', 'product_linked', 'product_unlinked', 'note_added',
    'ai_reply_generated', 'operator_escalated', 'wecom_notified',
    'platform_sync_failed'
  ));

ALTER TABLE ticket_events ADD CONSTRAINT chk_ticket_events_actor_type
  CHECK (actor_type IN ('system', 'operator', 'customer', 'automation', 'platform'));

CREATE INDEX idx_ticket_events_ticket_id ON ticket_events (ticket_id);
CREATE INDEX idx_ticket_events_created_at ON ticket_events (ticket_id, created_at DESC);
CREATE INDEX idx_ticket_events_type ON ticket_events (event_type);

-- ============================================================================
-- 8. ticket_resolution_actions — business outcomes (spec §7.4.2)
-- ============================================================================

CREATE TABLE ticket_resolution_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  action_type      text NOT NULL,
  amount           numeric,
  currency         text DEFAULT 'JPY',
  replacement_sku  text,
  quantity         integer,
  reason           text,
  approved_by      text,
  executed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ticket_resolution_actions ADD CONSTRAINT chk_ticket_resolution_action_type
  CHECK (action_type IN (
    'full_refund', 'partial_refund', 'replacement', 'return_request',
    'address_change', 'cancel_order', 'information_only', 'seller_escalation',
    'platform_escalation', 'no_action'
  ));

CREATE INDEX idx_ticket_resolution_actions_ticket_id ON ticket_resolution_actions (ticket_id);

-- ============================================================================
-- 9. Views — read models for UI (spec §8)
-- ============================================================================

-- ticket_list_view: single-row-per-ticket summary for list rendering
CREATE OR REPLACE VIEW ticket_list_view AS
SELECT
  t.id                                  AS ticket_id,
  t.ticket_number,
  t.platform,
  t.account_id,
  pa.display_name                       AS account_display_name,
  t.external_order_id,
  t.status,
  t.priority,
  t.issue_types,
  t.customer_display_name,
  t.subject                             AS product_name,  -- fallback; overridden by primary product join
  tp.sku                                AS primary_sku,
  t.latest_message_at,
  t.latest_customer_message,
  t.needs_reply,
  t.external_url,
  t.assigned_user_id,
  t.assigned_display_name,
  t.origin,
  t.created_at,
  t.updated_at,
  -- Counts via subqueries for list badges
  (SELECT count(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id)  AS attachment_count,
  (SELECT count(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id)        AS note_count,
  (SELECT count(*) FROM ticket_events te WHERE te.ticket_id = t.id)       AS event_count
FROM tickets t
LEFT JOIN platform_accounts pa ON t.account_id = pa.id
LEFT JOIN ticket_products tp ON t.id = tp.ticket_id AND tp.role = 'primary';

-- ticket_detail_view: full ticket with aggregated product list and account info
CREATE OR REPLACE VIEW ticket_detail_view AS
SELECT
  t.id,
  t.ticket_number,
  t.legacy_baserow_id,
  t.platform,
  t.account_id,
  pa.display_name                       AS account_display_name,
  pa.shop_code                          AS account_shop_code,
  pa.platform                           AS account_platform,
  t.external_order_id,
  t.external_thread_id,
  t.origin,
  t.customer_display_name,
  t.customer_contact,
  t.subject,
  t.description,
  t.status,
  t.priority,
  t.issue_types,
  t.assigned_user_id,
  t.assigned_display_name,
  t.latest_message_at,
  t.latest_customer_message,
  t.needs_reply,
  t.external_url,
  t.raw_source_payload,
  t.created_at,
  t.updated_at,
  t.closed_at,
  -- Aggregated product list as JSON array for detail rendering
  (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp2.id,
      'product_id', tp2.product_id,
      'variant_id', tp2.variant_id,
      'listing_id', tp2.listing_id,
      'listing_sku_id', tp2.listing_sku_id,
      'sku', tp2.sku,
      'quantity', tp2.quantity,
      'role', tp2.role,
      'product_title', p.title,
      'variant_name', pv.variant_name,
      'listing_title', pl.title
    ) ORDER BY tp2.role = 'primary' DESC, tp2.created_at ASC)
    FROM ticket_products tp2
    LEFT JOIN products p ON tp2.product_id = p.id
    LEFT JOIN product_variants pv ON tp2.variant_id = pv.id
    LEFT JOIN platform_listings pl ON tp2.listing_id = pl.id
    WHERE tp2.ticket_id = t.id
  )                                     AS products,
  -- Counts
  (SELECT count(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id)  AS attachment_count,
  (SELECT count(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id)        AS note_count,
  (SELECT count(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id)     AS message_count,
  (SELECT count(*) FROM ticket_events te WHERE te.ticket_id = t.id)       AS event_count
FROM tickets t
LEFT JOIN platform_accounts pa ON t.account_id = pa.id;

-- ============================================================================
-- 10. RLS — locked down until operator auth/RLS model is finalized
-- ============================================================================

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_resolution_actions ENABLE ROW LEVEL SECURITY;

-- No public/anon policies in MVP. Server-side Worker operations use service role,
-- which bypasses RLS. Add scoped operator policies only after auth is finalized.

-- ============================================================================
-- 11. Migration metadata
-- ============================================================================

COMMENT ON TABLE tickets IS 'MVP ticketing — manual ticket creation, Mercari-first';
COMMENT ON TABLE ticket_products IS 'Links tickets to existing product/variant/listing master data';
COMMENT ON TABLE ticket_messages IS 'Customer/platform/operator-facing communication history';
COMMENT ON TABLE ticket_notes IS 'Internal operator notes';
COMMENT ON TABLE ticket_attachments IS 'Ticket evidence and uploaded files';
COMMENT ON TABLE ticket_events IS 'Immutable audit trail for all ticket workflow changes';
COMMENT ON TABLE ticket_resolution_actions IS 'Business outcomes: refunds, replacements, escalations';
