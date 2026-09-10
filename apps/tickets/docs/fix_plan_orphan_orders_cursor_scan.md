# Fix Plan: Orphan Orders — Cursor-Paginated Deep Scan

**Issue**: [GH#11 comment 4560280747](https://github.com/retailpulses/inbox/issues/11#issuecomment-4560280747) — `2JQYq3hwdwgLF9NzcRr8SR` (Shop4)

## Understanding

| Element | Detail |
|---------|--------|
| Order | `2JQYq3hwdwgLF9NzcRr8SR` (Shop4) |
| Created | 2026-04-30 |
| Status | COMPLETED |
| Product | N508P301428B |
| Buyer msg #1 | 5/13: 保証の問い合わせ → `suspicious` |
| Buyer msg #2 | 5/27: 部品不足 (Q3x1, 16Lx7, 16Rx7) → `real_ticket/quality_issue` |
| Baserow ticket | **None** — never created |
| Manual reply | 5/28: FUGUAI sent manually |

## Root Cause

`orderTransactions(first:100)` sorts by `createdAt DESC`. By mid-May, the April 30 order had
fallen past the 100-order window. The unified backscan only covers orders that already have
a Baserow ticket, so orders without tickets become permanently invisible.

```
Timeline:
  04/30 ── Order created
  05/09 ── Pre-order notice (SELLER)
  05/10 ── Shipped (SELLER)
  05/13 ── 保証問い合わせ (BUYER)  ← order already past first:100 window
  05/14 ── Manual reply (SELLER)
  05/27 ── 部品不足報告 (BUYER)     ← still invisible, no ticket
  05/28 ── Manual FUGUAI (SELLER)
```

## Fix

### Modified: `get_unreplied_transactions()`

**Before**: Single `orderTransactions(first:100)` — only newest 100 orders.

**After**: Cursor-paginated scan:
- Up to `max_pages=3` pages (100 orders/page = ~300 orders)
- Age gate: stops when oldest order on a page exceeds `max_age_days=90`
- Query now supports `after` cursor + returns `pageInfo.hasNextPage`/`endCursor`
- Function signature unchanged (backward compatible)

### API Impact

| Metric | Before | After |
|--------|--------|-------|
| Orders scanned | 100/shop | up to 300/shop |
| API pts/run | ~120 (4 shops × 30) | ~360 (4 shops × 30 × 3) |
| Time added | 0 | ~6s (2s/extra page × 3 extra pages, serial across 4 shops) |
| Safety | Within 10k pts/hr limit | Same |

### What Changes Behaviorally

Newly detectable orders (previously past first:100 window) now enter the processing pipeline.
Since they have no Baserow ticket, the existing `else` branches in `main()` handle them:
- `greeting_only` → auto-close (no ticket created, consistent with existing behavior)
- `real_ticket/quality_issue` → FUGUAI sent, Baserow ticket created
- `suspicious` → FUGUAI_LITE sent, Baserow ticket created

## Validation

- Dry-run: passed (2026-05-28 11:47 JST). 2 unreplied found across 4 shops (normal volume).
- The specific order `2JQYq3hwdwgLF9NzcRr8SR` now has last message = SELLER (manual reply)
  → correctly NOT flagged as unreplied.
- Future buyer messages on old orders WILL be detected.

## Validation Test Cases

```
# Deep scan finds old orders
Order from 30 days ago, last msg BUYER, no ticket → found, processed
Order from 30 days ago, last msg SELLER, no ticket → skipped (already handled)
Order from 120 days ago → excluded by age gate (90d cutoff)

# No regression on existing flow  
Order from 2 days ago, last msg BUYER → found on page 1 (same as before)
Order from 2 days ago, last msg SELLER → skipped (same as before)
```
