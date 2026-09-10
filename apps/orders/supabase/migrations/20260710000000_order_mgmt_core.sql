-- OrderMgmt: core schema migration
-- Creates the sales-order management data model for the Mercari→GigaB2B pipeline
-- and future cross-platform order orchestration (Rakuten, Amazon, Yahoo).
--
-- This migration references existing RPagentOS tables:
--   product_variants (item_code = GigaB2B SKU)
--   platform_accounts (platform, shop_code, seller_account_id)
--
-- Tables created (5 new):
--   sales_orders, giga_shipment_projections, sales_order_message_state,
--   order_message_templates, pipeline_run_log
--
-- RLS note: Unlike existing RPagentOS tables (MVP posture, no RLS),
-- OrderMgmt tables enable RLS with SELECT-only policies for authenticated
-- users. All writes go through backend API → service_role (bypasses RLS).
-- This is a deliberate security hardening for order data.
--
-- See: docs/design/supabase-migration-design.md

-- ============================================================================
-- 1. sales_orders — the core OrderMgmt entity
-- ============================================================================
-- One row per (order_id, source_store_id, product_name). Full lifecycle:
-- ingest → review → projection → Giga sync → tracking → marketplace close.

create table if not exists sales_orders (
  id                  uuid primary key default gen_random_uuid(),
  order_id            text not null,
  sales_channel       text not null,
  platform_account_id uuid references platform_accounts(id),
  source_store_id     text not null,
  order_status        text not null,
  review_status       text not null default 'PENDING_REVIEW',

  -- Product (links to canonical product_variants)
  product_name         text,
  b2b_item_code        text,
  variant_id           uuid references product_variants(id),
  original_product_id  text,
  ai_copywrite_log     text,
  quantity             integer not null default 1,
  product_price        numeric(12,2),
  shipping_price       numeric(12,2),

  -- Shipping address (mirrored from marketplace — immutable after ingest)
  shipping_name          text,
  shipping_postal_code   text,
  shipping_state         text,
  shipping_city          text,
  shipping_address_1     text,
  shipping_address_2     text,
  shipping_phone_number  text,
  shipping_method        text,
  shipping_carrier       text,

  -- Delivery preferences (operator-editable via Portal)
  requested_delivery_date text,
  requested_delivery_time text,

  -- Buyer
  buyer_name      text,
  order_comments  text,

  -- Tracking (written by Phase 4 tracking reconciliation)
  shipping_completed_at timestamptz,
  tracking_carrier      text,
  tracking_number       text,

  -- Close status (written by Phase 5 marketplace close)
  shop_close_status        text,
  shop_close_attempted_at  timestamptz,
  shop_close_completed_at  timestamptz,
  shop_close_error         text,

  -- Auto-approval (written by Phase 2 auto-approval)
  auto_approval_rule text,
  auto_approved_at   timestamptz,

  -- Rakuten-specific fields currently small enough to keep on the core table.
  -- If future channels add broader divergent shapes, split detail tables then.
  manage_number       text,
  confirm_in_progress boolean,

  -- Message state (denormalized from sales_order_message_state for fast Portal queries)
  has_unread_messages  boolean not null default false,
  last_message_at      timestamptz,
  last_message_preview text,

  -- Timestamps
  purchase_date timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Uniqueness: same dedup logic as current Baserow
  constraint chk_sales_channel check (sales_channel in ('mercari', 'rakuten', 'amazon', 'yahoo')),
  constraint chk_review_status check (review_status in ('PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD')),
  constraint uq_sales_order_line unique nulls not distinct (sales_channel, order_id, source_store_id, product_name)
);

-- Indexes for sales_orders

-- Primary query: review queue (filter by channel + status + review)
create index if not exists ix_sales_orders_review_queue
  on sales_orders(sales_channel, order_status, review_status)
  where review_status in ('PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD');

-- Projection query: WAITING_FOR_SHIPPING + approved review statuses
create index if not exists ix_sales_orders_projection
  on sales_orders(sales_channel, order_status, review_status, created_at)
  where order_status = 'WAITING_FOR_SHIPPING'
    and review_status in ('APPROVED', 'AUTO_APPROVED');

-- Order detail lookup (most common single-order query)
create index if not exists ix_sales_orders_order_id on sales_orders(order_id);
create index if not exists ix_sales_orders_source_store on sales_orders(source_store_id);
create index if not exists ix_sales_orders_b2b on sales_orders(b2b_item_code);
create index if not exists ix_sales_orders_variant on sales_orders(variant_id);
create index if not exists ix_sales_orders_platform_account on sales_orders(platform_account_id);

-- Stuck-order detection (tracking backlog)
create index if not exists ix_sales_orders_tracking_backlog
  on sales_orders(id)
  where shipping_completed_at is null
    and order_status = 'WAITING_FOR_SHIPPING';

-- Stuck-order detection (close backlog)
create index if not exists ix_sales_orders_close_backlog
  on sales_orders(id)
  where shipping_completed_at is not null
    and shop_close_completed_at is null;

-- Full-text search for Portal (product_name, order_id, shipping_name, b2b_item_code)
create index if not exists ix_sales_orders_search on sales_orders using gin(
  to_tsvector('simple',
    coalesce(order_id, '') || ' ' ||
    coalesce(product_name, '') || ' ' ||
    coalesce(shipping_name, '') || ' ' ||
    coalesce(b2b_item_code, '')
  )
);

-- Purchase date for auto-approval date gate
create index if not exists ix_sales_orders_purchase on sales_orders(purchase_date);

-- ============================================================================
-- 2. giga_shipment_projections — Phase 2 projection + Phase 3 sync lifecycle
-- ============================================================================
-- Separate from giga_cogs_shipment_lines (which is CSV import history).
-- This table owns the API-driven GigaB2B sync lifecycle.

create table if not exists giga_shipment_projections (
  id                uuid primary key default gen_random_uuid(),
  sales_order_id    uuid not null references sales_orders(id) on delete cascade,
  order_id          text not null,
  sales_channel     text not null,
  source_store_id   text not null,

  -- Giga sync lifecycle
  giga_sync_status        text not null default 'PENDING',
  giga_sync_attempted_at  timestamptz,
  giga_sync_processed_at  timestamptz,
  giga_sync_request_id    text,
  giga_sync_error         text,

  -- GigaB2B API fields (mirrored from sales_orders at projection time)
  order_from                  text,
  b2b_item_code               text,
  ship_to_qty                 integer,
  ship_to_name                text,
  ship_to_phone               text,
  ship_to_postal_code         text,
  ship_to_address             text,
  ship_to_city                text,
  ship_to_state               text,
  ship_to_country             text,
  ship_to_service_level       text,
  ship_from                   text,
  requested_delivery_date     text,
  buyer_platform_sku          text,
  buyer_sku_description       text,
  buyer_sku_commercial_value  numeric(12,2),
  order_comments              text,
  order_date                  timestamptz,

  -- Tracking (written by Phase 4)
  shipping_completed_at timestamptz,
  tracking_carrier      text,
  tracking_number       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_giga_sync_status check (giga_sync_status in ('PENDING', 'ATTEMPTED', 'SYNCED', 'ALREADY_EXISTS', 'ERROR', 'INVALID'))
);

-- Indexes for giga_shipment_projections
create index if not exists ix_giga_projections_sales_order on giga_shipment_projections(sales_order_id);
create index if not exists ix_giga_projections_sync_status on giga_shipment_projections(giga_sync_status);
create index if not exists ix_giga_projections_order_id on giga_shipment_projections(order_id);

-- Partial index: only rows that need syncing (outbound Phase 3)
create index if not exists ix_giga_projections_unsent
  on giga_shipment_projections(id)
  where giga_sync_status in ('PENDING', 'ERROR');

-- Partial index: synced but no tracking yet (Phase 4 backlog)
create index if not exists ix_giga_projections_untracked
  on giga_shipment_projections(id)
  where giga_sync_status = 'SYNCED' and shipping_completed_at is null;

-- ============================================================================
-- 3. sales_order_message_state — per-order read/latest-message state
-- ============================================================================
-- Stores current read-state only, NOT the full message history.
-- Replaces CF KV message tracking.
-- If full thread display is needed later, add sales_order_message_events.

create table if not exists sales_order_message_state (
  id                    uuid primary key default gen_random_uuid(),
  sales_order_id        uuid not null references sales_orders(id) on delete cascade,
  source_store_id       text not null,
  order_transaction_id  text not null,

  last_read_transaction_id text,
  last_read_message_id     text,
  last_read_at             timestamptz,

  -- Denormalized for fast unread badge in Portal
  latest_message_at       timestamptz,
  latest_message_preview  text,
  has_unread              boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(source_store_id, order_transaction_id)
);

create index if not exists ix_sales_order_msg_state_order on sales_order_message_state(sales_order_id);

-- ============================================================================
-- 3b. sales_order_message_events (deferred — commented out for future)
-- ============================================================================
-- If the Portal UI needs full message threads without VPS relay calls,
-- uncomment and run this table to record each inbound/outbound message event.
--
-- create table if not exists sales_order_message_events (
--   id                  uuid primary key default gen_random_uuid(),
--   message_state_id    uuid not null references sales_order_message_state(id) on delete cascade,
--   direction           text not null,
--   body                text not null,
--   message_id          text,
--   sent_by             text,
--   platform_message_id text,
--   sent_at             timestamptz,
--   created_at          timestamptz not null default now(),
--   constraint chk_message_direction check (direction in ('inbound', 'outbound'))
-- );

-- ============================================================================
-- 4. order_message_templates — reusable Portal message templates
-- ============================================================================
-- Migrates the CF KV template store that Portal operators use for
-- common reply scenarios (shipping delay, payment issue, etc.).
-- Separate from message_drafts which are per-ticket drafts.

create table if not exists order_message_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  subject    text,
  body       text not null,
  category   text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_order_msg_templates_category on order_message_templates(category);
create index if not exists ix_order_msg_templates_active on order_message_templates(sort_order) where is_active;

-- ============================================================================
-- 5. pipeline_run_log — audit trail for pipeline phase execution
-- ============================================================================
-- Replaces the Baserow pipeline_runs table. Standalone table — NOT linked to
-- agent_runs (which is for LLM agent execution logging, not cron-based pipeline
-- phases). Different execution models.

create table if not exists pipeline_run_log (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null,
  trigger_type  text,
  mode          text,
  cron          text,
  step          text not null,
  shop_scope    text,
  ok            boolean not null default false,
  started_at    timestamptz,
  ended_at      timestamptz,
  error_message text,
  result_counts jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists ix_pipeline_run_log_run_id on pipeline_run_log(run_id);
create index if not exists ix_pipeline_run_log_created on pipeline_run_log(created_at);

-- ============================================================================
-- 6. updated_at triggers
-- ============================================================================
-- The set_updated_at() function was created in migration 20260702000000.
-- Add triggers for tables that have an updated_at column.

drop trigger if exists trg_sales_orders_updated_at on sales_orders;
create trigger trg_sales_orders_updated_at
  before update on sales_orders
  for each row execute function set_updated_at();

drop trigger if exists trg_giga_projections_updated_at on giga_shipment_projections;
create trigger trg_giga_projections_updated_at
  before update on giga_shipment_projections
  for each row execute function set_updated_at();

drop trigger if exists trg_sales_order_msg_state_updated_at on sales_order_message_state;
create trigger trg_sales_order_msg_state_updated_at
  before update on sales_order_message_state
  for each row execute function set_updated_at();

drop trigger if exists trg_order_msg_templates_updated_at on order_message_templates;
create trigger trg_order_msg_templates_updated_at
  before update on order_message_templates
  for each row execute function set_updated_at();

-- ============================================================================
-- 7. RLS: enable row-level security
-- ============================================================================
-- Unlike existing RPagentOS tables (MVP posture, no RLS), OrderMgmt tables
-- enable RLS with SELECT-only policies for authenticated users.
-- All writes go through backend API → service_role (bypasses RLS).

alter table sales_orders enable row level security;
alter table giga_shipment_projections enable row level security;
alter table sales_order_message_state enable row level security;
alter table order_message_templates enable row level security;
alter table pipeline_run_log enable row level security;

-- Operators (authenticated users): READ-ONLY for all tables
create policy "Operators can read sales orders"
  on sales_orders for select to authenticated using (true);

create policy "Operators can read shipments"
  on giga_shipment_projections for select to authenticated using (true);

create policy "Operators can read message state"
  on sales_order_message_state for select to authenticated using (true);

create policy "Operators can read message templates"
  on order_message_templates for select to authenticated using (true);

create policy "Operators can read pipeline logs"
  on pipeline_run_log for select to authenticated using (true);

-- No INSERT/UPDATE/DELETE policies for authenticated users.
-- All mutations go through backend API → service_role (which bypasses RLS).

-- ============================================================================
-- 8. Grants
-- ============================================================================

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'sales_orders',
      'giga_shipment_projections',
      'sales_order_message_state',
      'order_message_templates',
      'pipeline_run_log'
    ])
  loop
    execute format('grant select, insert, update, delete on %I to service_role', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end
$$;

-- ============================================================================
-- 9. Table and column comments
-- ============================================================================

comment on table sales_orders is 'Core OrderMgmt entity: one row per (order_id, source_store_id, product_name). Full lifecycle from ingest to marketplace close.';
comment on column sales_orders.sales_channel is 'Canonical platform: mercari, rakuten, amazon, yahoo (lowercase, matches platform_accounts.platform).';
comment on column sales_orders.platform_account_id is 'FK to platform_accounts — resolved via seller_account_id matching at ingest time.';
comment on column sales_orders.source_store_id is 'Raw marketplace seller/store ID (e.g., Mercari 2JMLHBxjiFHDr55jMwA7fs).';
comment on column sales_orders.review_status is 'Operator review state: PENDING_REVIEW, AUTO_APPROVED, APPROVED, ON_HOLD.';
comment on column sales_orders.b2b_item_code is 'GigaB2B SKU — matches product_variants.item_code (case-insensitive).';
comment on column sales_orders.variant_id is 'FK to product_variants — resolved when b2b_item_code matches.';

comment on table giga_shipment_projections is 'Projected shipments created by Phase 2, pushed to GigaB2B by Phase 3. Separate from giga_cogs_shipment_lines (CSV import history).';
comment on column giga_shipment_projections.giga_sync_status is 'Sync lifecycle: PENDING → ATTEMPTED → SYNCED | ALREADY_EXISTS | ERROR | INVALID.';

comment on table sales_order_message_state is 'Per-order read/latest-message state. Replaces CF KV message tracking. NOT the full message history.';
comment on table order_message_templates is 'Reusable message templates for Portal operators. Migrated from CF KV. Separate from message_drafts (per-ticket drafts).';
comment on table pipeline_run_log is 'Audit log for cron-based pipeline phase execution. Standalone — NOT linked to agent_runs (LLM agent execution).';
