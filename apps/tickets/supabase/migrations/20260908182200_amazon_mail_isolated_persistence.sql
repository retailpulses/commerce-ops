-- Domain: ticketing/amazon
-- Owner: retailpulses/ticket-handling
-- Affected: amazon_mail_messages, amazon_mail_sync_state_v2
-- Change class: additive, platform-isolated
-- Hosted write required: yes; exact-SHA approval and readback required
-- Consumers: Amazon mail ingestion adapter only

CREATE TABLE IF NOT EXISTS public.amazon_mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.platform_accounts(id),
  ticket_id uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  provider_account_id text NOT NULL,
  provider_folder_id text NOT NULL,
  provider_message_id text NOT NULL,
  provider_thread_id text,
  external_order_id text,
  subject text,
  body text,
  source_received_at timestamptz NOT NULL,
  mail_auth_status text NOT NULL,
  mail_auth_domain text,
  review_status text NOT NULL,
  processing_status text NOT NULL DEFAULT 'pending',
  attachment_count integer NOT NULL DEFAULT 0,
  attachment_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_amazon_mail_message
    UNIQUE (provider_account_id, provider_message_id),
  CONSTRAINT chk_amazon_mail_auth_status
    CHECK (mail_auth_status IN ('pass', 'failed', 'unavailable')),
  CONSTRAINT chk_amazon_mail_review_status
    CHECK (review_status IN ('needs_review', 'reviewed', 'automation_candidate', 'untrusted_review')),
  CONSTRAINT chk_amazon_mail_untrusted_minimization CHECK (
    mail_auth_status = 'pass'
    OR (review_status = 'untrusted_review' AND ticket_id IS NULL AND subject IS NULL AND body IS NULL)
  ),
  CONSTRAINT chk_amazon_mail_processing_status
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT chk_amazon_mail_attachment_count
    CHECK (attachment_count >= 0),
  CONSTRAINT chk_amazon_mail_attachment_summary
    CHECK (jsonb_typeof(attachment_summary) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_amazon_mail_review_queue
  ON public.amazon_mail_messages(review_status, source_received_at, id);
CREATE INDEX IF NOT EXISTS idx_amazon_mail_ticket
  ON public.amazon_mail_messages(ticket_id, source_received_at DESC)
  WHERE ticket_id IS NOT NULL;

ALTER TABLE public.amazon_mail_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.amazon_mail_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.amazon_mail_messages FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.amazon_mail_messages FROM service_role;
GRANT SELECT ON TABLE public.amazon_mail_messages TO service_role;

CREATE TABLE IF NOT EXISTS public.amazon_mail_sync_state_v2 (
  provider_account_id text NOT NULL,
  provider_folder_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
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
  CONSTRAINT chk_amazon_mail_sync_v2_window CHECK (
    (continuation IS NULL AND window_start IS NULL AND run_to IS NULL)
    OR (continuation IS NOT NULL AND window_start IS NOT NULL AND run_to IS NOT NULL)
  ),
  CONSTRAINT chk_amazon_mail_sync_v2_metrics
    CHECK (jsonb_typeof(last_run_metrics) = 'object'),
  CONSTRAINT chk_amazon_mail_sync_v2_generation CHECK (generation > 0)
);
ALTER TABLE public.amazon_mail_sync_state_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.amazon_mail_sync_state_v2 FROM PUBLIC;
REVOKE ALL ON TABLE public.amazon_mail_sync_state_v2 FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.amazon_mail_sync_state_v2 FROM service_role;
GRANT SELECT ON TABLE public.amazon_mail_sync_state_v2 TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_amazon_mail_sync_state_v2(
  p_provider_account_id text,
  p_provider_folder_id text,
  p_expected_generation bigint,
  p_watermark_received_at timestamptz,
  p_watermark_message_id text,
  p_window_start timestamptz,
  p_run_to timestamptz,
  p_continuation text,
  p_last_success_at timestamptz,
  p_last_error_code text,
  p_last_run_metrics jsonb
)
RETURNS public.amazon_mail_sync_state_v2
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.amazon_mail_sync_state_v2%ROWTYPE;
BEGIN
  IF btrim(COALESCE(p_provider_account_id, '')) = ''
     OR btrim(COALESCE(p_provider_folder_id, '')) = ''
     OR p_expected_generation IS NULL OR p_expected_generation < 0 THEN
    RAISE EXCEPTION 'amazon_provider_account_required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.amazon_mail_sync_state_v2 (
    provider_account_id, provider_folder_id, generation,
    watermark_received_at, watermark_message_id,
    window_start, run_to, continuation, last_success_at, last_error_code,
    last_run_metrics, updated_at
  ) VALUES (
    p_provider_account_id, p_provider_folder_id, 1,
    p_watermark_received_at, p_watermark_message_id,
    p_window_start, p_run_to, p_continuation, p_last_success_at, p_last_error_code,
    COALESCE(p_last_run_metrics, '{}'::jsonb), now()
  )
  ON CONFLICT (provider_account_id, provider_folder_id) DO UPDATE SET
    generation = amazon_mail_sync_state_v2.generation + 1,
    watermark_received_at = EXCLUDED.watermark_received_at,
    watermark_message_id = EXCLUDED.watermark_message_id,
    window_start = EXCLUDED.window_start,
    run_to = EXCLUDED.run_to,
    continuation = EXCLUDED.continuation,
    last_success_at = EXCLUDED.last_success_at,
    last_error_code = EXCLUDED.last_error_code,
    last_run_metrics = EXCLUDED.last_run_metrics,
    updated_at = now()
  WHERE amazon_mail_sync_state_v2.generation = p_expected_generation
    AND (
      p_watermark_received_at IS NULL
      OR amazon_mail_sync_state_v2.watermark_received_at IS NULL
      OR p_watermark_received_at >= amazon_mail_sync_state_v2.watermark_received_at
    )
  RETURNING * INTO v_row;
  IF NOT FOUND
     OR (v_row.generation = 1 AND p_expected_generation <> 0)
     OR (v_row.generation > 1 AND v_row.generation <> p_expected_generation + 1) THEN
    RAISE EXCEPTION 'amazon_sync_checkpoint_conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_amazon_mail_sync_state_v2(
  text, text, bigint, timestamptz, text, timestamptz, timestamptz, text,
  timestamptz, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_amazon_mail_sync_state_v2(
  text, text, bigint, timestamptz, text, timestamptz, timestamptz, text,
  timestamptz, text, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_amazon_mail_message_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.account_id IS DISTINCT FROM OLD.account_id OR
    NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id OR
    NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR
    NEW.external_order_id IS DISTINCT FROM OLD.external_order_id OR
    NEW.body IS DISTINCT FROM OLD.body OR
    NEW.source_received_at IS DISTINCT FROM OLD.source_received_at
  ) THEN
    RAISE EXCEPTION 'amazon_mail_immutable_evidence_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_accounts
                 WHERE id = NEW.account_id AND platform = 'amazon') THEN
    RAISE EXCEPTION 'amazon_mail_account_platform_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tickets
    WHERE id = NEW.ticket_id
      AND platform = 'amazon'
      AND account_id = NEW.account_id
      AND external_order_id = NEW.external_order_id
  ) THEN
    RAISE EXCEPTION 'amazon_mail_ticket_scope_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_amazon_mail_message_scope ON public.amazon_mail_messages;
CREATE TRIGGER trg_amazon_mail_message_scope
BEFORE INSERT OR UPDATE OF account_id, ticket_id, provider_account_id,
  provider_message_id, external_order_id, body, source_received_at ON public.amazon_mail_messages
FOR EACH ROW EXECUTE FUNCTION public.enforce_amazon_mail_message_scope();
REVOKE ALL ON FUNCTION public.enforce_amazon_mail_message_scope() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ingest_amazon_mail_message_v2(
  p_account_id uuid,
  p_ticket_id uuid,
  p_provider_account_id text,
  p_provider_folder_id text,
  p_provider_message_id text,
  p_provider_thread_id text,
  p_external_order_id text,
  p_subject text,
  p_body text,
  p_source_received_at timestamptz,
  p_mail_auth_status text,
  p_mail_auth_domain text,
  p_review_status text,
  p_attachment_count integer
)
RETURNS public.amazon_mail_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.amazon_mail_messages%ROWTYPE;
BEGIN
  INSERT INTO public.amazon_mail_messages (
    account_id, ticket_id, provider_account_id, provider_folder_id,
    provider_message_id, provider_thread_id, external_order_id, subject, body,
    source_received_at, mail_auth_status, mail_auth_domain, review_status,
    attachment_count
  ) VALUES (
    p_account_id, p_ticket_id, p_provider_account_id, p_provider_folder_id,
    p_provider_message_id, p_provider_thread_id, p_external_order_id, p_subject, p_body,
    p_source_received_at, p_mail_auth_status, p_mail_auth_domain, p_review_status,
    COALESCE(p_attachment_count, 0)
  )
  ON CONFLICT (provider_account_id, provider_message_id) DO UPDATE SET
    provider_folder_id = EXCLUDED.provider_folder_id,
    ticket_id = COALESCE(amazon_mail_messages.ticket_id, EXCLUDED.ticket_id),
    provider_thread_id = COALESCE(amazon_mail_messages.provider_thread_id, EXCLUDED.provider_thread_id),
    external_order_id = COALESCE(amazon_mail_messages.external_order_id, EXCLUDED.external_order_id),
    updated_at = now()
  RETURNING * INTO v_row;
  IF v_row.account_id IS DISTINCT FROM p_account_id
     OR v_row.ticket_id IS DISTINCT FROM p_ticket_id
     OR v_row.external_order_id IS DISTINCT FROM p_external_order_id
     OR v_row.body IS DISTINCT FROM p_body
     OR v_row.source_received_at IS DISTINCT FROM p_source_received_at THEN
    RAISE EXCEPTION 'amazon_mail_replay_contract_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.ingest_amazon_mail_message_v2(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_amazon_mail_message_v2(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer
) TO service_role;

COMMENT ON TABLE public.amazon_mail_messages IS
  'worker_only Amazon mail evidence; never shared with Mercari webhook persistence';
