-- Domain: inquiry_management
-- Owner: retailpulses/inquiry-automation
-- Affected: inquiries, inquiry_product_links, knowledge_articles, inquiry_knowledge_links,
--   inquiry_management_set_updated_at
-- Change class: additive
-- Hosted write required: yes
-- Consumers:
--   retailpulses/workers (mail-integration: inquiry create/update, product reads, knowledge reads)
--   retailpulses/skills:mercari-inquiry-follow-up (inquiry reads, follow-up status writes)
--   inquiry-automation dashboard (server-side operator reads/mutations)
--   inquiry-automation Worker (classification, product linking, draft writes)
--   inquiry-automation VPS enrichment (Mercari detail extraction writes)
--
-- Schema decision: inquiry_management is a governance domain, not a physical Postgres schema.
-- All tables live in the public schema. This avoids search_path complexity and is consistent
-- with existing RPagentOS-owned tables (product_catalog, ticketing, etc.).
--
-- Phase 1 MVP tables only. Deferred: inquiry_messages, inquiry_events, inquiry_enrichment_runs,
-- accounts, cursor_state, runtime_logs, message_templates (KV retained).
-- External dependencies (owned by retailpulses/RPagentOS):
--   public.product_variants(id uuid), public.platform_accounts(id uuid)

-- =============================================================================
-- 1. Search extension
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- =============================================================================
-- 2. Canonical inquiries table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inquiries (
  -- Identity and provenance
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  baserow_row_id INTEGER UNIQUE,           -- nullable, migration provenance only
  legacy_mercari_inquiries_id BIGINT UNIQUE, -- nullable, consolidation provenance
  source TEXT NOT NULL DEFAULT 'mercari_shops'
    CHECK (source IN ('mercari_shops', 'email', 'rakuten', 'amazon', 'manual', 'zoho', 'unknown')),
  external_inquiry_id TEXT,                -- Mercari inquiry ID from URL path /inquiries/{id}
  external_thread_id TEXT,                 -- Legacy /talk-rooms/ ID
  url TEXT,                                -- Full Mercari inquiry URL
  shop_key TEXT
    CHECK (shop_key IN ('shop1', 'shop2', 'shop3', 'shop4')),
  platform_account_id UUID REFERENCES public.platform_accounts(id) ON DELETE SET NULL,

  -- Workflow state
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'followed_up', 'answered', 'closed_won', 'closed_lose')),
  automation_status TEXT NOT NULL DEFAULT 'new'
    CHECK (automation_status IN ('new', 'classified', 'product_linked', 'drafted', 'copywritten', 'failed')),
  follow_up_status TEXT DEFAULT 'open'
    CHECK (follow_up_status IN ('open', 'followed_up', 'do_not_follow_up')),
  inquiry_type TEXT
    CHECK (inquiry_type IN (
      'product_availability', 'shipping_related', 'assembly', 'price_negotiation',
      'others', 'product_spec', 'bulk_purchase', 'find_a_product',
      'scheduled_delivery', 'okinawa_inquiry'
    )),
  deleted_at TIMESTAMPTZ,                  -- Soft deletion

  -- Inquiry and customer data
  inquiry_date TIMESTAMPTZ,
  inquiry_body TEXT,
  customer_nickname TEXT,
  product_name_snapshot TEXT,              -- Denormalized at ingestion time
  sender_email TEXT,
  receiving_email TEXT,
  last_inbound_time TIMESTAMPTZ,
  last_custom_message TEXT,
  message_log_raw TEXT,                    -- Raw appended log, defer normalization to Phase 2
  order_id TEXT,                           -- Extracted via regex from inquiry body
  seller TEXT,

  -- Draft and assisted-reply data
  draft_reply TEXT,
  reply_strategy TEXT,
  inquiry_skill_reply TEXT,
  reply_drafted_at TIMESTAMPTZ,
  ai_copywritten_reply TEXT,               -- Separated from ai_copywritten_at (see migration notes)
  ai_copywritten_at TIMESTAMPTZ,           -- Separated from ai_copywritten_reply
  reply_assist_status TEXT,
  reply_assist_request_id TEXT,
  reply_assist_last_result TEXT,

  -- Mercari enrichment and commercial snapshot data
  mercari_product_id TEXT,
  mercari_variant_name TEXT,
  units INTEGER,
  effective_price_excl_shipping NUMERIC(10,2),
  effective_price_incl_shipping NUMERIC(10,2),
  effective_tcogs NUMERIC(10,2),
  expected_value NUMERIC(10,2),            -- Computed server-side when units changes

  -- Follow-up and compatibility data
  follow_up_sent_at TIMESTAMPTZ,
  notes TEXT,

  -- Operational metadata
  extra JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency constraint: stable external identity
CREATE UNIQUE INDEX IF NOT EXISTS idx_inquiries_external_identity
  ON public.inquiries (source, shop_key, external_inquiry_id)
  WHERE external_inquiry_id IS NOT NULL AND shop_key IS NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON public.inquiries (status);
CREATE INDEX IF NOT EXISTS idx_inquiries_automation_status ON public.inquiries (automation_status);
CREATE INDEX IF NOT EXISTS idx_inquiries_follow_up_status ON public.inquiries (follow_up_status);
CREATE INDEX IF NOT EXISTS idx_inquiries_shop_key ON public.inquiries (shop_key);
CREATE INDEX IF NOT EXISTS idx_inquiries_inquiry_date ON public.inquiries (inquiry_date DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON public.inquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_customer_nickname ON public.inquiries (customer_nickname);
CREATE INDEX IF NOT EXISTS idx_inquiries_sender_email ON public.inquiries (sender_email);
CREATE INDEX IF NOT EXISTS idx_inquiries_deleted_at ON public.inquiries (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_external_inquiry_id ON public.inquiries (external_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_url ON public.inquiries (url);

-- Japanese search support: pg_trgm GIN indexes for ILIKE queries
CREATE INDEX IF NOT EXISTS idx_inquiries_body_trgm ON public.inquiries
  USING GIN (inquiry_body extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inquiries_customer_trgm ON public.inquiries
  USING GIN (customer_nickname extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inquiries_product_snapshot_trgm ON public.inquiries
  USING GIN (product_name_snapshot extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inquiries_last_custom_msg_trgm ON public.inquiries
  USING GIN (last_custom_message extensions.gin_trgm_ops);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.inquiry_management_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inquiries_updated_at ON public.inquiries;
CREATE TRIGGER trg_inquiries_updated_at
  BEFORE UPDATE ON public.inquiries
  FOR EACH ROW EXECUTE FUNCTION public.inquiry_management_set_updated_at();

-- RLS: worker_only access class — enabled with no browser-visible policies
ALTER TABLE public.inquiries ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 3. Knowledge articles
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.knowledge_articles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  baserow_row_id INTEGER UNIQUE,            -- Migration provenance (from Baserow 897440)
  title TEXT NOT NULL,
  body TEXT,                                 -- Was "Knowledge" in Baserow
  active BOOLEAN NOT NULL DEFAULT true,
  tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_articles_tag ON public.knowledge_articles (tag);
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_active ON public.knowledge_articles (active) WHERE active;

DROP TRIGGER IF EXISTS trg_knowledge_articles_updated_at ON public.knowledge_articles;
CREATE TRIGGER trg_knowledge_articles_updated_at
  BEFORE UPDATE ON public.knowledge_articles
  FOR EACH ROW EXECUTE FUNCTION public.inquiry_management_set_updated_at();

ALTER TABLE public.knowledge_articles ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 4. Inquiry-product junction table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inquiry_product_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id BIGINT NOT NULL REFERENCES public.inquiries(id) ON DELETE CASCADE,
  -- product_variant_id: canonical Supabase product catalog reference
  -- Uses the product_variants table in product_catalog domain (owned by RPagentOS)
  product_variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
  baserow_product_row_id INTEGER,            -- Migration provenance for unresolved links
  item_code_snapshot TEXT,                   -- Snapshot at link time
  product_name_snapshot TEXT,                -- Snapshot at link time
  is_primary BOOLEAN NOT NULL DEFAULT false,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  link_source TEXT
    CHECK (link_source IN ('worker_match', 'operator', 'enrichment', 'migration', 'unknown')),
  confidence NUMERIC(3,2),                  -- 0.00–1.00 match confidence
  CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CHECK (
    product_variant_id IS NOT NULL
    OR baserow_product_row_id IS NOT NULL
    OR item_code_snapshot IS NOT NULL
  ),
  UNIQUE (inquiry_id, baserow_product_row_id),
  UNIQUE (inquiry_id, item_code_snapshot)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_product_links_variant
  ON public.inquiry_product_links (inquiry_id, product_variant_id)
  WHERE product_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiry_product_links_product
  ON public.inquiry_product_links (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_product_links_primary
  ON public.inquiry_product_links (inquiry_id, is_primary) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_product_links_one_primary
  ON public.inquiry_product_links (inquiry_id) WHERE is_primary;

ALTER TABLE public.inquiry_product_links ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 5. Inquiry-knowledge junction table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inquiry_knowledge_links (
  inquiry_id BIGINT NOT NULL REFERENCES public.inquiries(id) ON DELETE CASCADE,
  knowledge_article_id BIGINT NOT NULL REFERENCES public.knowledge_articles(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  link_source TEXT
    CHECK (link_source IN ('mail_integration_skill', 'operator', 'migration', 'unknown')),
  PRIMARY KEY (inquiry_id, knowledge_article_id)
);

ALTER TABLE public.inquiry_knowledge_links ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 6. Grants (worker_only access class)
--    Scoped workload roles are issued in a separate owner-reviewed migration before
--    production activation. Browser roles are denied even if project defaults change.
-- =============================================================================

REVOKE ALL ON TABLE public.inquiries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.knowledge_articles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_product_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inquiry_knowledge_links FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_articles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_product_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inquiry_knowledge_links TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.inquiries_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.knowledge_articles_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inquiry_product_links_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.inquiry_management_set_updated_at() FROM PUBLIC;
