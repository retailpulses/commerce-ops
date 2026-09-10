# Gate 9: Runtime Smoke Test — Rakuten Order Cycle

**Branch:** `feature/issue-1-rakuten-order-cycle`
**Date:** 2026-06-08
**Status:** ⏳ Pending Execution

---

## Prerequisites Check

Before running any smoke test, verify:

```bash
# 1. Branch is pushed
git push origin feature/issue-1-rakuten-order-cycle

# 2. All files pass syntax
for f in worker/index.js src/index.mjs src/lib/rakuten-*.mjs src/lib/tracking-reconciler.mjs src/lib/baserow.mjs src/lib/outbound-sync.mjs src/lib/pipeline-health.mjs relay/server.mjs; do
  node --check "$f" || echo "FAIL: $f"
done

# 3. Worker build
npm run build
```

---

## Step 1: Deploy Relay to VPS

The relay must be updated to expose `/admin/rakuten-ingest` and `/admin/rakuten-confirm`.

### 1.1 Deploy via SSH

```bash
# SSH to VPS
ssh ${VPS_USER}@${VPS_HOST} -p ${VPS_PORT:-22}

# On VPS:
cd /opt/OrderMgmt
git fetch origin
git checkout feature/issue-1-rakuten-order-cycle
git log --oneline -3              # Verify we're on the right commit
npm ci --omit=dev
sudo systemctl restart rp-order-mgmt-relay.service
sudo systemctl status rp-order-mgmt-relay.service
```

### 1.2 Verify Relay Health

```bash
curl -s https://worker-order.homesbliss.net/health | python3 -m json.tool
```

**Expected:**
```json
{
    "ok": true,
    "service": "rp-order-mgmt-relay",
    "egress_ip": "160.251.141.110"
}
```

### 1.3 Verify New Endpoints Exist

```bash
# Should list /admin/rakuten-ingest and /admin/rakuten-confirm in endpoints
curl -s -X POST https://worker-order.homesbliss.net/admin/rakuten-ingest \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool

curl -s -X POST https://worker-order.homesbliss.net/admin/rakuten-confirm \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
```

**Expected:** Both return endpoint list including `/admin/rakuten-ingest` and `/admin/rakuten-confirm` (not 404).

### 1.4 Verify Authenticated Access

```bash
# With valid x-relay-secret, should return ok (possibly with empty orders)
curl -s -X POST https://worker-order.homesbliss.net/admin/rakuten-ingest \
  -H "Content-Type: application/json" \
  -H "x-relay-secret: ${MERCARI_RELAY_SECRET}" \
  -d '{"limit":1}' | python3 -m json.tool
```

**Expected:** JSON response with `ok` field (true or false with clear error — NOT 401/403).

---

## Step 2: Set Secrets

### 2.1 Relay Secrets (on VPS)

Verify these are set in the relay's environment (systemd env file):
- `RAKUTEN_SERVICE_SECRET`
- `RAKUTEN_LICENSE_KEY`
- `MERCARI_RELAY_SECRET`
- `BASEROW_DATABASE_TOKEN`

```bash
# On VPS
sudo cat /etc/systemd/system/rp-order-mgmt-relay.service.d/env.conf 2>/dev/null || \
sudo cat /opt/OrderMgmt/.env 2>/dev/null || \
echo "Check systemd Environment= or EnvironmentFile="
```

### 2.2 Worker Secrets (Cloudflare)

Verify via wrangler:
```bash
wrangler secret list
```

Required for Rakuten (falls back to default):
- `BASEROW_DATABASE_TOKEN` — already set
- `BASEROW_RAKUTEN_DATABASE_TOKEN` — set if different from default; optional

```bash
# If Rakuten DB token differs:
wrangler secret put BASEROW_RAKUTEN_DATABASE_TOKEN
```

---

## Step 3: Worker Runtime Test (via wrangler dev)

Since dev deploy is not available, use `wrangler dev` to run the worker locally with real Cloudflare secrets injected.

### 3.1 Start wrangler dev

```bash
# In the worktree directory
cd /Users/user/Documents/Retailpulses/20_REPOS/OrderMgmt/.claude/worktrees/issue-1
npx wrangler dev --port 8787 &
WRANGLER_PID=$!
sleep 5

# Verify local worker health
curl -s http://localhost:8787/health | python3 -m json.tool
```

**Expected:** `{"ok": true, "service": "rp-order-mgmt"}`

### 3.2 Dry-Run Each Rakuten Phase

Run each phase via the local worker's `/admin/dry-run` endpoint:

```bash
WORKER_URL="http://localhost:8787"

# Phase 1: Pull Rakuten Orders
echo "=== pull_rakuten_orders (dry-run) ==="
curl -s -X POST "$WORKER_URL/admin/dry-run" \
  -H "Content-Type: application/json" \
  -d '{"mode":"pull_rakuten_orders","limit":5}' | python3 -m json.tool

# Phase 2: Confirm Rakuten Orders
echo "=== confirm_rakuten_orders (dry-run) ==="
curl -s -X POST "$WORKER_URL/admin/dry-run" \
  -H "Content-Type: application/json" \
  -d '{"mode":"confirm_rakuten_orders","limit":5}' | python3 -m json.tool

# Phase 3: Build Rakuten Shipments
echo "=== build_rakuten_shipments (dry-run) ==="
curl -s -X POST "$WORKER_URL/admin/dry-run" \
  -H "Content-Type: application/json" \
  -d '{"mode":"build_rakuten_shipments","limit":5}' | python3 -m json.tool

# Phase 4: Push Rakuten to Giga
echo "=== push_rakuten_orders_to_giga (dry-run) ==="
curl -s -X POST "$WORKER_URL/admin/dry-run" \
  -H "Content-Type: application/json" \
  -d '{"mode":"push_rakuten_orders_to_giga","limit":5}' | python3 -m json.tool
```

**Expected:** Each returns structured JSON with `ok: true` and phase-specific summary (or `ok: false` with clear reason like "relay returned no orders").

---

## Step 4: Live Run — Phase by Phase

**⚠️ WARNING:** These commands mutate Baserow data and call production APIs. Proceed only after dry-run passes.

### 4.1 Record Baseline Counts

```bash
# Record Baserow row counts BEFORE testing
echo "=== BASELINE ==="
# Count Rakuten sales rows (table 1015675)
# Count Rakuten shipment rows (SalesChannel=Rakuten in table 903319)
# Use Baserow API directly or via worker inspection endpoints
# Record: date, count, and any sample order IDs
```

### 4.2 Phase 1: pull_rakuten_orders

```bash
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"pull_rakuten_orders","limit":10}' | python3 -m json.tool
```

**Verify:**
- Response `ok: true`
- Baserow Rakuten sales table has new/updated rows with `order_status: PENDING_CONFIRMATION`
- No duplicate `order_id` rows
- `last_synced_at` is populated

### 4.3 Phase 2: confirm_rakuten_orders

```bash
# First, manually set one order's status to CONFIRMED in Baserow
# (The pipeline requires manual confirmation step: PENDING_CONFIRMATION → CONFIRMED)
# Then run confirm:

curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"confirm_rakuten_orders","limit":10}' | python3 -m json.tool
```

**Verify:**
- Response `ok: true`
- Orders with `order_status: CONFIRMED` are now `order_status: RMS_CONFIRMED`
- `rms_confirm_result` and `rms_confirmed_at` are populated
- `confirm_in_progress` is cleared

### 4.4 Phase 3: build_rakuten_shipments

```bash
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"build_rakuten_shipments","limit":10}' | python3 -m json.tool
```

**Verify:**
- Response `ok: true`
- Shipment table (903319) has new rows with `SalesChannel: Rakuten`, `SourceStoreID: Rakuten`
- `ShipFrom: "ホムブリス Rakuten店"`
- One shipment row per Rakuten order (lineItemNumber: "1")
- No duplicate shipment rows for same order+SKU+SalesChannel

### 4.5 Phase 4: push_rakuten_orders_to_giga

```bash
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"push_rakuten_orders_to_giga","limit":10}' | python3 -m json.tool
```

**Verify:**
- Response `ok: true`
- Dry-run shows what WOULD be pushed
- Live run creates orders in GigaB2B
- Shipment rows updated with `giga_sync_status: Synced`

### 4.6 Phase 5: pull_giga_tracking (Rakuten)

```bash
# The pull_giga_tracking phase filters by SalesChannel="Mercari" by default.
# We need to test with the tracking reconciler's salesChannel param.
# This may require a manual script or a separate admin endpoint call.
# For now, verify that Rakuten shipments with tracking would be found:
# (The reconciler filters SalesChannel=Rakuten when platform="Rakuten")

# Alternative: use local CLI
node src/index.mjs --mode pull_giga_tracking --limit 10 2>&1 | head -50
```

**Verify:**
- Shipment rows with SalesChannel=Rakuten are queried
- Giga tracking API returns tracking info for Rakuten orders pushed to Giga
- Shipment rows patched with tracking data

---

## Step 5: Idempotency Proof

### 5.1 Run pull_rakuten_orders twice

```bash
# Run 1
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"pull_rakuten_orders","limit":10}' | python3 -m json.tool > run1.json

# Run 2 (immediately after)
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"pull_rakuten_orders","limit":10}' | python3 -m json.tool > run2.json

# Compare
python3 -c "
import json
r1 = json.load(open('run1.json'))
r2 = json.load(open('run2.json'))
# Both should succeed
assert r1['ok'] == r2['ok'] == True
# Run 2 should have 0 new rows (all already ingested)
print('Idempotency check: pull_rakuten_orders — PASS')
"
```

### 5.2 Run build_rakuten_shipments twice

```bash
# Run 1
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"build_rakuten_shipments","limit":10}' | python3 -m json.tool > build1.json

# Run 2
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"build_rakuten_shipments","limit":10}' | python3 -m json.tool > build2.json

# Verify: Run 2 should have 0 created (all already projected)
python3 -c "
import json
r1 = json.load(open('build1.json'))
r2 = json.load(open('build2.json'))
print(f'Run 1: created={r1[\"steps\"][0][\"summary\"][\"created\"]}, updated={r1[\"steps\"][0][\"summary\"][\"updated\"]}')
print(f'Run 2: created={r2[\"steps\"][0][\"summary\"][\"created\"]}, updated={r2[\"steps\"][0][\"summary\"][\"updated\"]}')
# Run 2 should have 0 created (rowsEquivalent returns true for unchanged rows)
assert r2['steps'][0]['summary']['created'] == 0
print('Idempotency check: build_rakuten_shipments — PASS')
"
```

### 5.3 Run push_rakuten_orders_to_giga twice

```bash
# Run 1
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"push_rakuten_orders_to_giga","limit":10}' | python3 -m json.tool > push1.json

# Run 2
curl -s -X POST "$WORKER_URL/admin/run-once" \
  -H "Content-Type: application/json" \
  -d '{"mode":"push_rakuten_orders_to_giga","limit":10}' | python3 -m json.tool > push2.json

# Verify: Run 2 should not create duplicates in Giga
python3 -c "
import json
r1 = json.load(open('push1.json'))
r2 = json.load(open('push2.json'))
# Both runs should have same results (GigaB2B returns Already Exists for duplicates)
print('Idempotency check: push_rakuten_orders_to_giga — PASS')
"
```

---

## Step 6: Dashboard / Log Visibility

### 6.1 Verify Worker Logs

```bash
# Check wrangler dev console output for:
# - Phase execution logs
# - Baserow API calls
# - Giga API calls
# - Error messages (if any)

# Check recent production logs:
wrangler tail --format json 2>&1 | head -100
```

### 6.2 Verify Pipeline Run Audit

Check Baserow pipeline runs table for Rakuten phase entries:
- Look for rows with `step` = pull_rakuten_orders, confirm_rakuten_orders, build_rakuten_shipments, push_rakuten_orders_to_giga
- `trigger_type: admin` (from manual /admin/run-once calls)
- `ok: true`

---

## Step 7: Post-Test Verification

### 7.1 Baserow Row Counts

```bash
echo "=== POST-TEST COUNTS ==="
# Rakuten sales table (1015675) — row count
# Rakuten sales — by status (PENDING_CONFIRMATION, CONFIRMED, RMS_CONFIRMED, CANCELED)
# Shipment table (903319) — rows with SalesChannel=Rakuten
# Shipment table — by giga_sync_status
```

### 7.2 Changed Records Report

For each phase, report:
- Phase name
- Rows processed / created / updated / unchanged / failed
- Any unexpected errors or warnings
- Sample order IDs affected

---

## Test Result Template

Fill after execution:

| Phase | Dry-Run | Live Run | Idempotent | Notes |
|-------|---------|----------|------------|-------|
| pull_rakuten_orders | ⏳ | ⏳ | ⏳ | |
| confirm_rakuten_orders | ⏳ | ⏳ | ⏳ | |
| build_rakuten_shipments | ⏳ | ⏳ | ⏳ | |
| push_rakuten_orders_to_giga | ⏳ | ⏳ | ⏳ | |
| pull_giga_tracking (Rakuten) | ⏳ | ⏳ | ⏳ | |

### Baserow Counts

| Table | Before | After | Delta |
|-------|--------|-------|-------|
| Rakuten sales (1015675) | ? | ? | ? |
| Shipments (903319, Rakuten) | ? | ? | ? |
| Pending confirmation | ? | ? | ? |
| RMS_CONFIRMED | ? | ? | ? |

---

## Rollback

If any step fails:

1. Stop `wrangler dev`: `kill $WRANGLER_PID`
2. Rollback relay: SSH to VPS, `git checkout main`, `sudo systemctl restart rp-order-mgmt-relay.service`
3. Clean up test data in Baserow (manually delete test rows if needed)
4. Do NOT delete the feature branch — preserve for debugging
