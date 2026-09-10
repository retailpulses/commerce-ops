-- Transactional TicketForm-to-Ticket finalization.
--
-- Ticket creation is allowed only after a validated customer form submission
-- (or by a separate explicit operator action). This RPC atomically claims the
-- token, creates/reuses one ticket, creates one submission, links verified
-- Storage objects, records events, and consumes the token.

ALTER TABLE public.submission_tokens
  ADD COLUMN IF NOT EXISTS product_name text,
  ADD COLUMN IF NOT EXISTS product_sku text,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

CREATE OR REPLACE FUNCTION public.finalize_ticketform_submission(
  p_token_id uuid,
  p_submission_id uuid,
  p_issue_description text,
  p_expected_solution text DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE (
  ticket_id uuid,
  submission_id uuid,
  created_ticket boolean,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_token public.submission_tokens%ROWTYPE;
  v_ticket_id uuid;
  v_submission_id uuid;
  v_created_ticket boolean := false;
  v_attachment jsonb;
  v_attachment_id uuid;
  v_bucket text;
  v_path text;
  v_variant_id uuid;
  v_product_id uuid;
  v_object_metadata jsonb;
  v_object_size bigint;
  v_object_mime text;
  v_attachment_size bigint;
  v_attachment_mime text;
  v_attachment_media text;
BEGIN
  IF p_issue_description IS NULL OR btrim(p_issue_description) = '' THEN
    RAISE EXCEPTION 'issue_description_required' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(COALESCE(p_attachments, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'attachments_must_be_array' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_token
  FROM public.submission_tokens
  WHERE id = p_token_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_token_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- A successful retry returns the original result instead of duplicating it.
  IF v_token.status = 'used' AND v_token.customer_submission_id IS NOT NULL THEN
    SELECT cs.id, cs.ticket_id
    INTO v_submission_id, v_ticket_id
    FROM public.customer_submissions cs
    WHERE cs.id = v_token.customer_submission_id;

    IF v_submission_id IS NULL OR v_ticket_id IS NULL THEN
      RAISE EXCEPTION 'used_token_has_incomplete_finalization';
    END IF;

    IF v_submission_id <> p_submission_id THEN
      RAISE EXCEPTION 'submission_already_finalized_by_another_request'
        USING ERRCODE = '55000';
    END IF;

    IF (
      (SELECT count(*) FROM public.ticket_attachments ta
       WHERE ta.customer_submission_id = v_submission_id)
        <> jsonb_array_length(COALESCE(p_attachments, '[]'::jsonb))
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) item
        WHERE NOT EXISTS (
          SELECT 1 FROM public.ticket_attachments ta
          WHERE ta.customer_submission_id = v_submission_id
            AND ta.storage_path = item->>'storage_path'
        )
      )
    ) THEN
      RAISE EXCEPTION 'replay_attachment_mismatch' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT v_ticket_id, v_submission_id, false, true;
    RETURN;
  END IF;

  IF v_token.status <> 'active' THEN
    RAISE EXCEPTION 'submission_token_not_active' USING ERRCODE = '55000';
  END IF;

  IF v_token.expires_at <= now() THEN
    RAISE EXCEPTION 'submission_token_expired' USING ERRCODE = '55000';
  END IF;

  IF jsonb_array_length(COALESCE(p_attachments, '[]'::jsonb)) > COALESCE(v_token.max_upload_count, 5) THEN
    RAISE EXCEPTION 'attachment_count_exceeded' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) item
    GROUP BY item->>'storage_path'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate_attachment_path' USING ERRCODE = '22023';
  END IF;

  -- Verify every staged private object server-side before any business rows are
  -- finalized. Client-supplied metadata is never sufficient by itself.
  FOR v_attachment IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb))
  LOOP
    v_bucket := NULLIF(v_attachment->>'storage_bucket', '');
    v_path := NULLIF(v_attachment->>'storage_path', '');
    IF v_bucket IS NULL OR v_path IS NULL THEN
      RAISE EXCEPTION 'attachment_storage_location_required' USING ERRCODE = '22023';
    END IF;
    IF v_bucket <> 'ticket-attachments' OR
       v_path NOT LIKE ('customer-submissions/' || p_submission_id::text || '/%') THEN
      RAISE EXCEPTION 'attachment_storage_location_not_authorized' USING ERRCODE = '42501';
    END IF;
    SELECT o.metadata
    INTO v_object_metadata
    FROM storage.objects o
    WHERE o.bucket_id = v_bucket AND o.name = v_path;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attachment_object_missing:%', v_path USING ERRCODE = 'P0002';
    END IF;

    v_attachment_size := NULLIF(v_attachment->>'size_bytes', '')::bigint;
    v_attachment_mime := lower(NULLIF(v_attachment->>'mime_type', ''));
    v_attachment_media := lower(NULLIF(v_attachment->>'media_type', ''));
    v_object_size := NULLIF(v_object_metadata->>'size', '')::bigint;
    v_object_mime := lower(NULLIF(v_object_metadata->>'mimetype', ''));

    IF v_attachment_size IS NULL OR v_object_size IS NULL OR
       v_attachment_size <> v_object_size OR v_object_size > 104857600 THEN
      RAISE EXCEPTION 'attachment_size_mismatch:%', v_path USING ERRCODE = '22023';
    END IF;
    IF v_attachment_mime IS NULL OR v_object_mime IS NULL OR
       v_attachment_mime <> v_object_mime OR
       (v_attachment_mime NOT LIKE 'image/%' AND v_attachment_mime NOT LIKE 'video/%') THEN
      RAISE EXCEPTION 'attachment_mime_mismatch:%', v_path USING ERRCODE = '22023';
    END IF;
    IF (v_attachment_media = 'image' AND v_attachment_mime NOT LIKE 'image/%') OR
       (v_attachment_media = 'video' AND v_attachment_mime NOT LIKE 'video/%') OR
       v_attachment_media NOT IN ('image', 'video') THEN
      RAISE EXCEPTION 'attachment_media_type_mismatch:%', v_path USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_ticket_id := v_token.ticket_id;

  -- Reuse the existing ticket for the order, including immutable migrated
  -- history, instead of creating a second active case after retirement.
  IF v_ticket_id IS NULL AND v_token.external_order_id IS NOT NULL THEN
    SELECT t.id
    INTO v_ticket_id
    FROM public.tickets t
    WHERE t.platform = COALESCE(v_token.platform, 'mercari')
      AND t.account_id IS NOT DISTINCT FROM v_token.account_id
      AND t.external_order_id = v_token.external_order_id
    ORDER BY t.created_at ASC
    LIMIT 1;
  END IF;

  IF v_ticket_id IS NULL THEN
    BEGIN
      INSERT INTO public.tickets (
        platform,
        account_id,
        external_order_id,
        origin,
        subject,
        description,
        status,
        priority,
        issue_types,
        latest_message_at,
        latest_customer_message,
        needs_reply,
        raw_source_payload
      ) VALUES (
        COALESCE(v_token.platform, 'mercari'),
        v_token.account_id,
        v_token.external_order_id,
        'form_submission',
        COALESCE(NULLIF(v_token.product_name, '') || ' 不具合報告', 'アフターサービス申請'),
        btrim(p_issue_description),
        'open',
        'high',
        ARRAY['quality_issue']::text[],
        now(),
        btrim(p_issue_description),
        true,
        jsonb_build_object(
          'source', 'ticketform_submission',
          'submission_token_id', v_token.id,
          'product_name', v_token.product_name,
          'product_sku', v_token.product_sku
        )
      )
      RETURNING id INTO v_ticket_id;
      v_created_ticket := true;
    EXCEPTION WHEN unique_violation THEN
      -- Concurrent creation for the same platform/account/order deterministically
      -- resolves to the winner rather than surfacing an unknown failure.
      SELECT t.id
      INTO v_ticket_id
      FROM public.tickets t
      WHERE t.platform = COALESCE(v_token.platform, 'mercari')
        AND t.account_id IS NOT DISTINCT FROM v_token.account_id
        AND t.external_order_id = v_token.external_order_id
      ORDER BY t.created_at ASC
      LIMIT 1;
      IF v_ticket_id IS NULL THEN
        RAISE;
      END IF;
    END;
  END IF;

  -- New customer evidence always returns the case to actionable work.
  UPDATE public.tickets
  SET latest_message_at = now(),
      latest_customer_message = btrim(p_issue_description),
      needs_reply = true,
      status = CASE
        WHEN status IN ('pending_customer', 'resolved', 'closed', 'canceled') THEN 'in_progress'
        ELSE status
      END,
      closed_at = CASE
        WHEN status IN ('resolved', 'closed', 'canceled') THEN NULL
        ELSE closed_at
      END
  WHERE id = v_ticket_id;

  INSERT INTO public.customer_submissions (
    id,
    ticket_id,
    submission_type,
    issue_description,
    expected_solution,
    source,
    processing_status,
    raw_payload,
    submitted_at
  ) VALUES (
    p_submission_id,
    v_ticket_id,
    v_token.allowed_submission_type,
    btrim(p_issue_description),
    NULLIF(btrim(COALESCE(p_expected_solution, '')), ''),
    'public_form',
    'linked',
    jsonb_build_object(
      'submission_token_id', v_token.id,
      'external_order_id', v_token.external_order_id
    ),
    now()
  )
  RETURNING id INTO v_submission_id;

  FOR v_attachment IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb))
  LOOP
    v_attachment_id := COALESCE(
      NULLIF(v_attachment->>'id', '')::uuid,
      gen_random_uuid()
    );
    INSERT INTO public.ticket_attachments (
      id,
      ticket_id,
      customer_submission_id,
      storage_bucket,
      storage_path,
      filename,
      mime_type,
      media_type,
      size_bytes,
      source,
      metadata
    ) VALUES (
      v_attachment_id,
      v_ticket_id,
      v_submission_id,
      v_attachment->>'storage_bucket',
      v_attachment->>'storage_path',
      v_attachment->>'filename',
      v_attachment->>'mime_type',
      v_attachment->>'media_type',
      NULLIF(v_attachment->>'size_bytes', '')::bigint,
      'customer_submission',
      COALESCE(v_attachment->'metadata', '{}'::jsonb)
    );
  END LOOP;

  -- Best-effort product relationship: failure to resolve master data must not
  -- lose an otherwise valid customer submission.
  IF NULLIF(btrim(COALESCE(v_token.product_sku, '')), '') IS NOT NULL THEN
    BEGIN
      SELECT pv.id, pv.product_id
      INTO v_variant_id, v_product_id
      FROM public.product_variants pv
      WHERE lower(pv.item_code) = lower(v_token.product_sku)
         OR lower(pv.sku) = lower(v_token.product_sku)
      ORDER BY CASE WHEN lower(pv.item_code) = lower(v_token.product_sku) THEN 0 ELSE 1 END
      LIMIT 1;

      IF v_variant_id IS NOT NULL THEN
        INSERT INTO public.ticket_products (
          ticket_id, product_id, variant_id, sku, role
        ) VALUES (
          v_ticket_id, v_product_id, v_variant_id, v_token.product_sku, 'primary'
        ) ON CONFLICT DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Preserve the form/ticket transaction; unresolved product context is
      -- reviewable and can be linked later by an operator.
      NULL;
    END;
  END IF;

  IF v_created_ticket THEN
    INSERT INTO public.ticket_events (
      ticket_id, event_type, actor_type, payload
    ) VALUES (
      v_ticket_id,
      'ticket_created',
      'customer',
      jsonb_build_object(
        'source', 'ticketform_submission',
        'submission_id', v_submission_id,
        'submission_token_id', v_token.id
      )
    );
  END IF;

  INSERT INTO public.ticket_events (
    ticket_id, event_type, actor_type, payload
  ) VALUES (
    v_ticket_id,
    'message_received',
    'customer',
    jsonb_build_object(
      'source', 'ticketform_submission',
      'submission_id', v_submission_id,
      'attachment_count', jsonb_array_length(COALESCE(p_attachments, '[]'::jsonb)),
      'description_preview', left(btrim(p_issue_description), 200)
    )
  );

  FOR v_attachment IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb))
  LOOP
    INSERT INTO public.ticket_events (
      ticket_id, event_type, actor_type, payload
    ) VALUES (
      v_ticket_id,
      'attachment_added',
      'customer',
      jsonb_build_object(
        'submission_id', v_submission_id,
        'filename', v_attachment->>'filename',
        'storage_path', v_attachment->>'storage_path'
      )
    );
  END LOOP;

  UPDATE public.submission_tokens
  SET status = 'used',
      used_count = used_count + 1,
      ticket_id = v_ticket_id,
      customer_submission_id = v_submission_id,
      finalized_at = now()
  WHERE id = v_token.id;

  -- A form created from an inbound queue request completes that queue handoff.
  IF v_token.source_inbound_message_id IS NOT NULL THEN
    UPDATE public.inbound_ticket_messages
    SET linked_ticket_id = v_ticket_id,
        queue_status = 'linked',
        review_status = 'reviewed',
        read_at = COALESCE(read_at, now()),
        reviewed_at = COALESCE(reviewed_at, now())
    WHERE id = v_token.source_inbound_message_id;
  END IF;

  RETURN QUERY SELECT v_ticket_id, v_submission_id, v_created_ticket, false;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_ticketform_submission(
  uuid, uuid, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_ticketform_submission(
  uuid, uuid, text, text, jsonb
) TO service_role;

COMMENT ON FUNCTION public.finalize_ticketform_submission(
  uuid, uuid, text, text, jsonb
) IS 'Idempotently finalizes a validated TicketForm into one linked submission, ticket, evidence set, and audit trail.';
