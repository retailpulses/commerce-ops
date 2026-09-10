# Database Governance — Local Declaration

Repository: retailpulses/OrderMgmt
Installed governance ref: 8e9361eaea4cd8bcfa88a24b80485694279edf37
Last updated: 2026-09-07

## Repository Role

- **Supabase consumer:** yes
- **Migration owner:** yes

## Owned Domains

- `order_management` — sales_orders, giga_shipment_projections, sales_order_message_state, order_message_templates, pipeline_run_log, payment_reminders, idempotency_guards, order_management_message_webhook_event, pipeline_orchestration_runs, pipeline_steps, order_orchestrator_lease, order_lifecycle_watermarks, external_operation_attempts, external_operation_resolutions, order_scheduler_ownership, order_scheduler_ownership_events, and associated RPCs/triggers/policies

## Consumed Shared Domains

- `product_catalog` (owner: RPagentOS) — existing product context reads support portal display and margin computation. Operator writes are limited to `product_commercials.manual_cost_price`, `manual_presale_arrival_date`, and `presale_info_protect_until` through the RPagentOS owner API with a dedicated server-side token; OrderMgmt performs no direct product-catalog writes. Effective-value calculation remains owner-controlled.

## Generated Types

**Exempt.** The Worker is the sole Supabase client. Types are generated from API route signatures.

## Deployment Authority

Hosted writes require explicit approval. See `docs/DATABASE_GOVERNANCE.md` in rp-governance-kit §6.

## Database Environment Model

**Shared.** Multiple repositories connect to one hosted Supabase project. Production and staging are not yet separated (documented technical debt).

## Supabase CLI Version

- Local (Homebrew): `2.109.1` (verified 2026-07-15)
- CI: not yet pinned — record when configured

## Known Technical Debt

- Timestamp collision `20260710000000` with ticket-handling (different SQL — real collision)
- RLS policies use operator-read pattern; Worker uses service_role for writes

## Workload Declaration

| Workload ID | Category | Risk | Trigger | Kill-switch | Approval |
|---|---|---|---|---|---|
| `ordermgmt_mercari_message_sync` | scheduled_jobs | Medium | `3,13,23,33,43,53 * * * *` (cron) | Remove from SCHEDULED_CRON_MODES | Issue #131 |
| `ordermgmt_manual_product_overrides` | agent_operations | Medium | Authenticated operator event | Remove `ORDERMGMT_CATALOG_API_TOKEN` from the RPagentOS owner API or roll back Portal | Issue #174 / rp-governance-kit#39 |
| `ordermgmt_canonical_orchestrator` | scheduled_jobs | High | Target VPS systemd timer; shadow first; live per capability only | Disable the exact `ORCHESTRATOR_ENABLE_*` capability flag and timer | Issue #265 strategy implementation |
| `ordermgmt_external_operation_resolution` | agent_operations | High | Manual, one exact operation | Remove service-role credential from operator environment / revoke RPC execute | Issue #265 strategy implementation |
| `ordermgmt_scheduler_ownership` | agent_operations | High | Manual, one exact workload, default dry-run | Remove service-role credential from operator environment / revoke RPC execute | Issue #265 strategy implementation |

`ordermgmt_mercari_message_sync` also runs webhook-event retry as an internal behavior of the same phase (Issue #131): `retryStuckWebhookEvents` claims and re-processes stuck `order_management_message_webhook_event` rows after `syncMercariMessages`, gated by `WEBHOOK_INTAKE_ENABLED`. It is not a separate workload.

All other workloads are declared in `docs/SYNC_JOB_INVENTORY.md` and registered in the canonical `DATABASE_WORKLOADS.yaml` in `rp-governance-kit`.

`ordermgmt_canonical_orchestrator`,
`ordermgmt_external_operation_resolution`, and
`ordermgmt_scheduler_ownership` are prepared on the local
`rp-governance-kit` branch `codex/ordermgmt-pipeline-governance`, together with
the complete OrderMgmt ownership-object additions. They are not merged into
the central registry and therefore are not current production governance
facts. Central review and merge are required before production activation;
this does not block branch development or review under the central governance
gate model.

## Egress Measurement Contract

Scheduled pipeline phases set `x-client-info` to
`ordermgmt/<phase>/<release_version>`. Each phase records requests, successful
and failed responses, returned rows, `Content-Length` response bytes when the
header is available, and decoded JSON bytes for adapter list reads. These are
separate metrics: decoded JSON size is an attribution estimate and must not be
reported as Supabase billing-meter egress.

The phase snapshot is emitted as structured `supabase_egress` log output and
persisted under `pipeline_run_log.result_counts.egress`. Per-run and per-day
budgets remain `measurement_required` until a representative production window
is reconciled against Supabase organization Billing/Usage. No budget is to be
invented from request counts alone.

Issue #265 rollout uses explicit-column projections for the new control-plane,
freshness, ownership and ledger reads; generic list reads paginate at 1,000 rows,
the Portal control-plane caps each collection at 5,000 rows, and exact canaries
are single-order scoped. Until the first shadow baseline is measured, both
per-invocation and projected-daily bytes remain `measurement_required`. Reaching
80% of the measured daily budget is a warning that pauses rollout expansion;
100%, a missing bound/pagination contract, or missing measurement is critical
and blocks VPS ownership acquisition.

## Migrations

| Migration | Tables/Columns | Date |
|---|---|---|
| `20260710000000_order_mgmt_core.sql` | sales_orders, giga_shipment_projections, sales_order_message_state, order_message_templates, pipeline_run_log | 2026-07-10 |
| `20260713000000_add_buyer_message_columns.sql` | sales_orders.latest_buyer_message_id, message_last_synced_at; sales_order_message_state message columns | 2026-07-13 |
| `20260728012328_add_idempotency_guards.sql` | idempotency_guards | 2026-07-28 |
| `20260804000000_order_mgmt_webhook_event.sql` | order_management_message_webhook_event; sales_order_message_state webhook columns | 2026-08-04 |
| `20260815120000_add_canceled_review_status.sql` | sales_orders.review_status CHECK constraint (adds CANCELED); public.set_order_review_status(...) RPC (7-arg, 5 guards, order-scoped advisory lock) | 2026-08-16 |
| `20260826014226_add_payment_method.sql` | sales_orders.payment_method | 2026-08-26 |
| `20260826091000_add_cancellation_reason.sql` | sales_orders.cancellation_reason; public.cancel_order_with_reason(...) RPC | 2026-08-26 |
| `20260830021246_add_rakuten_status_audit.sql` | sales_orders.rakuten_order_progress, rakuten_status_mapping_state, rakuten_order_progress_observed_at | 2026-08-30 |
| `20260907090000_add_lifecycle_freshness_watermarks.sql` | order_lifecycle_watermarks; Mercari and Rakuten order-scoped lifecycle CAS RPCs; explicit payment reminder delivery state | 2026-09-07 |
| `20260907100000_add_orchestrator_control_plane.sql` | pipeline_orchestration_runs, pipeline_steps, order_orchestrator_lease; lease acquire/heartbeat/release RPCs | 2026-09-07 |
| `20260907110000_add_external_operation_ledger.sql` | external_operation_attempts; service-role-only claim/finalize RPCs | 2026-09-07 |
| `20260907151000_add_external_operation_resolution.sql` | external_operation_resolutions; service-role-only evidence-gated resolution RPC | 2026-09-07 |
| `20260907152000_allow_evidence_to_override_operation_failure.sql` | forward correction: authoritative applied evidence may supersede earlier definitive-failure classification | 2026-09-07 |
| `20260907153000_add_atomic_rakuten_close_completion.sql` | order-scoped CAS/RPC for atomic multi-line Rakuten close completion and readback | 2026-09-07 |
| `20260907154000_add_atomic_mercari_close_completion.sql` | store/order-scoped RPC for atomic Mercari terminal and tracking persistence | 2026-09-07 |
| `20260907155000_add_scheduler_ownership_registry.sql` | expiring per-workload scheduler ownership, immutable events, read-only service-role table grants and sole evidence/CAS write RPC | 2026-09-07 |
