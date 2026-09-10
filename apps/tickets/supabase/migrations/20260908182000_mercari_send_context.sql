-- Domain: ticketing/mercari
-- Owner: retailpulses/ticket-handling
-- Affected: mercari_send_context
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required
-- Consumers: Mercari send adapter only

CREATE TABLE IF NOT EXISTS public.mercari_send_context (
  sent_message_id uuid PRIMARY KEY
    REFERENCES public.sent_messages(id) ON DELETE RESTRICT,
  transaction_id text NOT NULL,
  message_ids_before_send jsonb NOT NULL DEFAULT '[]'::jsonb,
  mutation_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mercari_send_context_transaction
    CHECK (btrim(transaction_id) <> ''),
  CONSTRAINT chk_mercari_send_context_baseline
    CHECK (jsonb_typeof(message_ids_before_send) = 'array')
);

CREATE OR REPLACE FUNCTION public.enforce_mercari_send_context_platform()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.sent_messages AS sent
    JOIN public.tickets AS ticket ON ticket.id = sent.ticket_id
    JOIN public.platform_accounts AS account ON account.id = ticket.account_id
    WHERE sent.id = NEW.sent_message_id
      AND sent.platform = 'mercari'
      AND ticket.platform = 'mercari'
      AND account.platform = 'mercari'
      AND ticket.external_order_id = NEW.transaction_id
  ) THEN
    RAISE EXCEPTION 'mercari_send_context_platform_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mercari_send_context_platform ON public.mercari_send_context;
CREATE TRIGGER trg_mercari_send_context_platform
BEFORE INSERT OR UPDATE OF sent_message_id, transaction_id ON public.mercari_send_context
FOR EACH ROW EXECUTE FUNCTION public.enforce_mercari_send_context_platform();
REVOKE ALL ON FUNCTION public.enforce_mercari_send_context_platform() FROM PUBLIC;

ALTER TABLE public.mercari_send_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mercari_send_context FROM PUBLIC;
REVOKE ALL ON TABLE public.mercari_send_context FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.mercari_send_context FROM service_role;
GRANT SELECT ON TABLE public.mercari_send_context TO service_role;

COMMENT ON TABLE public.mercari_send_context IS
  'worker_only Mercari-specific state for one sent_messages operation';
