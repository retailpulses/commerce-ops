-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiries, inquiry_messages (new), inquiry_webhook_events (new),
--   inquiry_ingestion_runs (new), inquiry_quarantine (new),
--   inquiry_outbound_operations (new), inquiry_follow_up_events (new),
--   inquiry_message_timeline_vw (new), follow_up_review_queue_vw (new),
--   follow_up_upcoming_vw (new), follow_up_history_vw (new),
--   inquiry_claim_outbound_cycle, inquiry_finalize_outbound,
--   inquiry_schedule_follow_up, inquiry_claim_webhook_event,
--   inquiry_complete_webhook_event, inquiry_reconcile_api_thread
-- Change class: additive (roll-forward only; no destructive down-migration)
-- Hosted write required: yes
-- Consumers:
--   inquiry-automation Worker (webhook ingest, async processing, daily audit)
--   inquiry-automation dashboard (operator timeline, Send/finalize, follow-up queue)
--
-- Purpose: implement the Mercari inquiry API-first canonical data model from
-- docs/01_ARCHITECTURE.md / docs/phases/mercari-inquiry-api-redesign/README.md.
-- Canonical identity is source-neutral:
--   inquiry  -> (shop_key, external_inquiry_id)
--   message  -> (shop_key, external_message_id)
-- `source='mercari_shops'` remains provenance only and never splits identity.

-- =============================================================================
-- 1. inquiries — additive external / follow-up cycle columns
-- =============================================================================

ALTER TABLE public.inquiries
  ADD COLUMN IF NOT EXISTS external_status TEXT,
  ADD COLUMN IF NOT EXISTS external_sales_channel TEXT,
  ADD COLUMN IF NOT EXISTS external_first_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_target_type TEXT,
  ADD COLUMN IF NOT EXISTS external_product_id TEXT,
  ADD COLUMN IF NOT EXISTS external_product_variant_id TEXT,
  ADD COLUMN IF NOT EXISTS external_order_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS external_shop_id TEXT,
  ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_payload JSONB,

  -- Follow-up cycle state (single source of truth; legacy follow_up_status is
  -- retained as read-only provenance and no longer drives any queue).
  ADD COLUMN IF NOT EXISTS follow_up_state TEXT
    CHECK (follow_up_state IN ('scheduled', 'superseded_by_inbound', 'followed_up', 'do_not_follow_up', 'cleared')),
  ADD COLUMN IF NOT EXISTS follow_up_due_date DATE,
  ADD COLUMN IF NOT EXISTS follow_up_date_source TEXT
    CHECK (follow_up_date_source IN ('auto_after_reply', 'operator_override')),
  ADD COLUMN IF NOT EXISTS follow_up_date_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS follow_up_date_updated_by TEXT,
  ADD COLUMN IF NOT EXISTS follow_up_cycle_id UUID,
  ADD COLUMN IF NOT EXISTS follow_up_cycle_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_confirmed_outbound_message_id TEXT,
  ADD COLUMN IF NOT EXISTS last_confirmed_outbound_at TIMESTAMPTZ;

COMMENT ON COLUMN public.inquiries.follow_up_state IS
  'Single follow-up cycle state. due/overdue are derived from follow_up_due_date in JST; not persisted separately.';
COMMENT ON COLUMN public.inquiries.follow_up_status IS
  'Legacy read-only field. The new follow-up queue is driven solely by follow_up_state/follow_up_due_date.';

CREATE INDEX IF NOT EXISTS idx_inquiries_follow_up_queue
  ON public.inquiries (follow_up_state, follow_up_due_date)
  WHERE follow_up_state = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_inquiries_external_target_type
  ON public.inquiries (external_target_type);

-- =============================================================================
-- 2. Source-neutral canonical identity (inquiries)
--    Safe handling of pre-existing duplicates: this migration never chooses,
--    merges, deletes, or soft-deletes user records. Any duplicate active
--    identity aborts the migration with an exact diagnostic. A separately
--    reviewed bounded repair must resolve it before this migration is retried.
-- =============================================================================

DO $$
DECLARE
  v_duplicate_count BIGINT;
  v_sample TEXT;
BEGIN
  SELECT COUNT(*) INTO v_duplicate_count
  FROM (
    SELECT shop_key, external_inquiry_id
    FROM public.inquiries
    WHERE shop_key IS NOT NULL
      AND external_inquiry_id IS NOT NULL
      AND deleted_at IS NULL
    GROUP BY shop_key, external_inquiry_id
    HAVING COUNT(*) > 1
  ) duplicates;

  IF v_duplicate_count > 0 THEN
    SELECT string_agg(format('%s/%s ids=%s', shop_key, external_inquiry_id, ids), '; ')
    INTO v_sample
    FROM (
      SELECT shop_key, external_inquiry_id, array_agg(id ORDER BY id) AS ids
      FROM public.inquiries
      WHERE shop_key IS NOT NULL AND external_inquiry_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY shop_key, external_inquiry_id
      HAVING COUNT(*) > 1
      ORDER BY shop_key, external_inquiry_id
      LIMIT 10
    ) samples;
    RAISE EXCEPTION 'canonical inquiry identity preflight failed: % duplicate groups; sample: %',
      v_duplicate_count, v_sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiries_shop_external_identity
  ON public.inquiries (shop_key, external_inquiry_id)
  WHERE shop_key IS NOT NULL AND external_inquiry_id IS NOT NULL AND deleted_at IS NULL;

-- =============================================================================
-- 3. inquiry_messages — normalized message table (canonical source-neutral)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inquiry_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id BIGINT NOT NULL REFERENCES public.inquiries(id) ON DELETE CASCADE,
  shop_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'mercari_shops',
  external_inquiry_id TEXT,
  external_message_id TEXT NOT NULL,
  external_from TEXT,                    -- BUYER / SELLER / ADMIN
  direction TEXT                         -- inbound / outbound
    CHECK (direction IN ('inbound', 'outbound')),
  body TEXT,
  sent_at TIMESTAMPTZ,
  external_status TEXT,                  -- ACTIVE / DELETED / ...
  deleted_at TIMESTAMPTZ,                -- change-aware tombstone (admin-delete)
  attachments_metadata JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_observed_at TIMESTAMPTZ,
  source_payload_hash TEXT,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outbound_operation_id BIGINT,          -- FK added below after ledger creation
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_messages_shop_external
  ON public.inquiry_messages (shop_key, external_message_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_messages_inquiry_sent
  ON public.inquiry_messages (inquiry_id, sent_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_inquiry_messages_external_inquiry
  ON public.inquiry_messages (external_inquiry_id);

DROP TRIGGER IF EXISTS trg_inquiry_messages_updated_at ON public.inquiry_messages;
CREATE TRIGGER trg_inquiry_messages_updated_at
  BEFORE UPDATE ON public.inquiry_messages
  FOR EACH ROW EXECUTE FUNCTION public.inquiry_management_set_updated_at();

ALTER TABLE public.inquiry_messages ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 4. Durable webhook event inbox
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inquiry_webhook_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_identity TEXT NOT NULL,
  shop_key TEXT,
  topic TEXT NOT NULL,
  external_event_id TEXT,
  external_inquiry_id TEXT,
  external_message_id TEXT,
  schema_version TEXT,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_source TEXT NOT NULL DEFAULT 'webhook'
    CHECK (delivery_source IN ('webhook', 'daily_audit', 'backfill')),
  raw_payload JSONB,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  correlation_id TEXT,
  claimed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_webhook_events_identity
  ON public.inquiry_webhook_events (event_identity);
CREATE INDEX IF NOT EXISTS idx_inquiry_webhook_events_claim
  ON public.inquiry_webhook_events (processing_status, next_retry_at, id)
  WHERE processing_status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_inquiry_webhook_events_shop
  ON public.inquiry_webhook_events (shop_key);

DROP TRIGGER IF EXISTS trg_inquiry_webhook_events_updated_at ON public.inquiry_webhook_events;
CREATE TRIGGER trg_inquiry_webhook_events_updated_at
  BEFORE UPDATE ON public.inquiry_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.inquiry_management_set_updated_at();

ALTER TABLE public.inquiry_webhook_events ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 5. Operational ledgers
-- =============================================================================

-- 5.1 Ingestion run / cursor ledger
CREATE TABLE IF NOT EXISTS public.inquiry_ingestion_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_key TEXT,
  run_id TEXT NOT NULL,
  delivery_source TEXT NOT NULL DEFAULT 'daily_audit'
    CHECK (delivery_source IN ('webhook', 'daily_audit', 'backfill')),
  release_sha TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  cursor_before TEXT,
  cursor_after TEXT,
  window_start_at TIMESTAMPTZ,
  window_end_at TIMESTAMPTZ,
  requests INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  scanned INTEGER NOT NULL DEFAULT 0,
  compared INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  error_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_key, run_id)
);

ALTER TABLE public.inquiry_ingestion_runs ENABLE ROW LEVEL SECURITY;

-- 5.2 Quarantine / exception ledger
CREATE TABLE IF NOT EXISTS public.inquiry_quarantine (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_key TEXT,
  kind TEXT,
  event_identity TEXT,
  external_inquiry_id TEXT,
  external_message_id TEXT,
  reason TEXT,
  raw_payload JSONB,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiry_quarantine_open
  ON public.inquiry_quarantine (resolved_at) WHERE resolved_at IS NULL;

ALTER TABLE public.inquiry_quarantine ENABLE ROW LEVEL SECURITY;

-- 5.3 Outbound operation ledger
CREATE TABLE IF NOT EXISTS public.inquiry_outbound_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id BIGINT NOT NULL REFERENCES public.inquiries(id) ON DELETE CASCADE,
  shop_key TEXT,
  external_inquiry_id TEXT,
  follow_up_cycle_id UUID,               -- null => initial reply cycle
  operation_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  actor TEXT,
  requested_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'confirmed', 'ambiguous', 'failed', 'reconciled')),
  lease_until TIMESTAMPTZ,
  mercari_message_id TEXT,
  readback_body_hash TEXT,
  readback_at TIMESTAMPTZ,
  finalize_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_outbound_idempotency
  ON public.inquiry_outbound_operations (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_inquiry_outbound_inquiry
  ON public.inquiry_outbound_operations (inquiry_id, follow_up_cycle_id);

DROP TRIGGER IF EXISTS trg_inquiry_outbound_operations_updated_at ON public.inquiry_outbound_operations;
CREATE TRIGGER trg_inquiry_outbound_operations_updated_at
  BEFORE UPDATE ON public.inquiry_outbound_operations
  FOR EACH ROW EXECUTE FUNCTION public.inquiry_management_set_updated_at();

ALTER TABLE public.inquiry_outbound_operations ENABLE ROW LEVEL SECURITY;

-- Late FK: inquiry_messages.outbound_operation_id -> outbound ledger
ALTER TABLE public.inquiry_messages
  ADD CONSTRAINT fk_inquiry_messages_outbound_operation
  FOREIGN KEY (outbound_operation_id)
  REFERENCES public.inquiry_outbound_operations(id) ON DELETE SET NULL;

-- 5.4 Immutable follow-up workflow events
CREATE TABLE IF NOT EXISTS public.inquiry_follow_up_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id BIGINT NOT NULL REFERENCES public.inquiries(id) ON DELETE CASCADE,
  follow_up_cycle_id UUID,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('cycle_created', 'due_date_set', 'due_date_override', 'superseded_by_inbound', 'followed_up', 'do_not_follow_up', 'cleared')),
  actor TEXT,
  previous_state TEXT,
  new_state TEXT,
  previous_due_date DATE,
  new_due_date DATE,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiry_follow_up_events_inquiry
  ON public.inquiry_follow_up_events (inquiry_id, occurred_at DESC);

ALTER TABLE public.inquiry_follow_up_events ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 6. Projections (views)
-- =============================================================================

-- 6.1 Normalized message timeline
CREATE OR REPLACE VIEW public.inquiry_message_timeline_vw
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  m.id,
  m.inquiry_id,
  m.shop_key,
  m.external_inquiry_id,
  m.external_message_id,
  m.external_from,
  m.direction,
  m.body,
  m.sent_at,
  m.external_status,
  m.deleted_at,
  m.attachments_metadata,
  m.source_payload_hash,
  m.outbound_operation_id,
  m.idempotency_key,
  m.first_observed_at,
  m.last_observed_at,
  m.created_at,
  m.updated_at
FROM public.inquiry_messages m
ORDER BY m.sent_at ASC NULLS LAST, m.id ASC;

-- 6.2 Follow-up queue projections. due/overdue derived from JST today.

CREATE OR REPLACE VIEW public.follow_up_review_queue_vw
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  i.id,
  i.shop_key,
  i.external_inquiry_id,
  i.customer_nickname,
  i.product_name_snapshot,
  i.external_target_type,
  i.follow_up_state,
  i.follow_up_due_date,
  i.follow_up_date_source,
  i.follow_up_cycle_id,
  i.last_confirmed_outbound_message_id,
  i.last_confirmed_outbound_at,
  i.status,
  ((now() AT TIME ZONE 'Asia/Tokyo')::date - i.follow_up_due_date) AS days_overdue,
  CASE
    WHEN i.follow_up_due_date = (now() AT TIME ZONE 'Asia/Tokyo')::date THEN 'due'
    ELSE 'overdue'
  END AS bucket,
  latest.message_from AS latest_message_from,
  latest.message_id AS latest_message_id,
  latest.message_sent_at AS latest_message_sent_at
FROM public.inquiries i
LEFT JOIN LATERAL (
  SELECT m.external_from AS message_from,
         m.external_message_id AS message_id,
         m.sent_at AS message_sent_at
  FROM public.inquiry_messages m
  WHERE m.inquiry_id = i.id AND m.deleted_at IS NULL
  ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
  LIMIT 1
) latest ON true
WHERE i.deleted_at IS NULL
  AND i.follow_up_state = 'scheduled'
  AND i.follow_up_due_date IS NOT NULL
  AND i.follow_up_due_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date
  AND i.status NOT IN ('closed_won', 'closed_lose')
  AND COALESCE(i.external_status, '') <> 'RESOLVED'
  AND latest.message_from = 'SELLER'
  AND latest.message_id = i.last_confirmed_outbound_message_id;

CREATE OR REPLACE VIEW public.follow_up_upcoming_vw
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  i.id,
  i.shop_key,
  i.external_inquiry_id,
  i.customer_nickname,
  i.product_name_snapshot,
  i.external_target_type,
  i.follow_up_state,
  i.follow_up_due_date,
  i.follow_up_date_source,
  i.follow_up_cycle_id,
  i.last_confirmed_outbound_message_id,
  i.last_confirmed_outbound_at,
  i.status,
  ((now() AT TIME ZONE 'Asia/Tokyo')::date - i.follow_up_due_date) AS days_until_due,
  latest.message_from AS latest_message_from,
  latest.message_id AS latest_message_id,
  latest.message_sent_at AS latest_message_sent_at
FROM public.inquiries i
LEFT JOIN LATERAL (
  SELECT m.external_from AS message_from,
         m.external_message_id AS message_id,
         m.sent_at AS message_sent_at
  FROM public.inquiry_messages m
  WHERE m.inquiry_id = i.id AND m.deleted_at IS NULL
  ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
  LIMIT 1
) latest ON true
WHERE i.deleted_at IS NULL
  AND i.follow_up_state = 'scheduled'
  AND i.follow_up_due_date IS NOT NULL
  AND i.follow_up_due_date > (now() AT TIME ZONE 'Asia/Tokyo')::date
  AND i.status NOT IN ('closed_won', 'closed_lose')
  AND COALESCE(i.external_status, '') <> 'RESOLVED'
  AND latest.message_from = 'SELLER'
  AND latest.message_id = i.last_confirmed_outbound_message_id;

CREATE OR REPLACE VIEW public.follow_up_history_vw
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  i.id,
  i.shop_key,
  i.external_inquiry_id,
  i.customer_nickname,
  i.product_name_snapshot,
  i.external_target_type,
  i.follow_up_state,
  i.follow_up_due_date,
  i.follow_up_date_source,
  i.follow_up_cycle_id,
  i.last_confirmed_outbound_message_id,
  i.last_confirmed_outbound_at,
  i.status
FROM public.inquiries i
WHERE i.deleted_at IS NULL
  AND i.follow_up_state IN ('followed_up', 'do_not_follow_up', 'cleared', 'superseded_by_inbound');

-- =============================================================================
-- 7. Atomic RPCs
-- =============================================================================

-- 7.1 Claim an outbound cycle. Serializes concurrent sends via a row lock on the
--     inquiry and enforces exactly one active lease per (inquiry, cycle).
CREATE OR REPLACE FUNCTION public.inquiry_claim_outbound_cycle(
  p_inquiry_id BIGINT,
  p_follow_up_cycle_id UUID,
  p_idempotency_key TEXT,
  p_actor TEXT,
  p_requested_body TEXT,
  p_lease_seconds INT DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_inquiry public.inquiries%ROWTYPE;
  v_existing RECORD;
  v_operation_id BIGINT;
  v_lease_until TIMESTAMPTZ;
  v_operation_version INT;
BEGIN
  IF p_inquiry_id IS NULL THEN
    RAISE EXCEPTION 'p_inquiry_id is required';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  SELECT * INTO v_inquiry FROM public.inquiries WHERE id = p_inquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inquiry % not found', p_inquiry_id;
  END IF;

  -- Fail closed: an order-target thread must never enter the inquiry outbound path.
  IF v_inquiry.external_target_type = 'InquiryOrderTransactionTarget'
     OR v_inquiry.external_order_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'order-target inquiry % is not routable through inquiry outbound', p_inquiry_id;
  END IF;

  -- Idempotent reclaim of the same operation key.
  SELECT id, status, lease_until INTO v_existing
  FROM public.inquiry_outbound_operations
  WHERE idempotency_key = p_idempotency_key
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- A failed state is only written before any external mutation was made
    -- (for example, stale-thread or fresh-read failure). Reclaiming that same
    -- logical operation is therefore safe. Ambiguous and terminal states stay
    -- fail-closed and must be reconciled rather than retried.
    IF v_existing.status = 'failed' THEN
      v_lease_until := now() + make_interval(secs => GREATEST(p_lease_seconds, 1));
      UPDATE public.inquiry_outbound_operations
      SET status = 'pending',
          lease_until = v_lease_until,
          actor = p_actor,
          requested_body = p_requested_body,
          finalize_error = NULL
      WHERE id = v_existing.id;
      RETURN jsonb_build_object(
        'claimed', true,
        'reclaimed', true,
        'operationId', v_existing.id,
        'idempotencyKey', p_idempotency_key,
        'leaseUntil', v_lease_until,
        'status', 'pending'
      );
    END IF;
    IF v_existing.status IN ('pending', 'sent') AND v_existing.lease_until > now() THEN
      RETURN jsonb_build_object(
        'claimed', false,
        'reclaimed', true,
        'operationId', v_existing.id,
        'idempotencyKey', p_idempotency_key,
        'leaseUntil', v_existing.lease_until,
        'status', v_existing.status
      );
    END IF;
    -- Ambiguous / terminal reuse: never blind-retry on a stale key.
    RAISE EXCEPTION 'idempotency key % already used with status %', p_idempotency_key, v_existing.status;
  END IF;

  -- Reject if another active lease exists for this thread/cycle.
  IF EXISTS (
    SELECT 1 FROM public.inquiry_outbound_operations
    WHERE inquiry_id = p_inquiry_id
      AND ((p_follow_up_cycle_id IS NULL AND follow_up_cycle_id IS NULL)
           OR follow_up_cycle_id = p_follow_up_cycle_id)
      AND status IN ('pending', 'sent')
      AND lease_until > now()
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'active lease already held for inquiry % cycle %',
      p_inquiry_id, COALESCE(p_follow_up_cycle_id::text, 'reply');
  END IF;

  SELECT COALESCE(MAX(operation_version), 0) + 1 INTO v_operation_version
  FROM public.inquiry_outbound_operations WHERE inquiry_id = p_inquiry_id;

  v_lease_until := now() + make_interval(secs => GREATEST(p_lease_seconds, 1));

  INSERT INTO public.inquiry_outbound_operations (
    inquiry_id, shop_key, external_inquiry_id, follow_up_cycle_id,
    operation_version, idempotency_key, actor, requested_body, status, lease_until
  ) VALUES (
    v_inquiry.id, v_inquiry.shop_key, v_inquiry.external_inquiry_id, p_follow_up_cycle_id,
    v_operation_version, p_idempotency_key, p_actor, p_requested_body, 'pending', v_lease_until
  )
  RETURNING id INTO v_operation_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'operationId', v_operation_id,
    'idempotencyKey', p_idempotency_key,
    'leaseUntil', v_lease_until,
    'operationVersion', v_operation_version
  );
END;
$$;

-- 7.2 Finalize outbound. Confirms the platform message from authoritative
--     readback, writes the canonical outbound message, opens the next
--     follow-up cycle (JST +3 default), and records immutable events — atomically.
CREATE OR REPLACE FUNCTION public.inquiry_finalize_outbound(
  p_operation_id BIGINT,
  p_mercari_message_id TEXT,
  p_message_body TEXT,
  p_readback_body_hash TEXT,
  p_sent_at TIMESTAMPTZ DEFAULT NULL,
  p_actor TEXT DEFAULT NULL,
  p_follow_up_due_date DATE DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_op public.inquiry_outbound_operations%ROWTYPE;
  v_inquiry public.inquiries%ROWTYPE;
  v_new_cycle_id UUID;
  v_new_due_date DATE;
  v_new_source TEXT;
  v_sent_at TIMESTAMPTZ;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'p_operation_id is required';
  END IF;
  IF p_mercari_message_id IS NULL OR p_mercari_message_id = '' THEN
    RAISE EXCEPTION 'p_mercari_message_id (authoritative readback) is required';
  END IF;
  IF p_readback_body_hash IS NULL OR p_readback_body_hash = '' THEN
    RAISE EXCEPTION 'p_readback_body_hash (authoritative readback) is required';
  END IF;

  SELECT * INTO v_op FROM public.inquiry_outbound_operations
  WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation % not found', p_operation_id;
  END IF;

  SELECT * INTO v_inquiry FROM public.inquiries WHERE id = v_op.inquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inquiry % not found', v_op.inquiry_id;
  END IF;

  -- Idempotent: already finalized -> return existing success.
  IF v_op.status = 'confirmed' THEN
    RETURN jsonb_build_object(
      'finalized', true,
      'alreadyConfirmed', true,
      'operationId', v_op.id,
      'mercariMessageId', v_op.mercari_message_id
    );
  END IF;

  IF v_op.status NOT IN ('pending', 'sent') THEN
    RAISE EXCEPTION 'operation % in unexpected state % (reconcile, never blind retry)',
      v_op.id, v_op.status;
  END IF;

  v_sent_at := COALESCE(p_sent_at, now());

  -- Confirm the outbound operation.
  UPDATE public.inquiry_outbound_operations
  SET status = 'confirmed',
      mercari_message_id = p_mercari_message_id,
      readback_body_hash = p_readback_body_hash,
      readback_at = now(),
      lease_until = NULL,
      requested_body = COALESCE(requested_body, p_message_body)
  WHERE id = v_op.id;

  -- Canonical outbound message (upsert by source-neutral identity).
  INSERT INTO public.inquiry_messages (
    inquiry_id, shop_key, source, external_inquiry_id, external_message_id,
    external_from, direction, body, sent_at, external_status, deleted_at,
    source_observed_at, source_payload_hash, first_observed_at, last_observed_at,
    outbound_operation_id, idempotency_key
  ) VALUES (
    v_inquiry.id, v_inquiry.shop_key, 'mercari_shops', v_inquiry.external_inquiry_id, p_mercari_message_id,
    'SELLER', 'outbound', COALESCE(p_message_body, v_op.requested_body), v_sent_at, 'ACTIVE', NULL,
    now(), p_readback_body_hash, now(), now(),
    v_op.id, v_op.idempotency_key
  )
  ON CONFLICT (shop_key, external_message_id) DO UPDATE SET
    body = EXCLUDED.body,
    sent_at = EXCLUDED.sent_at,
    external_status = EXCLUDED.external_status,
    deleted_at = NULL,
    source_observed_at = EXCLUDED.source_observed_at,
    source_payload_hash = EXCLUDED.source_payload_hash,
    last_observed_at = now(),
    outbound_operation_id = EXCLUDED.outbound_operation_id,
    idempotency_key = EXCLUDED.idempotency_key;

  -- A follow-up closes its current cycle and leaves the inquiry out of the
  -- active queue. A normal reply (no follow-up cycle) opens the next +3 cycle.
  IF v_op.follow_up_cycle_id IS NOT NULL THEN
    INSERT INTO public.inquiry_follow_up_events (
      inquiry_id, follow_up_cycle_id, event_type, actor,
      previous_state, new_state, previous_due_date, new_due_date
    ) VALUES (
      v_inquiry.id, v_op.follow_up_cycle_id, 'followed_up', p_actor,
      'scheduled', 'followed_up', v_inquiry.follow_up_due_date, v_inquiry.follow_up_due_date
    );
    UPDATE public.inquiries
    SET follow_up_state = 'followed_up',
        follow_up_sent_at = v_sent_at,
        last_confirmed_outbound_message_id = p_mercari_message_id,
        last_confirmed_outbound_at = v_sent_at
    WHERE id = v_inquiry.id;
    v_new_cycle_id := v_op.follow_up_cycle_id;
    v_new_due_date := v_inquiry.follow_up_due_date;
    v_new_source := v_inquiry.follow_up_date_source;
  ELSE
    v_new_cycle_id := gen_random_uuid();
    IF p_follow_up_due_date IS NOT NULL THEN
      v_new_due_date := p_follow_up_due_date;
      v_new_source := 'operator_override';
    ELSE
      v_new_due_date := (v_sent_at AT TIME ZONE 'Asia/Tokyo')::date + 3;
      v_new_source := 'auto_after_reply';
    END IF;

    UPDATE public.inquiries
    SET follow_up_cycle_id = v_new_cycle_id,
        follow_up_state = 'scheduled',
        follow_up_due_date = v_new_due_date,
        follow_up_date_source = v_new_source,
        follow_up_cycle_started_at = now(),
        last_confirmed_outbound_message_id = p_mercari_message_id,
        last_confirmed_outbound_at = v_sent_at,
        status = CASE WHEN v_inquiry.status = 'received' THEN 'answered' ELSE v_inquiry.status END
    WHERE id = v_inquiry.id;

    INSERT INTO public.inquiry_follow_up_events (
      inquiry_id, follow_up_cycle_id, event_type, actor,
      previous_state, new_state, previous_due_date, new_due_date
    ) VALUES (
      v_inquiry.id, v_new_cycle_id, 'cycle_created', p_actor,
      NULL, 'scheduled', NULL, v_new_due_date
    );
  END IF;

  RETURN jsonb_build_object(
    'finalized', true,
    'operationId', v_op.id,
    'mercariMessageId', p_mercari_message_id,
    'followUpCycleId', v_new_cycle_id,
    'followUpDueDate', v_new_due_date,
    'followUpDateSource', v_new_source
  );
END;
$$;

-- 7.3 Operator follow-up schedule override / clear.
CREATE OR REPLACE FUNCTION public.inquiry_schedule_follow_up(
  p_inquiry_id BIGINT,
  p_follow_up_due_date DATE DEFAULT NULL,
  p_follow_up_state TEXT DEFAULT 'scheduled',
  p_actor TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_inquiry public.inquiries%ROWTYPE;
  v_cycle_id UUID;
  v_prev_state TEXT;
  v_prev_due_date DATE;
  v_event_type TEXT;
BEGIN
  IF p_inquiry_id IS NULL THEN
    RAISE EXCEPTION 'p_inquiry_id is required';
  END IF;
  IF p_follow_up_state NOT IN ('scheduled', 'do_not_follow_up', 'cleared') THEN
    RAISE EXCEPTION 'invalid follow_up_state %', p_follow_up_state;
  END IF;
  IF p_follow_up_state = 'scheduled' AND p_follow_up_due_date IS NULL THEN
    RAISE EXCEPTION 'p_follow_up_due_date is required when state is scheduled';
  END IF;

  SELECT * INTO v_inquiry FROM public.inquiries WHERE id = p_inquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inquiry % not found', p_inquiry_id;
  END IF;

  v_prev_state := v_inquiry.follow_up_state;
  v_prev_due_date := v_inquiry.follow_up_due_date;
  v_cycle_id := COALESCE(v_inquiry.follow_up_cycle_id, gen_random_uuid());

  v_event_type := CASE p_follow_up_state
    WHEN 'scheduled' THEN 'due_date_override'
    ELSE p_follow_up_state
  END;

  UPDATE public.inquiries
  SET follow_up_cycle_id = v_cycle_id,
      follow_up_state = p_follow_up_state,
      follow_up_due_date = CASE WHEN p_follow_up_state = 'scheduled' THEN p_follow_up_due_date ELSE v_inquiry.follow_up_due_date END,
      follow_up_date_source = CASE WHEN p_follow_up_state = 'scheduled' THEN 'operator_override' ELSE v_inquiry.follow_up_date_source END,
      follow_up_date_updated_at = now(),
      follow_up_date_updated_by = p_actor,
      follow_up_cycle_started_at = COALESCE(v_inquiry.follow_up_cycle_started_at, now())
  WHERE id = p_inquiry_id;

  INSERT INTO public.inquiry_follow_up_events (
    inquiry_id, follow_up_cycle_id, event_type, actor,
    previous_state, new_state, previous_due_date, new_due_date, reason
  ) VALUES (
    v_inquiry.id, v_cycle_id, v_event_type, p_actor,
    v_prev_state, p_follow_up_state, v_prev_due_date,
    CASE WHEN p_follow_up_state = 'scheduled' THEN p_follow_up_due_date ELSE v_prev_due_date END,
    p_reason
  );

  RETURN jsonb_build_object(
    'scheduled', true,
    'inquiryId', v_inquiry.id,
    'followUpCycleId', v_cycle_id,
    'followUpState', p_follow_up_state,
    'followUpDueDate', CASE WHEN p_follow_up_state = 'scheduled' THEN p_follow_up_due_date ELSE v_prev_due_date END
  );
END;
$$;

-- 7.4 Webhook event claim (async processor)
CREATE OR REPLACE FUNCTION public.inquiry_claim_webhook_event(
  p_worker TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_event public.inquiry_webhook_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event
  FROM public.inquiry_webhook_events
  WHERE processing_status IN ('pending', 'failed')
    AND (next_retry_at IS NULL OR next_retry_at <= now())
  ORDER BY id ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.inquiry_webhook_events
  SET processing_status = 'processing',
      attempts = attempts + 1,
      claimed_by = p_worker
  WHERE id = v_event.id;

  RETURN to_jsonb(v_event);
END;
$$;

-- 7.5 Webhook event finalize (async processor)
CREATE OR REPLACE FUNCTION public.inquiry_complete_webhook_event(
  p_event_id BIGINT,
  p_status TEXT,
  p_error TEXT DEFAULT NULL,
  p_next_retry_at TIMESTAMPTZ DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'invalid completion status %', p_status;
  END IF;

  UPDATE public.inquiry_webhook_events
  SET processing_status = p_status,
      last_error = p_error,
      next_retry_at = p_next_retry_at,
      processed_at = now()
  WHERE id = p_event_id;
END;
$$;

-- 7.6 Apply platform lifecycle transitions to the active follow-up cycle.
CREATE OR REPLACE FUNCTION public.inquiry_apply_platform_transition(
  p_inquiry_id BIGINT,
  p_topic TEXT,
  p_latest_message_from TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_inquiry public.inquiries%ROWTYPE;
  v_new_state TEXT;
  v_event_type TEXT;
BEGIN
  SELECT * INTO v_inquiry FROM public.inquiries WHERE id = p_inquiry_id FOR UPDATE;
  IF NOT FOUND OR v_inquiry.follow_up_state <> 'scheduled' THEN RETURN; END IF;

  IF p_topic = 'INQUIRY_RESOLVED' THEN
    v_new_state := 'cleared';
    v_event_type := 'cleared';
  ELSIF p_latest_message_from = 'BUYER' THEN
    v_new_state := 'superseded_by_inbound';
    v_event_type := 'superseded_by_inbound';
  ELSE
    RETURN;
  END IF;

  UPDATE public.inquiries SET follow_up_state = v_new_state WHERE id = p_inquiry_id;
  INSERT INTO public.inquiry_follow_up_events (
    inquiry_id, follow_up_cycle_id, event_type, actor,
    previous_state, new_state, previous_due_date, new_due_date, reason
  ) VALUES (
    v_inquiry.id, v_inquiry.follow_up_cycle_id, v_event_type, 'mercari_ingestion',
    v_inquiry.follow_up_state, v_new_state, v_inquiry.follow_up_due_date,
    v_inquiry.follow_up_due_date, p_topic
  );
END;
$$;

-- 7.7 Reconcile one authoritative API thread in a single database round trip.
--     The Mercari API exposes messages per thread, so the external read is
--     necessarily thread-scoped. This RPC prevents a second N+1 pattern at the
--     database boundary and writes only rows whose business facts changed.
CREATE OR REPLACE FUNCTION public.inquiry_reconcile_api_thread(
  p_inquiry JSONB,
  p_messages JSONB
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_inquiry_id BIGINT;
  v_shop_key TEXT := p_inquiry->>'shop_key';
  v_external_inquiry_id TEXT := p_inquiry->>'external_inquiry_id';
  v_inquiry_created BOOLEAN := false;
  v_inquiry_changed BOOLEAN := false;
  v_message JSONB;
  v_message_id BIGINT;
  v_messages_created INTEGER := 0;
  v_messages_changed INTEGER := 0;
BEGIN
  IF v_shop_key IS NULL OR v_external_inquiry_id IS NULL THEN
    RAISE EXCEPTION 'shop_key and external_inquiry_id are required';
  END IF;
  IF p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' THEN
    RAISE EXCEPTION 'p_messages must be an array';
  END IF;

  SELECT id INTO v_inquiry_id
  FROM public.inquiries
  WHERE shop_key = v_shop_key
    AND external_inquiry_id = v_external_inquiry_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.inquiries (
      shop_key, source, external_inquiry_id, external_status,
      external_sales_channel, external_first_opened_at,
      external_last_activity_at, external_target_type, external_product_id,
      external_product_variant_id, external_order_transaction_id,
      external_shop_id, source_observed_at, source_payload, inquiry_date,
      inquiry_body, customer_nickname, last_inbound_time, last_custom_message
    ) VALUES (
      v_shop_key, COALESCE(p_inquiry->>'source', 'mercari_shops'), v_external_inquiry_id,
      p_inquiry->>'external_status', p_inquiry->>'external_sales_channel',
      (p_inquiry->>'external_first_opened_at')::timestamptz,
      (p_inquiry->>'external_last_activity_at')::timestamptz,
      p_inquiry->>'external_target_type', p_inquiry->>'external_product_id',
      p_inquiry->>'external_product_variant_id', p_inquiry->>'external_order_transaction_id',
      p_inquiry->>'external_shop_id', (p_inquiry->>'source_observed_at')::timestamptz,
      COALESCE(p_inquiry->'source_payload', '{}'::jsonb),
      (p_inquiry->>'inquiry_date')::timestamptz, p_inquiry->>'inquiry_body',
      p_inquiry->>'customer_nickname', (p_inquiry->>'last_inbound_time')::timestamptz,
      p_inquiry->>'last_custom_message'
    ) RETURNING id INTO v_inquiry_id;
    v_inquiry_created := true;
    v_inquiry_changed := true;
  ELSE
    UPDATE public.inquiries i SET
      source = COALESCE(p_inquiry->>'source', i.source),
      external_status = p_inquiry->>'external_status',
      external_sales_channel = p_inquiry->>'external_sales_channel',
      external_first_opened_at = (p_inquiry->>'external_first_opened_at')::timestamptz,
      external_last_activity_at = (p_inquiry->>'external_last_activity_at')::timestamptz,
      external_target_type = p_inquiry->>'external_target_type',
      external_product_id = p_inquiry->>'external_product_id',
      external_product_variant_id = p_inquiry->>'external_product_variant_id',
      external_order_transaction_id = p_inquiry->>'external_order_transaction_id',
      external_shop_id = p_inquiry->>'external_shop_id',
      source_observed_at = (p_inquiry->>'source_observed_at')::timestamptz,
      source_payload = COALESCE(p_inquiry->'source_payload', i.source_payload),
      inquiry_date = COALESCE((p_inquiry->>'inquiry_date')::timestamptz, i.inquiry_date),
      inquiry_body = COALESCE(p_inquiry->>'inquiry_body', i.inquiry_body),
      customer_nickname = COALESCE(p_inquiry->>'customer_nickname', i.customer_nickname),
      last_inbound_time = COALESCE((p_inquiry->>'last_inbound_time')::timestamptz, i.last_inbound_time),
      last_custom_message = COALESCE(p_inquiry->>'last_custom_message', i.last_custom_message)
    WHERE i.id = v_inquiry_id
      AND (
        i.external_status IS DISTINCT FROM p_inquiry->>'external_status' OR
        i.external_sales_channel IS DISTINCT FROM p_inquiry->>'external_sales_channel' OR
        i.external_first_opened_at IS DISTINCT FROM (p_inquiry->>'external_first_opened_at')::timestamptz OR
        i.external_last_activity_at IS DISTINCT FROM (p_inquiry->>'external_last_activity_at')::timestamptz OR
        i.external_target_type IS DISTINCT FROM p_inquiry->>'external_target_type' OR
        i.external_product_id IS DISTINCT FROM p_inquiry->>'external_product_id' OR
        i.external_product_variant_id IS DISTINCT FROM p_inquiry->>'external_product_variant_id' OR
        i.external_order_transaction_id IS DISTINCT FROM p_inquiry->>'external_order_transaction_id' OR
        i.external_shop_id IS DISTINCT FROM p_inquiry->>'external_shop_id' OR
        (p_inquiry->>'inquiry_date' IS NOT NULL AND i.inquiry_date IS DISTINCT FROM (p_inquiry->>'inquiry_date')::timestamptz) OR
        (p_inquiry->>'inquiry_body' IS NOT NULL AND i.inquiry_body IS DISTINCT FROM p_inquiry->>'inquiry_body') OR
        (p_inquiry->>'customer_nickname' IS NOT NULL AND i.customer_nickname IS DISTINCT FROM p_inquiry->>'customer_nickname') OR
        (p_inquiry->>'last_inbound_time' IS NOT NULL AND i.last_inbound_time IS DISTINCT FROM (p_inquiry->>'last_inbound_time')::timestamptz) OR
        (p_inquiry->>'last_custom_message' IS NOT NULL AND i.last_custom_message IS DISTINCT FROM p_inquiry->>'last_custom_message')
      );
    v_inquiry_changed := FOUND;
  END IF;

  FOR v_message IN SELECT value FROM jsonb_array_elements(p_messages)
  LOOP
    IF NULLIF(v_message->>'external_message_id', '') IS NULL THEN CONTINUE; END IF;

    SELECT id INTO v_message_id
    FROM public.inquiry_messages
    WHERE shop_key = v_shop_key
      AND external_message_id = v_message->>'external_message_id'
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.inquiry_messages (
        inquiry_id, shop_key, source, external_inquiry_id, external_message_id,
        external_from, direction, body, sent_at, external_status, deleted_at,
        attachments_metadata, source_observed_at, source_payload_hash
      ) VALUES (
        v_inquiry_id, v_shop_key, COALESCE(v_message->>'source', 'mercari_shops'),
        v_external_inquiry_id, v_message->>'external_message_id',
        v_message->>'external_from', v_message->>'direction', v_message->>'body',
        (v_message->>'sent_at')::timestamptz, v_message->>'external_status',
        (v_message->>'deleted_at')::timestamptz,
        COALESCE(v_message->'attachments_metadata', '[]'::jsonb),
        (v_message->>'source_observed_at')::timestamptz,
        v_message->>'source_payload_hash'
      );
      v_messages_created := v_messages_created + 1;
    ELSE
      UPDATE public.inquiry_messages m SET
        inquiry_id = v_inquiry_id,
        external_inquiry_id = v_external_inquiry_id,
        external_from = v_message->>'external_from',
        direction = v_message->>'direction',
        body = v_message->>'body',
        sent_at = (v_message->>'sent_at')::timestamptz,
        external_status = v_message->>'external_status',
        deleted_at = (v_message->>'deleted_at')::timestamptz,
        attachments_metadata = COALESCE(v_message->'attachments_metadata', '[]'::jsonb),
        source_observed_at = (v_message->>'source_observed_at')::timestamptz,
        source_payload_hash = v_message->>'source_payload_hash',
        last_observed_at = now()
      WHERE m.id = v_message_id
        AND (
          m.inquiry_id IS DISTINCT FROM v_inquiry_id OR
          m.external_inquiry_id IS DISTINCT FROM v_external_inquiry_id OR
          m.external_from IS DISTINCT FROM v_message->>'external_from' OR
          m.direction IS DISTINCT FROM v_message->>'direction' OR
          m.body IS DISTINCT FROM v_message->>'body' OR
          m.sent_at IS DISTINCT FROM (v_message->>'sent_at')::timestamptz OR
          m.external_status IS DISTINCT FROM v_message->>'external_status' OR
          m.deleted_at IS DISTINCT FROM (v_message->>'deleted_at')::timestamptz OR
          m.attachments_metadata IS DISTINCT FROM COALESCE(v_message->'attachments_metadata', '[]'::jsonb) OR
          m.source_payload_hash IS DISTINCT FROM v_message->>'source_payload_hash'
        );
      IF FOUND THEN v_messages_changed := v_messages_changed + 1; END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inquiryId', v_inquiry_id,
    'inquiryCreated', v_inquiry_created,
    'inquiryChanged', v_inquiry_changed,
    'messagesCreated', v_messages_created,
    'messagesChanged', v_messages_changed,
    'rowsWritten', (CASE WHEN v_inquiry_changed THEN 1 ELSE 0 END) + v_messages_created + v_messages_changed
  );
END;
$$;

-- =============================================================================
-- 8. Grants (service_role only; browser roles denied)
-- =============================================================================

REVOKE ALL ON TABLE public.inquiry_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_webhook_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_ingestion_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_quarantine FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_outbound_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_follow_up_events FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_ingestion_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_quarantine TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_outbound_operations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_follow_up_events TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.inquiry_messages_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_webhook_events_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_ingestion_runs_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_quarantine_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_outbound_operations_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_follow_up_events_id_seq TO service_role;

REVOKE ALL ON TABLE public.inquiry_message_timeline_vw FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.follow_up_review_queue_vw FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.follow_up_upcoming_vw FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.follow_up_history_vw FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inquiry_message_timeline_vw TO service_role;
GRANT SELECT ON TABLE public.follow_up_review_queue_vw TO service_role;
GRANT SELECT ON TABLE public.follow_up_upcoming_vw TO service_role;
GRANT SELECT ON TABLE public.follow_up_history_vw TO service_role;

REVOKE ALL ON FUNCTION public.inquiry_claim_outbound_cycle(BIGINT, UUID, TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inquiry_finalize_outbound(BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inquiry_schedule_follow_up(BIGINT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inquiry_claim_webhook_event(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inquiry_complete_webhook_event(BIGINT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inquiry_apply_platform_transition(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inquiry_reconcile_api_thread(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inquiry_claim_outbound_cycle(BIGINT, UUID, TEXT, TEXT, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.inquiry_finalize_outbound(BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.inquiry_schedule_follow_up(BIGINT, DATE, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.inquiry_claim_webhook_event(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.inquiry_complete_webhook_event(BIGINT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.inquiry_apply_platform_transition(BIGINT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.inquiry_reconcile_api_thread(JSONB, JSONB) TO service_role;
