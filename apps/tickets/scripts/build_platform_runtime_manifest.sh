#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
role="${2:-}"
environment="${3:-}"
output="${4:-}"
case "$platform" in mercari|rakuten|amazon) ;; *) echo "platform must be mercari, rakuten, or amazon" >&2; exit 2;; esac
case "$role" in send|ingestion) ;; *) echo "role must be send or ingestion" >&2; exit 2;; esac
case "$environment" in staging|production) ;; *) echo "environment must be staging or production" >&2; exit 2;; esac
[[ -n "$output" ]] || { echo "output path is required" >&2; exit 2; }

suffix=""
[[ "$environment" == "staging" ]] && suffix=".staging"
config="web/worker/wrangler.${platform}-${role}${suffix}.toml"
[[ -f "$config" ]] || { echo "missing config: $config" >&2; exit 1; }
entrypoint="$(sed -n 's/^main = "\([^"]*\)"/\1/p' "$config")"
[[ -n "$entrypoint" && -f "web/worker/$entrypoint" ]] || { echo "invalid entrypoint in $config" >&2; exit 1; }
bundle_dir="$(mktemp -d)"
trap 'rm -rf "$bundle_dir"' EXIT
(cd web/worker && npx wrangler deploy --dry-run --config "$(basename "$config")" --outdir "$bundle_dir" >/dev/null)
bundle_sha256="$(find "$bundle_dir" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"

jq -n \
  --arg platform "$platform" \
  --arg role "$role" \
  --arg environment "$environment" \
  --arg git_sha "$(git rev-parse HEAD)" \
  --arg config "$config" \
  --arg config_sha256 "$(shasum -a 256 "$config" | awk '{print $1}')" \
  --arg entrypoint "$entrypoint" \
  --arg entrypoint_sha256 "$(shasum -a 256 "web/worker/$entrypoint" | awk '{print $1}')" \
  --arg bundle_sha256 "$bundle_sha256" \
  --arg migration_sha256 "$(find supabase/migrations -type f -name '*.sql' -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')" \
  --arg provider_contract_sha256 "$(shasum -a 256 web/worker/contracts/provider-send-v1.json | awk '{print $1}')" \
  --argjson provider_contract "$(jq -c . web/worker/contracts/provider-send-v1.json)" \
  '{schema_version:1, contract_version:"2026-09-09.v1", platform:$platform, role:$role, environment:$environment, git_sha:$git_sha, config:$config, config_sha256:$config_sha256, entrypoint:$entrypoint, entrypoint_sha256:$entrypoint_sha256, bundle_sha256:$bundle_sha256, migration_sha256:$migration_sha256, provider_contract_sha256:$provider_contract_sha256, provider_contract:$provider_contract, worker_version_id:null, binding_target:null, previous_rollback_target:null, health_readback:null, n_minus_one_contract:null}' > "$output"
