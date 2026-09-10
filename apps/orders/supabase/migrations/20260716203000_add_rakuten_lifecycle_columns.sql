-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none

alter table public.sales_orders
  add column if not exists last_synced_at timestamptz,
  add column if not exists sync_error text,
  add column if not exists rms_confirm_result text,
  add column if not exists rms_confirmed_at timestamptz,
  add column if not exists rms_close_result text,
  add column if not exists rms_close_completed_at timestamptz;
