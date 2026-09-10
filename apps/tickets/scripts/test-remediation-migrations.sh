#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="ticket-remediation-migrations-${RANDOM}-${RANDOM}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
POSTGRES_PASSWORD="migration-contract-only"
DB_NAME="migration_contract"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$CONTAINER" \
  --env POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --env POSTGRES_DB="$DB_NAME" \
  --volume "$ROOT_DIR:/repo:ro" \
  "$POSTGRES_IMAGE" >/dev/null

# The official image starts a temporary server while initializing the fresh
# data directory, then stops it and launches the final server. pg_isready can
# briefly succeed against that temporary server, so wait for both ready events.
for _ in $(seq 1 60); do
  ready_events="$(docker logs "$CONTAINER" 2>&1 | grep -c "database system is ready to accept connections" || true)"
  if [[ "$ready_events" -ge 2 ]] && \
     docker exec "$CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1 && \
     docker exec "$CONTAINER" psql -U postgres -d "$DB_NAME" -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
[[ "${ready_events:-0}" -ge 2 ]]
docker exec "$CONTAINER" psql -U postgres -d "$DB_NAME" -c "SELECT 1" >/dev/null

psql_file() {
  docker exec --env PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" psql \
    --username postgres \
    --dbname "$DB_NAME" \
    --set ON_ERROR_STOP=1 \
    --file "$1"
}

psql_sql() {
  docker exec --env PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" psql \
    --username postgres \
    --dbname "$DB_NAME" \
    --set ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command "$1"
}

psql_file /repo/supabase/tests/remediation_migrations_bootstrap.sql >/dev/null

for migration in "$ROOT_DIR"/supabase/migrations/2026071500000{0,1,2,3}_*.sql; do
  psql_file "/repo/${migration#"$ROOT_DIR"/}" >/dev/null
done

# Reproduce the hosted retirement-import shape: one physical R2 object was
# discovered from both a ticket row and its form row. The resolution migration
# must consolidate those references without losing either provenance record.
psql_sql "
  INSERT INTO public.tickets (id, platform, origin) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mercari', 'migrated_baserow');
  INSERT INTO public.customer_submissions (id, ticket_id) VALUES
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  INSERT INTO public.ticket_attachments (
    id, ticket_id, customer_submission_id, storage_bucket, storage_path,
    original_url, filename, mime_type, media_type, size_bytes, source,
    metadata, legacy_baserow_file_key
  ) VALUES
    (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL,
      'r2:ticketing-legacy-evidence', 'legacy/shared-proof.mp4',
      'https://legacy.invalid/shared-proof.mp4', 'shared-proof.mp4',
      'video/mp4', 'video', 55509035, 'imported_baserow',
      '{\"legacy_table\":\"tickets\",\"legacy_row_id\":6898}',
      'tickets:6898:shared'
    ),
    (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'r2:ticketing-legacy-evidence', 'legacy/shared-proof.mp4',
      'https://legacy.invalid/shared-proof.mp4', 'shared-proof.mp4',
      'video/mp4', 'video', 55509035, 'imported_baserow',
      '{\"legacy_table\":\"forms\",\"legacy_row_id\":1552}',
      'forms:1552:shared'
    );
" >/dev/null

for migration in "$ROOT_DIR"/supabase/migrations/2026071500000{4,5}_*.sql; do
  psql_file "/repo/${migration#"$ROOT_DIR"/}" >/dev/null
done

legacy_consolidation_state="$(psql_sql "
  SELECT count(*) || ':' ||
         count(*) FILTER (WHERE customer_submission_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') || ':' ||
         max(jsonb_array_length(metadata->'consolidated_legacy_provenance'))
  FROM public.ticket_attachments
  WHERE storage_bucket = 'r2:ticketing-legacy-evidence'
    AND storage_path = 'legacy/shared-proof.mp4';
")"
if [[ "$legacy_consolidation_state" != "1:1:2" ]]; then
  echo "unexpected legacy attachment consolidation: $legacy_consolidation_state" >&2
  exit 1
fi
echo "Legacy attachment provenance consolidation passed"

# Reapplication is part of the contract: every remediation migration must be
# safe after an interrupted deploy or an already-repaired environment.
for migration in "$ROOT_DIR"/supabase/migrations/2026071500000{0,1,2,3,4,5}_*.sql; do
  psql_file "/repo/${migration#"$ROOT_DIR"/}" >/dev/null
done

# The additive seller-share migration is intentionally applied once: unlike
# remediation migrations it creates new tables and is not a replay migration.
psql_file /repo/supabase/migrations/20260716010000_ticket_shares.sql >/dev/null

psql_sql "
  DO \$\$
  DECLARE
    share public.ticket_share_tokens%ROWTYPE;
    evidence_id uuid;
  BEGIN
    SELECT id INTO evidence_id
    FROM public.ticket_attachments
    WHERE storage_path = 'legacy/shared-proof.mp4';
    SELECT * INTO share FROM public.create_ticket_share(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repeat('a', 64),
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      'operator-hash',
      '{\"version\":1,\"seller_description\":\"Reviewed seller summary\"}'::jsonb,
      ARRAY[evidence_id],
      false
    );
    IF abs(extract(epoch FROM ((share.expires_at - share.created_at) - interval '7 days'))) > 0.01 THEN
      RAISE EXCEPTION 'seller share lifetime is not exactly 168 hours';
    END IF;
    PERFORM * FROM public.resolve_ticket_share(repeat('a', 64));
    IF (SELECT access_count FROM public.ticket_share_tokens WHERE id = share.id) <> 1 THEN
      RAISE EXCEPTION 'seller share access telemetry was not incremented';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.authorize_ticket_share_attachment(
        repeat('a', 64), evidence_id
      )
    ) THEN
      RAISE EXCEPTION 'selected seller evidence was not authorized';
    END IF;
    PERFORM * FROM public.create_ticket_share(
      '12121212-1212-4212-8212-121212121212',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repeat('b', 64),
      '13131313-1313-4313-8313-131313131313',
      'operator-hash',
      '{\"version\":1,\"seller_description\":\"Rotated seller summary\"}'::jsonb,
      ARRAY[]::uuid[],
      true
    );
    IF EXISTS (SELECT 1 FROM public.resolve_ticket_share(repeat('a', 64))) THEN
      RAISE EXCEPTION 'rotated seller token still resolves';
    END IF;
    PERFORM * FROM public.revoke_ticket_share(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '12121212-1212-4212-8212-121212121212',
      'operator-hash'
    );
    IF EXISTS (SELECT 1 FROM public.resolve_ticket_share(repeat('b', 64))) THEN
      RAISE EXCEPTION 'revoked seller token still resolves';
    END IF;
  END
  \$\$;
" >/dev/null
echo "Seller share migration lifecycle passed"

run_share_create() {
  local token_id="$1"
  local token_hash="$2"
  local operation_id="$3"
  docker exec --env PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" psql \
    --username postgres \
    --dbname "$DB_NAME" \
    --set ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command "SELECT id FROM public.create_ticket_share(
      '$token_id',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '$token_hash',
      '$operation_id',
      'operator-hash',
      '{\"version\":1,\"seller_description\":\"Concurrent seller summary\"}'::jsonb,
      ARRAY[]::uuid[],
      false
    );"
}

run_share_create \
  '14141414-1414-4414-8414-141414141414' "$(printf 'c%.0s' {1..64})" \
  '15151515-1515-4515-8515-151515151515' >"/tmp/${CONTAINER}-share-a.out" 2>&1 &
share_pid_a=$!
run_share_create \
  '16161616-1616-4616-8616-161616161616' "$(printf 'd%.0s' {1..64})" \
  '17171717-1717-4717-8717-171717171717' >"/tmp/${CONTAINER}-share-b.out" 2>&1 &
share_pid_b=$!
wait "$share_pid_a"
wait "$share_pid_b"
rm -f "/tmp/${CONTAINER}-share-a.out" "/tmp/${CONTAINER}-share-b.out"

seller_share_active_count="$(psql_sql "
  SELECT count(*)
  FROM public.ticket_share_tokens
  WHERE ticket_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    AND status = 'active';
")"
if [[ "$seller_share_active_count" != "1" ]]; then
  echo "expected exactly one active seller share after concurrent creation" >&2
  exit 1
fi
echo "Concurrent seller share creation passed"

psql_file /repo/supabase/tests/remediation_migrations_contract.sql

# Two requests race on one active token with different submission IDs. The row
# lock must serialize them: exactly one commits and the other reports mismatch.
psql_sql "
  INSERT INTO public.submission_tokens (
    id, token_hash, platform, external_order_id, status, expires_at, max_upload_count
  ) VALUES (
    '77777777-7777-4777-8777-777777777777', 'token-concurrent', 'mercari',
    'ORDER-CONCURRENT', 'active', now() + interval '1 day', 5
  );
  INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
    ('ticket-attachments', 'customer-submissions/88888888-8888-4888-8888-888888888888/a.mp4', '{\"size\":\"104857600\",\"mimetype\":\"video/mp4\"}'),
    ('ticket-attachments', 'customer-submissions/99999999-9999-4999-8999-999999999999/b.mp4', '{\"size\":\"104857600\",\"mimetype\":\"video/mp4\"}');
" >/dev/null

run_finalize() {
  local submission_id="$1"
  local filename="$2"
  docker exec --env PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" psql \
    --username postgres \
    --dbname "$DB_NAME" \
    --set ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command "SELECT created_ticket, replayed FROM public.finalize_ticketform_submission(
      '77777777-7777-4777-8777-777777777777',
      '$submission_id',
      'Concurrent video evidence',
      NULL,
      '[{\"storage_bucket\":\"ticket-attachments\",\"storage_path\":\"customer-submissions/$submission_id/$filename\",\"filename\":\"$filename\",\"mime_type\":\"video/mp4\",\"media_type\":\"video\",\"size_bytes\":104857600}]'::jsonb
    );"
}

set +e
run_finalize '88888888-8888-4888-8888-888888888888' 'a.mp4' >"/tmp/${CONTAINER}-a.out" 2>&1 &
pid_a=$!
run_finalize '99999999-9999-4999-8999-999999999999' 'b.mp4' >"/tmp/${CONTAINER}-b.out" 2>&1 &
pid_b=$!
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e

outputs="$(cat "/tmp/${CONTAINER}-a.out" "/tmp/${CONTAINER}-b.out")"
rm -f "/tmp/${CONTAINER}-a.out" "/tmp/${CONTAINER}-b.out"

if [[ $((status_a == 0 ? 1 : 0)) -eq $((status_b == 0 ? 1 : 0)) ]]; then
  echo "$outputs" >&2
  echo "expected exactly one concurrent finalization to succeed" >&2
  exit 1
fi
if [[ "$outputs" != *"submission_already_finalized_by_another_request"* ]]; then
  echo "$outputs" >&2
  echo "concurrent loser did not report the expected submission mismatch" >&2
  exit 1
fi

concurrent_state="$(psql_sql "
  SELECT used_count || ':' ||
         (SELECT count(*) FROM public.customer_submissions cs WHERE cs.raw_payload->>'submission_token_id' = '77777777-7777-4777-8777-777777777777') || ':' ||
         (SELECT count(*) FROM public.tickets t WHERE t.external_order_id = 'ORDER-CONCURRENT')
  FROM public.submission_tokens
  WHERE id = '77777777-7777-4777-8777-777777777777';
")"
if [[ "$concurrent_state" != "1:1:1" ]]; then
  echo "unexpected concurrent finalization state: $concurrent_state" >&2
  exit 1
fi

echo "Concurrent TicketForm finalization passed"

# Validate the exact order-qualified R-Messe migration against PostgreSQL,
# including replay safety and one-ticket-per-order behavior.
psql_sql "
  DROP INDEX public.idx_tickets_platform_order;
  CREATE UNIQUE INDEX idx_tickets_platform_order
    ON public.tickets (
      platform,
      COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
      external_order_id
    )
    WHERE external_order_id IS NOT NULL AND origin <> 'migrated_baserow';
  CREATE UNIQUE INDEX uq_ticket_messages_platform_external
    ON public.ticket_messages(platform, external_message_id)
    WHERE external_message_id IS NOT NULL;
  CREATE TABLE public.rakuten_rmesse_inquiries (
    account_id uuid NOT NULL REFERENCES public.platform_accounts(id),
    inquiry_number text NOT NULL,
    shop_id text NOT NULL,
    order_number text NOT NULL,
    ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    last_update_date timestamptz NOT NULL,
    last_ingested_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, inquiry_number),
    CONSTRAINT rakuten_rmesse_order_required CHECK (btrim(order_number) <> '')
  );
  INSERT INTO public.platform_accounts(id, display_name)
  VALUES ('12121212-1212-4212-8212-121212121212', 'Rakuten test');
" >/dev/null
psql_file /repo/supabase/migrations/20260829110000_rakuten_rmesse_order_qualified_ticket_creation.sql >/dev/null
psql_file /repo/supabase/migrations/20260830090000_rakuten_rmesse_attachment_evidence.sql >/dev/null
psql_file /repo/supabase/migrations/20260901023000_rakuten_rmesse_pgcrypto_search_path.sql >/dev/null

first_rmesse_result="$(psql_sql "
  SELECT public.ingest_rakuten_rmesse_inquiry(
    '12121212-1212-4212-8212-121212121212', '440058', 'INQ-1', 'ORDER-R-1',
    'https://rmesse.example/INQ-1', 'Delivery', '2026-08-29T10:00:00Z',
    '[{\"external_message_id\":\"rakuten:INQ-1:initial\",\"sender_type\":\"system\",\"body\":\"initial\",\"sent_at\":\"2026-08-29T09:00:00Z\"},{\"external_message_id\":\"rakuten:INQ-1:reply:1\",\"sender_type\":\"customer\",\"body\":\"reply\",\"sent_at\":\"2026-08-29T10:00:00Z\",\"attachments\":[{\"label\":\"proof.jpeg\",\"path\":\"2026/08/29/proof\",\"mime_type\":\"image/jpeg\"}]}]'::jsonb
  );
")"
[[ "$first_rmesse_result" == *'"ticket_created": true'* ]]
[[ "$first_rmesse_result" == *'"messages_inserted": 2'* ]]
[[ "$first_rmesse_result" == *'"attachments_inserted": 1'* ]]

replay_rmesse_result="$(psql_sql "
  SELECT public.ingest_rakuten_rmesse_inquiry(
    '12121212-1212-4212-8212-121212121212', '440058', 'INQ-1', 'ORDER-R-1',
    'https://rmesse.example/INQ-1', 'Delivery', '2026-08-29T10:00:00Z',
    '[{\"external_message_id\":\"rakuten:INQ-1:reply:1\",\"sender_type\":\"customer\",\"body\":\"reply\",\"sent_at\":\"2026-08-29T10:00:00Z\"}]'::jsonb
  );
")"
[[ "$replay_rmesse_result" == *'"ticket_created": false'* ]]
[[ "$replay_rmesse_result" == *'"messages_inserted": 0'* ]]

psql_sql "
  SELECT public.ingest_rakuten_rmesse_inquiry(
    '12121212-1212-4212-8212-121212121212', '440058', 'INQ-2', 'ORDER-R-1',
    'https://rmesse.example/INQ-2', 'Delivery', '2026-08-29T11:00:00Z', '[]'::jsonb
  );
" >/dev/null
rmesse_state="$(psql_sql "
  SELECT count(*) || ':' || max(external_thread_id) || ':' || bool_and(needs_reply)
  FROM public.tickets
  WHERE platform = 'rakuten' AND external_order_id = 'ORDER-R-1';
")"
[[ "$rmesse_state" == "1:INQ-2:true" ]]

if psql_sql "
  SELECT public.ingest_rakuten_rmesse_inquiry(
    '12121212-1212-4212-8212-121212121212', '440058', 'INQ-PRE', '',
    NULL, NULL, now(), '[]'::jsonb
  );
" >/dev/null 2>&1; then
  echo "R-Messe ingest accepted an inquiry without an order number" >&2
  exit 1
fi
echo "Order-qualified R-Messe ticket creation passed"
echo "All remediation migration integration tests passed"
