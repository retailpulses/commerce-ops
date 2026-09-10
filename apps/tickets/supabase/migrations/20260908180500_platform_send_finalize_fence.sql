-- Domain: ticketing shared send core
-- Owner: retailpulses/ticket-handling
-- Affected: finalize_platform_operator_message_send, finalize_mercari_operator_message_send, finalize_rakuten_operator_message_send
-- Change class: additive atomic platform-fenced finalize RPC
-- Hosted write required: yes; explicit production approval required
-- Consumers: Ticket Handling Mercari and Rakuten send services

CREATE OR REPLACE FUNCTION public.finalize_platform_operator_message_send(
  p_ticket_id uuid,
  p_expected_platform text,
  p_client_operation_id uuid,
  p_expected_body text,
  p_expected_reply_intent text,
  p_platform_message_id text,
  p_platform_sent_at timestamptz,
  p_sent_by text DEFAULT NULL
)
RETURNS TABLE (sent_message jsonb, ticket_message jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sent public.sent_messages%ROWTYPE;
  v_ticket_platform text;
BEGIN
  IF p_expected_platform NOT IN ('mercari', 'rakuten') THEN
    RAISE EXCEPTION 'platform_finalize_unsupported' USING ERRCODE = '22023';
  END IF;

  SELECT lower(platform) INTO v_ticket_platform
  FROM public.tickets
  WHERE id = p_ticket_id
  FOR SHARE;
  IF NOT FOUND OR v_ticket_platform IS DISTINCT FROM p_expected_platform THEN
    RAISE EXCEPTION 'ticket_platform_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sent
  FROM public.sent_messages
  WHERE ticket_id = p_ticket_id
    AND client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbound_message_claim_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF lower(v_sent.platform) IS DISTINCT FROM p_expected_platform
     OR v_sent.body IS DISTINCT FROM p_expected_body
     OR v_sent.reply_intent IS DISTINCT FROM p_expected_reply_intent THEN
    RAISE EXCEPTION 'outbound_message_contract_mismatch' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT * FROM public.finalize_operator_message_send(
    p_ticket_id,
    p_client_operation_id,
    p_platform_message_id,
    p_platform_sent_at,
    p_sent_by
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_platform_operator_message_send(
  uuid, text, uuid, text, text, text, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_platform_operator_message_send(
  uuid, text, uuid, text, text, text, timestamptz, text
) FROM service_role;

CREATE OR REPLACE FUNCTION public.finalize_mercari_operator_message_send(
  p_ticket_id uuid, p_client_operation_id uuid, p_expected_body text,
  p_expected_reply_intent text, p_platform_message_id text,
  p_platform_sent_at timestamptz, p_sent_by text DEFAULT NULL
)
RETURNS TABLE (sent_message jsonb, ticket_message jsonb, replayed boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.finalize_platform_operator_message_send(
    p_ticket_id, 'mercari', p_client_operation_id, p_expected_body,
    p_expected_reply_intent, p_platform_message_id, p_platform_sent_at, p_sent_by
  );
$$;

CREATE OR REPLACE FUNCTION public.finalize_rakuten_operator_message_send(
  p_ticket_id uuid, p_client_operation_id uuid, p_expected_body text,
  p_expected_reply_intent text, p_platform_message_id text,
  p_platform_sent_at timestamptz, p_sent_by text DEFAULT NULL
)
RETURNS TABLE (sent_message jsonb, ticket_message jsonb, replayed boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.finalize_platform_operator_message_send(
    p_ticket_id, 'rakuten', p_client_operation_id, p_expected_body,
    p_expected_reply_intent, p_platform_message_id, p_platform_sent_at, p_sent_by
  );
$$;

REVOKE ALL ON FUNCTION public.finalize_mercari_operator_message_send(
  uuid, uuid, text, text, text, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_rakuten_operator_message_send(
  uuid, uuid, text, text, text, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_mercari_operator_message_send(
  uuid, uuid, text, text, text, timestamptz, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_rakuten_operator_message_send(
  uuid, uuid, text, text, text, timestamptz, text
) TO service_role;
