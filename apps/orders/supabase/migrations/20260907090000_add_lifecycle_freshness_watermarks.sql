-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.order_lifecycle_watermarks, public.payment_reminders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: OrderMgmt lifecycle reconciliation, payment reminders, sales brief
--
-- Purpose: Persist accounting-complete marketplace lifecycle evidence so
-- downstream external actions and reports can fail closed when source facts
-- are stale or only partially reconciled.

CREATE TABLE IF NOT EXISTS order_lifecycle_watermarks (
  platform              text NOT NULL,
  source_store_id        text NOT NULL,
  completion_state       text NOT NULL CHECK (completion_state IN ('accounting_complete', 'partial', 'failed')),
  observed_at            timestamptz NOT NULL,
  completed_at           timestamptz NOT NULL,
  run_id                 text NOT NULL,
  release_version        text,
  candidates             integer NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  matched                integer NOT NULL DEFAULT 0 CHECK (matched >= 0),
  unchanged              integer NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  changed                integer NOT NULL DEFAULT 0 CHECK (changed >= 0),
  not_found              integer NOT NULL DEFAULT 0 CHECK (not_found >= 0),
  failed                 integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, source_store_id)
);

CREATE INDEX IF NOT EXISTS ix_order_lifecycle_watermarks_completed
  ON order_lifecycle_watermarks(completed_at);

ALTER TABLE order_lifecycle_watermarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE order_lifecycle_watermarks FROM anon, authenticated;

COMMENT ON TABLE order_lifecycle_watermarks IS
  'Per marketplace/store lifecycle reconciliation watermarks. Only accounting_complete rows may release freshness-gated consumers.';
COMMENT ON COLUMN order_lifecycle_watermarks.observed_at IS
  'Oldest authoritative marketplace observation included in this completed scope.';
COMMENT ON COLUMN order_lifecycle_watermarks.completed_at IS
  'Time the reconciler durably persisted and read back the complete scope accounting.';

ALTER TABLE payment_reminders
  ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'UNKNOWN_RESULT'
    CHECK (delivery_state IN ('RESERVED', 'SENT', 'UNKNOWN_RESULT', 'RECONCILED_SENT', 'RELEASED')),
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_error text;

-- Existing rows predate explicit state tracking and represent successful sends.
UPDATE payment_reminders
SET delivery_state = 'SENT',
    confirmed_at = COALESCE(confirmed_at, sent_at)
WHERE message_text <> 'reserved'
  AND delivery_state = 'UNKNOWN_RESULT';

COMMENT ON COLUMN payment_reminders.delivery_state IS
  'Intent/outcome state. UNKNOWN_RESULT is retained after ambiguous delivery until authoritative reconciliation.';

CREATE OR REPLACE FUNCTION public.reconcile_mercari_order_status(
  p_row_ids uuid[], p_expected_statuses text[], p_target_status text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  IF cardinality(p_row_ids) IS NULL OR cardinality(p_row_ids) = 0
     OR cardinality(p_row_ids) <> cardinality(p_expected_statuses)
     OR p_target_status NOT IN ('WAITING_FOR_PAYMENT', 'WAITING_FOR_SHIPPING', 'COMPLETED', 'CANCELED') THEN
    RAISE EXCEPTION 'invalid lifecycle reconciliation request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(array_to_string(p_row_ids, ','), 0));
  SELECT count(*) INTO v_count
  FROM sales_orders s
  JOIN unnest(p_row_ids, p_expected_statuses) AS expected(id, status) ON expected.id = s.id
  WHERE s.sales_channel = 'mercari' AND s.order_status = expected.status;
  IF v_count <> cardinality(p_row_ids) THEN
    RAISE EXCEPTION 'lifecycle CAS conflict';
  END IF;
  UPDATE sales_orders
  SET order_status = p_target_status,
      review_status = CASE WHEN p_target_status IN ('COMPLETED', 'CANCELED') THEN NULL ELSE review_status END
  WHERE id = ANY(p_row_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF p_target_status = 'CANCELED' THEN
    UPDATE giga_shipment_projections
    SET giga_sync_status = CASE WHEN giga_sync_status IN ('SYNCED', 'ALREADY_EXISTS') THEN giga_sync_status ELSE 'INVALID' END,
        giga_sync_error = CASE WHEN giga_sync_status IN ('SYNCED', 'ALREADY_EXISTS') THEN giga_sync_error ELSE 'Order canceled on Mercari' END,
        giga_sync_processed_at = now()
    WHERE sales_order_id = ANY(p_row_ids);
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_mercari_order_status(uuid[], text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mercari_order_status(uuid[], text[], text) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_rakuten_order_status(
  p_row_ids uuid[], p_expected_statuses text[], p_target_statuses text[],
  p_order_progress text, p_mapping_state text, p_observed_at timestamptz
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF cardinality(p_row_ids) IS NULL OR cardinality(p_row_ids) = 0
     OR cardinality(p_row_ids) <> cardinality(p_expected_statuses)
     OR cardinality(p_row_ids) <> cardinality(p_target_statuses)
     OR p_mapping_state <> 'MAPPED' OR p_observed_at IS NULL
     OR EXISTS (
       SELECT 1 FROM unnest(p_target_statuses) AS target(status)
       WHERE target.status NOT IN ('PENDING_CONFIRMATION', 'WAITING_FOR_PAYMENT', 'CONFIRMED', 'RMS_CONFIRMED', 'COMPLETED', 'CANCELED')
     ) THEN
    RAISE EXCEPTION 'invalid Rakuten lifecycle reconciliation request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(array_to_string(p_row_ids, ','), 0));
  SELECT count(*) INTO v_count
  FROM sales_orders s
  JOIN unnest(p_row_ids, p_expected_statuses) AS expected(id, status) ON expected.id = s.id
  WHERE s.sales_channel = 'rakuten' AND s.order_status = expected.status;
  IF v_count <> cardinality(p_row_ids) THEN RAISE EXCEPTION 'Rakuten lifecycle CAS conflict'; END IF;

  UPDATE sales_orders AS s
  SET order_status = target.status,
      review_status = CASE WHEN target.status IN ('COMPLETED', 'CANCELED') THEN NULL ELSE s.review_status END,
      rakuten_order_progress = p_order_progress,
      rakuten_status_mapping_state = p_mapping_state,
      rakuten_order_progress_observed_at = p_observed_at
  FROM unnest(p_row_ids, p_target_statuses) AS target(id, status)
  WHERE s.id = target.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE giga_shipment_projections
  SET giga_sync_status = CASE WHEN giga_sync_status IN ('SYNCED', 'ALREADY_EXISTS') THEN giga_sync_status ELSE 'INVALID' END,
      giga_sync_error = CASE WHEN giga_sync_status IN ('SYNCED', 'ALREADY_EXISTS') THEN giga_sync_error ELSE 'Order canceled on Rakuten' END,
      giga_sync_processed_at = now()
  WHERE sales_order_id IN (
    SELECT target.id FROM unnest(p_row_ids, p_target_statuses) AS target(id, status)
    WHERE target.status = 'CANCELED'
  );
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_rakuten_order_status(uuid[], text[], text[], text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_rakuten_order_status(uuid[], text[], text[], text, text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_payment_reminder(
  p_order_id text, p_source_store_id text, p_reminder_type text, p_message_text text
) RETURNS TABLE(id uuid, claimed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  INSERT INTO payment_reminders (
    order_id, source_store_id, reminder_type, message_text,
    delivery_state, reserved_at, sent_at, mercari_message_id,
    confirmed_at, last_reconciled_at, reconciliation_error
  ) VALUES (
    p_order_id, p_source_store_id, p_reminder_type, p_message_text,
    'RESERVED', now(), now(), NULL, NULL, NULL, NULL
  )
  ON CONFLICT (order_id, source_store_id, reminder_type) DO UPDATE
  SET message_text = EXCLUDED.message_text,
      delivery_state = 'RESERVED',
      reserved_at = now(),
      mercari_message_id = NULL,
      confirmed_at = NULL,
      reconciliation_error = NULL
  WHERE payment_reminders.delivery_state = 'RELEASED'
  RETURNING payment_reminders.id, true;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_payment_reminder(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_payment_reminder(text, text, text, text) TO service_role;
