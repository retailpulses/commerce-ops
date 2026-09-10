CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
SET search_path TO public, extensions;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA storage;

CREATE TABLE public.platform_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text
);

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text
);

CREATE TABLE public.product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES public.products(id),
  item_code text,
  sku text
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text UNIQUE NOT NULL,
  platform text NOT NULL,
  account_id uuid REFERENCES public.platform_accounts(id),
  external_order_id text,
  external_thread_id text,
  origin text NOT NULL DEFAULT 'manual',
  customer_display_name text,
  customer_contact text,
  subject text,
  description text,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  issue_types text[] NOT NULL DEFAULT '{}',
  assigned_user_id uuid,
  assigned_display_name text,
  latest_message_at timestamptz,
  latest_customer_message text,
  needs_reply boolean NOT NULL DEFAULT false,
  external_url text,
  raw_source_payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE SEQUENCE public.ticket_number_seq;

CREATE FUNCTION public.generate_ticket_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.ticket_number := 'TEST-' || nextval('public.ticket_number_seq')::text;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ticket_number
  BEFORE INSERT ON public.tickets
  FOR EACH ROW
  WHEN (NEW.ticket_number IS NULL)
  EXECUTE FUNCTION public.generate_ticket_number();

CREATE UNIQUE INDEX idx_tickets_platform_order
  ON public.tickets (platform, account_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

CREATE TABLE public.ticket_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  variant_id uuid REFERENCES public.product_variants(id),
  sku text NOT NULL,
  role text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_ticket_products_link
  ON public.ticket_products (
    ticket_id,
    COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  platform text NOT NULL,
  external_message_id text,
  sender_type text NOT NULL,
  sender_display_name text,
  body text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.customer_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  submission_type text NOT NULL DEFAULT 'damage_evidence',
  issue_description text,
  expected_solution text,
  source text NOT NULL DEFAULT 'public_form',
  processing_status text NOT NULL DEFAULT 'pending',
  raw_payload jsonb NOT NULL DEFAULT '{}',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES public.tickets(id) ON DELETE CASCADE,
  customer_submission_id uuid REFERENCES public.customer_submissions(id) ON DELETE SET NULL,
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  original_url text,
  filename text,
  mime_type text,
  media_type text NOT NULL,
  size_bytes bigint,
  source text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_events_event_type_check CHECK (event_type IN (
    'ticket_created','ticket_reopened','message_added','message_received',
    'message_sent','status_changed','priority_changed','resolution_updated',
    'attachment_added','product_linked','product_unlinked','note_added',
    'ai_reply_generated','operator_escalated','wecom_notified','platform_sync_failed'
  ))
);

CREATE TABLE public.ticket_resolution_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  amount numeric,
  currency text DEFAULT 'JPY',
  replacement_sku text,
  quantity integer,
  reason text,
  approved_by text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.inbound_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  linked_ticket_id uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  queue_status text NOT NULL DEFAULT 'unread',
  review_status text NOT NULL DEFAULT 'needs_review',
  received_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  reviewed_at timestamptz
);

CREATE TABLE public.submission_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text UNIQUE NOT NULL,
  ticket_id uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  platform text,
  account_id uuid REFERENCES public.platform_accounts(id),
  external_order_id text,
  customer_submission_id uuid REFERENCES public.customer_submissions(id) ON DELETE SET NULL,
  allowed_submission_type text NOT NULL DEFAULT 'damage_evidence',
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  max_upload_count integer,
  used_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.sent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  platform text NOT NULL,
  platform_message_id text,
  body text NOT NULL,
  reply_intent text NOT NULL,
  sent_by text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text,
  metadata jsonb,
  UNIQUE (bucket_id, name)
);
