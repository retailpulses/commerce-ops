#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_SHA:?RELEASE_SHA is required}"

archive="/tmp/portal-acceptance-relay-$RELEASE_SHA.tgz"
release="/opt/portal-acceptance-relay/releases/$RELEASE_SHA"
vhost="/etc/nginx/conf.d/seller-share.conf"
backup="${vhost}.portal-acceptance-backup"

test -f "$archive"
test -f /etc/portal-acceptance-relay.env
test "$(stat -c '%U:%G:%a' /etc/portal-acceptance-relay.env)" = "root:root:600"
test -f "$vhost"

if ! id portal-acceptance-relay >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin portal-acceptance-relay
fi

install -d -o root -g root -m 0755 "$release"
tar -xzf "$archive" -C "$release"
chown -R root:root "$release"
chmod -R u=rwX,go=rX "$release"
install -o root -g root -m 0644 "$release/portal-acceptance-relay.service" /etc/systemd/system/portal-acceptance-relay.service
install -o root -g root -m 0644 "$release/nginx-global.conf" /etc/nginx/conf.d/00-portal-acceptance-relay.conf
install -d -o root -g root -m 0755 /etc/nginx/snippets
install -o root -g root -m 0644 "$release/nginx-location.conf" /etc/nginx/snippets/portal-acceptance-relay-location.conf

cp -a "$vhost" "$backup"
VHOST="$vhost" python3 <<'PY'
import os
from pathlib import Path

path = Path(os.environ["VHOST"])
text = path.read_text()
include = "    include /etc/nginx/snippets/portal-acceptance-relay-location.conf;\n"
if include.strip() in text:
    raise SystemExit(0)

blocks = []
start = None
depth = 0
for index, line in enumerate(text.splitlines(keepends=True)):
    stripped = line.strip()
    if start is None and stripped == "server {":
        start = index
        depth = 0
    if start is not None:
        depth += line.count("{") - line.count("}")
        if depth == 0:
            blocks.append((start, index))
            start = None

lines = text.splitlines(keepends=True)
for start, end in blocks:
    body = "".join(lines[start : end + 1])
    if "server_name seller-share.homesbliss.net;" not in body or "listen 443" not in body:
        continue
    for index in range(start + 1, end):
        if lines[index].lstrip().startswith("location "):
            lines.insert(index, include + "\n")
            path.write_text("".join(lines))
            raise SystemExit(0)
raise SystemExit("seller-share HTTPS server block was not found")
PY

if ! nginx -t; then
  cp -a "$backup" "$vhost"
  rm -f /etc/nginx/conf.d/00-portal-acceptance-relay.conf /etc/nginx/snippets/portal-acceptance-relay-location.conf
  nginx -t
  exit 1
fi

ln -sfn "$release" /opt/portal-acceptance-relay/current.next
mv -Tf /opt/portal-acceptance-relay/current.next /opt/portal-acceptance-relay/current
systemctl daemon-reload
systemctl enable --now portal-acceptance-relay.service
systemctl restart portal-acceptance-relay.service
systemctl reload nginx
curl -fsS --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:3010/healthz
systemctl is-active --quiet portal-acceptance-relay.service
rm -f "$archive"
