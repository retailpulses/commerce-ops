-- Migration: Copywrite AI generation log table
-- Purpose: Log every AI copywrite generation for statistical analysis and prompt improvement

CREATE TABLE IF NOT EXISTS copywrite_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ticket_id INTEGER NOT NULL,
  order_id TEXT NOT NULL DEFAULT '',
  shop TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('success', 'error')),
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  resolution_guide TEXT NOT NULL DEFAULT '',
  generated_reply TEXT NOT NULL DEFAULT '',
  reply_char_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  customer_message TEXT NOT NULL DEFAULT '',
  ticket_description TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_cl_ticket_id ON copywrite_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_cl_created_at ON copywrite_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_cl_status ON copywrite_logs(status);
