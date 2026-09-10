-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: order_scheduler_ownership, order_scheduler_ownership_events
-- Change class: additive
-- Hosted write required: yes

CREATE TABLE IF NOT EXISTS order_scheduler_ownership (
  workload_id text PRIMARY KEY CHECK (length(trim(workload_id)) BETWEEN 3 AND 120),
  scheduler_owner text NOT NULL CHECK (scheduler_owner IN ('cloudflare_worker', 'vps_order_orchestrator', 'vps_reporting_timer', 'disabled')),
  runtime_host text NOT NULL CHECK (length(trim(runtime_host)) BETWEEN 2 AND 200),
  release_version text,
  kill_switch_state text NOT NULL CHECK (kill_switch_state IN ('enabled', 'disabled', 'unverified')),
  legacy_scheduler_disabled boolean NOT NULL,
  evidence_ref text NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 3 AND 500),
  evidence_observed_at timestamptz NOT NULL,
  verified_by text NOT NULL CHECK (length(trim(verified_by)) BETWEEN 2 AND 200),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_scheduler_ownership_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workload_id text NOT NULL,
  previous_owner text,
  scheduler_owner text NOT NULL,
  runtime_host text NOT NULL,
  release_version text,
  kill_switch_state text NOT NULL,
  legacy_scheduler_disabled boolean NOT NULL,
  evidence_ref text NOT NULL,
  evidence_observed_at timestamptz NOT NULL,
  verified_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_order_scheduler_ownership_expires ON order_scheduler_ownership(expires_at);
CREATE INDEX IF NOT EXISTS ix_order_scheduler_ownership_events_workload ON order_scheduler_ownership_events(workload_id, recorded_at DESC);

ALTER TABLE order_scheduler_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_scheduler_ownership_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON order_scheduler_ownership, order_scheduler_ownership_events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON order_scheduler_ownership, order_scheduler_ownership_events FROM service_role;
GRANT SELECT ON order_scheduler_ownership, order_scheduler_ownership_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_order_scheduler_ownership(
  p_workload_id text,
  p_expected_owner text,
  p_scheduler_owner text,
  p_runtime_host text,
  p_release_version text,
  p_kill_switch_state text,
  p_legacy_scheduler_disabled boolean,
  p_evidence_ref text,
  p_evidence_observed_at timestamptz,
  p_verified_by text,
  p_expires_at timestamptz
) RETURNS SETOF order_scheduler_ownership
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_previous order_scheduler_ownership%ROWTYPE;
  v_current order_scheduler_ownership%ROWTYPE;
BEGIN
  IF length(trim(coalesce(p_workload_id, ''))) NOT BETWEEN 3 AND 120
     OR p_scheduler_owner NOT IN ('cloudflare_worker', 'vps_order_orchestrator', 'vps_reporting_timer', 'disabled')
     OR length(trim(coalesce(p_runtime_host, ''))) NOT BETWEEN 2 AND 200
     OR p_kill_switch_state NOT IN ('enabled', 'disabled', 'unverified')
     OR length(trim(coalesce(p_evidence_ref, ''))) NOT BETWEEN 3 AND 500
     OR length(trim(coalesce(p_verified_by, ''))) NOT BETWEEN 2 AND 200
     OR p_evidence_observed_at IS NULL
     OR p_evidence_observed_at > now() + interval '5 minutes'
     OR p_evidence_observed_at < now() - interval '1 day'
     OR p_expires_at <= now()
     OR p_expires_at > now() + interval '8 days' THEN
    RAISE EXCEPTION 'invalid scheduler ownership evidence';
  END IF;
  IF p_scheduler_owner = 'vps_order_orchestrator' AND p_legacy_scheduler_disabled IS NOT TRUE THEN
    RAISE EXCEPTION 'vps ownership requires legacy scheduler disabled evidence';
  END IF;
  IF p_scheduler_owner = 'disabled' AND p_kill_switch_state <> 'disabled' THEN
    RAISE EXCEPTION 'disabled ownership requires disabled kill switch';
  END IF;

  SELECT * INTO v_previous FROM order_scheduler_ownership
  WHERE workload_id = trim(p_workload_id) FOR UPDATE;

  IF p_scheduler_owner = 'vps_order_orchestrator'
     AND (NOT FOUND OR v_previous.scheduler_owner NOT IN ('disabled', 'vps_order_orchestrator')) THEN
    RAISE EXCEPTION 'vps ownership requires prior disabled quiescence';
  END IF;

  IF FOUND THEN
    IF p_expected_owner IS NULL OR v_previous.scheduler_owner <> p_expected_owner THEN
      RAISE EXCEPTION 'scheduler ownership conflict';
    END IF;
    UPDATE order_scheduler_ownership SET
      scheduler_owner = p_scheduler_owner,
      runtime_host = trim(p_runtime_host),
      release_version = nullif(trim(coalesce(p_release_version, '')), ''),
      kill_switch_state = p_kill_switch_state,
      legacy_scheduler_disabled = p_legacy_scheduler_disabled,
      evidence_ref = trim(p_evidence_ref),
      evidence_observed_at = p_evidence_observed_at,
      verified_by = trim(p_verified_by),
      verified_at = now(),
      expires_at = p_expires_at,
      updated_at = now()
    WHERE workload_id = trim(p_workload_id)
    RETURNING * INTO v_current;
  ELSE
    IF p_expected_owner IS NOT NULL THEN RAISE EXCEPTION 'scheduler ownership conflict'; END IF;
    INSERT INTO order_scheduler_ownership (
      workload_id, scheduler_owner, runtime_host, release_version,
      kill_switch_state, legacy_scheduler_disabled, evidence_ref,
      evidence_observed_at, verified_by, expires_at
    ) VALUES (
      trim(p_workload_id), p_scheduler_owner, trim(p_runtime_host), nullif(trim(coalesce(p_release_version, '')), ''),
      p_kill_switch_state, p_legacy_scheduler_disabled, trim(p_evidence_ref),
      p_evidence_observed_at, trim(p_verified_by), p_expires_at
    ) RETURNING * INTO v_current;
  END IF;

  INSERT INTO order_scheduler_ownership_events (
    workload_id, previous_owner, scheduler_owner, runtime_host, release_version,
    kill_switch_state, legacy_scheduler_disabled, evidence_ref,
    evidence_observed_at, verified_by
  ) VALUES (
    v_current.workload_id, v_previous.scheduler_owner, v_current.scheduler_owner,
    v_current.runtime_host, v_current.release_version, v_current.kill_switch_state,
    v_current.legacy_scheduler_disabled, v_current.evidence_ref,
    v_current.evidence_observed_at, v_current.verified_by
  );
  RETURN NEXT v_current;
END;
$$;

REVOKE ALL ON FUNCTION public.record_order_scheduler_ownership(text,text,text,text,text,text,boolean,text,timestamptz,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_order_scheduler_ownership(text,text,text,text,text,text,boolean,text,timestamptz,text,timestamptz)
  TO service_role;
