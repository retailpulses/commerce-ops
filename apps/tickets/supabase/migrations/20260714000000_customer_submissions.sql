-- ============================================================
-- Issue #??: Customer Submissions & Form Tokens
-- Supabase-backed replacement for Baserow Ticket Form (893037)
-- Spec: docs/trd/supabase-ticketing-mvp-spec.md §7.5, §7.5.1, §10
-- ============================================================

-- ── customer_submissions ──

CREATE TABLE IF NOT EXISTS customer_submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_baserow_id   integer UNIQUE,
  ticket_id           uuid REFERENCES tickets(id) ON DELETE SET NULL,
  submission_type     text NOT NULL DEFAULT 'damage_evidence'
                        CHECK (submission_type IN (
                          'damage_evidence','aftersales_request','supplementary_info',
                          'operator_requested','other'
                        )),
  customer_display_name text,
  customer_contact    text,
  issue_description   text,
  expected_solution   text,
  source              text NOT NULL DEFAULT 'public_form'
                        CHECK (source IN ('public_form','operator_manual','migrated_baserow')),
  processing_status   text NOT NULL DEFAULT 'pending'
                        CHECK (processing_status IN (
                          'pending','linked','processed','needs_manual_review','failed'
                        )),
  raw_payload         jsonb NOT NULL DEFAULT '{}',
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS idx_customer_submissions_ticket
  ON customer_submissions (ticket_id);

CREATE INDEX IF NOT EXISTS idx_customer_submissions_status
  ON customer_submissions (processing_status);

CREATE INDEX IF NOT EXISTS idx_customer_submissions_submitted_at
  ON customer_submissions (submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_submissions_type
  ON customer_submissions (submission_type);

-- Pending review queue (most common filtered query)
CREATE INDEX IF NOT EXISTS idx_customer_submissions_pending_review
  ON customer_submissions (submitted_at DESC)
  WHERE processing_status IN ('pending', 'needs_manual_review');

-- ── submission_tokens ──

CREATE TABLE IF NOT EXISTS submission_tokens (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash            text UNIQUE NOT NULL,
  ticket_id             uuid REFERENCES tickets(id) ON DELETE SET NULL,
  platform              text,
  account_id            uuid REFERENCES platform_accounts(id),
  external_order_id     text,
  customer_submission_id uuid REFERENCES customer_submissions(id) ON DELETE SET NULL,
  allowed_submission_type text NOT NULL DEFAULT 'damage_evidence',
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','used','expired','revoked')),
  expires_at            timestamptz NOT NULL,
  max_upload_count      integer,
  used_count            integer NOT NULL DEFAULT 0,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS idx_submission_tokens_hash
  ON submission_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_submission_tokens_ticket
  ON submission_tokens (ticket_id);

CREATE INDEX IF NOT EXISTS idx_submission_tokens_status
  ON submission_tokens (status);

-- Active tokens lookup (expiry validated in application code)
CREATE INDEX IF NOT EXISTS idx_submission_tokens_active
  ON submission_tokens (token_hash)
  WHERE status = 'active';

-- ── FK: ticket_attachments.customer_submission_id ──
-- Column already exists in 0001_ticketing_mvp_core.sql but without FK constraint.
-- Add the FK now that customer_submissions exists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_ticket_attachments_customer_submission'
  ) THEN
    ALTER TABLE ticket_attachments
      ADD CONSTRAINT fk_ticket_attachments_customer_submission
      FOREIGN KEY (customer_submission_id) REFERENCES customer_submissions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── submission_tokens FK to customer_submissions ──

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_submission_tokens_customer_submission'
  ) THEN
    ALTER TABLE submission_tokens
      ADD CONSTRAINT fk_submission_tokens_customer_submission
      FOREIGN KEY (customer_submission_id) REFERENCES customer_submissions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── Auto-update updated_at ──

DROP TRIGGER IF EXISTS trg_customer_submissions_updated_at ON customer_submissions;
CREATE TRIGGER trg_customer_submissions_updated_at
  BEFORE UPDATE ON customer_submissions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──

ALTER TABLE customer_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_tokens ENABLE ROW LEVEL SECURITY;

-- No anon policies in MVP. Server-side Worker operations use service_role,
-- which bypasses RLS. Public form endpoint validates tokens in application code.

-- ── Comments ──

COMMENT ON TABLE customer_submissions IS 'Customer evidence/intake — replaces Baserow Ticket Form (893037). Public form submissions, operator-requested evidence, and migrated Baserow data.';
COMMENT ON TABLE submission_tokens IS 'Tokenized public form URLs. Store token_hash only — plain token goes in the customer-facing URL.';
