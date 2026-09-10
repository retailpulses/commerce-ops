#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="ticket-platform-migration-test-$$"
POSTGRES_IMAGE="${PLATFORM_TEST_POSTGRES_IMAGE:-postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73}"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --rm --name "$CONTAINER" \
  --env POSTGRES_PASSWORD=test \
  --volume "$ROOT_DIR:/repo:ro" \
  "$POSTGRES_IMAGE" >/dev/null
ready_streak=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    ready_streak=$((ready_streak + 1))
    if [[ "$ready_streak" -ge 2 ]]; then break; fi
  else
    ready_streak=0
  fi
  sleep 1
done
if [[ "$ready_streak" -lt 2 ]] || ! docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
  echo "PostgreSQL fixture did not become ready: $POSTGRES_IMAGE" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi

psql_exec=(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres)
"${psql_exec[@]}" <<'SQL'
CREATE ROLE service_role;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE authenticator;
CREATE TABLE public.inbound_ticket_messages (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  processing_status text NOT NULL,
  next_retry_at timestamptz,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  last_attempt_at timestamptz,
  shop_name text,
  shop_id text,
  order_transaction_id text,
  webhook_received_at timestamptz
);
SQL

# This migration must apply before any Amazon columns exist.
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908180000_mercari_inbound_retry_source_fence.sql >/dev/null
"${psql_exec[@]}" <<'SQL'
INSERT INTO public.inbound_ticket_messages
  (id, source, processing_status, shop_name, shop_id, order_transaction_id, webhook_received_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'mercari_webhook', 'pending', 'shop', '1', 'tx', now()),
  ('22222222-2222-4222-8222-222222222222', 'rakuten_test', 'pending', NULL, NULL, NULL, NULL);

DO $$
DECLARE claimed_count integer;
BEGIN
  SELECT count(*) INTO claimed_count
  FROM public.claim_pending_mercari_webhook_messages(NULL);
  IF claimed_count <> 1 THEN RAISE EXCEPTION 'expected exactly one Mercari claim'; END IF;
  IF (SELECT processing_status FROM public.inbound_ticket_messages
      WHERE id = '22222222-2222-4222-8222-222222222222') <> 'pending' THEN
    RAISE EXCEPTION 'non-Mercari row was mutated';
  END IF;
END $$;
SQL

# Simulate the Amazon expansion, including its incompatible historical CHECK,
# then prove the forward-only compatibility migration restores Mercari inserts.
"${psql_exec[@]}" <<'SQL'
DELETE FROM public.inbound_ticket_messages;
ALTER TABLE public.inbound_ticket_messages
  ADD COLUMN provider_account_id text,
  ADD COLUMN provider_folder_id text,
  ADD COLUMN provider_message_id text,
  ADD COLUMN source_received_at timestamptz,
  ADD COLUMN mail_auth_status text,
  ADD COLUMN external_order_id text,
  ADD COLUMN review_status text;
ALTER TABLE public.inbound_ticket_messages
  ADD CONSTRAINT chk_inbound_ticket_messages_source_fields CHECK (
    source <> 'mercari_webhook' OR source_received_at IS NOT NULL
  );
SQL
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908181000_amazon_mercari_constraint_compatibility.sql >/dev/null
"${psql_exec[@]}" <<'SQL'
BEGIN;
INSERT INTO public.inbound_ticket_messages
  (id, source, processing_status, shop_name, shop_id, order_transaction_id, webhook_received_at)
VALUES
  ('33333333-3333-4333-8333-333333333333', 'mercari_webhook', 'pending', 'shop', '1', 'tx2', now());
ROLLBACK;

DO $$
BEGIN
  IF has_function_privilege('service_role',
    'public.claim_pending_mercari_webhook_messages(integer)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role execute grant missing';
  END IF;
  IF has_function_privilege('public',
    'public.claim_pending_mercari_webhook_messages(integer)', 'EXECUTE') IS TRUE THEN
    RAISE EXCEPTION 'PUBLIC execute privilege was not revoked';
  END IF;
END $$;
SQL

# Apply and execute the atomic platform-fenced finalize contract.
"${psql_exec[@]}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SEQUENCE public.ticket_number_seq START WITH 1;
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text,
  platform text NOT NULL,
  account_id uuid,
  external_order_id text,
  origin text,
  customer_display_name text,
  subject text,
  description text,
  priority text,
  issue_types text[],
  external_url text,
  needs_reply boolean NOT NULL DEFAULT true,
  external_thread_id text,
  latest_message_at timestamptz,
  latest_customer_message text,
  status text NOT NULL DEFAULT 'open',
  raw_source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.sent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  platform text NOT NULL,
  platform_message_id text,
  body text NOT NULL,
  reply_intent text NOT NULL,
  sent_by text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  platform text NOT NULL,
  external_message_id text,
  sender_type text,
  sender_display_name text,
  body text,
  sent_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ticket_messages_platform_external
  ON public.ticket_messages(platform, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE TABLE public.ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  event_type text,
  actor_type text,
  actor_id text,
  payload jsonb,
  idempotency_key text
);
CREATE UNIQUE INDEX uq_ticket_events_idempotency_key
  ON public.ticket_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
SQL
"${psql_exec[@]}" -f /repo/supabase/migrations/20260715000005_operator_message_idempotency.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908180500_platform_send_finalize_fence.sql >/dev/null
"${psql_exec[@]}" <<'SQL'
INSERT INTO public.tickets (id, platform)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mercari');
INSERT INTO public.sent_messages
  (ticket_id, platform, client_operation_id, body, reply_intent, delivery_status)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mercari',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'approved body', 'terminal', 'sending');

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.finalize_rakuten_operator_message_send(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'approved body', 'terminal',
      'wrong-platform-message', now(), 'operator'
    );
    RAISE EXCEPTION 'platform mismatch unexpectedly finalized';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF (SELECT delivery_status FROM public.sent_messages
      WHERE client_operation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 'sending' THEN
    RAISE EXCEPTION 'mismatched finalize mutated outbox';
  END IF;
END $$;

SELECT * FROM public.finalize_mercari_operator_message_send(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'approved body', 'terminal',
  'mercari-message-1', now(), 'operator'
);

DO $$
BEGIN
  IF (SELECT delivery_status FROM public.sent_messages
      WHERE client_operation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 'sent' THEN
    RAISE EXCEPTION 'matching finalize did not commit';
  END IF;
  IF (SELECT needs_reply FROM public.tickets
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') IS NOT FALSE THEN
    RAISE EXCEPTION 'terminal finalize did not update ticket state';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
      'public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'platform finalize service_role grant missing';
  END IF;
  IF has_function_privilege('public',
      'public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)', 'EXECUTE')
     OR has_function_privilege('public',
      'public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'platform finalize PUBLIC execute privilege was not revoked';
  END IF;
END $$;
SQL

# Apply WP3 additive platform-owned persistence and prove hard platform fences.
"${psql_exec[@]}" <<'SQL'
CREATE TABLE public.platform_accounts (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  shop_code text,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE public.rakuten_rmesse_inquiries (
  account_id uuid NOT NULL,
  inquiry_number text NOT NULL,
  shop_id text,
  order_number text,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  last_update_date timestamptz NOT NULL,
  last_ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, inquiry_number)
);
CREATE TABLE public.rakuten_rmesse_sync_state (
  account_id uuid PRIMARY KEY REFERENCES public.platform_accounts(id),
  cursor_updated_at timestamptz NOT NULL,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_accounts (id, platform, shop_code) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'mercari', 'Shop1'),
  ('99999999-9999-4999-8999-999999999999', 'rakuten', 'Rakuten1'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'amazon', 'Amazon1');
INSERT INTO public.tickets (id, platform) VALUES
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'rakuten'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'amazon');
UPDATE public.tickets SET account_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
UPDATE public.tickets SET account_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  external_order_id = 'mercari-tx'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE public.tickets SET account_id = '99999999-9999-4999-8999-999999999999',
  external_order_id = 'rakuten-order'
WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
UPDATE public.tickets SET external_order_id = 'amazon-order'
WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
ALTER TABLE public.inbound_ticket_messages
  ADD COLUMN IF NOT EXISTS linked_ticket_id uuid REFERENCES public.tickets(id),
  ADD COLUMN IF NOT EXISTS external_thread_id text,
  ADD COLUMN IF NOT EXISTS customer_display_name text,
  ADD COLUMN IF NOT EXISTS latest_buyer_message text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS queue_status text NOT NULL DEFAULT 'unread',
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
INSERT INTO public.inbound_ticket_messages(
  id, source, processing_status, shop_name, shop_id, order_transaction_id, webhook_received_at
) VALUES (
  '77777777-7777-4777-8777-777777777777', 'mercari_webhook', 'completed',
  'Shop1', 'shop-1', 'mercari-tx', now()
);
INSERT INTO public.inbound_ticket_messages(
  id, source, processing_status, shop_name, shop_id, order_transaction_id, webhook_received_at
) VALUES (
  '88888888-8888-4888-8888-888888888888', 'mercari_webhook', 'completed',
  'Shop1', 'shop-1', 'mercari-new-order', now()
);
INSERT INTO public.rakuten_rmesse_inquiries
  (account_id, inquiry_number, ticket_id, last_update_date)
VALUES
  ('99999999-9999-4999-8999-999999999999', 'rakuten-inquiry',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', now());
INSERT INTO public.sent_messages
  (id, ticket_id, platform, client_operation_id, body, reply_intent, delivery_status)
VALUES
  ('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'mercari', '11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'mercari body', 'holding', 'sending'),
  ('22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'rakuten', '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'rakuten body', 'holding', 'sending'),
  ('33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
   'amazon', '33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'amazon body', 'holding', 'sending');
SQL
"${psql_exec[@]}" -f /repo/supabase/migrations/20260909023000_mercari_queue_link_rpc.sql >/dev/null
"${psql_exec[@]}" <<'SQL'
SELECT public.link_mercari_inbound_message_to_ticket(
  '77777777-7777-4777-8777-777777777777',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'migration-test'
);
-- Idempotent replay must not add a second event.
SELECT public.link_mercari_inbound_message_to_ticket(
  '77777777-7777-4777-8777-777777777777',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'migration-test'
);
SELECT public.convert_mercari_inbound_message_to_ticket_v1(
  '88888888-8888-4888-8888-888888888888', NULL, NULL, 'high', NULL, ARRAY['delivery'], 'https://example.invalid/order', 'migration-test'
);
SELECT public.convert_mercari_inbound_message_to_ticket_v1(
  '88888888-8888-4888-8888-888888888888', NULL, NULL, 'high', NULL, ARRAY['delivery'], 'https://example.invalid/order', 'migration-test'
);
DO $$
BEGIN
  IF (SELECT linked_ticket_id FROM public.inbound_ticket_messages
      WHERE id = '77777777-7777-4777-8777-777777777777')
      <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid THEN
    RAISE EXCEPTION 'Mercari queue link did not commit';
  END IF;
  IF (SELECT count(*) FROM public.ticket_events
      WHERE idempotency_key = 'mercari_queue_link:77777777-7777-4777-8777-777777777777:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 1 THEN
    RAISE EXCEPTION 'Mercari queue link audit is not idempotent';
  END IF;
  IF (SELECT count(*) FROM public.tickets
      WHERE platform='mercari' AND account_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        AND external_order_id='mercari-new-order') <> 1
     OR (SELECT queue_status FROM public.inbound_ticket_messages
        WHERE id='88888888-8888-4888-8888-888888888888') <> 'converted' THEN
    RAISE EXCEPTION 'Mercari atomic conversion or replay failed';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('public',
      'public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Mercari queue link ACL mismatch';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.transition_mercari_queue_v1(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
      'public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text)', 'EXECUTE')
     OR has_function_privilege('public',
      'public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Mercari queue action ACL mismatch';
  END IF;
  IF (SELECT count(*) FROM public.count_mercari_queue_unread_v1(NULL)) <> 0 THEN
    RAISE EXCEPTION 'Mercari unread aggregate included a linked row';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.count_mercari_queue_unread_v1(text)', 'EXECUTE')
     OR has_function_privilege('public',
      'public.count_mercari_queue_unread_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Mercari unread aggregate ACL mismatch';
  END IF;
END $$;
SQL
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908182000_mercari_send_context.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908182100_rakuten_rmesse_send_context.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908182200_amazon_mail_isolated_persistence.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260909011500_amazon_mail_ingestion_v3.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260909024000_amazon_mail_queue_actions.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260908182300_amazon_spapi_send_context.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260829110000_rakuten_rmesse_order_qualified_ticket_creation.sql >/dev/null
"${psql_exec[@]}" <<'SQL'
ALTER TABLE public.inbound_ticket_messages
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS product_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS order_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS classification jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS full_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_ticket_messages_idempotency
  ON public.inbound_ticket_messages(idempotency_key);
SQL
"${psql_exec[@]}" -f /repo/supabase/migrations/20260909040000_platform_runtime_principals.sql >/dev/null
"${psql_exec[@]}" -f /repo/supabase/migrations/20260909041000_platform_runtime_ownership.sql >/dev/null
"${psql_exec[@]}" <<'SQL'
INSERT INTO public.platform_runtime_ownership(component,routing_generation,active_version_id,state,in_flight_count)
VALUES
  ('mercari-send','generation-1','version-mercari-send','active',0),
  ('mercari-ingestion','generation-1','version-mercari-ingestion','active',0),
  ('rakuten-send','generation-1','version-rakuten-send','active',0),
  ('rakuten-ingestion','generation-1','version-rakuten-ingestion','active',0),
  ('amazon-send','generation-1','version-amazon-send','active',0),
  ('amazon-ingestion','generation-1','version-amazon-ingestion','active',0);
INSERT INTO public.mercari_send_context
  (sent_message_id, transaction_id, message_ids_before_send)
VALUES ('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mercari-tx', '[]');
INSERT INTO public.rakuten_rmesse_send_context
  (sent_message_id, inquiry_number, reply_ids_before_send)
VALUES ('22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rakuten-inquiry', '[]');

DO $$
DECLARE
  v_roles text[] := ARRAY[
    'ticketing_mercari_send_runtime', 'ticketing_mercari_ingestion_runtime',
    'ticketing_rakuten_send_runtime', 'ticketing_rakuten_ingestion_runtime',
    'ticketing_amazon_send_runtime', 'ticketing_amazon_ingestion_runtime'
  ];
  v_probes text[] := ARRAY[
    'public.probe_mercari_send_runtime_v1()', 'public.probe_mercari_ingestion_runtime_v1()',
    'public.probe_rakuten_send_runtime_v1()', 'public.probe_rakuten_ingestion_runtime_v1()',
    'public.probe_amazon_send_runtime_v1()', 'public.probe_amazon_ingestion_runtime_v1()'
  ];
  i integer;
  j integer;
BEGIN
  IF NOT has_function_privilege('ticketing_mercari_send_runtime', 'public.get_mercari_send_ticket_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('ticketing_mercari_send_runtime', 'public.get_rakuten_send_ticket_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Mercari runtime function isolation failed';
  END IF;
  IF NOT has_function_privilege('ticketing_rakuten_send_runtime', 'public.get_rakuten_send_ticket_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('ticketing_rakuten_send_runtime', 'public.get_amazon_send_ticket_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Rakuten runtime function isolation failed';
  END IF;
  IF NOT has_function_privilege('ticketing_amazon_send_runtime', 'public.get_amazon_send_ticket_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('ticketing_amazon_send_runtime', 'public.get_mercari_send_ticket_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Amazon runtime function isolation failed';
  END IF;
  IF has_table_privilege('ticketing_mercari_send_runtime','public.sent_messages','DELETE')
     OR has_table_privilege('ticketing_rakuten_send_runtime','public.sent_messages','DELETE')
     OR has_table_privilege('ticketing_mercari_ingestion_runtime','public.sent_messages','SELECT')
     OR has_table_privilege('ticketing_rakuten_ingestion_runtime','public.sent_messages','SELECT')
     OR has_table_privilege('ticketing_amazon_ingestion_runtime','public.sent_messages','SELECT') THEN
    RAISE EXCEPTION 'send/ingestion table privilege separation failed';
  END IF;
  IF (to_regprocedure('public.claim_amazon_mail_send(uuid,uuid,text,text,text,uuid,text,timestamptz,text,text)') IS NOT NULL
       AND has_function_privilege('ticketing_amazon_ingestion_runtime','public.claim_amazon_mail_send(uuid,uuid,text,text,text,uuid,text,timestamptz,text,text)','EXECUTE'))
     OR (to_regprocedure('public.begin_amazon_mail_provider_mutation(uuid,uuid,bigint)') IS NOT NULL
       AND has_function_privilege('ticketing_amazon_ingestion_runtime','public.begin_amazon_mail_provider_mutation(uuid,uuid,bigint)','EXECUTE'))
     OR (to_regprocedure('public.finalize_amazon_mail_send(uuid,uuid,text,timestamptz,text)') IS NOT NULL
       AND has_function_privilege('ticketing_amazon_ingestion_runtime','public.finalize_amazon_mail_send(uuid,uuid,text,timestamptz,text)','EXECUTE')) THEN
    RAISE EXCEPTION 'Amazon ingestion role received legacy outbound capability';
  END IF;
  FOR i IN 1..array_length(v_roles, 1) LOOP
    FOR j IN 1..array_length(v_probes, 1) LOOP
      IF has_function_privilege(v_roles[i], v_probes[j], 'EXECUTE') IS DISTINCT FROM (i = j) THEN
        RAISE EXCEPTION 'runtime probe ACL matrix mismatch: role %, probe %', v_roles[i], v_probes[j];
      END IF;
    END LOOP;
  END LOOP;
END $$;
SET ROLE ticketing_mercari_send_runtime;
DO $$ BEGIN
  IF (public.probe_mercari_send_runtime_v1()->>'ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Mercari send capability probe did not validate runtime privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sent_messages WHERE platform <> 'mercari') THEN
    RAISE EXCEPTION 'Mercari send runtime can read another platform sent message';
  END IF;
  BEGIN
    PERFORM public.get_rakuten_send_ticket_v1('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    RAISE EXCEPTION 'Mercari send runtime executed Rakuten ticket projection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (public.assert_platform_runtime_owner_v1(
    'mercari-send','generation-1','version-mercari-send'
  )->>'active')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Mercari send runtime ownership assertion failed';
  END IF;
  BEGIN
    PERFORM public.assert_platform_runtime_owner_v1(
      'rakuten-ingestion','generation-1','version-rakuten-ingestion'
    );
    RAISE EXCEPTION 'Mercari send runtime asserted another component ownership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.acquire_platform_runtime_lease_v1(
    'mercari-send','generation-1','version-mercari-send',
    '77777777-7777-4777-8777-777777777777','work'
  ) OR NOT public.release_platform_runtime_lease_v1(
    '77777777-7777-4777-8777-777777777777'
  ) THEN RAISE EXCEPTION 'Mercari send runtime lease lifecycle failed'; END IF;
END $$;
RESET ROLE;
SET ROLE ticketing_rakuten_send_runtime;
DO $$ BEGIN
  IF (public.probe_rakuten_send_runtime_v1()->>'ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Rakuten send capability probe did not validate runtime privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sent_messages WHERE platform <> 'rakuten') THEN
    RAISE EXCEPTION 'Rakuten send runtime can read another platform sent message';
  END IF;
  BEGIN
    PERFORM public.get_mercari_send_ticket_v1('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    RAISE EXCEPTION 'Rakuten send runtime executed Mercari ticket projection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.acquire_platform_runtime_lease_v1(
    'rakuten-send','generation-1','version-rakuten-send',
    '77777777-7777-4777-8777-777777777778','work'
  ) OR NOT public.release_platform_runtime_lease_v1(
    '77777777-7777-4777-8777-777777777778'
  ) THEN RAISE EXCEPTION 'Rakuten send runtime lease lifecycle failed'; END IF;
END $$;
RESET ROLE;
SET ROLE ticketing_amazon_send_runtime;
DO $$ BEGIN
  IF (public.probe_amazon_send_runtime_v1()->>'ready')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Amazon send placeholder must remain unavailable';
  END IF;
  IF has_table_privilege(current_user,'public.sent_messages','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Amazon send placeholder received outbound table mutation capability';
  END IF;
  BEGIN
    PERFORM public.get_rakuten_send_ticket_v1('ffffffff-ffff-4fff-8fff-ffffffffffff');
    RAISE EXCEPTION 'Amazon send runtime executed Rakuten ticket projection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.acquire_platform_runtime_lease_v1(
    'amazon-send','generation-1','version-amazon-send',
    '77777777-7777-4777-8777-777777777779','work'
  ) OR NOT public.release_platform_runtime_lease_v1(
    '77777777-7777-4777-8777-777777777779'
  ) THEN RAISE EXCEPTION 'Amazon send runtime lease lifecycle failed'; END IF;
END $$;
RESET ROLE;
SET ROLE ticketing_mercari_ingestion_runtime;
DO $$ DECLARE v_first jsonb; v_second jsonb; BEGIN
  v_first := public.ingest_mercari_webhook_event_v1(
    'shop', 'shop-id', 'runtime-role-tx', now(), now(), 'runtime-role-webhook-1'
  );
  IF (v_first->>'inserted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Mercari runtime durable webhook insert did not insert';
  END IF;
  v_second := public.ingest_mercari_webhook_event_v1(
    'shop', 'shop-id', 'runtime-role-tx', now(), now(), 'runtime-role-webhook-1'
  );
  IF (v_second->>'inserted')::boolean IS TRUE THEN
    RAISE EXCEPTION 'Mercari runtime durable webhook replay was not idempotent';
  END IF;
  IF (public.probe_mercari_ingestion_runtime_v1()->>'ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Mercari ingestion capability probe did not validate runtime privileges';
  END IF;
  IF NOT public.acquire_platform_runtime_lease_v1(
    'mercari-ingestion','generation-1','version-mercari-ingestion',
    '77777777-7777-4777-8777-777777777782','work'
  ) OR NOT public.release_platform_runtime_lease_v1(
    '77777777-7777-4777-8777-777777777782'
  ) THEN RAISE EXCEPTION 'Mercari ingestion runtime active work lease lifecycle failed'; END IF;
END $$;
RESET ROLE;
SET ROLE ticketing_amazon_ingestion_runtime;
DO $$ BEGIN
  IF (public.probe_amazon_ingestion_runtime_v1()->>'ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Amazon ingestion capability probe did not validate runtime privileges';
  END IF;
  BEGIN
    PERFORM public.ingest_mercari_webhook_event_v1(
      'shop', 'shop-id', 'forbidden-amazon', now(), now(), 'runtime-cross-platform-amazon'
    );
    RAISE EXCEPTION 'Amazon runtime executed Mercari ingestion RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.acquire_platform_runtime_lease_v1(
    'amazon-ingestion','generation-1','version-amazon-ingestion',
    '77777777-7777-4777-8777-777777777780','work'
  ) OR NOT public.release_platform_runtime_lease_v1(
    '77777777-7777-4777-8777-777777777780'
  ) THEN RAISE EXCEPTION 'Amazon ingestion runtime lease lifecycle failed'; END IF;
END $$;
RESET ROLE;
INSERT INTO public.sent_messages (
  id, ticket_id, platform, client_operation_id, body, reply_intent, delivery_status
) VALUES (
  '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mercari',
  '33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'release body', 'holding', 'sending'
);
SET ROLE ticketing_mercari_send_runtime;
DO $$ BEGIN
  IF NOT public.release_mercari_operator_message_claim_v1(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'release body', 'holding'
  ) THEN RAISE EXCEPTION 'Mercari runtime failed to release its own claim'; END IF;
END $$;
RESET ROLE;
SET ROLE ticketing_runtime_deployer;
DO $$ BEGIN
  PERFORM public.prepare_platform_runtime_handoff_v1(
    'mercari-ingestion','version-mercari-ingestion','generation-2','checkpoint-1'
  );
END $$;
RESET ROLE;
SET ROLE ticketing_mercari_ingestion_runtime;
DO $$ BEGIN
  IF NOT public.acquire_platform_runtime_lease_v1(
    'mercari-ingestion','generation-1','version-mercari-ingestion',
    '88888888-8888-4888-8888-888888888881','intake'
  ) THEN RAISE EXCEPTION 'Mercari old-version intake was blocked while quiesced'; END IF;
  BEGIN
    PERFORM public.acquire_platform_runtime_lease_v1(
      'mercari-ingestion','generation-1','version-mercari-ingestion',
      '88888888-8888-4888-8888-888888888882','work'
    );
    RAISE EXCEPTION 'Mercari work lease was admitted while quiesced';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  PERFORM public.release_platform_runtime_lease_v1('88888888-8888-4888-8888-888888888881');
END $$;
RESET ROLE;
SET ROLE ticketing_runtime_deployer;
DO $$ DECLARE v_nonce uuid := '55555555-5555-4555-8555-555555555555'; BEGIN
  PERFORM public.begin_platform_runtime_transition_v1(
    'mercari-ingestion','generation-2','version-mercari-ingestion',
    'version-mercari-ingestion-next','generation-2','activate',v_nonce
  );
END $$;
RESET ROLE;
SET ROLE ticketing_mercari_ingestion_runtime;
DO $$ BEGIN
  IF NOT public.acquire_platform_runtime_lease_v1(
    'mercari-ingestion','generation-1','version-mercari-ingestion',
    '88888888-8888-4888-8888-888888888883','intake'
  ) THEN RAISE EXCEPTION 'Mercari old-version intake was blocked while activating'; END IF;
  PERFORM public.release_platform_runtime_lease_v1('88888888-8888-4888-8888-888888888883');
END $$;
RESET ROLE;
SET ROLE ticketing_runtime_deployer;
DO $$ DECLARE v_nonce uuid := '55555555-5555-4555-8555-555555555555'; BEGIN
  PERFORM public.finish_platform_runtime_transition_v1(
    'mercari-ingestion','generation-2','version-mercari-ingestion-next','generation-2',v_nonce
  );
  BEGIN
    PERFORM public.begin_platform_runtime_transition_v1(
      'mercari-ingestion','generation-2','version-mercari-ingestion',
      'stale-version','generation-3','activate','66666666-6666-4666-8666-666666666666'
    );
    RAISE EXCEPTION 'stale ownership CAS unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  PERFORM public.begin_platform_runtime_transition_v1(
    'mercari-ingestion','generation-2','version-mercari-ingestion-next',
    'version-mercari-ingestion','generation-1','rollback',
    '66666666-6666-4666-8666-666666666667'
  );
END $$;
RESET ROLE;
SET ROLE ticketing_mercari_ingestion_runtime;
DO $$ BEGIN
  IF NOT public.acquire_platform_runtime_lease_v1(
    'mercari-ingestion','generation-2','version-mercari-ingestion-next',
    '88888888-8888-4888-8888-888888888885','intake'
  ) THEN RAISE EXCEPTION 'Mercari intake was blocked while rolling back'; END IF;
  PERFORM public.release_platform_runtime_lease_v1('88888888-8888-4888-8888-888888888885');
END $$;
RESET ROLE;
SET ROLE ticketing_runtime_deployer;
DO $$ BEGIN
  IF NOT public.abort_platform_runtime_transition_v1(
    'mercari-ingestion','generation-2','version-mercari-ingestion-next',
    '66666666-6666-4666-8666-666666666667'
  ) THEN RAISE EXCEPTION 'Rollback abort did not restore active owner'; END IF;
  PERFORM public.reconcile_platform_runtime_restored_v1(
    'mercari-ingestion','version-mercari-ingestion-next',
    'version-mercari-ingestion','generation-1','cloudflare-readback:test-fixture'
  );
  PERFORM public.prepare_platform_runtime_handoff_v1(
    'rakuten-ingestion','version-rakuten-ingestion','generation-rakuten-abort','abort-test'
  );
  PERFORM public.begin_platform_runtime_transition_v1(
    'rakuten-ingestion','generation-rakuten-abort','version-rakuten-ingestion',
    'version-rakuten-next','generation-rakuten-abort','activate',
    '66666666-6666-4666-8666-666666666668'
  );
  IF NOT public.abort_platform_runtime_transition_v1(
    'rakuten-ingestion','generation-rakuten-abort','version-rakuten-ingestion',
    '66666666-6666-4666-8666-666666666668'
  ) THEN RAISE EXCEPTION 'Activation abort failed'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_runtime_ownership
    WHERE component='rakuten-ingestion' AND state='active'
      AND routing_generation='generation-1' AND active_version_id='version-rakuten-ingestion'
  ) THEN RAISE EXCEPTION 'Activation abort did not restore prior generation'; END IF;
END $$;
INSERT INTO public.platform_runtime_leases(
  lease_id,component,routing_generation,version_id,purpose,expires_at
) VALUES (
  '88888888-8888-4888-8888-888888888884','mercari-send','generation-1',
  'version-mercari-send','work',now()-interval '1 minute'
);
UPDATE public.platform_runtime_ownership SET in_flight_count=1 WHERE component='mercari-send';
SET ROLE ticketing_runtime_deployer;
DO $$ BEGIN
  IF NOT public.reap_expired_platform_runtime_lease_v1(
    'mercari-send','88888888-8888-4888-8888-888888888884',
    'version-mercari-send','worker-invocation-termination-confirmed:test-fixture'
  ) THEN RAISE EXCEPTION 'Explicit expired lease recovery failed'; END IF;
  PERFORM public.prepare_platform_runtime_handoff_v1(
    'mercari-send','version-mercari-send','generation-expiry','expired-lease-reaped'
  );
END $$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_runtime_leases WHERE lease_id='88888888-8888-4888-8888-888888888884') OR
     (SELECT in_flight_count FROM public.platform_runtime_ownership WHERE component='mercari-send') <> 0 THEN
    RAISE EXCEPTION 'Expired work lease was not reaped before handoff';
  END IF;
END $$;
SET ROLE ticketing_rakuten_ingestion_runtime;
DO $$ DECLARE v_state jsonb; BEGIN
  v_state := public.upsert_rakuten_rmesse_sync_state_v1(
    '99999999-9999-4999-8999-999999999999', now(), now()
  );
  IF v_state->>'account_id' <> '99999999-9999-4999-8999-999999999999' THEN
    RAISE EXCEPTION 'Rakuten runtime failed to persist checkpoint';
  END IF;
  IF (public.probe_rakuten_ingestion_runtime_v1()->>'ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Rakuten ingestion capability probe did not validate runtime privileges';
  END IF;
  BEGIN
    PERFORM public.ingest_mercari_webhook_event_v1(
      'shop', 'shop-id', 'forbidden', now(), now(), 'runtime-cross-platform'
    );
    RAISE EXCEPTION 'Rakuten runtime executed Mercari ingestion RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.acquire_platform_runtime_lease_v1(
    'rakuten-ingestion','generation-1','version-rakuten-ingestion',
    '77777777-7777-4777-8777-777777777781','work'
  ) OR NOT public.release_platform_runtime_lease_v1(
    '77777777-7777-4777-8777-777777777781'
  ) THEN RAISE EXCEPTION 'Rakuten ingestion runtime lease lifecycle failed'; END IF;
END $$;
RESET ROLE;
INSERT INTO public.amazon_mail_messages (
  id, account_id, ticket_id, provider_account_id, provider_folder_id, provider_message_id,
  provider_thread_id, external_order_id, body, source_received_at, mail_auth_status, review_status
) VALUES (
  '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'amazon-account', 'inbox', 'amazon-message', 'amazon-thread', 'amazon-order',
  'private customer body', '2026-09-08T00:00:00Z', 'pass', 'needs_review'
);
INSERT INTO public.amazon_mail_messages (
  id, account_id, provider_account_id, provider_folder_id, provider_message_id,
  source_received_at, mail_auth_status, review_status
) VALUES (
  '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'amazon-account', 'inbox',
  'amazon-untrusted-message', '2026-09-08T00:00:01Z', 'failed', 'untrusted_review'
);
SELECT public.transition_amazon_mail_queue_v1(
  '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'review', NULL, 'migration-test'
);
SELECT public.transition_amazon_mail_queue_v1(
  '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'review', NULL, 'migration-test'
);
SELECT public.transition_amazon_mail_queue_v1(
  '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ignore', NULL, 'migration-test'
);
DO $$
BEGIN
  IF (SELECT review_status FROM public.amazon_mail_messages
      WHERE id='44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 'reviewed' THEN
    RAISE EXCEPTION 'Amazon queue review transition did not commit';
  END IF;
  IF (SELECT review_status FROM public.amazon_mail_messages
      WHERE id='55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 'untrusted_review'
     OR (SELECT reviewed_at FROM public.amazon_mail_messages
      WHERE id='55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa') IS NULL
     OR (SELECT queue_status FROM public.amazon_mail_messages
      WHERE id='55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 'ignored' THEN
    RAISE EXCEPTION 'Amazon untrusted review/ignore violated minimization state';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.transition_amazon_mail_queue_v1(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('public',
      'public.transition_amazon_mail_queue_v1(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Amazon queue transition ACL mismatch';
  END IF;
  IF (public.count_amazon_mail_queue_unread_v1()->>'total')::integer <> 0 THEN
    RAISE EXCEPTION 'Amazon unread aggregate included a linked row';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.count_amazon_mail_queue_unread_v1()', 'EXECUTE')
     OR has_function_privilege('public',
      'public.count_amazon_mail_queue_unread_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Amazon unread aggregate ACL mismatch';
  END IF;
END $$;
SELECT public.create_amazon_spapi_send_context(
  '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'confirm_customization_details',
  'amazon-order', repeat('a', 64)
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.mercari_send_context
      (sent_message_id, transaction_id, message_ids_before_send)
    VALUES ('22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'wrong-platform', '[]');
    RAISE EXCEPTION 'cross-platform context insert unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;

  IF has_table_privilege('public', 'public.mercari_send_context', 'SELECT')
     OR has_table_privilege('public', 'public.rakuten_rmesse_send_context', 'SELECT')
     OR has_table_privilege('public', 'public.amazon_mail_messages', 'SELECT')
     OR has_table_privilege('public', 'public.amazon_spapi_send_context', 'SELECT') THEN
    RAISE EXCEPTION 'PUBLIC privilege leaked from isolated persistence';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.mercari_send_context', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.rakuten_rmesse_send_context', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.amazon_mail_messages', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.amazon_spapi_send_context', 'SELECT') THEN
    RAISE EXCEPTION 'service_role privilege missing from isolated persistence';
  END IF;
  IF has_table_privilege('service_role', 'public.mercari_send_context', 'INSERT,UPDATE')
     OR has_table_privilege('service_role', 'public.rakuten_rmesse_send_context', 'INSERT,UPDATE')
     OR has_table_privilege('service_role', 'public.amazon_mail_messages', 'INSERT,UPDATE')
     OR has_table_privilege('service_role', 'public.amazon_spapi_send_context', 'INSERT,UPDATE') THEN
    RAISE EXCEPTION 'service_role direct DML leaked from isolated persistence';
  END IF;
  IF has_table_privilege('anon', 'public.amazon_mail_messages', 'SELECT')
     OR has_table_privilege('authenticated', 'public.amazon_mail_messages', 'SELECT') THEN
    RAISE EXCEPTION 'application-role privilege leaked from Amazon evidence';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.rakuten_rmesse_send_context
      (sent_message_id, inquiry_number, reply_ids_before_send)
    VALUES ('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rakuten-inquiry', '[]');
    RAISE EXCEPTION 'wrong-platform Rakuten context unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    UPDATE public.amazon_spapi_send_context
    SET sent_message_id = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    WHERE sent_message_id = '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'wrong-platform Amazon context update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    UPDATE public.mercari_send_context SET transaction_id = 'other-order'
    WHERE sent_message_id = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'wrong Mercari transaction update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    UPDATE public.rakuten_rmesse_send_context SET inquiry_number = 'other-inquiry'
    WHERE sent_message_id = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'wrong Rakuten inquiry update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    UPDATE public.amazon_mail_messages
    SET ticket_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    WHERE id = '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'cross-platform Amazon evidence update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    INSERT INTO public.amazon_mail_messages (
      account_id, ticket_id, provider_account_id, provider_folder_id,
      provider_message_id, external_order_id, body, source_received_at,
      mail_auth_status, review_status
    ) VALUES (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      'amazon-account', 'inbox', 'wrong-order-message', 'other-order',
      'body', now(), 'pass', 'needs_review'
    );
    RAISE EXCEPTION 'same-account wrong-order evidence unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;

-- A folder move must replay the same Amazon provider message, not duplicate it.
SELECT public.ingest_amazon_mail_message_v2(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'amazon-account', 'archive', 'amazon-message', 'amazon-thread', 'amazon-order',
  'subject', 'private customer body', '2026-09-08T00:00:00Z', 'pass', NULL, 'needs_review', 0
);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.amazon_mail_messages
      WHERE provider_account_id = 'amazon-account' AND provider_message_id = 'amazon-message') <> 1 THEN
    RAISE EXCEPTION 'Amazon folder move duplicated evidence';
  END IF;
  IF (SELECT provider_folder_id FROM public.amazon_mail_messages
      WHERE provider_account_id = 'amazon-account' AND provider_message_id = 'amazon-message') <> 'archive' THEN
    RAISE EXCEPTION 'Amazon folder move did not update location';
  END IF;
END $$;

SELECT public.upsert_amazon_mail_sync_state_v2(
  'amazon-account', 'inbox', 0, '2026-09-08T00:00:00Z', 'm1',
  NULL, NULL, NULL, '2026-09-08T00:01:00Z', NULL, '{}'
);
SELECT public.upsert_amazon_mail_sync_state_v2(
  'amazon-account', 'archive', 0, '2026-09-08T00:00:00Z', 'm1',
  NULL, NULL, NULL, '2026-09-08T00:01:00Z', NULL, '{}'
);
DO $$
BEGIN
  BEGIN
    PERFORM public.upsert_amazon_mail_sync_state_v2(
      'amazon-account', 'inbox', 0, '2026-09-07T00:00:00Z', 'stale',
      NULL, NULL, NULL, now(), NULL, '{}'
    );
    RAISE EXCEPTION 'stale Amazon checkpoint unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  IF (SELECT count(*) FROM public.amazon_mail_sync_state_v2
      WHERE provider_account_id = 'amazon-account') <> 2 THEN
    RAISE EXCEPTION 'Amazon sync folders collided';
  END IF;
END $$;

CREATE TABLE public.amazon_mail_sync_state (
  provider_account_id text NOT NULL,
  provider_folder_id text NOT NULL,
  watermark_received_at timestamptz,
  watermark_message_id text,
  window_start timestamptz,
  run_to timestamptz,
  continuation text,
  last_success_at timestamptz,
  last_error_code text,
  last_run_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (provider_account_id, provider_folder_id)
);
INSERT INTO public.amazon_mail_sync_state (
  provider_account_id, provider_folder_id, watermark_received_at,
  watermark_message_id, window_start, run_to, continuation
) VALUES (
  'amazon-account', 'legacy-folder', '2026-09-05T00:00:00Z', 'legacy-m1',
  '2026-09-04T23:45:00Z', '2026-09-06T03:00:00Z', '{"segment_date":"2026-09-05"}'
);
DO $$
DECLARE seeded jsonb;
BEGIN
  SELECT public.seed_amazon_mail_sync_state_v2_from_legacy('amazon-account', 'legacy-folder') INTO seeded;
  IF seeded->>'source' <> 'legacy_seeded'
     OR seeded->>'watermark_message_id' <> 'legacy-m1'
     OR (seeded->>'generation')::bigint <> 1 THEN
    RAISE EXCEPTION 'legacy Amazon checkpoint was not seeded exactly';
  END IF;
  SELECT public.seed_amazon_mail_sync_state_v2_from_legacy('amazon-account', 'legacy-folder') INTO seeded;
  IF seeded->>'source' <> 'v2_existing' THEN
    RAISE EXCEPTION 'existing v2 checkpoint was not authoritative';
  END IF;
END $$;

INSERT INTO public.amazon_mail_sync_state (
  provider_account_id, provider_folder_id, window_start, run_to, continuation
) VALUES
  ('amazon-account', 'bad-json', '2026-09-04T00:00:00Z', '2026-09-06T00:00:00Z', '{bad'),
  ('amazon-account', 'null-segment', '2026-09-04T00:00:00Z', '2026-09-06T00:00:00Z', '{"segment_date":null}'),
  ('amazon-account', 'bad-date', '2026-09-04T00:00:00Z', '2026-09-06T00:00:00Z', '{"segment_date":"2026-99-99"}'),
  ('amazon-account', 'out-of-range', '2026-09-04T00:00:00Z', '2026-09-06T00:00:00Z', '{"segment_date":"2026-09-07"}'),
  ('amazon-account', 'reverse-window', '2026-09-05T20:00:00Z', '2026-09-05T10:00:00Z', '{"segment_date":"2026-09-05"}');
DO $$
DECLARE folder text;
BEGIN
  FOREACH folder IN ARRAY ARRAY['bad-json','null-segment','bad-date','out-of-range','reverse-window'] LOOP
    BEGIN
      PERFORM public.seed_amazon_mail_sync_state_v2_from_legacy('amazon-account', folder);
      RAISE EXCEPTION 'invalid legacy checkpoint unexpectedly seeded: %', folder;
    EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
    END;
    IF EXISTS (SELECT 1 FROM public.amazon_mail_sync_state_v2
        WHERE provider_account_id = 'amazon-account' AND provider_folder_id = folder) THEN
      RAISE EXCEPTION 'invalid legacy checkpoint left v2 state: %', folder;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM public.upsert_amazon_mail_sync_state_v2(
      'amazon-account', 'invalid-cas', 0, NULL, NULL,
      '2026-09-05T20:00:00Z', '2026-09-05T10:00:00Z',
      '{"segment_date":"2026-09-05"}', now(), NULL, '{}'
    );
    RAISE EXCEPTION 'invalid v2 CAS unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.amazon_mail_sync_state_v2
      WHERE provider_account_id = 'amazon-account' AND provider_folder_id = 'invalid-cas') THEN
    RAISE EXCEPTION 'invalid v2 CAS persisted state';
  END IF;
END $$;

ALTER TABLE public.amazon_mail_sync_state_v2 DISABLE TRIGGER trg_amazon_mail_sync_window;
INSERT INTO public.amazon_mail_sync_state_v2 (
  provider_account_id, provider_folder_id, window_start, run_to, continuation
) VALUES (
  'amazon-account', 'preexisting-invalid', '2026-09-05T20:00:00Z',
  '2026-09-05T10:00:00Z', '{"segment_date":"2026-09-05"}'
);
ALTER TABLE public.amazon_mail_sync_state_v2 ENABLE TRIGGER trg_amazon_mail_sync_window;
DO $$
BEGIN
  BEGIN
    PERFORM public.seed_amazon_mail_sync_state_v2_from_legacy('amazon-account', 'preexisting-invalid');
    RAISE EXCEPTION 'preexisting invalid v2 checkpoint unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;
DELETE FROM public.amazon_mail_sync_state_v2
WHERE provider_account_id = 'amazon-account' AND provider_folder_id = 'preexisting-invalid';

-- v3 ingestion must append one normalized customer message atomically, update
-- only its Amazon ticket, and report replay truthfully.
DO $$
DECLARE first_result jsonb; replay_result jsonb;
BEGIN
  UPDATE public.tickets SET external_order_id = '249-8835835-9935024'
  WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  SELECT public.ingest_amazon_mail_message_v3(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '249-8835835-9935024', 'new subject',
    'new private body', '2026-09-08T01:00:00Z', 'amazon-account', 'inbox',
    'amazon-message-v3', 'amazon-thread-v3', 'pass', 'amazon.co.jp', 0
  ) INTO first_result;
  SELECT public.ingest_amazon_mail_message_v3(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '249-8835835-9935024', 'new subject',
    'new private body', '2026-09-08T01:00:00Z', 'amazon-account', 'archive',
    'amazon-message-v3', 'amazon-thread-v3', 'pass', 'amazon.co.jp', 0
  ) INTO replay_result;
  IF (first_result->>'evidence_inserted')::boolean IS NOT TRUE
     OR (first_result->>'ticket_message_inserted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'first Amazon v3 ingest did not report inserts';
  END IF;
  IF (replay_result->>'evidence_inserted')::boolean IS NOT FALSE
     OR (replay_result->>'ticket_message_inserted')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Amazon v3 replay metrics are not truthful';
  END IF;
  IF (SELECT count(*) FROM public.ticket_messages
      WHERE platform = 'amazon' AND external_message_id = 'zoho:amazon-account:amazon-message-v3') <> 1 THEN
    RAISE EXCEPTION 'Amazon v3 replay duplicated normalized message';
  END IF;
  IF (SELECT latest_customer_message FROM public.tickets
      WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff') <> 'new private body' THEN
    RAISE EXCEPTION 'Amazon v3 ingest did not update authoritative ticket';
  END IF;
  IF (SELECT latest_customer_message FROM public.tickets
      WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') IS NOT NULL THEN
    RAISE EXCEPTION 'Amazon v3 ingest mutated Mercari ticket';
  END IF;
END $$;

DO $$
DECLARE promoted jsonb;
BEGIN
  PERFORM public.ingest_amazon_mail_message_v3(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '249-8835835-9935024', 'hidden',
    'hidden', '2026-09-08T02:00:00Z', 'amazon-account', 'inbox',
    'amazon-auth-promotion', 'amazon-thread-v3', 'unavailable', NULL, 2
  );
  IF EXISTS (SELECT 1 FROM public.amazon_mail_messages
      WHERE provider_message_id = 'amazon-auth-promotion'
        AND (body IS NOT NULL OR external_order_id IS NOT NULL OR attachment_count <> 0)) THEN
    RAISE EXCEPTION 'untrusted Amazon evidence was not minimized';
  END IF;
  SELECT public.ingest_amazon_mail_message_v3(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '249-8835835-9935024', 'promoted subject',
    'promoted body', '2026-09-08T02:00:00Z', 'amazon-account', 'archive',
    'amazon-auth-promotion', 'amazon-thread-v3', 'pass', 'amazon.co.jp', 0
  ) INTO promoted;
  IF promoted->>'binding_state' <> 'linked_existing_ticket'
     OR (promoted->>'ticket_message_inserted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Amazon authentication promotion did not project atomically';
  END IF;
  BEGIN
    PERFORM public.ingest_amazon_mail_message_v3(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '249-8835835-9935024', 'promoted subject',
      'promoted body', '2026-09-08T02:00:00Z', 'amazon-account', 'archive',
      'amazon-auth-promotion', 'different-thread', 'pass', 'amazon.co.jp', 0
    );
    RAISE EXCEPTION 'Amazon thread replay mismatch unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    PERFORM public.ingest_amazon_mail_message_v3(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', NULL, NULL, NULL,
      '2026-09-08T02:00:00Z', 'amazon-account', 'archive',
      'amazon-auth-promotion', 'amazon-thread-v3', 'failed', NULL, 0
    );
    RAISE EXCEPTION 'Amazon trusted evidence downgrade unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;

DO $$
BEGIN
  UPDATE public.tickets SET latest_message_at = '2026-09-08T04:00:00Z',
    latest_customer_message = 'newer message', needs_reply = false, status = 'resolved'
  WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  PERFORM public.ingest_amazon_mail_message_v3(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '249-8835835-9935024', 'older',
    'older body', '2026-09-08T03:00:00Z', 'amazon-account', 'inbox',
    'amazon-older-backfill', 'amazon-thread-v3', 'pass', 'amazon.co.jp', 0
  );
  IF EXISTS (SELECT 1 FROM public.tickets
      WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
        AND (latest_customer_message <> 'newer message' OR needs_reply OR status <> 'resolved')) THEN
    RAISE EXCEPTION 'older Amazon backfill regressed ticket state';
  END IF;
  IF (SELECT latest_customer_message FROM public.tickets
      WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') IS NOT NULL THEN
    RAISE EXCEPTION 'Amazon v3 ingest mutated Rakuten ticket';
  END IF;
END $$;
SQL

# Prove each WP3 target installs and replays without either other platform target.
for target in mercari rakuten amazon_ingestion amazon_spapi_send; do
  database="wp3_${target}"
  docker exec "$CONTAINER" createdb -U postgres "$database"
  "${psql_exec[@]}" -d "$database" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.platform_accounts (id uuid PRIMARY KEY, platform text NOT NULL);
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  account_id uuid,
  external_order_id text,
  external_thread_id text,
  latest_message_at timestamptz,
  latest_customer_message text,
  needs_reply boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.sent_messages (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  platform text NOT NULL
);
CREATE TABLE public.rakuten_rmesse_inquiries (
  account_id uuid NOT NULL,
  inquiry_number text NOT NULL,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  last_update_date timestamptz NOT NULL,
  PRIMARY KEY (account_id, inquiry_number)
);
CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  platform text NOT NULL,
  external_message_id text,
  sender_type text,
  body text,
  sent_at timestamptz,
  raw_payload jsonb
);
CREATE UNIQUE INDEX uq_ticket_messages_platform_external
  ON public.ticket_messages(platform, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE TABLE public.ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id),
  event_type text,
  actor_type text,
  actor_id text,
  payload jsonb,
  idempotency_key text
);
CREATE UNIQUE INDEX uq_ticket_events_idempotency_key
  ON public.ticket_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
SQL
  case "$target" in
    mercari) migration="20260908182000_mercari_send_context.sql" ;;
    rakuten) migration="20260908182100_rakuten_rmesse_send_context.sql" ;;
    amazon_ingestion) migration="20260908182200_amazon_mail_isolated_persistence.sql" ;;
    amazon_spapi_send) migration="20260908182300_amazon_spapi_send_context.sql" ;;
  esac
  "${psql_exec[@]}" -d "$database" -f "/repo/supabase/migrations/$migration" >/dev/null
  "${psql_exec[@]}" -d "$database" -f "/repo/supabase/migrations/$migration" >/dev/null
  if [[ "$target" == "amazon_ingestion" ]]; then
    "${psql_exec[@]}" -d "$database" -f /repo/supabase/migrations/20260909011500_amazon_mail_ingestion_v3.sql >/dev/null
    "${psql_exec[@]}" -d "$database" -f /repo/supabase/migrations/20260909011500_amazon_mail_ingestion_v3.sql >/dev/null
    "${psql_exec[@]}" -d "$database" -f /repo/supabase/migrations/20260909024000_amazon_mail_queue_actions.sql >/dev/null
    "${psql_exec[@]}" -d "$database" -f /repo/supabase/migrations/20260909024000_amazon_mail_queue_actions.sql >/dev/null
  fi
  objects="$("${psql_exec[@]}" -d "$database" -Atc \
    "SELECT concat_ws(',', to_regclass('public.mercari_send_context'), to_regclass('public.rakuten_rmesse_send_context'), to_regclass('public.amazon_mail_messages'), to_regclass('public.amazon_spapi_send_context'))")"
  case "$target:$objects" in
    mercari:mercari_send_context|rakuten:rakuten_rmesse_send_context|amazon_ingestion:amazon_mail_messages|amazon_spapi_send:amazon_spapi_send_context) ;;
    *) echo "WP3 independent install leaked objects for $target: $objects" >&2; exit 1 ;;
  esac
done

echo "Disposable PostgreSQL platform-isolation migration test passed"
