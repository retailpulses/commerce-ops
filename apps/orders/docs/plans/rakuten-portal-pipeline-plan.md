# Rakuten Portal + Pipeline — Work Plan

**Date:** 2026-07-19 | **Issues:** #148, #153, #169, #146, #150, #152

## Target Architecture (from `docs/rakuten-order-pipeline.md`)

```
PENDING_CONFIRMATION  →  CONFIRMED  →  [shipment projection]  →  [Giga push]
       ↑                      ↑
   (ingest)           (operator clicks Confirm in portal,
                       after confirming on Rakuten RMS)
```

The key insight: confirming on RMS is a platform requirement, not a pipeline state. The operator does it on Rakuten's site, then records "done" by setting CONFIRMED in the portal. The pipeline does not need to know about RMS at all.

## Governance Context

| Rule | Level | Affected Phase | Action |
|------|-------|---------------|--------|
| Change-aware writes | `MUST` | Phase 1 | Guard status PATCH: only write when `orderProgress`-derived status differs from current |
| Audit/remediation separation | `MUST` | Phase 3 | RMS_CONFIRMED→CONFIRMED data conversion as separate one-off script with dry-run |
| Workload registration | `MUST BEFORE PRODUCTION` | Phases 3-4 | Register modified crons in DATABASE_WORKLOADS.yaml |
| Kill switches | `MUST BEFORE PRODUCTION` | Phases 3-4 | Document kill switch per modified cron |
| Cross-domain | N/A | All | No consumers declared — safe to modify |
| DDL migrations | N/A | All | Code-only — no schema changes |

---

## Phase 1 — Low-risk foundation (parallel)

### #148: Status freshness — map RMS `orderProgress` → `order_status`

**File:** `src/lib/rakuten-ingest.mjs` (~25 lines)

| RMS `orderProgress` | → `order_status` |
|---------------------|-------------------|
| `ORDER_ACCEPTED` / `ORDER_IN_PROGRESS` / `ORDER_START` | `PENDING_CONFIRMATION` |
| `ORDER_COMPLETED` / `ORDER_SHIPPED` | `COMPLETED` |
| `ORDER_CANCELED` | `CANCELED` |

**Change-aware guard (governance `MUST`):** Only PATCH when the mapped status differs from the existing row's `order_status`. Do not blindly rewrite on every sync.

**Also:** Map `orderDatetime` → `purchase_date` if currently null (backfill on first sync after this change).

**Test:** 3-5 cases in `test/rakuten-ingest.test.mjs`.

### #153: Truncate `shipFrom` for GigaB2B 16-char limit

**File:** `src/lib/outbound-sync.mjs` — `resolveOutboundOrderFrom()` (~8 lines)

"HomesBliss Rakuten" (18 chars) → truncate to 16. Add validation warning. Document that the Rakuten projector's `shipFrom` should be fixed at source in a follow-up.

**Test:** 2-3 cases in existing outbound-sync tests.

---

## Phase 2 — Portal Rakuten support

Covers **#169 + #146** together. Operator can't confirm what they can't see.

### Step 1: Remove channel hard-reject

**File:** `src/lib/portal/shared.mjs:247`

```js
// Before:
if (channel !== "mercari") throw new Error(...);

// After:
const VALID_CHANNELS = ["mercari", "rakuten"];
if (!VALID_CHANNELS.includes(channel)) throw new Error(...);
```

### Step 2: Make order-list query channel-aware

**File:** `src/lib/portal/order-list.mjs`, `src/lib/portal/handlers.mjs`

- `buildChannelFilter(channel)` — adds `sales_channel = 'rakuten'` filter
- `getChannelStatuses(channel, lifecycle)` — maps lifecycle → per-channel status filters
  - `active` for Rakuten: `PENDING_CONFIRMATION`, `CONFIRMED`, `RMS_CONFIRMED`
  - `completed` for Rakuten: `COMPLETED`, `CANCELED`
- Portal UI: add channel selector (Mercari / Rakuten) to filter bar

### Step 3: Add "Confirm" action for Rakuten orders

**File:** `src/lib/portal/handlers.mjs` — new endpoint `POST /api/portal/orders/:id/confirm`

- Validates `sales_channel === 'rakuten'` and `order_status === 'PENDING_CONFIRMATION'`
- Sets `order_status = 'CONFIRMED'`, `confirmed_at = now()`, appends audit to `order_comments`
- Returns enriched order object

**File:** Portal UI — Confirm button in order detail drawer (visible only for Rakuten + PENDING_CONFIRMATION). Dialog: "Mark as confirmed? Confirm on Rakuten RMS first."

### Step 4: Summary bar for Rakuten

Replace Mercari-specific counts with Rakuten-relevant statuses when channel=rakuten.

**Files:** `shared.mjs`, `order-list.mjs`, `handlers.mjs`, portal UI (~200 lines total)

---

## Phase 3 — State machine simplification (after Phase 2 is live)

### #150: Remove RMS_CONFIRMED, use universal CONFIRMED

1. **Projector reads CONFIRMED directly** — `rakuten-projector.mjs`: change filter from `RMS_CONFIRMED` to `CONFIRMED`
2. **Deprecate `confirm_rakuten_orders` RMS API call** — `rakuten-confirmer.mjs`: comment out cron schedule, add deprecation note
3. **Mark RMS_CONFIRMED as deprecated** — `order-state.mjs`: keep constant but remove from transition graph
4. **One-off data script** — convert existing `RMS_CONFIRMED` rows to `CONFIRMED` (separate dry-run + apply, per governance §6)
5. **Register workloads** — add `confirm_rakuten_orders` + `build_rakuten_shipments` to `DATABASE_WORKLOADS.yaml`

---

## Phase 4 — Outbound pipeline fixes (after Phase 3)

### #152: Channel-aware outbound allowlist

**File:** `src/lib/outbound-sync.mjs:241-304`

Replace hardcoded `WAITING_FOR_SHIPPING` with per-channel status map:
```js
const APPROVAL_STATUSES = {
  mercari: ["WAITING_FOR_SHIPPING"],
  rakuten: ["CONFIRMED"],
};
```
Register `push_rakuten_orders_to_giga` in `DATABASE_WORKLOADS.yaml`.

---

## Summary

| Phase | Issues | Files | Est. lines | Depends on |
|-------|--------|-------|-----------|------------|
| 1 | #148, #153 | 2 | ~35 | — |
| 2 | #169, #146 | 4-5 | ~200 | Phase 1 |
| 3 | #150 | 4-5 | ~80 (mostly delete) | Phase 2 live in prod |
| 4 | #152 | 1 | ~30 | Phase 3 |

**Buildable today: Phases 1 + 2.** Phases 3-4 require portal Rakuten confirmation to be used in production first.
