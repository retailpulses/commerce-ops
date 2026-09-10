#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
role="${2:-}"
environment="${3:-}"
manifest="${4:-}"
[[ "$platform" =~ ^(mercari|rakuten|amazon)$ ]] || { echo "invalid platform" >&2; exit 2; }
[[ "$role" =~ ^(send|ingestion)$ ]] || { echo "invalid role" >&2; exit 2; }
[[ "$environment" =~ ^(staging|production)$ ]] || { echo "invalid environment" >&2; exit 2; }
[[ -f "$manifest" ]] || { echo "accepted manifest file is required" >&2; exit 2; }
[[ "${PLATFORM_RUNTIME_ROLLBACK_APPROVED:-}" == "yes" ]] || { echo "rollback requires PLATFORM_RUNTIME_ROLLBACK_APPROVED=yes" >&2; exit 1; }
[[ -n "${PLATFORM_RUNTIME_DEPLOYER_KEY:-}" && -n "${SUPABASE_URL:-}" ]] || { echo "deployer credential and SUPABASE_URL are required" >&2; exit 1; }

suffix=""
[[ "$environment" == "staging" ]] && suffix=".staging"
config="web/worker/wrangler.${platform}-${role}${suffix}.toml"
component="${platform}-${role}"
jq -e --arg platform "$platform" --arg role "$role" --arg environment "$environment" \
  '.platform == $platform and .role == $role and .environment == $environment and
   .deployment_phase == "activate" and .n_minus_one_contract == true and
   (.worker_version_id | type == "string") and
   (.previous_rollback_target | type == "string") and
   (.previous_routing_generation | type == "string") and
   (.routing_generation | type == "string") and
   (.contract_version == "2026-09-09.v1") and
   (.health_readback.status == "ready" or (.platform == "amazon" and .role == "send" and .health_readback.status == "unavailable"))' "$manifest" >/dev/null
current_expected="$(jq -r '.worker_version_id' "$manifest")"
rollback_target="$(jq -r '.previous_rollback_target' "$manifest")"
[[ "$rollback_target" =~ ^[0-9a-f-]{20,}$ ]] || { echo "manifest has no valid rollback target" >&2; exit 2; }
generation="$(jq -r '.routing_generation' "$manifest")"
previous_generation="$(jq -r '.previous_routing_generation' "$manifest")"
[[ -n "$previous_generation" && "$previous_generation" != "none" ]] || { echo "manifest has no valid previous routing generation" >&2; exit 2; }

before="$(mktemp)"
after="$(mktemp)"
transition_started=false
traffic_switched=false
nonce="$(uuidgen | tr '[:upper:]' '[:lower:]')"
cleanup() {
  status=$?
  if [[ "$transition_started" == "true" ]]; then
    if ! scripts/snapshot_platform_runtime_versions.sh "$environment" "$after"; then
      rm -f "$before" "$after"
      exit 1
    fi
    actual="$(jq -r --arg component "$component" '.[$component]' "$after")"
    if [[ "$actual" == "$rollback_target" ]]; then
      (cd web/worker && npx wrangler versions deploy "$current_expected@100%" --yes --config "wrangler.${platform}-${role}${suffix}.toml" --message "reconcile isolated rollback ${component}") || true
      scripts/snapshot_platform_runtime_versions.sh "$environment" "$after" || { rm -f "$before" "$after"; exit 1; }
      actual="$(jq -r --arg component "$component" '.[$component]' "$after")"
      [[ "$actual" == "$current_expected" ]] || { echo "Cloudflare restore remains ambiguous; DB transition preserved" >&2; rm -f "$before" "$after"; exit 1; }
    elif [[ "$actual" != "$current_expected" ]]; then
      echo "ambiguous Cloudflare rollback state; DB transition preserved" >&2
      rm -f "$before" "$after"
      exit 1
    fi
    ownership_payload="$(jq -n --arg component "$component" '{p_component:$component}')"
    ownership="$(curl --fail --silent --show-error --max-time 15 -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Content-Type: application/json" -d "$ownership_payload" "$SUPABASE_URL/rest/v1/rpc/get_platform_runtime_ownership_v1")" || { rm -f "$before" "$after"; exit 1; }
    state="$(jq -r '.state' <<<"$ownership")"
    active="$(jq -r '.active_version_id' <<<"$ownership")"
    active_generation="$(jq -r '.routing_generation' <<<"$ownership")"
    if [[ "$state" == "rolling_back" && "$(jq -r '.transition_nonce' <<<"$ownership")" == "$nonce" ]]; then
      payload="$(jq -n --arg component "$component" --arg generation "$generation" --arg expected "$current_expected" --arg nonce "$nonce" '{p_component:$component,p_generation:$generation,p_expected_version_id:$expected,p_nonce:$nonce}')"
      result="$(curl --fail --silent --show-error --max-time 15 -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Content-Type: application/json" -d "$payload" "$SUPABASE_URL/rest/v1/rpc/abort_platform_runtime_transition_v1")" || status=1
      [[ "$result" == "true" ]] || status=1
    elif [[ "$state" == "active" && "$active" == "$rollback_target" && "$active_generation" == "$previous_generation" ]]; then
      recovery_nonce="$(uuidgen | tr '[:upper:]' '[:lower:]')"
      begin_recovery="$(jq -n --arg component "$component" --arg generation "$previous_generation" --arg expected "$rollback_target" --arg target "$current_expected" --arg target_generation "$generation" --arg nonce "$recovery_nonce" '{p_component:$component,p_generation:$generation,p_expected_version_id:$expected,p_target_version_id:$target,p_target_generation:$target_generation,p_transition:"rollback",p_nonce:$nonce}')"
      curl --fail --silent --show-error --max-time 15 -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Content-Type: application/json" -d "$begin_recovery" "$SUPABASE_URL/rest/v1/rpc/begin_platform_runtime_transition_v1" >/dev/null || status=1
      finish_recovery="$(jq -n --arg component "$component" --arg generation "$previous_generation" --arg target "$current_expected" --arg target_generation "$generation" --arg nonce "$recovery_nonce" '{p_component:$component,p_generation:$generation,p_target_version_id:$target,p_target_generation:$target_generation,p_nonce:$nonce}')"
      curl --fail --silent --show-error --max-time 15 -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" -H "Content-Type: application/json" -d "$finish_recovery" "$SUPABASE_URL/rest/v1/rpc/finish_platform_runtime_transition_v1" >/dev/null || status=1
    elif [[ "$state" != "active" || "$active" != "$current_expected" || "$active_generation" != "$generation" ]]; then
      status=1
    fi
  fi
  rm -f "$before" "$after"
  exit "$status"
}
trap cleanup EXIT
scripts/snapshot_platform_runtime_versions.sh "$environment" "$before"
current_actual="$(jq -r --arg component "$component" '.[$component]' "$before")"
[[ "$current_actual" == "$current_expected" ]] || {
  echo "rollback CAS failed: active version differs from accepted manifest" >&2
  exit 1
}

begin_payload="$(jq -n --arg component "$component" --arg generation "$generation" --arg expected "$current_expected" --arg target "$rollback_target" --arg target_generation "$previous_generation" --arg nonce "$nonce" '{p_component:$component,p_generation:$generation,p_expected_version_id:$expected,p_target_version_id:$target,p_target_generation:$target_generation,p_transition:"rollback",p_nonce:$nonce}')"
transition_started=true
curl --fail --silent --show-error --max-time 15 \
  -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" \
  -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" \
  -H "Content-Type: application/json" \
  -d "$begin_payload" "$SUPABASE_URL/rest/v1/rpc/begin_platform_runtime_transition_v1" >/dev/null

(cd web/worker && npx wrangler rollback "$rollback_target" --yes --config "wrangler.${platform}-${role}${suffix}.toml" --message "isolated rollback ${component}")
traffic_switched=true
scripts/snapshot_platform_runtime_versions.sh "$environment" "$after"
jq -e --arg component "$component" --arg target "$rollback_target" \
  '.[$component] == $target' "$after" >/dev/null
for other in mercari-send mercari-ingestion rakuten-send rakuten-ingestion amazon-send amazon-ingestion; do
  [[ "$other" == "$component" ]] && continue
  [[ "$(jq -r --arg key "$other" '.[$key]' "$before")" == "$(jq -r --arg key "$other" '.[$key]' "$after")" ]] || {
    echo "rollback changed unrelated component: $other" >&2
    exit 1
  }
done

finish_payload="$(jq -n --arg component "$component" --arg generation "$generation" --arg target "$rollback_target" --arg target_generation "$previous_generation" --arg nonce "$nonce" '{p_component:$component,p_generation:$generation,p_target_version_id:$target,p_target_generation:$target_generation,p_nonce:$nonce}')"
curl --fail --silent --show-error --max-time 15 \
  -H "apikey: $PLATFORM_RUNTIME_DEPLOYER_KEY" \
  -H "Authorization: Bearer $PLATFORM_RUNTIME_DEPLOYER_KEY" \
  -H "Content-Type: application/json" \
  -d "$finish_payload" "$SUPABASE_URL/rest/v1/rpc/finish_platform_runtime_transition_v1" >/dev/null
transition_started=false
traffic_switched=false

[[ -n "${PORTAL_HEALTH_URL:-}" ]] || { echo "PORTAL_HEALTH_URL is required for rollback readback" >&2; exit 1; }
health="$(curl --fail --silent --show-error --max-time 10 "${PORTAL_HEALTH_URL%/}/api/health")"
case "$component" in
  mercari-send) probe="$(jq '.messaging.mercari.send' <<<"$health")" ;;
  mercari-ingestion) probe="$(jq '.messaging.mercari.ingestion' <<<"$health")" ;;
  rakuten-send) probe="$(jq '.messaging.rakuten.send' <<<"$health")" ;;
  rakuten-ingestion) probe="$(jq '.messaging.rakuten.ingestion' <<<"$health")" ;;
  amazon-send) probe="$(jq '.messaging.amazon.spapi_send' <<<"$health")" ;;
  amazon-ingestion) probe="$(jq '.messaging.amazon.mail_ingestion' <<<"$health")" ;;
esac
jq -e --arg platform "$platform" --arg role "$role" \
  --arg contract "$(jq -r '.contract_version' "$manifest")" \
  '.platform == $platform and .role == $role and .contract_version == $contract and (.status == "ready" or ($platform == "amazon" and $role == "send" and .status == "unavailable"))' \
  <<<"$probe" >/dev/null
printf '%s\n' "rollback verified: ${component} -> ${rollback_target}; other components unchanged"
