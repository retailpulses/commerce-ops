-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: complete_rakuten_order_close, sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none

CREATE OR REPLACE FUNCTION public.complete_rakuten_order_close(
  p_row_ids uuid[],
  p_expected_statuses text[],
  p_completed_at timestamptz,
  p_order_progress text,
  p_progress_observed_at timestamptz
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF cardinality(p_row_ids) IS NULL OR cardinality(p_row_ids) = 0
     OR cardinality(p_row_ids) <> cardinality(p_expected_statuses)
     OR p_completed_at IS NULL OR p_progress_observed_at IS NULL
     OR p_order_progress <> '500' THEN
    RAISE EXCEPTION 'invalid Rakuten close completion request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(array_to_string(p_row_ids, ','), 0));
  SELECT count(*) INTO v_count
  FROM sales_orders AS sales
  JOIN unnest(p_row_ids, p_expected_statuses) AS expected(id, status)
    ON expected.id = sales.id
  WHERE sales.sales_channel = 'rakuten'
    AND sales.order_status = expected.status
    AND sales.rms_close_completed_at IS NULL;
  IF v_count <> cardinality(p_row_ids) THEN
    RAISE EXCEPTION 'Rakuten close completion CAS conflict';
  END IF;

  UPDATE sales_orders AS sales
  SET order_status = 'COMPLETED',
      review_status = NULL,
      rms_close_completed_at = p_completed_at,
      rms_close_result = 'closed',
      rakuten_order_progress = p_order_progress,
      rakuten_status_mapping_state = 'MAPPED',
      rakuten_order_progress_observed_at = p_progress_observed_at,
      last_synced_at = p_completed_at,
      sync_error = ''
  WHERE sales.id = ANY(p_row_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_rakuten_order_close(uuid[],text[],timestamptz,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_rakuten_order_close(uuid[],text[],timestamptz,text,timestamptz)
  TO service_role;

