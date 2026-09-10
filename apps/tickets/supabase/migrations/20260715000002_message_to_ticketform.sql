-- Message-to-TicketForm automation state. This migration deliberately has no
-- trigger or function that can write to tickets.

ALTER TABLE inbound_ticket_messages
  ADD COLUMN IF NOT EXISTS automation_decision text NOT NULL DEFAULT 'operator_review'
    CHECK (automation_decision IN ('no_action', 'operator_review', 'non_form_reply', 'ticketform_request')),
  ADD COLUMN IF NOT EXISTS automation_reason text,
  ADD COLUMN IF NOT EXISTS reply_status text NOT NULL DEFAULT 'not_attempted'
    CHECK (reply_status IN ('not_attempted', 'blocked', 'sending', 'sent', 'failed')),
  ADD COLUMN IF NOT EXISTS reply_platform_message_id text,
  ADD COLUMN IF NOT EXISTS reply_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_error text,
  ADD COLUMN IF NOT EXISTS submission_token_id uuid REFERENCES submission_tokens(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_reply_status
  ON inbound_ticket_messages (reply_status, received_at DESC);

ALTER TABLE submission_tokens
  ADD COLUMN IF NOT EXISTS source_inbound_message_id uuid
    REFERENCES inbound_ticket_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_name text,
  ADD COLUMN IF NOT EXISTS product_sku text,
  ADD COLUMN IF NOT EXISTS automation_case_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_tokens_source_inbound
  ON submission_tokens (source_inbound_message_id);

-- One usable automatic TicketForm per platform/account/order case. Revoking a
-- token explicitly releases the case for a replacement request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_tokens_automation_case
  ON submission_tokens (automation_case_key)
  WHERE automation_case_key IS NOT NULL AND status IN ('active', 'used');

COMMENT ON COLUMN inbound_ticket_messages.automation_decision IS
  'Message-to-TicketForm decision only; never an instruction to create a ticket.';
COMMENT ON COLUMN submission_tokens.automation_case_key IS
  'Idempotency key preventing duplicate active/used automatic form requests for an order.';
