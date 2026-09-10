-- ============================================================
-- Issue #131: Forward durable Mercari events to OrderMgmt webhook
-- ============================================================
-- Domain: ticketing
-- Owner: retailpulses/ticket-handling
-- Affected: inbound_ticket_messages; claim_pending_webhook_forwarding
-- Change class: schema and workload state
-- Hosted write required: yes; service_role only
-- Consumers: Ticket Handling Worker webhook forwarder and retry cron
-- Adds durable forwarding state to inbound_ticket_messages so the
-- Worker can push raw order_transaction_message_created events to
-- OrderMgmt's /webhooks/mercari-message endpoint after its durable
-- insert, with bounded retries and full observability.
--
-- Forwarding status lifecycle:
--   not_forwarded → forwarding (atomically claimed, in-flight) → forwarded
--   forwarding → not_forwarded (transient failure; returned to the pool)
--   forwarding → failed (terminal: non-retryable error, exhausted attempts,
--               or stale-abandoned claim after a worker crash)
--
-- The claim RPC owns every transition: it atomically moves not_forwarded
-- (or a stale forwarding) row into forwarding while bumping the attempt
-- counter, so a row can never be processed twice concurrently. Rows that
-- crash mid-flight are reclaimed after the staleness window and either
-- re-forwarded (attempts left) or terminalized (attempts exhausted).
--
-- The forwarding secret is never stored here. Only status, attempt count,
-- and timestamps are persisted (headers/credentials stay in Worker env).

ALTER TABLE inbound_ticket_messages
  ADD COLUMN IF NOT EXISTS forwarding_status text NOT NULL DEFAULT 'not_forwarded',
  ADD COLUMN IF NOT EXISTS forwarding_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forwarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS forward_error text,
  ADD COLUMN IF NOT EXISTS last_forward_attempt_at timestamptz;

-- Single named check constraint on forwarding_status. Drop any legacy
-- auto-named constraint from an earlier version of this migration first so
-- this file is safe to re-apply (partial/reapply safety).
DO $$
DECLARE
  legacy text;
BEGIN
  FOR legacy IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'inbound_ticket_messages'::regclass
      AND contype = 'c'
      AND conname <> 'chk_forwarding_status'
      AND pg_get_constraintdef(oid) LIKE '%forwarding_status%'
  LOOP
    EXECUTE format('ALTER TABLE inbound_ticket_messages DROP CONSTRAINT %I', legacy);
  END LOOP;
END
$$;

ALTER TABLE inbound_ticket_messages
  DROP CONSTRAINT IF EXISTS chk_forwarding_status;

ALTER TABLE inbound_ticket_messages
  ADD CONSTRAINT chk_forwarding_status
  CHECK (forwarding_status IN ('not_forwarded', 'forwarding', 'forwarded', 'failed'));

-- Claim-aligned index: matches the claim RPC predicate exactly
-- (statuses in-flight-or-pending, oldest first).
DROP INDEX IF EXISTS idx_inbound_forwarding_scan;
CREATE INDEX idx_inbound_forwarding_scan
  ON inbound_ticket_messages (server_received_at)
  WHERE forwarding_status IN ('not_forwarded', 'forwarding');

-- Index: forwarded rows for audit lookups
CREATE INDEX IF NOT EXISTS idx_inbound_forwarded_at
  ON inbound_ticket_messages (forwarded_at)
  WHERE forwarded_at IS NOT NULL;

-- Atomically claim forwarding candidates. Mirrors claim_pending_inbound_messages
-- (SELECT ... FOR UPDATE SKIP LOCKED is not safely emulatable via the API).
--
-- A claim is a real state transition: the row moves to 'forwarding' with the
-- attempt counter bumped in the same UPDATE, so no other worker can pick it up.
-- Candidates are:
--   - not_forwarded rows within the lookback window
--   - forwarding rows whose last attempt is stale (crashed worker) and that
--     still have attempts left — reclaimed and re-claimed atomically
-- Rows outside the lookback window are reconciled by OrderMgmt's own polling,
-- so forwarding is for latency only.
--
-- Stale abandoned rows that can never be re-claimed are terminalized first:
--   - attempts exhausted → failed (forward_attempts_exhausted)
--   - outside the lookback window → failed (forward_stale_abandoned)
-- so a crashed worker can never leave a row stuck in 'forwarding' forever.
CREATE OR REPLACE FUNCTION claim_pending_webhook_forwarding(
  claim_limit integer DEFAULT 10,
  max_attempts integer DEFAULT 5
)
RETURNS SETOF inbound_ticket_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE inbound_ticket_messages
  SET forwarding_status = 'failed',
      forward_error = 'forward_attempts_exhausted'
  WHERE forwarding_status = 'forwarding'
    AND (last_forward_attempt_at IS NULL
         OR last_forward_attempt_at < now() - interval '10 minutes')
    AND forwarding_attempts >= claim_pending_webhook_forwarding.max_attempts;

  UPDATE inbound_ticket_messages
  SET forwarding_status = 'failed',
      forward_error = 'forward_stale_abandoned'
  WHERE forwarding_status = 'forwarding'
    AND (last_forward_attempt_at IS NULL
         OR last_forward_attempt_at < now() - interval '10 minutes')
    AND server_received_at < now() - interval '3 days';

  WITH candidates AS (
    SELECT id
    FROM inbound_ticket_messages
    WHERE forwarding_attempts < claim_pending_webhook_forwarding.max_attempts
      AND server_received_at >= now() - interval '3 days'
      AND (
        forwarding_status = 'not_forwarded'
        OR (
          forwarding_status = 'forwarding'
          AND (last_forward_attempt_at IS NULL
               OR last_forward_attempt_at < now() - interval '10 minutes')
        )
      )
    ORDER BY server_received_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT claim_pending_webhook_forwarding.claim_limit
  )
  UPDATE inbound_ticket_messages AS m
  SET forwarding_status = 'forwarding',
      forwarding_attempts = m.forwarding_attempts + 1,
      last_forward_attempt_at = now()
  FROM candidates
  WHERE m.id = candidates.id
  RETURNING m.*;
$$;

REVOKE ALL ON FUNCTION claim_pending_webhook_forwarding(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pending_webhook_forwarding(integer, integer) TO service_role;

COMMENT ON COLUMN inbound_ticket_messages.forwarding_status IS
  'Forwarding to OrderMgmt (Issue #131): not_forwarded (pending or retryable), forwarding (claimed, in-flight), forwarded (accepted), failed (terminal).';
COMMENT ON COLUMN inbound_ticket_messages.forwarding_attempts IS
  'Number of forwarding attempts made. Capped by ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS (default 5).';
COMMENT ON COLUMN inbound_ticket_messages.forwarded_at IS
  'Timestamp when OrderMgmt acknowledged the forwarded event (2xx).';
COMMENT ON COLUMN inbound_ticket_messages.forward_error IS
  'Last forwarding error (code only; response bodies are never persisted).';
COMMENT ON COLUMN inbound_ticket_messages.last_forward_attempt_at IS
  'Timestamp of the most recent forwarding attempt (set on claim and on outcome).';
