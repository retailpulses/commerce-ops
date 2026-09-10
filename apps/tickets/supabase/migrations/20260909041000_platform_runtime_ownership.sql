-- Domain: ticketing/platform-runtime-ownership
-- Owner: retailpulses/ticket-handling
-- Affected: platform_runtime_ownership, platform_runtime_leases, deployer/runtime RPCs
-- Change class: additive, platform-isolated control plane
-- Hosted write required: yes; exact-SHA approval and ownership/lease readback required
-- Consumers: six platform Workers and ticketing runtime deployer
-- Shared deployment control plane for six isolated runtime components.
-- Runtime identities may only assert their own active generation. A separate
-- deployer identity performs compare-and-swap transitions after operator
-- quiescence/handoff evidence has been recorded.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketing_runtime_deployer') THEN
    CREATE ROLE ticketing_runtime_deployer NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT ticketing_runtime_deployer TO authenticator;
GRANT USAGE ON SCHEMA public TO ticketing_runtime_deployer;

CREATE TABLE IF NOT EXISTS public.platform_runtime_ownership (
  component text PRIMARY KEY CHECK (component IN (
    'mercari-send','mercari-ingestion','rakuten-send','rakuten-ingestion','amazon-send','amazon-ingestion'
  )),
  routing_generation text NOT NULL,
  active_version_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','quiesced','activating','rolling_back')),
  in_flight_count integer NOT NULL DEFAULT 0 CHECK (in_flight_count >= 0),
  checkpoint text,
  previous_generation text,
  previous_version_id text,
  pending_version_id text,
  pending_generation text,
  transition_nonce uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_runtime_ownership ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.platform_runtime_leases (
  lease_id uuid PRIMARY KEY,
  component text NOT NULL REFERENCES public.platform_runtime_ownership(component) ON DELETE CASCADE,
  routing_generation text NOT NULL,
  version_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'work' CHECK (purpose IN ('work','intake')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  acquired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_runtime_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_runtime_ownership FROM PUBLIC, anon, authenticated,
  ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime,
  ticketing_runtime_deployer;
REVOKE ALL ON TABLE public.platform_runtime_leases FROM PUBLIC, anon, authenticated,
  ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime,
  ticketing_runtime_deployer;

CREATE OR REPLACE FUNCTION public.prepare_platform_runtime_handoff_v1(
  p_component text, p_expected_version_id text, p_new_generation text, p_checkpoint text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.platform_runtime_ownership%ROWTYPE;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  IF btrim(COALESCE(p_new_generation,'')) IN ('','none') THEN
    RAISE EXCEPTION 'runtime_generation_required' USING ERRCODE='22023';
  END IF;
  UPDATE public.platform_runtime_ownership owner SET in_flight_count=(
    SELECT count(*) FROM public.platform_runtime_leases lease
    WHERE lease.component=owner.component AND lease.purpose='work'
  ) WHERE owner.component=p_component;
  IF p_expected_version_id='none' THEN
    INSERT INTO public.platform_runtime_ownership(
      component,routing_generation,active_version_id,state,in_flight_count,checkpoint
    ) VALUES (p_component,p_new_generation,'none','quiesced',0,p_checkpoint)
    ON CONFLICT (component) DO NOTHING RETURNING * INTO v_row;
  ELSE
    UPDATE public.platform_runtime_ownership SET
      previous_generation=routing_generation, previous_version_id=active_version_id,
      routing_generation=p_new_generation,
      state='quiesced', checkpoint=p_checkpoint, updated_at=now()
    WHERE component=p_component AND active_version_id=p_expected_version_id
      AND state='active' AND in_flight_count=0
      AND NOT EXISTS (
        SELECT 1 FROM public.platform_runtime_leases l
        WHERE l.component=p_component AND l.purpose='work'
      )
    RETURNING * INTO v_row;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime_handoff_not_quiescent' USING ERRCODE='55000'; END IF;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.acquire_platform_runtime_lease_v1(
  p_component text, p_generation text, p_version_id text, p_lease_id uuid, p_purpose text DEFAULT 'work'
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_expected_role name;
BEGIN
  v_expected_role := ('ticketing_' || replace(p_component, '-', '_') || '_runtime')::name;
  IF current_setting('role', true) IS DISTINCT FROM v_expected_role::text THEN
    RAISE EXCEPTION 'runtime_lease_principal_mismatch' USING ERRCODE='42501';
  END IF;
  IF p_purpose NOT IN ('work','intake') OR (p_purpose='intake' AND p_component<>'mercari-ingestion') THEN
    RAISE EXCEPTION 'runtime_lease_purpose_invalid' USING ERRCODE='22023';
  END IF;
  UPDATE public.platform_runtime_ownership SET
    in_flight_count=in_flight_count + CASE WHEN p_purpose='work' THEN 1 ELSE 0 END,
    updated_at=now()
  WHERE component=p_component AND (
    (p_purpose='work' AND active_version_id=p_version_id AND state='active') OR
    (p_purpose='intake' AND state IN ('active','quiesced','activating','rolling_back') AND
      (active_version_id=p_version_id OR pending_version_id=p_version_id) AND
      (routing_generation=p_generation OR previous_generation=p_generation OR pending_generation=p_generation))
  );
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime_owner_not_active' USING ERRCODE='55000'; END IF;
  INSERT INTO public.platform_runtime_leases(lease_id,component,routing_generation,version_id,purpose,expires_at)
  VALUES(p_lease_id,p_component,p_generation,p_version_id,p_purpose,now()+interval '30 minutes');
  RETURN true;
END $$;

-- Expiry is diagnostic, not an automatic mutation fence. A deployer may reap
-- an expired work lease only as an explicit, audited recovery action after the
-- corresponding Worker invocation has been confirmed terminated.
CREATE OR REPLACE FUNCTION public.reap_expired_platform_runtime_lease_v1(
  p_component text, p_lease_id uuid, p_expected_version_id text, p_checkpoint text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  IF btrim(COALESCE(p_checkpoint,'')) = '' THEN
    RAISE EXCEPTION 'runtime_reap_evidence_required' USING ERRCODE='22023';
  END IF;
  DELETE FROM public.platform_runtime_leases lease
  USING public.platform_runtime_ownership owner
  WHERE lease.lease_id=p_lease_id AND lease.component=p_component
    AND lease.purpose='work' AND lease.expires_at<=now()
    AND owner.component=lease.component AND owner.active_version_id=p_expected_version_id
    AND owner.state='active';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'runtime_lease_reap_cas_failed' USING ERRCODE='40001'; END IF;
  UPDATE public.platform_runtime_ownership SET
    in_flight_count=(SELECT count(*) FROM public.platform_runtime_leases l WHERE l.component=p_component AND l.purpose='work'),
    checkpoint=p_checkpoint, updated_at=now()
  WHERE component=p_component AND active_version_id=p_expected_version_id AND state='active';
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.release_platform_runtime_lease_v1(p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_component text; v_purpose text; v_expected_role name;
BEGIN
  SELECT component,purpose INTO v_component,v_purpose FROM public.platform_runtime_leases WHERE lease_id=p_lease_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_expected_role := ('ticketing_' || replace(v_component, '-', '_') || '_runtime')::name;
  IF current_setting('role', true) IS DISTINCT FROM v_expected_role::text THEN
    RAISE EXCEPTION 'runtime_lease_principal_mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM public.platform_runtime_leases WHERE lease_id=p_lease_id;
  UPDATE public.platform_runtime_ownership SET
    in_flight_count=GREATEST(in_flight_count-CASE WHEN v_purpose='work' THEN 1 ELSE 0 END,0), updated_at=now()
  WHERE component=v_component;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.assert_platform_runtime_owner_v1(
  p_component text, p_generation text, p_version_id text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_expected_role name; v_row public.platform_runtime_ownership%ROWTYPE;
BEGIN
  v_expected_role := ('ticketing_' || replace(p_component, '-', '_') || '_runtime')::name;
  IF current_setting('role', true) IS DISTINCT FROM v_expected_role::text THEN
    RAISE EXCEPTION 'runtime_owner_principal_mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.platform_runtime_ownership WHERE component=p_component;
  IF NOT FOUND OR v_row.state <> 'active' OR v_row.routing_generation <> p_generation OR
     v_row.active_version_id <> p_version_id THEN
    RAISE EXCEPTION 'runtime_owner_not_active' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('active',true,'component',v_row.component,
    'routing_generation',v_row.routing_generation,'active_version_id',v_row.active_version_id,
    'checkpoint',v_row.checkpoint);
END $$;

CREATE OR REPLACE FUNCTION public.get_platform_runtime_ownership_v1(p_component text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.platform_runtime_ownership%ROWTYPE;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.platform_runtime_ownership WHERE component=p_component;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_prepared_platform_runtime_handoff_v1(
  p_component text, p_generation text, p_expected_version_id text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  IF p_expected_version_id='none' THEN
    DELETE FROM public.platform_runtime_ownership
    WHERE component=p_component AND routing_generation=p_generation
      AND active_version_id='none' AND state IN ('quiesced','activating')
      AND NOT EXISTS (SELECT 1 FROM public.platform_runtime_leases l WHERE l.component=p_component);
  ELSE
    UPDATE public.platform_runtime_ownership SET routing_generation=previous_generation,
      state='active', previous_generation=NULL, previous_version_id=NULL,
      checkpoint=NULL, updated_at=now()
    WHERE component=p_component AND routing_generation=p_generation
      AND active_version_id=p_expected_version_id AND state='quiesced'
      AND pending_version_id IS NULL AND previous_generation IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1;
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_platform_runtime_restored_v1(
  p_component text, p_from_version_id text, p_restored_version_id text,
  p_restored_generation text, p_evidence text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.platform_runtime_ownership%ROWTYPE;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  IF btrim(COALESCE(p_evidence,''))='' OR btrim(COALESCE(p_restored_generation,'')) IN ('','none') OR
     btrim(COALESCE(p_restored_version_id,'')) IN ('','none') THEN
    RAISE EXCEPTION 'runtime_restore_evidence_required' USING ERRCODE='22023';
  END IF;
  UPDATE public.platform_runtime_ownership SET
    routing_generation=p_restored_generation, active_version_id=p_restored_version_id,
    state='active', in_flight_count=0, checkpoint=p_evidence,
    previous_generation=NULL, previous_version_id=NULL,
    pending_version_id=NULL, pending_generation=NULL, transition_nonce=NULL,
    updated_at=now()
  WHERE component=p_component AND in_flight_count=0
    AND NOT EXISTS (SELECT 1 FROM public.platform_runtime_leases l WHERE l.component=p_component AND l.purpose='work')
    AND (
      active_version_id IN (p_from_version_id,p_restored_version_id) OR
      (active_version_id='none' AND pending_version_id=p_from_version_id)
    )
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime_restore_reconcile_cas_failed' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.begin_platform_runtime_transition_v1(
  p_component text, p_generation text, p_expected_version_id text,
  p_target_version_id text, p_target_generation text, p_transition text, p_nonce uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.platform_runtime_ownership%ROWTYPE;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  IF p_transition NOT IN ('activate','rollback') OR p_nonce IS NULL OR
     btrim(COALESCE(p_target_version_id,'')) = '' THEN
    RAISE EXCEPTION 'runtime_transition_invalid' USING ERRCODE='22023';
  END IF;
  UPDATE public.platform_runtime_ownership SET
    state = CASE WHEN p_transition='activate' THEN 'activating' ELSE 'rolling_back' END,
    pending_version_id=p_target_version_id, pending_generation=p_target_generation,
    transition_nonce=p_nonce, updated_at=now()
  WHERE component=p_component AND routing_generation=p_generation
    AND active_version_id=p_expected_version_id AND in_flight_count=0
    AND state=CASE WHEN p_transition='activate' THEN 'quiesced' ELSE 'active' END
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime_transition_cas_failed' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.finish_platform_runtime_transition_v1(
  p_component text, p_generation text, p_target_version_id text, p_target_generation text, p_nonce uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.platform_runtime_ownership%ROWTYPE;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  UPDATE public.platform_runtime_ownership SET active_version_id=p_target_version_id,
    routing_generation=p_target_generation, state='active', pending_version_id=NULL,
    pending_generation=NULL, transition_nonce=NULL, updated_at=now()
  WHERE component=p_component AND routing_generation=p_generation
    AND pending_version_id=p_target_version_id AND pending_generation=p_target_generation AND transition_nonce=p_nonce
    AND state IN ('activating','rolling_back')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime_transition_finish_cas_failed' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.abort_platform_runtime_transition_v1(
  p_component text, p_generation text, p_expected_version_id text, p_nonce uuid
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer;
BEGIN
  IF current_setting('role', true) <> 'ticketing_runtime_deployer' THEN
    RAISE EXCEPTION 'runtime_deployer_required' USING ERRCODE='42501';
  END IF;
  UPDATE public.platform_runtime_ownership SET
    routing_generation=CASE WHEN state='activating' AND previous_generation IS NOT NULL THEN previous_generation ELSE routing_generation END,
    state=CASE WHEN state='activating' AND p_expected_version_id='none' THEN 'quiesced' ELSE 'active' END,
    pending_version_id=NULL, pending_generation=NULL, transition_nonce=NULL, updated_at=now()
  WHERE component=p_component AND routing_generation=p_generation
    AND active_version_id=p_expected_version_id AND transition_nonce=p_nonce
    AND state IN ('activating','rolling_back');
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1;
END $$;

REVOKE ALL ON FUNCTION public.assert_platform_runtime_owner_v1(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_platform_runtime_ownership_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_prepared_platform_runtime_handoff_v1(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_platform_runtime_restored_v1(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_platform_runtime_handoff_v1(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_platform_runtime_lease_v1(text,text,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_platform_runtime_lease_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reap_expired_platform_runtime_lease_v1(text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_platform_runtime_transition_v1(text,text,text,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_platform_runtime_transition_v1(text,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abort_platform_runtime_transition_v1(text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_platform_runtime_owner_v1(text,text,text) TO
  ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.acquire_platform_runtime_lease_v1(text,text,text,uuid,text),
  public.release_platform_runtime_lease_v1(uuid) TO
  ticketing_mercari_send_runtime, ticketing_mercari_ingestion_runtime,
  ticketing_rakuten_send_runtime, ticketing_rakuten_ingestion_runtime,
  ticketing_amazon_send_runtime, ticketing_amazon_ingestion_runtime;
GRANT EXECUTE ON FUNCTION public.prepare_platform_runtime_handoff_v1(text,text,text,text) TO ticketing_runtime_deployer;
GRANT EXECUTE ON FUNCTION public.get_platform_runtime_ownership_v1(text),
  public.cancel_prepared_platform_runtime_handoff_v1(text,text,text),
  public.reconcile_platform_runtime_restored_v1(text,text,text,text,text) TO ticketing_runtime_deployer;
GRANT EXECUTE ON FUNCTION public.reap_expired_platform_runtime_lease_v1(text,uuid,text,text) TO ticketing_runtime_deployer;
GRANT EXECUTE ON FUNCTION public.begin_platform_runtime_transition_v1(text,text,text,text,text,text,uuid),
  public.finish_platform_runtime_transition_v1(text,text,text,text,uuid),
  public.abort_platform_runtime_transition_v1(text,text,text,uuid) TO ticketing_runtime_deployer;
