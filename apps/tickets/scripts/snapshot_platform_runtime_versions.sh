#!/usr/bin/env bash
set -euo pipefail

environment="${1:-}"
output="${2:-}"
[[ "$environment" =~ ^(staging|production)$ ]] || { echo "environment must be staging or production" >&2; exit 2; }
[[ -n "$output" ]] || { echo "output path is required" >&2; exit 2; }
suffix=""
[[ "$environment" == "staging" ]] && suffix=".staging"

snapshot='{}'
for platform in mercari rakuten amazon; do
  for role in send ingestion; do
    component="${platform}-${role}"
    config="web/worker/wrangler.${component}${suffix}.toml"
    status_file="$(mktemp)"
    error_file="$(mktemp)"
    if (cd web/worker && npx wrangler deployments status --json \
        --config "wrangler.${component}${suffix}.toml" >"$status_file" 2>"$error_file"); then
      version="$(jq -r '
        (if type == "array" then .[0] else . end) |
        [.versions[]? | select((.percentage // 0) == 100) | (.version_id // .id)] |
        if length == 1 then .[0] elif length == 0 then "absent" else "ambiguous" end
      ' "$status_file")"
      [[ "$version" != "ambiguous" ]] || {
        echo "${component} has no single 100% active deployment" >&2
        rm -f "$status_file" "$error_file"
        exit 1
      }
    elif grep -q 'code: 10007' "$error_file"; then
      version="absent"
    else
      echo "Failed to read active deployment for ${component}" >&2
      sed -n '1,8p' "$error_file" >&2
      rm -f "$status_file" "$error_file"
      exit 1
    fi
    rm -f "$status_file" "$error_file"
    snapshot="$(jq --arg key "$component" --arg version "$version" '. + {($key):$version}' <<<"$snapshot")"
  done
done
printf '%s\n' "$snapshot" > "$output"
