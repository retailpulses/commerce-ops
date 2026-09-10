-- Ticket Statuses config table — allows operators to add/edit ticket status
-- options without redeployment. Status transition rules remain in code.
-- Pattern follows ticket_issue_types (migration 0002).
-- Issue: #122

-- ============================================================================
-- 1. ticket_statuses — configurable registry of valid ticket statuses
-- ============================================================================

CREATE TABLE ticket_statuses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text UNIQUE NOT NULL,
  display_name text NOT NULL,
  category     text NOT NULL DEFAULT 'active',
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Category labels help the UI group statuses (e.g. "open", "in_progress", "closed")
ALTER TABLE ticket_statuses ADD CONSTRAINT chk_ticket_statuses_category
  CHECK (category IN ('open', 'in_progress', 'pending', 'resolved', 'closed'));

-- Seed initial statuses matching current hardcoded values
INSERT INTO ticket_statuses (key, display_name, category, sort_order) VALUES
  ('open',                 'Open',                  'open',         1),
  ('in_progress',          'In Progress',           'in_progress',  2),
  ('pending_customer',     'Pending Customer',      'pending',      3),
  ('pending_third_party',  'Pending 3rd Party',     'pending',      4),
  ('resolved',             'Resolved',              'resolved',     5),
  ('closed',               'Closed',                'closed',       6),
  ('canceled',             'Canceled',              'closed',       7);

-- Trigger for updated_at
CREATE TRIGGER trg_ticket_statuses_updated_at
  BEFORE UPDATE ON ticket_statuses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Index for fetching active statuses in order
CREATE INDEX idx_ticket_statuses_active ON ticket_statuses (sort_order)
  WHERE is_active = true;

-- ============================================================================
-- 2. RLS
-- ============================================================================

ALTER TABLE ticket_statuses ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. Migration metadata
-- ============================================================================

COMMENT ON TABLE ticket_statuses IS 'Configurable registry of valid ticket statuses. UI fetches active statuses dynamically. Status transition rules remain in application code.';
