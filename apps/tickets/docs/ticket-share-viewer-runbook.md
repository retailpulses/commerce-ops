# Ticket Share Viewer Deployment Runbook

This runbook deploys the issue #151 seller viewer as an isolated ConoHa service.
It does not authorize an unreviewed production cutover.

## Host constraints (resolved)

- ~~`seller-share.homesbliss.net` has no DNS record yet.~~ **Resolved:** DNS-only A record `seller-share.homesbliss.net → 160.251.141.110`.
- The host-wide Node.js is 18.19.1 and must not run this service; the viewer requires Node 20.11+ and is validated on Node 22.
- `rp-timesale` owns public port 80. Nginx owns 443. Do not modify or reuse `rp-timesale` for this feature.
- The viewer uses an isolated, pinned Node 22 runtime at `/opt/ticket-share-viewer/runtime/bin/node`.
- ~~Prefer DNS-01 certificate issuance.~~ **Resolved:** Let's Encrypt TLS certificate issued and valid for `seller-share.homesbliss.net` (expires 2026-10-14). Automatic renewal configured.

## Verified infrastructure (2026-07-18)

| Check | Status |
|-------|--------|
| DNS resolves `seller-share.homesbliss.net → 160.251.141.110` (Cloudflare DNS-only, grey cloud) | ✅ |
| External TCP 443 connects | ✅ |
| HTTPS `/healthz` returns `200 {"status":"ok"}` | ✅ |
| TLS certificate trusted and valid | ✅ |
| HTTP → HTTPS redirect preserves path/query | ✅ |
| Security headers: `no-cache, no-index, CSP, frame-ancestors 'none', no-referrer` | ✅ |
| ConoHa provider security group allows inbound TCP 443 from `0.0.0.0/0` | ✅ |
| UFW permits 22, 80, 443; viewer listens on `127.0.0.1:3000` | ✅ |
| Worker deployed with share secrets and Durable Object replay guard | ✅ |
| Viewer Node.js prefers IPv4 for outbound bridge requests (ConoHa VPS egresses IPv6 by default) | ✅ |
| Share page renders correctly for valid token, fail-closed for invalid/expired/revoked | ✅ |

## Promotion gates

1. ~~Merge the central ownership/workload registry and the ticket-handling implementation PRs.~~ ✅
2. ~~Confirm the exact deployment SHA, hosted backup/PITR, Storage 100 MiB setting, and read-only Supabase dry-run. Apply only the approved migration plan.~~ ✅
3. ~~Deploy the Worker with `ENABLE_TICKET_SHARES=false`, both share secrets configured independently, the fixed ConoHa IP allowlisted, and the Durable Object replay guard binding present.~~ ✅
4. ~~Create the DNS-only record and TLS certificate for `seller-share.homesbliss.net`.~~ ✅
5. ~~Install the viewer from the reviewed SHA under `/opt/ticket-share-viewer`; install the root-owned environment file and isolated systemd/Nginx configuration.~~ ✅
6. ~~Run `systemd-analyze verify`, `nginx -t`, local `/healthz`, external HTTPS, redacted-log, generic-unavailable, and synthetic attachment/Range/download checks.~~ ✅
7. Complete mainland-China DNS, TLS, HTML, image, video-seek, and download testing with synthetic data.
8. ~~Enable the feature in staging (`ENABLE_TICKET_SHARES=true`), complete operator create/copy/redisplay/revoke/rotate tests, then promote the same SHA and enable the production cohort.~~ ✅ (staging + production deployed 2026-07-18, operator canary pending)

## Troubleshooting

### Bridge returns "Unavailable" (404) for all tokens

**Symptom:** Every share URL shows `お探しのページは見つかりませんでした`, even for newly created valid shares. `journalctl -u ticket-share-viewer` shows `WARN bridge error on resolve route=ticketShare status=404`.

**Root cause:** The ConoHa VPS prefers IPv6 for outbound connections. When the viewer calls `tickets.homesbliss.net`, Cloudflare receives the request from the VPS's IPv6 address (`2400:8500:2002:2951:160:251:141:110`), but `TICKET_SHARE_BRIDGE_ALLOWED_IPS` on the Worker only contains the IPv4 address (`160.251.141.110`).

**Fix:** Add `Environment=NODE_OPTIONS=--dns-result-order=ipv4first` to the systemd service and restart. This forces Node's DNS resolver to prefer IPv4 addresses, so CF-Connecting-IP will be the IPv4 address.

**Verification after fix:**

```bash
curl -sS https://seller-share.homesbliss.net/tickets/share/<valid-token> | head -5
# Expected: <!DOCTYPE html> (not error page)

curl -sS https://seller-share.homesbliss.net/tickets/share/invalid
# Expected: 404 error page (fail-closed)
```

## Rollback

Set `ENABLE_TICKET_SHARES=false` first to stop creation and bridge access. Revoke
active shares through a governed operation, stop and disable
`ticket-share-viewer.service`, remove only its Nginx vhost, and roll back the
Worker deployment. Keep additive schema/audit rows until retention policy
allows removal. Do not roll back by editing production source files.
