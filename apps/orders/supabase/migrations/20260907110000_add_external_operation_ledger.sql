-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: external_operation_attempts
-- Change class: additive
-- Hosted write required: yes

CREATE TABLE IF NOT EXISTS external_operation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  capability text NOT NULL,
  platform text NOT NULL,
  source_store_id text NOT NULL,
  order_id text NOT NULL,
  payload_hash text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'RESERVED', 'CONFIRMED', 'ALREADY_APPLIED', 'UNKNOWN_RESULT', 'DEFINITIVE_FAILURE', 'RELEASED'
  )),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  provider_request_id text,
  provider_code text,
  error_code text,
  reconciliation_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_external_operation_attempts_status
  ON external_operation_attempts(capability, status, updated_at);
CREATE INDEX IF NOT EXISTS ix_external_operation_attempts_order
  ON external_operation_attempts(platform, source_store_id, order_id);

ALTER TABLE external_operation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE external_operation_attempts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON external_operation_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.claim_external_operation(
  p_operation_key text, p_capability text, p_platform text,
  p_source_store_id text, p_order_id text, p_payload_hash text, p_run_id text
) RETURNS TABLE(attempt_id uuid, claimed boolean, operation_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF nullif(trim(p_operation_key), '') IS NULL OR nullif(trim(p_capability), '') IS NULL
     OR nullif(trim(p_platform), '') IS NULL OR nullif(trim(p_source_store_id), '') IS NULL
     OR nullif(trim(p_order_id), '') IS NULL OR nullif(trim(p_payload_hash), '') IS NULL
     OR nullif(trim(p_run_id), '') IS NULL THEN
    RAISE EXCEPTION 'invalid external operation claim';
  END IF;
  RETURN QUERY
  INSERT INTO external_operation_attempts (
    operation_key, capability, platform, source_store_id, order_id,
    payload_hash, run_id, status
  ) VALUES (
    p_operation_key, p_capability, p_platform, p_source_store_id, p_order_id,
    p_payload_hash, p_run_id, 'RESERVED'
  )
  ON CONFLICT (operation_key) DO UPDATE
    SET run_id = EXCLUDED.run_id, status = 'RESERVED', reserved_at = now(),
        finalized_at = NULL, provider_request_id = NULL, provider_code = NULL,
        error_code = NULL, reconciliation_note = NULL, updated_at = now()
    WHERE external_operation_attempts.status = 'RELEASED'
  RETURNING external_operation_attempts.id, true, external_operation_attempts.status;

  IF NOT FOUND THEN
    RETURN QUERY SELECT attempt.id, false, attempt.status
      FROM external_operation_attempts AS attempt
      WHERE attempt.operation_key = p_operation_key;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_external_operation(
  p_operation_key text, p_run_id text, p_status text,
  p_provider_request_id text DEFAULT NULL, p_provider_code text DEFAULT NULL,
  p_error_code text DEFAULT NULL, p_reconciliation_note text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated boolean;
BEGIN
  IF p_status NOT IN ('CONFIRMED', 'ALREADY_APPLIED', 'UNKNOWN_RESULT', 'DEFINITIVE_FAILURE') THEN
    RAISE EXCEPTION 'invalid external operation terminal status';
  END IF;
  UPDATE external_operation_attempts
  SET status = p_status, finalized_at = now(), updated_at = now(),
      provider_request_id = nullif(left(coalesce(p_provider_request_id, ''), 200), ''),
      provider_code = nullif(left(coalesce(p_provider_code, ''), 100), ''),
      error_code = nullif(left(coalesce(p_error_code, ''), 500), ''),
      reconciliation_note = nullif(left(coalesce(p_reconciliation_note, ''), 500), '')
  WHERE operation_key = p_operation_key AND run_id = p_run_id AND status = 'RESERVED'
  RETURNING true INTO v_updated;
  RETURN COALESCE(v_updated, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_external_operation(text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_external_operation(text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_external_operation(text,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_external_operation(text,text,text,text,text,text,text) TO service_role;
