# Supabase Cutover Audit — 2026-07-13

**Branch:** `codex/fix-supabase-canonical-review-status`  
**Base:** `main` (audited commit `5f9b0c1`)  
**Status:** P0 items fixed in this PR; P1 items documented below for post-deploy execution.

---

## Data Integrity Summary

| Metric | Baserow | Supabase | Status |
|--------|---------|----------|--------|
| Mercari sales rows | 4,912 | 4,646 logical lines | Zero logical sales lines missing |
| Active lines (non-terminal) | 111 | 111 | Match |
| Shipment projections | 1,442 | 1,439 | 3 Synced projections missing from Supabase |
| `sales_order_message_state` rows | — | 0 | Not yet migrated |
| Unread/last-message state | — | None | Not yet populated |

---

## P0 Findings — Fixed in This PR

### 1. Review Status Translation Boundary (46 UNKNOWN lines)

**Root cause:** Supabase stores canonical `review_status` values (`PENDING_REVIEW`, `APPROVED`, `AUTO_APPROVED`, `ON_HOLD`) matching the PostgreSQL `review_status` enum. Application logic in `order-state.mjs` compares against legacy display values (`"Pending Review"`, `"Approved"`, `"Auto-Approved"`, `"On Hold"`).

The `statusEquals()` function does case-insensitive comparison only — not whitespace/underscore normalization. `"pending_review"` ≠ `"pending review"`, so every canonical row fails every status comparison, deriving `PIPELINE_STATE.UNKNOWN`.

**Fix:** Added bidirectional translation in `supabase.mjs` at the adapter boundary:
- `toApplicationRow()`: canonical → legacy (`PENDING_REVIEW` → `"Pending Review"`)
- `toDatabasePayload()`: legacy → canonical (`"Pending Review"` → `PENDING_REVIEW`)

This follows the existing pattern already used for `giga_sync_status` (`legacyGigaSyncStatus()` / `normalizeDatabaseValue()`).

**Impact:** All status comparisons in `order-state.mjs`, `review-gate.mjs`, `pipeline-health.mjs`, `shipment-projector.mjs`, `outbound-sync.mjs`, `auto-approval.mjs`, and `portal/order-list.mjs` now receive the legacy values they expect.

### 2. All Canonical Review Mutations Fail Transition Validation

**Root cause:** `isValidReviewMutation()` in `order-state.mjs` uses `REVIEW_STATUS_TRANSITIONS` keyed by legacy display values. When the current review status is canonical (`PENDING_REVIEW`), `REVIEW_STATUS_TRANSITIONS["PENDING_REVIEW"]` is `undefined`, so all mutations fail with `no_transitions_defined_from:PENDING_REVIEW`.

**Fix:** Resolved by the translation boundary (finding #1). Mutations now receive legacy values and pass validation.

### 3. Auto-Approval of Canonical PENDING_REVIEW

**Root cause:** `auto-approval.mjs` loads rows filtered by `OPTION.REVIEW_STATUS.PENDING_REVIEW` which is the canonical value `"PENDING_REVIEW"`. The `statusEquals` check on line 863 (`statusEquals(currentReviewStatus, REVIEW_STATUS.PENDING_REVIEW)`) compares canonical against legacy — they don't match.

**Fix:** Resolved by the translation boundary. `toApplicationRow()` converts canonical `PENDING_REVIEW` to legacy `"Pending Review"` before business logic sees it.

### 4. Auto-Approved Shipment Projection Blocked

**Root cause:** `shipment-projector.mjs` checks `isPipelineApprovedReviewStatus()` which compares against `REVIEW_STATUS.APPROVED` and `REVIEW_STATUS.AUTO_APPROVED` (legacy values). Canonical `AUTO_APPROVED` rows don't match.

**Fix:** Resolved by the translation boundary.

### 5. Outbound Giga Review Gate Blocked

**Root cause:** `outbound-sync.mjs` builds an allowlist using `isPipelineApprovedReviewStatus()`. Same canonical-vs-legacy mismatch blocks all approved orders from outbound sync.

**Fix:** Resolved by the translation boundary.

### 6. Pipeline-Health Classification

**Root cause:** `pipeline-health.mjs` uses `statusEquals(row.review_status, REVIEW_STATUS.PENDING_REVIEW)` and similar comparisons. Canonical values don't match legacy constants.

**Fix:** Resolved by the translation boundary.

### 7. False `orders_approved` Count + Auto-Message Without Patch

**Root cause:** In `auto-approval.mjs`, the loop over rows tracks `allPatched` but not whether any row was actually patched (vs skipped due to status change). If all rows are `skipped_status_changed`, `allPatched` stays `true`, `orders_approved` increments, and a buyer message is sent — but nothing was actually patched.

**Fix:** Added `anyRowActuallyPatched` flag. `orders_approved` only increments and messages only send when at least one row was successfully patched.

### 8. Pipeline Audit Counts — Empty `{}`

**Root cause:** `extractCounts()` in `pipeline-runner.mjs` only extracts from `summary.counts` sub-object or `summary.results` array. Both `syncMercariMessages` and `autoApproveMercariOrders` return top-level count fields (`orders_checked`, `orders_evaluated`, etc.) that `extractCounts` doesn't recognize.

**Fix:** Extended `extractCounts()` to recognize:
- `syncMercariMessages` shape: `orders_checked`, `orders_synced`, `orders_failed`
- `autoApproveMercariOrders` shape: `candidates_loaded`, `orders_evaluated`, `orders_approved`, `rows_approved`, `patch_failures`, `messages_sent`, `messages_skipped`, `message_failures`

### 9. Safe UI Defaults

**Root cause:** `App.tsx` defaulted to `attention: "unread"` (showing zero orders — no unread state exists in Supabase yet) and `sortOrder: "asc"` (oldest first).

**Fix:** Changed defaults to:
- `attention: "any"` — shows all attention levels
- `sortOrder: "desc"` — newest purchase_date first

### 10. No Regression Tests with Supabase Canonical Fixtures

**Fix:** Added comprehensive tests in `test/supabase-canonical-review.test.mjs` covering:
- Translation boundary round-trips (canonical ↔ legacy)
- `getPipelineState()` with canonical input
- `isPipelineApprovedReviewStatus()` with canonical input
- `isValidReviewMutation()` with canonical input
- `isActivePipelineState()` with canonical-derived states
- Auto-approval `orders_approved` guards (no false count, no message without patch)
- Pipeline-health status comparisons
- Portal `enrichPortalOrderRow()` pipeline_state derivation with canonical input
- `extractCounts()` for message sync and auto-approval summary shapes

---

## P1 Debt — Remaining for Post-Deploy Execution

| # | Item | Severity | Owner | Notes |
|---|------|----------|-------|-------|
| 1 | Projection parity | Resolved | Codex | The reported 24-row gap was an audit false positive caused by Supabase's 1,000-row response cap. A paginated read loaded all 1,439 projections and matched all 34 eligible product lines: 32 `SYNCED`, 2 `ALREADY_EXISTS`. The 35th approved row is an intentionally skipped fee-only row. |
| 2 | 3 historical Sync projection discrepancies | Medium | Post-deploy investigation | Baserow has 3 Synced projections not in Supabase. May be timing artifacts from migration window. |
| 3 | Unread-state migration | Medium | Post-deploy | `sales_order_message_state` has zero rows. KV state needs migration to Supabase. |
| 4 | COGS backfill (84 codes) | Medium | Post-deploy | 84 active product codes lack `effective_tcogs`; 81 have COGS in Baserow. |
| 5 | Stock parity | Medium | Post-deploy | 52/84 available-stock values differ from Baserow; 3 have null stock fields. |
| 6 | Database-side sorting/pagination | Medium | Architecture | Portal sorting operates after 100-row backend cap. Server-side ORDER BY + keyset pagination needed. |
| 7 | 35 waiting-for-shipping lines Approved/Auto-Approved | Resolved | Monitor | 34 product lines are projected and terminal at Giga; 1 fee-only row is intentionally excluded. |
| 8 | Message-sync empty results | Low | Investigate | Recent runs show success but zero results. May be relay connectivity or cron timing. |

---

## Verification

- [x] Audit report saved
- [x] Translation boundary implemented in `supabase.mjs`
- [x] `extractCounts` extended in both the shared runner and production Worker
- [x] `autoApproveMercariOrders` patched-guard fix
- [x] UI defaults corrected
- [x] Regression tests added
- [x] Full test suite passing: 644/644
- [x] Portal tests passing: 2/2
- [x] Portal TypeScript production build passing
- [x] Production deploy workflow rebuilds the React SPA
- [x] PR #118 opened against `main`

---

## Production Actions

- [x] Verify projections with a fully paginated Supabase read: 34/34 eligible product lines matched
- [x] Verify Giga disposition: 32 `SYNCED`, 2 `ALREADY_EXISTS`
- Migrate message state from KV to Supabase
- Update COGS and stock in Supabase
- [x] Deploy canonical review-status fix to production
