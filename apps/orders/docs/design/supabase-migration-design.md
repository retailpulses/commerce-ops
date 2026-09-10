# Supabase Migration — Design Document

**Status:** Draft for review — updated with live Supabase schema (2026-07-10)  
**Umbrella issue:** [#105](https://github.com/retailpulses/OrderMgmt/issues/105)  
**Supabase project:** `gqeyfhshxdiyhugvmbuk` (`ap-northeast-2`, created 2026-06-29)

---

## 0. Existing Supabase Project Inventory

RPagentOS already has a **live Supabase project** with 20 migrations and 50+ tables. OrderMgmt's migration must account for this — we are not designing into a greenfield.

### 0.1 Tables That Overlap with OrderMgmt's Domain

| Live Table | Rows (approx.) | What It Holds | Overlap with OrderMgmt |
|------------|-------|--------------|------------------------|
| `product_variants` | 5,570 | SKU-level: `item_code`, `sku`, `stock_qty`, dimensions, `jan_code` | **Direct overlap** — `item_code` = OrderMgmt's `B2BItemCode` |
| `product_commercials` | (linked) | Per-variant: `effective_tcogs`, `owned_qty`, `fulfillment_fee`, `inventory_status`, `sync_status` | **Direct overlap** — this IS the Baserow Products (886994) table migrated to Supabase |
| `platform_listings` | 5,829 | Platform listings: `platform`, `shop_code`, `external_listing_id`, `current_price`, `listing_status`, `variant_id` | **Partial overlap** — these are the "active listing" side; OrderMgmt tracks the "fulfilled order" side |
| `platform_listing_skus` | (linked) | SKU-level listing data: `stock_qty`, `current_price`, `seller_sku` | Listing detail — OrderMgmt sales lines are the "sold" counterpart |
| `platform_accounts` | (small) | `platform`, `shop_code`, `display_name`, `seller_account_id` | **Direct overlap** — OrderMgmt's Mercari shops (Shop1-4) + Rakuten |
| `giga_cogs_shipment_lines` | (growing) | GigaB2B CSV import: `marketplace_order_id`, `item_code`, `tracking_numbers`, `sales_channel`, `order_status`, `ship_date_at`, `carrier_raw` | **Major overlap** — this IS the Giga shipment data that OrderMgmt Phase 4 pulls via API |
| `giga_cogs_import_batches` | (small) | CSV import batch metadata | OrderMgmt could write these instead of its own `pipeline_runs` |
| `inbound_ticket_messages` | (growing) | Customer messages: `order_transaction_id`, `shop_id`, `latest_buyer_message`, `review_status`, `queue_status` | **Direct overlap** — OrderMgmt Phase 1 message sync |
| `tickets` | (growing) | Customer support tickets: `external_order_id`, `platform`, `status`, `priority` | **Partial overlap** — OrderMgmt's buyer-messages.mjs |
| `ticket_messages` | (linked) | Individual messages: `sender_type`, `body`, `sent_at` | OrderMgmt's message thread display |
| `sent_messages` | (linked) | Sent replies: `platform_message_id`, `body`, `sent_by` | OrderMgmt's reply tracking |
| `copywriting_logs` | (growing) | AI reply generation: `customer_message`, `generated_reply`, `model`, `latency_ms` | OrderMgmt's OpenAI reply generation |
| `message_drafts` | (small) | Message drafts linked to tickets | OrderMgmt's portal templates |
| `agent_runs` | (growing) | Agent execution: `run_type`, `status`, `target_platform` | OrderMgmt's `pipeline_runs` audit log |
| `product_families` / `product_spus` | (small) | Product hierarchy (SPU1, SPU2) | Product grouping for OrderMgmt's presale dashboard |
| `bundle_products` / `bundle_components` | (small) | Bundle/combo products | Future cross-selling context for order review |

### 0.2 Key Relationships Already in Place

```
product_families
  └── product_spus
        └── product_variants (item_code = GigaB2B SKU)
              ├── product_commercials (pricing, inventory, sync status)
              └── platform_listings (via variant_id)
                    └── platform_listing_skus

platform_accounts (platform, shop_code)
  └── platform_listings

giga_cogs_shipment_lines (marketplace_order_id, item_code, tracking_numbers)
  └── giga_cogs_import_batches

tickets (external_order_id, platform)
  ├── ticket_messages
  ├── sent_messages
  └── inbound_ticket_messages (order_transaction_id, shop_id)
```

### 0.3 Critical Gap: No `sales_orders` Table

The live schema has products, listings, Giga shipments, and customer tickets — but **no sales orders table**. OrderMgmt's primary contribution to this ecosystem is the sales order entity: the record that a specific customer bought a specific product on a specific marketplace at a specific time, and that this order flows through review → projection → Giga sync → tracking → close.

### 0.4 Design Implication

OrderMgmt should **extend the existing project** rather than create a separate one. The `sales_orders` table bridges the gap between `platform_listings` (the offer) and `giga_cogs_shipment_lines` (the fulfillment).

---

## Gate 0: Source-of-Truth Inventory

*(Baserow schema fully documented — see original design doc sections 0.2–0.9. Not repeated here for brevity.)*

For the complete Baserow field inventory, option IDs, implicit relationships, business rules, and Portal API surface, see the [extended version in the original commit](https://github.com/retailpulses/OrderMgmt/blob/main/docs/design/supabase-migration-design.md) of this document.

---

## Gate 1: Supabase Database Migration

### 1.0 Key Decision: Same Project or Separate?

**Recommendation: Same Supabase project (`gqeyfhshxdiyhugvmbuk`).**

Rationale:
- `product_variants.item_code` already IS the canonical product identity that OrderMgmt uses as `B2BItemCode`
- `product_commercials` already IS the Baserow Products (886994) table migrated — with `effective_tcogs`, `owned_qty`, `inventory_status` that OrderMgmt's Portal reads for margin/stock
- `giga_cogs_shipment_lines` already receives Giga shipment data — OrderMgmt's Phase 4 tracking reconciliation could write directly to enrich these rows
- `inbound_ticket_messages` already stores Mercari customer messages — OrderMgmt's message sync could write here
- `platform_accounts` already defines shop/platform identity
- Separate project would require cross-database foreign keys or application-level joins

### 1.1 What OrderMgmt Adds (New Tables)

| New Table | Purpose | References |
|-----------|---------|------------|
| `sales_orders` | **The core OrderMgmt entity.** One row per (order_id, shop, product_name). Full lifecycle: ingest → review → project → sync → track → close. | `product_variants.item_code`, `platform_accounts.id` |
| `sales_order_message_state` | Read/latest-message state per sales order (replaces CF KV message tracking). NOT the full message thread — see `sales_order_message_events` for history. | `sales_orders.id` |
| `sales_order_message_events` | *(future)* Full message event log (inbound + outbound) when UI needs threads without VPS relay calls. | `sales_order_message_state.id` |
| `order_message_templates` | Reusable message templates for Portal operators (migrates CF KV template store). Not per-ticket drafts — those live in `message_drafts`. | — |
| `giga_shipment_projections` | Projected shipments created by Phase 2 projector, pushed to Giga by Phase 3. Giga sync status lifecycle. | `sales_orders.id` |
| `pipeline_run_log` | Audit log for pipeline phase execution (replaces Baserow pipeline_runs table) | — |

### 1.2 What OrderMgmt References (Existing Tables — No Changes)

| Existing Table | How OrderMgmt Uses It | Join Key |
|----------------|----------------------|----------|
| `product_variants` | Product lookup for margin/stock in Portal. SKU resolution for Giga projection. | `sales_orders.b2b_item_code` ≅ `product_variants.item_code` (case-insensitive contains match) |
| `product_commercials` | Margin calculation (`effective_tcogs`), stock check (`owned_qty`), inventory status for presale dashboard | via `product_variants.id` |
| `platform_accounts` | Shop identity normalization. `sales_orders.source_store_id` (raw marketplace seller/store ID, e.g. `2JMLHBxjiFHDr55jMwA7fs`) resolves to `platform_accounts.seller_account_id`. `platform_accounts.shop_code` (`shop1`..`shop4`, lowercase) is the human-friendly label. | `platform_accounts.seller_account_id` = `sales_orders.source_store_id` |
| `giga_cogs_shipment_lines` | Read-side: tracking data from Giga CSV import. OrderMgmt's Phase 4 `reconcileShippingInfo` should enrich these rows with tracking → then patch `sales_orders` | `sales_orders.order_id` ≅ `giga_cogs_shipment_lines.marketplace_order_id` |
| — | `inbound_ticket_messages` is an **aftersales** system (post-Completed customer support tickets). OrderMgmt message sync handles **active-order** buyer messages (pre-shipment questions). Different lifecycle phases, different purposes. Keep separate. | — |
| — | `agent_runs` is for **LLM agent** execution logging (AI model runs), not general pipeline auditing. OrderMgmt's cron-based pipeline phases are operational batch processing — keep `pipeline_run_log` standalone. | — |

### 1.3 Complete Schema (New Tables Only)

```sql
-- ============================================================================
-- 1. sales_orders — the core OrderMgmt entity
-- ============================================================================

CREATE TYPE sales_channel AS ENUM ('mercari', 'rakuten', 'amazon', 'yahoo');
-- NOTE: lowercase canonical platform (matches platform_accounts.platform).
-- giga_cogs_shipment_lines.sales_channel uses title case ('Mercari', 'Amazon') —
-- map at the boundary when reading/writing that table.

CREATE TYPE review_status AS ENUM ('PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD');
-- NOTE: matching display values from Baserow review_status single-select options

CREATE TYPE giga_sync_status AS ENUM ('PENDING', 'ATTEMPTED', 'SYNCED', 'ALREADY_EXISTS', 'ERROR', 'INVALID');
-- NOTE: extends giga_cogs_shipment_lines statuses with OrderMgmt-specific states

CREATE TABLE sales_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          TEXT NOT NULL,                        -- normalized (no order_ prefix), case-sensitive
  sales_channel     sales_channel NOT NULL,
  platform_account_id UUID NOT NULL,                       -- FK to platform_accounts (resolved via shop_code matching)
  source_store_id   TEXT NOT NULL,                         -- raw marketplace seller/store ID (e.g., Mercari 2JMLHBxjiFHDr55jMwA7fs)
  order_status      TEXT NOT NULL,                        -- channel-specific status display value
  review_status     review_status NOT NULL DEFAULT 'PENDING_REVIEW',

  -- Product (links to canonical product_variants)
  product_name           TEXT,
  b2b_item_code          TEXT,                            -- matches product_variants.item_code (case-insensitive)
  variant_id             UUID,                            -- FK to product_variants when b2b_item_code resolves
  original_product_id    TEXT,                            -- marketplace product ID (e.g. Mercari p_abc123)
  quantity               INTEGER NOT NULL DEFAULT 1,
  product_price          DECIMAL(10,2),
  shipping_price         DECIMAL(10,2),

  -- Shipping address (mirrored from marketplace — immutable after ingest)
  shipping_name           TEXT,
  shipping_postal_code    TEXT,
  shipping_state          TEXT,
  shipping_city           TEXT,
  shipping_address_1      TEXT,
  shipping_address_2      TEXT,
  shipping_phone_number   TEXT,
  shipping_method         TEXT,
  shipping_carrier        TEXT,

  -- Delivery preferences (operator-editable via Portal)
  requested_delivery_date TEXT,
  requested_delivery_time TEXT,

  -- Buyer
  buyer_name       TEXT,
  order_comments   TEXT,                                  -- memo log (prepended, timestamped)

  -- Tracking (written by Phase 4 tracking reconciliation)
  shipping_completed_at   TIMESTAMPTZ,
  tracking_carrier        TEXT,                           -- multi-package: carriers joined with ' / '
  tracking_number         TEXT,                           -- multi-package: numbers joined with ' / '

  -- Close status (written by Phase 5 marketplace close)
  shop_close_status         TEXT,
  shop_close_attempted_at   TIMESTAMPTZ,
  shop_close_completed_at   TIMESTAMPTZ,
  shop_close_error          TEXT,

  -- Auto-approval (written by Phase 2 auto-approval)
  auto_approval_rule TEXT,
  auto_approved_at   TIMESTAMPTZ,

  -- Message state (denormalized from sales_order_message_state for fast Portal queries)
  has_unread_messages    BOOLEAN NOT NULL DEFAULT FALSE,
  last_message_at        TIMESTAMPTZ,
  last_message_preview   TEXT,

  -- Timestamps
  purchase_date  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uniqueness: same as current Baserow dedup logic
  CONSTRAINT uq_sales_order_line UNIQUE (sales_channel, order_id, source_store_id, product_name)
);

-- ============================================================================
-- Indexes for sales_orders
-- ============================================================================

-- Primary query: review queue (filter by channel + status + review)
CREATE INDEX idx_sales_orders_review_queue
  ON sales_orders(sales_channel, order_status, review_status)
  WHERE review_status IN ('PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD');

-- Projection query: Mercari WAITING_FOR_SHIPPING + Approved/Auto-Approved
CREATE INDEX idx_sales_orders_projection
  ON sales_orders(sales_channel, order_status, review_status, created_at)
  WHERE order_status = 'WAITING_FOR_SHIPPING'
    AND review_status IN ('APPROVED', 'AUTO_APPROVED');

-- Order detail lookup (most common single-order query)
CREATE INDEX idx_sales_orders_order_id ON sales_orders(order_id);
CREATE INDEX idx_sales_orders_source_store ON sales_orders(source_store_id);
CREATE INDEX idx_sales_orders_b2b ON sales_orders(b2b_item_code);
CREATE INDEX idx_sales_orders_variant ON sales_orders(variant_id);
CREATE INDEX idx_sales_orders_platform_account ON sales_orders(platform_account_id);

-- Stuck-order detection (tracking backlog, close backlog)
CREATE INDEX idx_sales_orders_tracking_backlog
  ON sales_orders(id) 
  WHERE shipping_completed_at IS NULL 
    AND order_status = 'WAITING_FOR_SHIPPING';
CREATE INDEX idx_sales_orders_close_backlog
  ON sales_orders(id)
  WHERE shipping_completed_at IS NOT NULL 
    AND shop_close_completed_at IS NULL;

-- Full-text search for Portal (product_name, order_id, shipping_name)
CREATE INDEX idx_sales_orders_search ON sales_orders USING gin(
  to_tsvector('simple', 
    coalesce(order_id, '') || ' ' || 
    coalesce(product_name, '') || ' ' || 
    coalesce(shipping_name, '') || ' ' ||
    coalesce(b2b_item_code, '')
  )
);

-- Purchase date for auto-approval date gate
CREATE INDEX idx_sales_orders_purchase ON sales_orders(purchase_date);

-- ============================================================================
-- 2. giga_shipment_projections — Phase 2 projection + Phase 3 sync
-- ============================================================================

CREATE TABLE giga_shipment_projections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id    UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  order_id          TEXT NOT NULL,
  sales_channel     sales_channel NOT NULL,
  source_store_id   TEXT NOT NULL,

  -- Giga sync lifecycle
  giga_sync_status       giga_sync_status NOT NULL DEFAULT 'PENDING',
  giga_sync_attempted_at  TIMESTAMPTZ,
  giga_sync_processed_at  TIMESTAMPTZ,
  giga_sync_request_id    TEXT,
  giga_sync_error         TEXT,

  -- GigaB2B API fields (mirrored from sales_orders at projection time)
  order_from           TEXT,                              -- Shop1..Shop4 short name
  b2b_item_code        TEXT,
  ship_to_qty           INTEGER,
  ship_to_name          TEXT,
  ship_to_phone         TEXT,
  ship_to_postal_code   TEXT,
  ship_to_address       TEXT,
  ship_to_city          TEXT,
  ship_to_state         TEXT,
  ship_to_country       TEXT,
  ship_to_service_level TEXT,
  ship_from             TEXT,
  requested_delivery_date TEXT,
  buyer_platform_sku    TEXT,
  buyer_sku_description TEXT,
  buyer_sku_commercial_value DECIMAL(10,2),
  order_comments        TEXT,
  order_date            TIMESTAMPTZ,

  -- Tracking (written by Phase 4)
  shipping_completed_at  TIMESTAMPTZ,
  tracking_carrier       TEXT,
  tracking_number        TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_giga_projections_sales_order ON giga_shipment_projections(sales_order_id);
CREATE INDEX idx_giga_projections_sync_status ON giga_shipment_projections(giga_sync_status);
CREATE INDEX idx_giga_projections_order_id ON giga_shipment_projections(order_id);
-- Partial index for outbound sync: only rows that need syncing
CREATE INDEX idx_giga_projections_unsent
  ON giga_shipment_projections(id)
  WHERE giga_sync_status IN ('PENDING', 'ERROR');
-- Partial index for tracking pull
CREATE INDEX idx_giga_projections_untracked
  ON giga_shipment_projections(id)
  WHERE giga_sync_status = 'SYNCED' AND shipping_completed_at IS NULL;

-- ============================================================================
-- 3. sales_order_message_state — per-order read/latest-message state (replaces CF KV)
-- ============================================================================
-- This table stores current read-state only, NOT the full message history.
-- If the Portal UI later needs full thread display without VPS relay calls,
-- add a separate sales_order_message_events table for the event log.

CREATE TABLE sales_order_message_state (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id            UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  source_store_id           TEXT NOT NULL,                -- raw marketplace seller/store ID
  order_transaction_id      TEXT NOT NULL,                -- Mercari transaction ID for GraphQL

  last_read_transaction_id  TEXT,
  last_read_message_id      TEXT,
  last_read_at              TIMESTAMPTZ,

  -- Denormalized for fast unread badge
  latest_message_at         TIMESTAMPTZ,
  latest_message_preview    TEXT,
  has_unread                BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(source_store_id, order_transaction_id)
);

CREATE INDEX idx_sales_order_msg_state_order ON sales_order_message_state(sales_order_id);

-- ============================================================================
-- 3b. sales_order_message_events — full message history (future, deferred)
-- ============================================================================
-- If the Portal UI needs full message threads without VPS relay calls,
-- add this table to record each inbound/outbound message event.
-- Deferred until the Portal message UI requirements are finalized.
--
-- CREATE TABLE sales_order_message_events (
--   id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   message_state_id      UUID NOT NULL REFERENCES sales_order_message_state(id) ON DELETE CASCADE,
--   direction             TEXT NOT NULL,              -- 'inbound' | 'outbound'
--   body                  TEXT NOT NULL,
--   message_id            TEXT,                       -- platform message ID
--   sent_by               TEXT,                       -- operator name (outbound only)
--   platform_message_id   TEXT,                       -- platform-returned ID (outbound)
--   sent_at               TIMESTAMPTZ,
--   created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
-- );

-- ============================================================================
-- 3c. order_message_templates — reusable Portal message templates (replaces CF KV)
-- ============================================================================
-- Current message_drafts are per-ticket drafts, not reusable templates.
-- This table migrates the CF KV template store that Portal operators use
-- for common reply scenarios (shipping delay, payment issue, etc.).

CREATE TABLE order_message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,                            -- operator-facing label
  subject     TEXT,                                     -- optional subject line
  body        TEXT NOT NULL,                            -- template body with {variable} placeholders
  category    TEXT,                                     -- e.g. 'shipping', 'payment', 'general'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  TEXT,                                     -- operator who created it
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_msg_templates_category ON order_message_templates(category);
CREATE INDEX idx_order_msg_templates_active ON order_message_templates(sort_order) WHERE is_active;

-- ============================================================================
-- 4. pipeline_run_log — audit trail for pipeline phases
-- ============================================================================

CREATE TABLE pipeline_run_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        TEXT NOT NULL,                             -- run_{timestamp}_{random8}
  trigger_type  TEXT,                                      -- 'cron', 'admin', 'manual'
  mode          TEXT,
  cron          TEXT,
  step          TEXT NOT NULL,                             -- phase name
  shop_scope    TEXT,
  ok            BOOLEAN NOT NULL DEFAULT FALSE,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  error_message TEXT,
  result_counts JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_run_log_run_id ON pipeline_run_log(run_id);
CREATE INDEX idx_pipeline_run_log_created ON pipeline_run_log(created_at);

-- ============================================================================
-- 5. RLS Policies
-- ============================================================================

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE giga_shipment_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_message_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_run_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_message_templates ENABLE ROW LEVEL SECURITY;

-- Operators (authenticated users): READ-ONLY for all tables.
-- All writes go through the backend API using the service_role key,
-- which validates business rules before mutating (isValidReviewMutation, etc.).

CREATE POLICY "Operators can read sales orders"
  ON sales_orders FOR SELECT TO authenticated USING (true);

CREATE POLICY "Operators can read shipments"
  ON giga_shipment_projections FOR SELECT TO authenticated USING (true);

CREATE POLICY "Operators can read message state"
  ON sales_order_message_state FOR SELECT TO authenticated USING (true);

CREATE POLICY "Operators can read pipeline logs"
  ON pipeline_run_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "Operators can read message templates"
  ON order_message_templates FOR SELECT TO authenticated USING (true);

-- No INSERT/UPDATE/DELETE policies for authenticated users.
-- All mutations go through backend API → service_role (which bypasses RLS).
-- Application-layer validation runs in the backend, not in RLS WITH CHECK expressions.
```

---

## Gate 2: Operator UI Parity

*(Stack and page plan — same as original design doc, not repeated.)*

**Stack:** React 19 + Vite 6 + TypeScript 5.7 + shadcn/ui + TanStack Query + TanStack Router. Deployed on VPS via Docker (nginx serving static build).

**Service boundary:** Browser Supabase client uses `anon` key + RLS for **reads only** (all tables have SELECT policies, no INSERT/UPDATE/DELETE policies for `authenticated`). All write operations (review_status, order_comments, b2b_item_code, delivery prefs, message templates, message read-state) go through a thin backend API that validates business rules (`isValidReviewMutation`, etc.) before using the `service_role` key (which bypasses RLS).

---

## Gates 3-4: Runtime Consolidation & Cross-Platform

*(Deferred — see original design doc for direction.)*

---

## Key Decisions for Review

| # | Decision | Original Proposal | Updated After Live Schema Review |
|---|----------|-------------------|----------------------------------|
| D1 | **Supabase project** | New dedicated project | **SAME project** (`gqeyfhshxdiyhugvmbuk`) — `product_variants`, `product_commercials`, `giga_cogs_shipment_lines`, `platform_accounts`, `inbound_ticket_messages` already exist |
| D2 | **Products table** | Create OrderMgmt `products` | **REFERENCE** `product_variants` + `product_commercials` — `sales_orders.variant_id` → `product_variants.id` |
| D3 | **Giga shipments** | Create OrderMgmt `giga_shipments` | **Create `giga_shipment_projections`** (separate table). `giga_cogs_shipment_lines` is a different data source (CSV import) with different semantics. OrderMgmt owns the API-driven sync lifecycle in its own table. No FK dependency between the two. |
| D4 | **Message state** | Supabase table replacing CF KV | **Create `sales_order_message_state`** for active-order buyer message read-state (NOT full history). Do NOT link to `inbound_ticket_messages` — that system handles aftersales (post-Completed) customer support tickets. If full thread history is needed later, add `sales_order_message_events`. |
| D5 | **Pipeline audit** | `pipeline_runs` table | **Create standalone `pipeline_run_log`**. Do NOT link to `agent_runs` — that table is for LLM agent execution logging, not cron-based operational pipeline phases. Different execution models. |
| D6 | **Frontend** | React + Vite + TypeScript | Unchanged |
| D7 | **Unified sales_orders** | Unified core + channel detail tables | ✅ **Settled — unified `sales_orders` with `sales_channel` enum** (lowercase canonical: `mercari`, `rakuten`, `amazon`, `yahoo`). 2 channels, ~80% field overlap. Shop identity: `platform_account_id` (FK) + `source_store_id` (raw marketplace ID). |
| D8 | **Platform casing** | Title case in sales_channel | ✅ **Settled — lowercase canonical internally** (`mercari`, `rakuten`, `amazon`, `yahoo`). Matches `platform_accounts.platform`. Map to title case at boundaries where `giga_cogs_shipment_lines.sales_channel` expects it. |
| D9 | **RLS write policy** | Authenticated UPDATE with WITH CHECK | ✅ **Settled — read-only RLS for authenticated users.** All writes go through backend API → `service_role` (which bypasses RLS). Application-layer validation runs in the backend, not in RLS expressions. |
| D10 | **Portal templates** | CF KV → Supabase | ✅ **Settled — new `order_message_templates` table.** Reusable templates (migrated from CF KV). Separate from `message_drafts` which are per-ticket drafts. |

---

## Success Criteria (Gate 1 Ship Threshold)

- [ ] Live Supabase schema documented (this document §0 — complete)
- [ ] Current Baserow schema and Portal API contract documented (original design doc)
- [ ] `sales_orders` + `giga_shipment_projections` + `sales_order_message_state` + `order_message_templates` + `pipeline_run_log` created in Supabase project `gqeyfhshxdiyhugvmbuk`
- [ ] FK references to `product_variants`, `platform_accounts` validated
- [ ] Adapter tests prove Baserow and Supabase behavior match for pagination, filters, create/patch/delete, Japanese text
- [ ] Dry-run migration diff report clean
- [ ] Parallel run 48h clean
- [ ] Post-cutover pipeline clean for 72h
- [ ] Rollback tested: env var switch restores Baserow write path

---

## Reference

- **Live Supabase project:** `gqeyfhshxdiyhugvmbuk` (`ap-northeast-2`, PostgreSQL 17.6)
- **Credentials:** `master_credentials.md` §8
- **RPagentOS schema source:** `RPagentOS/supabase/migrations/` (20 migrations, 2026-06-29 → 2026-07-08)
- **Architecture assessment:** `docs/supabase-migration-assessment.md`
- **Architecture audit:** `OrderMgmt架构分析报告.md`
- **Baserow adapter:** `src/lib/baserow.mjs`
- **State definitions:** `src/lib/order-state.mjs`
- **Channel config:** `src/lib/channel-config.mjs`
