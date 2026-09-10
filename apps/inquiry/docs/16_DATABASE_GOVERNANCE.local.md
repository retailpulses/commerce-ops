# Database Governance — Local Declaration

Repository: `retailpulses/inquiry-automation`  
Canonical policy reviewed: `v1.6.0`  
Database environment: shared Supabase project; local/disposable shadow for development

## Repository role

- Supabase consumer: yes
- Migration owner: yes
- Owned domain: `inquiry_management`
- Access class: `worker_only`
- Hosted-write authority: Retailpulses owner; no agent self-approval

Owned Phase 1 objects:

- Tables: `inquiries`, `inquiry_product_links`, `knowledge_articles`, `inquiry_knowledge_links`
- Views: `inquiry_list_vw`, `inquiry_detail_vw`
- Function: `inquiry_management_set_updated_at()`
- Triggers: `trg_inquiries_updated_at`, `trg_knowledge_articles_updated_at`

API-first expansion under Architecture Change Issue #92:

- Table extension: `inquiries` platform target/status/readback and single follow-up-cycle fields
- Tables: `inquiry_messages`, `inquiry_webhook_events`, `inquiry_ingestion_runs`, `inquiry_quarantine`, `inquiry_outbound_operations`, `inquiry_follow_up_events`
- Views: `inquiry_message_timeline_vw`, `follow_up_review_queue_vw`, `follow_up_upcoming_vw`, `follow_up_history_vw`
- Functions: `inquiry_claim_outbound_cycle`, `inquiry_finalize_outbound`, `inquiry_schedule_follow_up`, `inquiry_claim_webhook_event`, `inquiry_complete_webhook_event`, `inquiry_apply_platform_transition`
- Access class remains `worker_only`; browser roles are revoked and only server-side service-role consumers receive grants

Consumed RPagentOS-owned `product_catalog` objects:

- `product_variants` — temporary migration resolution and approved runtime projection source
- `platform_accounts` — optional UUID foreign key

The migration set does not replay independently without those two owner-domain tables.
Stage C therefore replays against a disposable database bootstrapped from the actual
RPagentOS owner migrations. It must not create substitute production product tables.

## Generated types

Temporary documented exemption: this repository uses narrow, hand-typed raw PostgREST
DTOs rather than `supabase-js`. Contract tests assert the actual local PostgREST schema
and UUID shapes. Revisit generated shared types before expanding beyond the Phase 1 DTOs.

## Database-writing workloads

Canonical registry changes are tracked in the companion governance PR. Local source
inventory is [`SYNC_JOB_INVENTORY.md`](SYNC_JOB_INVENTORY.md).

| Workload ID | Category | Risk | Trigger | Access path | Kill switch |
|---|---|---:|---|---|---|
| `inquiry_historical_migration` | backfill | high | manual, one-time | PostgREST, temporary migration credential | SIGINT/process cancel; no scheduled trigger |
| `inquiry_automation_worker` | scheduled job + agent operation | high | Cloudflare cron | PostgREST, write-scoped | `INQUIRY_AUTOMATION_WRITES_ENABLED` |
| `inquiry_dashboard_mutations` | interactive writes | high for new-path rollout | operator | PostgREST, write-scoped Pages Function | `INQUIRY_DASHBOARD_MUTATIONS_ENABLED` |
| `inquiry_vps_enrichment` | sync | high | bounded manual/scheduler | PostgREST, write-scoped | `INQUIRY_ENRICHMENT_WRITES_ENABLED` + SIGTERM |
| `inquiry_mercari_webhook_ingestion` | pull / internal write | medium | Mercari webhook + bounded async processor | Cloudflare Worker → PostgREST; Mercari readback via fixed-egress relay | `INQUIRY_MERCARI_INGEST_WRITES_ENABLED` |
| `inquiry_mercari_daily_completeness_audit` | reconcile / internal write | medium | daily `0 16 * * *` UTC | Cloudflare Worker → Mercari relay + PostgREST | `INQUIRY_COMPLETENESS_AUDIT_WRITES_ENABLED` |
| `inquiry_operator_send` | push / external write | high | authenticated operator click | Pages Function → Mercari relay + atomic PostgREST RPC | `INQUIRY_OUTBOUND_SEND_ENABLED` |

The API-first workloads are implemented locally but remain inactive until the schema,
secrets, webhook contract, canary, and single-writer cutover gates in Issue #92 pass.
Their retry/concurrency/idempotency/readback contracts are declared in
`docs/SYNC_JOB_INVENTORY.md` and the bounded Phase document.

The migration workload uses 50-row write batches, bounded 50-value lookup batches,
60-second HTTP timeouts, idempotent provenance keys, and machine-readable reconciliation.
Production volumes, retries, monitoring thresholds, scoped credential issuance, dry-run
evidence, canary approval, and deployed commit must be completed at the production gate.

## Local Stage C replay

The committed assertions are in `tests/stage_c/schema_contract.sql`; deterministic source
fixtures are in `tests/fixtures/migration/`. Validation must use a disposable database and
must not run against hosted Supabase without explicit approval.
