\set ON_ERROR_STOP on

begin;

-- One synthetic catalog identity shared by the three domain flows. Fixed UUIDs
-- make failures reproducible; the transaction rolls back after all assertions.
insert into public.platform_accounts
  (id, platform, shop_code, display_name, seller_account_id, metadata)
values
  ('10000000-0000-4000-8000-000000000001', 'mercari', 'shop1',
   'Synthetic Shop', 'synthetic-account', '{"synthetic":true}');

insert into public.products (id, spu_code, title, category)
values ('20000000-0000-4000-8000-000000000001', 'SYNTH-SPU-001',
        'Synthetic Staging Product', 'synthetic');

insert into public.product_variants
  (id, product_id, sku, item_code, variant_name, status, raw_payload)
values
  ('30000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001',
   'SYNTH-SKU-001', 'SYNTH-SKU-001', 'Synthetic Variant', 'active',
   '{"synthetic":true}');

insert into public.product_commercials
  (variant_id, source_available_qty, source_unit_price, baseline_price,
   manual_cost_price, fulfillment_fee, rma_rate, raw_payload)
values
  ('30000000-0000-4000-8000-000000000001', 8, 1000, 900, 0, 500,
   'Low', '{"synthetic":true}');

-- Inquiry: intake -> persistence -> catalog relation -> normalized readback ->
-- compose-only draft. No outbound operation is created and no send credential
-- exists in the local environment.
insert into public.inquiries
  (external_inquiry_id, source, shop_key, status, automation_status,
   inquiry_date, inquiry_body, customer_nickname, product_name_snapshot,
   draft_reply, extra)
values
  ('synthetic-inquiry-001', 'mercari_shops', 'shop1', 'received', 'drafted',
   now(), 'Synthetic question: is this available?', 'Synthetic Buyer',
   'Synthetic Staging Product', 'Synthetic draft; delivery is disabled.',
   '{"synthetic":true}')
returning id as inquiry_id \gset

insert into public.inquiry_product_links
  (inquiry_id, product_variant_id, item_code_snapshot, product_name_snapshot,
   is_primary, link_source, confidence)
values
  (:inquiry_id, '30000000-0000-4000-8000-000000000001', 'SYNTH-SKU-001',
   'Synthetic Staging Product', true, 'operator', 1.00);

insert into public.inquiry_messages
  (inquiry_id, shop_key, external_inquiry_id, external_message_id,
   external_from, direction, body, sent_at, source_payload_hash)
values
  (:inquiry_id, 'shop1', 'synthetic-inquiry-001', 'synthetic-message-001',
   'BUYER', 'inbound', 'Synthetic question: is this available?', now(),
   repeat('0', 64));

-- Tickets: intake -> evidence -> lifecycle -> share/read -> atomic resolution.
insert into public.tickets
  (id, platform, account_id, external_order_id, external_thread_id, origin,
   customer_display_name, subject, description, status, priority, needs_reply,
   raw_source_payload)
values
  ('40000000-0000-4000-8000-000000000001', 'mercari',
   '10000000-0000-4000-8000-000000000001', 'SYNTH-ORDER-001',
   'synthetic-thread-001', 'platform_ingest', 'Synthetic Buyer',
   'Synthetic damaged item', 'Synthetic staging ticket', 'in_progress',
   'normal', true, '{"synthetic":true}');

insert into public.ticket_products
  (id, ticket_id, product_id, variant_id, sku, quantity, role)
values
  ('41000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'SYNTH-SKU-001', 1, 'primary');

insert into public.ticket_attachments
  (id, ticket_id, storage_bucket, storage_path, filename, mime_type,
   media_type, size_bytes, source, metadata)
values
  ('42000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', 'ticket-attachments',
   'synthetic/ticket-001/evidence.txt', 'evidence.txt', 'text/plain', 'file',
   24, 'operator_upload', '{"synthetic":true,"uploaded":false}');

insert into public.message_drafts (ticket_id, body, resolution_guide, created_by)
values ('40000000-0000-4000-8000-000000000001',
        'Synthetic resolution draft; delivery disabled.',
        'Information-only synthetic resolution.', 'local-staging');

insert into public.ticket_share_tokens
  (id, ticket_id, token_hash, client_operation_id, created_by, expires_at,
   snapshot, pii_reviewed_at, pii_reviewed_by)
values
  ('43000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', repeat('a', 64),
   '44000000-0000-4000-8000-000000000001', 'local-staging',
   now() + interval '1 day',
   '{"version":1,"seller_description":"Synthetic share view","synthetic":true}',
   now(), 'local-staging');

insert into public.ticket_share_attachments
  (share_token_id, attachment_id, display_order)
values ('43000000-0000-4000-8000-000000000001',
        '42000000-0000-4000-8000-000000000001', 0);

select * from public.record_ticket_resolution(
  '40000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000001',
  'information_only', null, 'JPY', null, null,
  'Synthetic staging resolution', null, 'local-staging', true
);

-- Orders: synthetic ingest -> reconciliation -> fulfillment transition. The
-- projection stops at local PENDING; no adapter credential or live scheduler
-- is available to perform a marketplace/Giga mutation.
insert into public.sales_orders
  (id, order_id, sales_channel, platform_account_id, source_store_id,
   order_status, review_status, product_name, b2b_item_code, variant_id,
   quantity, product_price, buyer_name, purchase_date)
values
  ('50000000-0000-4000-8000-000000000001', 'SYNTH-ORDER-001', 'mercari',
   '10000000-0000-4000-8000-000000000001', 'synthetic-shop1',
   'WAITING_FOR_SHIPPING', 'PENDING_REVIEW', 'Synthetic Staging Product',
   'SYNTH-SKU-001', '30000000-0000-4000-8000-000000000001', 1, 2500,
   'Synthetic Buyer', now());

update public.sales_orders
set review_status = 'APPROVED'
where id = '50000000-0000-4000-8000-000000000001';

insert into public.giga_shipment_projections
  (id, sales_order_id, order_id, sales_channel, source_store_id,
   giga_sync_status, b2b_item_code, ship_to_qty, ship_to_name,
   ship_to_address, order_comments)
values
  ('51000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000001', 'SYNTH-ORDER-001', 'mercari',
   'synthetic-shop1', 'PENDING', 'SYNTH-SKU-001', 1, 'Synthetic Buyer',
   'TEST-ONLY — no shipment', 'Synthetic fake-adapter path only');

-- Cross-domain read contracts and physical outbound absence assertions.
do $assertions$
declare
  inquiry_rows integer;
  ticket_rows integer;
  order_rows integer;
begin
  select count(*) into inquiry_rows
  from public.inquiry_detail_vw
  where external_inquiry_id = 'synthetic-inquiry-001'
    and jsonb_array_length(linked_products) = 1
    and draft_reply = 'Synthetic draft; delivery is disabled.';
  if inquiry_rows <> 1 then raise exception 'Inquiry acceptance failed'; end if;

  select count(*) into ticket_rows
  from public.tickets t
  join public.ticket_share_tokens s on s.ticket_id = t.id
  join public.ticket_resolution_actions r on r.ticket_id = t.id
  where t.id = '40000000-0000-4000-8000-000000000001'
    and t.status = 'closed' and s.status = 'active';
  if ticket_rows <> 1 then raise exception 'Ticket acceptance failed'; end if;

  select count(*) into order_rows
  from public.sales_orders o
  join public.giga_shipment_projections p on p.sales_order_id = o.id
  where o.id = '50000000-0000-4000-8000-000000000001'
    and o.review_status = 'APPROVED' and p.giga_sync_status = 'PENDING';
  if order_rows <> 1 then raise exception 'Order acceptance failed'; end if;

  if exists (
       select 1 from public.inquiry_outbound_operations o
       join public.inquiries i on i.id = o.inquiry_id
       where i.external_inquiry_id = 'synthetic-inquiry-001'
     )
     or exists (select 1 from public.sent_messages where ticket_id = '40000000-0000-4000-8000-000000000001')
     or exists (select 1 from public.external_operation_attempts)
  then
    raise exception 'Outbound physical-unavailability assertion failed';
  end if;
end
$assertions$;

select json_build_object(
  'inquiry', 'pass',
  'tickets', 'pass',
  'orders', 'pass',
  'cross_domain_catalog_relation', 'pass',
  'outbound_physically_unavailable', 'pass'
) as local_staging_acceptance;

rollback;
