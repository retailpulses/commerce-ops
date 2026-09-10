-- Domain: ticketing
-- Owner: retailpulses/ticket-handling
-- Affected: rakuten_rmesse_inquiries, rakuten_rmesse_sync_state, ticket_messages, tickets, ticket_events, ingest_rakuten_rmesse_inquiry
-- Change class: additive
-- Hosted write required: yes
-- Consumers: retailpulses/ticket-handling

CREATE TABLE IF NOT EXISTS public.rakuten_rmesse_inquiries (
  account_id uuid NOT NULL REFERENCES public.platform_accounts(id),
  inquiry_number text NOT NULL,
  shop_id text NOT NULL,
  order_number text NOT NULL,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  last_update_date timestamptz NOT NULL,
  last_ingested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, inquiry_number),
  CONSTRAINT rakuten_rmesse_order_required CHECK (btrim(order_number) <> '')
);

ALTER TABLE public.rakuten_rmesse_inquiries ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.rakuten_rmesse_inquiries IS
  'worker_only exact R-Messe inquiry to Rakuten order and ticket mapping';

CREATE INDEX IF NOT EXISTS idx_rakuten_rmesse_ticket
  ON public.rakuten_rmesse_inquiries(ticket_id);
CREATE INDEX IF NOT EXISTS idx_rakuten_rmesse_updated
  ON public.rakuten_rmesse_inquiries(account_id, last_update_date DESC);

CREATE TABLE IF NOT EXISTS public.rakuten_rmesse_sync_state (
  account_id uuid PRIMARY KEY REFERENCES public.platform_accounts(id),
  cursor_updated_at timestamptz NOT NULL,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rakuten_rmesse_sync_state ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.rakuten_rmesse_sync_state IS
  'worker_only bounded overlap cursor for official RMS InquiryManagementAPI pulls';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_messages_platform_external
  ON public.ticket_messages(platform, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ingest_rakuten_rmesse_inquiry(
  p_account_id uuid,
  p_shop_id text,
  p_inquiry_number text,
  p_order_number text,
  p_external_url text,
  p_category text,
  p_last_update_date timestamptz,
  p_messages jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket tickets%ROWTYPE;
  v_message jsonb;
  v_inserted integer := 0;
  v_customer_inserted integer := 0;
  v_latest_customer_at timestamptz;
  v_created boolean := false;
BEGIN
  IF p_account_id IS NULL OR btrim(COALESCE(p_inquiry_number, '')) = '' OR
     btrim(COALESCE(p_order_number, '')) = '' THEN
    RAISE EXCEPTION 'rakuten_order_qualification_required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_messages, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'messages_must_be_array' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM tickets
  WHERE platform = 'rakuten'
    AND account_id = p_account_id
    AND external_order_id = p_order_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO tickets (
      platform, account_id, external_order_id, external_thread_id, origin,
      subject, status, priority, external_url, raw_source_payload
    ) VALUES (
      'rakuten', p_account_id, p_order_number, p_inquiry_number, 'platform_ingest',
      COALESCE(NULLIF(p_category, ''), 'Rakuten R-Messe inquiry'),
      'open', 'normal', p_external_url,
      jsonb_build_object('source', 'rms_inquiry_management_api', 'shop_id', p_shop_id)
    )
    RETURNING * INTO v_ticket;
    v_created := true;

    INSERT INTO ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
    VALUES (v_ticket.id, 'ticket_created', 'automation', 'rakuten_rmesse_ingest',
      jsonb_build_object('inquiry_number', p_inquiry_number, 'order_qualified', true));
  END IF;

  INSERT INTO rakuten_rmesse_inquiries(
    account_id, inquiry_number, shop_id, order_number, ticket_id, last_update_date
  ) VALUES (
    p_account_id, p_inquiry_number, p_shop_id, p_order_number, v_ticket.id, p_last_update_date
  )
  ON CONFLICT (account_id, inquiry_number) DO UPDATE SET
    order_number = EXCLUDED.order_number,
    ticket_id = EXCLUDED.ticket_id,
    last_update_date = GREATEST(rakuten_rmesse_inquiries.last_update_date, EXCLUDED.last_update_date),
    last_ingested_at = now();

  FOR v_message IN SELECT value FROM jsonb_array_elements(p_messages)
  LOOP
    IF btrim(COALESCE(v_message->>'external_message_id', '')) = '' OR
       btrim(COALESCE(v_message->>'body', '')) = '' THEN
      CONTINUE;
    END IF;

    INSERT INTO ticket_messages(
      ticket_id, platform, external_message_id, sender_type, body, sent_at, raw_payload
    ) VALUES (
      v_ticket.id, 'rakuten', v_message->>'external_message_id',
      CASE WHEN v_message->>'sender_type' = 'seller' THEN 'seller' ELSE 'customer' END,
      v_message->>'body', (v_message->>'sent_at')::timestamptz,
      jsonb_build_object('source', 'rms_inquiry_management_api', 'inquiry_number', p_inquiry_number)
    )
    ON CONFLICT (platform, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
      IF v_message->>'sender_type' = 'customer' THEN
        v_customer_inserted := v_customer_inserted + 1;
        v_latest_customer_at := GREATEST(
          COALESCE(v_latest_customer_at, '-infinity'::timestamptz),
          (v_message->>'sent_at')::timestamptz
        );
      END IF;
    END IF;
  END LOOP;

  IF v_inserted > 0 THEN
    UPDATE tickets SET
      latest_message_at = GREATEST(COALESCE(latest_message_at, '-infinity'::timestamptz), p_last_update_date),
      latest_customer_message = CASE WHEN v_customer_inserted > 0 THEN
        (SELECT body FROM ticket_messages
         WHERE ticket_id = v_ticket.id AND sender_type = 'customer'
         ORDER BY sent_at DESC LIMIT 1)
        ELSE latest_customer_message END,
      needs_reply = CASE WHEN v_customer_inserted > 0 THEN true ELSE needs_reply END,
      status = CASE
        WHEN v_customer_inserted > 0 AND status IN ('resolved','closed','canceled') THEN 'in_progress'
        ELSE status END,
      updated_at = now()
    WHERE id = v_ticket.id;

    INSERT INTO ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
    VALUES (v_ticket.id, 'message_received', 'automation', 'rakuten_rmesse_ingest',
      jsonb_build_object('inquiry_number', p_inquiry_number, 'messages_inserted', v_inserted,
        'customer_messages_inserted', v_customer_inserted));
  END IF;

  RETURN jsonb_build_object(
    'ticket_id', v_ticket.id,
    'ticket_number', v_ticket.ticket_number,
    'ticket_created', v_created,
    'messages_inserted', v_inserted,
    'customer_messages_inserted', v_customer_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_rakuten_rmesse_inquiry(
  uuid, text, text, text, text, text, timestamptz, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_rakuten_rmesse_inquiry(
  uuid, text, text, text, text, text, timestamptz, jsonb
) TO service_role;
