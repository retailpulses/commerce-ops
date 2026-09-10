# Operations

Last reviewed: 2026-09-07 — current Cloudflare/VPS split and target canonical orchestrator recovery controls.

## Health Checks

### Worker
```bash
curl https://rp-order-mgmt.jim-yang-3c5.workers.dev/health
# {"ok":true,"service":"rp-order-mgmt","release_version":"...","ts":"..."}
```

### Relay (local on VPS)
```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"service":"rp-order-mgmt-relay","egress_ip":"160.251.141.110"}
```

### Relay (via Cloudflare Tunnel)
```bash
curl https://worker-order.homesbliss.net/health
```

---

## Logs

### Worker
```bash
npm run tail:prod
# or
npx wrangler tail --env production
```

### Bounded Supabase egress capture

Dispatch `.github/workflows/monitor-worker-egress.yml` for 5, 15, or 30
minutes. It uses the existing scoped Cloudflare deployment token to tail the
production Worker, filters out all non-`supabase_egress` logs, and retains the
sanitized artifact for seven days. Do not upload an unfiltered Worker tail as
incident evidence because other logs may contain order identifiers.

### Relay
```bash
# Systemd journal
journalctl -u rp-order-mgmt-relay.service -n 50 --no-pager
journalctl -u rp-order-mgmt-relay.service -f   # follow
```

---

## Systemd Commands

```bash
# Status
systemctl status rp-order-mgmt-relay.service

# Restart
sudo systemctl restart rp-order-mgmt-relay.service

# Stop
sudo systemctl stop rp-order-mgmt-relay.service

# Start
sudo systemctl start rp-order-mgmt-relay.service

# Enable on boot
sudo systemctl enable rp-order-mgmt-relay.service
```

---

## Common Failure Cases

### External operation is `RESERVED` or `UNKNOWN_RESULT`

Do not retry or release it based on age. First obtain authoritative provider
evidence that the exact operation was applied or was not applied. Then run the
single-operation audit without `--confirm-write`:

```bash
npm run resolve:external-operation -- \
  --operation-key '<exact-key>' \
  --expected-status UNKNOWN_RESULT \
  --outcome APPLIED \
  --evidence-ref '<provider-readback-reference>' \
  --reason '<reviewed explanation of the evidence>' \
  --resolved-by '<operator identity>'
```

Review the current row and proposal. Only an explicitly approved mutation adds
`--confirm-write`. Success requires readback of both the operation status and
the immutable `external_operation_resolutions` audit row. Never place secrets
or customer content in arguments, evidence references, reasons, or logs.

### Relay health returns non-200
1. Check service status: `systemctl status rp-order-mgmt-relay.service`
2. Check journal: `journalctl -u rp-order-mgmt-relay.service -n 50`
3. Check port binding: `ss -tlnp | grep 8787`
4. Check egress IP: should be `160.251.141.110`
5. Verify env vars are set in systemd unit

### Worker cron not running
1. Check wrangler deploy succeeded
2. Verify cron triggers in `wrangler.toml` match expected schedule
3. Check Cloudflare dashboard → Workers → rp-order-mgmt → Triggers

This is the current production-business-scheduler procedure only. During a
capability cutover, also read the durable `order_scheduler_ownership` entry and
prove the corresponding VPS/Cloudflare owners are not simultaneously active.

### Canonical orchestrator not running
1. Confirm the capability has an approved cutover; do not enable the target timer as a generic failover.
2. Check `order-mgmt-orchestrator.timer` and `.service`, then the exact deployed release SHA.
3. Read `pipeline_orchestration_runs`, `pipeline_steps`, the active lease, and the workload ownership event.
4. Treat a shadow lease as shadow evidence only; it does not prove production ownership.
5. If an external operation is `RESERVED` or `UNKNOWN_RESULT`, reconcile it before restarting a writer or restoring a legacy trigger.

For migrated marketplace order capabilities, inspect the direct local client
and VPS egress rather than treating relay health as an orchestrator dependency.
Worker-owned production capabilities continue to require relay health until
their individual ownership cutover is complete.

### Manual and dry-run safety

- `/admin/run-once` is dry-run only; `confirm_write=true` is rejected.
- `/admin/dry-run` and `/admin/run-once` return `dry_run_unsupported` for a
  write-capable phase until that phase has a tested side-effect-free preview.
- Do not treat admin authentication as production-change approval.
- Execute approved live canaries through the canonical orchestrator with exact
  capability ownership, scope, durable intent and post-run readback.

### Ingest failures
1. Check relay health first (worker calls relay for ingest)
2. Verify relay has `MERCARI_TOKENS_PATH` set and tokens are valid
3. Check Supabase connectivity from both Worker and relay without exposing credentials

### GigaB2B API errors
1. Verify `GIGA_CLIENT_ID` and `GIGA_CLIENT_SECRET` are set as worker secrets
2. Check Giga API status: `https://openapi.gigab2b.com`
3. Verify HMAC signing in `src/lib/giga-client.mjs`

---

## External APIs

| API | URL | Auth |
|-----|-----|------|
| Supabase | Project REST/RPC endpoint | Scoped server credential; service role only where governed |
| GigaB2B | `https://openapi.gigab2b.com` | HMAC-SHA256 |
| Mercari Shops | Current Worker via relay; target VPS orchestrator via local IPv4 adapter | Secret tokens on VPS |
| Rakuten RMS orders | Current Worker via relay; target VPS orchestrator via local IPv4 adapter | ESA credentials on VPS |

---

## Cloudflare

- **Account**: jim-yang-3c5
- **Worker name**: rp-order-mgmt
- **Tunnel**: rp-order-mgmt-relay (Zero Trust → `localhost:8787`)
- **Wrangler**: `wrangler.toml` at repo root
