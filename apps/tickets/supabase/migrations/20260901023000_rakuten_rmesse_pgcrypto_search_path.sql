-- Domain: ticketing
-- Owner: retailpulses/ticket-handling
-- Affected: ingest_rakuten_rmesse_inquiry
-- Change class: additive
-- Hosted write required: yes
-- Consumers: retailpulses/ticket-handling
-- Forward recovery: restore the function search_path to public after replacing
-- all pgcrypto calls in the function with schema-qualified equivalents.

-- Supabase installs pgcrypto in the extensions schema. The attachment evidence
-- function is SECURITY DEFINER with a fixed search_path, so its unqualified
-- digest() call must be able to resolve extensions.digest().
ALTER FUNCTION public.ingest_rakuten_rmesse_inquiry(
  uuid, text, text, text, text, text, timestamptz, jsonb
) SET search_path TO public, extensions;
