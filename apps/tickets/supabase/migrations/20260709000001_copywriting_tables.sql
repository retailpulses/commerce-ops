-- ============================================================
-- Supabase Ticketing — Copywriting & Message Send Support
-- Phase 1: drafts, sent_messages, copywriting_logs
-- ============================================================

-- ── message_drafts — one draft per ticket ──

CREATE TABLE IF NOT EXISTS message_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body             text NOT NULL DEFAULT '',
  resolution_guide text DEFAULT '',
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_drafts_ticket ON message_drafts (ticket_id);

-- ── sent_messages — audit record of platform-sent replies ──

CREATE TABLE IF NOT EXISTS sent_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('mercari','amazon','rakuten','other')),
  platform_message_id text,
  body               text NOT NULL,
  reply_intent       text NOT NULL CHECK (reply_intent IN ('terminal','holding')),
  sent_by            text,
  sent_at            timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_ticket ON sent_messages (ticket_id, sent_at DESC);

-- ── copywriting_logs — AI generation audit trail ──

CREATE TABLE IF NOT EXISTS copywriting_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          uuid REFERENCES tickets(id) ON DELETE SET NULL,
  ticket_number      text,
  model              text NOT NULL,
  prompt_version     text DEFAULT 'default',
  resolution_guide   text,
  generated_reply    text,
  reply_char_count   integer,
  latency_ms         integer,
  status             text NOT NULL CHECK (status IN ('success','error')),
  error_message      text,
  customer_message   text,
  ticket_description text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copywriting_logs_ticket ON copywriting_logs (ticket_id);
CREATE INDEX IF NOT EXISTS idx_copywriting_logs_created ON copywriting_logs (created_at DESC);

-- ── RLS — service_role bypasses; add operator policies later ──

ALTER TABLE message_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE copywriting_logs ENABLE ROW LEVEL SECURITY;

-- ── Auto-update updated_at on drafts ──

DROP TRIGGER IF EXISTS trg_message_drafts_updated_at ON message_drafts;
CREATE TRIGGER trg_message_drafts_updated_at
  BEFORE UPDATE ON message_drafts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE message_drafts IS 'Per-ticket operator composer draft — one row per ticket';
COMMENT ON TABLE sent_messages IS 'Audit record of replies actually sent to platform message threads';
COMMENT ON TABLE copywriting_logs IS 'AI reply generation audit trail for quality and error-rate tracking';
