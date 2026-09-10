# Phase 1 MVP: Baserow to Supabase Migration

**Status:** Approved scope — implementation pending  
**Date:** 2026-07-21  
**Owner:** `retailpulses/inquiry-automation`  
**Target:** Shared Retailpulses Supabase project  
**Production URL:** `https://ops.homesbliss.net/inquiry`

## 1. Decision

Phase 1 is a complete inquiry-domain cut-over from Baserow to Supabase, not a
long-lived bridge.

After production cut-over:

- Supabase is the only operational source of truth for inquiries and inquiry
  knowledge.
- Product reads use the existing Supabase product catalog. This repository does
  not create or maintain a second product table.
- No inquiry reader, writer, scheduled job, dashboard endpoint, enrichment
  script, follow-up skill, or fallback path may call Baserow.
- No inquiry-runtime configuration or secret may contain a Baserow inquiry,
  product, or knowledge table identifier or token.
- Baserow is not a rollback target. Application rollback continues to use
  Supabase.
- `baserow_row_id` may remain as immutable migration provenance. It is not a
  runtime dependency.

Baserow is permitted only during the bounded migration window as the one-time
source for extraction and reconciliation. Migration-only credentials and tools
must be removed or disabled after cut-over.

## 2. Phase 1 outcomes

Phase 1 is complete only when all of the following are true:

1. All inquiry records and required relationships are present in Supabase.
2. The React dashboard reads and writes through authenticated server-side APIs.
3. The canonical inquiry Worker classifies, links products, and drafts against
   Supabase.
4. `rp-mail-integration` creates and updates inquiries in Supabase and no longer
   reads inquiry products or knowledge from Baserow.
5. VPS browser enrichment writes to Supabase.
6. The Mercari inquiry follow-up skill uses the canonical inquiry model.
7. The existing Supabase `mercari_inquiries` data is consolidated into the
   canonical model and no longer remains an independent source of truth.
8. Inquiry-specific Baserow secrets, variables, adapters, fallback code, and
   scheduled paths are removed.
9. Two healthy scheduled Worker cycles complete after cut-over.

## 3. Explicitly deferred

The following are not part of Phase 1:

- Structured `inquiry_messages` normalization
- General-purpose event sourcing or an `inquiry_events` table
- Database-backed Worker cursor or runtime-log tables
- Database-backed enrichment-run history
- Moving templates or prompt versions out of Cloudflare KV
- Supabase Realtime subscriptions
- Direct browser access to Supabase
- Migrating the React UI into SvelteKit
- New analytics, SLA, assignment, or customer-history features
- Ticket-domain integration beyond preserving existing identifiers

Deferral must not create a Baserow dependency. Existing data needed by the MVP
is retained in canonical columns, relationship tables, or `extra` JSONB.

## 4. Systems in scope

The migration includes every current inquiry reader or writer, even when its
source code is outside this repository.

| System | Repository/location | Phase 1 responsibility |
|---|---|---|
| Inquiry automation Worker | `inquiry-automation/apps/worker` | Classify, link, draft, schedule |
| Inquiry dashboard API | `inquiry-automation/apps/dashboard/functions` | Operator reads and mutations |
| Inquiry dashboard UI | `inquiry-automation/apps/dashboard/src` | UI at `/inquiry` |
| Browser enrichment | `inquiry-automation/src/enrichment`, `scripts/enrich_*` | Mercari detail extraction |
| Mail ingestion and inquiry skill | `workers/packages/mail-integration` | Create/update inquiries and assisted drafts |
| Mercari follow-up skill | `skills/mercari-inquiry-follow-up` | Query, send, and record follow-ups |
| Existing minimal inquiry table | RPagentOS migration `20260718000003` | Consolidate into canonical inquiries |
| Governance registry | `rp-governance-kit` | Ownership, access, capability, workloads |

The retired Python classification/drafting pipeline is not a production target.
Any retired code that still imports the Baserow client must be removed from the
active tree or converted into a Supabase-only backfill/debug tool. Git history
is the archive.

## 5. Access and authentication

### 5.1 Database access class

Inquiry tables remain `worker_only`:

- Browsers do not receive Supabase credentials.
- Dashboard Pages Functions access Supabase server-side.
- Workers and VPS scripts use separately issued, workload-scoped credentials.
- RLS is enabled with no browser-visible policies.

Production must not use one unrestricted shared `service_role` key across every
workload when a scoped PostgREST/Postgres role can be issued. Required grants:

- Inquiry owner workloads: required CRUD on inquiry-owned objects only.
- Product access: read-only access to approved product catalog projections.
- Follow-up skill: bounded inquiry read and follow-up-status update capability.
- Migration job: temporary insert/upsert capability, revoked after cut-over.

Credential issuance and access paths must be registered before activation.

### 5.2 Operator authentication

`ops.homesbliss.net/inquiry*` must be protected by Cloudflare Access.

Dashboard APIs must independently validate the Access JWT, including issuer,
audience, expiry, and approved identity or group. The verified operator identity
must be available to mutation handlers. Authentication is not satisfied merely
because the hostname is described as an internal portal.

Mutation endpoints must be same-origin, reject unsupported methods and content
types, validate input, and apply CSRF protection if cookie-based application
sessions are later introduced.

## 6. Minimal Phase 1 data model

All objects must be schema-qualified consistently. The migration must decide
and document whether `inquiry_management` is a physical Postgres schema or an
organization governance domain mapped to `public`. It must not rely on an
implicit `search_path`.

### 6.1 `inquiries`

The canonical table must preserve fields consumed or written by current
production workloads.

Required column groups:

**Identity and provenance**

- `id`
- `baserow_row_id` — nullable, unique, migration provenance only
- `legacy_mercari_inquiries_id` — nullable, unique
- `source`
- `external_inquiry_id`
- `external_thread_id`
- `url`
- `shop_key`
- optional canonical `platform_account_id`

**Workflow state**

- `status`
- `automation_status`
- `follow_up_status`
- `inquiry_type`
- `deleted_at` for soft deletion

`status`, `automation_status`, and `follow_up_status` must remain separate.
Creating a draft must not mean that a customer reply was sent. Phase 1 should
use text plus CHECK constraints or lookup tables rather than hard-to-change
Postgres enums.

**Inquiry and customer data**

- `inquiry_date`
- `inquiry_body`
- `customer_nickname`
- `product_name_snapshot`
- `sender_email`
- `receiving_email`
- `last_inbound_time`
- `last_custom_message`
- `message_log_raw`
- `order_id`
- `seller`

**Draft and assisted-reply data**

- `draft_reply`
- `reply_strategy`
- `inquiry_skill_reply`
- `reply_drafted_at`
- `ai_copywritten_reply`
- `ai_copywritten_at`
- `reply_assist_status`
- `reply_assist_request_id`
- `reply_assist_last_result`

The legacy `AI Reply Copywrited` value must be migrated carefully because
current systems use it both as reply text and as a timestamp. The migration
must classify valid timestamps into `ai_copywritten_at`, preserve text in
`ai_copywritten_reply`, and report ambiguous values.

**Mercari enrichment and commercial snapshot data**

- `mercari_product_id`
- `mercari_variant_name`
- `units`
- `effective_price_excl_shipping`
- `effective_price_incl_shipping`
- `effective_tcogs`
- `expected_value`

The implementation must define whether commercial values are historical
snapshots or derived live values. The current dashboard expects `expected_value`
to change after `units` changes; that behavior must be implemented explicitly
in a view, RPC, or server-side calculation.

**Follow-up and compatibility data**

- `follow_up_sent_at`
- `notes`

**Operational metadata**

- `created_at`
- `updated_at` with a functioning update trigger or equivalent
- `extra JSONB NOT NULL DEFAULT '{}'`

Required idempotency constraints include:

- Unique non-null `baserow_row_id`
- Unique non-null `legacy_mercari_inquiries_id`
- A reviewed partial unique key for a stable external identity, preferably
  `(source, shop_key, external_inquiry_id)`

URL may be used for migration reconciliation but must not be assumed to be the
only durable external identifier without duplicate analysis.

### 6.2 `inquiry_product_links`

This table links inquiries to the existing Supabase product catalog. It must not
own product data.

Minimum fields:

- `inquiry_id`
- canonical `product_variant_id` where resolvable
- `item_code_snapshot`
- `product_name_snapshot`
- `is_primary`
- `linked_at`
- `link_source`
- optional confidence value

The migration must map Baserow product row IDs to canonical Supabase products
through `baserow_886994_compat_vw` or another owner-approved product projection.
Unresolved and ambiguous links must be reported, not silently discarded.

### 6.3 `knowledge_articles`

Knowledge must move to Supabase because `rp-mail-integration` currently reads it
when generating inquiry-skill replies.

Minimum fields:

- `id`
- `baserow_row_id` — unique migration provenance
- `title`
- `body`
- `active`
- `tag`
- `created_at`
- `updated_at`

### 6.4 `inquiry_knowledge_links`

Minimum fields:

- `inquiry_id`
- `knowledge_article_id`
- `linked_at`
- `link_source`
- primary key across the two IDs

### 6.5 Dashboard views

At most two dashboard views may be added:

- `inquiry_list_vw`
- `inquiry_detail_vw`

Views must use explicit schemas and grants. If any non-service role can query
them, use security-invoker behavior and test that the view cannot bypass the
underlying access policy.

### 6.6 Existing state stores retained

- Cloudflare Durable Object remains the Worker lock, cursor, and run-state
  store.
- Cloudflare logs/observability remain the Worker execution log.
- Cloudflare KV remains the message-template and prompt-version store.

These are retained because they are not Baserow dependencies and already serve
the required MVP behavior.

## 7. Search behavior

Japanese inquiry search must be validated using real Japanese samples.
`to_tsvector('simple', ...)` alone is not accepted as proof of useful Japanese
search.

Phase 1 should use an approved combination such as normalized `ILIKE` queries
with `pg_trgm` GIN indexes on the searched text fields. Query plans and latency
must be captured against representative data before production.

## 8. Existing `mercari_inquiries` consolidation

The RPagentOS-owned `mercari_inquiries` table must not remain an independent
operational table after Phase 1.

Required sequence:

1. Confirm hosted existence, row count, consumers, and whether it contains data
   not present in Baserow.
2. Resolve its missing or inconsistent governance registration.
3. Map its rows into canonical `inquiries` using external ID, shop, customer,
   item code, timestamps, and manual exception review.
4. Preserve `follow_up_sent_at` and notes.
5. Update `mercari-inquiry-follow-up` to the canonical inquiry API/table.
6. Verify all follow-up reads and writes.
7. Retire or rename the old table through a migration owned by RPagentOS.
8. If a temporary compatibility view is required, give it an explicit removal
   date and ensure it reads canonical inquiries only.

This is a coordinated ownership transfer. The inquiry repository cannot alter
an RPagentOS-owned object unilaterally.

## 9. Dashboard deployment

Phase 1 keeps the React dashboard as a separate Cloudflare Pages project.

Routing target:

```text
ops.homesbliss.net/inquiry/*      -> inquiry dashboard Pages project
ops.homesbliss.net/inquiry/api/*  -> inquiry dashboard Pages Functions
ops.homesbliss.net/*              -> existing ops portal
```

A Cloudflare Worker route or equivalent zone-level routing owns the path split.
The dashboard must build with `/inquiry/` as its asset base, and its API base
must be `/inquiry/api`.

Do not copy generated React `dist/` files into the ops-portal repository. Do not
move the UI to SvelteKit in Phase 1.

## 10. Implementation workstreams

Code and data preparation may run in parallel, but schema decisions, production
writes, and final cut-over remain centrally controlled.

### Workstream A — governance and schema

- Approve the physical schema/domain mapping.
- Register ownership, consumers, access paths, capabilities, and workloads.
- Add replayable migrations with governance headers.
- Add RLS, grants, constraints, indexes, updated-at behavior, and views.
- Generate field mapping and status mapping specifications.
- Test migration replay against local or shadow Supabase.

### Workstream B — canonical Worker

- Replace `apps/worker/src/clients/baserow.ts` with a Supabase adapter and
  repository interfaces.
- Query canonical inquiry columns and product catalog projections in bounded
  batches.
- Preserve Durable Object state.
- Add change-aware writes, idempotency, retry budgets, and dead-letter/error
  evidence.
- Add an automation write kill switch checked before every batch.
- Remove Baserow variables and secrets from Worker configuration.

### Workstream C — dashboard and authenticated API

- Replace Baserow dashboard Functions with Supabase repositories.
- Add Cloudflare Access JWT validation middleware.
- Preserve list, search, detail, status, product link/unlink, units, drafts,
  copywriting, templates, and prompt behavior.
- Move APIs under `/inquiry/api`.
- Add a mutation kill switch that leaves reads available.
- Deploy as a separate Pages project behind the `/inquiry/*` route.

### Workstream D — mail ingestion and inquiry skill

- Update `workers/packages/mail-integration` inquiry create/update paths to
  canonical Supabase writes.
- Preserve deduplication and latest-message ordering.
- Replace inquiry-specific product and knowledge Baserow reads with Supabase.
- Split copywritten reply text from copywritten timestamp semantics.
- Remove inquiry-domain Baserow table IDs, fallback paths, cache rebuild paths,
  and inquiry webhook assumptions.
- Add independent ingestion and assisted-draft write kill switches.

Other non-inquiry Baserow responsibilities in the mail-integration package are
outside this migration, but no inquiry execution path may depend on them.

### Workstream E — VPS browser enrichment and retired Python cleanup

- Replace enrichment Baserow reads/writes with canonical Supabase repository
  calls.
- Resolve product links through the canonical product catalog.
- Add scoped credentials, timeouts, bounded retries, SIGTERM handling, dry-run,
  and an enrichment write kill switch.
- Remove `src/baserow_client.py` and active imports once migration tooling is
  retired.
- Remove or convert retired Python scripts so the inquiry repository has no
  operational Baserow adapter or fallback.

### Workstream F — follow-up skill and legacy table

- Update the skill query, status update, and verification script to canonical
  inquiries.
- Preserve external-send safety and its already-purchased disclaimer.
- Keep database-write and external-message kill switches independent.
- Coordinate legacy-table retirement with RPagentOS.

### Workstream G — migration and reconciliation

- Produce a complete field inventory from live Baserow schema metadata.
- Extract inquiries, knowledge, and relationship IDs using cursor pagination.
- Import idempotently in bounded batches.
- Import existing Supabase `mercari_inquiries` rows.
- Produce machine-readable exception reports.
- Compare counts, stable identifiers, field hashes, relationship counts,
  timestamps, status mappings, and null/empty values.
- Remove migration-only credentials and disable migration tools after sign-off.

## 11. Cut-over strategy

### Gate 0 — inventory and contracts

- Complete the reader/writer inventory.
- Freeze the field and status mapping.
- Identify duplicate and missing external IDs.
- Confirm product-link mapping behavior.
- Confirm ownership approvals and scoped credentials.

### Gate 1 — local/shadow validation

- Replay migrations from zero.
- Run all unit and integration tests with external calls mocked.
- Backfill a shadow database from a sanitized or approved extract.
- Validate Japanese search and dashboard queries.

### Gate 2 — zero-write production shadow read

- New code reads production Supabase with mutations disabled.
- Compare results with Baserow without changing either system.
- Capture request counts, latency, errors, and mismatches.

### Gate 3 — bounded live canary

- Import at most the governance-approved canary size.
- Exercise explicit test/canary inquiry IDs only.
- Review metrics and reconciliation before proceeding.

### Gate 4 — initial full backfill

- Baserow remains authoritative.
- Run repeatable idempotent full backfill.
- Resolve all blocking exceptions.
- Stage every Supabase-based reader and writer with writes disabled.

### Gate 5 — controlled mutation freeze and final sync

1. Disable `rp-mail-integration` inquiry ingestion.
2. Disable inquiry classification/drafting cron.
3. Stop VPS enrichment.
4. Put dashboard mutations into read-only mode.
5. Stop follow-up database updates and external sends.
6. Run final idempotent reconciliation.
7. Verify counts, hashes, relationships, statuses, and recent timestamps.

### Gate 6 — Supabase activation

1. Activate Supabase mail ingestion.
2. Verify new inquiry creation and deduplication.
3. Activate canonical Worker writes.
4. Activate VPS enrichment.
5. Activate dashboard mutations.
6. Activate the updated follow-up skill.
7. Monitor error, retry, request, and write metrics.

### Gate 7 — decommission and closeout

- Remove inquiry-specific Baserow variables and secrets from Cloudflare and VPS.
- Remove inquiry Baserow adapters and fallback branches.
- Disable Baserow inquiry webhooks, scheduled paths, and cache rebuild paths.
- Remove migration-only Baserow credentials and tooling.
- Mark Baserow inquiry, product, and knowledge tables as retired; they are not a
  production fallback.
- Run repository-wide and cross-repository static checks for forbidden inquiry
  Baserow references.
- Complete two healthy unattended Worker cycles.
- Capture final governance evidence and close the migration issue.

## 12. Rollback and recovery

There is no rollback to Baserow after Gate 6.

Supported recovery actions are:

- Disable the affected Supabase writer with its workload-specific kill switch.
- Keep dashboard reads available where safe.
- Roll back the application deployment while retaining Supabase as the database.
- Replay an idempotent batch from recorded input or dead-letter evidence.
- Restore Supabase from its approved backup/PITR mechanism for database-level
  corruption, following incident procedures.

Before Gate 6, Baserow remains authoritative and the cut-over may be aborted.
After Gate 6, any reverse synchronization to Baserow is prohibited unless a new
incident-specific plan is explicitly approved.

## 13. Governance workload classification

| Workload | Default risk | Required treatment |
|---|---|---|
| Baserow/Supabase historical backfill | High | Full high-risk rollout and evidence |
| Final reconciliation | High | Manual, monitored, bounded batches |
| Mail inquiry ingestion | Medium scheduled sync | High-risk gates because it is a new production write path |
| Classification/product-link cron | Medium scheduled/agent | High-risk gates because it is a new production write path |
| LLM draft writer | Medium agent operation | High-risk gates because it is a new production write path |
| VPS browser enrichment | Medium-to-High sync | High-risk gates and durable error evidence |
| Follow-up skill | High | Database writes plus external customer messages |
| Operator edits | Bounded interactive writes | Auth, validation, audit identity, code review |
| Hard delete | Prohibited in MVP | Use `deleted_at` soft deletion |

Each declaration must include volume, concurrency, timeout, bounded jittered
retries, request budget, cursor/batch strategy, dead-letter mechanism, kill
switch, monitoring, dry-run result, and deployed commit or release.

## 14. Kill switches

Required independent controls:

- `INQUIRY_INGEST_WRITES_ENABLED`
- `INQUIRY_AUTOMATION_WRITES_ENABLED`
- `INQUIRY_ENRICHMENT_WRITES_ENABLED`
- `INQUIRY_DASHBOARD_MUTATIONS_ENABLED`
- `INQUIRY_FOLLOWUP_DB_WRITES_ENABLED`
- `INQUIRY_EXTERNAL_SEND_ENABLED`

Worker switches must be checked before each batch and paired with cron disable or
rollback-deploy procedures. VPS workloads must support SIGTERM between rows or
batches. Database sessions must be attributable to a workload so a precise
session termination or scoped-role revocation can be used in an emergency.

## 15. Validation matrix

### Schema and migration

- Migrations replay from zero.
- All objects are in the intended schema.
- RLS and grants match declared access.
- Unique and foreign-key constraints reject invalid data.
- `updated_at` changes on update.
- Backfill is idempotent.

### Data

- Inquiry source/target counts reconcile.
- Every Baserow inquiry has exactly one canonical mapping or an approved
  exception.
- Every existing `mercari_inquiries` row has a canonical mapping or an approved
  exception.
- Product and knowledge link counts reconcile.
- Ambiguous AI copywrite values are reported.
- Commercial-value behavior matches the dashboard contract.

### Runtime

- Mail ingestion creates and updates canonical inquiries idempotently.
- Worker classification, product matching, and drafting are change-aware.
- Dashboard list/detail/search and all mutations work under Access auth.
- VPS enrichment writes all four required Mercari enrichment fields.
- Follow-up reads, writes, verification, and external-send controls work.
- Kill switches are tested without disabling unrelated workloads.

### Zero-Baserow acceptance

After migration tooling is retired:

- No code in `inquiry-automation` imports a Baserow client.
- No inquiry path in `workers/packages/mail-integration` accesses Baserow tables
  `886975`, `886994`, or `897440`.
- No follow-up skill path accesses Baserow.
- No inquiry deployment contains `BASEROW_*` inquiry variables or secrets.
- No active documentation instructs operators to run inquiry workflows against
  Baserow.
- Network/observability evidence for two scheduled cycles shows zero inquiry
  requests to `api.baserow.io`.

Historical migration notes may mention Baserow, and canonical rows may retain
`baserow_row_id`; neither is an operational dependency.

## 16. Definition of done

Phase 1 is done when:

1. Governance changes are approved.
2. Schema and data validation pass.
3. Every listed system uses Supabase for inquiry operations.
4. The authenticated dashboard is live at `/inquiry`.
5. All workload kill switches are tested.
6. The legacy `mercari_inquiries` source is retired or reduced to a dated
   read-only compatibility view over canonical data.
7. Inquiry-specific Baserow credentials, adapters, fallbacks, and schedules are
   removed.
8. Two healthy scheduled cycles complete with retained evidence.
9. No unresolved data-loss, duplicate, security, or governance blocker remains.

