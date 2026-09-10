#!/usr/bin/env bash
set -euo pipefail

# Phase 1 snapshot importer for commerce-ops.
# Run from the repository root with an authenticated `gh` CLI that can read
# the four private source repositories.
#
# This intentionally imports CURRENT TREES ONLY. It never grafts private Git
# history into the public commerce-ops repository.
#
# Keep this script compatible with the Bash version bundled with macOS; do not
# rely on Bash 4+ associative arrays.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/commerce-ops-import-$$"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK" "$ROOT/apps"

for cmd in gh git rsync grep find xargs; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $cmd" >&2
    exit 1
  }
done

COMMON_RSYNC_EXCLUDES=(
  --exclude='.git/'
  --exclude='.github/'
  --exclude='.serena/'
  --exclude='.env'
  --exclude='.env.local'
  --exclude='.env.production'
  --exclude='.env.staging'
  --exclude='.dev.vars'
  --exclude='.dev.vars.*'
  --exclude='node_modules/'
  --exclude='dist/'
  --exclude='dist-*/'
  --exclude='build/'
  --exclude='coverage/'
  --exclude='.next/'
  --exclude='.turbo/'
  --exclude='.wrangler/'
  --exclude='.cache/'
  --exclude='__pycache__/'
  --exclude='.pytest_cache/'
  --exclude='.mypy_cache/'
  --exclude='.ruff_cache/'
  --exclude='.venv/'
  --exclude='venv/'
  --exclude='*.log'
  --exclude='logs/'
  --exclude='docs/reports/'
  --exclude='docs/worklog/'
  --exclude='docs/session-closeout/'
  --exclude='docs/github-issues/'
  --exclude='open_tickets_report.md'
  --exclude='*.har'
)

sync_one() {
  local app="$1"
  local repo="$2"
  local expected="$3"
  local src="$WORK/$app"
  local dst="$ROOT/apps/$app"

  echo "==> Clone current $repo"
  gh repo clone "$repo" "$src" -- --depth=1 --branch main --single-branch >/dev/null
  local actual
  actual="$(git -C "$src" rev-parse HEAD)"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: $repo main moved since audit." >&2
    echo "  audited: $expected" >&2
    echo "  current: $actual" >&2
    echo "Refresh docs/SOURCE_PROVENANCE.md and this script deliberately before importing." >&2
    exit 1
  fi

  mkdir -p "$dst"
  rsync -a --delete "${COMMON_RSYNC_EXCLUDES[@]}" "$src/" "$dst/"

  # These Inquiry root docs describe the retired Baserow/Python architecture
  # as current. Keep that history in the private source repo, not in the new
  # monorepo where agents could mistake it for operating guidance.
  if [[ "$app" == "inquiry" ]]; then
    rm -f "$dst/REFACTOR-WORKER.md" "$dst/ROADMAP.md"
  fi

  # ticket-handling Baserow is retired. Keep executable migration tooling and
  # the old Baserow/inline-SPA architecture report in the private source
  # repository/history rather than importing them as apparent current guidance.
  if [[ "$app" == "tickets" ]]; then
    rm -f \
      "$dst/scripts/migrate_baserow_ticket_pipeline.py" \
      "$dst/TicketHandling架构分析报告.md"
  fi

  printf '%s\n' "$repo@$actual" > "$dst/.source-revision"
}

# Pin the audited revisions. If source main has advanced, stop and deliberately
# refresh provenance rather than silently importing a different tree.
sync_one "ops-portal" "retailpulses/ops-portal" "6740e9a6116ce3d4d9bd9980caa78538ad02bb97"
sync_one "inquiry" "retailpulses/inquiry-automation" "e02ba5f2b81ff67252d2a22a41ec0b0e42464b75"
sync_one "orders" "retailpulses/OrderMgmt" "f3789ca5ca27f8a23b0b6db09c82c0579c3d6702"
sync_one "tickets" "retailpulses/ticket-handling" "7434487ad33e3b3d2d0b89ba9e8c3da054c07ec6"

echo "==> Safety scan"

# No private env files. Examples/templates remain allowed.
while IFS= read -r f; do
  case "$(basename "$f")" in
    .env.example|.env.sample) ;;
    *) echo "ERROR: environment file must not be committed: ${f#$ROOT/}" >&2; exit 1 ;;
  esac
done < <(find "$ROOT/apps" -type f -name '.env*' -print)

# Fail on obvious high-risk credential material. This is intentionally
# conservative and supplements, not replaces, human review. Use standard
# macOS tools rather than requiring ripgrep.
SECRET_PATTERN='(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'
if find "$ROOT/apps" -type f \
    ! -name '.env.example' \
    ! -name '.env.sample' \
    -print0 | xargs -0 grep -nE "$SECRET_PATTERN"; then
  echo "ERROR: possible credential material detected; inspect before commit." >&2
  exit 1
fi

# Inquiry and Tickets have retired Baserow as runtime architecture. Historical
# documentation may mention Baserow, but executable/config runtime trees must
# not re-add it. Stale root operating docs are explicitly removed above.
BASEROW_PATTERN='(api\.baserow\.io|BASEROW_(API_)?TOKEN|BASEROW_DATABASE_TOKEN)'
for app in inquiry tickets; do
  if find "$ROOT/apps/$app" -type f \
      ! -name '*.md' \
      ! -path '*/docs/*' \
      ! -path '*/supabase/migrations/*' \
      ! -path '*test*' \
      -print0 | xargs -0 grep -nE "$BASEROW_PATTERN"; then
    echo "ERROR: active Baserow runtime reference detected in $app." >&2
    exit 1
  fi
done

echo
printf '%s\n' \
  'Snapshot import prepared successfully.' \
  'Review `git status` and `git diff --stat` before committing.' \
  'Do not add deployment workflows or production secrets in this change.'
