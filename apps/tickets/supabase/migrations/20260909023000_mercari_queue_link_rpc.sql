-- Domain: ticketing/mercari
-- Owner: retailpulses/ticket-handling
-- Affected: inbound_ticket_messages, tickets, ticket_events
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required

CREATE OR REPLACE FUNCTION public.link_mercari_inbound_message_to_ticket(
  p_inbound_message_id uuid,
  p_ticket_id uuid,
  p_actor_id text
)
RETURNS public.inbound_ticket_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.inbound_ticket_messages%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_account_id uuid;
BEGIN
  IF p_inbound_message_id IS NULL OR p_ticket_id IS NULL OR btrim(COALESCE(p_actor_id, '')) = '' THEN
    RAISE EXCEPTION 'mercari_queue_link_input_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_message
  FROM public.inbound_ticket_messages
  WHERE id = p_inbound_message_id
    AND source = 'mercari_webhook'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mercari_queue_item_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_account_id
  FROM public.platform_accounts
  WHERE platform = 'mercari'
    AND status = 'active'
    AND lower(shop_code) = lower(v_message.shop_name)
  LIMIT 1;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'mercari_queue_account_unresolved' USING ERRCODE = '23514';
  END IF;

  IF v_ticket.platform <> 'mercari'
     OR v_ticket.account_id IS DISTINCT FROM v_account_id
     OR v_ticket.external_order_id IS DISTINCT FROM v_message.order_transaction_id THEN
    RAISE EXCEPTION 'mercari_queue_ticket_scope_mismatch' USING ERRCODE = '23514';
  END IF;

  IF v_message.linked_ticket_id IS NOT NULL THEN
    IF v_message.linked_ticket_id = v_ticket.id
       AND v_message.queue_status = 'linked'
       AND v_message.review_status = 'reviewed' THEN
      RETURN v_message;
    END IF;
    RAISE EXCEPTION 'mercari_queue_already_linked' USING ERRCODE = '23514';
  END IF;
  IF v_message.queue_status NOT IN ('unread', 'read') THEN
    RAISE EXCEPTION 'mercari_queue_state_conflict' USING ERRCODE = '23514';
  END IF;

  UPDATE public.inbound_ticket_messages
  SET linked_ticket_id = v_ticket.id,
      queue_status = 'linked',
      review_status = 'reviewed',
      reviewed_at = COALESCE(reviewed_at, now()),
      updated_at = now()
  WHERE id = v_message.id
  RETURNING * INTO v_message;

  INSERT INTO public.ticket_events(
    ticket_id, event_type, actor_type, actor_id, payload, idempotency_key
  ) VALUES (
    v_ticket.id, 'message_received', 'operator', p_actor_id,
    jsonb_build_object(
      'source', 'mercari_queue_link',
      'inbound_message_id', v_message.id,
      'order_transaction_id', v_message.order_transaction_id
    ),
    'mercari_queue_link:' || v_message.id::text || ':' || v_ticket.id::text
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  RETURN v_message;
END;
$$;

REVOKE ALL ON FUNCTION public.link_mercari_inbound_message_to_ticket(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_mercari_inbound_message_to_ticket(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_mercari_inbound_message_to_ticket(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.link_mercari_inbound_message_to_ticket(uuid, uuid, text) IS
  'Atomically links one Mercari queue row to the exact same-platform/account/order ticket and records an idempotent audit event.';

CREATE OR REPLACE FUNCTION public.count_mercari_queue_unread_v1(p_shop_name text DEFAULT NULL)
RETURNS TABLE(shop_name text, unread_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT messages.shop_name, count(*)::bigint
  FROM public.inbound_ticket_messages AS messages
  WHERE messages.source = 'mercari_webhook'
    AND messages.queue_status = 'unread'
    AND (p_shop_name IS NULL OR messages.shop_name = p_shop_name)
  GROUP BY messages.shop_name
  ORDER BY messages.shop_name;
$$;

REVOKE ALL ON FUNCTION public.count_mercari_queue_unread_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_mercari_queue_unread_v1(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_mercari_queue_unread_v1(text) TO service_role;

CREATE OR REPLACE FUNCTION public.transition_mercari_queue_v1(
  p_inbound_message_id uuid,
  p_action text
)
RETURNS public.inbound_ticket_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_message public.inbound_ticket_messages%ROWTYPE;
BEGIN
  SELECT * INTO v_message FROM public.inbound_ticket_messages
  WHERE id = p_inbound_message_id AND source = 'mercari_webhook' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mercari_queue_item_not_found' USING ERRCODE = 'P0002'; END IF;

  CASE p_action
    WHEN 'mark_read' THEN
      IF v_message.queue_status <> 'unread' THEN RAISE EXCEPTION 'mercari_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.inbound_ticket_messages SET queue_status='read', read_at=now(), updated_at=now() WHERE id=v_message.id RETURNING * INTO v_message;
    WHEN 'mark_unread' THEN
      IF v_message.queue_status <> 'read' THEN RAISE EXCEPTION 'mercari_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.inbound_ticket_messages SET queue_status='unread', read_at=NULL, updated_at=now() WHERE id=v_message.id RETURNING * INTO v_message;
    WHEN 'review' THEN
      IF v_message.review_status <> 'needs_review' THEN RAISE EXCEPTION 'mercari_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.inbound_ticket_messages SET review_status='reviewed', reviewed_at=now(), updated_at=now() WHERE id=v_message.id RETURNING * INTO v_message;
    WHEN 'ignore' THEN
      IF v_message.queue_status NOT IN ('unread','read') OR v_message.linked_ticket_id IS NOT NULL THEN RAISE EXCEPTION 'mercari_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.inbound_ticket_messages SET queue_status='ignored', review_status='reviewed', reviewed_at=now(), updated_at=now() WHERE id=v_message.id RETURNING * INTO v_message;
    ELSE RAISE EXCEPTION 'mercari_queue_action_invalid' USING ERRCODE = '22023';
  END CASE;
  RETURN v_message;
END;
$$;

CREATE OR REPLACE FUNCTION public.convert_mercari_inbound_message_to_ticket_v1(
  p_inbound_message_id uuid,
  p_subject text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_customer_display_name text DEFAULT NULL,
  p_issue_types text[] DEFAULT NULL,
  p_external_url text DEFAULT NULL,
  p_actor_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.inbound_ticket_messages%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_account_id uuid;
  v_created boolean := false;
BEGIN
  SELECT * INTO v_message FROM public.inbound_ticket_messages
  WHERE id=p_inbound_message_id AND source='mercari_webhook' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mercari_queue_item_not_found' USING ERRCODE='P0002'; END IF;
  IF v_message.queue_status = 'converted' AND v_message.linked_ticket_id IS NOT NULL THEN
    SELECT * INTO v_ticket FROM public.tickets WHERE id=v_message.linked_ticket_id;
    RETURN jsonb_build_object('ticket_id',v_ticket.id,'ticket_number',v_ticket.ticket_number,'created',false,'replayed',true);
  END IF;
  IF v_message.queue_status NOT IN ('unread','read') OR v_message.linked_ticket_id IS NOT NULL THEN
    RAISE EXCEPTION 'mercari_queue_state_conflict' USING ERRCODE='23514';
  END IF;
  SELECT id INTO v_account_id FROM public.platform_accounts
  WHERE platform='mercari' AND status='active' AND lower(shop_code)=lower(v_message.shop_name) LIMIT 1;
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'mercari_queue_account_unresolved' USING ERRCODE='23514'; END IF;

  SELECT * INTO v_ticket FROM public.tickets
  WHERE platform='mercari' AND account_id=v_account_id AND external_order_id=v_message.order_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.tickets(
      ticket_number, platform, account_id, external_order_id, external_thread_id, origin,
      customer_display_name, subject, description, status, priority, issue_types, external_url,
      latest_message_at, latest_customer_message, needs_reply
    ) VALUES (
      'T-' || to_char(now(),'YYYYMMDD') || '-' || lpad(nextval('public.ticket_number_seq')::text,4,'0'),
      'mercari', v_account_id, v_message.order_transaction_id, v_message.external_thread_id, 'manual',
      COALESCE(NULLIF(btrim(p_customer_display_name),''), v_message.customer_display_name),
      COALESCE(NULLIF(btrim(p_subject),''), 'Mercari inquiry ' || v_message.order_transaction_id),
      COALESCE(NULLIF(btrim(p_description),''), v_message.latest_buyer_message),
      'open', CASE WHEN p_priority IN ('low','normal','high','urgent') THEN p_priority ELSE 'normal' END,
      COALESCE(p_issue_types, '{}'::text[]), NULLIF(btrim(p_external_url),''),
      v_message.received_at, v_message.latest_buyer_message, true
    ) RETURNING * INTO v_ticket;
    v_created := true;
  END IF;

  UPDATE public.inbound_ticket_messages
  SET linked_ticket_id=v_ticket.id, queue_status='converted', review_status='reviewed',
      reviewed_at=COALESCE(reviewed_at,now()), updated_at=now()
  WHERE id=v_message.id RETURNING * INTO v_message;
  INSERT INTO public.ticket_events(ticket_id,event_type,actor_type,actor_id,payload,idempotency_key)
  VALUES (v_ticket.id,'message_received','operator',COALESCE(NULLIF(btrim(p_actor_id),''),'portal_operator'),
    jsonb_build_object('source','manual_queue_conversion','inbound_message_id',v_message.id),
    'mercari_queue_convert:' || v_message.id::text || ':' || v_ticket.id::text)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  RETURN jsonb_build_object('ticket_id',v_ticket.id,'ticket_number',v_ticket.ticket_number,'created',v_created,'replayed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_mercari_queue_v1(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_mercari_queue_v1(uuid,text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_mercari_queue_v1(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text) TO service_role;
