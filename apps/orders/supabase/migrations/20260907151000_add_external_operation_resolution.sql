-- Domain: order_management
-- Owner: retailpulses/OrderMgmt
-- Affected: external_operation_resolutions, external_operation_attempts, resolve_external_operation
-- Change class: additive
-- Hosted write required: yes
-- Consumers: none

CREATE TABLE IF NOT EXISTS external_operation_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL REFERENCES external_operation_attempts(operation_key),
  previous_status text NOT NULL CHECK (previous_status IN ('RESERVED', 'UNKNOWN_RESULT', 'DEFINITIVE_FAILURE')),
  resolution_outcome text NOT NULL CHECK (resolution_outcome IN ('APPLIED', 'NOT_APPLIED')),
  resulting_status text NOT NULL CHECK (resulting_status IN ('ALREADY_APPLIED', 'RELEASED')),
  evidence_ref text NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 3 AND 500),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  resolved_by text NOT NULL CHECK (length(trim(resolved_by)) BETWEEN 2 AND 200),
  resolved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_external_operation_resolutions_operation
  ON external_operation_resolutions(operation_key, resolved_at DESC);

ALTER TABLE external_operation_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE external_operation_resolutions FROM anon, authenticated;
GRANT SELECT, INSERT ON external_operation_resolutions TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_external_operation(
  p_operation_key text,
  p_expected_status text,
  p_resolution_outcome text,
  p_evidence_ref text,
  p_reason text,
  p_resolved_by text
) RETURNS TABLE(
  resolution_id uuid,
  operation_key text,
  previous_status text,
  resulting_status text,
  resolved_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_resulting_status text;
  v_resolution external_operation_resolutions%ROWTYPE;
BEGIN
  IF nullif(trim(p_operation_key), '') IS NULL
     OR p_expected_status NOT IN ('RESERVED', 'UNKNOWN_RESULT', 'DEFINITIVE_FAILURE')
     OR p_resolution_outcome NOT IN ('APPLIED', 'NOT_APPLIED')
     OR length(trim(coalesce(p_evidence_ref, ''))) NOT BETWEEN 3 AND 500
     OR length(trim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 500
     OR length(trim(coalesce(p_resolved_by, ''))) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'invalid external operation resolution';
  END IF;

  IF p_expected_status = 'DEFINITIVE_FAILURE' AND p_resolution_outcome = 'APPLIED' THEN
    RAISE EXCEPTION 'definitive failure cannot be resolved as applied';
  END IF;

  v_resulting_status := CASE p_resolution_outcome
    WHEN 'APPLIED' THEN 'ALREADY_APPLIED'
    ELSE 'RELEASED'
  END;

  UPDATE external_operation_attempts AS attempt
  SET status = v_resulting_status,
      finalized_at = now(),
      updated_at = now(),
      reconciliation_note = left(
        'operator_resolution:' || trim(p_resolution_outcome) || ':' || trim(p_evidence_ref),
        500
      )
  WHERE attempt.operation_key = p_operation_key
    AND attempt.status = p_expected_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'external operation resolution conflict';
  END IF;

  INSERT INTO external_operation_resolutions (
    operation_key, previous_status, resolution_outcome, resulting_status,
    evidence_ref, reason, resolved_by
  ) VALUES (
    p_operation_key, p_expected_status, p_resolution_outcome, v_resulting_status,
    trim(p_evidence_ref), trim(p_reason), trim(p_resolved_by)
  ) RETURNING * INTO v_resolution;

  RETURN QUERY SELECT
    v_resolution.id,
    v_resolution.operation_key,
    v_resolution.previous_status,
    v_resolution.resulting_status,
    v_resolution.resolved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_external_operation(text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_external_operation(text,text,text,text,text,text)
  TO service_role;
