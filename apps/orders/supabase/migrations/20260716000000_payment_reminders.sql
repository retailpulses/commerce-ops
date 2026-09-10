-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: public.payment_reminders
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none
--
-- Purpose: Track sent payment reminders for Mercari WAITING_FOR_PAYMENT orders,
-- enforcing idempotency (one reminder type per order per store).
-- Referenced by: src/lib/payment-reminders.mjs

-- ============================================================================
-- payment_reminders — one row per (order_id, source_store_id, reminder_type)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_reminders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            text NOT NULL,
  source_store_id     text NOT NULL,
  reminder_type       text NOT NULL CHECK (reminder_type IN ('day2', 'day3')),
  message_text        text NOT NULL,
  mercari_message_id  text,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- One reminder type per order per store
  CONSTRAINT uq_payment_reminder UNIQUE (order_id, source_store_id, reminder_type)
);

-- Worker-only table: service_role bypasses RLS; no client policies exist.
ALTER TABLE payment_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE payment_reminders FROM anon, authenticated;

-- Lookup index: check if a reminder was already sent for a specific order+store
CREATE INDEX IF NOT EXISTS ix_payment_reminders_order
  ON payment_reminders(order_id, source_store_id);

-- Lookup index: audit trail by sent time (for debugging / monitoring)
CREATE INDEX IF NOT EXISTS ix_payment_reminders_sent_at
  ON payment_reminders(sent_at);

-- ── Comments ────────────────────────────────────────────────────────────

COMMENT ON TABLE payment_reminders IS
  'Tracks automatic payment reminders sent to Mercari buyers for WAITING_FOR_PAYMENT orders. Enforces one day2 and one day3 reminder per (order_id, source_store_id).';

COMMENT ON COLUMN payment_reminders.order_id IS
  'Normalized Mercari order ID (order_ prefix stripped). Matches sales_orders.order_id.';

COMMENT ON COLUMN payment_reminders.source_store_id IS
  'Raw Mercari store/seller ID. Matches sales_orders.source_store_id.';

COMMENT ON COLUMN payment_reminders.reminder_type IS
  'Which reminder was sent: day2 (calendar day after purchase) or day3 (2 calendar days after purchase).';

COMMENT ON COLUMN payment_reminders.message_text IS
  'The rendered message text that was sent to the buyer (template with variables substituted).';

COMMENT ON COLUMN payment_reminders.mercari_message_id IS
  'The Mercari message ID returned by addOrderTransactionMessage, if available. Nullable — some send attempts may succeed without returning a message ID.';

COMMENT ON COLUMN payment_reminders.sent_at IS
  'When the reminder was successfully sent (JST timestamptz).';
