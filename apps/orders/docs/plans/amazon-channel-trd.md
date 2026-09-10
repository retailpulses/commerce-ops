# TRD: Amazon Order Channel — Portal & Pipeline Integration

**Status:** Draft  
**Author:** Jim Yang + Claude  
**Date:** 2026-07-16  
**Issue:** [#157](https://github.com/retailpulses/OrderMgmt/issues/157)

## 1. Objective

Add Amazon (Amazon.co.jp) as a fully supported sales channel in the OrderMgmt
portal and pipeline, following the exact same pattern used for Rakuten.

Amazon orders ingested via SP-API appear in the Order Review Portal alongside
Mercari orders, flow through the same review → B2B code resolution → projection
→ GigaB2B → tracking → close pipeline, and are filterable by `channel=amazon`.

## 2. Background

### 2.1 Current state

| Capability | Mercari | Rakuten | Amazon |
|-----------|---------|---------|--------|
| Order ingestion | ✅ | ✅ | ❌ |
| Portal review queue | ✅ | ❌ (portal hardcodes mercari) | ❌ |
| B2B item code resolution | ✅ (SKU = code) | ✅ (manage_number → links) | ❌ |
| Shipment projection | ✅ | ✅ | ❌ |
| GigaB2B outbound sync | ✅ | ✅ | ❌ |
| Tracking reconciliation | ✅ | ✅ | ❌ |
| Marketplace close | ✅ | ⚠️ (unscheduled) | ❌ |
| Cron schedules | ✅ | ✅ | ❌ |

### 2.2 What already exists for Amazon

- **Supabase schema**: `sales_channel` CHECK constraint already includes `'amazon'`
- **GigaB2B outbound sync**: Recognizes `"Amazon"` as a valid `SalesChannel`
- **SKU→B2B mapping data**: 87 `platform_listings` rows with `platform = 'amazon'`,
  linked via `product_platform_links` → `product_variants.item_code`
- **amazonops repo**: Existing SP-API tooling at `retailpulses/amazonops` (listing
  sync, price management, inventory flatfile)
- **Platform account**: Likely already registered in `platform_accounts`

### 2.3 Amazon SP-API order data shape

Amazon SP-API `Orders` API (v0) returns:

```
OrderList[].{
  AmazonOrderId,          // e.g. "503-9773225-8558223"
  OrderStatus,            // "Unshipped", "Shipped", "Canceled"
  PurchaseDate,
  OrderTotal.{Amount, CurrencyCode},
  BuyerInfo.{BuyerName, BuyerEmail},
  ShippingAddress.{Name, AddressLine1-3, City, StateOrRegion,
                   PostalCode, CountryCode, Phone},
  PaymentMethod,
  FulfillmentChannel,     // "AFN" (FBA) or "MFN" (merchant-fulfilled)
}

OrderItems[].{
  ASIN,                   // Amazon product identifier
  SellerSKU,              // OUR SKU (matches platform_listings.external_listing_id)
  Title,
  QuantityOrdered,
  ItemPrice.{Amount, CurrencyCode},
  OrderItemId,
}
```

Each order item becomes one `sales_orders` row (same model as Mercari/Rakuten).

**Key difference from Rakuten**: Orders with `FulfillmentChannel = AFN` (FBA) are
Fulfilled-by-Amazon — Amazon handles shipping, tracking, and customer service.
These should be **ingested but excluded from GigaB2B projection** (Amazon ships
from their own warehouse, not from Giga).

## 3. Design

### 3.1 Architecture (identical to Rakuten)

```
Amazon SP-API  ←→  VPS Relay  ←→  Cloudflare Worker  ←→  Supabase  ←→  GigaB2B
     │                                                            │
     │  ListOrders / GetOrder                                     │
     │  (seller-sku = key)                                        │
     │                                                            │
     └── SP-API endpoints on ConoHa VPS                           │
         (same VPS as Mercari/Rakuten relay)                     │
```

### 3.2 SKU → B2B Item Code Resolution

Same pattern as Rakuten, different lookup column:

| Platform | Listing table | Key column | Link table | Target column |
|----------|-------------|------------|------------|---------------|
| Rakuten | `platform_listings` | `manage_number` | `product_platform_links` | `product_variants.item_code` |
| Amazon | `platform_listings` | `external_listing_id` | `product_platform_links` | `product_variants.item_code` |

```sql
-- Amazon resolution query (two-step, set-based)
-- Step 1: seller-sku → listing_id
SELECT id FROM platform_listings
WHERE platform = 'amazon' AND external_listing_id IN ($sellerSkus);

-- Step 2: listing_id → variant.item_code
SELECT ppl.listing_id, pv.item_code, pv.raw_payload
FROM product_platform_links ppl
JOIN product_variants pv ON pv.id = ppl.variant_id
WHERE ppl.listing_id IN ($listingIds);
```

Unlike Rakuten (which has color-based variant disambiguation), Amazon
seller-skus are expected to have 1:1 mapping to product variants. If a
seller-sku maps to multiple variants, fail closed (same as Rakuten).

### 3.3 Order status mapping

| Amazon OrderStatus | Supabase order_status | Notes |
|-------------------|----------------------|-------|
| `Unshipped` | `PENDING_CONFIRMATION` | Awaiting operator review |
| `Shipped` | `WAITING_FOR_SHIPPING` (or `CONFIRMED`) | Already shipped by Amazon (FBA) |
| `Canceled` | `CANCELED` | Canceled on Amazon |

**FBA handling**: Orders with `FulfillmentChannel = AFN`:
- Ingest as `order_status = WAITING_FOR_SHIPPING` (bypasses review gate —
  Amazon handles fulfillment, no Giga shipment needed)
- Set `review_status = AUTO_APPROVED`
- Skip shipment projection entirely
- Tracking reconciliation still applies (pull tracking from Giga? Or from
  Amazon? For FBA, tracking is on Amazon — not in Giga. Skip tracking
  reconciliation for FBA orders.)

### 3.4 Portal channel integration

The portal currently hardcodes `channel=mercari` in
`shared.mjs:validatePortalParams`. This needs to become channel-aware.

**Changes needed:**

| File | Change |
|------|--------|
| `src/lib/channel-config.mjs` | Add `AMAZON_CHANNEL` config |
| `src/lib/portal/shared.mjs` | Allow `channel=amazon` in validation; add Amazon shop IDs |
| `src/lib/portal/order-list.mjs` | Dispatch `buildServerFilters` by channel config |
| `src/lib/portal/handlers.mjs` | Channel-aware detail/approve/memo handlers (read `sales_channel` from row) |
| `portal/src/components/layout/FilterBar.tsx` | Add channel dropdown (Mercari / Rakuten / Amazon) |

### 3.5 FBA vs MFN — two paths

```
Amazon order ingested
  │
  ├── FulfillmentChannel = "AFN" (FBA)
  │     order_status = WAITING_FOR_SHIPPING
  │     review_status = AUTO_APPROVED
  │     → Skip Giga shipment projection
  │     → Portal: visible, no B2B code needed
  │     → Tracking: pull from Amazon SP-API (future)
  │
  └── FulfillmentChannel = "MFN" (merchant)
        order_status = PENDING_CONFIRMATION
        review_status = PENDING_REVIEW
        → Operator reviews, resolves B2B code
        → Projector creates Giga shipment row
        → Outbound sync pushes to Giga
        → Tracking from Giga, close on Amazon (future)
```

**First iteration: MFN only.** FBA orders can be ingested but the FBA
tracking/close path is deferred. MFN is the critical path — these are the
orders we ship from our warehouse via GigaB2B.

## 4. Implementation Phases

### Phase 1: Ingest (Amazon orders → Supabase)

**New files:**
- `src/lib/amazon-relay.mjs` — Worker → VPS relay HTTP calls
- `src/lib/amazon-ingest.mjs` — SP-API order → Supabase sales_orders row

**Modified files:**
- `relay/server.mjs` — Add `POST /admin/amazon-ingest` endpoint
- `relay/` — Add Amazon SP-API order fetching script (or inline in server.mjs)

**Work on VPS:**
- Verify SP-API credentials are available on ConoHa VPS
- Add Amazon SP-API order fetch logic to relay server (or as spawned script)

**Cron:**
- Add `pull_amazon_orders` phase to `worker/index.js`
- Schedule: `3 * * * *` (offset from Mercari at :01 and Rakuten at :02)

**Output:** Amazon orders appear in `sales_orders` with `sales_channel = 'amazon'`,
visible in Supabase but NOT yet in the portal.

### Phase 2: Item Code Resolution

**Modified files:**
- `src/lib/item-code-resolver.mjs` — Add `createAmazonItemCodeResolver(client)`

**Pattern:** Near-identical to `createRakutenItemCodeResolver`, but queries
`platform_listings.external_listing_id` instead of `manage_number`:
```
seller-sku → platform_listings (platform='amazon') → product_platform_links → item_code
```

No color-based variant disambiguation needed (simpler than Rakuten). If a
seller-sku maps to multiple item_codes, fail closed with reason `ambiguous_mapping`.

**Also needed for ingest:** During ingest, attempt to resolve B2B item code
automatically (same `preserveOrResolveB2BItemCode` pattern as Rakuten).

### Phase 3: Portal Channel Support

**Modified files:**
- `src/lib/channel-config.mjs` — Add `AMAZON_CHANNEL`:
  ```js
  export const AMAZON_CHANNEL = Object.freeze({
    salesChannel: "Amazon",
    shopIds: Object.freeze({ Amazon: "Amazon" }),
    salesOrderIdField: "order_id",
    salesStatusFilters: Object.freeze([
      { field: FIELD.SALES.ORDER_STATUS, optionId: OPTION.AMAZON_ORDER_STATUS.PENDING_CONFIRMATION },
    ]),
    patchSales: false, // Amazon close not implemented yet
    itemCodeResolver: amazonResolveItemCode,
  });
  ```
- `src/lib/portal/shared.mjs`:
  - `validatePortalParams`: Add `'amazon'` to allowed channels
  - Add Amazon shop ID validation
- `src/lib/portal/order-list.mjs`:
  - `buildServerFilters`: Accept channel param, dispatch to correct channel's shopIds
  - `handlePortalOrderList`: Use `sales_channel` filter in Supabase query
- `portal/src/components/layout/FilterBar.tsx`: Add channel selector dropdown
- `portal/src/lib/constants.ts`: Add Amazon shop/channel labels

**DB fields needed:**
- Add `review_status` enum values if Amazon-specific review workflow differs
- `OPTION.AMAZON_ORDER_STATUS` (if using single_select style; on Supabase it's text)

### Phase 4: Shipment Projection

**New files:**
- `src/lib/amazon-projector.mjs` — Amazon sales → Giga shipment rows

**Pattern:** Near-identical to `rakuten-projector.mjs`:
- Filter: `sales_channel = 'amazon'`, `order_status = 'CONFIRMED'`
- Exclude: `FulfillmentChannel = 'AFN'` (FBA orders — no Giga shipment)
- Map: same `SHIPMENT_FIELDS` mapping, `SalesChannel = "Amazon"`,
  `ShipFrom = "HomesBliss Amazon"`, `SourceStoreID = "Amazon"`

**Modified files:**
- `worker/index.js` — Add `build_amazon_shipments` phase
- `src/lib/outbound-sync.mjs` — Already supports Amazon (line 47); verify

### Phase 5: Tracking & Close (deferred)

These can follow the Rakuten pattern:
- `sync_amazon_tracking` — `reconcileShippingInfo(env, { salesChannel: "Amazon" })`
- `close_amazon_orders` — SP-API `SubmitFeed` for shipping confirmation (requires
  Amazon SP-API Feeds API; verify endpoint before scheduling)

**Defer to Phase 5b** — Amazon close is lower priority since MFN volume is
expected to be low initially.

## 5. Cron Schedule

Proposed schedule (interleaved with existing phases):

```
# Amazon
3 * * * *              pull_amazon_orders
12,22,32,42,52 * * * * build_amazon_shipments
14,24,34,44,54 * * * * push_amazon_orders_to_giga
18,28,38,48,58 * * * * sync_amazon_tracking
# close_amazon_orders — unscheduled (same reason as Rakuten)
```

| Minute | Mercari | Rakuten | Amazon |
|--------|---------|---------|--------|
| :01 | pull | | |
| :02 | | pull | |
| :03 | | | **pull** |
| :03-:07 | build (×6) | | |
| :05-:09 | push (×6) | push (×6) | |
| :07-:09 | | build (×6) | |
| :08-:10 | tracking (×6) | | |
| :10-:12 | | tracking (×6) | |
| :12-:14 | | | **build** (×6) |
| :14-:16 | | | **push** (×6) |
| :18-:20 | | | **tracking** (×6) |

This keeps each platform's phases clustered and avoids overlap.

## 6. Files Summary

### New files (6)
| File | Purpose |
|------|---------|
| `src/lib/amazon-relay.mjs` | Worker → VPS relay HTTP calls for SP-API |
| `src/lib/amazon-ingest.mjs` | SP-API order → Supabase sales_orders row |
| `src/lib/amazon-projector.mjs` | Amazon sales → Giga shipment projection |
| `relay/amazon-sp-api.mjs` | SP-API order fetch logic (on VPS) |
| `docs/plans/amazon-channel-trd.md` | This document |
| *(test files)* | Unit tests for ingest, projector, resolver |

### Modified files (10)
| File | Change |
|------|--------|
| `src/lib/channel-config.mjs` | Add `AMAZON_CHANNEL` |
| `src/lib/item-code-resolver.mjs` | Add `createAmazonItemCodeResolver` |
| `src/lib/portal/shared.mjs` | Allow `amazon` channel, Amazon shop validation |
| `src/lib/portal/order-list.mjs` | Channel-aware filter dispatch |
| `src/lib/db-fields.mjs` | Add Amazon-specific field/option constants if needed |
| `src/lib/order-state.mjs` | Add Amazon order status definitions |
| `worker/index.js` | 5 new phases + cron schedule |
| `relay/server.mjs` | `POST /admin/amazon-ingest` endpoint |
| `portal/src/components/layout/FilterBar.tsx` | Channel selector |
| `portal/src/lib/constants.ts` | Amazon labels |

### Not modified
| File | Reason |
|------|--------|
| `src/lib/outbound-sync.mjs` | Already supports `SalesChannel = "Amazon"` (line 47) |
| `src/lib/tracking-reconciler.mjs` | Channel-agnostic; works via `channelConfig` |
| `supabase/migrations/` | Schema already has `'amazon'` in CHECK constraint |

## 7. Risk & Decisions

### 7.1 FBA handling
- **Decision**: Ingest FBA orders but skip Giga projection. Portal shows them
  as informational.
- **Risk**: Operator confusion — FBA and MFN orders look similar.
- **Mitigation**: `FulfillmentChannel` field on sales row; badge in portal.

### 7.2 SP-API credential availability
- **Unknown**: Are SP-API credentials (refresh token, client ID, client secret)
  available on the ConoHa VPS? They may only exist on the MacBook or in the
  `amazonops` repo.
- **Action**: Verify credential availability before starting Phase 1.

### 7.3 SP-API rate limits
- Amazon SP-API has stricter rate limits than Rakuten RMS. The `ListOrders`
  endpoint may need throttling.
- **Mitigation**: Start with low-frequency cron (every 60 min) and tune up.

### 7.4 MFN order volume
- Currently unknown. If MFN volume is near-zero, Phase 4 (projection) and
  Phase 5 (tracking/close) can be deferred until volume justifies it.

## 8. Success Criteria

1. **Phase 1**: `pull_amazon_orders` ingests order `503-9773225-8558223` into
   `sales_orders` with `sales_channel = 'amazon'`
2. **Phase 2**: B2B item code auto-resolved for seller-skus that have
   `product_platform_links` mappings
3. **Phase 3**: Amazon orders visible in portal at `?channel=amazon`,
   filterable, reviewable, editable (B2B code, memo, approve/hold)
4. **Phase 4**: MFN orders with `order_status = CONFIRMED` and
   `b2b_item_code` set are projected to `giga_shipment_projections` and
   pushed to GigaB2B
5. **Phase 5**: Tracking flows back from Giga to sales rows; close on Amazon
   (deferred)

## 9. References

- [Issue #157](https://github.com/retailpulses/OrderMgmt/issues/157) — Amazon order not in portal
- [Rakuten pipeline doc](../rakuten-order-pipeline.md)
- [Sales order review design](../sales-order-review.md)
- [Supabase migration design](../design/supabase-migration-design.md)
- Amazon SP-API docs: [Orders API v0](https://developer-docs.amazon.com/sp-api/docs/orders-api-v0-reference)
- `retailpulses/amazonops` — Existing SP-API tooling
