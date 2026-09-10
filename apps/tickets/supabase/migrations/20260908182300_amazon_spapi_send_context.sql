-- Domain: ticketing/amazon-spapi-send
-- Owner: retailpulses/ticket-handling
-- Affected: amazon_spapi_send_context, create_amazon_spapi_send_context
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required
-- Consumers: Amazon SP-API action-specific send adapter only

CREATE TABLE IF NOT EXISTS public.amazon_spapi_send_context (
  sent_message_id uuid PRIMARY KEY
    REFERENCES public.sent_messages(id) ON DELETE RESTRICT,
  action_type text NOT NULL,
  external_order_id text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_mutation_started_at timestamptz,
  spapi_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_amazon_spapi_action_type
    CHECK (action_type ~ '^[a-z0-9_]+$'),
  CONSTRAINT chk_amazon_spapi_order
    CHECK (btrim(external_order_id) <> ''),
  CONSTRAINT chk_amazon_spapi_request_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION public.enforce_amazon_spapi_send_context_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.sent_message_id IS DISTINCT FROM OLD.sent_message_id OR
    NEW.action_type IS DISTINCT FROM OLD.action_type OR
    NEW.external_order_id IS DISTINCT FROM OLD.external_order_id OR
    NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
  ) THEN
    RAISE EXCEPTION 'amazon_spapi_send_context_immutable_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.sent_messages AS sent
    JOIN public.tickets AS ticket ON ticket.id = sent.ticket_id
    JOIN public.platform_accounts AS account ON account.id = ticket.account_id
    WHERE sent.id = NEW.sent_message_id
      AND sent.platform = 'amazon'
      AND ticket.platform = 'amazon'
      AND account.platform = 'amazon'
      AND ticket.external_order_id = NEW.external_order_id
  ) THEN
    RAISE EXCEPTION 'amazon_spapi_send_context_scope_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_amazon_spapi_send_context_scope ON public.amazon_spapi_send_context;
CREATE TRIGGER trg_amazon_spapi_send_context_scope
BEFORE INSERT OR UPDATE OF sent_message_id, action_type, external_order_id, request_fingerprint
ON public.amazon_spapi_send_context
FOR EACH ROW EXECUTE FUNCTION public.enforce_amazon_spapi_send_context_scope();
REVOKE ALL ON FUNCTION public.enforce_amazon_spapi_send_context_scope() FROM PUBLIC;

ALTER TABLE public.amazon_spapi_send_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.amazon_spapi_send_context FROM PUBLIC;
REVOKE ALL ON TABLE public.amazon_spapi_send_context FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.amazon_spapi_send_context FROM service_role;
GRANT SELECT ON TABLE public.amazon_spapi_send_context TO service_role;

CREATE OR REPLACE FUNCTION public.create_amazon_spapi_send_context(
  p_sent_message_id uuid,
  p_action_type text,
  p_external_order_id text,
  p_request_fingerprint text
)
RETURNS public.amazon_spapi_send_context
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.amazon_spapi_send_context%ROWTYPE;
BEGIN
  INSERT INTO public.amazon_spapi_send_context (
    sent_message_id, action_type, external_order_id, request_fingerprint
  ) VALUES (
    p_sent_message_id, p_action_type, p_external_order_id, p_request_fingerprint
  )
  ON CONFLICT (sent_message_id) DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.amazon_spapi_send_context
    WHERE sent_message_id = p_sent_message_id;
    IF v_row.action_type IS DISTINCT FROM p_action_type
       OR v_row.external_order_id IS DISTINCT FROM p_external_order_id
       OR v_row.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'amazon_spapi_send_context_replay_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_amazon_spapi_send_context(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_amazon_spapi_send_context(uuid, text, text, text) TO service_role;

COMMENT ON TABLE public.amazon_spapi_send_context IS
  'worker_only Amazon SP-API action-specific send state; contains no mail thread or raw request payload';
