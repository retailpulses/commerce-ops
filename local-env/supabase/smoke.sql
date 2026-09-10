\set ON_ERROR_STOP on

do $$
declare
  v_inquiry_id bigint;
  v_link_count integer;
  v_note text;
begin
  select id into strict v_inquiry_id
  from public.inquiries
  where external_inquiry_id = 'synthetic-inquiry-001';

  select count(*) into v_link_count
  from public.inquiry_product_links
  where inquiry_id = v_inquiry_id
    and product_variant_id = '00000000-0000-4000-8000-000000000101';

  if v_link_count <> 1 then
    raise exception 'expected one deterministic synthetic product link, got %', v_link_count;
  end if;

  update public.inquiries
  set notes = 'synthetic local write verified'
  where id = v_inquiry_id;

  select notes into strict v_note
  from public.inquiry_detail_vw
  where id = v_inquiry_id;

  if v_note <> 'synthetic local write verified' then
    raise exception 'Inquiry read/write verification failed';
  end if;
end
$$;

select json_build_object(
  'flow', 'synthetic_inquiry_read_write',
  'inquiries', (select count(*) from public.inquiries),
  'messages', (select count(*) from public.inquiry_messages),
  'product_links', (select count(*) from public.inquiry_product_links),
  'result', 'pass'
) as local_poc_result;
