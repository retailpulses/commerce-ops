# Sales Order Review Gate

Add an operator review gate before Giga shipment creation.
Only approved orders reach Giga. Operators review and edit sales orders directly in Baserow.
Designed for multi-platform support: Mercari now, Rakuten and Amazon later.

## Status

| Stage | Status |
|-------|--------|
| Design | ✅ Complete |
| Codex review | ✅ Complete (3 high findings addressed) |
| Review gate implementation | ✅ Complete |
| Auto-approval implementation | ✅ Complete |
| Tests | ✅ 368 passing |

## Current Pipeline

```
Mercari ──> Ingest (P1) ──> Sales Orders (Baserow 903318) ──> Projector (P2)
  ──> Shipments (Baserow 903319) ──> Outbound Sync (P3) ──> GigaB2B
                                                               │
                                                          Pull Tracking (P4)
                                                               │
                                                     ┌─────────┴──────────┐
                                                     │                    │
                                              Update shipment       Update sales
                                              rows in Baserow     rows in Baserow
                                                     │                    │
                                                     └─────────┬──────────┘
                                                               │
                                                          Close on Mercari (P5)
```

All fully automatic — no operator intervention.

## Proposed Flow

```
                            ┌──[REVIEW GATE PER PLATFORM]──┐
                            │                               │
Mercari ──> Ingest (P1) ──> Mercari Sales Orders ──────> Projector (P2)*
                            │  (review_status)               │
                            │  ┌─────────────────┐           │ Only Approved
                            │  │ Operator reviews │           │ orders pass
                            │  │ & edits in      │           │
                            │  │ Baserow         │           │
                            │  │ Sets            │           │
                            │  │ review_status   │           │
                            │  │ = "Approved"    │           │
                            │  └─────────────────┘           │
                            │                               │
                            └───────────────────────────────┘
                                                               │
                                        Projector (P2) ──> Giga Shipments (shared table 903319)
                                                               │
                                                          Outbound Sync (P3)**
                                                               │
                                                              GigaB2B
                                                               │
                                                          Pull Tracking (P4)***
                                                               │
                                                     ┌─────────┴──────────┐
                                                     │                    │
                                              Update shipment       Update sales
                                              rows in Baserow     rows in Baserow
                                                     │                    │
                                                     └─────────┬──────────┘
                                                               │
                                                          Close on marketplace (P5)***

 *  P2: Only projects Approved orders from each platform's sales order table
**  P3: Also cross-checks review_status on the source sales order
*** P4, P5: Unaffected by review gate — once shipped, track and close proceed automatically
```

### Downstream Flow (GigaB2B → Tracking → Close) — Unchanged

P4 and P5 operate on **shipment rows** (already in Giga), not on sales order review status:

- **P4 (tracking pull)**: Reads shipment rows by `giga_sync_status = Synced`, calls Giga
  tracking API, patches both shipment and sales rows with tracking data. No review
  dependency — if the shipment was pushed, tracking comes back regardless.

- **P5 (marketplace close)**: Reads sales rows that have `shipping_completed_at` set
  (meaning tracking was received from Giga). Closes the order on the marketplace via
  platform-specific API. No review dependency.

**Net result**: The review gate only controls the point of *entry* into Giga. Once an
order is approved and pushed, the downstream flow is automatic and unaffected by
subsequent `review_status` changes. This is by design — you cannot "revoke" a Giga
shipment after it's been created.

## Multi-Platform Architecture

Each platform has its own **sales order table** but shares the **Giga shipment table**:

```
                    Sales Order Tables                  Giga Shipment Table
                    ┌─────────────────────┐
Mercari ───────────>│  Mercari Sales      │──┐
     (table 903318) │  review_status ✓    │  │
                    └─────────────────────┘  │
                                             ├──> Giga Shipments (table 903319)
                    ┌─────────────────────┐  │      SalesChannel = "Mercari"
Rakuten ───────────>│  Rakuten Sales      │──┤      SalesChannel = "Rakuten"
     (new table)    │  review_status ✓    │  │      SalesChannel = "Amazon"
                    └─────────────────────┘  │
                                             │
                    ┌─────────────────────┐  │
Amazon ────────────>│  Amazon Sales       │──┘
     (new table)    │  review_status ✓    │
                    └─────────────────────┘
```

### Pattern per platform

| Component | Mercari (exists) | Rakuten (future) | Amazon (future) |
|-----------|-----------------|-------------------|-----------------|
| Sales order table | `903318` | New table | New table |
| Ingest script | `sync_mercari_...mjs` | New script | New script |
| `review_status` field | On 903318 | On Rakuten table | On Amazon table |
| Projector function | `projectMercariSalesOrdersToShipment()` | New projector | New projector |
| Outbound sync | Shared `runOutboundSync()` via SalesChannel filter | Same | Same |
| Tracking pull | Shared `reconcileShippingInfo()` | Same | Same |
| Marketplace close | `close_all_shipped_orders.mjs` | New close script | New close script |

### Why this works

1. **Giga shipment table is the integration hub** — it already has `SalesChannel` field
   supporting 22+ channels. Outbound sync, tracking pull, and all Giga API calls
   are already platform-agnostic.

2. **`review_status` lives on the platform-specific sales order table** — each
   platform's projector reads from its own table and checks its own `review_status`.
   No cross-table coupling.

3. **Constants in `baserow.mjs`** — Each platform gets its own field/option constants:
   ```js
   SALES_MERCARI: { REVIEW_STATUS: "790xxx" }
   SALES_RAKUTEN: { REVIEW_STATUS: "791xxx" }
   REVIEW_STATUS: { PENDING_REVIEW: "...", APPROVED: "...", CHANGES_REQUESTED: "..." }
   ```
   Option IDs are shared (same option values, same semantics).
   Field IDs are per-table (each table has its own field).

## Schema Changes

### Mercari Sales Orders table (903318) — New field

| Field | Type | Options | Default | Purpose |
|-------|------|---------|---------|---------|
| `review_status` | Single Select | `Pending Review`, `Approved`, `Changes Requested` | `Pending Review` | Controls whether order passes the gate |
| `reviewed_by` | Text | — | empty | Operator who reviewed (optional audit) |
| `reviewed_at` | DateTime | — | empty | When reviewed (optional audit) |

Single Select is the right choice — stable option IDs, no typo states,
filterable server-side via Baserow API.

Same field will be added to Rakuten/Amazon sales order tables when onboarded.

## File-by-File Changes

### 1. `src/lib/baserow.mjs` — Register constants

Add field ID and option IDs (obtain from live Baserow schema).

**Per-platform field IDs** (each sales order table has its own):
```js
SALES: {
  ...existing,
  REVIEW_STATUS: "790xxxx",     // Mercari sales table field ID
}
// Future platforms get their own key:
// SALES_RAKUTEN: { REVIEW_STATUS: "791xxx" }
// SALES_AMAZON:  { REVIEW_STATUS: "792xxx" }
```

**Shared option IDs** (same option values across all tables):
```js
REVIEW_STATUS: {
  PENDING_REVIEW: "59xxxxx",
  APPROVED: "59xxxxx",
  CHANGES_REQUESTED: "59xxxxx",
}
```

### 2. `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs` — Ingest

**`normalizeTransaction()` at line ~438:** Add `review_status` to `target_row`:

```js
target_row: {
  ...existing,
  [ORDER_FIELD_NAMES.reviewStatus]: "Pending Review",  // <-- NEW
}
```

**Upsert loop at line ~319-348 (CRITICAL):**

- **CREATE path** (line 337): `target_row` includes `review_status: "Pending Review"` — correct.
- **UPDATE path** (line 332): Must NOT include `review_status` in the PATCH payload.
  Before patching existing rows, strip `review_status` from `line.target_row`:

```js
if (existing) {
  const patchPayload = { ...line.target_row };
  delete patchPayload[ORDER_FIELD_NAMES.reviewStatus];  // preserve existing
  const res = await baserowPatchRow({ ...rowId: existing.id, payload: patchPayload });
}
```

This prevents re-ingestion from overwriting an operator's `Approved` status.

`rowsEquivalent()` comparison (line 321) should also exclude `review_status`
from the diff so that the operator-set status does not trigger a false PATCH:

```js
function rowsEquivalent(existingRow, targetRow) {
  const skipKeys = new Set([ORDER_FIELD_NAMES.reviewStatus]);
  for (const key of Object.keys(targetRow)) {
    if (skipKeys.has(key)) continue;
    // ... existing comparison ...
  }
}
```

### 3. `src/lib/shipment-projector.mjs` — Review gate (the primary gate)

**Add SALES_FIELDS entry:**

```js
reviewStatus: "review_status",
```

**Server-side filter — also filter by `review_status = Approved`:**

```js
const salesFilter = {
  [`filter__field_${BASEROW_FIELD.SALES.ORDER_STATUS}__single_select_equal`]:
    BASEROW_OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
  [`filter__field_${BASEROW_FIELD.SALES.REVIEW_STATUS}__single_select_equal`]:
    BASEROW_OPTION.REVIEW_STATUS.APPROVED,                        // <-- NEW
};
```

**Client-side filter — double-check:**

```js
const candidateRows = salesRows.filter((row) => {
  const orderStatus = readSelectValue(row[SALES_FIELDS.orderStatus]);
  const reviewStatus = readSelectValue(row[SALES_FIELDS.reviewStatus]); // <-- NEW
  ...
  if (orderStatus !== "WAITING_FOR_SHIPPING") return false;
  if (reviewStatus !== "Approved") return false;                        // <-- NEW
  ...
});
```

### 4. `src/lib/outbound-sync.mjs` — Secondary gate (prevents bypass)

**Problem (Codex finding #1):** Once a shipment row exists, Phase 3 syncs it
without checking whether the sales order is still approved.

**Problem (Codex finding #3):** Current cancellation detection only scans
`WAITING_FOR_SHIPPING` sales rows (line 251-253), so `CANCELED` rows are
missed. The code comment (line 250) acknowledges this.

**Fix — `collectScopedGroups()` at line ~233:**

Replace the single `WAITING_FOR_SHIPPING` query with two parallel queries:

```js
// Fetch sales data needed for both review gate and cancellation detection
const [salesWfs, salesCanceled] = await Promise.all([
  listAllRows(client, client.salesOrderTableId, {
    [`filter__field_${BASEROW_FIELD.SALES.ORDER_STATUS}__single_select_equal`]:
      BASEROW_OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
  }),
  listAllRows(client, client.salesOrderTableId, {
    [`filter__field_${BASEROW_FIELD.SALES.ORDER_STATUS}__single_select_equal`]:
      BASEROW_OPTION.ORDER_STATUS.CANCELED,
  }),
]);
const salesRows = [...salesWfs, ...salesCanceled];
```

Add a **review status allowlist** check in the `filtered` loop (around line 266):

```js
// Build allowlist: order IDs that are both WAITING_FOR_SHIPPING and Approved
const approvedOrderIds = new Set(
  salesWfs
    .filter((row) => {
      const rs = normalizeFieldText(row.review_status).toUpperCase();
      return rs === "APPROVED" || !rs;  // empty = legacy pre-gate rows
    })
    .map((row) => normalizeOrderId(row.order_id))
    .filter(Boolean),
);
```

Then gate the shipment filter:

```js
const filtered = inScope.filter((row) => {
  if (shouldSkipFeeRow(row)) return false;
  const orderId = normalizeOrderId(row[GIGA_FIELDS.orderId]);
  if (!approvedOrderIds.has(orderId)) return false;  // <-- review gate
  if (canceledOrderIds.has(orderId)) return false;
  ...
});
```

This ensures:
- Only approved orders' shipments reach Giga
- Canceled orders are blocked (even if their shipment row still exists)
- Both queries run in parallel — no extra latency

### 5. `src/lib/pipeline-health.mjs` — Report held orders separately

**`missingShipments` filter (line 38):** Add `review_status = Approved` check
so pending-review orders aren't reported as "missing":

```js
const missingShipments = salesInScope.filter((row) => {
  if (text(row.order_status) !== "WAITING_FOR_SHIPPING") return false;
  if (readSelectValue(row.review_status) !== "Approved") return false;  // <-- NEW
  ...
});
```

**New counters:**

```js
const pendingReview = salesInScope.filter((row) =>
  text(row.order_status) === "WAITING_FOR_SHIPPING"
  && readSelectValue(row.review_status) === "Pending Review"
);
const changesRequested = salesInScope.filter((row) =>
  text(row.order_status) === "WAITING_FOR_SHIPPING"
  && readSelectValue(row.review_status) === "Changes Requested"
);
```

Return:

```js
return {
  ...existing,
  pending_review_count: pendingReview.length,
  pending_review_orders: pendingReview.slice(0, 50),
  changes_requested_count: changesRequested.length,
  changes_requested_orders: changesRequested.slice(0, 50),
};
```

### 6. `worker/index.js` — Admin endpoints (optional but recommended)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/review-orders` | GET | List orders by `review_status` + shop filters |
| `/admin/review-orders/approve` | POST | Bulk-approve specific order IDs |
| `/admin/review-orders/bulk-approve` | POST | Approve all pending for a shop |

### 7. `src/index.mjs` — CLI mirror (optional)

Same endpoints as worker for CLI debugging.

## Operator Workflow

1. Open **Mercari Sales Orders** table in Baserow
2. Filter: `review_status` = `Pending Review`
3. Per order:
   - Review shipping address, buyer info, SKUs, pricing
   - Edit any field inline (address, phone, name, quantity)
   - Set `review_status` → `Approved`
4. Pipeline picks it up within ~10 min (next projector cron)
5. Once shipped, tracking flows back automatically (P4) and order closes on Mercari (P5)

No custom dashboard needed — Baserow is the review interface.

When Rakuten/Amazon are added, same workflow — just open their respective sales order table instead.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Re-ingestion of approved order** | `review_status` preserved (stripped from PATCH payload) |
| **Operator edits address after approval** | Projector detects change via `rowsEquivalent()`, updates shipment row |
| **Order already synced to Giga** | Outbound sync skips it (`giga_sync_status` filter) |
| **Buyer cancels after approval** | Outbound sync now fetches `CANCELED` rows and blocks shipment |
| **New order arrives** | Default `Pending Review`; does not proceed |
| **Operator un-approves** | Set back to `Pending Review` or `Changes Requested` in Baserow |
| **Bulk approval needed** | Use `/admin/review-orders/approve` API |
| **Legacy orders (no review_status field)** | `readSelectValue()` returns empty; treated as "no value" — does NOT pass Approved filter. Fixed by migration. |
| **Order already in Giga, then review_status changed** | No effect — P4/P5 are independent of review_status. Giga order cannot be revoked. |
| **Rakuten/Amazon platform added later** | Each gets its own `review_status` field on its own sales order table. Same pattern applies. |

### What review_status does NOT affect

| Pipeline phase | Affected by review gate? | Reason |
|----------------|--------------------------|--------|
| P1: Ingest | No | Ingest runs on schedule, creates `Pending Review` orders |
| P2: Project | **Yes** | Only `Approved` orders are projected to Giga shipments |
| P3: Outbound sync | **Yes** | Secondary check: only `Approved` + not-canceled can sync |
| P4: Tracking pull | No | Operates on existing shipment rows, not sales review status |
| P5: Marketplace close | No | Operates on shipped orders, not sales review status |
| Cancellation reconciler | No | Detects cancellations independently of review status |

## Migration

### One-time backfill for existing in-flight orders

Goal: set `review_status = Approved` on existing orders that are already
flowing through the pipeline, so the review gate doesn't block them.

Rule: set `Approved` only on rows that meet ALL criteria:
- `order_status = WAITING_FOR_SHIPPING`
- Has at least one corresponding shipment row (same `order_id`, same shop)
- Shipment is Mercari channel (not other platform)
- Sales row is not a fee-only row (`product_name` excludes "各種手数料")
- Sales row is not `CANCELING` or `CANCELED`

**Procedure:**

1. Run dry-report: count candidates, sample first 20 rows
2. Manual review of sample
3. Run patch via CLI script
4. Verify: health snapshot shows 0 `pending_review` for those orders

## Implementation Order

### Phase A — Foundation (Mercari only, shared infrastructure)

| Step | File(s) | Depends on |
|------|---------|------------|
| 1 | Baserow UI — add `review_status` field to Mercari Sales Orders, note IDs | Nothing |
| 2 | `src/lib/baserow.mjs` — register constants (field IDs + option IDs) | Step 1 |
| 3 | `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs` — ingest changes | Step 2 |
| 4 | `src/lib/shipment-projector.mjs` — primary review gate filter | Step 2 |
| 5 | `src/lib/outbound-sync.mjs` — secondary gate + cancel-fetch fix | Step 2 |
| 6 | `src/lib/pipeline-health.mjs` — held-order reporting | Step 4 |
| 7 | Migration: backfill existing in-flight Mercari orders | Steps 1-4 |

### Phase B — Operator interfaces (optional)

| Step | File(s) | Depends on |
|------|---------|------------|
| 8 | `worker/index.js` — admin review endpoints (GET list, POST approve) | Step 2 |
| 9 | `src/index.mjs` — CLI mirror | Step 8 |

### Phase C — Future platforms (Rakuten / Amazon)

| Step | File(s) | Depends on |
|------|---------|------------|
| 10 | Baserow UI — add `review_status` field to Rakuten/Amazon table | Nothing |
| 11 | New ingest script (per platform) — set `review_status` on create, preserve on update | Phase A patterns |
| 12 | New projector (per platform) — filter `review_status = Approved` | Phase A patterns |
| 13 | Outbound sync, tracking, close — reuse existing shared modules | Already works |

## Rollback Plan

If the review gate causes issues:

1. Remove both filters in `shipment-projector.mjs` (server-side + client-side)
2. Remove the allowlist check in `outbound-sync.mjs`
3. Revert ingest script changes (stop setting `review_status` on create)
4. (Optional) Set all `review_status` fields back to empty in Baserow

The pipeline returns to fully automatic mode in one deploy. No data loss —
orders that were pending review remain in the sales table, just not gated.

### Per-platform rollback

For future platforms (Rakuten/Amazon), rollback is isolated to that platform:
- Remove review gate in that platform's projector only
- Other platforms' review gates continue working independently

---

## Auto-Approval Implementation

The auto-approval pipeline runs on the same cron as `build_giga_shipments` (`3,13,23,33,43,53 * * * *`).

### Rule Evaluation (OR Semantics)

Two rules are evaluated per non-fee line using **OR semantics** — a line passes if ANY rule matches:

| Rule | Enabled | Standard Gate | Margin | Stock Constraints | Use Case |
|------|---------|--------------|--------|------------------|----------|
| `low_stock_good_margin` | ✅ | No | >= 8% | `maxOwnedQty: 0`, `maxQtyAvailable: 5` | Own stock empty, limited supplier, healthy margin |
| `standard_order_approval` | ✅ | Yes | >= 11% | None | Standard order: WAITING_FOR_SHIPPING, prior purchase, sufficient margin |

### Hard Blocks (Always Apply)

- **Hokkaido / Okinawa**: Never auto-approved (elevated shipping costs)
- **Empty `shipping_state`**: Never auto-approved (fail closed — missing address = manual review)
- **Fee-only rows**: Always skipped from evaluation
- **Missing B2BItemCode / product on non-fee rows**: Always fails
- **Insufficient stock**: Never auto-approved unless either owned stock or supplier stock covers the full order quantity
- **Missing stock data**: Fails closed unless the known stock source already covers the full order quantity

Owned and supplier stock are alternative fulfillment sources, not a combined pool.
For example, an order for two units remains eligible when `ownedQty: 2` and
`qtyAvailable: 0`; `ownedQty: 1` and `qtyAvailable: 1` does not qualify.

### Standard Order Approval Gate

The `standard_order_approval` rule gates on two conditions:
- **`order_status` must be `WAITING_FOR_SHIPPING`** — ensures the order is in the shipping pipeline
- **`purchase_date` must be strictly before today in JST** — ensures the buyer purchased before the current day

The `low_stock_good_margin` rule does not use this gate (it has its own stock-based constraints instead).

The legacy `paymentDateGate` mechanism (checking `payment_date` N+1) is preserved for backward-compatible env-var custom rules but is no longer used by any default rule.

### Patch Fields Written

When an order is auto-approved, each row receives:
- `review_status` → `Auto-Approved`
- `auto_approval_rule` → comma-separated rule name(s) that matched
- `auto_approved_at` → JST ISO timestamp
- `order_comments` → prepended audit entry

### Configuration

Rules can be overridden via `AUTO_APPROVAL_RULES_CONFIG` env var (JSON):

```json
{"rules":[
  {"name":"low_stock_good_margin","enabled":true,"paymentDateGate":false,"thresholds":{"maxOwnedQty":0,"maxQtyAvailable":5,"minMarginPercent":8}},
  {"name":"standard_order_approval","enabled":true,"thresholds":{"minMarginPercent":11}}
]}
```

### Module Structure

- **`src/lib/auto-approval.mjs`**: Rule definitions, evaluation, main entry point
- **`src/lib/__tests__/auto-approval.test.mjs`**: 70+ tests covering all rules, OR logic, payment gate, geographic exclusion, shipping state fail-closed, and message sending
- **`src/lib/baserow.mjs`**: Field IDs for `auto_approval_rule` (9308210) and `auto_approved_at` (9308212)
