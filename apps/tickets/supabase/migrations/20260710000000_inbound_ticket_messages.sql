-- ============================================================
-- Issue #109: Inbound Ticket Messages — webhook message queue
-- ============================================================

-- ── inbound_ticket_messages — operator-visible webhook queue ──

CREATE TABLE IF NOT EXISTS inbound_ticket_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                text NOT NULL DEFAULT 'mercari_webhook'
                          CHECK (source IN ('mercari_webhook')),
  shop_name             text NOT NULL,
  shop_id               text NOT NULL,
  order_transaction_id  text NOT NULL,
  external_thread_id    text,
  customer_display_name text,
  product_summary       jsonb NOT NULL DEFAULT '{}',
  order_summary         jsonb NOT NULL DEFAULT '{}',
  latest_buyer_message  text,
  full_payload          jsonb NOT NULL DEFAULT '{}',
  linked_ticket_id      uuid REFERENCES tickets(id) ON DELETE SET NULL,
  queue_status          text NOT NULL DEFAULT 'unread'
                          CHECK (queue_status IN ('unread','read','linked','converted','ignored','archived')),
  review_status         text NOT NULL DEFAULT 'needs_review'
                          CHECK (review_status IN ('needs_review','reviewed','automation_candidate')),
  classification        jsonb NOT NULL DEFAULT '{}',
  classifier_version    text,
  webhook_received_at   timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  read_at               timestamptz,
  reviewed_at           timestamptz,
  idempotency_key       text UNIQUE NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS idx_inbound_queue_status
  ON inbound_ticket_messages (queue_status);

CREATE INDEX IF NOT EXISTS idx_inbound_review_status
  ON inbound_ticket_messages (review_status);

CREATE INDEX IF NOT EXISTS idx_inbound_shop
  ON inbound_ticket_messages (shop_name);

CREATE INDEX IF NOT EXISTS idx_inbound_linked_ticket
  ON inbound_ticket_messages (linked_ticket_id);

CREATE INDEX IF NOT EXISTS idx_inbound_transaction
  ON inbound_ticket_messages (order_transaction_id);

CREATE INDEX IF NOT EXISTS idx_inbound_received_at
  ON inbound_ticket_messages (received_at DESC);

-- Composite index: unread queue by shop (most common filtered query)
CREATE INDEX IF NOT EXISTS idx_inbound_unread_by_shop
  ON inbound_ticket_messages (shop_name, received_at DESC)
  WHERE queue_status = 'unread';

-- ── Auto-update updated_at ──

DROP TRIGGER IF EXISTS trg_inbound_ticket_messages_updated_at ON inbound_ticket_messages;
CREATE TRIGGER trg_inbound_ticket_messages_updated_at
  BEFORE UPDATE ON inbound_ticket_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──

ALTER TABLE inbound_ticket_messages ENABLE ROW LEVEL SECURITY;

-- No anon policies — service_role server-side access only (matching existing tables)

COMMENT ON TABLE inbound_ticket_messages IS 'Operator-visible inbound webhook message queue — Mercari webhook events surfaced for triage';
