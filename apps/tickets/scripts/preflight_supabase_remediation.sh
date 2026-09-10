#!/usr/bin/env bash
set -euo pipefail

# Read-only hosted release preflight using Supabase's temporary login role.
# It never prints the access token and never applies a migration.

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "SUPABASE_ACCESS_TOKEN is required" >&2
  exit 2
fi
if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
  echo "SUPABASE_PROJECT_REF is required" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_SHA="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
if [[ "${SUPABASE_MIGRATION_APPROVED_SHA:-}" != "$CURRENT_SHA" ]]; then
  echo "SUPABASE_MIGRATION_APPROVED_SHA must equal the exact deployment SHA: $CURRENT_SHA" >&2
  exit 2
fi
if [[ "${SUPABASE_BACKUP_VERIFIED:-}" != "yes" ]]; then
  echo "Set SUPABASE_BACKUP_VERIFIED=yes only after confirming hosted and logical backups." >&2
  exit 2
fi
if [[ "${SUPABASE_STORAGE_100MIB_VERIFIED:-}" != "yes" ]]; then
  echo "Set SUPABASE_STORAGE_100MIB_VERIFIED=yes only after verifying the hosted 100 MiB limit." >&2
  exit 2
fi

SKIP_PARITY="${SKIP_MIGRATION_PARITY_CHECK:-}"

SUPABASE=(npx --yes supabase@2.109.1)
export NO_COLOR=1
export TERM=dumb
WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

"${SUPABASE[@]}" link --project-ref "$SUPABASE_PROJECT_REF" --yes >/dev/null

if [[ "$SKIP_PARITY" == "true" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  WARNING: SKIP_MIGRATION_PARITY_CHECK=true                       ║"
  echo "║                                                                  ║"
  echo "║  The migration-parity dry-run has been waived for this release.  ║"
  echo "║  This override is ONLY safe when the release contains zero       ║"
  echo "║  migration changes AND the hosted database schema is known to    ║"
  echo "║  be current from a separate reconciliation.                      ║"
  echo "║                                                                  ║"
  echo "║  The remaining safety gates (SHA approval, backup verified,      ║"
  echo "║  storage limit, hosted remediation query) still apply.           ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""

  set +e
  dry_run="$("${SUPABASE[@]}" db push --linked --include-all --dry-run --yes 2>&1)"
  dry_run_status=$?
  set -e
  printf '%s\n' "$dry_run"
  if [[ $dry_run_status -ne 0 ]]; then
    echo "Supabase migration dry-run failed with status $dry_run_status (non-fatal: parity check waived)." >&2
    echo "This mismatch must be resolved before the next release that contains migration changes." >&2
  fi
else
  set +e
  dry_run="$("${SUPABASE[@]}" db push --linked --include-all --dry-run --yes 2>&1)"
  dry_run_status=$?
  set -e
  printf '%s\n' "$dry_run"
  if [[ $dry_run_status -ne 0 ]]; then
    echo "Supabase migration dry-run failed with status $dry_run_status." >&2
    exit "$dry_run_status"
  fi

  EXPECTED_PENDING=(
    20260830090000_rakuten_rmesse_attachment_evidence.sql
  )

  if [[ "$dry_run" == *"Would push these migrations:"* ]]; then
    printf '%s\n' "$dry_run" \
      | sed -n 's/^[[:space:]]*[•*-][[:space:]]*\([^[:space:]]*\.sql\).*$/\1/p' \
      | sort -u >"$WORK_DIR/observed"
    printf '%s\n' "${EXPECTED_PENDING[@]}" | sort -u >"$WORK_DIR/expected"
    if ! cmp -s "$WORK_DIR/observed" "$WORK_DIR/expected"; then
      echo "Hosted migration plan does not match the approved remediation set." >&2
      echo "Expected:" >&2
      cat "$WORK_DIR/expected" >&2
      echo "Observed:" >&2
      cat "$WORK_DIR/observed" >&2
      exit 1
    fi
  elif [[ "$dry_run" != *"Remote database is up to date"* ]]; then
    echo "Supabase dry-run did not produce an authoritative migration plan." >&2
    exit 1
  fi
fi

"${SUPABASE[@]}" db query --linked \
  --file "$ROOT_DIR/supabase/tests/hosted_remediation_preflight.sql"

echo "Hosted Supabase remediation preflight passed"
echo "No hosted mutation was performed"
