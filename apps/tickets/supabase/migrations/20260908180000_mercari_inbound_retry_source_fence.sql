-- Domain: ticketing
-- Owner: retailpulses/ticket-handling
-- Affected: claim_pending_mercari_webhook_messages
-- Change class: additive Mercari-only source-isolation RPC
-- Hosted write required: yes; service_role only; explicit production approval required
-- Consumers: Ticket Handling Mercari retry worker

CREATE OR REPLACE FUNCTION public.claim_pending_mercari_webhook_messages(
  claim_limit integer DEFAULT 10
)
RETURNS SETOF public.inbound_ticket_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT id
    FROM public.inbound_ticket_messages
    WHERE source = 'mercari_webhook'
      AND processing_status IN ('pending', 'failed')
      AND (next_retry_at IS NULL OR next_retry_at <= now())
    ORDER BY server_received_at ASC, id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(claim_limit, 10), 1), 100)
  )
  UPDATE public.inbound_ticket_messages AS message
  SET processing_status = 'processing',
      processing_started_at = now(),
      last_attempt_at = now()
  FROM candidates
  WHERE message.id = candidates.id
  RETURNING message.*;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_mercari_webhook_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_mercari_webhook_messages(integer) TO service_role;

COMMENT ON FUNCTION public.claim_pending_mercari_webhook_messages(integer) IS
  'Claims only Mercari webhook rows for bounded enrichment retry; never claims another platform source.';
