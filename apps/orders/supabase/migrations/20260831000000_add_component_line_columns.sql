-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: portal-api (VPS), worker (Cloudflare)
--
-- Durable manual component order lines. Portal operators can attach
-- operator-chosen fulfillment components (line_origin='operator_component') to
-- an existing marketplace anchor line (line_origin='marketplace'). The
-- self-referential parent_line_id links each component back to its anchor, and
-- component_index gives a deterministic ordering within the order.
--
-- Existing rows are all marketplace lines by definition (components did not
-- exist before this migration), so they are backfilled to 'marketplace'.
--
-- Rollback:
--   alter table public.sales_orders
--     drop constraint if exists chk_sales_orders_component_index,
--     drop column if exists component_index,
--     drop column if exists parent_line_id,
--     drop constraint if exists chk_sales_orders_line_origin,
--     drop column if exists line_origin;

-- 1. line_origin — provenance of the sales line. Backfill existing rows.
alter table public.sales_orders
  add column if not exists line_origin text;

alter table public.sales_orders
  alter column line_origin set default 'marketplace';

update public.sales_orders
   set line_origin = 'marketplace'
 where line_origin is null;

alter table public.sales_orders
  alter column line_origin set not null;

do $$ begin
  alter table public.sales_orders add constraint chk_sales_orders_line_origin
    check (line_origin in ('marketplace', 'operator_component'));
exception when duplicate_object then null;
end $$;

-- 2. parent_line_id — self-FK to the anchor sales line. Cascade so that an
-- anchor's component lines are removed with it (no orphans).
alter table public.sales_orders
  add column if not exists parent_line_id uuid references public.sales_orders(id) on delete cascade;

-- 3. component_index — deterministic 1-based ordering within the order.
alter table public.sales_orders
  add column if not exists component_index integer;

do $$ begin
  alter table public.sales_orders add constraint chk_sales_orders_component_index
    check (component_index is null or component_index > 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.sales_orders add constraint chk_sales_orders_component_shape check (
    (line_origin = 'marketplace' and parent_line_id is null and component_index is null)
    or (line_origin = 'operator_component' and parent_line_id is not null and component_index is not null)
  );
exception when duplicate_object then null;
end $$;

create unique index if not exists uq_sales_orders_component_position
  on public.sales_orders(parent_line_id, component_index)
  where line_origin = 'operator_component';

create index if not exists ix_sales_orders_parent_line
  on public.sales_orders(parent_line_id)
  where parent_line_id is not null;

comment on column public.sales_orders.line_origin is
  'Provenance of this sales line: marketplace (ingested) or operator_component (operator-added fulfillment component).';
comment on column public.sales_orders.parent_line_id is
  'For operator_component lines, the sales_orders.id of the marketplace anchor line. Null for anchor/marketplace lines.';
comment on column public.sales_orders.component_index is
  'Deterministic 1-based ordering index of operator_component lines within an order. Null for marketplace lines.';
