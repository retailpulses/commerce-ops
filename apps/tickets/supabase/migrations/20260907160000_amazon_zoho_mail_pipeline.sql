-- Domain: ticketing
-- Owner: retailpulses/ticket-handling
-- Affected: inbound_ticket_messages, amazon_mail_sync_state, sent_messages,
--           ticket_messages, tickets, ticket_events; Amazon mail RPCs
-- Change class: additive schema and workload state with source-specific constraints
-- Hosted write required: yes; service_role only; explicit production approval required
-- Consumers: Ticket Handling Worker and authenticated Ticket Portal handlers

ALTER TABLE public.inbound_ticket_messages
  ALTER COLUMN shop_name DROP NOT NULL,
  ALTER COLUMN shop_id DROP NOT NULL,
  ALTER COLUMN order_transaction_id DROP NOT NULL,
  ALTER COLUMN webhook_received_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.platform_accounts(id),
  ADD COLUMN IF NOT EXISTS external_order_id text,
  ADD COLUMN IF NOT EXISTS message_subject text,
  ADD COLUMN IF NOT EXISTS source_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_account_id text,
  ADD COLUMN IF NOT EXISTS provider_folder_id text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS provider_thread_id text,
  ADD COLUMN IF NOT EXISTS mail_auth_status text,
  ADD COLUMN IF NOT EXISTS mail_auth_domain text,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attachment_processing_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS attachment_processing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachment_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attachment_next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS attachment_error_code text;

UPDATE public.inbound_ticket_messages
SET source_received_at = webhook_received_at
WHERE source = 'mercari_webhook'
  AND source_received_at IS NULL;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.inbound_ticket_messages'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%source IN (%mercari_webhook%'
        OR pg_get_constraintdef(oid) LIKE '%review_status IN (%needs_review%'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.inbound_ticket_messages DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

ALTER TABLE public.inbound_ticket_messages
  DROP CONSTRAINT IF EXISTS chk_inbound_ticket_messages_source,
  DROP CONSTRAINT IF EXISTS chk_inbound_ticket_messages_review_status,
  DROP CONSTRAINT IF EXISTS chk_inbound_ticket_messages_source_fields;

ALTER TABLE public.inbound_ticket_messages
  ADD CONSTRAINT chk_inbound_ticket_messages_source
    CHECK (source IN ('mercari_webhook', 'amazon_zoho_mail')),
  ADD CONSTRAINT chk_inbound_ticket_messages_review_status
    CHECK (review_status IN ('needs_review', 'reviewed', 'automation_candidate', 'untrusted_review')),
  ADD CONSTRAINT chk_inbound_ticket_messages_source_fields CHECK (
    (
      source = 'mercari_webhook'
      AND shop_name IS NOT NULL
      AND shop_id IS NOT NULL
      AND order_transaction_id IS NOT NULL
      AND webhook_received_at IS NOT NULL
      AND source_received_at IS NOT NULL
    )
    OR
    (
      source = 'amazon_zoho_mail'
      AND provider_account_id IS NOT NULL
      AND provider_folder_id IS NOT NULL
      AND provider_message_id IS NOT NULL
      AND source_received_at IS NOT NULL
      AND mail_auth_status IN ('pass', 'failed', 'unavailable')
      AND (
        (mail_auth_status = 'pass' AND external_order_id IS NOT NULL)
        OR review_status = 'untrusted_review'
        OR external_order_id IS NULL
      )
    )
  ),
  ADD CONSTRAINT chk_inbound_ticket_messages_attachment_status
    CHECK (attachment_processing_status IN ('none', 'pending', 'processing', 'completed', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_amazon_provider_message
  ON public.inbound_ticket_messages(source, provider_account_id, provider_message_id)
  WHERE source = 'amazon_zoho_mail';

CREATE INDEX IF NOT EXISTS idx_inbound_amazon_reconciliation
  ON public.inbound_ticket_messages(processing_status, source_received_at, id)
  WHERE source = 'amazon_zoho_mail'
    AND processing_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS public.amazon_mail_sync_state (
  provider_account_id text NOT NULL,
  provider_folder_id text NOT NULL,
  watermark_received_at timestamptz,
  watermark_message_id text,
  window_start timestamptz,
  run_to timestamptz,
  continuation text,
  last_success_at timestamptz,
  last_error_code text,
  last_run_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_account_id, provider_folder_id),
  CONSTRAINT chk_amazon_mail_sync_window CHECK (
    (continuation IS NULL AND window_start IS NULL AND run_to IS NULL)
    OR (continuation IS NOT NULL AND window_start IS NOT NULL AND run_to IS NOT NULL)
  )
);

ALTER TABLE public.amazon_mail_sync_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sent_messages
  ADD COLUMN IF NOT EXISTS source_inbound_message_id uuid
    REFERENCES public.inbound_ticket_messages(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reviewed_customer_message_id text,
  ADD COLUMN IF NOT EXISTS reviewed_customer_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_customer_revision text,
  ADD COLUMN IF NOT EXISTS reviewed_thread_revision text,
  ADD COLUMN IF NOT EXISTS provider_mutation_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lease_claimed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS no_send_first_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_send_last_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_send_observation_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.sent_messages
  DROP CONSTRAINT IF EXISTS sent_messages_delivery_status_check;
ALTER TABLE public.sent_messages
  ADD CONSTRAINT sent_messages_delivery_status_check
  CHECK (delivery_status IN ('sending', 'sent', 'ambiguous', 'confirmed_not_sent'));

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS message_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_message_revision bigint NOT NULL DEFAULT 0;

UPDATE public.tickets AS ticket
SET message_revision = (
  SELECT count(*) FROM public.ticket_messages AS message WHERE message.ticket_id = ticket.id
), customer_message_revision = (
  SELECT count(*) FROM public.ticket_messages AS message
  WHERE message.ticket_id = ticket.id AND message.sender_type = 'customer'
);

CREATE OR REPLACE FUNCTION public.increment_ticket_message_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tickets
  SET message_revision = COALESCE(message_revision, 0) + 1,
      customer_message_revision = COALESCE(customer_message_revision, 0)
        + CASE WHEN NEW.sender_type = 'customer' THEN 1 ELSE 0 END
  WHERE id = NEW.ticket_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_message_revision ON public.ticket_messages;
CREATE TRIGGER trg_ticket_message_revision
AFTER INSERT ON public.ticket_messages
FOR EACH ROW EXECUTE FUNCTION public.increment_ticket_message_revision();

CREATE INDEX IF NOT EXISTS idx_sent_messages_source_inbound
  ON public.sent_messages(source_inbound_message_id)
  WHERE source_inbound_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_active_send_lease
  ON public.sent_messages(ticket_id)
  WHERE platform = 'amazon' AND delivery_status IN ('sending', 'ambiguous');

CREATE OR REPLACE FUNCTION public.ingest_amazon_mail_message(
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
  p_provider_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inbound public.inbound_ticket_messages%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_external_message_id text;
  v_inserted boolean := false;
  v_message_inserted boolean := false;
BEGIN
  IF btrim(COALESCE(p_provider_account_id, '')) = '' OR
     btrim(COALESCE(p_provider_folder_id, '')) = '' OR
     btrim(COALESCE(p_provider_message_id, '')) = '' OR p_source_received_at IS NULL THEN
    RAISE EXCEPTION 'amazon_mail_source_identity_required' USING ERRCODE = '22023';
  END IF;
  IF p_mail_auth_status NOT IN ('pass', 'failed', 'unavailable') THEN
    RAISE EXCEPTION 'amazon_mail_auth_status_invalid' USING ERRCODE = '22023';
  END IF;

  v_external_message_id := 'zoho:' || p_provider_account_id || ':' || p_provider_message_id;

  INSERT INTO public.inbound_ticket_messages (
    source, account_id, external_order_id, external_thread_id, message_subject,
    latest_buyer_message, source_received_at, provider_account_id,
    provider_folder_id, provider_message_id, provider_thread_id,
    mail_auth_status, mail_auth_domain, provider_metadata,
    review_status, idempotency_key, processing_status, forwarding_status,
    forward_error, attachment_processing_status
  ) VALUES (
    'amazon_zoho_mail', p_account_id, NULLIF(btrim(p_external_order_id), ''),
    NULLIF(btrim(p_provider_thread_id), ''), p_subject,
    CASE WHEN p_mail_auth_status = 'pass' THEN p_body ELSE NULL END,
    p_source_received_at, p_provider_account_id, p_provider_folder_id,
    p_provider_message_id, NULLIF(btrim(p_provider_thread_id), ''),
    p_mail_auth_status, p_mail_auth_domain, COALESCE(p_provider_metadata, '{}'::jsonb),
    CASE WHEN p_mail_auth_status = 'pass' THEN 'needs_review' ELSE 'untrusted_review' END,
    v_external_message_id, 'completed', 'failed', 'source_not_applicable',
    CASE WHEN p_mail_auth_status = 'pass'
      AND jsonb_typeof(COALESCE(p_provider_metadata->'attachments', '[]'::jsonb)) = 'array'
      AND jsonb_array_length(COALESCE(p_provider_metadata->'attachments', '[]'::jsonb)) > 0
      THEN 'pending' ELSE 'none' END
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_inbound;

  IF FOUND THEN
    v_inserted := true;
  ELSE
    SELECT * INTO v_inbound
    FROM public.inbound_ticket_messages
    WHERE idempotency_key = v_external_message_id;

    UPDATE public.inbound_ticket_messages
    SET account_id = COALESCE(account_id, p_account_id),
        external_order_id = COALESCE(external_order_id, NULLIF(btrim(p_external_order_id), '')),
        updated_at = now()
    WHERE id = v_inbound.id
      AND (
        (account_id IS NULL AND p_account_id IS NOT NULL)
        OR (external_order_id IS NULL AND NULLIF(btrim(p_external_order_id), '') IS NOT NULL)
      )
    RETURNING * INTO v_inbound;
    IF NOT FOUND THEN
      SELECT * INTO v_inbound
      FROM public.inbound_ticket_messages
      WHERE idempotency_key = v_external_message_id;
    END IF;
  END IF;

  IF p_mail_auth_status = 'pass' AND v_inbound.account_id IS NOT NULL
     AND v_inbound.external_order_id IS NOT NULL THEN
    SELECT * INTO v_ticket
    FROM public.tickets
    WHERE platform = 'amazon'
      AND account_id = p_account_id
      AND external_order_id = v_inbound.external_order_id
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.inbound_ticket_messages
      SET linked_ticket_id = v_ticket.id,
          queue_status = 'linked'
      WHERE id = v_inbound.id
      RETURNING * INTO v_inbound;

      INSERT INTO public.ticket_messages (
        ticket_id, platform, external_message_id, sender_type, body, sent_at, raw_payload
      ) VALUES (
        v_ticket.id, 'amazon', v_external_message_id, 'customer', p_body,
        p_source_received_at,
        jsonb_build_object('source', 'amazon_zoho_mail', 'inbound_message_id', v_inbound.id)
      )
      ON CONFLICT (platform, external_message_id) WHERE external_message_id IS NOT NULL
      DO NOTHING;
      v_message_inserted := FOUND;

      IF v_message_inserted THEN
        UPDATE public.tickets
        SET latest_message_at = GREATEST(COALESCE(latest_message_at, '-infinity'::timestamptz), p_source_received_at),
            latest_customer_message = p_body,
            needs_reply = true,
            status = CASE
              WHEN status IN ('pending_customer', 'pending_third_party', 'resolved', 'closed', 'canceled')
                THEN 'in_progress'
              ELSE status
            END,
            updated_at = now()
        WHERE id = v_ticket.id;

        INSERT INTO public.ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
        VALUES (
          v_ticket.id, 'message_received', 'automation', 'amazon_zoho_mail_ingest',
          jsonb_build_object('inbound_message_id', v_inbound.id, 'external_message_id', v_external_message_id)
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'inbound_message_id', v_inbound.id,
    'inserted', v_inserted,
    'linked_ticket_id', v_inbound.linked_ticket_id,
    'ticket_message_inserted', v_message_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_amazon_mail_message(
  uuid, text, text, text, timestamptz, text, text, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_amazon_mail_message(
  uuid, text, text, text, timestamptz, text, text, text, text, text, text, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.convert_amazon_mail_to_ticket(
  p_inbound_message_id uuid,
  p_actor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inbound public.inbound_ticket_messages%ROWTYPE;
  v_ticket public.tickets%ROWTYPE;
  v_external_message_id text;
  v_created boolean := false;
  v_message_inserted boolean := false;
BEGIN
  IF btrim(COALESCE(p_actor_id, '')) = '' THEN
    RAISE EXCEPTION 'operator_actor_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inbound
  FROM public.inbound_ticket_messages
  WHERE id = p_inbound_message_id
  FOR UPDATE;

  IF NOT FOUND OR v_inbound.source <> 'amazon_zoho_mail' THEN
    RAISE EXCEPTION 'amazon_inbound_message_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inbound.mail_auth_status <> 'pass' OR v_inbound.external_order_id IS NULL OR
     v_inbound.account_id IS NULL OR v_inbound.latest_buyer_message IS NULL THEN
    RAISE EXCEPTION 'amazon_inbound_message_not_convertible' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE platform = 'amazon'
    AND account_id = v_inbound.account_id
    AND external_order_id = v_inbound.external_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.tickets (
      platform, account_id, external_order_id, external_thread_id, origin,
      subject, description, customer_display_name, status, priority,
      latest_message_at, latest_customer_message, needs_reply, raw_source_payload
    ) VALUES (
      'amazon', v_inbound.account_id, v_inbound.external_order_id,
      v_inbound.provider_thread_id, 'manual',
      COALESCE(NULLIF(v_inbound.message_subject, ''), 'Amazon buyer message'),
      v_inbound.latest_buyer_message, v_inbound.customer_display_name,
      'in_progress', 'normal', v_inbound.source_received_at,
      v_inbound.latest_buyer_message, true,
      jsonb_build_object('source', 'amazon_zoho_mail', 'converted_by', p_actor_id)
    )
    RETURNING * INTO v_ticket;
    v_created := true;

    INSERT INTO public.ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
    VALUES (
      v_ticket.id, 'ticket_created', 'operator', p_actor_id,
      jsonb_build_object('source', 'amazon_zoho_mail', 'inbound_message_id', v_inbound.id)
    );
  END IF;

  v_external_message_id := 'zoho:' || v_inbound.provider_account_id || ':' || v_inbound.provider_message_id;

  INSERT INTO public.ticket_messages (
    ticket_id, platform, external_message_id, sender_type, body, sent_at, raw_payload
  ) VALUES (
    v_ticket.id, 'amazon', v_external_message_id, 'customer',
    v_inbound.latest_buyer_message, v_inbound.source_received_at,
    jsonb_build_object('source', 'amazon_zoho_mail', 'inbound_message_id', v_inbound.id)
  )
  ON CONFLICT (platform, external_message_id) WHERE external_message_id IS NOT NULL
  DO NOTHING;
  v_message_inserted := FOUND;

  UPDATE public.inbound_ticket_messages
  SET linked_ticket_id = v_ticket.id,
      queue_status = CASE WHEN v_created THEN 'converted' ELSE 'linked' END,
      review_status = 'reviewed',
      reviewed_at = now()
  WHERE id = v_inbound.id;

  IF v_message_inserted AND NOT v_created THEN
    UPDATE public.tickets
    SET external_thread_id = COALESCE(external_thread_id, v_inbound.provider_thread_id),
        latest_message_at = GREATEST(COALESCE(latest_message_at, '-infinity'::timestamptz), v_inbound.source_received_at),
        latest_customer_message = v_inbound.latest_buyer_message,
        needs_reply = true,
        status = CASE
          WHEN status IN ('pending_customer', 'pending_third_party', 'resolved', 'closed', 'canceled')
            THEN 'in_progress'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_ticket.id;
  END IF;

  RETURN jsonb_build_object(
    'ticket_id', v_ticket.id,
    'ticket_number', v_ticket.ticket_number,
    'ticket_created', v_created,
    'ticket_message_inserted', v_message_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.convert_amazon_mail_to_ticket(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.convert_amazon_mail_to_ticket(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_amazon_mail_attachments(p_limit integer DEFAULT 25)
RETURNS SETOF public.inbound_ticket_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.inbound_ticket_messages
  SET attachment_processing_status = 'failed',
      attachment_claimed_at = NULL,
      attachment_next_retry_at = NULL,
      attachment_error_code = 'attachment_retries_exhausted',
      updated_at = now()
  WHERE source = 'amazon_zoho_mail'
    AND attachment_processing_status = 'processing'
    AND attachment_processing_attempts >= 5
    AND attachment_claimed_at < now() - interval '15 minutes';

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.inbound_ticket_messages
    WHERE source = 'amazon_zoho_mail'
      AND mail_auth_status = 'pass'
      AND linked_ticket_id IS NOT NULL
      AND (
        attachment_processing_status IN ('pending', 'failed')
        OR (attachment_processing_status = 'processing' AND attachment_claimed_at < now() - interval '15 minutes')
      )
      AND (attachment_next_retry_at IS NULL OR attachment_next_retry_at <= now())
      AND (
        attachment_processing_attempts < 4
        OR (
          attachment_processing_status = 'processing'
          AND attachment_processing_attempts = 4
          AND attachment_claimed_at < now() - interval '15 minutes'
        )
      )
    ORDER BY source_received_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  )
  UPDATE public.inbound_ticket_messages AS message
  SET attachment_processing_status = 'processing',
      attachment_processing_attempts = attachment_processing_attempts + 1,
      attachment_claimed_at = now(),
      attachment_error_code = NULL,
      updated_at = now()
  FROM candidates
  WHERE message.id = candidates.id
  RETURNING message.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_amazon_mail_attachments(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_amazon_mail_attachments(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_amazon_mail_attachment_batch(p_results jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected integer := jsonb_array_length(COALESCE(p_results, '[]'::jsonb));
  v_updated integer;
BEGIN
  IF jsonb_typeof(COALESCE(p_results, '[]'::jsonb)) <> 'array' OR v_expected > 25 THEN
    RAISE EXCEPTION 'amazon_attachment_batch_invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb)) result
    LEFT JOIN public.inbound_ticket_messages source
      ON source.id = (result->>'source_id')::uuid
      AND source.source = 'amazon_zoho_mail'
      AND source.linked_ticket_id IS NOT NULL
      AND source.attachment_processing_status = 'processing'
    WHERE source.id IS NULL
      OR result->>'status' NOT IN ('completed', 'failed')
      OR jsonb_array_length(COALESCE(result->'evidence', '[]'::jsonb)) > 5
  ) THEN
    RAISE EXCEPTION 'amazon_attachment_batch_claim_mismatch' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.ticket_attachments(
    ticket_id, storage_bucket, storage_path, filename, mime_type,
    media_type, size_bytes, source, metadata
  )
  SELECT
    (evidence->>'ticket_id')::uuid,
    evidence->>'storage_bucket',
    evidence->>'storage_path',
    NULLIF(evidence->>'filename', ''),
    evidence->>'mime_type',
    evidence->>'media_type',
    (evidence->>'size_bytes')::bigint,
    evidence->>'source',
    COALESCE(evidence->'metadata', '{}'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb)) result
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(result->'evidence', '[]'::jsonb)) evidence
  ON CONFLICT (storage_bucket, storage_path) DO NOTHING;

  UPDATE public.inbound_ticket_messages source
  SET provider_metadata = result->'provider_metadata',
      attachment_processing_status = result->>'status',
      attachment_claimed_at = NULL,
      attachment_next_retry_at = NULLIF(result->>'next_retry_at', '')::timestamptz,
      attachment_error_code = NULLIF(result->>'error_code', '')
  FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb)) result
  WHERE source.id = (result->>'source_id')::uuid
    AND source.attachment_processing_status = 'processing';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'amazon_attachment_batch_concurrent_change' USING ERRCODE = '40001';
  END IF;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_amazon_mail_attachment_batch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_amazon_mail_attachment_batch(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.promote_abandoned_amazon_send(
  p_ticket_id uuid,
  p_client_operation_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sent public.sent_messages%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  UPDATE public.sent_messages
  SET delivery_status = 'ambiguous',
      delivery_error = 'provider_mutation_worker_abandoned'
  WHERE ticket_id = p_ticket_id
    AND platform = 'amazon'
    AND delivery_status = 'sending'
    AND provider_mutation_started_at IS NOT NULL
    AND provider_mutation_started_at < now() - interval '5 minutes'
    AND (p_client_operation_id IS NULL OR client_operation_id = p_client_operation_id)
  RETURNING * INTO v_sent;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_ticket_id, 'platform_sync_failed', 'system', NULL,
    jsonb_build_object(
      'source', 'amazon_zoho_mail_reply_recovery',
      'client_operation_id', v_sent.client_operation_id,
      'resolution', 'worker_abandoned_to_ambiguous'
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_abandoned_amazon_send(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_abandoned_amazon_send(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_amazon_mail_send(
  p_ticket_id uuid,
  p_client_operation_id uuid,
  p_body text,
  p_reply_intent text,
  p_sent_by text,
  p_source_inbound_message_id uuid,
  p_reviewed_customer_message_id text,
  p_reviewed_customer_message_at timestamptz,
  p_reviewed_customer_revision text,
  p_reviewed_thread_revision text
)
RETURNS TABLE(sent_message jsonb, ticket_message jsonb, claimed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets%ROWTYPE;
  v_sent public.sent_messages%ROWTYPE;
  v_ticket_message public.ticket_messages%ROWTYPE;
  v_latest_revision text;
BEGIN
  IF btrim(COALESCE(p_body, '')) = '' OR p_reply_intent NOT IN ('terminal', 'holding') OR
     p_source_inbound_message_id IS NULL OR btrim(COALESCE(p_reviewed_customer_message_id, '')) = '' OR
     p_reviewed_customer_message_at IS NULL OR btrim(COALESCE(p_reviewed_customer_revision, '')) = '' OR
     btrim(COALESCE(p_reviewed_thread_revision, '')) = '' THEN
    RAISE EXCEPTION 'amazon_send_claim_evidence_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ticket FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.platform <> 'amazon' THEN
    RAISE EXCEPTION 'amazon_ticket_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.promote_abandoned_amazon_send(p_ticket_id, NULL);

  SELECT * INTO v_sent FROM public.sent_messages
  WHERE ticket_id = p_ticket_id AND client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_sent.platform <> 'amazon' OR v_sent.body IS DISTINCT FROM p_body OR
       v_sent.reply_intent IS DISTINCT FROM p_reply_intent OR
       v_sent.source_inbound_message_id IS DISTINCT FROM p_source_inbound_message_id OR
       v_sent.reviewed_customer_message_id IS DISTINCT FROM p_reviewed_customer_message_id OR
       v_sent.reviewed_customer_message_at IS DISTINCT FROM p_reviewed_customer_message_at OR
       v_sent.reviewed_customer_revision IS DISTINCT FROM p_reviewed_customer_revision OR
       v_sent.reviewed_thread_revision IS DISTINCT FROM p_reviewed_thread_revision THEN
      RAISE EXCEPTION 'client_operation_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_sent.delivery_status = 'sent' THEN
      SELECT * INTO v_ticket_message FROM public.ticket_messages
      WHERE ticket_id = p_ticket_id AND client_operation_id = p_client_operation_id;
    END IF;
    IF v_sent.delivery_status = 'confirmed_not_sent' THEN
      RETURN QUERY SELECT to_jsonb(v_sent), NULL::jsonb, false;
      RETURN;
    END IF;
    IF v_sent.delivery_status = 'sending' AND v_sent.provider_mutation_started_at IS NULL
       AND v_sent.lease_claimed_at < now() - interval '15 minutes' THEN
      IF v_ticket.message_revision::text IS DISTINCT FROM p_reviewed_thread_revision OR
         v_ticket.customer_message_revision::text IS DISTINCT FROM p_reviewed_customer_revision THEN
        RAISE EXCEPTION 'amazon_thread_revision_stale' USING ERRCODE = '40001';
      END IF;
      UPDATE public.sent_messages
      SET lease_generation = lease_generation + 1,
          lease_claimed_at = now(),
          platform_message_ids_before_send = NULL,
          delivery_error = NULL
      WHERE id = v_sent.id
      RETURNING * INTO v_sent;
      RETURN QUERY SELECT to_jsonb(v_sent), NULL::jsonb, true;
      RETURN;
    END IF;
    RETURN QUERY SELECT to_jsonb(v_sent),
      CASE WHEN v_ticket_message.id IS NULL THEN NULL ELSE to_jsonb(v_ticket_message) END,
      false;
    RETURN;
  END IF;

  v_latest_revision := v_ticket.message_revision::text;
  IF v_latest_revision IS DISTINCT FROM p_reviewed_thread_revision OR
     v_ticket.customer_message_revision::text IS DISTINCT FROM p_reviewed_customer_revision THEN
    RAISE EXCEPTION 'amazon_thread_revision_stale' USING ERRCODE = '40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inbound_ticket_messages
    WHERE id = p_source_inbound_message_id
      AND source = 'amazon_zoho_mail'
      AND linked_ticket_id = p_ticket_id
      AND mail_auth_status = 'pass'
      AND ('zoho:' || provider_account_id || ':' || provider_message_id) = p_reviewed_customer_message_id
      AND source_received_at = p_reviewed_customer_message_at
  ) THEN
    RAISE EXCEPTION 'amazon_reviewed_source_not_authorized' USING ERRCODE = '22023';
  END IF;

  UPDATE public.sent_messages
  SET delivery_status = 'confirmed_not_sent',
      delivery_error = 'pre_mutation_lease_reclaimed'
  WHERE ticket_id = p_ticket_id AND platform = 'amazon'
    AND delivery_status = 'sending'
    AND provider_mutation_started_at IS NULL
    AND lease_claimed_at < now() - interval '15 minutes';

  IF EXISTS (
    SELECT 1 FROM public.sent_messages
    WHERE ticket_id = p_ticket_id AND platform = 'amazon'
      AND delivery_status IN ('sending', 'ambiguous')
  ) THEN
    RAISE EXCEPTION 'amazon_send_in_progress' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.sent_messages(
    ticket_id, platform, client_operation_id, platform_message_id, body,
    reply_intent, sent_by, delivery_status, source_inbound_message_id,
    reviewed_customer_message_id, reviewed_customer_message_at,
    reviewed_customer_revision, reviewed_thread_revision
  ) VALUES (
    p_ticket_id, 'amazon', p_client_operation_id, NULL, p_body,
    p_reply_intent, p_sent_by, 'sending', p_source_inbound_message_id,
    p_reviewed_customer_message_id, p_reviewed_customer_message_at,
    p_reviewed_customer_revision, p_reviewed_thread_revision
  ) RETURNING * INTO v_sent;

  RETURN QUERY SELECT to_jsonb(v_sent), NULL::jsonb, true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_amazon_mail_send(
  uuid, uuid, text, text, text, uuid, text, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_amazon_mail_send(
  uuid, uuid, text, text, text, uuid, text, timestamptz, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_amazon_mail_send_as_not_sent(
  p_ticket_id uuid,
  p_client_operation_id uuid,
  p_actor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sent public.sent_messages%ROWTYPE;
  v_now timestamptz := now();
  v_terminal boolean := false;
BEGIN
  IF btrim(COALESCE(p_actor_id, '')) = '' THEN
    RAISE EXCEPTION 'operator_actor_required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  SELECT * INTO v_sent FROM public.sent_messages
  WHERE ticket_id = p_ticket_id AND client_operation_id = p_client_operation_id
    AND platform = 'amazon' AND delivery_status IN ('ambiguous', 'confirmed_not_sent')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'amazon_active_send_lease_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sent.delivery_status = 'confirmed_not_sent' THEN
    RETURN jsonb_build_object('resolution', 'confirmed_not_sent', 'replayed', true);
  END IF;

  IF v_sent.provider_mutation_started_at IS NULL THEN
    v_terminal := true;
  ELSIF v_sent.no_send_first_observed_at IS NULL THEN
    UPDATE public.sent_messages
    SET delivery_status = 'ambiguous',
        no_send_first_observed_at = v_now,
        no_send_last_observed_at = v_now,
        no_send_observation_count = 1
    WHERE id = v_sent.id;
  ELSIF v_now >= v_sent.provider_mutation_started_at + interval '30 minutes'
        AND v_now >= v_sent.no_send_first_observed_at + interval '5 minutes' THEN
    v_terminal := true;
  ELSE
    UPDATE public.sent_messages
    SET delivery_status = 'ambiguous',
        no_send_last_observed_at = v_now,
        no_send_observation_count = no_send_observation_count + 1
    WHERE id = v_sent.id;
  END IF;

  IF v_terminal THEN
    UPDATE public.sent_messages
    SET delivery_status = 'confirmed_not_sent',
        delivery_error = NULL,
        no_send_first_observed_at = COALESCE(no_send_first_observed_at, v_now),
        no_send_last_observed_at = v_now,
        no_send_observation_count = no_send_observation_count + 1
    WHERE id = v_sent.id;
  END IF;
  INSERT INTO public.ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_ticket_id, 'platform_sync_failed', 'operator', p_actor_id,
    jsonb_build_object(
      'source', 'amazon_zoho_mail_reply_resolution',
      'client_operation_id', p_client_operation_id,
      'resolution', CASE WHEN v_terminal THEN 'confirmed_not_sent' ELSE 'no_send_observed' END,
      'provider_mutation_started', v_sent.provider_mutation_started_at IS NOT NULL
    )
  );
  IF v_terminal THEN
    RETURN jsonb_build_object('resolution', 'confirmed_not_sent', 'replayed', false);
  END IF;
  RETURN jsonb_build_object(
    'resolution', 'settlement_pending',
    'eligible_after', v_sent.provider_mutation_started_at + interval '30 minutes',
    'next_observation_after', v_now + interval '5 minutes'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_amazon_mail_send_as_not_sent(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_amazon_mail_send_as_not_sent(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.begin_amazon_mail_provider_mutation(
  p_ticket_id uuid,
  p_client_operation_id uuid,
  p_lease_generation bigint
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets%ROWTYPE;
  v_sent public.sent_messages%ROWTYPE;
  v_started_at timestamptz := now();
BEGIN
  SELECT * INTO v_ticket FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.platform <> 'amazon' THEN
    RAISE EXCEPTION 'amazon_ticket_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_sent FROM public.sent_messages
  WHERE ticket_id = p_ticket_id
    AND client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF NOT FOUND OR v_sent.platform <> 'amazon' OR v_sent.delivery_status <> 'sending' OR
     v_sent.provider_mutation_started_at IS NOT NULL OR
     v_sent.lease_generation IS DISTINCT FROM p_lease_generation THEN
    RAISE EXCEPTION 'amazon_send_lease_fenced' USING ERRCODE = '40001';
  END IF;
  IF v_ticket.message_revision::text IS DISTINCT FROM v_sent.reviewed_thread_revision THEN
    RAISE EXCEPTION 'amazon_thread_revision_stale' USING ERRCODE = '40001';
  END IF;
  UPDATE public.sent_messages
  SET provider_mutation_started_at = v_started_at
  WHERE id = v_sent.id;
  RETURN v_started_at;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_amazon_mail_provider_mutation(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_amazon_mail_provider_mutation(uuid, uuid, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_amazon_mail_send(
  p_ticket_id uuid,
  p_client_operation_id uuid,
  p_platform_message_id text,
  p_platform_sent_at timestamptz,
  p_sent_by text
)
RETURNS TABLE (
  sent_message jsonb,
  ticket_message jsonb,
  replayed boolean,
  newer_customer_message boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets%ROWTYPE;
  v_sent public.sent_messages%ROWTYPE;
  v_source public.inbound_ticket_messages%ROWTYPE;
  v_latest public.inbound_ticket_messages%ROWTYPE;
  v_ticket_message public.ticket_messages%ROWTYPE;
  v_replayed boolean := false;
  v_newer boolean := true;
  v_latest_external_id text;
  v_customer_newer boolean := true;
BEGIN
  IF btrim(COALESCE(p_platform_message_id, '')) = '' THEN
    RAISE EXCEPTION 'amazon_finalize_evidence_required' USING ERRCODE = '22023';
  END IF;

  -- Ingestion locks the same ticket before publishing customer state, so this
  -- lock serializes finalization with any customer message currently linking.
  SELECT * INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id
  FOR UPDATE;
  IF NOT FOUND OR v_ticket.platform <> 'amazon' THEN
    RAISE EXCEPTION 'amazon_ticket_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_sent
  FROM public.sent_messages
  WHERE ticket_id = p_ticket_id
    AND client_operation_id = p_client_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbound_message_claim_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sent.platform <> 'amazon' OR v_sent.source_inbound_message_id IS NULL OR
     btrim(COALESCE(v_sent.reviewed_customer_message_id, '')) = '' OR
     v_sent.reviewed_customer_message_at IS NULL THEN
    RAISE EXCEPTION 'amazon_outbound_source_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_sent.delivery_status = 'confirmed_not_sent' THEN
    RAISE EXCEPTION 'amazon_send_confirmed_not_sent' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_source
  FROM public.inbound_ticket_messages
  WHERE id = v_sent.source_inbound_message_id
    AND source = 'amazon_zoho_mail'
    AND linked_ticket_id = p_ticket_id
    AND mail_auth_status = 'pass';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'amazon_outbound_source_not_authorized' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_latest
  FROM public.inbound_ticket_messages
  WHERE source = 'amazon_zoho_mail'
    AND linked_ticket_id = p_ticket_id
    AND mail_auth_status = 'pass'
  ORDER BY source_received_at DESC, provider_message_id DESC
  LIMIT 1;

  v_latest_external_id := 'zoho:' || v_latest.provider_account_id || ':' || v_latest.provider_message_id;
  v_customer_newer := v_latest.id IS DISTINCT FROM v_sent.source_inbound_message_id
    OR v_latest_external_id IS DISTINCT FROM v_sent.reviewed_customer_message_id
    OR v_latest.source_received_at IS DISTINCT FROM v_sent.reviewed_customer_message_at;
  v_newer := v_customer_newer
    OR v_ticket.customer_message_revision::text IS DISTINCT FROM v_sent.reviewed_customer_revision;

  IF v_sent.delivery_status = 'sent' THEN
    SELECT * INTO v_ticket_message
    FROM public.ticket_messages
    WHERE ticket_id = p_ticket_id
      AND client_operation_id = p_client_operation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'completed_outbound_message_missing_ticket_message';
    END IF;
    RETURN QUERY SELECT to_jsonb(v_sent), to_jsonb(v_ticket_message), true, v_newer;
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
    ticket_id, platform, external_message_id, sender_type,
    sender_display_name, body, sent_at, raw_payload, client_operation_id
  ) VALUES (
    p_ticket_id, 'amazon', p_platform_message_id, 'operator', p_sent_by,
    v_sent.body, COALESCE(p_platform_sent_at, now()),
    jsonb_build_object(
      'source', 'amazon_zoho_mail_reply',
      'client_operation_id', p_client_operation_id,
      'source_inbound_message_id', v_sent.source_inbound_message_id,
      'reviewed_customer_message_id', v_sent.reviewed_customer_message_id,
      'reviewed_customer_message_at', v_sent.reviewed_customer_message_at
    ),
    p_client_operation_id
  )
  ON CONFLICT (ticket_id, client_operation_id)
    WHERE client_operation_id IS NOT NULL
  DO UPDATE SET external_message_id = EXCLUDED.external_message_id
  RETURNING * INTO v_ticket_message;

  INSERT INTO public.ticket_events(ticket_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_ticket_id, 'message_sent', 'operator', p_sent_by,
    jsonb_build_object(
      'platform_message_id', p_platform_message_id,
      'reply_intent', v_sent.reply_intent,
      'body_preview', left(v_sent.body, 100),
      'client_operation_id', p_client_operation_id,
      'source_inbound_message_id', v_sent.source_inbound_message_id,
      'newer_customer_message', v_newer
    )
  );

  IF v_sent.reply_intent = 'terminal' AND NOT v_newer THEN
    UPDATE public.tickets SET needs_reply = false, updated_at = now()
    WHERE id = p_ticket_id;
  ELSIF v_newer THEN
    UPDATE public.tickets SET needs_reply = true, updated_at = now()
    WHERE id = p_ticket_id AND needs_reply = false;
  END IF;

  RETURN QUERY SELECT to_jsonb(v_sent), to_jsonb(v_ticket_message), v_replayed, v_newer;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_amazon_mail_send(
  uuid, uuid, text, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_amazon_mail_send(
  uuid, uuid, text, timestamptz, text
) TO service_role;

COMMENT ON TABLE public.amazon_mail_sync_state IS
  'worker_only lossless Zoho folder checkpoint with persisted frozen traversal window';
COMMENT ON FUNCTION public.ingest_amazon_mail_message(
  uuid, text, text, text, timestamptz, text, text, text, text, text, text, jsonb
) IS 'Idempotently persists Amazon Zoho mail and may append only to an existing exact Amazon ticket; never creates tickets.';
COMMENT ON FUNCTION public.convert_amazon_mail_to_ticket(uuid, text) IS
  'Authenticated-operator-only application path for transactional Amazon queue conversion or linking.';
COMMENT ON FUNCTION public.finalize_amazon_mail_send(
  uuid, uuid, text, timestamptz, text
) IS 'Atomically audits a Zoho reply and clears needs_reply only while the reviewed trusted customer message remains latest.';
