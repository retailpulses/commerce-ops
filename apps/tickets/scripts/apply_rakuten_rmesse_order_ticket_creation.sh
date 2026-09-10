#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS=(
  "$ROOT_DIR/supabase/migrations/20260829110000_rakuten_rmesse_order_qualified_ticket_creation.sql"
  "$ROOT_DIR/supabase/migrations/20260830090000_rakuten_rmesse_attachment_evidence.sql"
  "$ROOT_DIR/supabase/migrations/20260901023000_rakuten_rmesse_pgcrypto_search_path.sql"
)
PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
APPROVED_SHA="${SUPABASE_MIGRATION_APPROVED_SHA:-}"
RELEASE_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" || -z "$PROJECT_REF" ]]; then
  echo "Supabase access token and project ref are required" >&2
  exit 1
fi
if [[ -z "$APPROVED_SHA" || "$APPROVED_SHA" != "$RELEASE_SHA" ]]; then
  echo "Hosted migration is not approved for release SHA $RELEASE_SHA" >&2
  exit 1
fi
QUERY_URL="https://api.supabase.com/v1/projects/$PROJECT_REF/database/query"
for migration in "${MIGRATIONS[@]}"; do
  if [[ ! -f "$migration" ]]; then
    echo "Approved R-Messe migration file is missing: $(basename "$migration")" >&2
    exit 1
  fi
  payload="$(jq -n --rawfile query "$migration" '{query: $query}')"
  curl --fail-with-body --silent --show-error \
    --request POST "$QUERY_URL" \
    --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$payload" >/dev/null
done

verify_payload="$(jq -n --arg query "
  SELECT position('rakuten_ticket_create_conflict_unresolved' in
    pg_get_functiondef('public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb)'::regprocedure)
  ) > 0 AND position('attachments_inserted' in
    pg_get_functiondef('public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb)'::regprocedure)
  ) > 0 AS installed,
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ingest_rakuten_rmesse_inquiry'
      AND array_to_string(COALESCE(p.proconfig, ARRAY[]::text[]), ',')
          LIKE '%search_path=public, extensions%'
  ) AS pgcrypto_search_path_installed
" '{query: $query}')"
verify_response="$(curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$verify_payload")"
if [[ "$(jq -r '.[0].installed // false' <<<"$verify_response")" != "true" ]] ||
   [[ "$(jq -r '.[0].pgcrypto_search_path_installed // false' <<<"$verify_response")" != "true" ]]; then
  echo "R-Messe migration verification failed" >&2
  exit 1
fi
echo "R-Messe order, attachment-evidence, and pgcrypto search-path migrations installed and verified"
