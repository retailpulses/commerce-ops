# Issue Draft: Align Live Ticket Handler With Intended Aftersales Scan Rules

**Date**: 2026-06-14
**Scope**: live handler only (`web/worker/src/handler.ts` and related Mercari/Baserow clients)

## Intended Behavior

The live handler should behave as follows:

1. Deep-scan all 4 Mercari shops, but only for order status `COMPLETED`.
   - Reason: this path is for aftersales only, not pre-delivery support.

2. When a ticket may need to be created, check existing Tickets rows first and avoid duplicates.
   - `Order ID` matching must normalize both forms:
   - `order_<txId>`
   - `<txId>`

3. Separately scan all open tickets for new messages.
   - Reason: deep scan can miss older orders because of recency/pagination limits.

## Current Live Behavior

### 1. Deep scan is not limited to aftersales-only `COMPLETED`

Current code in [web/worker/src/clients/mercari.ts](/Users/user/Documents/Retailpulses/20_REPOS/ticket handling/web/worker/src/clients/mercari.ts:61) uses:

- `WAITING_FOR_PAYMENT`
- `WAITING_FOR_SHIPPING`
- `CANCELING`
- `COMPLETING`
- `COMPLETED`

This means the live handler still scans pre-delivery and in-flight states, which conflicts with the intended aftersales-only rule.

### 2. Backscan is broader than "open tickets only"

Current live handler logs `Backscanning ALL tickets` and fetches one page of tickets without a status filter:

- [web/worker/src/handler.ts](/Users/user/Documents/Retailpulses/20_REPOS/ticket handling/web/worker/src/handler.ts:120)
- [scripts/clients/baserow.py](/Users/user/Documents/Retailpulses/20_REPOS/ticket handling/scripts/clients/baserow.py:64) documents the same pattern in the legacy client family

This is not aligned with the intended rule of scanning all open tickets only.

### 3. Existing-ticket lookup is prefix-fragile

Current live handler creates/fetches tickets by exact `Order ID = order_<txId>`:

- lookup: [web/worker/src/handler.ts](/Users/user/Documents/Retailpulses/20_REPOS/ticket handling/web/worker/src/handler.ts:297)
- create/write: [web/worker/src/handler.ts](/Users/user/Documents/Retailpulses/20_REPOS/ticket handling/web/worker/src/handler.ts:493)

The backscan path also rejects rows whose `Order ID` does not start with `order_`:

- [web/worker/src/handler.ts](/Users/user/Documents/Retailpulses/20_REPOS/ticket handling/web/worker/src/handler.ts:160)

This means mixed historic data with and without the prefix can bypass dedupe and can also be skipped by backscan.

## Gap Summary

| Area | Intended | Current | Gap |
|---|---|---|---|
| Mercari deep scan statuses | `COMPLETED` only | multiple statuses incl. pre-delivery | not aligned |
| Existing-ticket safety net | open tickets only | all tickets, no status filter | not aligned |
| Duplicate prevention | normalize both `order_<txId>` and `<txId>` | exact `order_<txId>` assumption | not aligned |

## Required Changes

### A. Restrict live deep scan to aftersales status only

Change `getUnrepliedTransactions()` so the live handler only deep-scans:

- `COMPLETED`

Remove:

- `WAITING_FOR_PAYMENT`
- `WAITING_FOR_SHIPPING`
- `CANCELING`
- `COMPLETING`

### B. Change backscan scope from all tickets to all open tickets

The live handler backscan should cover all open tickets only.

Practical requirement:

- exclude `Closed Resolved`
- exclude `Closed Unresolved`

If Baserow single-select filtering is still unreliable, do post-filtering in code after fetch, but the effective handler behavior must be "open tickets only".

### C. Normalize `Order ID` for dedupe and backscan

Add a shared normalization rule:

- strip leading `order_` if present
- compare on normalized tx id

Apply it to:

- existing ticket lookup before create
- backscan row selection
- any direct ticket fetch paths that assume prefixed IDs

### D. Preserve message-first safety net for old orders

Keep the open-ticket backscan as the protection against deep-scan pagination/age limits.

Do not rely on deep scan alone for old aftersales conversations.

## Acceptance Criteria

- [ ] Live deep scan uses only `COMPLETED`
- [ ] Live backscan only processes open tickets
- [ ] Ticket dedupe works whether `Order ID` is stored as `order_<txId>` or `<txId>`
- [ ] Open tickets with old order age are still scanned for new buyer messages
- [ ] No duplicate ticket is created because of prefix mismatch

## Notes

- This issue is about the live handler behavior only, not the one-off backfill script.
- The current backfill script surfaced the same prefix assumption, but that is secondary to fixing the runtime path.
