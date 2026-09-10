#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: ./agents/run-codex.sh \"<task description>\""
  exit 1
fi

cd "$(dirname "$0")/.."

codex exec --skip-git-repo-check "$1"
