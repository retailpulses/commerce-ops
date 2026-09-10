-- Supabase Ticketing MVP — Hotfix Migration
-- Adds: started_at column, ticket_issue_types config table, updated views
-- Issue: #96 hotfixes

-- ============================================================================
-- 1. ticket_issue_types — configurable registry of valid issue types
--    Operators manage this table (via Supabase dashboard initially).
--    The UI fetches active types dynamically. tickets.issue_types stores keys.
-- ============================================================================

CREATE TABLE ticket_issue_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text UNIQUE NOT NULL,
  display_name text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed initial issue types (8 values)
INSERT INTO ticket_issue_types (key, display_name, sort_order) VALUES
  ('quality_issue',       'Quality Issue',       1),
  ('logistic_issue',      'Logistic Issue',      2),
  ('return',              'Return',              3),
  ('refund',              'Refund',              4),
  ('replacement',         'Replacement',         5),
  ('rma',                 'RMA',                 6),
  ('bad_review',          'Bad Review',          7),
  ('others',              'Others',              8);

-- Trigger for updated_at
CREATE TRIGGER trg_ticket_issue_types_updated_at
  BEFORE UPDATE ON ticket_issue_types
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Index
CREATE INDEX idx_ticket_issue_types_active ON ticket_issue_types (sort_order)
  WHERE is_active = true;

-- ============================================================================
-- 2. Add started_at to tickets
-- ============================================================================

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS started_at timestamptz;

COMMENT ON COLUMN tickets.started_at IS 'When work on the ticket started (set when status changes to in_progress)';

-- ============================================================================
-- 3. Recreate views to include started_at
-- ============================================================================

-- ticket_list_view: add started_at
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
  t.subject                             AS product_name,
  tp.sku                                AS primary_sku,
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
  (SELECT count(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id)  AS attachment_count,
  (SELECT count(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id)        AS note_count,
  (SELECT count(*) FROM ticket_events te WHERE te.ticket_id = t.id)       AS event_count
FROM tickets t
LEFT JOIN platform_accounts pa ON t.account_id = pa.id
LEFT JOIN ticket_products tp ON t.id = tp.ticket_id AND tp.role = 'primary';

-- ticket_detail_view: add started_at
CREATE OR REPLACE VIEW ticket_detail_view AS
SELECT
  t.id,
  t.ticket_number,
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
  t.started_at,
  t.created_at,
  t.updated_at,
  t.closed_at,
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
  (SELECT count(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id)  AS attachment_count,
  (SELECT count(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id)        AS note_count,
  (SELECT count(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id)     AS message_count,
  (SELECT count(*) FROM ticket_events te WHERE te.ticket_id = t.id)       AS event_count
FROM tickets t
LEFT JOIN platform_accounts pa ON t.account_id = pa.id;

-- ============================================================================
-- 4. RLS for new table
-- ============================================================================

ALTER TABLE ticket_issue_types ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. Migration metadata
-- ============================================================================

COMMENT ON TABLE ticket_issue_types IS 'Configurable registry of valid ticket issue types. UI fetches active types dynamically.';
