-- Domain: ticketing/rakuten
-- Owner: retailpulses/ticket-handling
-- Affected: rakuten_rmesse_send_context
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required
-- Consumers: Rakuten R-Messe send adapter only

CREATE TABLE IF NOT EXISTS public.rakuten_rmesse_send_context (
  sent_message_id uuid PRIMARY KEY
    REFERENCES public.sent_messages(id) ON DELETE RESTRICT,
  inquiry_number text NOT NULL,
  reply_ids_before_send jsonb NOT NULL DEFAULT '[]'::jsonb,
  mutation_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_rakuten_send_context_inquiry
    CHECK (btrim(inquiry_number) <> ''),
  CONSTRAINT chk_rakuten_send_context_baseline
    CHECK (jsonb_typeof(reply_ids_before_send) = 'array')
);

CREATE OR REPLACE FUNCTION public.enforce_rakuten_send_context_platform()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.sent_messages AS sent
    JOIN public.tickets AS ticket ON ticket.id = sent.ticket_id
    JOIN public.rakuten_rmesse_inquiries AS inquiry
      ON inquiry.ticket_id = sent.ticket_id
     AND inquiry.inquiry_number = NEW.inquiry_number
    JOIN public.platform_accounts AS account
      ON account.id = inquiry.account_id
     AND account.id = ticket.account_id
    WHERE sent.id = NEW.sent_message_id
      AND sent.platform = 'rakuten'
      AND ticket.platform = 'rakuten'
      AND account.platform = 'rakuten'
  ) THEN
    RAISE EXCEPTION 'rakuten_send_context_platform_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rakuten_send_context_platform ON public.rakuten_rmesse_send_context;
CREATE TRIGGER trg_rakuten_send_context_platform
BEFORE INSERT OR UPDATE OF sent_message_id, inquiry_number ON public.rakuten_rmesse_send_context
FOR EACH ROW EXECUTE FUNCTION public.enforce_rakuten_send_context_platform();
REVOKE ALL ON FUNCTION public.enforce_rakuten_send_context_platform() FROM PUBLIC;

ALTER TABLE public.rakuten_rmesse_send_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rakuten_rmesse_send_context FROM PUBLIC;
REVOKE ALL ON TABLE public.rakuten_rmesse_send_context FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.rakuten_rmesse_send_context FROM service_role;
GRANT SELECT ON TABLE public.rakuten_rmesse_send_context TO service_role;

COMMENT ON TABLE public.rakuten_rmesse_send_context IS
  'worker_only Rakuten R-Messe-specific state for one sent_messages operation';
