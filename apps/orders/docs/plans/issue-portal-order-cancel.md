# Issue: Portal "Cancel" action for orders

## Summary

Add a first-class **Cancel** action to the order portal so an operator can mark an order as cancelled locally and, once marked, the order can never be approved again. In-shop cancellation stays a manual shop-side step, but the portal must also automatically reflect "Cancel" when an order is cancelled on the marketplace.

## Background

Today the order portal (`portal/` SPA + `portal-api/` on VPS) only offers two Mercari order actions in the detail drawer footer:

- **✓ Approve** — `PATCH /api/portal/orders/:id/review` with `review_status = "Approved"`
- **⏸ Put on Hold** — same endpoint with `review_status = "On Hold"`

There is no way to "cancel" an order from the portal. An operator who decides an order should not ship (buyer requested cancel, no stock, wrong item) has no in-tool guard — the order remains Approve-able, so it can be accidentally approved and pushed to Giga. The only cancellation path today is outside the portal:

- In-shop cancellation (Mercari shop admin) → picked up later by the hourly ingest (`pull_shop_orders`) and the daily `reconcile_cancellations` job, which set `order_status = CANCELED` and clear `review_status`.

## Requirements

1. **Cancel button.** Add a destructive "Cancel" action to the order detail drawer (Mercari orders), gated to non-terminal orders only.
2. **Irreversible guard.** After Cancel is clicked, the order can no longer be approved — not via the single Approve button, not via bulk-approve, and not via auto-approval.
3. **In-shop cancellation is unchanged.** The portal Cancel action is a *local* marker/guard. The actual marketplace cancellation is still performed in the shop, as today.
4. **Auto-sync from shop.** If an order is cancelled in the shop, the order in the portal must automatically show a "Cancel" state. (This largely exists via ingest + `reconcile_cancellations`; the issue is to confirm it works end-to-end and that the portal surfaces it clearly.)

## Out of scope

- Calling the Mercari cancellation API from the portal (cancellation stays in-shop).
- Rakuten order cancellation (Rakuten has its own `CANCELED` lifecycle; this issue targets Mercari sales orders).
- Bulk "cancel" action (single-order cancel only; bulk can be a fast-follow).

## Acceptance criteria

- [ ] A "Cancel" button appears in the Mercari order detail drawer for orders not already terminal.
- [ ] Clicking Cancel shows a confirmation prompt before applying.
- [ ] After Cancel, the Approve / Put-on-Hold buttons are hidden or disabled, and the order is visually marked as cancelled.
- [ ] Cancel atomically updates **all** sales lines of the order (not just the first row).
- [ ] Single approve, bulk `order_ids`, and bulk `row_ids` cannot flip a cancelled order back to `Approved`; auto-approval skips it.
- [ ] Cancel wins over a concurrent approve (conditional write / CAS).
- [ ] `CANCELING` / `CANCELED` / `COMPLETED` orders show no review actions.
- [ ] unpaid→paid / address-retry backfill never resets a `CANCELED` review status.
- [ ] A projected-but-unsynced order is skipped by outbound after Cancel; an already-`SYNCED`/`ALREADY_EXISTS` order **disallows Cancel** (button hidden/disabled + handler rejects with "already pushed to Giga").
- [ ] A shop-side cancellation propagates to the portal as "Cancel" without operator action (visible after hourly ingest).
- [ ] The action writes a fixed-label audit entry `[<JST>] PORTAL_OPERATOR: marked order cancelled` (bare timestamp, no reason/memo) to `order_comments`.

## Design decision

See `docs/trd/portal-order-cancel-action.md`. The **approved** approach is a new operator-owned terminal review status `CANCELED` (rather than forcing `order_status = CANCELED`, which is ingest-owned and can be reverted by a later re-ingest while the shop order is still active).
