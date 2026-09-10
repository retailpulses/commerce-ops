-- ============================================================
-- Issue #126: Durable webhook ingestion — processing status columns
-- ============================================================
-- Adds async enrichment support to inbound_ticket_messages:
--   - processing_status: tracks enrichment lifecycle (pending → processing → completed/failed)
--   - processing_attempts / next_retry_at / last_attempt_at: bounded retry with backoff
--   - processing_error: last error message for diagnostics
--   - server_received_at: actual CF Worker receipt time (separate from Mercari event time)

-- ── New columns ──

ALTER TABLE inbound_ticket_messages
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_error text,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_received_at timestamptz NOT NULL DEFAULT now();

-- ── Backfill: existing rows were already enriched at insert time ──

UPDATE inbound_ticket_messages
SET processing_status = 'completed',
    processed_at = COALESCE(reviewed_at, created_at),
    server_received_at = received_at
WHERE processing_status = 'pending';

-- ── Index: find rows ready for retry processing ──

CREATE INDEX IF NOT EXISTS idx_inbound_pending_retry
  ON inbound_ticket_messages (processing_status, next_retry_at)
  WHERE processing_status IN ('pending', 'failed');

-- ── Index: observability queries by shop + status ──

CREATE INDEX IF NOT EXISTS idx_inbound_shop_processing
  ON inbound_ticket_messages (shop_name, processing_status);

-- Atomically claim retry rows. The API layer cannot safely emulate
-- SELECT ... FOR UPDATE SKIP LOCKED with separate select/update calls.
CREATE OR REPLACE FUNCTION claim_pending_inbound_messages(claim_limit integer DEFAULT 10)
RETURNS SETOF inbound_ticket_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT id
    FROM inbound_ticket_messages
    WHERE processing_status IN ('pending', 'failed')
      AND (next_retry_at IS NULL OR next_retry_at <= now())
    ORDER BY server_received_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT claim_limit
  )
  UPDATE inbound_ticket_messages AS m
  SET processing_status = 'processing',
      processing_started_at = now(),
      last_attempt_at = now()
  FROM candidates
  WHERE m.id = candidates.id
  RETURNING m.*;
$$;

REVOKE ALL ON FUNCTION claim_pending_inbound_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pending_inbound_messages(integer) TO service_role;
