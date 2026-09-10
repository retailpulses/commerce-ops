#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "Usage: $0 \"<task description>\""
  exit 1
fi

cd "$REPO_ROOT"

# Run OpenCode CLI in build mode with the given task prompt.
exec opencode run --agent build "$TASK"
