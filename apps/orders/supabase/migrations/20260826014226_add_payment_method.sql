-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none

alter table sales_orders
  add column if not exists payment_method text;

comment on column sales_orders.payment_method is
  'Marketplace-reported payment method; Rakuten source is SettlementModel.settlementMethod.';
