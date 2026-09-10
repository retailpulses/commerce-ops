-- Domain: order_management
-- Owner: retailpulses/ordermgmt
-- Affected: order_management_message_webhook_event (new table)
--                    sales_order_message_state (new columns + RPCs)
-- Change class: schema (new table + column additions + functions)
-- Hosted write required: yes; service_role only (authenticated read-only)
-- Consumers: webhook-handler.mjs, buyer-messages.mjs
--
-- OrderMgmt: durable webhook event receipt for Mercari
-- order_transaction_message_created events.
--
-- This table provides a durable, idempotent receipt for webhook events
-- consumed via the Ticket Handling shared event path. Each row records
-- one unique event identified by an idempotency_key backed by a UNIQUE
-- constraint. Processing is async after immediate 2xx acknowledgment.
--
-- Status lifecycle:
--   pending → processing → processed | failed | skipped | out_of_scope
-- Retries increment processing_attempts (max 3).
--
-- Claim safety:
--   claim_order_mgmt_webhook_event() atomically transitions pending →
--   processing and reclaims rows stuck in processing past the stale grace
--   window (worker crash). Attempts-exhausted rows are never reclaimed.
--
-- See: docs/webhook/mercari-event-contract.md
--      docs/webhook/webhook-architecture-adr.md

-- ============================================================================
-- 1. order_management_message_webhook_event
-- ============================================================================

-- The table must exist before any DROP POLICY / DROP TRIGGER targeting it:
-- PostgreSQL raises "relation does not exist" for a DROP on a missing table
-- even with IF EXISTS. Create first, then idempotently drop/recreate objects.
create table if not exists order_management_message_webhook_event (
  id                    uuid primary key default gen_random_uuid(),
  idempotency_key       text not null unique,

  source                text not null default 'mercari_webhook',
  topic                 text not null,
  shop_id               text not null,
  shop_name             text,
  order_transaction_id  text not null,
  order_id              text,

  webhook_received_at   timestamptz,
  server_received_at    timestamptz not null default now(),

  processing_status     text not null default 'pending',
  processing_attempts   integer not null default 0,
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  processing_error      text,
  last_attempt_at       timestamptz,

  in_scope              boolean,
  order_status_at_event text,
  buyer_message_id      text,

  is_duplicate          boolean not null default false,
  metrics               jsonb default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint chk_webhook_event_processing_status
    check (processing_status in ('pending','processing','processed','failed','skipped','out_of_scope')),
  constraint chk_webhook_event_source
    check (source in ('mercari_webhook','polling_reconciliation')),
  constraint chk_webhook_event_topic
    check (topic in ('order_transaction_message_created')),
  constraint chk_webhook_event_processing_attempts
    check (processing_attempts >= 0)
);

alter table order_management_message_webhook_event
  add column if not exists last_attempt_at timestamptz;

-- Idempotent hardening for a table that already existed before this migration
-- (e.g. an earlier partial apply): columns and CHECK constraints are added only
-- when missing, so CREATE TABLE IF NOT EXISTS never skips them on reapply.
alter table order_management_message_webhook_event
  add column if not exists is_duplicate boolean not null default false,
  add column if not exists metrics jsonb default '{}'::jsonb,
  alter column source set default 'mercari_webhook',
  alter column processing_status set default 'pending',
  alter column processing_attempts set default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_webhook_event_processing_status'
      and conrelid = 'order_management_message_webhook_event'::regclass
  ) then
    alter table order_management_message_webhook_event
      add constraint chk_webhook_event_processing_status
      check (processing_status in ('pending','processing','processed','failed','skipped','out_of_scope'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_webhook_event_source'
      and conrelid = 'order_management_message_webhook_event'::regclass
  ) then
    alter table order_management_message_webhook_event
      add constraint chk_webhook_event_source
      check (source in ('mercari_webhook','polling_reconciliation'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_webhook_event_topic'
      and conrelid = 'order_management_message_webhook_event'::regclass
  ) then
    alter table order_management_message_webhook_event
      add constraint chk_webhook_event_topic
      check (topic in ('order_transaction_message_created'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_webhook_event_processing_attempts'
      and conrelid = 'order_management_message_webhook_event'::regclass
  ) then
    alter table order_management_message_webhook_event
      add constraint chk_webhook_event_processing_attempts
      check (processing_attempts >= 0);
  end if;
end $$;

-- Idempotent policy/trigger teardown — safe here because the table exists.
-- Recreated below, so a reapply converges to a single policy + trigger.
drop policy if exists "Operators can read webhook events"
  on order_management_message_webhook_event;
drop trigger if exists trg_webhook_event_updated_at
  on order_management_message_webhook_event;

-- Index for idempotency lookups (UNIQUE constraint already covers single-key lookup)
create index if not exists ix_webhook_event_shop_order
  on order_management_message_webhook_event(shop_id, order_id);

create index if not exists ix_webhook_event_status
  on order_management_message_webhook_event(processing_status);

create index if not exists ix_webhook_event_received
  on order_management_message_webhook_event(server_received_at);

-- Claim index: pending/processing rows ordered by age (claim + retry scans)
create index if not exists ix_webhook_event_claim
  on order_management_message_webhook_event(server_received_at)
  where processing_status in ('pending','processing');

create index if not exists ix_webhook_event_msg_id
  on order_management_message_webhook_event(buyer_message_id)
  where buyer_message_id is not null;

-- Enable RLS
alter table order_management_message_webhook_event enable row level security;

-- Operators: read-only
create policy "Operators can read webhook events"
  on order_management_message_webhook_event
  for select to authenticated using (true);

-- Grant: service_role full access, authenticated read-only
grant select, insert, update, delete on order_management_message_webhook_event to service_role;
grant select on order_management_message_webhook_event to authenticated;

-- Updated-at trigger (reuses set_updated_at() from 20260702000000)
create trigger trg_webhook_event_updated_at
  before update on order_management_message_webhook_event
  for each row execute function set_updated_at();

-- ============================================================================
-- 2. Add webhook-metrics columns to sales_order_message_state
-- ============================================================================
-- Non-breaking: NULLable columns. Polling writes to these when comparing
-- against webhook event coverage; portal can surface webhook health indicators
-- after cutover without new schema changes.

alter table sales_order_message_state
  add column if not exists last_webhook_received_at timestamptz,
  add column if not exists last_webhook_processed_at timestamptz,
  add column if not exists webhook_miss_count integer not null default 0;

-- ============================================================================
-- 3. Atomic claim RPC — claim_order_mgmt_webhook_event
-- ============================================================================
-- Single-statement UPDATE ... RETURNING so concurrent workers can never
-- double-process an event. Transitions pending → processing; also reclaims
-- rows stuck in processing longer than the stale grace window (15 minutes,
-- i.e. worker crash recovery). Rows at/over max_attempts are never claimed.
--
-- The +3 headroom on the attempts cap exists so a row whose processing state
-- was never completed after hitting max_attempts (e.g. a worker crash during
-- the final attempt) can still be reclaimed once to reach a terminal state.

create or replace function claim_order_mgmt_webhook_event(
  event_id uuid,
  max_attempts integer default 3
)
returns setof order_management_message_webhook_event
language sql
security definer
set search_path = public
as $$
  update order_management_message_webhook_event as m
  set processing_status = 'processing',
      processing_started_at = now(),
      last_attempt_at = now(),
      processing_attempts = m.processing_attempts + 1
  where m.id = claim_order_mgmt_webhook_event.event_id
    and m.processing_attempts < (claim_order_mgmt_webhook_event.max_attempts + 3)
    and (
      m.processing_status = 'pending'
      or (
        m.processing_status = 'processing'
        and m.processing_started_at < now() - interval '15 minutes'
      )
    )
  returning m.*;
$$;

revoke all on function claim_order_mgmt_webhook_event(uuid, integer) from public;
grant execute on function claim_order_mgmt_webhook_event(uuid, integer) to service_role;

-- ============================================================================
-- 4. Atomic miss reconciliation RPC — reconcile_order_msg_webhook_misses
-- ============================================================================
-- Replaces the separate insert-then-increment path from the polling sync.
-- For every polling miss candidate this single governed RPC atomically:
--   1. inserts the reconciliation audit event with ON CONFLICT DO NOTHING
--      (idempotency_key UNIQUE dedups across repeated sync runs), and
--   2. increments webhook_miss_count ONLY when the audit row was newly created
--      (the `(xmax = 0)` idiom distinguishes an actual insert from a conflict
--      no-op).
-- Both steps run in one function/transaction, so a duplicate audit insert can
-- never double-count a miss. Returns the number of newly created misses.
--
-- The old non-atomic increment RPC is dropped so no stale surface remains.

drop function if exists increment_order_msg_webhook_miss_counts(jsonb);

create or replace function reconcile_order_msg_webhook_misses(events jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  ev jsonb;
  inserted boolean;
  created_count int := 0;
begin
  for ev in select * from jsonb_array_elements(events)
  loop
    insert into order_management_message_webhook_event (
      idempotency_key,
      source,
      topic,
      shop_id,
      order_transaction_id,
      order_id,
      webhook_received_at,
      server_received_at,
      processing_status,
      in_scope,
      buyer_message_id,
      is_duplicate,
      metrics
    )
    values (
      ev->>'idempotency_key',
      'polling_reconciliation',
      'order_transaction_message_created',
      ev->>'shop_id',
      ev->>'order_id',
      ev->>'order_id',
      now(),
      now(),
      'processed',
      true,
      ev->>'buyer_message_id',
      false,
      jsonb_build_object('detected_by', 'polling', 'webhook_miss', true)
    )
    on conflict (idempotency_key) do nothing
    returning (xmax = 0) into inserted;

    if inserted then
      update sales_order_message_state
      set webhook_miss_count = webhook_miss_count + 1
      where source_store_id = ev->>'shop_id'
        and order_transaction_id = ev->>'order_id';
      created_count := created_count + 1;
    end if;
  end loop;
  return created_count;
end;
$$;

revoke all on function reconcile_order_msg_webhook_misses(jsonb) from public;
grant execute on function reconcile_order_msg_webhook_misses(jsonb) to service_role;

-- ============================================================================
-- 5. Comments
-- ============================================================================

comment on table order_management_message_webhook_event is
  'Durable webhook event receipt for Mercari order_transaction_message_created events. One row per unique event; idempotency_key UNIQUE constraint prevents duplicates. Status transitions: pending→processing→processed/failed/skipped/out_of_scope. Retries capped at 3 attempts.';

comment on column order_management_message_webhook_event.idempotency_key is
  'Format: webhook:{shop_id}:{order_transaction_id}:{created_at}. Backed by UNIQUE constraint for atomic dedup.';

comment on column order_management_message_webhook_event.source is
  'Event source: mercari_webhook (normal intake) or polling_reconciliation (miss repair).';

comment on column order_management_message_webhook_event.order_transaction_id is
  'Mercari order_transaction_id from the webhook payload. Maps to sales_orders.order_id after stripping order_ prefix.';

comment on column order_management_message_webhook_event.order_id is
  'Normalized order_id (no order_ prefix). Populated during processing.';

comment on column order_management_message_webhook_event.last_attempt_at is
  'Timestamp of the most recent claim attempt (including stale-processing reclaims).';

comment on column order_management_message_webhook_event.metrics is
  'Non-sensitive JSON metrics: received_at, latency_ms, retry_count, webhook_miss, etc.';

comment on column sales_order_message_state.last_webhook_received_at is
  'Timestamp of the most recent webhook event received for this order. Never written from polling-miss detection.';

comment on column sales_order_message_state.last_webhook_processed_at is
  'Timestamp when the most recent webhook event completed processing for this order.';

comment on column sales_order_message_state.webhook_miss_count is
  'Running count of polling discoveries not previously observed through webhooks. Resettable after cutover.';
