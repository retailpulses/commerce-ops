# Pricing Seek Notification — Design Doc

## Status

Draft for review.

## Motivation

Supplier procurement prices drift over time. A product that was profitable last week may
not be today. Operators need to verify current supplier pricing whenever a product sells —
especially when the sale price sits at or near the known cost price.

Currently operators manually scan new orders in the Portal, compare against product costs,
and message the supplier group on WeCom. This is error-prone and doesn't scale.

**Goal**: Automatically detect orders where a product's sale price matches its known
procurement cost (`effective_cost_price = source_unit_price`), compile a summary, and
push it to the Technovation Group WeCom channel so the team can forward to the relevant
seller chat for pricing confirmation.

## Scope

- **Phase 1 (MVP)**: Detect products where `product_commercials.effective_cost_price =
  sales_orders.source_unit_price` from newly approved Mercari orders, push 3x daily to
  WeCom (Technovation Group webhook).
- **Phase 2**: Multi-platform support (Rakuten, Amazon).
- **Out of scope**: Automated supplier response parsing, auto-updating product costs from
  supplier replies, bid/ask negotiation workflow.

## Detection Condition

```
product_commercials.effective_cost_price = sales_orders.source_unit_price
```

A sales order line triggers pricing seek when the product's **effective cost price**
(what the supplier charges) equals the **source unit price** (what the product sold for
on the marketplace). This is the break-even scenario — no margin → urgent pricing
verification needed.

### Field Definitions

| Field | Table | Type | Description | Status |
|---|---|---|---|---|
| `effective_cost_price` | `product_commercials` | numeric(12,2) | Per-unit procurement cost from supplier, updated as supplier prices change | **New** — needs migration |
| `source_unit_price` | `sales_orders` | numeric(12,2) | Per-unit sale price on the source marketplace (same as `product_price` today, but named explicitly for its role in cost-price matching) | **New** — needs migration |

### Existing Related Fields (NOT used for detection)

| Field | Table | Why not used |
|---|---|---|
| `product_price` | `sales_orders` | Same value as `source_unit_price` in practice, but `source_unit_price` is the explicit name for this feature's semantics |
| `effective_tcogs` | `product_commercials` | Total cost of goods sold — may include shipping, fees, etc. `effective_cost_price` is the pure per-unit procurement cost |

### Design Decision: New Fields vs Reusing Existing

We create `source_unit_price` and `effective_cost_price` as explicit fields rather than
reusing `product_price` and `effective_tcogs` because:

1. **Semantic clarity** — `effective_cost_price` is distinct from `effective_tcogs`
   (cost price ≠ total cost of goods sold, which may bundle shipping/handling)
2. **Independent evolution** — supplier cost price can be updated independently of TCOGS
3. **Explicit intent** — the field names document the pricing seek workflow directly in
   the schema

### Lookup Path

```
sales_orders.b2b_item_code
  → product_variants.item_code (case-insensitive match)
    → product_variants.id = product_commercials.variant_id
      → product_commercials.effective_cost_price
```

## Architecture

```
Supabase (sales_orders + product_commercials via JOIN)
       │
       │  cron: 09:00, 13:00, 17:00 JST (3x daily, within working hours)
       ▼
┌──────────────────────────────────────────┐
│  rp-order-mgmt-reporting Worker          │
│                                          │
│  src/pricing-seek.js   ← NEW             │
│  ├─ fetchCandidates(env)                 │
│  │    Query sales_orders JOIN            │
│  │    product_variants +                 │
│  │    product_commercials via            │
│  │    b2b_item_code → item_code          │
│  │    Filter: mercari, approved,         │
│  │    today JST, has b2b_item_code       │
│  ├─ detectPricingSeek(rows)              │
│  │    effective_cost_price               │
│  │    = source_unit_price                │
│  ├─ formatPricingSeekMessage(matches)    │
│  │    markdown table: SKU, name,         │
│  │    cost price, sale price, order_id,  │
│  │    shop                               │
│  └─ sendWeCom(env, markdown, webhookUrl) │
│                                          │
│  src/wecom.js  ← MODIFIED                │
│  └─ sendWeCom accepts optional url param │
│                                          │
│  src/index.js  ← MODIFIED                │
│  └─ new cron trigger + /run/pricing-seek │
└──────────────────────────────────────────┘
       │
       │  POST markdown to webhook
       ▼
┌──────────────────────────────────────────┐
│  WeCom Bot — Technovation Group          │
│  Webhook key: 7d6bb76a-...b0abc          │
│                                          │
│  → Operators forward to seller chat      │
│  → Seller responds with current pricing  │
│  → Operator updates product cost data    │
└──────────────────────────────────────────┘
```

### Why the reporting worker?

The `rp-order-mgmt-reporting` worker already has:
- Supabase access (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- WeCom push capability (`wecom.js` with retry logic)
- Cron infrastructure (`scheduled` handler)
- Manual trigger pattern (`/run/*` endpoints with `RUN_SECRET` auth)
- Same data source (`sales_orders` table)

The pricing seek feature is a **reporting/notification** concern, not a pipeline concern.
It does not mutate orders — it only reads and notifies.

## Data Source

### Approach: REST API + Two Queries

Supabase's REST API doesn't support arbitrary JOINs, so we use two queries chained in
code:

**Step 1 — Fetch today's approved orders:**
```
GET /rest/v1/sales_orders
  ?select=order_id,product_name,b2b_item_code,source_unit_price,shipping_price,
          quantity,source_store_id,purchase_date,sales_channel,review_status,
          order_status
  &sales_channel=eq.mercari
  &review_status=in.(AUTO_APPROVED,APPROVED)
  &purchase_date=gte.{today_start_utc}
  &purchase_date=lt.{tomorrow_start_utc}
  &b2b_item_code=not.is.null
  &order=purchase_date.desc
  &limit=500
```

**Step 2 — Batch-resolve product cost prices:**
```
GET /rest/v1/product_variants
  ?select=item_code,product_commercials(effective_cost_price)
  &item_code=in.(b2b_item_code_list_from_step1)
```

Then in code: for each order line where `product_commercials.effective_cost_price` equals
the order's `source_unit_price`, flag as a match.

### Alternative: Direct SQL via Supabase client

If the reporting worker is refactored to use the Supabase JS client instead of REST API,
a single JOIN query is possible:

```sql
SELECT
  so.order_id, so.product_name, so.b2b_item_code,
  so.source_unit_price, so.product_price, so.shipping_price,
  so.quantity, so.source_store_id, so.purchase_date,
  pc.effective_cost_price
FROM sales_orders so
JOIN product_variants pv ON lower(pv.item_code) = lower(so.b2b_item_code)
JOIN product_commercials pc ON pc.variant_id = pv.id
WHERE so.sales_channel = 'mercari'
  AND so.review_status IN ('AUTO_APPROVED', 'APPROVED')
  AND so.purchase_date >= '{today_start_utc}'
  AND so.purchase_date <  '{tomorrow_start_utc}'
  AND so.b2b_item_code IS NOT NULL
  AND so.b2b_item_code != ''
  AND pc.effective_cost_price IS NOT NULL
  AND pc.effective_cost_price = so.source_unit_price
ORDER BY so.purchase_date DESC;
```

**Decision**: Use the Supabase JS client with direct SQL (or `.select()` with embedded
foreign references via PostgREST) for a single round-trip. The reporting worker already
has `SUPABASE_SERVICE_ROLE_KEY` with full query access.

### Filters Applied

| Filter | Reason |
|---|---|
| `review_status IN (AUTO_APPROVED, APPROVED)` | Only approved orders — pending review may change |
| `purchase_date` = today JST | Only fresh orders |
| `b2b_item_code IS NOT NULL` | Must resolve to a product |
| `pc.effective_cost_price IS NOT NULL` | Can't compare if cost price is unknown |
| `pc.effective_cost_price = so.source_unit_price` | The detection condition itself |
| Exclude fee rows (`product_name` matches "各種手数料" etc.) | Fee rows are not products |
| Exclude already-notified rows | Idempotency check |

## Schema Changes

### 1. Add `source_unit_price` to `sales_orders`

```sql
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS source_unit_price numeric(12,2);

COMMENT ON COLUMN sales_orders.source_unit_price IS
  'Per-unit sale price on the source marketplace. Mirrors product_price for the pricing-seek cost-match condition.';
```

### 2. Add `effective_cost_price` to `product_commercials`

```sql
ALTER TABLE product_commercials
  ADD COLUMN IF NOT EXISTS effective_cost_price numeric(12,2);

COMMENT ON COLUMN product_commercials.effective_cost_price IS
  'Per-unit procurement cost from supplier. Compared against sales_orders.source_unit_price for pricing-seek detection.';
```

### 3. Create idempotency table

```sql
CREATE TABLE IF NOT EXISTS pricing_seek_notifications (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     TEXT NOT NULL,
  product_name TEXT NOT NULL,
  notified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_name)
);
```

### Migration Notes

- `source_unit_price` should be backfilled from `product_price` for existing rows
- `effective_cost_price` should be backfilled from `effective_tcogs` where appropriate,
  or populated manually by operators
- The `pricing_seek_notifications` table uses the same reservation pattern as
  `payment_reminders`

## Idempotency

Before sending a WeCom notification for an `(order_id, product_name)` pair, insert a row
into `pricing_seek_notifications`. The unique constraint rejects duplicates. Insert
happens **after** successful WeCom send — if send fails, the row is not written and the
next cron will retry.

## WeCom Message Format

### Markdown Template

```markdown
### 🔍 Pricing Seek — {YYYY-MM-DD JST}
Push time: {YYYY-MM-DD HH:mm JST}
Cost = Sale price today: {N} lines across {M} orders

| SKU | Product | Cost Price | Sale Price | Qty | Shop | Order ID |
|---|---|---|---|---|---|---|
| GIGA-SKU-001 | Product A | ¥5,000 | ¥5,000 | 1 | Shop4 | M-...001 |
| GIGA-SKU-002 | Product B | ¥12,800 | ¥12,800 | 2 | Shop1 | M-...002 |

---
🤖 Auto-generated by rp-order-mgmt-reporting / pricing-seek
```

### Example (with real data)

```markdown
### 🔍 Pricing Seek — 2026-07-17 JST
Push time: 2026-07-17 09:05 JST
Cost = Sale price today: 3 lines across 2 orders

| SKU | Product | Cost Price | Sale Price | Qty | Shop | Order ID |
|---|---|---|---|---|---|---|
| NK-2204 | ナイキ エアマックス 90 | ¥12,800 | ¥12,800 | 1 | Shop4 | M-20260717-001 |
| AD-3310 | アディダス スタンスミス | ¥8,500 | ¥8,500 | 2 | Shop1 | M-20260717-002 |
| NK-2204 | ナイキ エアマックス 90 | ¥12,800 | ¥12,800 | 1 | Shop1 | M-20260717-003 |

---
🤖 Auto-generated by rp-order-mgmt-reporting / pricing-seek
```

### No-match behavior

When no lines satisfy the condition, send nothing (silent skip). Operators don't need a
"zero matches" notification. Dry-run endpoint returns `matches: 0`.

## Secrets & Env Vars

### New secrets

| Secret | Required | Description |
|---|---|---|
| `WECOM_PRICING_SEEK_WEBHOOK_URL` | Yes | Technovation Group webhook (`key=7d6bb76a-...`) |

### Existing secrets (already on worker)

| Secret | Used for |
|---|---|
| `SUPABASE_URL` | Query sales_orders + product_commercials |
| `SUPABASE_SERVICE_ROLE_KEY` | Auth for Supabase API |
| `RUN_SECRET` | Auth for manual `/run/pricing-seek` endpoint |

No `PRICING_SEEK_PRODUCT_MAP` env var — detection is database-driven, not config-driven.

## Cron Schedule

| Trigger | Schedule (UTC) | JST | Rationale |
|---|---|---|---|
| Pricing Seek | `0 0,4,8 * * *` | 09:00, 13:00, 17:00 | 3x daily within working hours, after order batches |

Aligns with working hours (09:00–18:00 JST).

## API Endpoints

### `POST /run/pricing-seek`

```bash
# Dry run — no WeCom push, returns preview
curl -X POST "https://rp-order-mgmt-reporting.retailpulses.workers.dev/run/pricing-seek?dry_run=true" \
  -H "x-run-secret: $RUN_SECRET"

# Live run — pushes to WeCom
curl -X POST "https://rp-order-mgmt-reporting.retailpulses.workers.dev/run/pricing-seek" \
  -H "x-run-secret: $RUN_SECRET"
```

**Response (dry run)**:
```json
{
  "ok": true,
  "job": "pricing-seek",
  "runId": "pricing-seek-20260717T000500Z",
  "trigger": "manual",
  "dryRun": true,
  "startedAt": "2026-07-17T00:05:00.000Z",
  "candidatesFetched": 12,
  "costPriceMatches": 3,
  "preview": "### 🔍 Pricing Seek — 2026-07-17 JST\n..."
}
```

**Response (live)**:
```json
{
  "ok": true,
  "job": "pricing-seek",
  "runId": "pricing-seek-20260717T000500Z",
  "trigger": "manual",
  "dryRun": false,
  "startedAt": "2026-07-17T00:05:00.000Z",
  "candidatesFetched": 12,
  "costPriceMatches": 3,
  "send": { "ok": true, "skipped": false, "status": 200 }
}
```

## Implementation Plan

### Files to create

| File | Purpose |
|---|---|
| `workers/mercari-reporting/src/pricing-seek.js` | Core logic: fetch candidates with JOIN, apply cost=sale condition, format markdown, push to WeCom |
| `supabase/migrations/YYYYMMDDHHMMSS_pricing_seek_schema.sql` | Add `source_unit_price` to sales_orders, `effective_cost_price` to product_commercials, create `pricing_seek_notifications` table |

### Files to modify

| File | Change |
|---|---|
| `workers/mercari-reporting/src/index.js` | Add cron route `0 0,4,8 * * *`, add `/run/pricing-seek` endpoint |
| `workers/mercari-reporting/src/wecom.js` | Accept optional `webhookUrl` parameter (defaults to `env.WECOM_WEBHOOK_URL`) |
| `workers/mercari-reporting/wrangler.toml` | Add cron trigger |
| `workers/mercari-reporting/secrets-checklist.md` | Add `WECOM_PRICING_SEEK_WEBHOOK_URL` |
| `workers/mercari-reporting/package.json` | Add `pricing-seek.js` to validate script |
| `src/lib/supabase.mjs` | Add `effective_cost_price` to product field resolution (pseudo field ID) |

### Implementation Steps

1. **Schema migration** — add `source_unit_price` to `sales_orders`, `effective_cost_price`
   to `product_commercials`, create `pricing_seek_notifications` table
2. **Backfill** `source_unit_price` from `product_price` for existing rows
3. **Update Supabase adapter** — add `effective_cost_price` to product field resolution
   in `src/lib/supabase.mjs`
4. **Create `pricing-seek.js`** — fetch candidates via JOIN, apply detection condition,
   check idempotency, format markdown, push to WeCom
5. **Modify `wecom.js`** — accept optional `webhookUrl` override
6. **Modify `index.js`** — wire up cron trigger and `/run/pricing-seek` endpoint
7. **Update `wrangler.toml`** — add cron expression
8. **Set secret** — `WECOM_PRICING_SEEK_WEBHOOK_URL`
9. **Deploy** — `wrangler deploy`
10. **Smoke test** — dry run first, verify output, then live run

### Key Functions (pricing-seek.js)

```
runPricingSeek(env, options) → { ok, runId, candidatesFetched, costPriceMatches, preview }
  ├─ fetchCandidates(env) → rows[]
  │    Query sales_orders JOIN product_variants + product_commercials
  │    Filter: mercari, approved, today JST, has b2b_item_code
  ├─ detectCostPriceMatches(rows) → Match[]
  │    effective_cost_price = source_unit_price
  │    Skip already-notified rows (pricing_seek_notifications)
  │    Skip fee rows
  ├─ formatPricingSeekMessage(matches, now) → markdown string
  └─ sendWeCom(env, markdown, webhookUrl) → { ok }
```

## Edge Cases

| Scenario | Behavior |
|---|---|
| **No matches today** | Silent skip. Dry run returns `costPriceMatches: 0`. |
| **Product not found in product_commercials** | Skipped. No cost price to compare against. |
| **`effective_cost_price` is NULL** | Skipped. Can't determine if cost = sale price. |
| **`source_unit_price` is NULL** | Skipped. Can't determine sale price. |
| **Same order-line seen twice (cron overlap)** | Idempotency table rejects duplicate. |
| **WeCom push fails (all 4 retries)** | Error logged. Row NOT written to notifications table (retry next cron). |
| **Working hours gate** | Cron fires outside 09:00–17:59 JST → skip. |
| **Multi-product order** | Each line evaluated independently. |
| **Hokkaido/Okinawa orders** | Included — geographic exclusion is for auto-approval margin risk, not pricing seek. |
| **Fee-only rows** | Excluded by product_name pattern match. |
| **Backfill: existing orders without `source_unit_price`** | One-time backfill from `product_price`. New ingests populate `source_unit_price` alongside `product_price`. |

## Rollback

1. Remove cron trigger from `wrangler.toml`
2. Deploy — worker continues serving sales-brief, pricing-seek cron stops
3. (Optional) Drop `pricing_seek_notifications` table
4. (Optional) Remove `WECOM_PRICING_SEEK_WEBHOOK_URL` secret
5. (Optional) Drop new columns (`source_unit_price`, `effective_cost_price`)

No data mutation from the notification path — rollback is a config change with zero order
data impact. The new columns are additive and safe to leave in place.

## Open Questions

1. **`source_unit_price` vs reusing `product_price`**: Are they always the same value?
   If so, we could skip the new column and use `product_price` directly in the condition.
   **Proposal:** Create `source_unit_price` for explicit semantics, backfill from
   `product_price`.
2. **`effective_cost_price` population**: Who updates this field when supplier prices
   change? **Proposal:** Manual operator update for Phase 1; CatalogSync or GigaB2B
   connector for Phase 2.
3. **Message grouping**: Combined message or per-shop? **Proposal:** Combined — fewer
   WeCom notifications.
4. **Multi-platform Phase 2**: Same condition works for Rakuten/Amazon — just change
   `sales_channel` filter.
5. **Price match tolerance**: Currently exact match only (`=`). Should we allow a small
   tolerance (e.g., ±¥1)? **Proposal:** Start with exact match; add tolerance env var
   if false negatives are a problem.
