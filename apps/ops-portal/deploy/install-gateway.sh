#!/bin/sh
set -eu

SHA="${1:?exact 40-character release SHA required}"
case "$SHA" in *[!0-9a-f]*|???????????????????????????????????????|?????????????????????????????????????????*) echo "invalid SHA" >&2; exit 2;; esac

SOURCE="${2:-.}"
ROOT=/opt/ops-portal-gateway
RELEASE="$ROOT/releases/$SHA"
CURRENT="$ROOT/current"
ENV_FILE=/etc/ops-portal-gateway.env
UNIT=ops-portal-gateway.service
test -f "$SOURCE/gateway/server.mjs"
test -f "$SOURCE/deploy/$UNIT"
test -f "$ENV_FILE"

exec 9>/run/lock/ops-portal-gateway-deploy.lock
flock -n 9 || { echo "another gateway deploy is in progress" >&2; exit 1; }

id ops-gateway >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin ops-gateway
install -d -o root -g root -m 0755 "$ROOT" "$ROOT/releases" "$RELEASE/gateway"
install -o root -g root -m 0644 "$SOURCE"/gateway/*.mjs "$RELEASE/gateway/"

DEPLOY_TMP=$(mktemp -d "$ROOT/.deploy.XXXXXX")
OLD_RELEASE=$(readlink -f "$CURRENT" 2>/dev/null || true)
cp -a "$ENV_FILE" "$DEPLOY_TMP/env"
if test -f "/etc/systemd/system/$UNIT"; then cp -a "/etc/systemd/system/$UNIT" "$DEPLOY_TMP/unit"; fi
if test -f "$ROOT/.previous-release"; then cp -a "$ROOT/.previous-release" "$DEPLOY_TMP/previous"; fi
CHANGED=0
ENV_TMP=

restore_previous() {
  CODE=$?
  trap - EXIT HUP INT TERM
  set +e
  if test "$CHANGED" = 1; then
    if test -n "$OLD_RELEASE"; then
      ln -sfn "$OLD_RELEASE" "$CURRENT.restore"
      mv -Tf "$CURRENT.restore" "$CURRENT"
    else
      rm -f "$CURRENT"
    fi
    cp -a "$DEPLOY_TMP/env" "$ENV_FILE"
    if test -f "$DEPLOY_TMP/unit"; then cp -a "$DEPLOY_TMP/unit" "/etc/systemd/system/$UNIT"; fi
    if test -f "$DEPLOY_TMP/previous"; then
      cp -a "$DEPLOY_TMP/previous" "$ROOT/.previous-release"
    else
      rm -f "$ROOT/.previous-release"
    fi
    systemctl daemon-reload
    systemctl restart "$UNIT"
  fi
  if test -n "$ENV_TMP"; then rm -f "$ENV_TMP"; fi
  rm -rf "$DEPLOY_TMP"
  exit "$CODE"
}
trap restore_previous EXIT
trap 'exit 130' HUP INT TERM

ENV_TMP=$(mktemp /etc/ops-portal-gateway.env.XXXXXX)
awk '!/^RELEASE_SHA=/' "$ENV_FILE" > "$ENV_TMP"
printf 'RELEASE_SHA=%s\n' "$SHA" >> "$ENV_TMP"
chown --reference="$ENV_FILE" "$ENV_TMP"
chmod 0600 "$ENV_TMP"
CHANGED=1
mv "$ENV_TMP" "$ENV_FILE"
ENV_TMP=

if test -n "$OLD_RELEASE"; then printf '%s\n' "$OLD_RELEASE" > "$ROOT/.previous-release"; fi
ln -sfn "$RELEASE" "$CURRENT.new"
mv -Tf "$CURRENT.new" "$CURRENT"
install -o root -g root -m 0644 "$SOURCE/deploy/$UNIT" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"

for ATTEMPT in 1 2 3 4 5; do
  HEALTH=$(curl --fail --silent --show-error http://127.0.0.1:8090/_gateway/health 2>/dev/null || true)
  echo "$HEALTH" | grep -q "\"release_sha\":\"$SHA\"" && break
  test "$ATTEMPT" = 5 && { echo "gateway exact-SHA health failed" >&2; exit 1; }
  sleep 2
done

trap - EXIT HUP INT TERM
rm -rf "$DEPLOY_TMP"
echo "gateway release $SHA active"
