#!/usr/bin/env bash
set -euo pipefail

prior_manifest="${1:-}"
[[ -f "$prior_manifest" ]] || { echo "previous accepted manifest is required" >&2; exit 2; }
descriptor="web/worker/contracts/provider-send-v1.json"
[[ -f "$descriptor" ]] || { echo "current provider contract descriptor is missing" >&2; exit 2; }

current_hash="$(shasum -a 256 "$descriptor" | awk '{print $1}')"
prior_hash="$(jq -r '.provider_contract_sha256 // empty' "$prior_manifest")"
prior_contract="$(jq -cS '.provider_contract // empty' "$prior_manifest")"
current_contract="$(jq -cS . "$descriptor")"
[[ "$prior_hash" == "$current_hash" && "$prior_contract" == "$current_contract" ]] || {
  echo "current provider contract is incompatible with the previous accepted contract" >&2
  exit 1
}

(cd web/worker && node --test --import tsx tests/provider-runtime-contract.test.ts)
printf '%s\n' "$current_hash"
