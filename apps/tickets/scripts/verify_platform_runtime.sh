#!/usr/bin/env bash
set -euo pipefail

selected="${1:-}"
before="${2:-}"
after="${3:-}"
manifest="${4:-}"
[[ "$selected" =~ ^(mercari|rakuten|amazon)-(send|ingestion)$ ]] || { echo "invalid selected component" >&2; exit 2; }
for file in "$before" "$after" "$manifest"; do [[ -f "$file" ]] || { echo "missing evidence file: $file" >&2; exit 2; }; done

jq -e --arg selected "$selected" '
  . as $after |
  input as $before |
  (["mercari-send","rakuten-send","amazon-send","mercari-ingestion","rakuten-ingestion","amazon-ingestion"] | all(. as $key | ($after[$key] | type == "string") and ($before[$key] | type == "string"))) and
  (["mercari-send","rakuten-send","amazon-send","mercari-ingestion","rakuten-ingestion","amazon-ingestion"] | all(. as $key | if $key == $selected then $after[$key] != $before[$key] else $after[$key] == $before[$key] end))
' "$after" "$before" >/dev/null

jq -e --arg selected "$selected" '
  (.platform + "-" + .role) == $selected and
  (.git_sha | length == 40) and
  (.config_sha256 | length == 64) and
  (.entrypoint_sha256 | length == 64) and
  (.bundle_sha256 | length == 64) and
  (.migration_sha256 | length == 64) and
  (.worker_version_id | type == "string") and
  (.previous_rollback_target | type == "string") and
  (.health_readback.status == "ready" or (.platform == "amazon" and .role == "send" and .health_readback.status == "unavailable")) and
  (.n_minus_one_contract == true)
' "$manifest" >/dev/null

echo "Verified isolated change for $selected"
