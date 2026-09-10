-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: pipeline_orchestration_runs, pipeline_steps, order_orchestrator_lease
-- Change class: additive
-- Hosted write required: yes

CREATE TABLE IF NOT EXISTS pipeline_orchestration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  release_version text,
  trigger_type text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('shadow', 'live')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES pipeline_orchestration_runs(run_id) ON DELETE CASCADE,
  step_name text NOT NULL,
  sequence integer NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'BLOCKED', 'FAILED', 'SKIPPED')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  started_at timestamptz,
  ended_at timestamptz,
  result_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  UNIQUE (run_id, step_name, attempt)
);

CREATE TABLE IF NOT EXISTS order_orchestrator_lease (
  lease_name text PRIMARY KEY,
  owner_id text NOT NULL,
  run_id text NOT NULL,
  release_version text,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_pipeline_orchestration_runs_started ON pipeline_orchestration_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS ix_pipeline_steps_run_sequence ON pipeline_steps(run_id, sequence);

ALTER TABLE pipeline_orchestration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_orchestrator_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pipeline_orchestration_runs, pipeline_steps, order_orchestrator_lease FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pipeline_orchestration_runs, pipeline_steps TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_orchestrator_lease TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_order_orchestrator_lease(
  p_lease_name text, p_owner_id text, p_run_id text, p_release_version text, p_ttl_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_claimed boolean;
BEGIN
  IF p_ttl_seconds < 60 OR p_ttl_seconds > 3600 THEN RAISE EXCEPTION 'invalid lease ttl'; END IF;
  INSERT INTO order_orchestrator_lease AS lease (
    lease_name, owner_id, run_id, release_version, acquired_at, expires_at, heartbeat_at
  ) VALUES (
    p_lease_name, p_owner_id, p_run_id, p_release_version, now(), now() + make_interval(secs => p_ttl_seconds), now()
  ) ON CONFLICT (lease_name) DO UPDATE
    SET owner_id = EXCLUDED.owner_id, run_id = EXCLUDED.run_id,
        release_version = EXCLUDED.release_version, acquired_at = now(),
        expires_at = EXCLUDED.expires_at, heartbeat_at = now()
    WHERE lease.expires_at <= now() OR (lease.owner_id = p_owner_id AND lease.run_id = p_run_id)
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_order_orchestrator_lease(
  p_lease_name text, p_owner_id text, p_run_id text
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH deleted AS (
    DELETE FROM order_orchestrator_lease
    WHERE lease_name = p_lease_name AND owner_id = p_owner_id AND run_id = p_run_id
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM deleted);
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_order_orchestrator_lease(
  p_lease_name text, p_owner_id text, p_run_id text, p_ttl_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_renewed boolean;
BEGIN
  IF p_ttl_seconds < 60 OR p_ttl_seconds > 3600 THEN RAISE EXCEPTION 'invalid lease ttl'; END IF;
  UPDATE order_orchestrator_lease
  SET heartbeat_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
  WHERE lease_name = p_lease_name AND owner_id = p_owner_id AND run_id = p_run_id
    AND expires_at > now()
  RETURNING true INTO v_renewed;
  RETURN COALESCE(v_renewed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_order_orchestrator_lease(text,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_order_orchestrator_lease(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_order_orchestrator_lease(text,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_order_orchestrator_lease(text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_orchestrator_lease(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_order_orchestrator_lease(text,text,text,integer) TO service_role;
