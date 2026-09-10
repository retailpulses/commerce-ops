# Order Pipeline — End-to-End (Multi-Platform)

## Design Principle

The order pipeline shares common lifecycle names, but external marketplace
authority remains channel-specific. For Rakuten, the latest RMS
`OrderModel.orderProgress` is authoritative and fulfillment fails closed when
that value is unknown, missing, payment-pending, or not shipment-ready.

```
Platform API  ←→  VPS Relay  ←→  Cloudflare Worker  ←→  Supabase  ←→  GigaB2B
```

## Proposed End-to-End Status Reconciliation Integration

The application-wide design in
`docs/trd/platform-order-status-reconciliation.md` keeps discovery and adds a
separate authoritative status gate before lifecycle writers consume an order.
This section is proposed behavior; the runtime remains unchanged until the
implementation, cutover, and production acceptance are approved.

```text
72-hour platform discovery (hourly, unchanged)
  -> idempotent sales_orders upsert
  -> platform-aware reconciliation of every locally non-terminal order
  -> authoritative status evidence persisted and read back
  -> review / RMS confirmation / payment reminder gates
  -> shipment projection
  -> Giga push
  -> tracking reconciliation
  -> marketplace close
  -> reconciliation continues until platform terminal evidence
```

The reconciliation phase is a lifecycle authority refresh, not a replacement
for `reconcile_end_to_end`. The latter heals internal projection/tracking/close
gaps; platform status reconciliation heals stale marketplace lifecycle facts.

### Required ordering and invariants

| Consumer | Required interaction with reconciliation |
|---|---|
| Discovery | Continues independently with the 72-hour overlap; cannot mark older candidates fresh |
| Review and auto-approval | Must reject canceled, canceling, unknown, missing, or stale-disallowed source states |
| Payment reminders | Must use a fresh authoritative `WAITING_FOR_PAYMENT` observation and re-read before any send; reconciliation itself never messages customers |
| RMS confirmation | Uses the existing Rakuten capability gate; reconciliation never calls a marketplace mutation |
| Shipment projection | Reads only platform-allowed, mapped lifecycle states; terminal/cancel-blocked observations win before projection |
| Giga push | Rechecks persisted source eligibility so a queued shipment cannot bypass a newly reconciled cancellation |
| Tracking | May persist tracking, but cannot revive a marketplace-terminal order |
| Marketplace close | Keeps its existing mutation/readback contract; status reconciliation observes the later terminal result |
| `reconcile_end_to_end` | Remains internal healing and must share terminal/cancellation guards with the new platform reconciler |

Mercari and Rakuten are mandatory initial platforms. The existing Mercari
`reconcile_cancellations` workload is folded or retired only after the new
phase proves parity; two independent reconciliation writers must not remain
scheduled. Platform-terminal definitions and cadence are specified in the
TRD. Amazon remains disabled until its source-status contract is verified.

## Rakuten Authoritative Status Contract

| RMS `orderProgress` | Internal status | RMS confirm | Fulfillment |
|---|---|---|---|
| 100 | `PENDING_CONFIRMATION` | Operator may request | Blocked |
| 200 | `WAITING_FOR_PAYMENT` | Operator may request | Blocked |
| 300 | `RMS_CONFIRMED` | Already ready | Allowed |
| 400 | `PENDING_CONFIRMATION` | Operator may request | Blocked |
| 500 | `COMPLETED` | Blocked | Terminal |
| 600 | `WAITING_FOR_PAYMENT` | Operator may request | Blocked |
| 700 | `CONFIRMED` | Already acknowledged | Blocked pending fresh 300 |
| 800/900 | `CANCELED` | Blocked | Terminal |

Every observation persists `rakuten_order_progress`,
`rakuten_status_mapping_state` (`MAPPED`, `UNKNOWN`, or `MISSING`), and
`rakuten_order_progress_observed_at`. Only a mapped numeric 300 is
shipment-ready. Compatibility strings remain ingest-compatible but do not
independently unlock fulfillment.

### Status Definitions

| Status | Meaning | Applies To |
|--------|---------|------------|
| `PENDING_CONFIRMATION` | Order ingested, awaiting operator confirmation | All platforms |
| `CONFIRMED` | Rakuten payment is complete but fresh RMS 300 has not yet authorized shipment | Rakuten |
| `RMS_CONFIRMED` | Fresh RMS 300 observed; shipment-ready | Rakuten |
| `WAITING_FOR_PAYMENT` | RMS 200/600; RMS confirmation may be requested but fulfillment is blocked | Rakuten/Mercari |
| `WAITING_FOR_SHIPPING` | (Mercari legacy — equivalent to CONFIRMED for active orders) | Mercari |
| `CANCELED` | Order canceled on platform | All platforms |
| `COMPLETED` | Order fulfilled and closed | All platforms |

### Per-Platform Differences

Rakuten differs because RMS acknowledgement, payment readiness, and shipment
readiness are distinct facts. They must not be collapsed into one operator
status.

| Platform | Operator action before confirming | System side effect on confirm |
|----------|----------------------------------|------------------------------|
| **Mercari** | None — order is already paid, Mercari handles the rest | None |
| **Rakuten** | Request RMS confirmation in Portal | Scheduled confirmer calls RMS; latest RMS status remains authoritative |
| **Amazon** | None expected | None expected |

RMS confirmation success records `rms_confirm_result` and
`rms_confirmed_at`; it never makes an unpaid order shippable. Ingest advances
700 to `CONFIRMED` and fresh 300 to `RMS_CONFIRMED` automatically.

## Cron Schedule

### Rakuten

| Minute | Phase | What |
|--------|-------|------|
| `2` | `pull_rakuten_orders` | Ingest orders from RMS (last 72h) |
| `7,17,27,37,47,57` | `build_rakuten_shipments` | Project mapped, fresh RMS 300 rows only |
| `5,15,25,35,45,55` | `push_rakuten_orders_to_giga` | Push shipment rows to GigaB2B API |
| `10,20,30,40,50` | `sync_rakuten_tracking` | Pull tracking from Giga, patch sales rows |
| `10,20,30,40,50` | `close_rakuten_orders` | Submit persisted tracking to RMS; runs after `sync_rakuten_tracking` |

`confirm_rakuten_orders` (`4,14,24,34,44,54`) processes explicit Portal
requests. Payment-pending 200/600 remains `WAITING_FOR_PAYMENT` after success.

**Timing:** ⚠️ `push_rakuten_orders_to_giga` (`:05`) runs **before**
`build_rakuten_shipments` (`:07`) in each 10-minute cycle. Shipment rows
created at `:07` are pushed at `:15`. Shift push to `:08` to eliminate
the 8-minute gap (see gap #7 / issue #186).

### Mercari

| Minute | Phase |
|--------|-------|
| `1` | `pull_shop_orders` |
| `3,13,23,33,43,53` | `auto_approve_orders`, `build_giga_shipments` |
| `6,16,26,36,46,56` | `push_orders_to_giga` |
| `8,18,28,38,48,58` | `pull_giga_tracking` |
| `9,19,29,39,49,59` | `close_shop_orders` |
| `11,21,31,41,51` | `reconcile_end_to_end` |
| `50 14 * * *` | `reconcile_cancellations` |

## Portal Interaction

### Review Queue

All platforms appear in the same portal, differentiated by `sales_channel`.

### Operator Actions

| Action | What it does | Pipeline impact |
|--------|-------------|-----------------|
| **Approve** (`review_status = APPROVED`) | Records operator review decision | Governance gate — does not replace confirmation |
| **Confirm** | Requests RMS confirmation | Records acknowledgement only; shipment waits for fresh RMS 300 |
| **Edit B2BItemCode** | Sets `b2b_item_code` — the GigaB2B SKU | Required before shipment projection |
| **Edit delivery preferences** | Modifies address/date/time/quantity | Persisted on the sales row |

## Platform-Specific Side Effects

### Rakuten RMS confirmOrder

Portal writes `rms_confirm_result=requested`. The scheduled confirmer claims
only requested rows, calls RMS through the fixed-IP relay, and persists the
acknowledgement. UNKNOWN/MISSING mappings cannot be requested or claimed.

## Known Gaps

### 1. Status discovery (#148) ✅ FIXED

~~Rakuten ingest ignores `orderProgress` from the RMS `getOrder` response.~~
Fixed: `mapRmsOrderProgressToStatus()` now maps both numeric and string codes.
(Commit: `e412fcf`, PR #170)

### 2. Portal confirmation (#146) ✅ FIXED

No portal UI to transition `PENDING_CONFIRMATION` → `CONFIRMED`. Operators
must edit the database directly. This should be a universal action across
all platforms, with Rakuten optionally showing a "also confirm on RMS" prompt.

### 3. No cancellation reconciler (Rakuten)

Mercari has `reconcile_cancellations` (daily at 14:50 JST). Rakuten has no
equivalent — RMS-canceled orders won't be detected.

### 4. `close_rakuten_orders` scheduling ✅ FIXED

The phase runs in the same cron invocation immediately after
`sync_rakuten_tracking`. It submits only orders with persisted tracking and
keeps strict RMS acknowledgement: local completion requires a fresh RMS read
with `orderProgress=500`.

### 5. `confirm_rakuten_orders` cron is redundant

The cron calls RMS `confirmOrder` API, duplicating what the operator does
manually on RMS. Should be removed or moved to the portal Confirm action.

### 6. Delivery preferences and customer remarks ✅ FIXED

Empirical RMS `getOrder` v3 responses place the operational delivery values
on the top-level `OrderModel`, not in the previously predicted
`DeliveryModel.hopeDelivery*` fields:

| RMS field | Content | Target |
|---|---|---|
| `OrderModel.deliveryDate` | 配送希望日 | `requested_delivery_date` |
| `OrderModel.shippingTerm` | 配送希望時間コード | `requested_delivery_time` |
| `OrderModel.remarks` | お客様備考・配送指示 | source-owned block in `order_comments` |

The projector combines date/time for Giga `shippedDate` and forwards only the
RMS customer-remarks block as `customerComments`. Operator memos and Portal
audit entries are excluded. See
`docs/trd/rakuten-ordermodel-delivery-remarks.md` for mappings and edge cases.

### 7. Timer ordering: push runs before projection (#186)

Push (`:05`) fires 2 minutes before projection (`:07`) in each cycle.
A shipment built at `:07` waits until `:15` to push. Fix: shift push to `:08`.

### 8. RMS delivery field names ✅ VERIFIED

Live responses verified `deliveryDate`, `shippingTerm`, and `remarks` on
`OrderModel`. Unknown `shippingTerm` codes are logged without customer data
and remain empty for operator review rather than being guessed.

## Manual Recovery

### Order stuck at PENDING_CONFIRMATION after RMS confirmation

Set `order_status = "CONFIRMED"` in Supabase:

```sql
UPDATE sales_orders
SET order_status = 'CONFIRMED'
WHERE order_id = '440058-20260715-0646140344';
```

The next `build_rakuten_shipments` run will pick it up and create shipment rows.

### Order stuck with missing B2BItemCode

The projector skips rows with empty `b2b_item_code`. Set it via the portal
B2B code editor, or directly:

```sql
UPDATE sales_orders
SET b2b_item_code = 'n515p416432c'
WHERE order_id = '440058-20260715-0646140344';
```

## Key Source Files

| File | Role |
|------|------|
| `src/lib/rakuten-ingest.mjs` | RMS order → sales_orders row |
| `src/lib/rakuten-confirmer.mjs` | CONFIRMED → RMS_API → (candidate for removal) |
| `src/lib/rakuten-projector.mjs` | CONFIRMED sales → giga_shipment_projections |
| `src/lib/outbound-sync.mjs` | Shipment rows → GigaB2B API |
| `src/lib/rakuten-relay.mjs` | Worker → VPS relay HTTP calls |
| `relay/server.mjs` | VPS relay — RMS API calls |
| `src/lib/tracking-reconciler.mjs` | Giga tracking → sales row patch |
| `src/lib/portal/handlers.mjs` | Portal review/bulk-approve/B2B-code endpoints |
| `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs` | Mercari reference: status mapping + terminal sync |
