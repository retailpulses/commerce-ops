#!/usr/bin/env bash
set -euo pipefail

# Phase 1 snapshot importer for commerce-ops.
# Run from the repository root with an authenticated `gh` CLI that can read
# the four private source repositories.
#
# This intentionally imports CURRENT TREES ONLY. It never grafts private Git
# history into the public commerce-ops repository.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/commerce-ops-import-$$"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK" "$ROOT/apps"

for cmd in gh git rsync rg; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $cmd" >&2
    exit 1
  }
done

# Pin the audited revisions. If source main has advanced, stop and deliberately
# refresh provenance rather than silently importing a different tree.
declare -A REPO=(
  [ops-portal]="retailpulses/ops-portal"
  [inquiry]="retailpulses/inquiry-automation"
  [orders]="retailpulses/OrderMgmt"
  [tickets]="retailpulses/ticket-handling"
)
declare -A REV=(
  [ops-portal]="6740e9a6116ce3d4d9bd9980caa78538ad02bb97"
  [inquiry]="e02ba5f2b81ff67252d2a22a41ec0b0e42464b75"
  [orders]="66008ae6d7394746459649c20ed123e391c9dff8"
  [tickets]="7434487ad33e3b3d2d0b89ba9e8c3da054c07ec6"
)

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
  local app="$1" repo="${REPO[$1]}" expected="${REV[$1]}"
  local src="$WORK/$app" dst="$ROOT/apps/$app"

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

  # ticket-handling Baserow is retired; executable migration tooling stays in
  # the original private repo/history rather than becoming active monorepo code.
  if [[ "$app" == "tickets" ]]; then
    rm -f "$dst/scripts/migrate_baserow_ticket_pipeline.py"
  fi

  printf '%s\n' "$repo@$actual" > "$dst/.source-revision"
}

sync_one ops-portal
sync_one inquiry
sync_one orders
sync_one tickets

echo "==> Safety scan"

# No private env files. Examples/templates remain allowed.
while IFS= read -r f; do
  case "$(basename "$f")" in
    .env.example|.env.sample) ;;
    *) echo "ERROR: environment file must not be committed: ${f#$ROOT/}" >&2; exit 1 ;;
  esac
done < <(find "$ROOT/apps" -type f -name '.env*' -print)

# Fail on obvious high-risk credential material. This is intentionally
# conservative and supplements, not replaces, human review.
if rg -n --hidden \
  --glob '!**/.env.example' --glob '!**/.env.sample' \
  '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})' \
  "$ROOT/apps"; then
  echo "ERROR: possible credential material detected; inspect before commit." >&2
  exit 1
fi

# Inquiry and Tickets have retired Baserow as runtime architecture. Historical
# docs/migrations may mention Baserow, but live runtime trees must not re-add it.
for app in inquiry tickets; do
  if rg -n '(api\.baserow\.io|BASEROW_(API_)?TOKEN|BASEROW_DATABASE_TOKEN)' \
      "$ROOT/apps/$app" \
      --glob '!docs/**' \
      --glob '!**/supabase/migrations/**' \
      --glob '!**/*test*' ; then
    echo "ERROR: active Baserow runtime reference detected in $app." >&2
    exit 1
  fi
done

echo
printf '%s\n' \
  'Snapshot import prepared successfully.' \
  'Review `git status` and `git diff --stat` before committing.' \
  'Do not add deployment workflows or production secrets in this change.'
