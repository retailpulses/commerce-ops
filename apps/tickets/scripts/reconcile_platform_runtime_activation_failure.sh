#!/usr/bin/env bash
set -euo pipefail

component="${1:?component required}"
environment="${2:?environment required}"
config="${3:?config required}"
generation="${4:?generation required}"
expected="${5:?expected previous version required}"
uploaded="${6:?uploaded version required}"
candidate="${7:?disabled candidate version required}"
nonce="${8:?transition nonce required}"
[[ -n "${PLATFORM_RUNTIME_DEPLOYER_KEY:-}" && -n "${SUPABASE_URL:-}" ]] || exit 2

target="$expected"
[[ "$target" != "none" ]] || target="$candidate"
before="$(mktemp)"
trap 'rm -f "$before"' EXIT
scripts/snapshot_platform_runtime_versions.sh "$environment" "$before"
actual="$(jq -r --arg component "$component" '.[$component]' "$before")"

# Resolve ambiguous Cloudflare outcomes first. Never move DB ownership away
# from the version still receiving traffic.
if [[ "$actual" == "$uploaded" ]]; then
  (cd web/worker && npx wrangler versions deploy "$target@100%" --yes --config "$config" --message "reconcile failed activation $component") || true
  scripts/snapshot_platform_runtime_versions.sh "$environment" "$before"
  actual="$(jq -r --arg component "$component" '.[$component]' "$before")"
fi
[[ "$actual" == "$target" || ("$expected" == "none" && "$actual" == "absent") ]] || {
  echo "ambiguous Cloudflare version retained; DB transition intentionally preserved" >&2
  exit 1
}

rpc() {
  local name="$1" payload="$2"
  curl --fail --silent --show-error --max-time 15 \
    -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" \
    -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" "$SUPABASE_URL/rest/v1/rpc/$name"
}

if [[ "$actual" == "absent" && "$expected" == "none" ]]; then
  # No Worker receives traffic. A prepared/bootstrap row may safely be removed;
  # an ambiguous response leaves it fail-closed and the same command is retryable.
  rpc cancel_prepared_platform_runtime_handoff_v1 "$(jq -n --arg component "$component" --arg generation "$generation" '{p_component:$component,p_generation:$generation,p_expected_version_id:"none"}')" >/dev/null || true
  exit 0
fi

restored_generation="$generation"
if [[ "$expected" != "none" ]]; then
  ownership="$(rpc get_platform_runtime_ownership_v1 "$(jq -n --arg component "$component" '{p_component:$component}')")"
  restored_generation="$(jq -r '.previous_generation // .routing_generation' <<<"$ownership")"
fi
payload="$(jq -n --arg component "$component" --arg from "$uploaded" --arg restored "$target" --arg generation "$restored_generation" --arg evidence "cloudflare-readback:$actual" '{p_component:$component,p_from_version_id:$from,p_restored_version_id:$restored,p_restored_generation:$generation,p_evidence:$evidence}')"
rpc reconcile_platform_runtime_restored_v1 "$payload" >/dev/null || true
verified="$(rpc get_platform_runtime_ownership_v1 "$(jq -n --arg component "$component" '{p_component:$component}')")"
jq -e --arg version "$target" --arg generation "$restored_generation" '.state=="active" and .active_version_id==$version and .routing_generation==$generation' <<<"$verified" >/dev/null
