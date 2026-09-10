-- Domain: ticketing/platform-runtime-security
-- Owner: retailpulses/ticket-handling
-- Affected: six platform runtime roles, platform-scoped RPC ACLs and probes
-- Change class: additive, platform-isolated security boundary
-- Hosted write required: yes; exact-SHA approval and authoritative role/ACL readback required
-- Consumers: Mercari, Rakuten and Amazon send/ingestion Workers
-- Additive platform-scoped PostgREST roles and send-ticket projections.
-- Runtime secrets must be JWTs whose role claim is exactly one role below.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_mercari_send_runtime') THEN CREATE ROLE ticketing_mercari_send_runtime NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_mercari_ingestion_runtime') THEN CREATE ROLE ticketing_mercari_ingestion_runtime NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_rakuten_send_runtime') THEN CREATE ROLE ticketing_rakuten_send_runtime NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_rakuten_ingestion_runtime') THEN CREATE ROLE ticketing_rakuten_ingestion_runtime NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_amazon_send_runtime') THEN CREATE ROLE ticketing_amazon_send_runtime NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_amazon_ingestion_runtime') THEN CREATE ROLE ticketing_amazon_ingestion_runtime NOLOGIN NOINHERIT; END IF;
END $$;

GRANT ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime TO authenticator;
GRANT USAGE ON SCHEMA public TO ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime;

CREATE OR REPLACE FUNCTION public.get_mercari_send_ticket_v1(p_ticket_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(t) || jsonb_build_object(
    'products','[]'::jsonb, 'notes','[]'::jsonb, 'events','[]'::jsonb,
    'resolution_actions','[]'::jsonb, 'customer_submissions','[]'::jsonb,
    'messages', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY COALESCE(m.sent_at,m.created_at) DESC) FROM public.ticket_messages m WHERE m.ticket_id=t.id),'[]'::jsonb)
  ) FROM public.tickets t WHERE t.id=p_ticket_id AND t.platform='mercari';
$$;
CREATE OR REPLACE FUNCTION public.get_rakuten_send_ticket_v1(p_ticket_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(t) || jsonb_build_object(
    'products','[]'::jsonb, 'notes','[]'::jsonb, 'events','[]'::jsonb,
    'resolution_actions','[]'::jsonb, 'customer_submissions','[]'::jsonb,
    'messages', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY COALESCE(m.sent_at,m.created_at) DESC) FROM public.ticket_messages m WHERE m.ticket_id=t.id),'[]'::jsonb)
  ) FROM public.tickets t WHERE t.id=p_ticket_id AND t.platform='rakuten';
$$;
CREATE OR REPLACE FUNCTION public.get_amazon_send_ticket_v1(p_ticket_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(t) || jsonb_build_object(
    'products','[]'::jsonb, 'notes','[]'::jsonb, 'events','[]'::jsonb,
    'resolution_actions','[]'::jsonb, 'customer_submissions','[]'::jsonb,
    'messages', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY COALESCE(m.sent_at,m.created_at) DESC) FROM public.ticket_messages m WHERE m.ticket_id=t.id),'[]'::jsonb)
  ) FROM public.tickets t WHERE t.id=p_ticket_id AND t.platform='amazon';
$$;

REVOKE ALL ON FUNCTION public.get_mercari_send_ticket_v1(uuid), public.get_rakuten_send_ticket_v1(uuid), public.get_amazon_send_ticket_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_mercari_send_ticket_v1(uuid) TO ticketing_mercari_send_runtime;
GRANT EXECUTE ON FUNCTION public.get_rakuten_send_ticket_v1(uuid) TO ticketing_rakuten_send_runtime;
GRANT EXECUTE ON FUNCTION public.get_amazon_send_ticket_v1(uuid) TO ticketing_amazon_send_runtime;

ALTER TABLE public.sent_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.sent_messages TO ticketing_mercari_send_runtime, ticketing_rakuten_send_runtime;
DROP POLICY IF EXISTS mercari_runtime_sent_messages ON public.sent_messages;
CREATE POLICY mercari_runtime_sent_messages ON public.sent_messages FOR ALL TO ticketing_mercari_send_runtime USING (platform='mercari') WITH CHECK (platform='mercari');
DROP POLICY IF EXISTS rakuten_runtime_sent_messages ON public.sent_messages;
CREATE POLICY rakuten_runtime_sent_messages ON public.sent_messages FOR ALL TO ticketing_rakuten_send_runtime USING (platform='rakuten') WITH CHECK (platform='rakuten');

ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tickets TO ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime;
DROP POLICY IF EXISTS mercari_runtime_tickets ON public.tickets;
CREATE POLICY mercari_runtime_tickets ON public.tickets FOR SELECT TO ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime USING (platform='mercari');
DROP POLICY IF EXISTS rakuten_runtime_tickets ON public.tickets;
CREATE POLICY rakuten_runtime_tickets ON public.tickets FOR SELECT TO ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime USING (platform='rakuten');
DROP POLICY IF EXISTS amazon_runtime_tickets ON public.tickets;
CREATE POLICY amazon_runtime_tickets ON public.tickets FOR SELECT TO ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime USING (platform='amazon');
GRANT SELECT ON public.ticket_messages TO ticketing_mercari_send_runtime, ticketing_rakuten_send_runtime;
DROP POLICY IF EXISTS mercari_runtime_ticket_messages ON public.ticket_messages;
CREATE POLICY mercari_runtime_ticket_messages ON public.ticket_messages FOR SELECT TO ticketing_mercari_send_runtime USING (EXISTS (SELECT 1 FROM public.tickets t WHERE t.id=ticket_id AND t.platform='mercari'));
DROP POLICY IF EXISTS rakuten_runtime_ticket_messages ON public.ticket_messages;
CREATE POLICY rakuten_runtime_ticket_messages ON public.ticket_messages FOR SELECT TO ticketing_rakuten_send_runtime USING (EXISTS (SELECT 1 FROM public.tickets t WHERE t.id=ticket_id AND t.platform='rakuten'));

GRANT SELECT ON public.platform_accounts TO ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime;
ALTER TABLE public.platform_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mercari_runtime_accounts ON public.platform_accounts;
CREATE POLICY mercari_runtime_accounts ON public.platform_accounts FOR SELECT TO ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime USING (platform='mercari');
DROP POLICY IF EXISTS rakuten_runtime_accounts ON public.platform_accounts;
CREATE POLICY rakuten_runtime_accounts ON public.platform_accounts FOR SELECT TO ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime USING (platform='rakuten');
DROP POLICY IF EXISTS amazon_runtime_accounts ON public.platform_accounts;
CREATE POLICY amazon_runtime_accounts ON public.platform_accounts FOR SELECT TO ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime USING (platform='amazon');

GRANT SELECT ON public.mercari_send_context TO ticketing_mercari_send_runtime;
GRANT SELECT ON public.rakuten_rmesse_send_context TO ticketing_rakuten_send_runtime;
GRANT SELECT ON public.amazon_spapi_send_context TO ticketing_amazon_send_runtime;
GRANT SELECT, INSERT, UPDATE ON public.inbound_ticket_messages TO ticketing_mercari_ingestion_runtime;
GRANT SELECT ON public.rakuten_rmesse_inquiries TO ticketing_rakuten_ingestion_runtime;
GRANT SELECT ON public.amazon_mail_messages, public.amazon_mail_sync_state_v2 TO ticketing_amazon_ingestion_runtime;

DO $$ BEGIN
  IF to_regclass('public.rakuten_rmesse_sync_state') IS NOT NULL THEN
    GRANT SELECT ON public.rakuten_rmesse_sync_state TO ticketing_rakuten_ingestion_runtime;
  END IF;
END $$;

DROP POLICY IF EXISTS mercari_runtime_inbound_messages ON public.inbound_ticket_messages;
CREATE POLICY mercari_runtime_inbound_messages ON public.inbound_ticket_messages
  FOR ALL TO ticketing_mercari_ingestion_runtime
  USING (source = 'mercari_webhook')
  WITH CHECK (source = 'mercari_webhook');

DROP POLICY IF EXISTS rakuten_runtime_inquiries ON public.rakuten_rmesse_inquiries;
CREATE POLICY rakuten_runtime_inquiries ON public.rakuten_rmesse_inquiries
  FOR SELECT TO ticketing_rakuten_ingestion_runtime
  USING (EXISTS (
    SELECT 1 FROM public.platform_accounts account
    WHERE account.id = account_id AND account.platform = 'rakuten'
  ));

CREATE OR REPLACE FUNCTION public.ingest_mercari_webhook_event_v1(
  p_shop_name text,
  p_shop_id text,
  p_order_transaction_id text,
  p_webhook_received_at timestamptz,
  p_server_received_at timestamptz,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid; v_inserted boolean := true;
BEGIN
  IF btrim(COALESCE(p_shop_name, '')) = '' OR
     btrim(COALESCE(p_shop_id, '')) = '' OR
     btrim(COALESCE(p_order_transaction_id, '')) = '' OR
     btrim(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'mercari_webhook_identity_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.inbound_ticket_messages (
    id, source, shop_name, shop_id, order_transaction_id, webhook_received_at,
    server_received_at, idempotency_key, processing_status,
    product_summary, order_summary, classification, full_payload
  ) VALUES (
    gen_random_uuid(), 'mercari_webhook', p_shop_name, p_shop_id, p_order_transaction_id,
    p_webhook_received_at, p_server_received_at, p_idempotency_key, 'pending',
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    v_inserted := false;
    SELECT id INTO v_id FROM public.inbound_ticket_messages
    WHERE source = 'mercari_webhook' AND idempotency_key = p_idempotency_key;
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'mercari_webhook_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('id', v_id, 'inserted', v_inserted);
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_rakuten_rmesse_sync_state_v1(
  p_account_id uuid,
  p_cursor_updated_at timestamptz,
  p_last_success_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row public.rakuten_rmesse_sync_state%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_accounts
    WHERE id = p_account_id AND platform = 'rakuten' AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'rakuten_platform_account_not_active' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rakuten_rmesse_sync_state (
    account_id, cursor_updated_at, last_success_at, last_error, updated_at
  ) VALUES (
    p_account_id, p_cursor_updated_at, p_last_success_at, NULL, now()
  )
  ON CONFLICT (account_id) DO UPDATE SET
    cursor_updated_at = GREATEST(public.rakuten_rmesse_sync_state.cursor_updated_at, EXCLUDED.cursor_updated_at),
    last_success_at = EXCLUDED.last_success_at,
    last_error = NULL,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_platform_operator_message_claim_v1(
  p_ticket_id uuid,
  p_expected_platform text,
  p_client_operation_id uuid,
  p_expected_body text,
  p_expected_reply_intent text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_expected_platform NOT IN ('mercari', 'rakuten') THEN
    RAISE EXCEPTION 'platform_release_unsupported' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.sent_messages
  WHERE ticket_id = p_ticket_id
    AND platform = p_expected_platform
    AND client_operation_id = p_client_operation_id
    AND body = p_expected_body
    AND reply_intent = p_expected_reply_intent
    AND delivery_status = 'sending'
    AND platform_message_id IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_mercari_operator_message_claim_v1(
  p_ticket_id uuid, p_client_operation_id uuid, p_expected_body text, p_expected_reply_intent text
)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.release_platform_operator_message_claim_v1(
    p_ticket_id, 'mercari', p_client_operation_id, p_expected_body, p_expected_reply_intent
  )
$$;

CREATE OR REPLACE FUNCTION public.release_rakuten_operator_message_claim_v1(
  p_ticket_id uuid, p_client_operation_id uuid, p_expected_body text, p_expected_reply_intent text
)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.release_platform_operator_message_claim_v1(
    p_ticket_id, 'rakuten', p_client_operation_id, p_expected_body, p_expected_reply_intent
  )
$$;

REVOKE ALL ON FUNCTION public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_platform_operator_message_claim_v1(uuid,text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_mercari_operator_message_claim_v1(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_rakuten_operator_message_claim_v1(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text) TO ticketing_mercari_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.claim_pending_mercari_webhook_messages(integer) TO ticketing_mercari_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.release_mercari_operator_message_claim_v1(uuid,uuid,text,text) TO ticketing_mercari_send_runtime;
GRANT EXECUTE ON FUNCTION public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text) TO ticketing_mercari_send_runtime;
GRANT EXECUTE ON FUNCTION public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz) TO ticketing_rakuten_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.release_rakuten_operator_message_claim_v1(uuid,uuid,text,text) TO ticketing_rakuten_send_runtime;
GRANT EXECUTE ON FUNCTION public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text) TO ticketing_rakuten_send_runtime;

DO $$
BEGIN
  IF to_regprocedure('public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb) TO ticketing_rakuten_ingestion_runtime;
  END IF;
  IF to_regprocedure('public.seed_amazon_mail_sync_state_v2_from_legacy(text,text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.seed_amazon_mail_sync_state_v2_from_legacy(text,text) TO ticketing_amazon_ingestion_runtime;
  END IF;
  IF to_regprocedure('public.ingest_amazon_mail_message_v3(uuid,text,text,text,timestamptz,text,text,text,text,text,text,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ingest_amazon_mail_message_v3(uuid,text,text,text,timestamptz,text,text,text,text,text,text,integer) TO ticketing_amazon_ingestion_runtime;
  END IF;
  IF to_regprocedure('public.upsert_amazon_mail_sync_state_v2(text,text,bigint,timestamptz,text,timestamptz,timestamptz,text,timestamptz,text,jsonb)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.upsert_amazon_mail_sync_state_v2(text,text,bigint,timestamptz,text,timestamptz,timestamptz,text,timestamptz,text,jsonb) TO ticketing_amazon_ingestion_runtime;
  END IF;
  IF to_regprocedure('public.claim_amazon_mail_attachments(integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.claim_amazon_mail_attachments(integer) TO ticketing_amazon_ingestion_runtime;
  END IF;
  IF to_regprocedure('public.finalize_amazon_mail_attachment_batch(jsonb)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.finalize_amazon_mail_attachment_batch(jsonb) TO ticketing_amazon_ingestion_runtime;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.probe_platform_runtime_internal(p_platform text, p_role text, p_principal name)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_ready boolean := false; v_last timestamptz; v_checkpoint text;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM p_principal::text THEN
    RAISE EXCEPTION 'runtime_principal_mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_platform='mercari' AND p_role='send' THEN
    v_ready := to_regprocedure('public.get_mercari_send_ticket_v1(uuid)') IS NOT NULL
      AND has_function_privilege(p_principal, 'public.get_mercari_send_ticket_v1(uuid)', 'EXECUTE')
      AND has_function_privilege(p_principal, 'public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)', 'EXECUTE')
      AND has_function_privilege(p_principal, 'public.release_mercari_operator_message_claim_v1(uuid,uuid,text,text)', 'EXECUTE')
      AND has_table_privilege(p_principal, 'public.sent_messages', 'SELECT,INSERT,UPDATE');
    SELECT max(sent_at) INTO v_last FROM public.sent_messages WHERE platform='mercari' AND delivery_status='sent';
  ELSIF p_platform='rakuten' AND p_role='send' THEN
    v_ready := to_regprocedure('public.get_rakuten_send_ticket_v1(uuid)') IS NOT NULL
      AND has_function_privilege(p_principal, 'public.get_rakuten_send_ticket_v1(uuid)', 'EXECUTE')
      AND has_function_privilege(p_principal, 'public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)', 'EXECUTE')
      AND has_function_privilege(p_principal, 'public.release_rakuten_operator_message_claim_v1(uuid,uuid,text,text)', 'EXECUTE')
      AND has_table_privilege(p_principal, 'public.sent_messages', 'SELECT,INSERT,UPDATE');
    SELECT max(sent_at) INTO v_last FROM public.sent_messages WHERE platform='rakuten' AND delivery_status='sent';
  ELSIF p_platform='amazon' AND p_role='send' THEN
    v_ready := false;
    SELECT max(sent_at) INTO v_last FROM public.sent_messages WHERE platform='amazon' AND delivery_status='sent';
  ELSIF p_platform='mercari' AND p_role='ingestion' THEN
    v_ready := to_regprocedure('public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text)') IS NOT NULL
      AND has_function_privilege(p_principal, 'public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text)', 'EXECUTE')
      AND has_function_privilege(p_principal, 'public.claim_pending_mercari_webhook_messages(integer)', 'EXECUTE')
      AND has_table_privilege(p_principal, 'public.inbound_ticket_messages', 'SELECT,UPDATE');
    SELECT max(server_received_at), max(server_received_at)::text INTO v_last,v_checkpoint FROM public.inbound_ticket_messages WHERE source='mercari_webhook';
  ELSIF p_platform='rakuten' AND p_role='ingestion' THEN
    v_ready := to_regprocedure('public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb)') IS NOT NULL
      AND has_function_privilege(p_principal, 'public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb)', 'EXECUTE')
      AND has_function_privilege(p_principal, 'public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz)', 'EXECUTE')
      AND has_table_privilege(p_principal, 'public.rakuten_rmesse_inquiries', 'SELECT');
    IF to_regclass('public.rakuten_rmesse_sync_state') IS NOT NULL THEN
      EXECUTE 'SELECT max(updated_at), max(updated_at)::text FROM public.rakuten_rmesse_sync_state' INTO v_last,v_checkpoint;
    END IF;
  ELSIF p_platform='amazon' AND p_role='ingestion' THEN
    v_ready := to_regprocedure('public.ingest_amazon_mail_message_v3(uuid,text,text,text,timestamptz,text,text,text,text,text,text,integer)') IS NOT NULL
      AND has_function_privilege(p_principal, 'public.ingest_amazon_mail_message_v3(uuid,text,text,text,timestamptz,text,text,text,text,text,text,integer)', 'EXECUTE')
      AND has_table_privilege(p_principal, 'public.amazon_mail_messages', 'SELECT')
      AND has_table_privilege(p_principal, 'public.amazon_mail_sync_state_v2', 'SELECT');
    SELECT max(updated_at), max(updated_at)::text INTO v_last,v_checkpoint FROM public.amazon_mail_sync_state_v2;
  END IF;
  IF v_ready THEN
    CASE p_principal::text
      WHEN 'ticketing_mercari_send_runtime' THEN
        v_ready := NOT has_table_privilege(p_principal,'public.sent_messages','DELETE')
          AND NOT has_function_privilege(p_principal,'public.get_rakuten_send_ticket_v1(uuid)','EXECUTE')
          AND NOT has_function_privilege(p_principal,'public.get_amazon_send_ticket_v1(uuid)','EXECUTE')
          AND NOT has_function_privilege(p_principal,'public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text)','EXECUTE');
      WHEN 'ticketing_mercari_ingestion_runtime' THEN
        v_ready := NOT has_table_privilege(p_principal,'public.sent_messages','SELECT,INSERT,UPDATE,DELETE')
          AND NOT has_function_privilege(p_principal,'public.get_mercari_send_ticket_v1(uuid)','EXECUTE')
          AND NOT has_function_privilege(p_principal,'public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz)','EXECUTE');
      WHEN 'ticketing_rakuten_send_runtime' THEN
        v_ready := NOT has_table_privilege(p_principal,'public.sent_messages','DELETE')
          AND NOT has_function_privilege(p_principal,'public.get_mercari_send_ticket_v1(uuid)','EXECUTE')
          AND NOT has_function_privilege(p_principal,'public.get_amazon_send_ticket_v1(uuid)','EXECUTE')
          AND NOT has_function_privilege(p_principal,'public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz)','EXECUTE');
      WHEN 'ticketing_rakuten_ingestion_runtime' THEN
        v_ready := NOT has_table_privilege(p_principal,'public.sent_messages','SELECT,INSERT,UPDATE,DELETE')
          AND NOT has_function_privilege(p_principal,'public.get_rakuten_send_ticket_v1(uuid)','EXECUTE')
          AND NOT has_function_privilege(p_principal,'public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text)','EXECUTE');
      WHEN 'ticketing_amazon_ingestion_runtime' THEN
        v_ready := NOT has_table_privilege(p_principal,'public.sent_messages','SELECT,INSERT,UPDATE,DELETE')
          AND NOT has_function_privilege(p_principal,'public.get_amazon_send_ticket_v1(uuid)','EXECUTE')
          AND (to_regprocedure('public.claim_amazon_mail_send(uuid,uuid,text,text,text,uuid,text,timestamptz,text,text)') IS NULL OR NOT has_function_privilege(p_principal,'public.claim_amazon_mail_send(uuid,uuid,text,text,text,uuid,text,timestamptz,text,text)','EXECUTE'))
          AND (to_regprocedure('public.begin_amazon_mail_provider_mutation(uuid,uuid,bigint)') IS NULL OR NOT has_function_privilege(p_principal,'public.begin_amazon_mail_provider_mutation(uuid,uuid,bigint)','EXECUTE'))
          AND (to_regprocedure('public.finalize_amazon_mail_send(uuid,uuid,text,timestamptz,text)') IS NULL OR NOT has_function_privilege(p_principal,'public.finalize_amazon_mail_send(uuid,uuid,text,timestamptz,text)','EXECUTE'));
      ELSE
        v_ready := false;
    END CASE;
  END IF;
  RETURN jsonb_build_object('ready',v_ready,'last_success_at',v_last,'checkpoint',v_checkpoint,'capability_version','2026-09-09.v1');
END $$;
REVOKE ALL ON FUNCTION public.probe_platform_runtime_internal(text,text,name) FROM PUBLIC, anon, authenticated,
  ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime;

CREATE OR REPLACE FUNCTION public.probe_mercari_send_runtime_v1() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.probe_platform_runtime_internal('mercari','send','ticketing_mercari_send_runtime') $$;
CREATE OR REPLACE FUNCTION public.probe_mercari_ingestion_runtime_v1() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.probe_platform_runtime_internal('mercari','ingestion','ticketing_mercari_ingestion_runtime') $$;
CREATE OR REPLACE FUNCTION public.probe_rakuten_send_runtime_v1() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.probe_platform_runtime_internal('rakuten','send','ticketing_rakuten_send_runtime') $$;
CREATE OR REPLACE FUNCTION public.probe_rakuten_ingestion_runtime_v1() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.probe_platform_runtime_internal('rakuten','ingestion','ticketing_rakuten_ingestion_runtime') $$;
CREATE OR REPLACE FUNCTION public.probe_amazon_send_runtime_v1() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.probe_platform_runtime_internal('amazon','send','ticketing_amazon_send_runtime') $$;
CREATE OR REPLACE FUNCTION public.probe_amazon_ingestion_runtime_v1() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.probe_platform_runtime_internal('amazon','ingestion','ticketing_amazon_ingestion_runtime') $$;
REVOKE ALL ON FUNCTION public.probe_mercari_send_runtime_v1(), public.probe_mercari_ingestion_runtime_v1(), public.probe_rakuten_send_runtime_v1(), public.probe_rakuten_ingestion_runtime_v1(), public.probe_amazon_send_runtime_v1(), public.probe_amazon_ingestion_runtime_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.probe_mercari_send_runtime_v1() TO ticketing_mercari_send_runtime;
GRANT EXECUTE ON FUNCTION public.probe_mercari_ingestion_runtime_v1() TO ticketing_mercari_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.probe_rakuten_send_runtime_v1() TO ticketing_rakuten_send_runtime;
GRANT EXECUTE ON FUNCTION public.probe_rakuten_ingestion_runtime_v1() TO ticketing_rakuten_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.probe_amazon_send_runtime_v1() TO ticketing_amazon_send_runtime;
GRANT EXECUTE ON FUNCTION public.probe_amazon_ingestion_runtime_v1() TO ticketing_amazon_ingestion_runtime;
