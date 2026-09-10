-- Record the business outcome and optional ticket closure atomically.
ALTER TABLE public.ticket_resolution_actions
  ADD COLUMN IF NOT EXISTS external_reference text,
  ADD COLUMN IF NOT EXISTS operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_resolution_operation
  ON public.ticket_resolution_actions (operation_id)
  WHERE operation_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.ticket_attachments
    GROUP BY storage_bucket, storage_path
    HAVING count(*) > 1 AND (
      bool_or(source <> 'imported_baserow')
      OR bool_or(storage_bucket NOT LIKE 'r2:%')
      OR count(DISTINCT ticket_id) > 1
      OR count(DISTINCT customer_submission_id) > 1
      OR count(DISTINCT COALESCE(original_url, '')) > 1
      OR count(DISTINCT COALESCE(filename, '')) > 1
      OR count(DISTINCT COALESCE(mime_type, '')) > 1
      OR count(DISTINCT media_type) > 1
      OR count(DISTINCT COALESCE(size_bytes, -1)) > 1
    )
  ) THEN
    RAISE EXCEPTION
      'conflicting attachment storage paths must be reconciled before enabling idempotent finalization';
  END IF;
END $$;

-- The Baserow retirement import can legitimately encounter the same physical
-- R2 object once through the legacy ticket row and once through its legacy form
-- row. Consolidate only those compatible pairs, prefer the row linked to the
-- customer submission, and preserve both source keys/metadata as provenance.
WITH ranked AS (
  SELECT
    id,
    storage_bucket,
    storage_path,
    row_number() OVER (
      PARTITION BY storage_bucket, storage_path
      ORDER BY (customer_submission_id IS NOT NULL) DESC, created_at, id
    ) AS duplicate_rank
  FROM public.ticket_attachments
), provenance AS (
  SELECT
    storage_bucket,
    storage_path,
    jsonb_agg(jsonb_build_object(
      'attachment_id', id,
      'legacy_baserow_file_key', legacy_baserow_file_key,
      'customer_submission_id', customer_submission_id,
      'metadata', metadata
    ) ORDER BY created_at, id) AS sources
  FROM public.ticket_attachments
  GROUP BY storage_bucket, storage_path
  HAVING count(*) > 1
)
UPDATE public.ticket_attachments keeper
SET metadata = keeper.metadata || jsonb_build_object(
  'consolidated_legacy_provenance', provenance.sources
)
FROM ranked
JOIN provenance USING (storage_bucket, storage_path)
WHERE keeper.id = ranked.id
  AND ranked.duplicate_rank = 1;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY storage_bucket, storage_path
      ORDER BY (customer_submission_id IS NOT NULL) DESC, created_at, id
    ) AS duplicate_rank
  FROM public.ticket_attachments
)
DELETE FROM public.ticket_attachments duplicate
USING ranked
WHERE duplicate.id = ranked.id
  AND ranked.duplicate_rank > 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ticket_attachments
    GROUP BY storage_bucket, storage_path
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate attachment storage paths remain after safe legacy consolidation';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_attachments_storage_object
  ON public.ticket_attachments (storage_bucket, storage_path);

ALTER TABLE public.ticket_events
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_events_idempotency_key
  ON public.ticket_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Paid-plan bucket policy: create or harden the private evidence bucket and
-- accept original customer/operator image/video evidence. Keeping this in the
-- migration prevents a Worker deploy from depending on a dashboard-only step.
INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) VALUES (
  'ticket-attachments',
  'ticket-attachments',
  false,
  104857600,
  ARRAY['image/*', 'video/*']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.ticket_events
  DROP CONSTRAINT IF EXISTS ticket_events_event_type_check;
ALTER TABLE public.ticket_events
  DROP CONSTRAINT IF EXISTS chk_ticket_events_event_type;
ALTER TABLE public.ticket_events
  ADD CONSTRAINT ticket_events_event_type_check CHECK (event_type IN (
    'ticket_created','ticket_reopened','message_added','message_received',
    'message_sent','status_changed','priority_changed','resolution_updated',
    'attachment_added','attachment_removed','product_linked','product_unlinked',
    'note_added','ai_reply_generated','operator_escalated','wecom_notified',
    'platform_sync_failed'
  ));

DROP FUNCTION IF EXISTS public.record_ticket_resolution(
  uuid, text, numeric, text, text, integer, text, text, text, boolean
);

CREATE OR REPLACE FUNCTION public.record_ticket_resolution(
  p_ticket_id uuid,
  p_operation_id uuid,
  p_action_type text,
  p_amount numeric DEFAULT NULL,
  p_currency text DEFAULT 'JPY',
  p_replacement_sku text DEFAULT NULL,
  p_quantity integer DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_external_reference text DEFAULT NULL,
  p_actor text DEFAULT NULL,
  p_close_ticket boolean DEFAULT true
)
RETURNS SETOF public.ticket_resolution_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action public.ticket_resolution_actions;
  v_previous_status text;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'resolution_operation_id_required' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_previous_status
  FROM public.tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  SELECT * INTO v_action
  FROM public.ticket_resolution_actions
  WHERE operation_id = p_operation_id;

  IF FOUND THEN
    IF v_action.ticket_id <> p_ticket_id THEN
      RAISE EXCEPTION 'resolution_operation_ticket_mismatch' USING ERRCODE = '22023';
    END IF;
    RETURN NEXT v_action;
    RETURN;
  END IF;

  INSERT INTO public.ticket_resolution_actions (
    ticket_id, action_type, amount, currency, replacement_sku, quantity,
    reason, approved_by, external_reference, operation_id, executed_at
  ) VALUES (
    p_ticket_id, p_action_type, p_amount, COALESCE(p_currency, 'JPY'),
    p_replacement_sku, p_quantity, p_reason, p_actor,
    p_external_reference, p_operation_id, now()
  ) RETURNING * INTO v_action;

  INSERT INTO public.ticket_events (
    ticket_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    p_ticket_id, 'resolution_updated', 'operator', p_actor,
    jsonb_build_object(
      'resolution_action_id', v_action.id,
      'action_type', p_action_type,
      'amount', p_amount,
      'currency', COALESCE(p_currency, 'JPY'),
      'external_reference', p_external_reference
    )
  );

  IF p_close_ticket AND v_previous_status <> 'closed' THEN
    UPDATE public.tickets
    SET status = 'closed', closed_at = now(), updated_at = now(), needs_reply = false
    WHERE id = p_ticket_id;

    INSERT INTO public.ticket_events (
      ticket_id, event_type, actor_type, actor_id, payload
    ) VALUES (
      p_ticket_id, 'status_changed', 'operator', p_actor,
      jsonb_build_object(
        'from', v_previous_status,
        'to', 'closed',
        'resolution_action_id', v_action.id
      )
    );
  END IF;

  RETURN NEXT v_action;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ticket_resolution(
  uuid, uuid, text, numeric, text, text, integer, text, text, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_ticket_resolution(
  uuid, uuid, text, numeric, text, text, integer, text, text, text, boolean
) TO service_role;
