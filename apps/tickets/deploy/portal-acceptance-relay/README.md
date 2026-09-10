# VPS Portal acceptance relay

Read-only, fixed-target relay for canonical `ops.homesbliss.net` CI acceptance.
It runs on the existing ConoHa VPS behind the existing HTTPS vhost at:

`https://seller-share.homesbliss.net/ops-portal-acceptance/accept?target=<name>`

Allowed targets are only `inquiry`, `tickets`, `order`, `ticket-health`,
`inquiry-release`, `tickets-release`, and `order-release`.
The service never accepts an arbitrary URL, never follows redirects, and only
accepts authenticated `GET` requests. Caller IPs are hashed before structured
journal logging; authorization and upstream credentials are never logged.

The three release targets expose application-owned, read-only release
contracts through the canonical Portal so CI can reject a healthy but stale
owner commit.

## Runtime

- system user: `portal-acceptance-relay` (no login/home)
- service: `portal-acceptance-relay.service`
- loopback listener: `127.0.0.1:3010`
- release root: `/opt/portal-acceptance-relay/releases/<git-sha>`
- current symlink: `/opt/portal-acceptance-relay/current`
- secrets: `/etc/portal-acceptance-relay.env`, root-owned mode `0600`
- HTTPS: existing `seller-share.homesbliss.net` Nginx/Let's Encrypt vhost

Required environment variables are `RELAY_AUTH_TOKEN`,
`CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`. GitHub callers receive
only the independent relay token. Cloudflare Access credentials stay on the
VPS and are not forwarded by callers.

## Verification

```sh
systemctl is-active portal-acceptance-relay.service
curl -fsS https://seller-share.homesbliss.net/ops-portal-acceptance/healthz
journalctl -u portal-acceptance-relay.service -n 50 --no-pager
nginx -t
```

Rollback by repointing `/opt/portal-acceptance-relay/current` to the prior
immutable release, then restart the service. Do not edit release files in
place. Rotate tokens by atomically replacing the protected environment file
and restarting the service.
