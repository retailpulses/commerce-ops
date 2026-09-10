# Codex Handoff Report — Supabase Canonical Review Status Fix (PR #118)

**Date:** 2026-07-13  
**Branch:** `codex/fix-supabase-canonical-review-status`  
**Commit:** `1edf678`  
**PR:** https://github.com/retailpulses/OrderMgmt/pull/118  
**Base:** `main` (audited commit `5f9b0c1`)

---

## 1. Problem Statement

The 2026-07-13 production audit found that Supabase stores `review_status` as PostgreSQL enum values (`PENDING_REVIEW`, `APPROVED`, `AUTO_APPROVED`, `ON_HOLD`) but the application expects legacy display values (`"Pending Review"`, `"Approved"`, `"Auto-Approved"`, `"On Hold"`). The `statusEquals()` function does case-insensitive comparison only — `"pending_review"` ≠ `"pending review"` — so every canonical row fails every status comparison, producing:

- 46 active lines deriving as `PIPELINE_STATE.UNKNOWN`
- All review mutations failing with `no_transitions_defined_from:PENDING_REVIEW`
- All approved/Auto-Approved orders blocked from shipment projection
- All approved orders blocked from outbound Giga sync
- Pipeline-health misclassifying all canonical rows
- Portal "Active" filter showing zero canonical rows

---

## 2. What This PR Fixes

### 2.1 Translation Boundary (`src/lib/supabase.mjs`, +58 lines)

Added bidirectional review_status translation at the adapter boundary, following the existing `giga_sync_status` pattern:

```
READ:  toApplicationRow()           → canonicalToLegacyReviewStatus()  → legacy
WRITE: normalizeDatabaseValue()     → legacyToCanonicalReviewStatus()  → canonical
```

**Translation maps:**

| Canonical (Supabase) | Legacy (Application) |
|---------------------|---------------------|
| `PENDING_REVIEW` | `"Pending Review"` |
| `APPROVED` | `"Approved"` |
| `AUTO_APPROVED` | `"Auto-Approved"` |
| `ON_HOLD` | `"On Hold"` |

Unknown/unrecognized values pass through unchanged in both directions.

### 2.2 Auto-Approval Guard (`src/lib/auto-approval.mjs`, +2 lines)

Added `anyRowActuallyPatched` flag. Previously, if all rows in an order were `skipped_status_changed` (already patched by a concurrent run), `allPatched` stayed `true`, causing:
- False `orders_approved` increment
- Automatic buyer message sent without any actual patch

Now: `if (allPatched && anyRowActuallyPatched)` — both conditions must be true.

### 2.3 Pipeline Audit Counts (`src/lib/pipeline-runner.mjs`, +20 lines)

Extended `extractCounts()` to recognize summary shapes from `syncMercariMessages` and `autoApproveMercariOrders`. Previously, these produced empty `{}` in `pipeline_run_log.result_counts` even when work was done (or when a green run hid zero-work behavior).

### 2.4 UI Defaults (`portal/src/App.tsx`, 2 lines)

- `attention: "unread"` → `"any"` — Supabase has no unread state yet, so "unread" default showed 0 orders
- `sortOrder: "asc"` → `"desc"` — newest purchase_date first

### 2.5 Audit Report (`docs/audits/2026-07-13-supabase-cutover-audit.md`, new)

Full P0/P1 breakdown with severity rankings, data integrity comparison (Baserow vs Supabase), and remaining production actions.

### 2.6 Regression Tests (`test/supabase-canonical-review.test.mjs`, new, 63 tests)

Covers translation round-trips, pipeline state derivation, review gate, mutation validation, portal enrichment, extractCounts, readSelectValue, auto-approval guard, and the explicit proof that raw canonical values DO fail (this is why the translation boundary is mandatory).

---

## 3. Complete Trace Matrix

Every review_status touchpoint in the codebase was traced. Here is the authoritative map.

### 3.1 READ PATH: Supabase → Application

All reads flow through `listAllRows` or `listRowsWithLimit` → `toApplicationRow()` → canonical → legacy.

| Module | Function | How it reads | Translation applied? |
|--------|----------|-------------|---------------------|
| `order-state.mjs` | `getPipelineState()` | Receives translated legacy value from caller | ✅ Via caller |
| `order-state.mjs` | `isValidReviewMutation()` | Receives translated legacy value from caller | ✅ Via caller |
| `review-gate.mjs` | `isPipelineApprovedReviewStatus()` | Receives translated legacy value | ✅ Via `toApplicationRow` |
| `review-gate.mjs` | `isBlockedReviewStatus()` | Receives translated legacy value | ✅ Via `toApplicationRow` |
| `pipeline-health.mjs` | `collectPipelineHealthSnapshot()` | Via `listAllRows` → `toApplicationRow` | ✅ |
| `shipment-projector.mjs` | Client-side filter (line 109) | Via `listAllRows` → `toApplicationRow` | ✅ |
| `outbound-sync.mjs` | Allowlist builder (line 274) | Via `listAllRows` → `toApplicationRow` | ✅ |
| `auto-approval.mjs` | Load + status check (line 862) | Via `listAllRows` → `toApplicationRow` | ✅ |
| `portal/order-list.mjs` | `enrichPortalOrderRow()` | Via `listRowsWithLimit` → `toApplicationRow` | ✅ |
| `portal/handlers.mjs` | `handlePortalOrderDetail()` | Via `findSalesOrderByOrderId` → `listAllRows` → `toApplicationRow` | ✅ |
| `portal/handlers.mjs` | `handlePortalSummary()` | Via `listPortalSalesRows` → `listRowsWithLimit` → `toApplicationRow` | ✅ |
| `portal/handlers.mjs` | `handlePortalReview()` mutation validation | Via `findSalesOrderByOrderId` → `listAllRows` → `toApplicationRow` | ✅ |
| `portal/handlers.mjs` | `handleBulkApprove()` mutation validation | Via `listRowsWithLimit` → `toApplicationRow` | ✅ |
| `portal-ui.mjs` | Legacy HTML portal rendering | Via portal API → `listRowsWithLimit` → `toApplicationRow` | ✅ |
| `portal/fee-orders.mjs` | Fee order row processing | Via `listRowsWithLimit` → `toApplicationRow` | ✅ |
| `portal/shared.mjs` | `LEGACY_REVIEW_STATUS_MAP` | Query-param translation only, not DB | N/A |
| `cancellation-reconciler.mjs` | Uses `order_status`, not `review_status` | N/A | ✅ |

### 3.2 WRITE PATH: Application → Supabase

All writes flow through `patchRow` or `createRow` → `toDatabasePayload()` → `normalizeDatabaseValue()` → legacy → canonical.

| Module | Function | What it sends | Translation applied? |
|--------|----------|--------------|---------------------|
| `portal/handlers.mjs` | `handlePortalReview()` (line 460) | `review_status: "Approved"` or `"On Hold"` (legacy) | ✅ Via `patchRow` → `normalizeDatabaseValue` |
| `portal/handlers.mjs` | `handleBulkApprove()` (line 584) | `review_status: REVIEW_STATUS.APPROVED` = `"Approved"` | ✅ Via `patchRow` → `normalizeDatabaseValue` |
| `auto-approval.mjs` | `autoApproveMercariOrders()` (line 873) | `review_status: REVIEW_STATUS.AUTO_APPROVED` = `"Auto-Approved"` | ✅ Via `patchRow` → `normalizeDatabaseValue` |

### 3.3 FILTER PATH: Server-side queries → Supabase

Server-side filters use `OPTION.REVIEW_STATUS.*` which are canonical values — they match Supabase columns directly without any translation.

| Module | Filter | Canonical value used | Matches Supabase? |
|--------|--------|---------------------|-------------------|
| `db-fields.mjs` | `OPTION.REVIEW_STATUS.PENDING_REVIEW` | `"PENDING_REVIEW"` | ✅ Direct match |
| `db-fields.mjs` | `OPTION.REVIEW_STATUS.APPROVED` | `"APPROVED"` | ✅ Direct match |
| `db-fields.mjs` | `OPTION.REVIEW_STATUS.AUTO_APPROVED` | `"AUTO_APPROVED"` | ✅ Direct match |
| `db-fields.mjs` | `OPTION.REVIEW_STATUS.ON_HOLD` | `"ON_HOLD"` | ✅ Direct match |
| `auto-approval.mjs` | PENDING_REVIEW filter (line 634) | `OPTION.REVIEW_STATUS.PENDING_REVIEW` → `"PENDING_REVIEW"` | ✅ |
| `shipment-projector.mjs` | `PIPELINE_APPROVED_OPTION_IDS` (line 89) | `["APPROVED", "AUTO_APPROVED"]` via `.in()` | ✅ |
| `portal/shared.mjs` | `REVIEW_FILTER_OPTION_MAP` | Canonical values via `.eq()` | ✅ |
| `portal/shared.mjs` | `buildReviewFilters()` | `OPTION.REVIEW_STATUS.*` → canonical | ✅ |

### 3.4 Key Insight: Filters vs Reads

**Filters** use canonical values directly (no translation). **Reads** and **writes** go through the translation boundary. These two paths are independent and correct because:

- Filter: `OPTION.REVIEW_STATUS.PENDING_REVIEW` = `"PENDING_REVIEW"` → `.eq("review_status", "PENDING_REVIEW")` → matches Supabase column directly
- Read: Supabase returns `"PENDING_REVIEW"` → `toApplicationRow` → `"Pending Review"` → application logic compares against `REVIEW_STATUS.PENDING_REVIEW` = `"Pending Review"` → match

### 3.5 Modules Verified as NOT Touching review_status

These files import `REVIEW_STATUS` or reference `review_status` but only for field metadata, test fixtures, or conditional logic that never reads/writes the value:

- `field-ownership.mjs` — field name lists only (ownership tracking)
- `order-backfill.mjs` — imports `REVIEW_STATUS` and `statusEquals` but uses them only for `order_status` checks
- `copywrite-context.mjs` — references review_status in context strings only
- `product-resolver.mjs` — uses for risk badge assessment (reads the value after translation)
- `baserow.mjs` — Baserow adapter, not used when `DATABASE_BACKEND=supabase`
- `worker/index.js` — imports `REVIEW_STATUS` for portal endpoints which delegate to `portal/handlers.mjs`

---

## 4. Files Changed

| File | Delta | Description |
|------|-------|-------------|
| `src/lib/supabase.mjs` | +58 | Translation maps + `canonicalToLegacyReviewStatus()` + `legacyToCanonicalReviewStatus()` + call sites in `toApplicationRow()` and `normalizeDatabaseValue()` |
| `src/lib/auto-approval.mjs` | +8/−1 | `anyRowActuallyPatched` guard on `orders_approved` + buyer message |
| `src/lib/pipeline-runner.mjs` | +24 | `extractCounts()` recognizes `syncMercariMessages` and `autoApproveMercariOrders` shapes |
| `portal/src/App.tsx` | +2/−2 | `attention: "any"`, `sortOrder: "desc"` |
| `docs/audits/2026-07-13-supabase-cutover-audit.md` | +139 (new) | Full audit report with P0/P1 breakdown |
| `test/supabase-canonical-review.test.mjs` | +710 (new) | 63 regression tests |

---

## 5. Test Results

```
Full suite:       644/644 passing, 0 failures
Portal build:     tsc -b && vite build — clean
```

Focused test files (all passing):
- `test/supabase-canonical-review.test.mjs` — 63 tests (new)
- `test/supabase-adapter.test.mjs` — 65 tests
- `test/tracking-reconciler.test.mjs` — 40 tests
- `test/wave1-contract.test.mjs`
- `test/close-shipped-orders.test.mjs`
- `test/fee-orders.test.mjs`
- `test/migrate-portal-templates.test.mjs`
- `src/lib/__tests__/order-state.test.mjs`
- `src/lib/__tests__/supabase-compat.test.mjs`
- `src/lib/__tests__/auto-approval.test.mjs`
- `src/lib/__tests__/shipment-projector.test.mjs`
- `src/lib/__tests__/outbound-sync.test.mjs`
- `src/lib/__tests__/pipeline-health.test.mjs`
- `src/lib/__tests__/portal-order-list.test.mjs`
- `src/lib/__tests__/portal-fee-orders.test.mjs`
- `src/lib/__tests__/portal-ui.test.mjs`
- `src/lib/__tests__/buyer-messages.test.mjs`
- `src/lib/__tests__/baserow.test.mjs`
- `src/lib/__tests__/product-resolver.test.mjs`
- `src/lib/__tests__/field-ownership.test.mjs`
- `src/lib/__tests__/order-backfill.test.mjs`
- `src/lib/__tests__/item-code-resolver.test.mjs`
- `src/lib/__tests__/shipment-projector-shipping-method.test.mjs`
- `src/lib/__tests__/timezone.test.mjs`
- `src/lib/__tests__/admin-auth.test.mjs`
- `src/lib/__tests__/copywrite-context.test.mjs`
- `src/lib/__tests__/openai-client.test.mjs`

---

## 6. Production Resolution and Remaining Actions

The canonical review-status fix and Portal UI are deployed. A fully paginated
production parity check loaded all 1,439 Supabase projection rows and proved
that the earlier 24-order gap was a false positive caused by the default
1,000-row response cap.

| # | Action | Severity | Prerequisites | Notes |
|---|--------|----------|--------------|-------|
| 1 | Verify projection backlog | **Resolved** | Completed | 34/34 eligible product lines have projections: 32 `SYNCED`, 2 `ALREADY_EXISTS`. The 35th row is fee-only and intentionally skipped. |
| 2 | Push orders to Giga | **Resolved** | Completed by scheduled Worker | No manual outbound push was required. |
| 3 | Investigate 3 historical projection discrepancies | Medium | Post-deploy | Baserow has 3 Synced projections not in Supabase. May be migration-window timing artifacts |
| 4 | Migrate message state from KV to Supabase | Medium | PR deployed | `sales_order_message_state` has zero rows. KV keys `message-state:v1:*` need migration |
| 5 | COGS backfill | Medium | Post-deploy | 84 active product codes lack `effective_tcogs`; 81 have COGS in Baserow |
| 6 | Stock parity audit | Medium | Post-deploy | 52/84 available-stock values differ from Baserow; 3 have null stock fields |
| 7 | Database-side sorting/pagination | Medium | Architecture decision | Portal sorts after 100-row backend cap. Needs server-side ORDER BY + keyset pagination |
| 8 | Deploy to production | **Resolved** | Completed | Worker run `29244833395`; Portal run `29245390227`. |

---

## 7. Risks & Edge Cases

### 7.1 Confirmed Safe

- **Dual-run window (Baserow + Supabase):** Translation is idempotent. Legacy values pass through `toApplicationRow` unchanged. Canonical values pass through `toDatabasePayload` unchanged. A value can go through either backend without corruption.
- **Concurrent cron runs:** The `anyRowActuallyPatched` guard prevents duplicate messages even when two auto-approval runs overlap.
- **Backward compatibility:** The `REVIEW_STATUS` constants in `order-state.mjs` are unchanged. All existing consumers continue to work with legacy values.

### 7.2 Known Limitations

- **Raw canonical values still fail if they bypass `toApplicationRow`.** If any future code path reads `review_status` directly from Supabase without going through `listAllRows`/`listRowsWithLimit`/`patchRow`/`createRow`, the translation won't apply. The trace matrix above confirms no such path exists today, but this is a regression risk.
- **`statusEquals` is NOT the translation boundary.** The fix is in `toApplicationRow`/`toDatabasePayload`, not in `statusEquals`. `statusEquals("PENDING_REVIEW", "Pending Review")` still returns `false`. This is correct — the translation happens before `statusEquals` is called.
- **The `dist*/` directories in the repo root are excluded from git but exist on disk.** They are from previous PRs (#108). Do not delete them — they are explicitly preserved per the task requirements.

### 7.3 What This PR Deliberately Does NOT Do

- Does not change any business logic in `order-state.mjs`, `review-gate.mjs`, or any consumer module
- Does not modify `statusEquals` or `readSelectValue` behavior
- Does not backfill data
- Does not deploy
- Does not touch Rakuten or Amazon paths
- Does not expand beyond Mercari scope

---

## 8. Verification Commands

```bash
# Run the new regression tests
node test/supabase-canonical-review.test.mjs

# Run full test suite
node --test $(find test src/lib/__tests__ -name "*.test.mjs" -type f | sort)

# Portal build
cd portal && npm run build

# Review the diff
git diff main --stat
git diff main -- src/lib/supabase.mjs
git diff main -- src/lib/auto-approval.mjs
git diff main -- src/lib/pipeline-runner.mjs
git diff main -- portal/src/App.tsx

# Read the audit report
cat docs/audits/2026-07-13-supabase-cutover-audit.md
```

---

## 9. Design Decision: Why the Translation Boundary Is at the Adapter

Alternative approaches considered and rejected:

| Approach | Why rejected |
|----------|-------------|
| Change `statusEquals` to normalize underscores/spaces | Would mask the real problem. `statusEquals` is a general-purpose utility; baking translation into it couples two concerns. |
| Change all `REVIEW_STATUS` constants to canonical values | Would require changing 20+ consumer files, every test fixture, and the legacy Baserow adapter. Violates "minimum change" principle. |
| Add translation in every consumer module | Scatters the concern across the codebase. The adapter boundary is the single choke point for all Supabase I/O. |
| **Chosen: Adapter boundary in `supabase.mjs`** | Same pattern already used for `giga_sync_status`. Single file, two call sites. Zero consumer changes. |

The existing `giga_sync_status` precedent is authoritative: `legacyGigaSyncStatus()` in `toApplicationRow()` for reads, `normalizeDatabaseValue()` for writes. The review_status fix follows this exact pattern.
