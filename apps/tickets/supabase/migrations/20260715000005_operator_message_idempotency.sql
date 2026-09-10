-- Durable idempotency for authenticated operator replies.
--
-- A sent_messages row is claimed before calling the external platform. The
-- same client operation can then be completed/replayed without sending twice.

ALTER TABLE public.sent_messages
  ADD COLUMN IF NOT EXISTS client_operation_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS platform_message_ids_before_send jsonb;

ALTER TABLE public.sent_messages
  DROP CONSTRAINT IF EXISTS sent_messages_delivery_status_check;
ALTER TABLE public.sent_messages
  ADD CONSTRAINT sent_messages_delivery_status_check
  CHECK (delivery_status IN ('sending', 'sent', 'ambiguous'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_sent_messages_client_operation
  ON public.sent_messages (ticket_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

ALTER TABLE public.ticket_messages
  ADD COLUMN IF NOT EXISTS client_operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_messages_client_operation
  ON public.ticket_messages (ticket_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.finalize_operator_message_send(
  p_ticket_id uuid,
  p_client_operation_id uuid,
  p_platform_message_id text,
  p_platform_sent_at timestamptz,
  p_sent_by text DEFAULT NULL
)
RETURNS TABLE (
  sent_message jsonb,
  ticket_message jsonb,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sent public.sent_messages%ROWTYPE;
  v_ticket_message public.ticket_messages%ROWTYPE;
  v_replayed boolean := false;
BEGIN
  IF p_platform_message_id IS NULL OR btrim(p_platform_message_id) = '' THEN
    RAISE EXCEPTION 'platform_message_id_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sent
  FROM public.sent_messages
  WHERE ticket_id = p_ticket_id
    AND client_operation_id = p_client_operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbound_message_claim_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_sent.delivery_status = 'sent' THEN
    SELECT * INTO v_ticket_message
    FROM public.ticket_messages
    WHERE ticket_id = p_ticket_id
      AND client_operation_id = p_client_operation_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'completed_outbound_message_missing_ticket_message';
    END IF;

    RETURN QUERY SELECT to_jsonb(v_sent), to_jsonb(v_ticket_message), true;
    RETURN;
  END IF;

  UPDATE public.sent_messages
  SET platform_message_id = p_platform_message_id,
      sent_at = COALESCE(p_platform_sent_at, now()),
      sent_by = COALESCE(p_sent_by, sent_by),
      delivery_status = 'sent',
      delivery_error = NULL
  WHERE id = v_sent.id
  RETURNING * INTO v_sent;

  INSERT INTO public.ticket_messages (
    ticket_id,
    platform,
    external_message_id,
    sender_type,
    sender_display_name,
    body,
    sent_at,
    raw_payload,
    client_operation_id
  ) VALUES (
    p_ticket_id,
    v_sent.platform,
    p_platform_message_id,
    'operator',
    p_sent_by,
    v_sent.body,
    COALESCE(p_platform_sent_at, now()),
    jsonb_build_object(
      'source', 'operator_platform_send',
      'client_operation_id', p_client_operation_id
    ),
    p_client_operation_id
  )
  ON CONFLICT (ticket_id, client_operation_id)
    WHERE client_operation_id IS NOT NULL
  DO UPDATE SET external_message_id = EXCLUDED.external_message_id
  RETURNING * INTO v_ticket_message;

  INSERT INTO public.ticket_events (
    ticket_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    p_ticket_id,
    'message_sent',
    'operator',
    p_sent_by,
    jsonb_build_object(
      'platform_message_id', p_platform_message_id,
      'reply_intent', v_sent.reply_intent,
      'body_preview', left(v_sent.body, 100),
      'client_operation_id', p_client_operation_id
    )
  );

  IF v_sent.reply_intent = 'terminal' THEN
    UPDATE public.tickets
    SET needs_reply = false,
        updated_at = now()
    WHERE id = p_ticket_id;
  END IF;

  RETURN QUERY SELECT to_jsonb(v_sent), to_jsonb(v_ticket_message), v_replayed;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_operator_message_send(
  uuid, uuid, text, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_operator_message_send(
  uuid, uuid, text, timestamptz, text
) TO service_role;

COMMENT ON COLUMN public.sent_messages.client_operation_id IS
  'Stable client-generated UUID used to claim and replay one external send.';
COMMENT ON FUNCTION public.finalize_operator_message_send(
  uuid, uuid, text, timestamptz, text
) IS 'Atomically records one platform send and replays the result for the same client operation.';
