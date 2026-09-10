-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: retailpulses/OrderMgmt

alter table public.sales_orders
  add column if not exists rakuten_order_progress text,
  add column if not exists rakuten_status_mapping_state text,
  add column if not exists rakuten_order_progress_observed_at timestamptz;

alter table public.sales_orders
  drop constraint if exists sales_orders_rakuten_status_mapping_state_check;

alter table public.sales_orders
  add constraint sales_orders_rakuten_status_mapping_state_check
  check (
    rakuten_status_mapping_state is null
    or rakuten_status_mapping_state in ('MAPPED', 'UNKNOWN', 'MISSING')
  );

comment on column public.sales_orders.rakuten_order_progress is
  'Latest normalized raw Rakuten RMS OrderModel.orderProgress value.';
comment on column public.sales_orders.rakuten_status_mapping_state is
  'Whether the latest Rakuten orderProgress is MAPPED, UNKNOWN, or MISSING.';
comment on column public.sales_orders.rakuten_order_progress_observed_at is
  'Timestamp when the current raw Rakuten orderProgress mapping was first observed.';
