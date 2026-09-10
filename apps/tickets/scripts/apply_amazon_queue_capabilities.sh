#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
APPROVED_SHA="${SUPABASE_MIGRATION_APPROVED_SHA:-}"
RELEASE_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
MIGRATIONS=(
  "$ROOT_DIR/supabase/migrations/20260908182200_amazon_mail_isolated_persistence.sql"
  "$ROOT_DIR/supabase/migrations/20260909011500_amazon_mail_ingestion_v3.sql"
  "$ROOT_DIR/supabase/migrations/20260909024000_amazon_mail_queue_actions.sql"
)

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" || -z "$PROJECT_REF" ]]; then
  echo "Supabase access token and project ref are required" >&2
  exit 1
fi
if [[ -z "$APPROVED_SHA" || "$APPROVED_SHA" != "$RELEASE_SHA" ]]; then
  echo "Amazon queue migrations are not approved for release SHA $RELEASE_SHA" >&2
  exit 1
fi
if [[ "${SUPABASE_BACKUP_VERIFIED:-}" != "true" && "${SUPABASE_BACKUP_VERIFIED:-}" != "yes" ]]; then
  echo "A current backup/PITR verification is required" >&2
  exit 1
fi

QUERY_URL="https://api.supabase.com/v1/projects/$PROJECT_REF/database/query"
for migration in "${MIGRATIONS[@]}"; do
  [[ -f "$migration" ]] || { echo "Missing Amazon migration: $migration" >&2; exit 1; }
  payload="$(jq -n --rawfile query "$migration" '{query: $query}')"
  curl --fail-with-body --silent --show-error \
    --request POST "$QUERY_URL" \
    --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$payload" >/dev/null
done

"$ROOT_DIR/scripts/verify_platform_isolation_capabilities.sh"
echo "Amazon queue capabilities installed and verified for release $RELEASE_SHA"
