-- Add 'platform' to the ticket_events actor_type check constraint.
-- The code currently uses 'system' for webhook-originated events as a
-- workaround; once this migration is applied, we can switch back to
-- 'platform' for better event provenance tracking.

-- Drop the existing constraint
ALTER TABLE ticket_events DROP CONSTRAINT IF EXISTS ticket_events_actor_type_check;

-- Re-create with 'platform' included
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_actor_type_check
  CHECK (actor_type IN ('customer', 'operator', 'system', 'automation', 'platform'));
