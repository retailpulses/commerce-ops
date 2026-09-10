-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiry_product_links for existing eligible API product inquiries
-- Change class: bounded data repair, idempotent
-- Hosted write required: yes; 100-row batches, hard cap 10,000 scanned rows
-- Consumers: Inquiry Portal detail/list pricing projection
-- Purpose: backfill deterministic catalog links after the one-row production
-- variant-ID canary succeeded. Unresolved or ambiguous rows remain unchanged.

DO $$
DECLARE
  v_after_id BIGINT := 0;
  v_batch JSONB;
  v_batch_scanned INTEGER;
  v_batch_linked INTEGER;
  v_total_scanned INTEGER := 0;
  v_total_linked INTEGER := 0;
  v_batches INTEGER := 0;
BEGIN
  LOOP
    v_batch := public.inquiry_backfill_catalog_product_links(v_after_id, 100);
    v_batch_scanned := COALESCE((v_batch->>'scanned')::integer, 0);
    v_batch_linked := COALESCE((v_batch->>'linked')::integer, 0);

    EXIT WHEN v_batch_scanned = 0;

    v_batches := v_batches + 1;
    v_total_scanned := v_total_scanned + v_batch_scanned;
    v_total_linked := v_total_linked + v_batch_linked;
    v_after_id := (v_batch->>'lastId')::bigint;

    RAISE NOTICE 'product link backfill batch %: %', v_batches, v_batch;

    IF v_batches >= 100 THEN
      RAISE EXCEPTION 'product link backfill exceeded 10,000-row safety cap';
    END IF;
  END LOOP;

  RAISE NOTICE 'product link backfill completed: batches=%, scanned=%, linked=%, unresolved=%',
    v_batches, v_total_scanned, v_total_linked, v_total_scanned - v_total_linked;
END;
$$;
