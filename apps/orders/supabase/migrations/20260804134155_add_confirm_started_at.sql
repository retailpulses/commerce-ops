-- Migration: add confirm_started_at timestamp for stuck-confirm detection
--
-- The confirmer previously used last_synced_at (shared with ingest) to
-- detect stuck confirm_in_progress flags. This was unreliable because
-- ingest updates last_synced_at on every order change, extending the
-- apparent lock age indefinitely.
--
-- confirm_started_at is set atomically with confirm_in_progress=true
-- and cleared together with confirm_in_progress=false. The confirmer
-- uses it as the authoritative lock-acquisition timestamp.

ALTER TABLE sales_orders
ADD COLUMN IF NOT EXISTS confirm_started_at timestamptz;
