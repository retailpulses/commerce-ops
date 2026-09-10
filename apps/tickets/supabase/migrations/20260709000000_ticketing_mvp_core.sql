-- ============================================================
-- Supabase Ticketing MVP — Core Schema Migration
-- Slice 1A + 1B: tickets, ticket_products, ticket_messages,
--                ticket_notes, ticket_attachments, ticket_events,
--                ticket_resolution_actions, views, indexes, RLS
-- ============================================================

-- ── Sequence for human-readable ticket numbers ──

CREATE SEQUENCE IF NOT EXISTS ticket_number_seq
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

-- ── tickets ──

CREATE TABLE IF NOT EXISTS tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text UNIQUE NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('mercari','amazon','rakuten','other')),
  account_id    uuid REFERENCES platform_accounts(id),
  external_order_id   text,
  external_thread_id  text,
  origin        text NOT NULL DEFAULT 'manual'
                  CHECK (origin IN ('manual','platform_ingest','migrated_baserow','form_submission')),
  customer_display_name text,
  customer_contact      text,
  subject        text,
  description    text,
  status         text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','pending_customer','pending_third_party','resolved','closed','canceled')),
  priority       text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  issue_types    text[] NOT NULL DEFAULT '{}',
  assigned_user_id     uuid,
  assigned_display_name text,
  latest_message_at       timestamptz,
  latest_customer_message text,
  needs_reply     boolean NOT NULL DEFAULT false,
  external_url    text,
  raw_source_payload jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);

-- ── Auto-generate ticket_number on insert ──

CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS trigger AS $$
BEGIN
  NEW.ticket_number := 'T-' || to_char(COALESCE(NEW.created_at, now()), 'YYYYMMDD')
                    || '-' || lpad(nextval('ticket_number_seq')::text, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticket_number ON tickets;
CREATE TRIGGER trg_ticket_number
  BEFORE INSERT ON tickets
  FOR EACH ROW
  WHEN (NEW.ticket_number IS NULL)
  EXECUTE FUNCTION generate_ticket_number();

-- ── Partial unique index: one ticket per platform order ──

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_platform_order
  ON tickets (platform, account_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

-- ── Standard lookup indexes ──

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets (priority);
CREATE INDEX IF NOT EXISTS idx_tickets_platform ON tickets (platform);
CREATE INDEX IF NOT EXISTS idx_tickets_account_id ON tickets (account_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_user_id ON tickets (assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_needs_reply ON tickets (needs_reply) WHERE needs_reply = true;
CREATE INDEX IF NOT EXISTS idx_tickets_latest_message_at ON tickets (latest_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_issue_types ON tickets USING gin (issue_types);

-- ── ticket_products — relationship table (not product master) ──

CREATE TABLE IF NOT EXISTS ticket_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  product_id     uuid REFERENCES products(id),
  variant_id     uuid REFERENCES product_variants(id),
  listing_id     uuid REFERENCES platform_listings(id),
  listing_sku_id uuid REFERENCES platform_listing_skus(id),
  sku            text NOT NULL,
  quantity       integer,
  role           text NOT NULL DEFAULT 'related'
                   CHECK (role IN ('primary','related','replacement','returned')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ticket_products_has_ref CHECK (
    product_id IS NOT NULL OR variant_id IS NOT NULL OR
    listing_id IS NOT NULL OR listing_sku_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_ticket_products_ticket ON ticket_products (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_products_sku ON ticket_products (sku);
CREATE INDEX IF NOT EXISTS idx_ticket_products_product_id ON ticket_products (product_id);
CREATE INDEX IF NOT EXISTS idx_ticket_products_variant_id ON ticket_products (variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_products_link
  ON ticket_products (
    ticket_id,
    COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(listing_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(listing_sku_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ── ticket_events — audit trail ──

CREATE TABLE IF NOT EXISTS ticket_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN (
                'ticket_created','ticket_reopened','message_added','message_received',
                'message_sent','status_changed','priority_changed','resolution_updated',
                'attachment_added','product_linked','product_unlinked','note_added',
                'ai_reply_generated','operator_escalated','wecom_notified','platform_sync_failed'
              )),
  actor_type  text NOT NULL CHECK (actor_type IN ('customer','operator','system','automation','platform')),
  actor_id    text,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events (ticket_id, created_at);

-- ── ticket_resolution_actions — business outcomes ──

CREATE TABLE IF NOT EXISTS ticket_resolution_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  action_type     text NOT NULL CHECK (action_type IN (
                    'full_refund','partial_refund','replacement','return_request',
                    'address_change','cancel_order','information_only',
                    'seller_escalation','platform_escalation','no_action'
                  )),
  amount          numeric,
  currency        text DEFAULT 'JPY',
  replacement_sku text,
  quantity        integer,
  reason          text,
  approved_by     text,
  executed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_resolution_actions_ticket ON ticket_resolution_actions (ticket_id);

-- ── ticket_messages — customer/platform/operator communication ──

CREATE TABLE IF NOT EXISTS ticket_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('mercari','amazon','rakuten','other')),
  external_message_id text,
  sender_type         text NOT NULL CHECK (sender_type IN ('customer','seller','operator','system','automation')),
  sender_display_name text,
  body                text NOT NULL,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  raw_payload         jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id, sent_at);

-- ── ticket_notes — internal operator notes ──

CREATE TABLE IF NOT EXISTS ticket_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body       text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes (ticket_id, created_at DESC);

-- ── ticket_attachments — evidence and uploaded files ──

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id              uuid REFERENCES tickets(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments (ticket_id, created_at DESC);

-- ── ticket_list_view — denormalized list query view ──

CREATE OR REPLACE VIEW ticket_list_view AS
SELECT
  t.id,
  t.ticket_number,
  t.platform,
  t.account_id,
  pa.display_name AS account_display_name,
  t.external_order_id,
  t.status,
  t.priority,
  t.issue_types,
  t.customer_display_name,
  t.subject,
  t.description,
  t.latest_message_at,
  t.latest_customer_message,
  t.needs_reply,
  t.external_url,
  t.created_at,
  -- Primary product info (first product marked 'primary', or first linked)
  COALESCE(primary_prod.product_name, first_prod.product_name) AS product_name,
  COALESCE(primary_prod.sku, first_prod.sku) AS primary_sku,
  COALESCE(primary_prod.seller_name, first_prod.seller_name) AS seller_name,
  COALESCE(ta.attachment_count, 0) AS attachment_count,
  COALESCE(nt.note_count, 0) AS note_count
FROM tickets t
LEFT JOIN platform_accounts pa ON pa.id = t.account_id
LEFT JOIN LATERAL (
  SELECT
    tp.sku,
    p.title AS product_name,
    NULL::text AS seller_name
  FROM ticket_products tp
  LEFT JOIN products p ON p.id = tp.product_id
  WHERE tp.ticket_id = t.id AND tp.role = 'primary'
  LIMIT 1
) primary_prod ON true
LEFT JOIN LATERAL (
  SELECT
    tp.sku,
    p.title AS product_name,
    NULL::text AS seller_name
  FROM ticket_products tp
  LEFT JOIN products p ON p.id = tp.product_id
  WHERE tp.ticket_id = t.id
  ORDER BY tp.created_at
  LIMIT 1
) first_prod ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS note_count
  FROM ticket_notes
  WHERE ticket_id = t.id
) nt ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS attachment_count
  FROM ticket_attachments
  WHERE ticket_id = t.id
) ta ON true;

-- ── ticket_detail_view — full detail with joins ──

CREATE OR REPLACE VIEW ticket_detail_view AS
SELECT
  t.*,
  pa.display_name AS account_display_name
FROM tickets t
LEFT JOIN platform_accounts pa ON pa.id = t.account_id;

-- ── RLS locked down until operator auth/RLS is finalized ──

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_resolution_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;

-- No public/anon policies in MVP. Server-side Worker operations use service_role,
-- which bypasses RLS. Add scoped operator policies only after auth is finalized.

-- ── Auto-update updated_at ──

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_ticket_notes_updated_at ON ticket_notes;
CREATE TRIGGER trg_ticket_notes_updated_at
  BEFORE UPDATE ON ticket_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE tickets IS 'MVP ticketing — manual ticket creation, Mercari-first';
COMMENT ON TABLE ticket_products IS 'Links tickets to existing product/variant/listing master data';
COMMENT ON TABLE ticket_messages IS 'Customer/platform/operator-facing communication history';
COMMENT ON TABLE ticket_notes IS 'Internal operator notes';
COMMENT ON TABLE ticket_attachments IS 'Ticket evidence and uploaded files';
COMMENT ON TABLE ticket_events IS 'Immutable audit trail for all ticket workflow changes';
COMMENT ON TABLE ticket_resolution_actions IS 'Business outcomes: refunds, replacements, escalations';
