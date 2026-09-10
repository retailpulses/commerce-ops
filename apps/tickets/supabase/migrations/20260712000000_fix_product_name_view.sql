-- Fix ticket_list_view to use actual product name from joined products table
-- (was incorrectly using t.subject AS product_name as a placeholder)
-- Issue: #122

-- Recreate ticket_list_view with proper product_name from master product data
CREATE OR REPLACE VIEW ticket_list_view AS
SELECT
  t.id                                  AS ticket_id,
  t.ticket_number,
  t.platform,
  t.account_id,
  pa.display_name                       AS account_display_name,
  t.external_order_id,
  t.status,
  t.priority,
  t.issue_types,
  t.customer_display_name,
  t.subject,
  COALESCE(p.title, pv.variant_name)    AS product_name,
  tp.sku                                AS primary_sku,
  t.latest_message_at,
  t.latest_customer_message,
  t.needs_reply,
  t.external_url,
  t.assigned_user_id,
  t.assigned_display_name,
  t.origin,
  t.started_at,
  t.created_at,
  t.updated_at,
  (SELECT count(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id)  AS attachment_count,
  (SELECT count(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id)        AS note_count,
  (SELECT count(*) FROM ticket_events te WHERE te.ticket_id = t.id)       AS event_count
FROM tickets t
LEFT JOIN platform_accounts pa ON t.account_id = pa.id
LEFT JOIN ticket_products tp ON t.id = tp.ticket_id AND tp.role = 'primary'
LEFT JOIN products p ON tp.product_id = p.id
LEFT JOIN product_variants pv ON tp.variant_id = pv.id;

-- Also update ticket_detail_view to include product_name and primary_sku
CREATE OR REPLACE VIEW ticket_detail_view AS
SELECT
  t.id,
  t.ticket_number,
  t.platform,
  t.account_id,
  pa.display_name                       AS account_display_name,
  pa.shop_code                          AS account_shop_code,
  pa.platform                           AS account_platform,
  t.external_order_id,
  t.external_thread_id,
  t.origin,
  t.customer_display_name,
  t.customer_contact,
  t.subject,
  t.description,
  t.status,
  t.priority,
  t.issue_types,
  t.assigned_user_id,
  t.assigned_display_name,
  t.latest_message_at,
  t.latest_customer_message,
  t.needs_reply,
  t.external_url,
  t.raw_source_payload,
  t.started_at,
  t.created_at,
  t.updated_at,
  t.closed_at,
  (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp2.id,
      'product_id', tp2.product_id,
      'variant_id', tp2.variant_id,
      'listing_id', tp2.listing_id,
      'listing_sku_id', tp2.listing_sku_id,
      'sku', tp2.sku,
      'quantity', tp2.quantity,
      'role', tp2.role,
      'product_title', p2.title,
      'variant_name', pv2.variant_name,
      'listing_title', pl.title
    ) ORDER BY tp2.role = 'primary' DESC, tp2.created_at ASC)
    FROM ticket_products tp2
    LEFT JOIN products p2 ON tp2.product_id = p2.id
    LEFT JOIN product_variants pv2 ON tp2.variant_id = pv2.id
    LEFT JOIN platform_listings pl ON tp2.listing_id = pl.id
    WHERE tp2.ticket_id = t.id
  )                                     AS products,
  (SELECT count(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id)  AS attachment_count,
  (SELECT count(*) FROM ticket_notes tn WHERE tn.ticket_id = t.id)        AS note_count,
  (SELECT count(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id)     AS message_count,
  (SELECT count(*) FROM ticket_events te WHERE te.ticket_id = t.id)       AS event_count
FROM tickets t
LEFT JOIN platform_accounts pa ON t.account_id = pa.id;

COMMENT ON VIEW ticket_list_view IS 'List-optimized ticket summary with primary product name from master data';
COMMENT ON VIEW ticket_detail_view IS 'Full ticket detail with product join data';
