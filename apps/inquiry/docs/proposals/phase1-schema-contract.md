# Phase 1 Schema Contract

**Frozen:** 2026-07-21
**Lead agent:** Jim Yang + Claude
**Status:** Stage B — local implementation

## Physical Schema Decision

`inquiry_management` is a **governance domain**, not a physical Postgres schema. All tables live in the `public` schema alongside existing RPagentOS-owned tables (`product_catalog`, `ticketing`, etc.). This avoids `search_path` complexity while maintaining clear governance boundaries through the ownership registry.

## Migration Files

| Migration | Contents |
|-----------|----------|
| `20260721000000_create_inquiry_management_core.sql` | Four MVP tables: `inquiries`, `inquiry_product_links`, `knowledge_articles`, `inquiry_knowledge_links`; plus checks, indexes, RLS, grants, and an inquiry-owned updated-at function |
| `20260721000001_create_inquiry_views.sql` | `inquiry_list_vw`, `inquiry_detail_vw` |

## Status Model

Three independent dimensions with TEXT + CHECK constraints. Lookup tables are deferred to avoid expanding the Phase 1 object set:

| Dimension | Values | Writers |
|-----------|--------|---------|
| `status` | received, followed_up, answered, closed_won, closed_lose | Dashboard (operator), mail ingestion (new inquiry→received), confirmed send/receipt paths |
| `automation_status` | new, classified, product_linked, drafted, copywritten, failed | Worker (pipeline progress) |
| `follow_up_status` | open, followed_up, do_not_follow_up | Follow-up skill |

Creating a draft updates only `automation_status`; it never marks the conversation `answered`.

## Field Groups

### Identity and provenance (8 columns)
`id`, `baserow_row_id`, `legacy_mercari_inquiries_id`, `source`, `external_inquiry_id`, `external_thread_id`, `url`, `shop_key`, `platform_account_id`

### Workflow state (5 columns)
`status`, `automation_status`, `follow_up_status`, `inquiry_type`, `deleted_at`

### Inquiry and customer data (11 columns)
`inquiry_date`, `inquiry_body`, `customer_nickname`, `product_name_snapshot`, `sender_email`, `receiving_email`, `last_inbound_time`, `last_custom_message`, `message_log_raw`, `order_id`, `seller`

### Draft and assisted-reply (9 columns)
`draft_reply`, `reply_strategy`, `inquiry_skill_reply`, `reply_drafted_at`, `ai_copywritten_reply`, `ai_copywritten_at`, `reply_assist_status`, `reply_assist_request_id`, `reply_assist_last_result`

### Mercari enrichment and commercial (8 columns)
`mercari_product_id`, `mercari_variant_name`, `units`, `effective_price_excl_shipping`, `effective_price_incl_shipping`, `effective_tcogs`, `expected_value`

### Follow-up and compatibility (2 columns)
`follow_up_sent_at`, `notes`

### Operational (3 columns)
`extra` (JSONB), `created_at`, `updated_at`

## Idempotency Constraints

1. `baserow_row_id` UNIQUE (nullable)
2. `legacy_mercari_inquiries_id` UNIQUE (nullable)
3. `(source, shop_key, external_inquiry_id)` partial unique index (where all three non-null)

## Access Class

`worker_only` — RLS enabled, no browser-visible policies. Service-role bypass is by design. Scoped PostgREST roles to be issued per-workload before production activation.

## Product Reads

Inquiries reference products via nullable UUID `inquiry_product_links.product_variant_id` (FK to RPagentOS-owned `public.product_variants.id`). An identity link key permits unresolved migration links to retain `item_code_snapshot` without inventing a product ID. Product reads for Worker and Dashboard go through approved Supabase product catalog views/projections. This repo does not create a product mirror.

## Deferred to Phase 2

- `inquiry_messages` (structured message log)
- `inquiry_events` (audit trail)
- `inquiry_enrichment_runs`
- `accounts` table (shop configuration)
- `cursor_state`, `runtime_logs` in Supabase (DO/KV retained)
- `message_templates` in Supabase (KV retained)
- Supabase Realtime subscriptions
- Direct browser access to Supabase

## AI Reply Copywrited Migration Rule

Migration must classify legacy `AI Reply Copywrited` values:
- ISO 8601 pattern → `ai_copywritten_at`
- Japanese text (greeting patterns) → `ai_copywritten_reply`
- Ambiguous → report as exception, store in `extra` JSONB
