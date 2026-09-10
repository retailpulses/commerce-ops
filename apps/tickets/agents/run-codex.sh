#!/usr/bin/env bash
# run-codex.sh — Non-interactive Codex CLI wrapper for delegated tasks.
# Usage: ./agents/run-codex.sh "<task prompt>"
#
# Requires: codex CLI (https://github.com/openai/codex)
# Install:  brew install codex  (or follow official docs)

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: ./agents/run-codex.sh \"<task prompt>\"" >&2
  exit 1
fi

TASK="$1"
OUTFILE="$(mktemp -t codex-out.XXXXXX)"
trap 'rm -f "$OUTFILE"' EXIT

echo "→ Codex: $TASK"
echo ""

codex exec \
  --output-last-message "$OUTFILE" \
  --ephemeral \
  "$TASK"

echo ""
echo "── Codex response ──"
cat "$OUTFILE"
