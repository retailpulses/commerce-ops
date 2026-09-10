#!/usr/bin/env bash
set -euo pipefail

# Pre-publish verification for the Phase 1 sanitized app snapshots.
# This script is intentionally macOS-Bash compatible and prints paths only for
# security-sensitive failures; it never echoes matched credential material.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$ROOT/apps"

fail=0

say_fail() {
  echo "ERROR: $*" >&2
  fail=1
}

check_revision() {
  local app="$1"
  local expected="$2"
  local file="$APPS/$app/.source-revision"
  if [[ ! -f "$file" ]]; then
    say_fail "missing apps/$app/.source-revision"
    return
  fi
  local actual
  actual="$(tr -d '\r\n' < "$file")"
  if [[ "$actual" != "$expected" ]]; then
    say_fail "apps/$app source revision mismatch"
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
  fi
}

for app in ops-portal inquiry orders tickets; do
  [[ -d "$APPS/$app" ]] || say_fail "missing apps/$app"
done

check_revision "ops-portal" "retailpulses/ops-portal@6740e9a6116ce3d4d9bd9980caa78538ad02bb97"
check_revision "inquiry" "retailpulses/inquiry-automation@e02ba5f2b81ff67252d2a22a41ec0b0e42464b75"
check_revision "orders" "retailpulses/OrderMgmt@f3789ca5ca27f8a23b0b6db09c82c0579c3d6702"
check_revision "tickets" "retailpulses/ticket-handling@7434487ad33e3b3d2d0b89ba9e8c3da054c07ec6"

# Repository/workflow boundaries: no nested Git history and no source workflows
# enter the monorepo snapshot. CI/deploy workflows are ported separately.
while IFS= read -r -d '' d; do
  say_fail "forbidden nested repository/workflow directory: ${d#$ROOT/}"
done < <(find "$APPS" -type d \( -name .git -o -name .github \) -print0)

# Generated/dependency directories should not be snapshot source.
while IFS= read -r -d '' d; do
  say_fail "generated/dependency directory present: ${d#$ROOT/}"
done < <(find "$APPS" -type d \( \
  -name node_modules -o -name dist -o -name build -o -name coverage -o \
  -name .next -o -name .turbo -o -name .wrangler -o -name __pycache__ -o \
  -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache -o \
  -name .venv -o -name venv \
\) -print0)

# Private environment files are forbidden; examples are allowed.
while IFS= read -r -d '' f; do
  case "$(basename "$f")" in
    .env.example|.env.sample) ;;
    *) say_fail "environment file present: ${f#$ROOT/}" ;;
  esac
done < <(find "$APPS" -type f -name '.env*' -print0)

# Credential-bearing file types/names should never be committed to this public repo.
while IFS= read -r -d '' f; do
  say_fail "credential/private material file present: ${f#$ROOT/}"
done < <(find "$APPS" -type f \( \
  -name '*.pem' -o -name '*.p12' -o -name '*.pfx' -o -name '*.jks' -o \
  -name 'id_rsa' -o -name 'id_ed25519' -o -name '.netrc' -o -name '.npmrc' -o \
  -name '.pypirc' -o -iname 'credentials.json' -o -iname '*service-account*.json' -o \
  -iname 'master_credentials.md' \
\) -print0)

SECRET_PATTERN='(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|sbp_[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'
while IFS= read -r -d '' f; do
  if grep -qE "$SECRET_PATTERN" "$f" 2>/dev/null; then
    say_fail "possible hardcoded credential in ${f#$ROOT/}"
  fi
done < <(find "$APPS" -type f ! -name '.env.example' ! -name '.env.sample' -print0)

# Common local/runtime data containers are never source-of-truth code artifacts.
while IFS= read -r -d '' f; do
  say_fail "database/archive/runtime-data file present: ${f#$ROOT/}"
done < <(find "$APPS" -type f \( \
  -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' -o -name '*.dump' -o \
  -name '*.bak' -o -name '*.har' -o -name '*.zip' -o -name '*.tar' -o \
  -name '*.tgz' -o -name '*.7z' \
\) -print0)

# Unexpected large files deserve explicit review before a public commit.
while IFS= read -r -d '' f; do
  say_fail "file larger than 5 MiB requires explicit review: ${f#$ROOT/}"
done < <(find "$APPS" -type f -size +5M -print0)

# Runtime Baserow is forbidden for Inquiry/Tickets. Historical Markdown and
# migration/test evidence may refer to retirement history.
BASEROW_PATTERN='(api\.baserow\.io|BASEROW_(API_)?TOKEN|BASEROW_DATABASE_TOKEN)'
for app in inquiry tickets; do
  while IFS= read -r -d '' f; do
    if grep -qE "$BASEROW_PATTERN" "$f" 2>/dev/null; then
      say_fail "active Baserow reference in apps/$app: ${f#$ROOT/}"
    fi
  done < <(find "$APPS/$app" -type f \
    ! -name '*.md' \
    ! -path '*/docs/*' \
    ! -path '*/supabase/migrations/*' \
    ! -path '*test*' \
    -print0)
done

# Explicit omissions that must remain absent from the public current-state tree.
for f in \
  "$APPS/inquiry/REFACTOR-WORKER.md" \
  "$APPS/inquiry/ROADMAP.md" \
  "$APPS/tickets/scripts/migrate_baserow_ticket_pipeline.py" \
  "$APPS/tickets/TicketHandling架构分析报告.md"; do
  [[ ! -e "$f" ]] || say_fail "retired/omitted artifact unexpectedly present: ${f#$ROOT/}"
done

# Produce only aggregate inventory after all fail-closed checks.
echo "Snapshot inventory:"
for app in ops-portal inquiry orders tickets; do
  files="$(find "$APPS/$app" -type f | wc -l | tr -d ' ')"
  bytes="$(du -sk "$APPS/$app" | awk '{print $1}')"
  echo "  $app: $files files, ${bytes} KiB"
done

if [[ "$fail" -ne 0 ]]; then
  echo "PRE-PUBLISH VERIFICATION FAILED — do not commit or push apps/." >&2
  exit 1
fi

echo "PRE-PUBLISH VERIFICATION PASSED"
echo "No deployment workflows are included; apps/ is ready for branch commit/review."
