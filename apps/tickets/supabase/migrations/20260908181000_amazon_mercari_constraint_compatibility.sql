-- Domain: ticketing shared-core compatibility
-- Owner: retailpulses/ticket-handling
-- Affected: inbound_ticket_messages source-fields constraint
-- Prerequisite: 20260907160000_amazon_zoho_mail_pipeline.sql
-- Change class: forward-only compatibility repair
-- Hosted write required: yes; explicit production approval required
-- Consumers: Ticket Handling Mercari webhook and Amazon mail ingestion

-- Amazon mail introduced source_received_at, but Mercari webhooks own
-- webhook_received_at. Restore independent source-specific constraint arms.
ALTER TABLE public.inbound_ticket_messages
  DROP CONSTRAINT IF EXISTS chk_inbound_ticket_messages_source_fields;

ALTER TABLE public.inbound_ticket_messages
  ADD CONSTRAINT chk_inbound_ticket_messages_source_fields CHECK (
    (
      source = 'mercari_webhook'
      AND shop_name IS NOT NULL
      AND shop_id IS NOT NULL
      AND order_transaction_id IS NOT NULL
      AND webhook_received_at IS NOT NULL
    )
    OR
    (
      source = 'amazon_zoho_mail'
      AND provider_account_id IS NOT NULL
      AND provider_folder_id IS NOT NULL
      AND provider_message_id IS NOT NULL
      AND source_received_at IS NOT NULL
      AND mail_auth_status IN ('pass', 'failed', 'unavailable')
      AND (
        (mail_auth_status = 'pass' AND external_order_id IS NOT NULL)
        OR review_status = 'untrusted_review'
        OR external_order_id IS NULL
      )
    )
  );
