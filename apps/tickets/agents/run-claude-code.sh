#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: ./agents/run-claude-code.sh \"<task prompt>\"" >&2
  exit 1
fi

TASK="$1"
CODEROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTFILE="$(mktemp -t claude-code-out.XXXXXX)"
trap 'rm -f "$OUTFILE"' EXIT

echo "-> Claude Code: $TASK"
echo ""

cd "$CODEROOT"

CLAUDE_BIN="${CLAUDE_BIN:-/Users/user/.local/bin/claude}"
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-acceptEdits}"

"$CLAUDE_BIN" \
  --print \
  --output-format text \
  --permission-mode "$CLAUDE_PERMISSION_MODE" \
  "$TASK" 2>&1 | tee "$OUTFILE"

echo ""
echo "-- Claude Code completed --"
