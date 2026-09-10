# Database Governance — Local Declaration

Repository: retailpulses/ticket-handling
Installed governance ref: main
Last updated: 2026-08-29

## Repository Role

- **Supabase consumer:** yes
- **Migration owner:** yes

## Owned Domains

- `ticketing` — ticket_issue_types, tickets, ticket_products, ticket_messages, ticket_notes, ticket_attachments, ticket_events, ticket_resolution_actions, ticket_statuses, message_drafts, sent_messages, copywriting_logs, customer_submissions, submission_tokens, inbound_ticket_messages, ticket_share_tokens, ticket_share_attachments, rakuten_rmesse_inquiries, rakuten_rmesse_sync_state, and associated functions/triggers

## Consumed Shared Domains

- `product_catalog` (owned by RPagentOS) — products, product_variants, platform_listings, platform_listing_skus, platform_accounts (ticket association and seller-share snapshots)
- `project_management` (owned by RPagentOS) — projects, project_attachments
- `listing_quality` (owned by RPagentOS) — listing_review_schedule_status_v1 view
- `task_management` (owned by RPagentOS) — tasks (for ticket linking)

## Generated Types

**Exempt.** The Worker is the sole Supabase client. Types are generated from API route signatures, not from the database schema directly.

## Deployment Authority

Hosted writes require explicit approval. See `docs/DATABASE_GOVERNANCE.md` in rp-governance-kit §6.

## Database Environment Model

**Shared.** Multiple repositories connect to one hosted Supabase project. Production and staging are not yet separated (documented technical debt).

## Database-Writing Workloads

### `ticket_form_legacy_backfill_20260730`

- **Category:** backfills
- **Risk level:** medium
- **Trigger:** one-off manual execution
- **Kill switch:** terminate `scripts/migrate_baserow_ticket_pipeline.py`; rerun is idempotent
- **Approval:** operator request on 2026-07-30
- **Workload declaration reference:** GitHub Issue #177
- **Access path:** postgrest plus private Supabase Storage
- **Bounds:** forms-only reconciliation; cumulative bounded delta is two `customer_submissions`, three new `ticket_attachments`, 62 existing form-attachment link repairs, and 76 idempotent `ticket_events`; no Baserow, ticket, product, schema, or migration writes
- **Retries:** maximum five attempts with exponential backoff for transient HTTP failures
- **Observability:** gitignored source snapshot and reconciliation report with source counts, write/result counts, and source SHA-256

### `ticket_share_event_api`

- **Category:** agent_operations
- **Risk level:** medium
- **Trigger:** event-driven operator create/rotate/revoke and seller page resolve
- **Kill switch:** set Worker `ENABLE_TICKET_SHARES=false`; the public viewer then fails closed
- **Approval:** GitHub Issue #151
- **Workload declaration reference:** GitHub Issue #151; canonical registry entry required before production enablement
- **Access path:** postgrest (Worker-only Supabase client and RPCs)
- **Bounds:** one ticket/share transaction per operator request; maximum 52 written rows, six PostgREST requests, one concurrent connection, and 5-second statement timeout target; one access-counter update per successful page resolve; no bulk loop
- **Retries:** client operation UUID makes create/rotate retries idempotent; no automatic unbounded retry
- **Observability:** aggregate create/rotate/revoke/resolve failures and access counts without logging tokens or share URLs

### `ordermgmt_webhook_forwarding`

- **Category:** agent_operations
- **Risk level:** low
- **Trigger:** event-driven (webhook handler `ctx.waitUntil`) plus cron sweep (4x daily JST) for rows stuck in `not_forwarded`
- **Kill switch:** unset Worker `ORDERMGMT_WEBHOOK_ENDPOINT` and `ORDERMGMT_WEBHOOK_FORWARD_SECRET`; forwarding then no-ops (rows stay `not_forwarded`, enrichment unaffected)
- **Approval:** GitHub Issue #131
- **Workload declaration reference:** GitHub Issue #131; OrderMgmt consuming endpoint `docs/webhook/webhook-architecture-adr.md`
- **Access path:** postgrest (Worker service-role client) plus outbound POST to OrderMgmt Worker endpoint
- **Bounds:** one event per inbound row; `forwarding_status` transitions `not_forwarded → forwarded|failed`; attempts capped by `ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS` (default 5); cron claim limited to 10 rows/run within a 3-day lookback; payload is the raw event contract (topic, shop_id, order_transaction_id, created_at) only
- **Retries:** bounded by the attempts cap; 2xx (including OrderMgmt duplicate) is success; 4xx contract failures are terminal; 5xx/429/network are retryable
- **Observability:** `forwarding_status`, `forwarding_attempts`, `forwarded_at`, `forward_error`, `last_forward_attempt_at` on `inbound_ticket_messages`; secret is header-only and never logged or persisted

### `ticketing_rakuten_rmesse_sync`

- **Category:** scheduled_jobs
- **Risk level:** medium
- **Trigger:** Cloudflare cron every two minutes; operator-triggered shadow run
- **Kill switch:** set `RAKUTEN_RMESSE_INGESTION_MODE=off`; outbound is independently controlled by `RAKUTEN_RMESSE_OUTBOUND_ENABLED=false`
- **Approval:** architecture and initial activation approved on 2026-08-23;
  order-qualified automatic ticket creation, hosted migration, and production
  activation explicitly approved by the operator on 2026-08-29
- **Workload declaration reference:** GitHub Issue #192; canonical registry entry in `retailpulses/rp-governance-kit` PR #48
- **Access path:** fixed-egress OrderMgmt relay to official RMS InquiryManagementAPI; ticketing Worker service-role RPC to owned ticketing objects
- **Bounds:** discovery is capped at 20 pages x 100 inquiry summaries per invocation; direct-detail reconciliation is oldest-first and capped by `RAKUTEN_RMESSE_RECONCILIATION_LIMIT` (production default 25) with a minimum two-minute interval; one concurrency path; at most one active/new-workflow Ticket per exact `(platform, account, order)`; no pre-sale content is persisted; each attachment is downloaded once per reference upgrade, capped at 20 MiB, image MIME/signature validated, and written to a content-hash private Storage path
- **Retries:** no in-invocation blind send retry; failed pull retains the prior cursor; native reply IDs and transactional RPC make overlap replay-safe
- **Observability:** discovery scanned/order-qualified/excluded/page counts plus reconciliation candidate/fetched/error counts, detail fetch, created-ticket, inserted-message, attachment stored/error counts, and last successful cursor; message bodies, filenames, paths, bytes, and customer PII are excluded from logs
- **Supabase read egress:** stable client identity `ticketing_rakuten_rmesse_sync`; projection `account_id,inquiry_number,shop_id,order_number,last_ingested_at`; oldest-first incremental cursor with limit 25; measured current response approximately 1.4 KB/invocation and projected approximately 1.0 MB/day; warning at 10 MB/day, critical at 50 MB/day
- **Attachment read egress:** exact-row projection `ticket_attachments(id,metadata)` by ticket ID, reference bucket, and deterministic reference path; no added scan or pagination; measured under 1 KB per new attachment and included in the same 10 MB/day warning and 50 MB/day critical thresholds

### `ticketing_amazon_zoho_mail_sync`

- **Category:** scheduled_jobs
- **Risk level:** high (new production write path with external mail reads and operator-triggered customer sends)
- **Trigger:** bounded Cloudflare cron for inbound sync; authenticated operator action only for outbound reply
- **Kill switch:** `AMAZON_MAIL_INGESTION_MODE=off`; attachment download and outbound independently default to `AMAZON_MAIL_ATTACHMENTS_ENABLED=false` and `AMAZON_MAIL_OUTBOUND_ENABLED=false`
- **Approval:** architecture and implementation requested in GitHub Issue #235; hosted migration, bounded write canary, scheduled activation, and each initial real reply remain separately gated
- **Workload declaration reference:** GitHub Issue #235; canonical registry entry required before production activation
- **Access path:** Zoho Mail REST API plus Worker service-role PostgREST/RPC access to Ticket Handling-owned objects; OrderMgmt context only through its approved read-only internal API
- **Bounds:** one provider account/folder; one UTC date segment and at most 20 pages x 100 metadata rows per invocation; frozen `window_start/run_to`; a full page 20 fails the segment closed; 15-minute overlap; oldest-first reconciliation; attachment bytes are not downloaded before a valid ticket parent exists; at most 25 messages x five supported images x 10 MiB, followed by one transactional bulk finalize; one concurrency path
- **Retries:** source rows and deterministic attachment paths are idempotent; attachment references are capped at three cross-invocation retries (four total attempts) with bounded exponential delay and jitter; ambiguous outbound submissions reconcile against the persisted pre-send baseline before any further mutation and are never blindly resent
- **Observability:** requests by operation, pages, rows discovered/persisted/deduplicated/failed, attachment metadata/stored/rejected counts, response bytes, retries, dead letters, runtime, and checkpoint outcome; no body, subject, address, filename, path, byte content, OAuth token, or full order number in logs
- **Supabase read egress:** stable client identity `ticketing_amazon_zoho_mail_sync`; explicit sync-state/inbound projections; cursor/frozen-window paging; provisional warning at 10 MB/day and critical at 50 MB/day until two shadow cycles provide measured budgets
- **Release mapping:** production activation must record the reviewed merge SHA or immutable release SHA in Issue #235 and the central workload registry

### Amazon Zoho buyer-message workloads

- **Workload IDs:** `ticketing_amazon_zoho_mail_sync`, `ticketing_amazon_zoho_attachment_reconciliation`, `ticketing_amazon_zoho_outbound_reply`
- **Category / risk:** scheduled sync, scheduled attachment reconciliation, and operator event; all `high`
- **Triggers:** Cloudflare cron/manual sync and authenticated Portal send
- **Kill switches:** `AMAZON_MAIL_INGESTION_MODE=off`, `AMAZON_MAIL_ATTACHMENTS_ENABLED=false`, `AMAZON_MAIL_OUTBOUND_ENABLED=false`
- **Approval:** pending the independent rollout approvals recorded in GitHub Issue #235
- **Canonical declaration:** `retailpulses/rp-governance-kit` PR #73
- **Local inventory:** `docs/SYNC_JOB_INVENTORY.md`
- **Access path:** Worker-only service-role PostgREST/RPC plus private `ticket-attachments` Storage
- **Bounds and observability:** see the local inventory and central workload registry; customer content, addresses, filenames and credentials are excluded from logs

## Supabase CLI Version

- Local (Homebrew): `2.109.1`
- CI: `2.109.1` (`npx supabase@2.109.1` in `.github/workflows/deploy.yml`)

## Known Technical Debt

- 18 zero-byte `_remote.sql` files for RPagentOS-authored migrations on the shared database
- Mixed migration naming: sequential (`0001_`, `0002_`) grandfathered alongside timestamps
- Duplicate migrations `20260708000002` and `20260708000003` exist in both this repo and RPagentOS
- Timestamp collision `20260710000000` with OrderMgmt (different SQL)
