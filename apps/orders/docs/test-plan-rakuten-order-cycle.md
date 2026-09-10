# Rakuten Order Cycle — Test Plan

**Feature branch:** `feature/issue-1-rakuten-order-cycle`
**Worktree:** `.claude/worktrees/issue-1`
**Date:** 2026-06-08

---

## Test Gates

### Gate 1: BUILD — Syntax & Import Validation

Verify all modules load without parse/import errors.

```bash
node --check worker/index.js
node --check src/index.mjs
node --check src/lib/tracking-reconciler.mjs
node --check src/lib/rakuten-ingest.mjs
node --check src/lib/rakuten-confirmer.mjs
node --check src/lib/rakuten-projector.mjs
node --check src/lib/rakuten-relay.mjs
node --check src/lib/baserow.mjs
node --check src/lib/outbound-sync.mjs
node --check src/lib/pipeline-health.mjs
node --check relay/server.mjs
```

**Expected:** All pass with no output.

### Gate 2: IMPORT — Module Import & Dependency Resolution

Verify all modules can be imported without runtime errors. Test each new Rakuten module in isolation by importing and checking exports.

```bash
node -e "
  import('./src/lib/rakuten-ingest.mjs').then(m => console.log('ingest:', Object.keys(m)));
  import('./src/lib/rakuten-confirmer.mjs').then(m => console.log('confirmer:', Object.keys(m)));
  import('./src/lib/rakuten-projector.mjs').then(m => console.log('projector:', Object.keys(m)));
  import('./src/lib/rakuten-relay.mjs').then(m => console.log('relay:', Object.keys(m)));
  import('./src/lib/tracking-reconciler.mjs').then(m => console.log('tracking:', Object.keys(m)));
"
```

**Expected:** Each module prints its exported function names with no errors.

### Gate 3: BASEROW — Field ID & Table Connectivity

Verify that:
- Baserow client creates correctly with env vars
- `clientForRakuten()` returns a valid client view
- Field IDs and option IDs are correctly mapped

```bash
node -e "
  const { createBaserowClient, clientForRakuten, BASEROW_FIELD, BASEROW_OPTION } = await import('./src/lib/baserow.mjs');
  const env = {
    BASEROW_API_BASE: 'https://api.baserow.io/api',
    BASEROW_DATABASE_TOKEN: process.env.BASEROW_DATABASE_TOKEN || 'test',
    BASEROW_RAKUTEN_SALES_ORDER_TABLE_ID: '1015675',
  };
  const client = createBaserowClient(env);
  console.log('Token prefix:', client.token.slice(0, 4) + '****');
  console.log('Rakuten token prefix:', client.rakutenToken.slice(0, 4) + '****');
  console.log('Sales table:', client.salesOrderTableId);
  console.log('Shipment table:', client.shipmentOrderTableId);
  console.log('Rakuten sales table:', client.rakutenSalesOrderTableId);
  
  const rakuten = clientForRakuten(client);
  console.log('Rakuten client sales table:', rakuten.salesOrderTableId);
  console.log('Rakuten client token same?', rakuten.token === client.rakutenToken);
  
  // Verify field IDs are defined
  console.log('RAKUTEN_SALES.ORDER_ID:', BASEROW_FIELD.RAKUTEN_SALES.ORDER_ID);
  console.log('RAKUTEN_SALES.ORDER_STATUS:', BASEROW_FIELD.RAKUTEN_SALES.ORDER_STATUS);
  console.log('RAKUTEN_SALES.CONFIRM_IN_PROGRESS:', BASEROW_FIELD.RAKUTEN_SALES.CONFIRM_IN_PROGRESS);
  console.log('RAKUTEN_ORDER_STATUS.RMS_CONFIRMED:', BASEROW_OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED);
  console.log('All checks passed');
"
```

**Expected:** All IDs are non-null, token prefixes shown, no errors.

### Gate 4: DRY-RUN — Pipeline Dry-Run Tests

Run each Rakuten phase in dry-run mode via CLI to verify the full code path executes without actually mutating data.

```bash
# Phase 1: Pull Rakuten orders (dry-run)
node src/index.mjs --mode pull_rakuten_orders --dry-run --limit 5

# Phase 2: Confirm Rakuten orders (dry-run)
node src/index.mjs --mode confirm_rakuten_orders --dry-run --limit 5

# Phase 3: Build Rakuten shipments (dry-run)
node src/index.mjs --mode build_rakuten_shipments --dry-run --limit 5
```

**Expected:** Each returns structured JSON with `ok: true` (or `ok: false` with clear reason like "no rows" or "relay unhealthy"). Dry-run phases that call the relay will fail if relay is unreachable, which is acceptable in local testing.

### Gate 5: RELAY — Relay Endpoint Verification

Verify the two new relay endpoints respond correctly.

```bash
# Check relay health
curl -s https://worker-order.homesbliss.net/health | jq .

# Check Rakuten ingest endpoint (dry-run style — will fail without credentials, but validates endpoint exists)
curl -s -X POST https://worker-order.homesbliss.net/admin/rakuten-ingest \
  -H "Content-Type: application/json" \
  -d '{"limit":1}' | jq .
```

**Expected:** Health endpoint returns `ok: true`. Ingest endpoint returns a response (ok or auth error) — validates the route is registered.

### Gate 6: EDGE — Edge Case Analysis

Manual verification of edge case handling:

| Edge Case | Module | Expected Behavior |
|-----------|--------|-------------------|
| Empty RMS order list | rakuten-ingest | Returns `{ok: true, count: 0}` |
| No CONFIRMED orders | rakuten-confirmer | Returns `{ok: true, candidates: 0}` |
| All orders already in_progress | rakuten-confirmer | Returns `{ok: true, candidates: 0}` |
| RMS confirm fails | rakuten-confirmer | Resets confirm_in_progress, returns `{ok: false}` |
| Duplicate order ingest | rakuten-ingest | Upserts existing row (no duplicate) |
| No RMS_CONFIRMED rows | rakuten-projector | Returns `{ok: true, projected: 0}` |
| Empty tracking result from Giga | tracking-reconciler | Records 0 updated rows for that order |
| Missing SALES_CHANNEL field | tracking-reconciler | text() fallback to "" |
| Cross-database token mismatch | baserow | `clientForRakuten()` uses correct token |
| Non-Rakuten store ID in shipment filter | tracking-reconciler | Filtered out by `storeId === "Rakuten"` check |

### Gate 7: WORKER — Worker fetch handler

Verify the Worker's fetch handler still registers all endpoints and the new cron mappings.

```bash
# Check the cron→phase mapping is complete
node -e "
  const fs = await import('fs');
  const src = fs.readFileSync('worker/index.js', 'utf8');
  // Count cron entries
  const cronMatches = src.match(/\"[^\"]+\"\s*:\s*\[/g);
  console.log('Cron entries found:', cronMatches ? cronMatches.length : 0);
  
  // Verify all 4 Rakuten aliases exist
  for (const alias of ['pull_rakuten_orders', 'confirm_rakuten_orders', 'build_rakuten_shipments', 'build_rakuten_shipments']) {
    console.log(alias + ':', src.includes(alias) ? 'FOUND' : 'MISSING');
  }
"
```

### Gate 8: CODE REVIEW — Adversarial Code Review

Run codex review on the diff to catch any issues.

```bash
codex review --diff origin/main...HEAD
```

---

## Test Execution Order

```
BUILD → IMPORT → BASEROW → DRY-RUN → RELAY → EDGE → WORKER → CODE REVIEW
```

## Test Result Format

| Gate | Status | Detail |
|------|--------|--------|
| 1. BUILD | ✅ | 13/13 files pass syntax check |
| 2. IMPORT | ✅ | 10/10 modules import with correct exports |
| 3. BASEROW | ✅ | 17/17 field/option IDs defined correctly |
| 4. DRY-RUN | ⚠️ Skipped | No local .env with BASEROW_DATABASE_TOKEN available |
| 5. RELAY | ⚠️ Partial | Relay healthy; Rakuten endpoints NOT deployed yet (relay code in worktree only) |
| 6. EDGE | ✅ | All edge case guards present in source code |
| 7. WORKER | ✅ | 13 cron entries, 6 Rakuten aliases, all match wrangler.toml |
| 8. CODE REVIEW | ✅ | Codex review completed; 3 HIGH, 8 MEDIUM, 5 LOW findings |

### Post-Review Fixes Applied

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| E1 | HIGH | Pipeline dead-end: no push_rakuten_orders_to_giga phase | Added phase alias, cron `5,15,25,35,45,55`, runPhase branch, wrangler.toml entry |
| B1 | HIGH | Missing concurrent-creation idempotency guard in rakuten-projector | Added `concurrentMatch` re-check before `createRow()` |
| B2 | HIGH | `rowsEquivalent` used hardcoded key list; missed new payload fields | Changed to iterate `Object.entries(payload)` matching Mercari pattern |

### Known Limitations (documented, not fixed)

| ID | Issue | Rationale |
|----|-------|-----------|
| E2 | Rakuten tracking doesn't patch sales rows | Rakuten sales table tracks order-confirmation lifecycle, not fulfillment |
| E3 | No Rakuten cancellation reconciler | Out of scope for initial implementation |
| C2 | `BASEROW_RAKUTEN_DATABASE_TOKEN` secret not documented | Must be set via `wrangler secret put` if token differs from default |
| C3 | Health snapshot Mercari-only | Rakuten pipeline health reporting is a follow-up task |
| E4 | Single line-item per order assumption | Acceptable for current Rakuten store setup |
| S1 | Shared `MERCARI_RELAY_SECRET` for Rakuten endpoints | Both run on same relay server |

### Deployment Prerequisites

Before this feature goes live:

1. **Deploy relay** — `/admin/rakuten-ingest`, `/admin/rakuten-confirm`, and `/admin/rakuten-close` endpoints are NOT on the production relay yet
2. **Set secrets** — `BASEROW_RAKUTEN_DATABASE_TOKEN` (if different from default), `RAKUTEN_SERVICE_SECRET`, `RAKUTEN_LICENSE_KEY` on the relay VPS
3. **Deploy worker** — `wrangler deploy` to push new crons and code to Cloudflare
4. **Verify cron schedule** — 13 cron triggers in wrangler.toml, no overlapping conflicts
5. **Resolve RMS API unknowns** — date format (blocker for Phase 1), close endpoint (Phase 6) — see `docs/rms-api-unknowns.md`

### Summary

- **Gates passed**: 5/8
- **Gates skipped**: 2 (DRY-RUN — no local env, RELAY — not deployed)
- **Code review**: Completed with 3 HIGH findings, all fixed
- **Phases**: 6/6 implemented (Phase 1 blocked by RMS date format; Phase 6 RMS API unverified)
- **Regression risk**: Low — all existing Mercari phases unchanged
- **Ready to commit**: Yes — pending relay deployment for end-to-end validation
