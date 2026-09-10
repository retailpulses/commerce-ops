# Portal VPS Cutover — Phase 2b Runbook

Date: 2026-07-28
Status: Production cutover complete; legacy Worker UI retired 2026-08-04

## Objective

Cut over the Portal UI + API from the Cloudflare Worker to the ConoHa VPS, eliminating the PORTAL_KV dependency and enabling the Worker scope reduction in Phase 4.

## Pre-flight Checklist

- [x] Phase 2a complete — all KV→Supabase adapters implemented
- [x] React portal app builds (tsc + vite, 289KB JS / 23KB CSS)
- [x] Portal API syntax-checks pass (4 files)
- [x] Security headers, CORS, body size limits in place
- [x] KV export tooling ready (scripts/kv-export-dry-run.mjs)
- [x] 806 tests pass, 0 failures
- [ ] KV export dry-run against production Worker
- [x] Supabase idempotency_guards migration applied to production (2026-07-28 via psql)
- [ ] Portal API .env file created on VPS with all required secrets
- [ ] nginx config deployed and validated
- [ ] SSL certificate configured (Let's Encrypt / existing)

## Architecture After Cutover

```
Browser → Cloudflare Tunnel → VPS nginx:443
                                  ├── /        → portal/dist/ (SPA static files)
                                  └── /api/    → 127.0.0.1:8790 (portal-api Hono)
                                                     │
                                                     ├── Supabase (service_role)
                                                     └── VPS Relay (Mercari messages)
```

Worker still runs cron pipeline phases — only Portal UI/API moves.

## Step-by-Step

### Step 1: Build Portal SPA

```bash
cd portal && npm ci && npm run build
# Output: portal/dist/
```

### Step 2: Deploy Portal API to VPS

```bash
# On VPS (deploy-api.yml does this automatically):
cd /opt/OrderMgmt
git fetch origin
git checkout main  # after merge; use feat/rakuten-portal-pipeline-v2 if deploying pre-merge

# Create .env (secrets — never commit)
cat > /opt/OrderMgmt/.env << 'EOF'
SUPABASE_SERVICE_ROLE_KEY=<from master_credentials.md>
SUPABASE_ANON_KEY=<from master_credentials.md>
ORDER_MGMT_ADMIN_SECRET=<from master_credentials.md>
BASEROW_DATABASE_TOKEN=<from master_credentials.md>
MERCARI_RELAY_SECRET=<from master_credentials.md>
PORTAL_ACCESS_TOKEN=<from master_credentials.md>
OPENAI_API_KEY=<from master_credentials.md>
EOF

# Install and start
cp deploy/rp-order-mgmt-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable rp-order-mgmt-api
systemctl start rp-order-mgmt-api

# Verify
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/health/deep
```

### Step 3: Deploy SPA + nginx

```bash
# Copy SPA build to nginx root
rsync -av portal/dist/ /usr/share/nginx/html/

# Deploy nginx config
cp portal/nginx.conf /etc/nginx/sites-available/portal
ln -sf /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### Step 4: Apply Supabase Migration

NOTE: `supabase db push` does NOT work against production — the `cli_login_postgres`
pooler user lacks DDL permissions on the public schema (by design).

```bash
# Apply via psql as postgres superuser (credentials in master_credentials.md):
PGPASSWORD='<db-password>' psql \
  -h db.gqeyfhshxdiyhugvmbuk.supabase.co \
  -p 5432 -U postgres -d postgres \
  -f supabase/migrations/20260728012328_add_idempotency_guards.sql

# Verify table exists:
# SELECT * FROM idempotency_guards LIMIT 1;

# Sync migration history (so supabase db push skips it):
# INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
# VALUES ('20260728012328', 'add_idempotency_guards', ARRAY[...]);
```

### Step 5: KV Export & Verification

```bash
# Dry-run: list all KV keys by prefix
CLOUDFLARE_API_TOKEN=<token> \
CLOUDFLARE_ACCOUNT_ID=<account> \
node scripts/kv-export-dry-run.mjs

# Save the JSON report for migration verification
node scripts/kv-export-dry-run.mjs --json > kv-export-$(date +%Y%m%d).json
```

### Step 6: Smoke Tests

```bash
# Auth gate check — unauthenticated request must return 401
curl -s -o /dev/null -w "%{http_code}" \
  https://order.homesbliss.net/api/portal/summary
# Expected: 401

# Health check
curl https://order.homesbliss.net/health

# Portal API (authenticated)
curl -H "Authorization: Bearer $PORTAL_ACCESS_TOKEN" \
  https://order.homesbliss.net/api/portal/summary

# All endpoints
for path in \
  /api/portal/summary \
  /api/portal/orders \
  /api/portal/templates \
  /api/portal/fee-orders \
  /api/portal/presale
do
  echo "=== $path ==="
  curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $PORTAL_ACCESS_TOKEN" \
    "https://order.homesbliss.net$path"
  echo
done

# Confirm endpoint (POST)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $PORTAL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://order.homesbliss.net/api/portal/orders/test-id/confirm"
# Expected: 404 or 200 (depends on order existence)
```

### Step 7: Monitor (24-48 hours)

- Watch portal-api logs: `journalctl -u rp-order-mgmt-api -f`
- Check Supabase idempotency_guards for new rows (auto-approval messages)
- Verify template CRUD works (create/edit/delete a test template)
- Verify message read/unread state persists across page loads
- Monitor Worker health (pipeline phases continue to run)

## Rollback Plan

The inline Worker UI is retired and is no longer a rollback target. If the VPS
portal has a critical failure, redeploy the last known-good React portal/API
commit through `deploy-api.yml`. The Worker `/` browser route and `/portal`
redirect to `https://order.homesbliss.net/`; `/api/portal/*` remains available
for compatibility and emergency diagnostics.

## Post-Cutover Cleanup (after 7-day soak)

- [ ] Remove PORTAL_KV binding from wrangler.toml
- [ ] Delete KV namespace (Cloudflare dashboard)
- [ ] Remove portal route handlers from worker/index.js
- [x] Remove portal-ui.mjs (legacy inline Worker UI retired 2026-08-04)
- [ ] Worker scope reduction → Phase 4a

## Known Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Auto-approval messages fail on VPS | Low | Medium | Idempotency guard dual-path; Worker still handles if KV present |
| Template data loss during migration | Low | High | KV not deleted until 7-day soak; templates-store.mjs tested |
| Message state divergence (KV vs Supabase) | Low | Medium | Dual-write in buyer-messages.mjs; KV still authoritative during soak |
| Portal API OOM/crash | Low | Medium | systemd Restart=on-failure; nginx returns 502 gracefully |
| nginx misconfiguration | Medium | High | nginx -t before reload; rollback config ready |
