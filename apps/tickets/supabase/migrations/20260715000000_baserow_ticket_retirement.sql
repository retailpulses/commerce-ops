-- Idempotency keys and provenance required for the final Baserow ticket import.

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS legacy_baserow_id integer;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_legacy_baserow_id
  ON public.tickets (legacy_baserow_id)
  WHERE legacy_baserow_id IS NOT NULL;

ALTER TABLE public.ticket_messages
  ADD COLUMN IF NOT EXISTS legacy_baserow_id integer;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_messages_legacy_baserow_id
  ON public.ticket_messages (legacy_baserow_id)
  WHERE legacy_baserow_id IS NOT NULL;

ALTER TABLE public.ticket_attachments
  ADD COLUMN IF NOT EXISTS legacy_baserow_file_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_attachments_legacy_file_key
  ON public.ticket_attachments (legacy_baserow_file_key)
  WHERE legacy_baserow_file_key IS NOT NULL;

ALTER TABLE public.ticket_events
  ADD COLUMN IF NOT EXISTS legacy_baserow_event_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_events_legacy_event_key
  ON public.ticket_events (legacy_baserow_event_key)
  WHERE legacy_baserow_event_key IS NOT NULL;

COMMENT ON COLUMN public.tickets.legacy_baserow_id IS
  'Immutable source row ID from retired Baserow Tickets table 884687.';
COMMENT ON COLUMN public.ticket_attachments.legacy_baserow_file_key IS
  'Deterministic source-table/row/file key used for idempotent legacy imports.';
