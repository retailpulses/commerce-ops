#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260908180000_mercari_inbound_retry_source_fence.sql"
SEND_FENCE_MIGRATION="$ROOT_DIR/supabase/migrations/20260908180500_platform_send_finalize_fence.sql"
COMPAT_MIGRATION="$ROOT_DIR/supabase/migrations/20260908181000_amazon_mercari_constraint_compatibility.sql"
QUEUE_LINK_MIGRATION="$ROOT_DIR/supabase/migrations/20260909023000_mercari_queue_link_rpc.sql"
PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
APPROVED_SHA="${SUPABASE_MIGRATION_APPROVED_SHA:-}"
RELEASE_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" || -z "$PROJECT_REF" ]]; then
  echo "Supabase access token and project ref are required" >&2
  exit 1
fi
if [[ -z "$APPROVED_SHA" || "$APPROVED_SHA" != "$RELEASE_SHA" ]]; then
  echo "Mercari source-fence migration is not approved for release SHA $RELEASE_SHA" >&2
  exit 1
fi
if [[ "${SUPABASE_BACKUP_VERIFIED:-}" != "true" && "${SUPABASE_BACKUP_VERIFIED:-}" != "yes" ]]; then
  echo "A current backup/PITR verification is required" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Approved Mercari source-fence migration file is missing" >&2
  exit 1
fi

QUERY_URL="https://api.supabase.com/v1/projects/$PROJECT_REF/database/query"
payload="$(jq -n --rawfile query "$MIGRATION" '{query: $query}')"
curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$payload" >/dev/null
send_payload="$(jq -n --rawfile query "$SEND_FENCE_MIGRATION" '{query: $query}')"
curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$send_payload" >/dev/null
queue_link_payload="$(jq -n --rawfile query "$QUEUE_LINK_MIGRATION" '{query: $query}')"
curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$queue_link_payload" >/dev/null

# M0 branch: only apply the forward compatibility repair when Amazon's schema
# is authoritatively present. The Mercari RPC remains independently installable.
amazon_probe="$(jq -n --arg query "
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inbound_ticket_messages'
      AND column_name = 'source_received_at'
  ) AS installed
" '{query: $query}')"
amazon_state="$(curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$amazon_probe")"
if [[ "$(jq -r '.[0].installed // false' <<<"$amazon_state")" == "true" ]]; then
  compat_payload="$(jq -n --rawfile query "$COMPAT_MIGRATION" '{query: $query}')"
  curl --fail-with-body --silent --show-error \
    --request POST "$QUERY_URL" \
    --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$compat_payload" >/dev/null
fi

verify_payload="$(jq -n --arg query "
  SELECT
    position('source = ''mercari_webhook''' in pg_get_functiondef(
      'public.claim_pending_mercari_webhook_messages(integer)'::regprocedure
    )) > 0 AS source_scoped,
    position('FOR UPDATE SKIP LOCKED' in pg_get_functiondef(
      'public.claim_pending_mercari_webhook_messages(integer)'::regprocedure
    )) > 0 AS concurrency_safe,
    position('COALESCE(claim_limit, 10)' in pg_get_functiondef(
      'public.claim_pending_mercari_webhook_messages(integer)'::regprocedure
    )) > 0 AS null_bounded,
    position('v_ticket.account_id IS DISTINCT FROM v_account_id' in pg_get_functiondef(
      'public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)'::regprocedure
    )) > 0
      AND position('v_ticket.external_order_id IS DISTINCT FROM v_message.order_transaction_id' in pg_get_functiondef(
      'public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)'::regprocedure
    )) > 0 AS queue_link_fenced,
    has_function_privilege('service_role',
      'public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)', 'EXECUTE')
      AND NOT has_function_privilege('public',
      'public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)', 'EXECUTE') AS queue_link_acl_safe
" '{query: $query}')"
verify_response="$(curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$verify_payload")"

if [[ "$(jq -r 'length' <<<"$verify_response")" != "1" ]] ||
   [[ "$(jq -r '.[0].source_scoped // false' <<<"$verify_response")" != "true" ]] ||
   [[ "$(jq -r '.[0].concurrency_safe // false' <<<"$verify_response")" != "true" ]] ||
   [[ "$(jq -r '.[0].null_bounded // false' <<<"$verify_response")" != "true" ]] ||
   [[ "$(jq -r '.[0].queue_link_fenced // false' <<<"$verify_response")" != "true" ]] ||
   [[ "$(jq -r '.[0].queue_link_acl_safe // false' <<<"$verify_response")" != "true" ]]; then
  echo "Mercari source-fence authoritative verification failed" >&2
  exit 1
fi

echo "Mercari ingestion source fence installed and verified for release $RELEASE_SHA"
