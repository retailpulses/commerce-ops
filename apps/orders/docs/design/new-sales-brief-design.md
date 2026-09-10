# New Mercari Sales Brief — Multi-Platform Design

## Status

Draft for review.

## Motivation

The current sales brief only covers Mercari orders. OrderMgmt now handles Rakuten orders (with Amazon ingestion planned). The brief should reflect the full multi-platform picture.

## Data Source

Supabase `sales_orders` table (project `gqeyfhshxdiyhugvmbuk`), filtered to all active sales channels.

### Schema Columns Used

| Column | Type | Use |
|---|---|---|
| `sales_channel` | text | Platform filter: `mercari`, `rakuten`, `amazon` |
| `order_status` | text | Status classification |
| `product_price` | numeric(12,2) | Revenue component |
| `shipping_price` | numeric(12,2) | Revenue component |
| `source_store_id` | text | Shop resolution (Mercari) |
| `purchase_date` | timestamptz | Date grouping |

### Revenue = `coalesce(product_price, 0) + coalesce(shipping_price, 0)`

---

## Status Classification by Platform

### Mercari

| Classification | Status Values |
|---|---|
| **Paid / Completed** | Any status except `CANCELED` and `WAITING_FOR_PAYMENT` (e.g. `WAITING_FOR_SHIPPING`, `COMPLETED`) |
| **Waiting Payment** | `WAITING_FOR_PAYMENT` |
| **Excluded** | `CANCELED` |

### Rakuten

| Classification | Status Values |
|---|---|
| **Paid / Completed** | `PENDING_CONFIRMATION`, `CONFIRMED`, `RMS_CONFIRMED` |
| **Waiting Payment** | None — `PENDING_CONFIRMATION` is awaiting shop acknowledgement after purchase |
| **Excluded** | `CANCELED` |

### Amazon (future)

| Classification | Status Values (provisional) |
|---|---|
| **Paid / Completed** | All statuses except `CANCELED` and `PENDING` |
| **Waiting Payment** | `PENDING` |
| **Excluded** | `CANCELED` |

*(To be confirmed when Amazon ingestion is implemented.)*

---

## Shop / Group Mapping

| Group | Included Orders |
|---|---|
| **Mercari Shop 4** | `sales_channel = 'mercari'` AND `source_store_id = '2JMLHBxjiFHDr55jMwA7fs'` |
| **Other Mercari** | `sales_channel = 'mercari'` AND `source_store_id` IN (`WMyisFmhbGWyVAPEwsfirn`, `ZaMyGWzp6hUdgDh5E9ADob`, `2JGrmZqojnBMfdWrtP2xk3`) |
| **Rakuten** | `sales_channel = 'rakuten'` |
| **Amazon** | `sales_channel = 'amazon'` (future) |

---

## New Sales Brief Format

### Overview

The brief is split into 3 sections:

1. **Total** — sum across all platforms
2. **By Platform** — breakdown by channel
3. **By Sales Group** — operational breakdown (Shop 4, Other Mercari, Rakuten, Amazon)

Each section shows **Today** and **Month To Date** metrics.

### Markdown Template

```markdown
### Multi-Platform Sales Brief
Push time: {YYYY-MM-DD HH:mm JST}
Month: {YYYY-MM}

#### Total
- Paid/completed orders: {todayPaidOrders}
- Paid/completed sales: ¥{todayPaidRevenue}
- Paid/completed AOV: ¥{todayPaidAov}
- Waiting payment: ¥{todayWaitingSum}

##### Month To Date
- Paid/completed orders: {mtdPaidOrders}
- Paid/completed sales: ¥{mtdPaidRevenue}
- Paid/completed AOV: ¥{mtdPaidAov}
- Waiting payment: ¥{mtdWaitingSum}

#### By Platform Today
- Mercari: {todayMercariOrders} orders / ¥{todayMercariRevenue}
- Rakuten: {todayRakutenOrders} orders / ¥{todayRakutenRevenue}
- Amazon: {todayAmazonOrders} orders / ¥{todayAmazonRevenue}

#### By Platform Month To Date
- Mercari: {mtdMercariOrders} orders / ¥{mtdMercariRevenue}
- Rakuten: {mtdRakutenOrders} orders / ¥{mtdRakutenRevenue}
- Amazon: {mtdAmazonOrders} orders / ¥{mtdAmazonRevenue}

#### By Sales Group Today
- Mercari Shop 4: {todayShop4Orders} orders / ¥{todayShop4Revenue}
- Other Mercari: {todayOtherMercariOrders} orders / ¥{todayOtherMercariRevenue}
- Rakuten: {todayRakutenOrders} orders / ¥{todayRakutenRevenue}
- Amazon: {todayAmazonOrders} orders / ¥{todayAmazonRevenue}

#### By Sales Group Month To Date
- Mercari Shop 4: {mtdShop4Orders} orders / ¥{mtdShop4Revenue}
- Other Mercari: {mtdOtherMercariOrders} orders / ¥{mtdOtherMercariRevenue}
- Rakuten: {mtdRakutenOrders} orders / ¥{mtdRakutenRevenue}
- Amazon: {mtdAmazonOrders} orders / ¥{mtdAmazonRevenue}

#### Scope
- Paid/completed: excludes `CANCELED` on all platforms; also excludes `WAITING_FOR_PAYMENT` (Mercari) and `PENDING_CONFIRMATION` (Rakuten).
- Waiting payment: includes only the platform-specific "awaiting payment" status for each channel.
```

---

## Example Output

Using July 2026 MTD data (as of 2026-07-16 23:24 JST):

```markdown
### Multi-Platform Sales Brief
Push time: 2026-07-16 23:24 JST
Month: 2026-07

#### Total
- Paid/completed orders: 13
- Paid/completed sales: ¥165,015
- Paid/completed AOV: ¥12,693
- Waiting payment: ¥40,781

##### Month To Date
- Paid/completed orders: 196
- Paid/completed sales: ¥2,656,908
- Paid/completed AOV: ¥13,556
- Waiting payment: ¥110,085

#### By Platform Today
- Mercari: 13 orders / ¥165,015
- Rakuten: 0 orders / ¥0
- Amazon: 0 orders / ¥0

#### By Platform Month To Date
- Mercari: 195 orders / ¥2,628,108
- Rakuten: 1 orders / ¥28,800
- Amazon: 0 orders / ¥0

#### By Sales Group Today
- Mercari Shop 4: 4 orders / ¥65,208
- Other Mercari: 9 orders / ¥99,807
- Rakuten: 0 orders / ¥0
- Amazon: 0 orders / ¥0

#### By Sales Group Month To Date
- Mercari Shop 4: 113 orders / ¥1,496,586
- Other Mercari: 82 orders / ¥1,131,522
- Rakuten: 1 orders / ¥28,800
- Amazon: 0 orders / ¥0

#### Scope
- Paid/completed: excludes `CANCELED` on all platforms; also excludes `WAITING_FOR_PAYMENT` (Mercari) and `PENDING_CONFIRMATION` (Rakuten).
- Waiting payment: includes only the platform-specific "awaiting payment" status for each channel.
```

---

## Implementation Plan

### Files to Change

| File | Change |
|---|---|
| `workers/packages/rp-mercari-reporting/src/index.js` → this repo `workers/mercari-reporting/src/index.js` | Rewrite entirely — new data source (Supabase), new format, multi-platform |
| `workers/mercari-reporting/wrangler.toml` | New worker config, Supabase secrets, cron triggers |

### New Worker Structure (proposed)

```
workers/mercari-reporting/
  src/
    index.js          — entry, cron handler, HTTP endpoints
    sales-brief.js    — fetch + aggregate + format
    cancel-rate.js    — weekly cancel rate (keep as-is, extend to multi-platform)
    wecom.js          — sendWeCom (unchanged)
  wrangler.toml
  package.json
  secrets-checklist.md
```

### Key Functions

```
runSalesBrief(env) → { ok, metrics, preview }
  └─ fetchOrders(env, monthStart, nextMonthStart) → rows[]
  └─ classifyOrder(row) → { group, platform, isPaid, isWaiting, revenue }
  └─ buildBrief(rows, now) → BriefSummary
  └─ formatBrief(summary) → markdown string
  └─ sendWeCom(env, markdown) → { ok }
```

### Secrets / Env Vars

| Secret | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (bypass RLS) |
| `WECOM_WEBHOOK_URL` | Yes | WeCom bot webhook |
| `RUN_SECRET` | No | Auth for manual triggers |

### Cron Schedule

| Report | Schedule (JST) |
|---|---|
| Sales Brief | 08:00, 11:00, 14:00, 17:00, 20:00, 22:00 (6x daily) |
| Cancel Rate Weekly | Monday 09:15 |

### Migration Path

1. Deploy new worker alongside existing `mercari-reporting` worker
2. Run both in parallel for 48h, compare outputs
3. Switch WeCom webhook to point at new worker
4. Archive old worker in `workers` monorepo

---

## Open Questions

1. **Amazon**: Should the template already include Amazon rows (even if ¥0) or only show platforms with data? **Decision:** Show all 3 platforms always — gives operators visibility that Amazon is tracked even when empty.
2. **Rakuten waiting**: `PENDING_CONFIRMATION` is awaiting shop acknowledgement, not customer payment. **Decision (corrected 2026-08-04):** Count it as paid sales; only `CANCELED` is excluded.
3. **Cancel Rate Weekly**: Should this also be extended to multi-platform? **Decision:** Yes, but defer to follow-up issue. Focus on sales brief first.
4. **AOV per group**: Should per-group AOV be shown? **Decision:** No — group AOV is noisy for small groups (Rakuten has 1 order). Only show total AOV.
