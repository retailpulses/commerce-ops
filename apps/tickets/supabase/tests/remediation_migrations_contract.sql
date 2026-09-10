\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_condition, false) THEN
    RAISE EXCEPTION 'assertion_failed: %', p_message;
  END IF;
END;
$$;

INSERT INTO public.submission_tokens (
  id, token_hash, platform, external_order_id, status, expires_at,
  max_upload_count, product_name
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'token-100m', 'mercari',
  'ORDER-100M', 'active', now() + interval '1 day', 5, 'Video product'
);

INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (
  'ticket-attachments',
  'customer-submissions/22222222-2222-4222-8222-222222222222/evidence.mp4',
  '{"size":"104857600","mimetype":"video/mp4"}'::jsonb
);

CREATE TEMP TABLE first_finalize AS
SELECT * FROM public.finalize_ticketform_submission(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'Exact 100 MiB video evidence',
  'Replacement requested',
  '[{"id":"33333333-3333-4333-8333-333333333333","storage_bucket":"ticket-attachments","storage_path":"customer-submissions/22222222-2222-4222-8222-222222222222/evidence.mp4","filename":"evidence.mp4","mime_type":"video/mp4","media_type":"video","size_bytes":104857600}]'::jsonb
);

SELECT pg_temp.assert_true(created_ticket AND NOT replayed, 'first finalization must create one ticket')
FROM first_finalize;

CREATE TEMP TABLE replay_finalize AS
SELECT * FROM public.finalize_ticketform_submission(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'Exact 100 MiB video evidence',
  'Replacement requested',
  '[{"id":"33333333-3333-4333-8333-333333333333","storage_bucket":"ticket-attachments","storage_path":"customer-submissions/22222222-2222-4222-8222-222222222222/evidence.mp4","filename":"evidence.mp4","mime_type":"video/mp4","media_type":"video","size_bytes":104857600}]'::jsonb
);

SELECT pg_temp.assert_true(NOT created_ticket AND replayed, 'same submission must replay')
FROM replay_finalize;

SELECT pg_temp.assert_true(
  (SELECT used_count = 1 AND status = 'used' FROM public.submission_tokens WHERE token_hash = 'token-100m'),
  'successful replay must not consume the token twice'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.customer_submissions WHERE id = '22222222-2222-4222-8222-222222222222'),
  'TicketForm replay must leave exactly one submission'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.ticket_attachments (
      ticket_id, storage_bucket, storage_path, media_type, source
    ) VALUES (
      (SELECT ticket_id FROM first_finalize),
      'ticket-attachments',
      'customer-submissions/22222222-2222-4222-8222-222222222222/evidence.mp4',
      'video',
      'operator_upload'
    );
    RAISE EXCEPTION 'duplicate attachment path unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
$$;

CREATE TEMP TABLE first_resolution AS
SELECT * FROM public.record_ticket_resolution(
  (SELECT ticket_id FROM first_finalize),
  '44444444-4444-4444-8444-444444444444',
  'replacement', NULL, 'JPY', 'SKU-REPLACEMENT', 1,
  'Replacement approved', 'REF-100M', 'portal_operator', true
);

CREATE TEMP TABLE replay_resolution AS
SELECT * FROM public.record_ticket_resolution(
  (SELECT ticket_id FROM first_finalize),
  '44444444-4444-4444-8444-444444444444',
  'replacement', NULL, 'JPY', 'SKU-REPLACEMENT', 1,
  'Replacement approved', 'REF-100M', 'portal_operator', true
);

SELECT pg_temp.assert_true(
  (SELECT id FROM first_resolution) = (SELECT id FROM replay_resolution),
  'resolution replay must return the original action'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.ticket_resolution_actions WHERE operation_id = '44444444-4444-4444-8444-444444444444'),
  'resolution replay must create one action'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.ticket_events WHERE event_type = 'resolution_updated' AND ticket_id = (SELECT ticket_id FROM first_finalize)),
  'resolution replay must create one resolution event'
);

UPDATE public.tickets
SET needs_reply = true
WHERE id = (SELECT ticket_id FROM first_finalize);

INSERT INTO public.sent_messages (
  id, ticket_id, platform, body, reply_intent, sent_by,
  client_operation_id, delivery_status
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  (SELECT ticket_id FROM first_finalize),
  'mercari', 'Replacement arranged', 'terminal', 'portal_operator',
  '66666666-6666-4666-8666-666666666666', 'sending'
);

CREATE TEMP TABLE first_send AS
SELECT * FROM public.finalize_operator_message_send(
  (SELECT ticket_id FROM first_finalize),
  '66666666-6666-4666-8666-666666666666',
  'platform-message-100m', now(), 'portal_operator'
);

CREATE TEMP TABLE replay_send AS
SELECT * FROM public.finalize_operator_message_send(
  (SELECT ticket_id FROM first_finalize),
  '66666666-6666-4666-8666-666666666666',
  'platform-message-100m', now(), 'portal_operator'
);

SELECT pg_temp.assert_true(
  NOT (SELECT replayed FROM first_send) AND (SELECT replayed FROM replay_send),
  'message finalization must distinguish first completion from replay'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.ticket_messages WHERE client_operation_id = '66666666-6666-4666-8666-666666666666'),
  'message replay must create one ticket message'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.ticket_events WHERE event_type = 'message_sent' AND payload->>'client_operation_id' = '66666666-6666-4666-8666-666666666666'),
  'message replay must create one sent event'
);

SELECT pg_temp.assert_true(
  NOT (SELECT needs_reply FROM public.tickets WHERE id = (SELECT ticket_id FROM first_finalize)),
  'terminal message finalization must clear needs_reply'
);

SELECT 'remediation migration contract passed' AS result;
