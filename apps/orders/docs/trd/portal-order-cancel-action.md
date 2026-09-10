# TRD: Portal "Cancel" action for Mercari orders

## Status

**Finalized (approved)** — Jim approved on 2026-08-15: Option B (hybrid) + schema migration; bare-timestamp audit; no bulk cancel; already-`SYNCED`/`ALREADY_EXISTS` orders disallow Cancel. **Codex final review returned GO (2026-08-15, 6 rounds)** — all blocking and non-blocking findings are folded in below. No code, schema, or deployment changes have been made yet.

## Problem

The order portal only lets an operator **Approve** or **Put on Hold** a Mercari order. There is no "cancel" action, so an order that should not ship remains Approve-able and can be accidentally approved and pushed to Giga. Separately, when an order is cancelled in the Mercari shop, the portal should reflect a "Cancel" state automatically.

Three sub-requirements:

1. A manual **Cancel** button in the portal.
2. After Cancel, the order **cannot be approved again** (hard guard).
3. Shop-side cancellation **auto-propagates** to the portal as "Cancel".

## Current state (verified)

### Approval flow
- Approve = `PATCH /api/portal/orders/:id/review` (`handlePortalReview`, `src/lib/portal/handlers.mjs:470`) writing `review_status = "Approved"`; "On Hold" writes `review_status = "On Hold"`.
- Bulk approve = `POST /api/portal/orders/bulk-approve` (`handlePortalBulkApprove`, `handlers.mjs:617`).
- Auto-approval (`src/lib/auto-approval.mjs`) only processes `review_status = PENDING_REVIEW` **and** `order_status = WAITING_FOR_SHIPPING` (line ~368–370, ~895).
- All three paths are gated by `isValidReviewMutation()` (`src/lib/order-state.mjs:358`), which rejects any review mutation when `order_status` is `COMPLETED` or `CANCELED` (`terminal_lifecycle`).

### Cancellation flow (already exists)
- Ingest (`pull_shop_orders`, hourly) is the Mercari source of truth. It owns `order_status` and, on re-sync, sets `order_status = CANCELED` and nulls `review_status` when Mercari reports the order cancelled (`applyTerminalReviewInvariant`, `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs:588`).
- `reconcileMercariCancellations` (`src/lib/cancellation-reconciler.mjs`, daily cron `50 14 * * *`) re-triggers ingest for `WAITING_FOR_SHIPPING`/`CANCELING`/`CANCELED` statuses, then marks linked Giga shipment rows `INVALID` and clears `review_status` on cancelled rows.

### Field ownership (decisive for the design)
`scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs` declares field ownership via `getOwnedFields({ phase: "pull_shop_orders", table: "sales", salesChannel: "Mercari" })`:

- **`order_status` is ingest-owned.** Ingest overwrites it to match Mercari on every re-sync. `guardTerminalOrderStatusRegression` (`:689`) only guards `COMPLETED → WAITING_FOR_SHIPPING`; it does **not** guard `CANCELED → WAITING_FOR_SHIPPING`.
- **`review_status` is operator-owned — with one exception.** Ingest strips it from the normal patch (`filterPatchToOwnedFields`, `:392`) and only touches it via `applyTerminalReviewInvariant` — to **null** it when `order_status` goes terminal. **However**, an independent backfill path (`needsBackfill`, `:353` → `src/lib/order-backfill.mjs:56`) runs outside the ownership filter and can reset an empty or `On Hold` `review_status` back to `Pending Review` (unpaid→paid / address-retry). A new `CANCELED` value is not currently in that backfill's reset set, but this must be locked down explicitly and regression-tested.

### Data model (Supabase `sales_orders`)
- `order_status text not null` — no CHECK constraint. Values include `WAITING_FOR_PAYMENT`, `WAITING_FOR_SHIPPING`, `COMPLETED`, `CANCELED` (plus transient Mercari `CANCELING`).
- `review_status text default 'PENDING_REVIEW'` — **nullable** since `supabase/migrations/20260715074201_allow_null_terminal_review_status.sql` — with CHECK `in ('PENDING_REVIEW','AUTO_APPROVED','APPROVED','ON_HOLD')` (`supabase/migrations/20260710000000_order_mgmt_core.sql:96`).
- Legacy display ↔ canonical translation lives in `src/lib/supabase.mjs` (`canonicalToLegacyReviewStatus` / `legacyToCanonicalReviewStatus`); canonical is uppercase, portal uses title-case display ("Approved", "On Hold").

### Portal UI
- `portal/src/components/detail/OrderDetailDrawer.tsx` footer renders Approve / On Hold (Mercari) and Confirm (Rakuten). No Cancel.
- `OrderInfo.tsx` shows `order_status`, `review_status`, `pipeline_state`.
- `FilterBar.tsx` already has a "Canceled" **lifecycle** filter (keyed on `order_status`).

## Design options

### Option A — force `order_status = CANCELED`
Cancel button writes `order_status = CANCELED` + null `review_status` + audit log.

- **Pros:** minimal — no schema change; reuses the existing terminal guard (`terminal_lifecycle`), existing "Canceled" filter, and `pipeline_state = CANCELLED`.
- **Cons:** `order_status` is ingest-owned. If the operator clicks Cancel but the shop order is still active, the next hourly ingest re-syncs `order_status` back to `WAITING_FOR_SHIPPING` (and `review_status` back to `Pending Review`), **re-enabling approval** — violating requirement 2. `guardTerminalOrderStatusRegression` does not protect `CANCELED`.

### Option B — new operator-owned terminal `review_status = CANCELED` (recommended)
Add a new `review_status` value `CANCELED` (canonical) / "Canceled" (display). The Cancel button writes `review_status = CANCELED` + audit log; `order_status` is left to ingest.

- **Pros:**
  - `review_status` is operator-owned, so a local Cancel **survives** subsequent re-ingest while the shop order is still active → hard, durable "cannot be approved" guarantee.
  - Approval already keys on `review_status` (`isValidReviewMutation`, auto-approval's `PENDING_REVIEW` match, projection's `APPROVED`/`AUTO_APPROVED` gate), so blocking is a small centralized change.
  - Composes cleanly with the existing shop-cancel path: when the shop cancellation propagates, ingest sets `order_status = CANCELED` + nulls `review_status`; the order is terminal by `order_status` from then on.
- **Cons:** requires a governed schema migration (extend `chk_review_status`), plus translation-map and state-machine updates.

**Recommendation: Option B.** It is the only option that satisfies "after clicked the order cannot be approved again" under the existing ingest-owned `order_status` behavior. Option A is a fallback if Jim prefers zero schema change and accepts the re-ingest revert risk.

## Recommended design (Option B)

### Semantics (hybrid — refined after Codex review)
- `review_status = CANCELED` means **"operator marked this order cancelled; do not approve or ship."**
- It is distinct from `order_status = CANCELED`, which means **"Mercari reports the order cancelled."** Either alone blocks approval.
- Manual Cancel **only** writes `review_status = CANCELED` (+ audit). It does **not** write `order_status = CANCELED` — `order_status` stays ingest-owned so "locally blocked" is never conflated with "Mercari confirmed cancelled". When the real shop cancellation arrives, ingest sets `order_status = CANCELED` and may null `review_status`; the order stays terminal via `order_status` from then on.
- Manual Cancel does **not** call Mercari. The operator still cancels in-shop per the existing SOP.

### Hardening requirements (blocking — from Codex review)

These close gaps that would otherwise break "cannot be approved again":

1. **Multi-line atomicity.** The sales table is one row per `(sales_channel, order_id, source_store_id, product_name)` (`core.sql:94`), and projection aggregates by order ID (`shipment-projector.mjs:249`). `findSalesOrderByOrderId()` returns only the first match (`handlers.mjs:1745`). **Cancel must atomically update all non-fee lines of the order** (same `sales_channel` + `source_store_id` + normalized `order_id`), not just one row.
2. **Atomicity + CAS / Cancel-wins.** `patchRow(..., match)` already provides single-row CAS (and commit `e74b0b6` added payment validation + `match` to single/bulk approve). But single-row CAS cannot atomically update **all** order lines, nor guarantee Cancel-wins against a racing approve. Add a **Supabase transactional RPC** that locks all non-fee lines of the order (`sales_channel + source_store_id + normalized order_id`), checks shipment + current review state, updates all lines + audit in one transaction, and applies a DB-level mutex on the approve path so **Cancel always wins**.
3. **Bulk `row_ids` bypass.** `handlePortalBulkApprove` only validates rows resolved via `order_ids`; rows submitted directly as `row_ids` are approved unconditionally (`handlers.mjs:627,652,675`). Bulk approve must re-read and conditionally update **every** row regardless of how it was addressed.
4. **`CANCELING` is not a terminal guard.** `isValidReviewMutation` only blocks `COMPLETED`/`CANCELED`, and an empty `review_status` is still Approve/On-Hold-able (`order-state.mjs:375`). During Mercari's transient `CANCELING`, an order could be manually approved. **Treat `CANCELING` as approval-blocked** (add to the terminal/blocked set and give it a defined pipeline state).
5. **Backfill must not reset `CANCELED`.** `order-backfill.mjs:56` can reset empty/`On Hold` → `Pending Review` outside the ownership filter. Guarantee `CANCELED` is never reset by that path, with regression tests for unpaid→paid and address-retry.
6. **Already-synced guard.** Cancelling an order whose Giga shipment is already `SYNCED`/`ALREADY_EXISTS` cannot withdraw the Giga order. **Disallow Cancel entirely** (decision 4): the handler rejects with `already_synced_to_giga` and the UI hides/disables the button with a "handle manually in Giga/Mercari" message. Never mark such an order `CANCELED` locally. **Lookup:** resolve anchor sales row → normalize `order_id` → query `giga_shipment_projections` where `sales_channel = 'mercari'` and `source_store_id` = anchor's and normalized `order_id` matches; if **any** row is `SYNCED`/`ALREADY_EXISTS`, reject. Do not key on `sales_order_id` alone (it points to one line). The lookup must **fail closed**: on query error, reject Cancel — never treat an error as "not synced".

### State machine
Add to `src/lib/order-state.mjs`:
- `REVIEW_STATUS.CANCELED = "Canceled"` (legacy display form, consistent with the other `REVIEW_STATUS` values).
- `REVIEW_STATUS_TRANSITIONS`: `CANCELED` is terminal (no outgoing transitions). Add `CANCELED` as a valid target from active review statuses (`PENDING_REVIEW`, `APPROVED`, `ON_HOLD`, `AUTO_APPROVED`) so the Cancel action is allowed while the order is active.
- `getPipelineState()`: when `order_status` is active and `review_status = CANCELED`, return `PIPELINE_STATE.CANCELLED`.
- `isValidReviewMutation()`: treat `review_status = CANCELED` as terminal — reject any mutation from `CANCELED` (reason `terminal_review_canceled`), and reject `Approved`/`On Hold` when current review is `CANCELED`.

### Data/schema (governed)
- New migration `supabase/migrations/YYYYMMDDHHMMSS_add_canceled_review_status.sql`:
  - `alter table public.sales_orders drop constraint chk_review_status;`
  - `alter table public.sales_orders add constraint chk_review_status check (review_status in ('PENDING_REVIEW','AUTO_APPROVED','APPROVED','ON_HOLD','CANCELED'));`
  - Update the column comment and any partial indexes that enumerate review_status values (`ix_sales_orders_review_queue`, `ix_sales_orders_projection` are safe — they reference the old four values, which remain valid).
- **Governance:** this is a Supabase schema change in the `order_management` domain. Follow `docs/16_DATABASE_GOVERNANCE.md` → `retailpulses/rp-governance-kit` `docs/DATABASE_GOVERNANCE.md` before applying.

### RPC contract (concrete — blocking)

All review mutations (Cancel, Approve, On-Hold, Auto-Approve) route through **one** `security definer` function that takes an **order-scoped advisory lock**, so Cancel always wins over a concurrent approve regardless of which line either operation touches. The existing per-row PostgREST `match` CAS (`e74b0b6`) is insufficient here because it cannot (a) atomically update all lines of an order, nor (b) share a mutex with a multi-line Cancel.

```sql
-- Order-scoped mutex (every review mutation acquires this first):
--   pg_advisory_xact_lock(hashtext(p_sales_channel || '|' || p_source_store_id || '|' || p_order_id))

create or replace function public.set_order_review_status(
  p_sales_channel   text,   -- 'mercari'
  p_source_store_id text,   -- anchor.source_store_id (Shop1..Shop4)
  p_order_id        text,   -- normalized (order_ prefix stripped)
  p_target          text,   -- 'CANCELED' | 'APPROVED' | 'ON_HOLD' | 'AUTO_APPROVED'
  p_audit           text    -- fixed label for CANCELED; '' otherwise
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_rows integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_sales_channel || '|' || p_source_store_id || '|' || p_order_id));

  -- non-fee predicate = isFeeRow()/shouldSkipFeeRow():
  --   not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')

  -- guard 1: order already terminal (nothing to mutate)
  if exists (select 1 from sales_orders
             where sales_channel = p_sales_channel and source_store_id = p_source_store_id
               and order_id = p_order_id
               and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
               and order_status in ('COMPLETED','CANCELED','CANCELING'))
  then raise exception 'ORDER_TERMINAL' using errcode = 'P0001'; end if;

  -- guard 2: already pushed to Giga — disallow local Cancel only (fail closed).
  -- Approve/On-Hold/Auto-Approve are NOT gated here; only Cancel is refused.
  if p_target = 'CANCELED'
     and exists (select 1 from giga_shipment_projections
             where sales_channel = p_sales_channel and source_store_id = p_source_store_id
               and order_id = p_order_id
               and giga_sync_status in ('SYNCED','ALREADY_EXISTS'))
  then raise exception 'ALREADY_SYNCED_TO_GIGA' using errcode = 'P0001'; end if;

  -- guard 3: CANCELED is terminal — approve/hold/auto-approve can never flip it back
  if p_target in ('APPROVED','ON_HOLD','AUTO_APPROVED')
     and exists (select 1 from sales_orders
                 where sales_channel = p_sales_channel and source_store_id = p_source_store_id
                   and order_id = p_order_id
                   and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
                   and review_status = 'CANCELED')
  then raise exception 'REVIEW_CANCELED' using errcode = 'P0001'; end if;

  -- update ALL non-fee lines atomically
  with t as (
    select id from sales_orders
    where sales_channel = p_sales_channel and source_store_id = p_source_store_id
      and order_id = p_order_id
      and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
    for update
  )
  update sales_orders so
     set review_status = p_target,
         order_comments = case when p_audit = '' then order_comments
                               else coalesce(nullif(order_comments, ''), '') || e'\n' || p_audit end
    from t where so.id = t.id;

  get diagnostics v_rows = row_count;
  return jsonb_build_object('updated', v_rows, 'review_status', p_target);
end;
$$;
```

- **Return shape:** `{"updated": <n>, "review_status": "<target>"}`.
- **Error contract** (SQLSTATE `P0001` / `raise_exception`, surfaced by `supabase.rpc`): `ORDER_TERMINAL`, `ALREADY_SYNCED_TO_GIGA`, `REVIEW_CANCELED`.
- **Callers:** `handlePortalCancel` → `p_target='CANCELED'`, `p_audit='[<JST>] PORTAL_OPERATOR: marked order cancelled'`. `handlePortalReview` (single) and `handlePortalBulkApprove` (per order) → `p_target='APPROVED'`/`'ON_HOLD'`, `p_audit=''`. Auto-approval → `p_target='AUTO_APPROVED'`. This **replaces** the current per-row PostgREST `PATCH` for review-status writes; the JS-level `isValidReviewMutation`/`review-gate` checks remain as a first line of defense but are no longer the sole guard.
- **Privileges:** the function is `security definer` and will inherit the migration owner's default `PUBLIC` execute grant. The migration must add `revoke execute on function public.set_order_review_status(text,text,text,text,text) from public;` and a `grant execute ... to <trusted_backend_role>` (the role `supabase.rpc` calls authenticate as), so anonymous/anonymous client roles cannot invoke it directly.
- **NULL safety:** `product_name` may be `NULL`; the predicate uses `coalesce(product_name, '')` so a `NULL` row is treated as a non-fee line (matching `isFeeRow()`'s JS behavior) and is always locked/checked/updated.

### Backend (shared handler + route)
- Add `handlePortalCancel(env, orderId)` in `src/lib/portal/handlers.mjs`:
  - Load the row via `findSalesOrderByOrderId`.
  - Reject if `order_status` is already `COMPLETED`/`CANCELED`/`CANCELING` (nothing to cancel).
  - Reject if `review_status` is already `CANCELED` (idempotent).
  - Write `review_status = CANCELED` (supabase adapter translates legacy→canonical).
  - Append audit entry `[<JST>] PORTAL_OPERATOR: marked order cancelled` to `order_comments` (bare timestamp, no reason/memo).
  - Invalidate summary/list caches.
- Register `POST /api/portal/orders/:id/cancel` in `portal-api/src/routes.mjs`.
- (No change needed to the Worker `worker/index.js` unless the Worker also serves portal endpoints; verify which entrypoint is canonical — portal runs on VPS `portal-api`, Worker retains cron/backlog.)

### Translation map
Add to `src/lib/supabase.mjs`:
- `REVIEW_STATUS_CANONICAL_TO_LEGACY`: `CANCELED: "Canceled"`.
- `REVIEW_STATUS_LEGACY_TO_CANONICAL`: `"canceled": "CANCELED"`.
- `src/lib/db-fields.mjs` `OPTION.REVIEW_STATUS.CANCELED = "CANCELED"` for canonical filters, if a server-side filter on canceled review status is added.

### Frontend (portal SPA)
- `OrderDetailDrawer.tsx` footer: add a destructive **"Cancel"** button (red styling) for Mercari orders that are not terminal (`order_status` not `COMPLETED`/`CANCELED`/`CANCELING`, `review_status` not `CANCELED`). Use `window.confirm` (or a small inline confirm) before applying.
- Hide the Approve / Put-on-Hold buttons when `review_status === "Canceled"` or `order_status` ∈ {`CANCELED`,`CANCELING`} (also fixes the existing gap where Approve would still render on a `CANCELED` order).
- Add `useCancelMutation` in `portal/src/hooks/useOrders.ts` + `api.ts` client method hitting `/orders/:id/cancel`.
- `OrderInfo.tsx` already renders `review_status`; optionally style "Canceled" as a red badge for clarity.
- `FilterBar.tsx`: optionally add "Canceled" to `REVIEW_OPTIONS` (the lifecycle "Canceled" filter already exists, keyed on `order_status`).

### Downstream safety (verify, mostly already handled)
- **Projection / outbound-sync** require `APPROVED`/`AUTO_APPROVED`, so `CANCELED` review rows are already excluded.
- **Auto-approval** matches `PENDING_REVIEW` only → skips `CANCELED`.
- **`reconcileMercariCancellations`** catch-all clears `review_status` on `order_status = CANCELED` rows; this should be extended to not fight a manually-set `CANCELED` review (it nulls review_status, which is fine — `order_status = CANCELED` remains terminal).
- **`pipeline-health` / portal "Active" filter** key off `getPipelineState`/review sets; confirm `CANCELED` review rows are excluded from "Active" counts.

## Risks

1. **Ingest revert (Option A only).** Forcing `order_status = CANCELED` is reverted by re-ingest if the shop order is still active. Option B avoids this by using operator-owned `review_status`.
2. **Schema migration.** Extending the CHECK constraint is a governed change and must follow database governance; a bad constraint drop could temporarily allow invalid values.
3. **Display ambiguity.** A locally-cancelled order shows `order_status = WAITING_FOR_SHIPPING` with `review_status = Canceled` until the shop cancellation lands. Acceptable, but the UI must make "Canceled" prominent.
4. **Stale rows.** `review_status = CANCELED` rows that never get a shop cancellation remain "active" to ingest (still `WAITING_FOR_SHIPPING`). They should be excluded from projection and not counted as active; the daily reconciler does not re-cancel them. (Optional follow-up: an operator reminder or a nightly sweep that flags `review_status = CANCELED` but `order_status = WAITING_FOR_SHIPPING` for manual shop-side cancellation.)

## Rollback

- **Code:** revert the handler/route/UI commits and redeploy portal API + SPA. No data migration to reverse on the code side.
- **Schema:** keep the new `CANCELED` value in the CHECK constraint is backward-compatible (superset of old values). To fully roll back, re-add the original 4-value constraint only after backfilling any `review_status = CANCELED` rows to `ON_HOLD` (or null).

## Validation

- Unit tests in `src/lib/__tests__/order-state.test.mjs`: `isValidReviewMutation` rejects approve from `CANCELED`; `getPipelineState` returns `CANCELLED` for `review_status = CANCELED`; `CANCELING` order blocks approval.
- Handler test for `handlePortalCancel`: rejects terminal/`CANCELED` orders; writes canonical `CANCELED` + audit log; invalidates caches; updates **all** order lines.
- Backfill regression: unpaid→paid and address-retry never reset `review_status = CANCELED`.
- Concurrency: Cancel vs Approve race → `CANCELED` wins.
- Portal: manual Cancel → refetch shows `review_status = Canceled`, Approve button hidden; approve attempt returns a clear error.
- End-to-end (dry-run / staging): cancel a test order in Mercari shop → confirm it appears as `CANCELED` in portal within the hourly ingest cycle.

### Blocking acceptance criteria

- Cancel atomically updates all sales lines of the same Mercari order (non-fee).
- Single approve, bulk `order_ids`, and bulk `row_ids` cannot flip `CANCELED` back to `Approved`.
- Cancel wins over a concurrent approve.
- unpaid→paid / address-retry never reset `CANCELED`.
- `CANCELING` / `CANCELED` / `COMPLETED` show no review actions.
- A projected-but-unsynced order is skipped by outbound after Cancel; a `SYNCED`/`ALREADY_EXISTS` order returns an explicit "manual recovery" state instead of a safe cancel.
- Active summary/list excludes local `CANCELED`; summary does not bucket it as `unset`.
- Shop-side `CANCELED` is visible after hourly ingest (daily reconciler is cleanup, not the primary SLA).
- Audit writes a fixed-label `[<JST>] PORTAL_OPERATOR: marked order cancelled` entry (bare timestamp, no reason/memo) — portal auth is a shared token, so there is no real per-user operator identity.

## Decisions (2026-08-15, Jim)

1. **Approved: Option B (hybrid) + schema migration** — extend `chk_review_status` with `CANCELED`.
2. **Audit = bare timestamp only** — no reason/memo text collected. The audit line is a fixed-label `[<JST>] PORTAL_OPERATOR: marked order cancelled` (no real operator identity — portal auth is a shared token, not per-user).
3. **Bulk cancel NOT needed** (single-order Cancel only).
4. **Already-`SYNCED`/`ALREADY_EXISTS` orders → disallow Cancel** (Option A). Hide/disable the Cancel button with "already pushed to Giga — handle manually in Giga/Mercari"; the handler rejects the request too. A local Cancel there would falsely imply the order was safely cancelled when Giga still holds a live shipment.

## Files touched (Option B, revised after Codex review)

- `src/lib/order-state.mjs` — `CANCELED` review status + transitions + pipeline state + mutation guard; add `CANCELING` to the blocked/terminal set.
- `src/lib/review-gate.mjs` — add `CANCELED` to the **blocked** set (never to the approved option-ID set).
- `src/lib/supabase.mjs` — canonical↔legacy translation maps.
- `src/lib/db-fields.mjs` — `OPTION.REVIEW_STATUS.CANCELED`.
- `src/lib/order-backfill.mjs` — guarantee `CANCELED` is never reset by unpaid→paid / address-retry backfill.
- `src/lib/portal/handlers.mjs` — `handlePortalCancel` (atomic all-lines, conditional write, already-synced guard); summary `by_review.canceled` (don't count `CANCELED` as `unset`); harden `handlePortalReview`/`handlePortalBulkApprove` to conditional writes incl. `row_ids`.
- `src/lib/portal/shared.mjs` — `REVIEW_FILTER` / filter map / legacy map accept `review=canceled`.
- `portal-api/src/routes.mjs` — `POST /api/portal/orders/:id/cancel`.
- `worker/index.js` — keep Worker-exposed portal routes in sync with the VPS `portal-api` route set (no stale entrypoint bypass).
- `src/lib/product-resolver.mjs` — a "locally cancelled" badge so cancelled orders don't render normal stock/risk state.
- `portal/src/components/detail/OrderDetailDrawer.tsx` — Cancel button; hide approve/hold when `order_status` is `COMPLETED`/`CANCELED`/`CANCELING` or `review_status` is `CANCELED`.
- `portal/src/components/layout/FilterBar.tsx` — add "Canceled" to `REVIEW_OPTIONS`.
- `portal/src/hooks/useOrders.ts`, `portal/src/lib/api.ts` — `useCancelMutation`.
- `supabase/migrations/YYYYMMDDHHMMSS_add_canceled_review_status.sql` — CHECK constraint (+ update column comment; note `ix_sales_orders_review_queue` intentionally keeps the old four values and thus excludes `CANCELED` — document as a deliberate choice).
- Tests: `src/lib/__tests__/order-state.test.mjs`, new `handlePortalCancel` + bulk/CAS tests, backfill regression tests, and concurrency (Cancel-wins) tests.

## Build plan (phased — one session per phase)

### Phase 1 — Backend core (no DB apply)
1. `src/lib/order-state.mjs` — add `REVIEW_STATUS.CANCELED = "Canceled"`; make `CANCELED` terminal in `REVIEW_STATUS_TRANSITIONS` and a valid target from active states; `getPipelineState` returns `CANCELLED` for active order + `review_status = CANCELED`; `isValidReviewMutation` treats `review_status = CANCELED` and `order_status = CANCELING` as terminal/blocked.
2. `src/lib/review-gate.mjs` — add `CANCELED` to `BLOCKED_REVIEW_STATUSES`/blocked option IDs (never to approved).
3. `src/lib/supabase.mjs` — add `CANCELED ↔ "Canceled"` to both translation maps.
4. `src/lib/db-fields.mjs` — add `OPTION.REVIEW_STATUS.CANCELED = "CANCELED"`.
5. `src/lib/order-backfill.mjs` — lock `CANCELED` against the unpaid→paid / address-retry reset (currently only `""`/`On Hold` are reset; add explicit guard + test).
6. `src/lib/portal/shared.mjs` — add `canceled` to `REVIEW_FILTER`, `REVIEW_FILTER_OPTION_MAP`, and the legacy status map.
7. `src/lib/portal/handlers.mjs` — add `handlePortalCancel(env, orderId)` that resolves the anchor row, fail-closed-checks shipment status, then **delegates to the transactional RPC** (item 10) to mark all non-fee lines `CANCELED` + audit atomically; reject if `order_status` ∈ {`COMPLETED`,`CANCELED`,`CANCELING`} or already-`SYNCED`/`ALREADY_EXISTS`; invalidate caches. Add summary `by_review.canceled`. For approve: verify `handlePortalReview`/`handlePortalBulkApprove` also respect the new `CANCELED`/`CANCELING` terminal states via the shared mutex (commit `e74b0b6` already added payment validation + single-row `match` CAS and rejects `row_ids`; keep that).
8. `portal-api/src/routes.mjs` — register `POST /api/portal/orders/:id/cancel`.
9. `worker/index.js` — mirror the new route if the Worker still exposes portal endpoints (avoid a stale entrypoint).
10. `supabase/migrations/YYYYMMDDHHMMSS_add_canceled_review_status.sql` — **write only, do not apply**: (a) drop/re-add `chk_review_status` with `CANCELED` + update column comment; (b) create the `set_order_review_status(...)` RPC **exactly as specified in the "RPC contract" section above** (advisory-lock key, three guards, non-fee predicate, return/error shape); document the intentional exclusion of `CANCELED` from `ix_sales_orders_review_queue`.
11. Tests: `order-state` unit tests + a new `handlePortalCancel` test covering terminal/CANCELING/already-synced rejection, all-lines atomicity, and CAS.

Verification: `npm run typecheck && npm run test && npm run lint`.

### Phase 2 — Frontend (no DB apply)
- `OrderDetailDrawer.tsx` — Cancel button (confirm); hide Approve/Hold/Cancel when `order_status` ∈ {`COMPLETED`,`CANCELED`,`CANCELING`}, `review_status = CANCELED`, or already-`SYNCED`/`ALREADY_EXISTS`; show the "already pushed" note.
- `FilterBar.tsx` — add "Canceled" to `REVIEW_OPTIONS`.
- `useOrders.ts` + `api.ts` — `useCancelMutation`.
- `product-resolver.mjs` — "locally cancelled" badge so cancelled orders don't render normal stock/risk.

### Phase 3 — Migration apply + integration
- Apply the migration (constraint + RPC) to Supabase **before** deploying any code that writes `CANCELED` (governance: `docs/16_DATABASE_GOVERNANCE.md` + central policy; explicit Jim confirmation first). The migration is backward-compatible (superset of the old 4 values).
- Full test suite + a dry-run end-to-end (cancel a staging order, confirm portal reflects `Canceled`; confirm shop-side cancel propagates via hourly ingest).

### Phase 4 — Deploy + verify
1. Deploy backend (portal API) — now safe because the constraint + RPC already exist.
2. Deploy SPA.
3. Post-deploy smoke: cancel one test order and verify all lines are `CANCELED` + audit written; verify approve is blocked; verify shop-side cancel propagates.
4. **Rollback triggers:** if the Cancel write path errors on the CHECK constraint or the RPC, the backend change is reverted (the SPA is backward-compatible with the old review values); the migration itself is a superset and does not need rollback unless we want to remove `CANCELED` (then backfill `CANCELED` → `ON_HOLD`/null first).
