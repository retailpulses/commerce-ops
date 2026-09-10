-- Domain: ticketing
-- Owner: retailpulses/ticket-handling
-- Affected: ticket_share_tokens, ticket_share_attachments, create_ticket_share,
--           revoke_ticket_share, resolve_ticket_share, authorize_ticket_share_attachment
-- Change class: additive
-- Hosted write required: yes
-- Consumers: retailpulses/ticket-handling

-- Seller-facing ticket shares are worker-only. The public viewer talks to the
-- ticketing Worker bridge and never connects to Postgres directly.

CREATE TABLE public.ticket_share_tokens (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  client_operation_id uuid NOT NULL,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  snapshot_version integer NOT NULL DEFAULT 1 CHECK (snapshot_version = 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  pii_reviewed_at timestamptz NOT NULL,
  pii_reviewed_by text NOT NULL CHECK (length(btrim(pii_reviewed_by)) > 0),
  access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ticket_share_client_operation UNIQUE (ticket_id, client_operation_id),
  CONSTRAINT chk_ticket_share_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX uq_ticket_share_one_active_per_ticket
  ON public.ticket_share_tokens (ticket_id)
  WHERE status = 'active';

CREATE INDEX idx_ticket_share_tokens_ticket_created
  ON public.ticket_share_tokens (ticket_id, created_at DESC);

CREATE TABLE public.ticket_share_attachments (
  share_token_id uuid NOT NULL
    REFERENCES public.ticket_share_tokens(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL
    REFERENCES public.ticket_attachments(id) ON DELETE CASCADE,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_token_id, attachment_id),
  CONSTRAINT uq_ticket_share_attachment_order UNIQUE (share_token_id, display_order)
);

CREATE INDEX idx_ticket_share_attachments_attachment
  ON public.ticket_share_attachments (attachment_id);

CREATE TRIGGER trg_ticket_share_tokens_updated_at
  BEFORE UPDATE ON public.ticket_share_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ticket_share_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_share_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ticket_share_tokens FROM anon, authenticated;
REVOKE ALL ON TABLE public.ticket_share_attachments FROM anon, authenticated;

COMMENT ON TABLE public.ticket_share_tokens IS
  'Worker-only, seven-day seller share grants. Only SHA-256 token hashes are stored.';
COMMENT ON TABLE public.ticket_share_attachments IS
  'Operator-selected attachment allowlist for a seller share.';
COMMENT ON COLUMN public.ticket_share_tokens.snapshot IS
  'Versioned, deny-by-default seller DTO. Never store raw ticket rows or structured buyer PII.';

CREATE OR REPLACE FUNCTION public.create_ticket_share(
  p_token_id uuid,
  p_ticket_id uuid,
  p_token_hash text,
  p_client_operation_id uuid,
  p_created_by text,
  p_snapshot jsonb,
  p_attachment_ids uuid[] DEFAULT '{}'::uuid[],
  p_rotate boolean DEFAULT false
)
RETURNS public.ticket_share_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_share public.ticket_share_tokens%ROWTYPE;
  v_attachment_ids uuid[] := COALESCE(p_attachment_ids, '{}'::uuid[]);
BEGIN
  IF p_token_id IS NULL OR p_ticket_id IS NULL OR p_client_operation_id IS NULL THEN
    RAISE EXCEPTION 'token, ticket, and client operation identifiers are required';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid token hash';
  END IF;
  IF length(btrim(COALESCE(p_created_by, ''))) = 0 THEN
    RAISE EXCEPTION 'created_by is required';
  END IF;
  IF jsonb_typeof(p_snapshot) <> 'object'
     OR (p_snapshot->>'version') IS DISTINCT FROM '1'
     OR length(btrim(COALESCE(p_snapshot->>'seller_description', ''))) = 0 THEN
    RAISE EXCEPTION 'invalid seller snapshot';
  END IF;

  -- Serialize create/rotate operations per ticket without locking ticket rows.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ticket_id::text, 0));

  IF NOT EXISTS (SELECT 1 FROM public.tickets WHERE id = p_ticket_id) THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;

  SELECT * INTO v_share
  FROM public.ticket_share_tokens
  WHERE ticket_id = p_ticket_id
    AND client_operation_id = p_client_operation_id;
  IF FOUND THEN
    RETURN v_share;
  END IF;

  IF cardinality(v_attachment_ids) <> (
    SELECT count(DISTINCT attachment_id)::integer
    FROM unnest(v_attachment_ids) AS selected(attachment_id)
  ) THEN
    RAISE EXCEPTION 'duplicate attachment id';
  END IF;

  IF cardinality(v_attachment_ids) <> (
    SELECT count(*)::integer
    FROM public.ticket_attachments
    WHERE ticket_id = p_ticket_id
      AND id = ANY(v_attachment_ids)
  ) THEN
    RAISE EXCEPTION 'attachment does not belong to ticket';
  END IF;

  UPDATE public.ticket_share_tokens
  SET status = 'expired'
  WHERE ticket_id = p_ticket_id
    AND status = 'active'
    AND expires_at <= now();

  IF NOT p_rotate THEN
    SELECT * INTO v_share
    FROM public.ticket_share_tokens
    WHERE ticket_id = p_ticket_id
      AND status = 'active';
    IF FOUND THEN
      RETURN v_share;
    END IF;
  ELSE
    UPDATE public.ticket_share_tokens
    SET status = 'revoked',
        revoked_at = now(),
        revoked_by = p_created_by
    WHERE ticket_id = p_ticket_id
      AND status = 'active';
  END IF;

  INSERT INTO public.ticket_share_tokens (
    id,
    ticket_id,
    token_hash,
    client_operation_id,
    created_by,
    status,
    expires_at,
    snapshot_version,
    snapshot,
    pii_reviewed_at,
    pii_reviewed_by
  ) VALUES (
    p_token_id,
    p_ticket_id,
    p_token_hash,
    p_client_operation_id,
    p_created_by,
    'active',
    now() + interval '7 days',
    1,
    p_snapshot,
    now(),
    p_created_by
  )
  RETURNING * INTO v_share;

  INSERT INTO public.ticket_share_attachments (
    share_token_id,
    attachment_id,
    display_order
  )
  SELECT v_share.id, selected.attachment_id, selected.ordinality - 1
  FROM unnest(v_attachment_ids) WITH ORDINALITY AS selected(attachment_id, ordinality);

  RETURN v_share;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_ticket_share(
  p_ticket_id uuid,
  p_share_id uuid,
  p_actor text
)
RETURNS public.ticket_share_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_share public.ticket_share_tokens%ROWTYPE;
BEGIN
  IF length(btrim(COALESCE(p_actor, ''))) = 0 THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_ticket_id::text, 0));

  UPDATE public.ticket_share_tokens
  SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END,
      revoked_at = CASE WHEN status = 'active' THEN now() ELSE revoked_at END,
      revoked_by = CASE WHEN status = 'active' THEN p_actor ELSE revoked_by END
  WHERE id = p_share_id
    AND ticket_id = p_ticket_id
  RETURNING * INTO v_share;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'share not found';
  END IF;
  RETURN v_share;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_ticket_share(p_token_hash text)
RETURNS TABLE (
  id uuid,
  ticket_id uuid,
  snapshot_version integer,
  snapshot jsonb,
  expires_at timestamptz,
  access_count bigint,
  last_accessed_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
SET lock_timeout = '2s'
AS $$
BEGIN
  UPDATE public.ticket_share_tokens tokens
  SET status = 'expired'
  WHERE tokens.token_hash = p_token_hash
    AND tokens.status = 'active'
    AND tokens.expires_at <= now();

  RETURN QUERY
  UPDATE public.ticket_share_tokens tokens
  SET access_count = tokens.access_count + 1,
      last_accessed_at = now()
  WHERE tokens.token_hash = p_token_hash
    AND tokens.status = 'active'
    AND tokens.expires_at > now()
  RETURNING
    tokens.id,
    tokens.ticket_id,
    tokens.snapshot_version,
    tokens.snapshot,
    tokens.expires_at,
    tokens.access_count,
    tokens.last_accessed_at,
    tokens.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_ticket_share_attachment(
  p_token_hash text,
  p_attachment_id uuid
)
RETURNS TABLE (
  share_id uuid,
  ticket_id uuid,
  attachment_id uuid,
  storage_bucket text,
  storage_path text,
  filename text,
  mime_type text,
  media_type text,
  size_bytes bigint,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
SET statement_timeout = '5s'
AS $$
  SELECT
    tokens.id,
    tokens.ticket_id,
    attachments.id,
    attachments.storage_bucket,
    attachments.storage_path,
    attachments.filename,
    attachments.mime_type,
    attachments.media_type,
    attachments.size_bytes,
    tokens.expires_at
  FROM public.ticket_share_tokens tokens
  JOIN public.ticket_share_attachments selected
    ON selected.share_token_id = tokens.id
  JOIN public.ticket_attachments attachments
    ON attachments.id = selected.attachment_id
   AND attachments.ticket_id = tokens.ticket_id
  WHERE tokens.token_hash = p_token_hash
    AND tokens.status = 'active'
    AND tokens.expires_at > now()
    AND attachments.id = p_attachment_id;
$$;

REVOKE ALL ON FUNCTION public.create_ticket_share(uuid, uuid, text, uuid, text, jsonb, uuid[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_ticket_share(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_ticket_share(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_ticket_share_attachment(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_ticket_share(uuid, uuid, text, uuid, text, jsonb, uuid[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_ticket_share(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_ticket_share(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_ticket_share_attachment(text, uuid) TO service_role;
