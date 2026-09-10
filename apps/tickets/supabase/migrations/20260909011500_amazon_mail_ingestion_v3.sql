-- Domain: ticketing/amazon
-- Owner: retailpulses/ticket-handling
-- Affected: amazon_mail_messages, ticket_messages, tickets, ticket_events
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required
-- Consumers: Amazon mail ingestion adapter only

CREATE OR REPLACE FUNCTION public.enforce_amazon_mail_message_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_auth_promotion boolean := TG_OP = 'UPDATE'
  AND OLD.mail_auth_status IN ('failed', 'unavailable') AND NEW.mail_auth_status = 'pass';
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.account_id IS DISTINCT FROM OLD.account_id OR
    NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id OR
    NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR
    NEW.source_received_at IS DISTINCT FROM OLD.source_received_at OR
    (NOT v_auth_promotion AND (
      NEW.external_order_id IS DISTINCT FROM OLD.external_order_id OR
      NEW.body IS DISTINCT FROM OLD.body
    ))
  ) THEN
    RAISE EXCEPTION 'amazon_mail_immutable_evidence_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_accounts
                 WHERE id = NEW.account_id AND platform = 'amazon') THEN
    RAISE EXCEPTION 'amazon_mail_account_platform_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tickets
    WHERE id = NEW.ticket_id AND platform = 'amazon'
      AND account_id = NEW.account_id
      AND external_order_id = NEW.external_order_id
  ) THEN
    RAISE EXCEPTION 'amazon_mail_ticket_scope_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.ingest_amazon_mail_message_v3(
  p_account_id uuid,
  p_external_order_id text,
  p_subject text,
  p_body text,
  p_source_received_at timestamptz,
  p_provider_account_id text,
  p_provider_folder_id text,
  p_provider_message_id text,
  p_provider_thread_id text,
  p_mail_auth_status text,
  p_mail_auth_domain text,
  p_attachment_count integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mail public.amazon_mail_messages%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_external_message_id text;
  v_ticket_ids uuid[];
  v_ticket_message_id uuid;
  v_inserted boolean := false;
  v_message_inserted boolean := false;
  v_order_id text;
  v_trusted boolean := p_mail_auth_status = 'pass';
  v_ticket_state_changed boolean := false;
BEGIN
  IF p_account_id IS NULL
     OR btrim(COALESCE(p_provider_account_id, '')) = ''
     OR btrim(COALESCE(p_provider_folder_id, '')) = ''
     OR btrim(COALESCE(p_provider_message_id, '')) = ''
     OR p_source_received_at IS NULL THEN
    RAISE EXCEPTION 'amazon_mail_source_identity_required' USING ERRCODE = '22023';
  END IF;
  IF p_mail_auth_status NOT IN ('pass', 'failed', 'unavailable') THEN
    RAISE EXCEPTION 'amazon_mail_auth_status_invalid' USING ERRCODE = '22023';
  END IF;
  v_order_id := CASE WHEN v_trusted THEN NULLIF(btrim(p_external_order_id), '') ELSE NULL END;
  IF v_order_id IS NOT NULL AND v_order_id !~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$' THEN
    RAISE EXCEPTION 'amazon_order_id_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_accounts
    WHERE id = p_account_id AND platform = 'amazon'
  ) THEN
    RAISE EXCEPTION 'amazon_mail_account_platform_mismatch' USING ERRCODE = '23514';
  END IF;

  IF v_trusted AND v_order_id IS NOT NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_ticket_ids
    FROM public.tickets
    WHERE platform = 'amazon'
      AND account_id = p_account_id
      AND external_order_id = v_order_id;
    IF cardinality(v_ticket_ids) > 1 THEN
      RAISE EXCEPTION 'amazon_ticket_binding_ambiguous' USING ERRCODE = '23514';
    END IF;
    IF cardinality(v_ticket_ids) = 1 THEN
      SELECT * INTO v_ticket FROM public.tickets WHERE id = v_ticket_ids[1] FOR UPDATE;
    END IF;
  END IF;

  INSERT INTO public.amazon_mail_messages (
    account_id, ticket_id, provider_account_id, provider_folder_id,
    provider_message_id, provider_thread_id, external_order_id, subject, body,
    source_received_at, mail_auth_status, mail_auth_domain, review_status,
    processing_status, attachment_count
  ) VALUES (
    p_account_id, v_ticket.id, p_provider_account_id, p_provider_folder_id,
    p_provider_message_id, NULLIF(btrim(p_provider_thread_id), ''), v_order_id,
    CASE WHEN v_trusted THEN p_subject ELSE NULL END,
    CASE WHEN v_trusted THEN p_body ELSE NULL END,
    p_source_received_at, p_mail_auth_status, p_mail_auth_domain,
    CASE WHEN v_trusted AND v_ticket.id IS NOT NULL THEN 'reviewed'
         WHEN v_trusted THEN 'needs_review' ELSE 'untrusted_review' END,
    'completed', CASE WHEN v_trusted THEN COALESCE(p_attachment_count, 0) ELSE 0 END
  )
  ON CONFLICT (provider_account_id, provider_message_id) DO NOTHING
  RETURNING * INTO v_mail;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT * INTO v_mail
    FROM public.amazon_mail_messages
    WHERE provider_account_id = p_provider_account_id
      AND provider_message_id = p_provider_message_id
    FOR UPDATE;
    IF v_mail.account_id IS DISTINCT FROM p_account_id
       OR (v_mail.provider_thread_id IS NOT NULL AND
          v_mail.provider_thread_id IS DISTINCT FROM NULLIF(btrim(p_provider_thread_id), ''))
       OR v_mail.source_received_at IS DISTINCT FROM p_source_received_at THEN
      RAISE EXCEPTION 'amazon_mail_replay_contract_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_mail.mail_auth_status IN ('failed', 'unavailable') AND v_trusted THEN
      UPDATE public.amazon_mail_messages
      SET provider_folder_id = p_provider_folder_id,
          provider_thread_id = COALESCE(provider_thread_id, NULLIF(btrim(p_provider_thread_id), '')),
          external_order_id = v_order_id, subject = p_subject, body = p_body,
          mail_auth_status = 'pass', mail_auth_domain = p_mail_auth_domain,
          review_status = CASE WHEN v_ticket.id IS NULL THEN 'needs_review' ELSE 'reviewed' END,
          processing_status = 'completed', attachment_count = COALESCE(p_attachment_count, 0),
          ticket_id = v_ticket.id, updated_at = now()
      WHERE id = v_mail.id RETURNING * INTO v_mail;
    ELSIF v_mail.external_order_id IS DISTINCT FROM v_order_id
       OR v_mail.subject IS DISTINCT FROM (CASE WHEN v_trusted THEN p_subject ELSE NULL END)
       OR v_mail.body IS DISTINCT FROM (CASE WHEN v_trusted THEN p_body ELSE NULL END)
       OR v_mail.mail_auth_status IS DISTINCT FROM p_mail_auth_status
       OR v_mail.mail_auth_domain IS DISTINCT FROM p_mail_auth_domain
       OR v_mail.attachment_count IS DISTINCT FROM
          (CASE WHEN v_trusted THEN COALESCE(p_attachment_count, 0) ELSE 0 END) THEN
      RAISE EXCEPTION 'amazon_mail_replay_contract_mismatch' USING ERRCODE = '23514';
    END IF;
    UPDATE public.amazon_mail_messages
    SET provider_folder_id = p_provider_folder_id,
        provider_thread_id = COALESCE(provider_thread_id, NULLIF(btrim(p_provider_thread_id), '')),
        updated_at = now()
    WHERE id = v_mail.id
    RETURNING * INTO v_mail;
  END IF;

  IF v_trusted AND v_ticket.id IS NOT NULL THEN
    IF v_mail.ticket_id IS NULL THEN
      UPDATE public.amazon_mail_messages
      SET ticket_id = v_ticket.id, review_status = 'reviewed', updated_at = now()
      WHERE id = v_mail.id
      RETURNING * INTO v_mail;
    ELSIF v_mail.ticket_id IS DISTINCT FROM v_ticket.id THEN
      RAISE EXCEPTION 'amazon_mail_ticket_scope_mismatch' USING ERRCODE = '23514';
    END IF;

    v_external_message_id := 'zoho:' || p_provider_account_id || ':' || p_provider_message_id;
    INSERT INTO public.ticket_messages (
      ticket_id, platform, external_message_id, sender_type, body, sent_at, raw_payload
    ) VALUES (
      v_ticket.id, 'amazon', v_external_message_id, 'customer', p_body,
      p_source_received_at,
      jsonb_build_object('source', 'amazon_mail_messages', 'amazon_mail_message_id', v_mail.id)
    )
    ON CONFLICT (platform, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_ticket_message_id;
    v_message_inserted := FOUND;

    IF NOT v_message_inserted THEN
      SELECT id INTO v_ticket_message_id
      FROM public.ticket_messages
      WHERE platform = 'amazon' AND external_message_id = v_external_message_id
        AND ticket_id = v_ticket.id AND sender_type = 'customer'
        AND body IS NOT DISTINCT FROM p_body
        AND sent_at IS NOT DISTINCT FROM p_source_received_at;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'amazon_ticket_message_replay_mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;

    IF v_message_inserted THEN
      UPDATE public.tickets
      SET external_thread_id = COALESCE(external_thread_id, NULLIF(btrim(p_provider_thread_id), '')),
          latest_message_at = GREATEST(COALESCE(latest_message_at, '-infinity'::timestamptz), p_source_received_at),
          latest_customer_message = CASE
            WHEN latest_message_at IS NULL OR p_source_received_at >= latest_message_at THEN p_body
            ELSE latest_customer_message END,
          needs_reply = CASE
            WHEN latest_message_at IS NULL OR p_source_received_at >= latest_message_at THEN true
            ELSE needs_reply END,
          status = CASE
            WHEN (latest_message_at IS NULL OR p_source_received_at >= latest_message_at)
             AND status IN ('pending_customer', 'pending_third_party', 'resolved', 'closed', 'canceled')
              THEN 'in_progress' ELSE status END,
          updated_at = now()
      WHERE id = v_ticket.id;
      v_ticket_state_changed := true;

      INSERT INTO public.ticket_events(ticket_id, event_type, actor_type, actor_id, payload, idempotency_key)
      VALUES (
        v_ticket.id, 'message_received', 'automation', 'amazon_zoho_mail_ingest',
        jsonb_build_object('amazon_mail_message_id', v_mail.id, 'external_message_id', v_external_message_id),
        'amazon_mail_message_received:' || v_mail.id
      ) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'amazon_mail_message_id', v_mail.id,
    'evidence_inserted', v_inserted,
    'replayed', NOT v_inserted,
    'binding_state', CASE WHEN NOT v_trusted THEN 'untrusted'
      WHEN v_mail.ticket_id IS NULL THEN 'review_required' ELSE 'linked_existing_ticket' END,
    'linked_ticket_id', v_mail.ticket_id,
    'ticket_message_id', v_ticket_message_id,
    'ticket_message_inserted', v_message_inserted
    ,'ticket_state_changed', v_ticket_state_changed,
    'review_status', v_mail.review_status,
    'processing_status', v_mail.processing_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_amazon_mail_message_v3(
  uuid, text, text, text, timestamptz, text, text, text, text, text, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_amazon_mail_message_v3(
  uuid, text, text, text, timestamptz, text, text, text, text, text, text, integer
) TO service_role;

COMMENT ON FUNCTION public.ingest_amazon_mail_message_v3(
  uuid, text, text, text, timestamptz, text, text, text, text, text, text, integer
) IS 'Amazon-only idempotent mail evidence ingestion with atomic normalized ticket projection';

CREATE OR REPLACE FUNCTION public.validate_amazon_mail_sync_window(
  p_window_start timestamptz,
  p_run_to timestamptz,
  p_continuation text
)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE v_continuation jsonb; v_segment_date date;
BEGIN
  IF NOT ((p_continuation IS NULL AND p_window_start IS NULL AND p_run_to IS NULL)
      OR (p_continuation IS NOT NULL AND p_window_start IS NOT NULL AND p_run_to IS NOT NULL))
     OR (p_continuation IS NOT NULL AND p_window_start > p_run_to) THEN
    RAISE EXCEPTION 'amazon_sync_checkpoint_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_continuation IS NULL THEN RETURN; END IF;
  BEGIN
    v_continuation := p_continuation::jsonb;
    IF jsonb_typeof(v_continuation) <> 'object'
       OR NOT (v_continuation ? 'segment_date')
       OR v_continuation->>'segment_date' IS NULL
       OR (v_continuation->>'segment_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR v_continuation <> jsonb_build_object('segment_date', v_continuation->>'segment_date') THEN
      RAISE EXCEPTION 'amazon_sync_checkpoint_invalid' USING ERRCODE = '23514';
    END IF;
    v_segment_date := (v_continuation->>'segment_date')::date;
    IF v_segment_date < p_window_start::date OR v_segment_date > p_run_to::date THEN
      RAISE EXCEPTION 'amazon_sync_checkpoint_invalid' USING ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'amazon_sync_checkpoint_invalid' USING ERRCODE = '23514';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_amazon_mail_sync_window()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.validate_amazon_mail_sync_window(NEW.window_start, NEW.run_to, NEW.continuation);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_amazon_mail_sync_window ON public.amazon_mail_sync_state_v2;
CREATE TRIGGER trg_amazon_mail_sync_window
BEFORE INSERT OR UPDATE OF window_start, run_to, continuation ON public.amazon_mail_sync_state_v2
FOR EACH ROW EXECUTE FUNCTION public.enforce_amazon_mail_sync_window();
REVOKE ALL ON FUNCTION public.validate_amazon_mail_sync_window(timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_amazon_mail_sync_window() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.seed_amazon_mail_sync_state_v2_from_legacy(
  p_provider_account_id text,
  p_provider_folder_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state public.amazon_mail_sync_state_v2%ROWTYPE;
  v_legacy jsonb;
  v_continuation jsonb;
  v_segment_date date;
  v_source text;
BEGIN
  IF btrim(COALESCE(p_provider_account_id, '')) = ''
     OR btrim(COALESCE(p_provider_folder_id, '')) = '' THEN
    RAISE EXCEPTION 'amazon_provider_account_required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_provider_account_id || ':' || p_provider_folder_id, 0
  ));

  SELECT * INTO v_state FROM public.amazon_mail_sync_state_v2
  WHERE provider_account_id = p_provider_account_id
    AND provider_folder_id = p_provider_folder_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.validate_amazon_mail_sync_window(
      v_state.window_start, v_state.run_to, v_state.continuation
    );
    RETURN to_jsonb(v_state) || jsonb_build_object('source', 'v2_existing');
  END IF;

  IF to_regclass('public.amazon_mail_sync_state') IS NOT NULL THEN
    EXECUTE
      'SELECT to_jsonb(s) FROM public.amazon_mail_sync_state s '
      'WHERE provider_account_id = $1 AND provider_folder_id = $2'
      INTO v_legacy USING p_provider_account_id, p_provider_folder_id;
  END IF;
  IF v_legacy IS NOT NULL AND NOT (
    (v_legacy->>'continuation' IS NULL AND v_legacy->>'window_start' IS NULL AND v_legacy->>'run_to' IS NULL)
    OR (v_legacy->>'continuation' IS NOT NULL AND v_legacy->>'window_start' IS NOT NULL AND v_legacy->>'run_to' IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'amazon_legacy_checkpoint_invalid' USING ERRCODE = '23514';
  END IF;
  IF v_legacy IS NOT NULL THEN
    BEGIN
      PERFORM public.validate_amazon_mail_sync_window(
        (v_legacy->>'window_start')::timestamptz,
        (v_legacy->>'run_to')::timestamptz,
        v_legacy->>'continuation'
      );
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'amazon_legacy_checkpoint_invalid' USING ERRCODE = '23514';
    END;
  END IF;
  IF v_legacy->>'continuation' IS NOT NULL
     AND (v_legacy->>'window_start')::timestamptz > (v_legacy->>'run_to')::timestamptz THEN
    RAISE EXCEPTION 'amazon_legacy_checkpoint_invalid' USING ERRCODE = '23514';
  END IF;
  IF v_legacy->>'continuation' IS NOT NULL THEN
    BEGIN
      v_continuation := (v_legacy->>'continuation')::jsonb;
      IF jsonb_typeof(v_continuation) <> 'object'
         OR NOT (v_continuation ? 'segment_date')
         OR v_continuation->>'segment_date' IS NULL
         OR (v_continuation->>'segment_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         OR v_continuation <> jsonb_build_object('segment_date', v_continuation->>'segment_date') THEN
        RAISE EXCEPTION 'amazon_legacy_checkpoint_invalid' USING ERRCODE = '23514';
      END IF;
      v_segment_date := (v_continuation->>'segment_date')::date;
      IF v_segment_date < (v_legacy->>'window_start')::timestamptz::date
         OR v_segment_date > (v_legacy->>'run_to')::timestamptz::date THEN
        RAISE EXCEPTION 'amazon_legacy_checkpoint_invalid' USING ERRCODE = '23514';
      END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'amazon_legacy_checkpoint_invalid' USING ERRCODE = '23514';
    END;
  END IF;

  INSERT INTO public.amazon_mail_sync_state_v2 (
    provider_account_id, provider_folder_id, generation,
    watermark_received_at, watermark_message_id, window_start, run_to,
    continuation, last_success_at, last_error_code, last_run_metrics
  ) VALUES (
    p_provider_account_id, p_provider_folder_id, 1,
    (v_legacy->>'watermark_received_at')::timestamptz,
    v_legacy->>'watermark_message_id',
    (v_legacy->>'window_start')::timestamptz,
    (v_legacy->>'run_to')::timestamptz,
    v_legacy->>'continuation',
    (v_legacy->>'last_success_at')::timestamptz,
    v_legacy->>'last_error_code',
    COALESCE(v_legacy->'last_run_metrics', '{}'::jsonb)
  )
  RETURNING * INTO v_state;
  v_source := CASE WHEN v_legacy IS NULL THEN 'empty_initialized' ELSE 'legacy_seeded' END;
  RETURN to_jsonb(v_state) || jsonb_build_object('source', v_source);
END;
$$;

REVOKE ALL ON FUNCTION public.seed_amazon_mail_sync_state_v2_from_legacy(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_amazon_mail_sync_state_v2_from_legacy(text, text) TO service_role;
