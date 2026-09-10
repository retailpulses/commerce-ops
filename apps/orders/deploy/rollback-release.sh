#!/usr/bin/env bash
set -Eeuo pipefail

release_root=${ORDER_RELEASE_ROOT:-/opt/order-mgmt}
unit=${ORDER_SYSTEMD_UNIT:-rp-order-mgmt-api.service}
nginx_config=${ORDER_NGINX_CONFIG:-/etc/nginx/conf.d/portal.conf}
target_sha=${1:-}
mode=apply
if [[ $target_sha == --check ]]; then
  mode=check
  shift
  target_sha=${1:-}
fi

if [[ $EUID -ne 0 ]]; then
  echo 'error: rollback must run as root' >&2
  exit 1
fi
if [[ ! $target_sha =~ ^[0-9a-f]{40}$ ]]; then
  echo 'usage: rollback-release.sh <40-character-release-sha>' >&2
  exit 2
fi

current=$release_root/current
target=$release_root/releases/$target_sha
env_file=$release_root/.env
health_port=${ORDER_HEALTH_PORT:-8790}
exec 9>/run/lock/order-release.lock
if ! flock -n 9; then
  echo 'error: another Order deploy or rollback is in progress' >&2
  exit 1
fi
old_release=$(readlink -f "$current")
old_sha=${old_release##*/}

for required in \
  "$target/portal-api/src/server.mjs" \
  "$target/portal-api/node_modules" \
  "$target/portal/dist/index.html" \
  "$target/deploy/$unit" \
  "$target/deploy/portal-nginx.conf" \
  "$env_file"; do
  [[ -e $required ]] || { echo "error: missing rollback input: $required" >&2; exit 1; }
done
if [[ $mode == check ]]; then
  echo "rollback check passed: $old_sha -> $target_sha"
  exit 0
fi
if [[ $old_sha == "$target_sha" ]]; then
  echo "release $target_sha is already current"
  exit 0
fi

rollback_tmp=$(mktemp -d "$release_root/.rollback.XXXXXX")
cp -a "$env_file" "$rollback_tmp/env"
cp -a "$nginx_config" "$rollback_tmp/nginx.conf"
cp -a "/etc/systemd/system/$unit" "$rollback_tmp/unit"
if [[ -f $release_root/.previous-release ]]; then
  cp -a "$release_root/.previous-release" "$rollback_tmp/previous-release"
fi
rollback_started=0

cleanup() {
  rm -rf -- "$rollback_tmp"
}

restore_previous() {
  local code=${1:-1}
  trap - ERR INT TERM
  set +e
  if [[ $rollback_started != 1 ]]; then
    cleanup
    trap - EXIT
    exit "$code"
  fi
  echo "rollback failed; restoring $old_sha" >&2
  local restore_failed=0
  ln -sfn "$old_release" "$current.restore" || restore_failed=1
  mv -Tf "$current.restore" "$current" || restore_failed=1
  cp -a "$rollback_tmp/env" "$env_file" || restore_failed=1
  cp -a "$rollback_tmp/nginx.conf" "$nginx_config" || restore_failed=1
  cp -a "$rollback_tmp/unit" "/etc/systemd/system/$unit" || restore_failed=1
  if [[ -f $rollback_tmp/previous-release ]]; then
    cp -a "$rollback_tmp/previous-release" "$release_root/.previous-release" || restore_failed=1
  else
    rm -f -- "$release_root/.previous-release" || restore_failed=1
  fi
  systemctl daemon-reload || restore_failed=1
  nginx -t >/dev/null || restore_failed=1
  systemctl reload nginx || restore_failed=1
  systemctl restart "$unit" || restore_failed=1
  if [[ $restore_failed == 0 ]]; then
    cleanup
  else
    echo "automatic restore was incomplete; protected recovery data remains at $rollback_tmp" >&2
  fi
  trap - EXIT
  exit "$code"
}
trap cleanup EXIT
trap 'restore_previous $?' ERR
trap 'restore_previous 130' INT TERM

# Published SPA files must remain readable by the unprivileged Nginx worker.
find "$target/portal/dist" -type d -exec chmod 0755 {} +
find "$target/portal/dist" -type f -exec chmod 0644 {} +

env_tmp=$(mktemp "$rollback_tmp/env.XXXXXX")
awk '!/^RELEASE_SHA=/ && !/^RELEASE_BUILT_AT=/' "$env_file" > "$env_tmp"
printf 'RELEASE_SHA=%s\nRELEASE_BUILT_AT=%s\n' "$target_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$env_tmp"
chown --reference="$env_file" "$env_tmp"
chmod 0600 "$env_tmp"
rollback_started=1
mv "$env_tmp" "$env_file"

printf '%s\n' "$old_release" > "$release_root/.previous-release"
ln -sfn "$target" "$current.rollback"
mv -Tf "$current.rollback" "$current"
install -m 0644 "$target/deploy/$unit" "/etc/systemd/system/$unit"
install -m 0644 "$target/deploy/portal-nginx.conf" "$nginx_config"
systemctl daemon-reload
systemctl enable "$unit" >/dev/null
nginx -t
systemctl reload nginx
systemctl restart "$unit"

health_code=000
for _ in 1 2 3 4 5; do
  health_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    "http://127.0.0.1:${health_port}/health" || true)
  [[ $health_code == 200 ]] && break
  sleep 3
done
[[ $health_code == 200 ]]
curl -sS --max-time 10 "http://127.0.0.1:${health_port}/api/release" \
  | jq -e --arg sha "$target_sha" \
      '.application == "order" and .contract_version == 1 and .release_sha == $sha' >/dev/null
[[ $(systemctl is-active "$unit") == active ]]
[[ $(systemctl is-enabled "$unit") == enabled ]]

trap - ERR INT TERM EXIT
cleanup
echo "rollback complete: $old_sha -> $target_sha"
