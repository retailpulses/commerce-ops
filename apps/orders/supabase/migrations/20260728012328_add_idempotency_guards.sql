-- Domain: order_management
-- Owner:  OrderMgmt
-- Affected objects: idempotency_guards (new table)
-- Change class: schema (new table)
-- Hosted-write requirement: service_role only (authenticated read-only)
-- Consumers: src/lib/idempotency.mjs, src/lib/auto-approval.mjs, src/lib/portal/handlers.mjs
--
-- OrderMgmt: idempotency guard table
-- Replaces Cloudflare KV auto-msg:* and reply-sent:* idempotency keys.
-- Used by auto-approval message sending and portal reply dedup to prevent
-- duplicate messages when runs overlap or retry.
--
-- KV TTL semantics:
--   auto-msg:*     → permanent (expires_at IS NULL)
--   reply-sent:*   → 60-second TTL (expires_at = now() + 60s)
--
-- This table uses a unique constraint on guard_key for atomic dedup.
-- Expired rows are cleaned on insert (delete+insert) and filtered in
-- check queries (expires_at IS NULL OR expires_at > now()).

create table if not exists idempotency_guards (
  id         bigint primary key generated always as identity,
  guard_key  text not null unique,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- Index for TTL-based queries (checkIdempotencyGuard filters on expires_at)
create index if not exists ix_idempotency_guards_expires
  on idempotency_guards(expires_at)
  where expires_at is not null;

-- Index for general cleanup (background GC job)
create index if not exists ix_idempotency_guards_created
  on idempotency_guards(created_at);

-- Enable RLS
alter table idempotency_guards enable row level security;

-- Operators: read-only
create policy "Operators can read idempotency guards"
  on idempotency_guards for select to authenticated using (true);

-- Grant: service_role full access, authenticated read-only
grant select, insert, update, delete on idempotency_guards to service_role;
grant select on idempotency_guards to authenticated;

comment on table idempotency_guards is 'Lightweight KV replacement for auto-approval and reply idempotency guards. Replaces auto-msg:* and reply-sent:* CF KV keys.';
comment on column idempotency_guards.guard_key is 'Unique guard key (e.g. auto-msg:v2:<orderId>:<transitionId> or reply-sent:<orderId>:<contentHash>).';
comment on column idempotency_guards.expires_at is 'When the guard expires (NULL = permanent). reply-sent:* keys get 60s TTL.';
