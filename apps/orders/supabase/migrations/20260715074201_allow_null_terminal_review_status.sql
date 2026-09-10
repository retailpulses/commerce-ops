-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.sales_orders.review_status
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none
--
-- Issue #144: terminal orders have no actionable review state. Allow the
-- repair tool to clear stale values while retaining the existing default for
-- new active orders and the existing CHECK constraint for non-null values.
--
-- Rollback: first restore a valid review_status on every null row, then run
--   alter table public.sales_orders alter column review_status set not null;

alter table public.sales_orders
  alter column review_status drop not null;

comment on column public.sales_orders.review_status is
  'Review workflow state for active orders. Null after an order reaches a terminal lifecycle state.';
