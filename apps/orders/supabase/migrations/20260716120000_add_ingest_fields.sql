-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: sales_orders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none

alter table sales_orders
  add column if not exists payment_date timestamptz,
  add column if not exists currency text,
  add column if not exists product_tax numeric(12,2),
  add column if not exists shipping_tax numeric(12,2),
  add column if not exists shipping_duration text,
  add column if not exists shipping_country text,
  add column if not exists billing_country text,
  add column if not exists billing_postal_code text,
  add column if not exists billing_state text,
  add column if not exists billing_city text,
  add column if not exists billing_address_1 text,
  add column if not exists billing_address_2 text,
  add column if not exists billing_name text,
  add column if not exists coupon_discount_amount numeric(12,2),
  add column if not exists coupon_id text,
  add column if not exists order_type text;
