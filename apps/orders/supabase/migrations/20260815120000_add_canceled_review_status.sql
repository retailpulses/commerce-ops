-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.sales_orders.review_status, public.set_order_review_status(...)
-- Change class: additive
-- Hosted write required: yes
-- Consumers: portal-api (VPS), worker (Cloudflare)
--
-- Portal "Cancel" action (issue: portal-order-cancel). Adds a new operator-owned
-- terminal review status CANCELED so an operator can locally block an order from
-- ever being approved again, independent of the ingest-owned order_status.
--
-- Semantics: review_status = 'CANCELED' means "operator marked cancelled; do not
-- approve or ship". It is distinct from order_status = 'CANCELED' (Mercari reports
-- cancelled). Either alone blocks approval.
--
-- The transaction RPC set_order_review_status(...) is the single write path for
-- all review mutations (CANCELED / APPROVED / ON_HOLD / AUTO_APPROVED). It locks
-- an order-scoped advisory lock and updates ALL non-fee lines atomically so Cancel
-- always wins over a concurrent approve.
--
-- Rollback: re-add the original 4-value constraint only AFTER backfilling any
--   review_status = 'CANCELED' rows to 'ON_HOLD' (or null). Drop the RPC.

-- 1. Extend the CHECK constraint (superset of the existing four values).
alter table public.sales_orders drop constraint chk_review_status;

alter table public.sales_orders add constraint chk_review_status
  check (review_status in ('PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD', 'CANCELED'));

comment on column public.sales_orders.review_status is
  'Review workflow state for active orders: PENDING_REVIEW, AUTO_APPROVED, APPROVED, ON_HOLD, CANCELED. Null after a terminal lifecycle. CANCELED is operator-owned and terminal (never auto-reset).';

-- NOTE: partial index ix_sales_orders_review_queue intentionally keeps its
-- original four-value predicate and therefore excludes CANCELED rows from the
-- review queue — a locally-cancelled order is terminal, not awaiting review.
-- No change required to that index.

-- 2. Transactional review-mutation RPC (see docs/trd/portal-order-cancel-action.md).
create or replace function public.set_order_review_status(
  p_sales_channel      text,   -- 'mercari' (lowercase)
  p_source_store_id    text,   -- raw store ID from the anchor sales row
  p_order_id           text,   -- normalized order ID (order_ prefix stripped)
  p_target             text,   -- 'CANCELED' | 'APPROVED' | 'ON_HOLD' | 'AUTO_APPROVED'
  p_audit              text,   -- audit label appended to order_comments; '' leaves it unchanged
  p_auto_approval_rule text default null, -- matched rule label; written when p_target = 'AUTO_APPROVED'
  p_auto_approved_at   text default null  -- JST ISO timestamp; written when p_target = 'AUTO_APPROVED'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_rows integer;
begin
  -- Order-scoped mutex: every review mutation serialises on this key, so a
  -- racing approve on any line cannot beat a multi-line Cancel.
  perform pg_advisory_xact_lock(hashtext(p_sales_channel || '|' || p_source_store_id || '|' || p_order_id));

  -- guard 1: order already terminal (nothing to mutate)
  if exists (select 1 from sales_orders
             where sales_channel = p_sales_channel and source_store_id = p_source_store_id
               and order_id = p_order_id
               and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
               and order_status in ('COMPLETED','CANCELED','CANCELING'))
  then raise exception 'ORDER_TERMINAL' using errcode = 'P0001'; end if;

  -- guard 2: already pushed to Giga — disallow local Cancel only (fail closed).
  -- Approve/On-Hold/Auto-Approve are NOT gated here; only Cancel is refused.
  if p_target = 'CANCELED'
     and exists (select 1 from giga_shipment_projections
             where sales_channel = p_sales_channel and source_store_id = p_source_store_id
               and order_id = p_order_id
               and giga_sync_status in ('SYNCED','ALREADY_EXISTS'))
  then raise exception 'ALREADY_SYNCED_TO_GIGA' using errcode = 'P0001'; end if;

  -- guard 3: CANCELED is terminal — approve/hold/auto-approve can never flip it back
  if p_target in ('APPROVED','ON_HOLD','AUTO_APPROVED')
     and exists (select 1 from sales_orders
                 where sales_channel = p_sales_channel and source_store_id = p_source_store_id
                   and order_id = p_order_id
                   and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
                   and review_status = 'CANCELED')
  then raise exception 'REVIEW_CANCELED' using errcode = 'P0001'; end if;

  -- guard 4: AUTO_APPROVED is CAS-gated on PENDING_REVIEW. Auto-approval reads
  -- PENDING_REVIEW, then performs long external checks; an operator may have set
  -- ON_HOLD / APPROVED / CANCELED meanwhile. The background job must never
  -- override an operator's deliberate state, so require every target non-fee
  -- line to still be PENDING_REVIEW at write time.
  if p_target = 'AUTO_APPROVED'
     and exists (select 1 from sales_orders
                 where sales_channel = p_sales_channel and source_store_id = p_source_store_id
                   and order_id = p_order_id
                   and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
                   and review_status is distinct from 'PENDING_REVIEW')
  then raise exception 'REVIEW_STATUS_CHANGED' using errcode = 'P0001'; end if;

  -- update ALL non-fee lines atomically
  with t as (
    select id from sales_orders
    where sales_channel = p_sales_channel and source_store_id = p_source_store_id
      and order_id = p_order_id
      and not (coalesce(product_name, '') like '%各種手数料%' or coalesce(product_name, '') = '追加支払い・追加送料専用')
    for update
  )
  update sales_orders so
     set review_status = p_target,
         order_comments = case
                            when p_audit = '' then order_comments
                            when order_comments is null or order_comments = '' then p_audit
                            else order_comments || e'\n' || p_audit
                          end,
         auto_approval_rule = case when p_target = 'AUTO_APPROVED'
                                   then p_auto_approval_rule else auto_approval_rule end,
         auto_approved_at   = case when p_target = 'AUTO_APPROVED'
                                   then p_auto_approved_at::timestamptz else auto_approved_at end
    from t where so.id = t.id;

  get diagnostics v_rows = row_count;

  -- Fail loudly on an empty update instead of returning a phantom success. In
  -- normal operation there is always at least one non-fee line for the anchor
  -- order key, so zero rows means the caller's key did not resolve.
  if v_rows = 0 then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;

  return jsonb_build_object('updated', v_rows, 'review_status', p_target);
end;
$$;

comment on function public.set_order_review_status(text, text, text, text, text, text, text) is
  'Transactional review-status mutation for portal Cancel/Approve/On-Hold/Auto-Approve. Order-scoped advisory lock + all-non-fee-lines atomic update; Cancel wins over concurrent approve. AUTO_APPROVED also writes auto_approval_rule and auto_approved_at in the same transaction.';

-- 3. Restrict execution to the trusted backend role (service_role). The
-- portal-api / worker authenticate with the service-role key; anonymous and
-- authenticated client roles must not be able to invoke this security-definer
-- function directly through PostgREST.
--
-- NOTE: `revoke ... from public` alone is NOT sufficient. Supabase installs
-- default privileges (pg_default_acl for the creating role, objtype f) that
-- grant EXECUTE directly to anon, authenticated, and service_role on function
-- creation. Those are explicit per-role grants, not the PUBLIC pseudo-role, so
-- they must be revoked by name.
revoke all on function public.set_order_review_status(text, text, text, text, text, text, text) from public;
revoke execute on function public.set_order_review_status(text, text, text, text, text, text, text) from anon, authenticated;
grant execute on function public.set_order_review_status(text, text, text, text, text, text, text) to service_role;
