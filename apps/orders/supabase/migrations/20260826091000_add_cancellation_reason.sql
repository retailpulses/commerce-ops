-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: sales_orders.cancellation_reason, public.cancel_order_with_reason
-- Change class: additive
-- Hosted write required: yes
-- Consumers: retailpulses/OrderMgmt

alter table public.sales_orders
  add column if not exists cancellation_reason text;

comment on column public.sales_orders.cancellation_reason is
  'Operator-entered free-text reason captured when an order is locally cancelled in Order Portal; retained for ad-hoc analysis.';

create or replace function public.cancel_order_with_reason(
  p_sales_channel       text,
  p_source_store_id     text,
  p_order_id            text,
  p_audit               text,
  p_cancellation_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_result jsonb;
begin
  if nullif(btrim(p_cancellation_reason), '') is null then
    raise exception 'CANCELLATION_REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if char_length(btrim(p_cancellation_reason)) > 2000 then
    raise exception 'CANCELLATION_REASON_TOO_LONG' using errcode = 'P0001';
  end if;

  -- The existing RPC acquires the order-scoped advisory lock and performs all
  -- lifecycle guards. This wrapper remains in the same transaction, so either
  -- both review status and reason persist, or neither does.
  v_result := public.set_order_review_status(
    p_sales_channel,
    p_source_store_id,
    p_order_id,
    'CANCELED',
    p_audit,
    null,
    null
  );

  update public.sales_orders
     set cancellation_reason = btrim(p_cancellation_reason)
   where sales_channel = p_sales_channel
     and source_store_id = p_source_store_id
     and order_id = p_order_id
     and not (
       coalesce(product_name, '') like '%各種手数料%'
       or coalesce(product_name, '') = '追加支払い・追加送料専用'
     );

  return v_result || jsonb_build_object('cancellation_reason', btrim(p_cancellation_reason));
end;
$$;

comment on function public.cancel_order_with_reason(text, text, text, text, text) is
  'Atomically marks all non-fee order lines locally cancelled and stores the required operator-entered free-text cancellation reason.';

revoke all on function public.cancel_order_with_reason(text, text, text, text, text) from public;
revoke execute on function public.cancel_order_with_reason(text, text, text, text, text) from anon, authenticated;
grant execute on function public.cancel_order_with_reason(text, text, text, text, text) to service_role;

