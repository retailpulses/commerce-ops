-- OrderMgmt: add buyer message tracking columns to sales_orders
--
-- These columns store the latest message ID and sync timestamp from the
-- marketplace buyer conversation, enabling the Portal to display message
-- status without needing to query a separate message store for basic
-- activity tracking.

-- ============================================================================
-- 1. Add columns to sales_orders
-- ============================================================================

alter table sales_orders
  add column if not exists latest_buyer_message_id text,
  add column if not exists message_last_synced_at timestamptz;

alter table sales_order_message_state
  add column if not exists latest_message_id text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_check_status text,
  add column if not exists last_check_error text;

-- ============================================================================
-- 2. Comments
-- ============================================================================

comment on column sales_orders.latest_buyer_message_id is 'ID of the most recent buyer message synced from the marketplace. Nullable — populated only after first message sync.';
comment on column sales_orders.message_last_synced_at is 'Timestamp of the last successful buyer message sync from the marketplace. Used to drive incremental sync windows and detect stale conversation state.';
comment on column sales_order_message_state.latest_message_id is 'ID of the latest buyer message used to compare against the durable read cursor.';
comment on column sales_order_message_state.last_checked_at is 'Timestamp of the latest marketplace message-state check.';
comment on column sales_order_message_state.last_check_status is 'Outcome of the latest marketplace message-state check.';
comment on column sales_order_message_state.last_check_error is 'Bounded error detail from the latest failed message-state check.';
