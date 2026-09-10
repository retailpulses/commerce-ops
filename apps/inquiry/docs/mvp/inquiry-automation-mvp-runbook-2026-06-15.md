# Inquiry Automation MVP - Operator Runbook

**Date:** 2026-06-15
**Target:** Cloudflare Worker `inquiry-automation-worker`
**Python fallback:** `inquiry-automation` (local)

---

## 1. Local Verification (Python)

```bash
cd /Users/user/Documents/Retailpulses/20_REPOS/inquiry-automation

# Source credentials without printing values
set -a
source .env
set +a

# Run test suite
python3 -m pytest tests/ -q

# Dry-run pipeline (safe - logs only, no Baserow writes)
python3 -m scripts.run_pipeline --dry-run --limit 3

# View operator queue
python3 -m scripts.operator_queue --limit 20
```

Expected: 190 tests pass, pipeline dry-run logs intended actions, queue shows pending inquiries.

---

## 2. Cloudflare Worker Local Dev

```bash
cd apps/worker

# Type check
npx tsc --noEmit

# Run unit tests (fork pool - use --pool forks explicitly)
npx vitest run --pool forks

# Start local dev server with test-scheduled mode
npx wrangler dev --test-scheduled
```

### Local smoke test endpoints

```bash
# Health check
curl http://localhost:8787/health

# Dry-run classify on explicit rows (safe)
curl -X POST 'http://localhost:8787/run?dryRun=true&rowIds=1,2,3&step=classify' \
  -H "Authorization: Bearer dev-token"

# Dry-run full pipeline
curl -X POST 'http://localhost:8787/run?dryRun=true&limit=3&step=all' \
  -H "Authorization: Bearer dev-token"

# Test cron trigger manually (local)
curl -X POST 'http://localhost:8787/__scheduled?cron=*/30+*+*+*+*'
```

---

## 3. Cloudflare Secret Setup

All secrets must be set via `wrangler secret put` - never commit to `.env` or `wrangler.toml [vars]`.

```bash
cd apps/worker

# Set required secrets (replace <value> with actual secret values)
npx wrangler secret put BASEROW_API_TOKEN
# Paste value at prompt (not in command line)

npx wrangler secret put OPENAI_API_KEY
# Paste value at prompt

npx wrangler secret put ADMIN_TOKEN
# Paste value at prompt - use a strong random token
```

**Note:** Do not include secret values in scripts, logs, or documentation. The `[vars]` section in `wrangler.toml` must never contain secrets.

### Verify secrets are set

```bash
npx wrangler secret list
```

Expected output lists three secret names (values are masked).

---

## 4. Deploy Worker (Dry-Run Mode)

```bash
cd apps/worker

# Deploy (DRY_RUN=true by default in wrangler.toml)
npx wrangler deploy

# Verify health
curl https://inquiry-automation-worker.<your-subdomain>.workers.dev/health
```

Expected: health endpoint returns `{"ok":true,"dryRun":true}`.

If deployment fails, check:
- KV namespace `SHOP_CACHE` exists and id in `wrangler.toml` is current
- Durable Object migration `v1` has been applied
- Wrangler is authenticated (`npx wrangler whoami`)

---

## 5. Dry-Run Smoke on Production

Run with explicit `rowIds` from known production Received rows:

```bash
DRY_RUN_URL="https://inquiry-automation-worker.<your-subdomain>.workers.dev"
ADMIN_TOKEN="<the-token-you-set>"

# Step 1: Dry-run classify on specific rows
curl -X POST "$DRY_RUN_URL/run?dryRun=true&rowIds=101,102,103&step=classify" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Step 2: Dry-run draft on specific rows
curl -X POST "$DRY_RUN_URL/run?dryRun=true&rowIds=101,102,103&step=draft" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Step 3: Dry-run full pipeline
curl -X POST "$DRY_RUN_URL/run?dryRun=true&rowIds=101,102,103&step=all" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Verify:**
- Response status is `completed`
- No errors in response
- Baserow rows are **not** modified (check manually or compare before/after)
- Console logs (`wrangler tail`) show proposed write actions

If dry-run reveals classification/draft mismatches, fix locally, re-deploy, and repeat.

---

## 6. Explicit-Row Live Pilot

Run on the same rows without dry-run:

```bash
# Record row state before mutation (check Baserow directly)
# Then:
curl -X POST "$DRY_RUN_URL/run?dryRun=false&rowIds=101,102,103&step=all" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Verify immediately after run:**
- `wrangler tail` shows no errors
- Baserow rows show correct status transitions (Received -> Followed-up -> Answered)
- Inquiry Type and Products are populated correctly
- Draft text is coherent and matches expected template/LLM output

**Rollback if pilot fails:**
- Status transitions wrong -> check config.ts option IDs
- Products not linked -> check product matching logic
- Draft contains nonsense -> check template registry / LLM prompt

---

## 7. Cron Enablement Decision

Cron may be enabled only after ALL of these are true:

- [ ] Worker dry-run smoke produces correct proposed payloads (step 5)
- [ ] Explicit-row live pilot produces correct Baserow mutations (step 6)
- [ ] Python pipeline is **not** running cron (`crontab -l` shows no inquiry-automation entries)
- [ ] DRY_RUN has been explicitly set to `false` in the Worker production environment
- [ ] Rollback steps are accessible (this runbook)

### Enable cron

The cron trigger is already configured in `wrangler.toml`:
```toml
[triggers]
crons = ["*/30 * * * *"]
```

Cron is active as long as the Worker is deployed with this trigger. If you need to enable it after deploying with cron disabled:

1. Uncomment or add the `[triggers]` section to `wrangler.toml`
2. Redeploy: `npx wrangler deploy`

### Monitor first cron runs

```bash
# Tail logs for first 3 cron executions
npx wrangler tail
```

Expected: `classify -> draft` sequence runs approx every 30 minutes. Each run logs processed count, skipped count, LLM calls.

---

## 8. Rollback / Disable Steps

### Emergency rollback (immediate stop)

```bash
# Option A: Redeploy with DRY_RUN=true and cron disabled
# Edit wrangler.toml to ensure DRY_RUN="true" and comment out [triggers]
npx wrangler deploy

# Option B: Remove cron trigger without changing DRY_RUN
# Comment out [triggers] section in wrangler.toml
npx wrangler deploy
```

### Full rollback to Python pipeline

```bash
# 1. Disable Worker cron
#    Edit wrangler.toml: comment out [triggers]
npx wrangler deploy

# 2. Re-enable Python cron
cd /Users/user/Documents/Retailpulses/20_REPOS/inquiry-automation
crontab crontab.example

# 3. Verify Python pipeline works
python3 -m scripts.run_pipeline --dry-run --limit 3

# 4. Confirm Worker writes are not running concurrently
#    Set DRY_RUN="true" in wrangler.toml and redeploy
```

### Post-rollback verification

```bash
# Python pipeline processes correctly in dry-run mode
python3 -m scripts.run_pipeline --dry-run --limit 20

# No active Worker mutations
curl https://inquiry-automation-worker.<your-subdomain>.workers.dev/health
# Confirm "dryRun": true
```

---

## 9. Admin Operations

### Reset cursor

```bash
curl -X POST "$DRY_RUN_URL/admin/reset-cursor?job=master-handler&to=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### View state (cursor, lock status, last run metadata)

```bash
curl "$DRY_RUN_URL/admin/state?job=master-handler" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Release stuck lock

```bash
curl -X POST "$DRY_RUN_URL/admin/release-lock?job=master-handler" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 10. Troubleshooting

### Symptom: `wrangler deploy` fails with "KV namespace not found"

Check that `SHOP_CACHE` KV namespace exists and its ID in `wrangler.toml` is correct:
```bash
npx wrangler kv namespace list
```

### Symptom: cron runs but logs "Unknown cron schedule"

Check `controller.cron` value against the switch case in `src/index.ts`. The Worker expects `*/30 * * * *` to match the `wrangler.toml` trigger.

### Symptom: Baserow writes not taking effect

- Confirm `user_field_names=true` in all API requests
- Verify numeric option IDs for select fields match live Baserow
- Check `ADMIN_TOKEN` is set and matches the auth header
- Check `wrangler tail` for 4xx/5xx from Baserow API

### Symptom: DO lock held across cron runs

```bash
# Release lock manually
curl -X POST "$DRY_RUN_URL/admin/release-lock" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Symptom: no rows processed (0 classified, 0 drafted)

- Check Baserow has Received rows (`Status=Received` and no existing `Inquiry Type`)
- Verify `BASEROW_API_TOKEN` has read/write access to table 886975
- Run with explicit `rowIds` to isolate fetch vs filter issue
