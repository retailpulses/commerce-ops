-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: complete_mercari_order_close, sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none

CREATE OR REPLACE FUNCTION public.complete_mercari_order_close(
  p_order_id text,
  p_source_store_id text,
  p_completed_at timestamptz,
  p_tracking_carrier text,
  p_tracking_number text,
  p_tracking_detail text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF nullif(trim(p_order_id), '') IS NULL
     OR nullif(trim(p_source_store_id), '') IS NULL
     OR p_completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid Mercari close completion request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_store_id || ':' || p_order_id, 0));

  UPDATE sales_orders
  SET order_status = 'COMPLETED',
      review_status = NULL,
      shipping_completed_at = p_completed_at,
      shop_close_status = 'Completed',
      shop_close_attempted_at = p_completed_at,
      shop_close_completed_at = p_completed_at,
      shop_close_error = '',
      shipping_carrier = p_tracking_carrier,
      shipping_tracking_info = p_tracking_detail,
      tracking_carrier = p_tracking_carrier,
      tracking_number = p_tracking_number
  WHERE sales_channel = 'mercari'
    AND source_store_id = p_source_store_id
    AND regexp_replace(order_id, '^order_', '') = regexp_replace(p_order_id, '^order_', '')
    AND order_status IN ('WAITING_FOR_SHIPPING', 'COMPLETING', 'COMPLETED');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN RAISE EXCEPTION 'Mercari close completion CAS conflict'; END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_mercari_order_close(text,text,timestamptz,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mercari_order_close(text,text,timestamptz,text,text,text)
  TO service_role;
