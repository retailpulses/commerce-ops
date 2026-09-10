-- Domain: ticketing/amazon
-- Owner: retailpulses/ticket-handling
-- Affected: amazon_mail_messages, tickets, ticket_messages, ticket_events
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required

ALTER TABLE public.amazon_mail_messages
  ADD COLUMN IF NOT EXISTS queue_status text NOT NULL DEFAULT 'unread',
  ADD COLUMN IF NOT EXISTS read_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE public.amazon_mail_messages
  DROP CONSTRAINT IF EXISTS chk_amazon_mail_queue_status;
ALTER TABLE public.amazon_mail_messages
  ADD CONSTRAINT chk_amazon_mail_queue_status
  CHECK (queue_status IN ('unread','read','linked','converted','ignored'));

UPDATE public.amazon_mail_messages
SET queue_status = CASE WHEN ticket_id IS NULL THEN queue_status ELSE 'linked' END
WHERE ticket_id IS NOT NULL AND queue_status IN ('unread','read');

CREATE OR REPLACE FUNCTION public.enforce_amazon_mail_queue_link_state()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.ticket_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.ticket_id IS NULL)
     AND NEW.queue_status IN ('unread','read') THEN
    NEW.queue_status := 'linked';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_amazon_mail_queue_link_state ON public.amazon_mail_messages;
CREATE TRIGGER trg_amazon_mail_queue_link_state
BEFORE INSERT OR UPDATE OF ticket_id, queue_status ON public.amazon_mail_messages
FOR EACH ROW EXECUTE FUNCTION public.enforce_amazon_mail_queue_link_state();

CREATE OR REPLACE FUNCTION public.transition_amazon_mail_queue_v1(
  p_message_id uuid,
  p_action text,
  p_ticket_id uuid DEFAULT NULL,
  p_actor_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mail public.amazon_mail_messages%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_event_type text;
BEGIN
  IF p_message_id IS NULL OR p_action NOT IN ('mark_read','mark_unread','review','ignore','link','convert') THEN
    RAISE EXCEPTION 'amazon_queue_action_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_mail FROM public.amazon_mail_messages
  WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'amazon_queue_item_not_found' USING ERRCODE = 'P0002';
  END IF;

  CASE p_action
    WHEN 'mark_read' THEN
      IF v_mail.queue_status <> 'unread' THEN RAISE EXCEPTION 'amazon_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.amazon_mail_messages SET queue_status='read', read_at=now(), updated_at=now()
      WHERE id=v_mail.id RETURNING * INTO v_mail;
    WHEN 'mark_unread' THEN
      IF v_mail.queue_status <> 'read' THEN RAISE EXCEPTION 'amazon_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.amazon_mail_messages SET queue_status='unread', read_at=NULL, updated_at=now()
      WHERE id=v_mail.id RETURNING * INTO v_mail;
    WHEN 'review' THEN
      IF v_mail.review_status NOT IN ('needs_review','untrusted_review') THEN RAISE EXCEPTION 'amazon_queue_state_conflict' USING ERRCODE = '23514'; END IF;
      UPDATE public.amazon_mail_messages
      SET review_status=CASE WHEN mail_auth_status = 'pass' THEN 'reviewed' ELSE review_status END,
          reviewed_at=now(), updated_at=now()
      WHERE id=v_mail.id RETURNING * INTO v_mail;
    WHEN 'ignore' THEN
      IF v_mail.queue_status NOT IN ('unread','read') OR v_mail.ticket_id IS NOT NULL THEN
        RAISE EXCEPTION 'amazon_queue_state_conflict' USING ERRCODE = '23514';
      END IF;
      UPDATE public.amazon_mail_messages
      SET queue_status='ignored',
          review_status=CASE WHEN mail_auth_status = 'pass' THEN 'reviewed' ELSE review_status END,
          reviewed_at=now(), updated_at=now()
      WHERE id=v_mail.id RETURNING * INTO v_mail;
    WHEN 'link' THEN
      IF v_mail.mail_auth_status <> 'pass' OR v_mail.ticket_id IS NOT NULL OR p_ticket_id IS NULL THEN
        RAISE EXCEPTION 'amazon_queue_link_not_allowed' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO v_ticket FROM public.tickets WHERE id=p_ticket_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found' USING ERRCODE = 'P0002'; END IF;
      IF v_ticket.platform <> 'amazon'
         OR v_ticket.account_id IS DISTINCT FROM v_mail.account_id
         OR (v_mail.external_order_id IS NOT NULL AND v_ticket.external_order_id IS DISTINCT FROM v_mail.external_order_id) THEN
        RAISE EXCEPTION 'amazon_queue_ticket_scope_mismatch' USING ERRCODE = '23514';
      END IF;
      UPDATE public.amazon_mail_messages
      SET ticket_id=v_ticket.id, queue_status='linked', review_status='reviewed', reviewed_at=now(), updated_at=now()
      WHERE id=v_mail.id RETURNING * INTO v_mail;
      v_event_type := 'amazon_queue_link';
    WHEN 'convert' THEN
      IF v_mail.mail_auth_status <> 'pass' OR v_mail.ticket_id IS NOT NULL OR btrim(COALESCE(v_mail.external_order_id,'')) = '' THEN
        RAISE EXCEPTION 'amazon_queue_convert_not_allowed' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO v_ticket FROM public.tickets
      WHERE platform='amazon' AND account_id=v_mail.account_id AND external_order_id=v_mail.external_order_id
      FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.tickets(
          platform, account_id, external_order_id, external_thread_id, origin,
          subject, description, status, priority, latest_message_at,
          latest_customer_message, needs_reply
        ) VALUES (
          'amazon', v_mail.account_id, v_mail.external_order_id, v_mail.provider_thread_id,
          'manual', COALESCE(v_mail.subject, 'Amazon buyer message'), v_mail.body,
          'open', 'normal', v_mail.source_received_at, v_mail.body, true
        ) RETURNING * INTO v_ticket;
      END IF;
      INSERT INTO public.ticket_messages(
        ticket_id, platform, external_message_id, sender_type, body, sent_at, raw_payload
      ) VALUES (
        v_ticket.id, 'amazon', 'zoho:' || v_mail.provider_account_id || ':' || v_mail.provider_message_id, 'customer', v_mail.body,
        v_mail.source_received_at, jsonb_build_object('source','amazon_mail_messages','mail_id',v_mail.id)
      ) ON CONFLICT (platform, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING;
      UPDATE public.amazon_mail_messages
      SET ticket_id=v_ticket.id, queue_status='converted', review_status='reviewed', reviewed_at=now(), updated_at=now()
      WHERE id=v_mail.id RETURNING * INTO v_mail;
      v_event_type := 'amazon_queue_convert';
  END CASE;

  IF v_event_type IS NOT NULL THEN
    INSERT INTO public.ticket_events(ticket_id,event_type,actor_type,actor_id,payload,idempotency_key)
    VALUES (
      v_ticket.id, 'message_received', 'operator', COALESCE(NULLIF(btrim(p_actor_id),''),'portal_operator'),
      jsonb_build_object('source',v_event_type,'amazon_mail_message_id',v_mail.id),
      v_event_type || ':' || v_mail.id::text || ':' || v_ticket.id::text
    ) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'message_id', v_mail.id,
    'queue_status', v_mail.queue_status,
    'review_status', v_mail.review_status,
    'ticket_id', v_mail.ticket_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transition_amazon_mail_queue_v1(uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_amazon_mail_queue_v1(uuid,text,uuid,text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_amazon_mail_queue_v1(uuid,text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.count_amazon_mail_queue_unread_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_v2_available boolean := true;
  v_legacy_available boolean := true;
  v_v2_keys jsonb := '[]'::jsonb;
  v_legacy_keys jsonb := '[]'::jsonb;
  v_total bigint;
BEGIN
  BEGIN
    EXECUTE $query$
      SELECT COALESCE(jsonb_agg(jsonb_build_array(provider_account_id, provider_message_id)), '[]'::jsonb)
      FROM public.amazon_mail_messages
      WHERE queue_status = 'unread' AND ticket_id IS NULL
    $query$ INTO v_v2_keys;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_v2_available := false;
  END;

  BEGIN
    EXECUTE $query$
      SELECT COALESCE(jsonb_agg(jsonb_build_array(provider_account_id, provider_message_id)), '[]'::jsonb)
      FROM public.inbound_ticket_messages
      WHERE source = 'amazon_zoho_mail'
        AND queue_status = 'unread'
        AND linked_ticket_id IS NULL
    $query$ INTO v_legacy_keys;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_legacy_available := false;
  END;

  IF NOT v_v2_available AND NOT v_legacy_available THEN
    RAISE EXCEPTION 'amazon_queue_sources_unavailable' USING ERRCODE = '42P01';
  END IF;

  SELECT count(*) INTO v_total
  FROM (
    SELECT DISTINCT value->>0 AS provider_account_id, value->>1 AS provider_message_id
    FROM jsonb_array_elements(v_v2_keys || v_legacy_keys)
  ) deduped;

  RETURN jsonb_build_object(
    'total', v_total,
    'v2_available', v_v2_available,
    'legacy_available', v_legacy_available
  );
END;
$$;

REVOKE ALL ON FUNCTION public.count_amazon_mail_queue_unread_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_amazon_mail_queue_unread_v1() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_amazon_mail_queue_unread_v1() TO service_role;
