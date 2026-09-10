#!/usr/bin/env bash
# run-opencode.sh — Non-interactive OpenCode CLI wrapper for delegated tasks.
# Usage: ./agents/run-opencode.sh "<task prompt>"
#
# Requires: opencode CLI
# Install:  brew install opencode  (or follow official docs)

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: ./agents/run-opencode.sh \"<task prompt>\"" >&2
  exit 1
fi

TASK="$1"
CODEROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTFILE="$(mktemp -t opencode-out.XXXXXX)"
trap 'rm -f "$OUTFILE"' EXIT

echo "→ OpenCode: $TASK"
echo ""

cd "$CODEROOT"
opencode run "$TASK" 2>&1 | tee "$OUTFILE"

echo ""
echo "── OpenCode response ──"
