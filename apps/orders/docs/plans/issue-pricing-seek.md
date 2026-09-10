# Pricing Seek — Detect cost=sale-price orders and push to WeCom for supplier pricing confirmation

## Summary

When a product's sale price equals its known procurement cost
(`product_commercials.effective_cost_price = sales_orders.source_unit_price`), the
order is at break-even — no margin. This feature automatically detects those lines and
pushes a summary to the Technovation Group WeCom channel so operators can verify supplier
pricing before fulfillment.

## Why

Supplier prices drift. A product sold at ¥5,000 that cost ¥5,000 last month may now cost
¥5,300 — turning break-even into a loss. Currently operators manually scan orders and
message suppliers. This automates detection and notification.

## Detection Condition

```
product_commercials.effective_cost_price = sales_orders.source_unit_price
```

Join path: `sales_orders.b2b_item_code → product_variants.item_code → product_commercials.variant_id`.

## Scope

### In scope
- Mercari orders with `review_status IN (AUTO_APPROVED, APPROVED)`, purchased today JST
- JOIN to `product_commercials` via `b2b_item_code → product_variants → variant_id`
- Detect where `effective_cost_price = source_unit_price`
- Push markdown table to WeCom (Technovation Group: `key=7d6bb76a-21f2-4699-82ff-e8095f9b0abc`)
- Idempotency via `pricing_seek_notifications` table
- Manual trigger via `/run/pricing-seek` with dry-run mode
- 3x daily cron: 09:00, 13:00, 17:00 JST

### Out of scope
- Automated supplier response parsing
- Auto-updating product costs from supplier replies
- Multi-platform (Rakuten, Amazon) — Phase 2

## Example WeCom Message

```markdown
### 🔍 Pricing Seek — 2026-07-17 JST
Push time: 2026-07-17 09:05 JST
Cost = Sale price today: 3 lines across 2 orders

| SKU | Product | Cost Price | Sale Price | Qty | Shop | Order ID |
|---|---|---|---|---|---|---|
| NK-2204 | ナイキ エアマックス 90 | ¥12,800 | ¥12,800 | 1 | Shop4 | M-20260717-001 |
| AD-3310 | アディダス スタンスミス | ¥8,500 | ¥8,500 | 2 | Shop1 | M-20260717-002 |
```

## Implementation

See [docs/design/pricing-seek-design.md](../design/pricing-seek-design.md) for full
architecture, data flow, schema changes, and edge cases.

### Files

| Action | File |
|---|---|
| **Create** | `workers/mercari-reporting/src/pricing-seek.js` — core logic |
| **Create** | `supabase/migrations/YYYYMMDDHHMMSS_pricing_seek_schema.sql` — new columns + idempotency table |
| **Modify** | `workers/mercari-reporting/src/index.js` — cron + endpoint |
| **Modify** | `workers/mercari-reporting/src/wecom.js` — optional webhookUrl param |
| **Modify** | `workers/mercari-reporting/wrangler.toml` — cron trigger |
| **Modify** | `workers/mercari-reporting/secrets-checklist.md` — new secret |
| **Modify** | `src/lib/supabase.mjs` — `effective_cost_price` field resolution |

### Schema Changes

| Table | Change |
|---|---|
| `sales_orders` | Add `source_unit_price numeric(12,2)` — backfill from `product_price` |
| `product_commercials` | Add `effective_cost_price numeric(12,2)` — backfill from `effective_tcogs` where appropriate |
| `pricing_seek_notifications` | New table with `UNIQUE(order_id, product_name)` |

### New Secret

| Secret | Purpose |
|---|---|
| `WECOM_PRICING_SEEK_WEBHOOK_URL` | Technovation Group webhook URL |

## Acceptance Criteria

- [ ] `POST /run/pricing-seek?dry_run=true` returns preview without WeCom push
- [ ] `POST /run/pricing-seek` sends markdown to WeCom, returns send status
- [ ] Cron fires at 09:00, 13:00, 17:00 JST
- [ ] Detection: `effective_cost_price = source_unit_price` (exact match)
- [ ] Products without matching `product_commercials` row are silently skipped
- [ ] Products with NULL `effective_cost_price` are silently skipped
- [ ] Same `(order_id, product_name)` never notified twice
- [ ] Fee rows excluded
- [ ] Dry run works when no matches exist (`costPriceMatches: 0`)
- [ ] WeCom push failure (after 4 retries) is logged, row NOT written to notifications table
- [ ] Silent skip when no matches found (no WeCom push)

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
