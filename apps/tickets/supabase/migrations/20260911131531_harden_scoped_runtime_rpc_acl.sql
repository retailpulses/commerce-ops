-- Domain: ticketing/platform-runtime-security
-- Owner: retailpulses/ticket-handling (authoritative source consolidated in retailpulses/commerce-ops)
-- Affected: function default ACLs for postgres/supabase_admin; scoped platform runtime RPC ACLs
-- Change class: additive
-- Hosted write required: yes; separate deployment approval and scoped-runtime credential readback required
-- Consumers: Mercari, Rakuten and Amazon send/ingestion Workers
-- Rollback: see retailpulses/inbox#104 PR body; restore only the explicit pre-change grants.

-- Batch 0. PostgreSQL normally grants EXECUTE on new functions to PUBLIC, and
-- the hosted project also has direct anon/authenticated function defaults for
-- these two audited application-function creators. Preserve service_role's
-- existing effective access explicitly after removing both exposure paths.
DO $migration$
DECLARE v_owner name;
BEGIN
  FOREACH v_owner IN ARRAY ARRAY['postgres'::name, 'supabase_admin'::name] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_owner) THEN
      IF v_owner = 'supabase_admin' THEN CONTINUE; END IF;
      RAISE EXCEPTION 'required default-ACL owner % does not exist', v_owner;
    END IF;
    IF NOT pg_has_role(current_user, v_owner, 'MEMBER')
       AND current_user <> v_owner::text THEN
      RAISE EXCEPTION 'migration role % cannot alter default privileges for %', current_user, v_owner;
    END IF;
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', v_owner);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', v_owner);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO service_role', v_owner);
  END LOOP;
END
$migration$;

-- Batch 1. service_role remains only for the documented Worker fallback.
REVOKE EXECUTE ON FUNCTION
  public.assert_platform_runtime_owner_v1(text,text,text),
  public.acquire_platform_runtime_lease_v1(text,text,text,uuid,text),
  public.release_platform_runtime_lease_v1(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.assert_platform_runtime_owner_v1(text,text,text),
  public.acquire_platform_runtime_lease_v1(text,text,text,uuid,text),
  public.release_platform_runtime_lease_v1(uuid)
TO ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime, service_role;

REVOKE EXECUTE ON FUNCTION
  public.probe_mercari_send_runtime_v1(), public.probe_mercari_ingestion_runtime_v1(),
  public.probe_rakuten_send_runtime_v1(), public.probe_rakuten_ingestion_runtime_v1(),
  public.probe_amazon_send_runtime_v1(), public.probe_amazon_ingestion_runtime_v1()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.probe_mercari_send_runtime_v1() TO ticketing_mercari_send_runtime, service_role;
GRANT EXECUTE ON FUNCTION public.probe_mercari_ingestion_runtime_v1() TO ticketing_mercari_ingestion_runtime, service_role;
GRANT EXECUTE ON FUNCTION public.probe_rakuten_send_runtime_v1() TO ticketing_rakuten_send_runtime, service_role;
GRANT EXECUTE ON FUNCTION public.probe_rakuten_ingestion_runtime_v1() TO ticketing_rakuten_ingestion_runtime, service_role;
GRANT EXECUTE ON FUNCTION public.probe_amazon_send_runtime_v1() TO ticketing_amazon_send_runtime, service_role;
GRANT EXECUTE ON FUNCTION public.probe_amazon_ingestion_runtime_v1() TO ticketing_amazon_ingestion_runtime, service_role;

REVOKE EXECUTE ON FUNCTION
  public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text),
  public.claim_pending_mercari_webhook_messages(integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.ingest_mercari_webhook_event_v1(text,text,text,timestamptz,timestamptz,text),
  public.claim_pending_mercari_webhook_messages(integer)
TO ticketing_mercari_ingestion_runtime, service_role;

REVOKE EXECUTE ON FUNCTION
  public.get_mercari_send_ticket_v1(uuid),
  public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text),
  public.release_mercari_operator_message_claim_v1(uuid,uuid,text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.get_mercari_send_ticket_v1(uuid),
  public.finalize_mercari_operator_message_send(uuid,uuid,text,text,text,timestamptz,text),
  public.release_mercari_operator_message_claim_v1(uuid,uuid,text,text)
TO ticketing_mercari_send_runtime, service_role;

REVOKE EXECUTE ON FUNCTION
  public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb),
  public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.ingest_rakuten_rmesse_inquiry(uuid,text,text,text,text,text,timestamptz,jsonb),
  public.upsert_rakuten_rmesse_sync_state_v1(uuid,timestamptz,timestamptz)
TO ticketing_rakuten_ingestion_runtime, service_role;

REVOKE EXECUTE ON FUNCTION
  public.get_rakuten_send_ticket_v1(uuid),
  public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text),
  public.release_rakuten_operator_message_claim_v1(uuid,uuid,text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.get_rakuten_send_ticket_v1(uuid),
  public.finalize_rakuten_operator_message_send(uuid,uuid,text,text,text,timestamptz,text),
  public.release_rakuten_operator_message_claim_v1(uuid,uuid,text,text)
TO ticketing_rakuten_send_runtime, service_role;

REVOKE EXECUTE ON FUNCTION
  public.ingest_amazon_mail_message_v3(uuid,text,text,text,timestamptz,text,text,text,text,text,text,integer),
  public.claim_amazon_mail_attachments(integer),
  public.finalize_amazon_mail_attachment_batch(jsonb),
  public.upsert_amazon_mail_sync_state_v2(text,text,bigint,timestamptz,text,timestamptz,timestamptz,text,timestamptz,text,jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.ingest_amazon_mail_message_v3(uuid,text,text,text,timestamptz,text,text,text,text,text,text,integer),
  public.claim_amazon_mail_attachments(integer),
  public.finalize_amazon_mail_attachment_batch(jsonb),
  public.upsert_amazon_mail_sync_state_v2(text,text,bigint,timestamptz,text,timestamptz,timestamptz,text,timestamptz,text,jsonb)
TO ticketing_amazon_ingestion_runtime, service_role;

REVOKE EXECUTE ON FUNCTION public.get_amazon_send_ticket_v1(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_amazon_send_ticket_v1(uuid) TO ticketing_amazon_send_runtime, service_role;

-- Verification SQL:
-- SELECT r.rolname AS owner, COALESCE(n.nspname, '*') AS schema_name,
--   COALESCE(grantee.rolname, 'PUBLIC') AS grantee, x.privilege_type
-- FROM pg_default_acl d
-- JOIN pg_roles r ON r.oid=d.defaclrole
-- LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
-- CROSS JOIN LATERAL aclexplode(d.defaclacl) x
-- LEFT JOIN pg_roles grantee ON grantee.oid=x.grantee
-- WHERE d.defaclobjtype='f' AND r.rolname IN ('postgres','supabase_admin')
-- ORDER BY r.rolname, schema_name, grantee;
-- Expected effective defaults: no PUBLIC/anon/authenticated EXECUTE;
-- service_role retains EXECUTE and the function owner retains implicit access.
