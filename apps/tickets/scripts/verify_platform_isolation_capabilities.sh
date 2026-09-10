#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" || -z "$PROJECT_REF" ]]; then
  echo "Supabase access token and project ref are required" >&2
  exit 1
fi

QUERY_URL="https://api.supabase.com/v1/projects/$PROJECT_REF/database/query"
verify_payload="$(jq -n --arg query "
  SELECT
    to_regprocedure('public.claim_pending_mercari_webhook_messages(integer)') IS NOT NULL
      AS mercari_claim_installed,
    position('ticket_platform_mismatch' in pg_get_functiondef(
      to_regprocedure('public.finalize_platform_operator_message_send(uuid,text,uuid,text,text,text,timestamptz,text)')
    )) > 0 AND position('outbound_message_contract_mismatch' in pg_get_functiondef(
      to_regprocedure('public.finalize_platform_operator_message_send(uuid,text,uuid,text,text,text,timestamptz,text)')
    )) > 0 AS platform_finalize_fenced,
    position('source = ''mercari_webhook''' in pg_get_functiondef(
      to_regprocedure('public.claim_pending_mercari_webhook_messages(integer)')
    )) > 0 AND position('COALESCE(claim_limit, 10)' in pg_get_functiondef(
      to_regprocedure('public.claim_pending_mercari_webhook_messages(integer)')
    )) > 0 AS mercari_claim_fenced,
    has_function_privilege('service_role',
      to_regprocedure('public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)'), 'EXECUTE')
      AND has_function_privilege('service_role',
      to_regprocedure('public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)'), 'EXECUTE')
      AND NOT has_function_privilege('public',
      to_regprocedure('public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)'), 'EXECUTE')
      AND NOT has_function_privilege('public',
      to_regprocedure('public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text)'), 'EXECUTE')
      AS platform_finalize_acl_safe,
    position('v_ticket.account_id IS DISTINCT FROM v_account_id' in pg_get_functiondef(
      to_regprocedure('public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)')
    )) > 0
      AND to_regprocedure('public.transition_mercari_queue_v1(uuid,text)') IS NOT NULL
      AND to_regprocedure('public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text)') IS NOT NULL
      AND has_function_privilege('service_role',
      to_regprocedure('public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)'), 'EXECUTE')
      AND has_function_privilege('service_role',
      to_regprocedure('public.transition_mercari_queue_v1(uuid,text)'), 'EXECUTE')
      AND has_function_privilege('service_role',
      to_regprocedure('public.convert_mercari_inbound_message_to_ticket_v1(uuid,text,text,text,text,text[],text,text)'), 'EXECUTE')
      AND NOT has_function_privilege('public',
      to_regprocedure('public.link_mercari_inbound_message_to_ticket(uuid,uuid,text)'), 'EXECUTE')
      AS mercari_queue_link_fenced,
    to_regprocedure('public.transition_amazon_mail_queue_v1(uuid,text,uuid,text)') IS NOT NULL
      AND to_regprocedure('public.count_amazon_mail_queue_unread_v1()') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'amazon_mail_messages'
          AND column_name IN ('queue_status','read_at','reviewed_at')
        GROUP BY table_schema, table_name HAVING count(*) = 3
      )
      AND has_function_privilege('service_role',
        to_regprocedure('public.transition_amazon_mail_queue_v1(uuid,text,uuid,text)'), 'EXECUTE')
      AND has_function_privilege('service_role',
        to_regprocedure('public.count_amazon_mail_queue_unread_v1()'), 'EXECUTE')
      AND NOT has_function_privilege('public',
        to_regprocedure('public.transition_amazon_mail_queue_v1(uuid,text,uuid,text)'), 'EXECUTE')
      AS amazon_queue_ready,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'inbound_ticket_messages'
        AND column_name = 'source_received_at'
    ) THEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.inbound_ticket_messages'::regclass
        AND conname = 'chk_inbound_ticket_messages_source_fields'
        AND position('source_received_at IS NOT NULL' in split_part(
          pg_get_constraintdef(oid), 'source = ''amazon_zoho_mail''', 1
        )) = 0
    ) ELSE true END AS mercari_constraint_compatible
" '{query: $query}')"
response="$(curl --fail-with-body --silent --show-error \
  --request POST "$QUERY_URL" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$verify_payload")"

# These booleans contain no row data or credentials and are safe CI evidence.
jq '.[0] | {
  mercari_claim_installed,
  platform_finalize_fenced,
  mercari_claim_fenced,
  platform_finalize_acl_safe,
  mercari_queue_link_fenced,
  amazon_queue_ready,
  mercari_constraint_compatible
}' <<<"$response"

if [[ "$(jq -r '.[0].mercari_claim_installed // false' <<<"$response")" != "true" ]] ||
   [[ "$(jq -r '.[0].platform_finalize_fenced // false' <<<"$response")" != "true" ]] ||
   [[ "$(jq -r '.[0].mercari_claim_fenced // false' <<<"$response")" != "true" ]] ||
   [[ "$(jq -r '.[0].platform_finalize_acl_safe // false' <<<"$response")" != "true" ]] ||
   [[ "$(jq -r '.[0].mercari_queue_link_fenced // false' <<<"$response")" != "true" ]] ||
   [[ "$(jq -r '.[0].amazon_queue_ready // false' <<<"$response")" != "true" ]] ||
   [[ "$(jq -r '.[0].mercari_constraint_compatible // false' <<<"$response")" != "true" ]]; then
  echo "Production platform-isolation capability verification failed" >&2
  exit 1
fi
echo "Production platform-isolation capabilities verified"
