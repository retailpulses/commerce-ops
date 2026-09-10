# Deployment

## Worker Deploy

Trigger: `deploy-worker.yml` → `workflow_dispatch`

### Flow
1. Select environment: `dev` or `production`
2. Production only allowed from `main` branch
3. Checks out exact GitHub Actions commit
4. `npm ci` → `npm test` → `wrangler deploy --var RELEASE_VERSION:<full_git_sha>`

The production workflow supplies the exact 40-character `${GITHUB_SHA}` as
`RELEASE_VERSION`. This value appears in `/health` and in Supabase
`x-client-info` attribution. Do not deploy a production release with the static
fallback version from `wrangler.toml`.
5. Smoke test against Worker health endpoint

### Smoke test
- Checks `GET /health` on the deployed Worker
- Accepts HTTP 200, 401, 403, 302 (CF Access gate)
- Retries up to 5 times with 5s delays

### CLI deploy
```bash
npm run deploy:worker:prod
npm run deploy:worker:dev
```

---

## Relay Deploy

Trigger: `deploy-relay.yml` → `workflow_dispatch`

### Flow
1. Select environment: `dev` or `production`
2. Production only allowed from `main` branch
3. Preflight checks on VPS (repo exists, clean tree, commit reachable)
4. SSH: `git checkout` exact SHA → `npm ci --omit=dev` → `systemctl restart`
5. Health check: `curl http://127.0.0.1:8787/health`

### Systemd unit
- Service: `rp-order-mgmt-relay.service`
- WorkingDirectory: `/opt/OrderMgmt`
- ExecStart: `/usr/bin/node relay/server.mjs`

---

## GitHub Secrets Required

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN_WORKERS_DEPLOY` | Wrangler deploy |
| `VPS_HOST` | Relay deploy SSH host |
| `VPS_USER` | Relay deploy SSH user |
| `VPS_SSH_KEY` | Relay deploy SSH private key |
| `VPS_PORT` | Relay deploy SSH port (optional, default 22) |

---

## Rollback

### Worker
```bash
git checkout <previous-good-sha-or-tag>
npm ci
npm run deploy:worker:prod
```

### Relay
Trigger `deploy-relay.yml` with `ref` input set to a known-good commit SHA or tag.

Or manually on VPS:
```bash
cd /opt/OrderMgmt
git fetch origin
git checkout <previous-good-sha-or-tag>
npm ci --omit=dev
sudo systemctl restart rp-order-mgmt-relay.service
curl -f http://127.0.0.1:8787/health
```

---

## Dev Deploy — ⚠️ Intentionally Skipped

Dev Worker deploy (`--env dev`) is **intentionally skipped** until proper environment isolation is configured.

### Risk

The current `wrangler.toml` uses top-level `[triggers]` and `[vars]`. Without a `[env.dev]` override, deploying to dev would:

1. **Enable all 7 cron triggers on the dev worker** — double-processing orders alongside production
2. **Write to the same production Baserow tables** (table IDs are shared)
3. **Call the same production VPS relay** (`MERCARI_RUNNER_BASE_URL`)

Any of these could corrupt order data or trigger duplicate Mercari API actions.

### Current mitigation

- `wrangler deploy --dry-run --env dev` was run successfully on 2026-06-07 — validates deployment mechanics without deploying
- The dev smoke URL (`rp-order-mgmt-dev.jim-yang-3c5.workers.dev`) is reserved for future use

### Future hardening

Before enabling dev deploy, create a proper `[env.dev]` section:

```toml
[env.dev]
triggers = { crons = [] }                  # Disable all crons
[env.dev.vars]
WORKER_ENV = "dev"
BASEROW_MERCARI_SALES_ORDER_TABLE_ID = ""  # Dev-only table
BASEROW_GIGA_SHIPMENT_ORDER_TABLE_ID = ""  # Dev-only table
MERCARI_RUNNER_BASE_URL = ""               # Dev relay or mock
```

And set dev-only secrets via `wrangler secret put --env dev`.

---

## Production Branch Rule

Production deploys are **only allowed from `main` branch**. The workflow gates this check.
