# Sync Job Inventory — OrderMgmt

Baseline status: **reconstructed; bounded runtime evidence added**
Last runtime verification: **2026-09-07 22:39 JST** — Cloudflare remains the business scheduler owner with the previously read-back 13 cron expressions. VPS release `37b1e7513b978298949b9cc5249bac0eb82ae603` is installed and its canonical hourly timer is enabled in shadow mode; run `run_1788788321770_t5jic55j` passed 17-step acceptance. All live capability flags remain false, no VPS business ownership was acquired, and all 16 legacy `pipeline-*` timers remain disabled. The sales-brief timer remains the separately observed reporting owner.
Inventory owner: **OrderMgmt repo (retailpulses/OrderMgmt)**

## Accepted Target Direction

The canonical target architecture is defined in
`docs/trd/order-pipeline-orchestration-strategy.md` (accepted 2026-09-07;
shadow implementation present but not deployed). It replaces the current
multi-scheduler intent with one VPS-started OrderMgmt orchestrator, durable
dependency/freshness evidence, and one scheduler owner per workload.
Run `npm run audit:strategy-readiness` for repository-local structural evidence;
its `strategy_complete=false` result remains authoritative until every listed
external runtime gate is proven by dated readback.
Local 61-order fixtures prove that auto-approval and Rakuten confirmation do
not inherit the legacy 50-candidate cap under canonical live `limit=null`;
provider pagination and deployed scale remain acceptance gates.

The branch also contains an authenticated operator projection at
`GET /order/api/portal/control-plane` and a Portal Pipeline Health view. It is
not deployed. Only a matching live run plus active database lease can prove
transient VPS production execution; a shadow lease cannot. The target owner,
Portal-process live-enable flag, or latest run alone never proves current
ownership or Cloudflare trigger retirement. Backlog reads are bounded and
surface truncation.

The target orchestrator phase contract uses `null` for full live accounting and
positive integers only for bounded shadow/canary execution. `0` is prohibited
at that boundary because legacy workloads gave it conflicting meanings. This
contract is branch-only and has not been scale-tested in production.

The branch DAG now separates Mercari and Rakuten dependency chains, message
ingestion, payment reminders, and a terminal read-only integrity audit. A
failure blocks only declared descendants. Reporting remains the single VPS
fresh-snapshot consumer. Rakuten close is represented after Rakuten tracking in
the DAG, but its dedicated live flag remains default-off and it cannot execute
without exact ownership plus an approved external-contract canary.

Each durable DAG step stores per-phase completion state and allowlisted
aggregate counts. It never stores per-order result arrays or customer/provider
payloads. Empty counts are not interpreted as accounting completeness.

Live ownership is capability-scoped. `ORCHESTRATOR_MODE=live`, the global live
gate, and an explicit `ORCHESTRATOR_ENABLE_*` flag are all required. The
repository template defaults every flag false; a disabled capability is
`SKIPPED`, and its enabled descendants are `BLOCKED`. Before executing every
enabled live unit, the orchestrator also requires an unexpired matching
`order_scheduler_ownership` row: owner `vps_order_orchestrator`, exact workload,
runtime host and release, enabled state, and `legacy_scheduler_disabled=true`.
Missing, stale or mismatched evidence records a durable `BLOCKED` step before
any phase code runs, with the reason visible through `pipeline_steps.error_code`
and the Portal control plane. Ownership evidence must have been observed within
24 hours even if its registry expiry is later. The Cloudflare scheduled handler
uses the same phase-to-workload map: an unregistered workload preserves the
pre-cutover owner, while any registered non-Cloudflare owner makes the Worker
step down; registry read failures also block dispatch. Flags or a self-asserted
VPS row alone therefore cannot authorize a competing writer.

The terminal `audit_pipeline_integrity` phase produces separate Mercari and
Rakuten sales/shipment/backlog counts. Channel filtering is explicit; Rakuten
rows are never evaluated against Mercari shop IDs. The phase is read-only and
cannot heal or write marketplace/Giga state.

`order_scheduler_ownership` is the target durable current-owner projection and
`order_scheduler_ownership_events` is its immutable audit trail. Records expire
within eight days and require fresh evidence; VPS ownership additionally
requires `legacy_scheduler_disabled=true`. The migration is not deployed and
contains no seed assumptions, so this inventory's runtime declarations remain
the current bounded evidence until governed registry population and readback.

This section does not change the current runtime declarations below. Until an
approved capability cutover is deployed and read back, Cloudflare cron remains
the current business scheduler and VPS pipeline timers must remain disabled.
Every cutover must update this inventory in the same change.

Worker admin endpoints do not provide a second write owner. `/admin/run-once`
is dry-run only and rejects write confirmation. A dry-run request for a phase
without a proven side-effect-free preview returns `dry_run_unsupported` before
phase code executes; it must never fall through to a real mutation.
Mercari and Rakuten Giga outbound are the first restored preview paths: they
perform candidate reads/payload validation only and never call the sync writer,
claim an operation, update a shipment, or invoke Giga create-order.

## Authority

This file is the authoritative repository record of intended and known production sync workloads. Runtime infrastructure (systemd timers, Cloudflare Cron Triggers) is the source of truth for what is currently executing. Differences between this inventory and runtime are **governance drift** — a signal to investigate, not automatic permission to modify either side.

Governance invariants are defined in the canonical `SYNC_WORKLOAD_GOVERNANCE.md` policy in `retailpulses/rp-governance-kit`.

**Repository domain:** `order_management`

## Supabase Egress Observability

Every Cloudflare pipeline phase uses the stable identity
`ordermgmt/<phase>/<release_version>`. Phase completion logs and
`pipeline_run_log.result_counts.egress` capture request counts, rows returned,
response `Content-Length` samples, and decoded JSON byte estimates. Missing
`Content-Length` is recorded as an unmeasured sample, never as zero-byte usage.

This instrumentation is for workload attribution. Supabase organization
Billing/Usage remains the acceptance source for actual egress. Initial byte
budgets and any projection/cursor remediation are gated on a representative
production measurement window linked to OrderMgmt #217 and RPagentOS #97.

---

## Summary Table

| Workload ID | Purpose | Kind / Effect | Risk | Runtime | Worker Trigger(s) | Systemd Timer(s) | Source -> Target | Lifecycle |
|---|---|---|---|---|---|---|---|---|
| `ordermgmt_canonical_orchestrator` | Execute the dependency-gated canonical order DAG | orchestrate / control_plane | High | VPS systemd shadow | hourly at `:01` JST | `order-mgmt-orchestrator.timer` (enabled shadow; live flags false) | Supabase control plane + marketplace phases | immutable shadow deployed; first run accepted; no business ownership |
| `ordermgmt_mercari_order_pull` | Discover and exact-ID reconcile Mercari orders | pull + reconcile / internal_write | Medium | CF Worker (+ VPS relay) | `1 * * * *` | hourly (legacy CORE_PHASES lacks reconciliation) | Mercari Shops API -> Supabase + freshness watermark | implementation pending deployment |
| `ordermgmt_rakuten_order_pull` | Discover and exact-ID reconcile Rakuten orders | pull + reconcile / internal_write | Medium | CF Worker (+ VPS relay) | `2 * * * *` | — | Rakuten RMS API -> Supabase + freshness watermark | reconciliation implementation pending deployment |
| `ordermgmt_mercari_message_sync` | Sync Mercari buyer messages to local store | pull / internal_write | Medium | CF Worker (+ VPS relay) | `3,13,23,33,43,53` | — | Mercari Shops API -> Supabase | active |
| `ordermgmt_auto_approve_orders` | Auto-approve eligible Mercari orders | projection / internal_write | Medium | CF Worker | `3,13,23,33,43,53` | — | Supabase -> Supabase | active |
| `ordermgmt_rakuten_order_confirm` | Confirm received Rakuten orders via RMS | push / external_write | Medium | CF Worker (+ VPS relay) | `4,14,24,34,44,54` | — | Supabase -> Rakuten RMS API | active |
| `ordermgmt_giga_shipment_build` | Project Mercari sales -> Giga shipment orders | projection / internal_write | Medium | CF Worker | `3,13,23,33,43,53` | hourly (in CORE_PHASES) | Supabase sales -> Supabase shipments | active |
| `ordermgmt_rakuten_shipment_build` | Project Rakuten sales -> Giga shipment orders | projection / internal_write | Medium | CF Worker | `7,17,27,37,47,57` | — | Supabase sales -> Supabase shipments | active |
| `ordermgmt_giga_order_push` | Push Mercari shipments to GigaB2B API | push / external_write | High | CF Worker | `6,16,26,36,46,56` | hourly (in CORE_PHASES) | Supabase shipments -> GigaB2B API | active |
| `ordermgmt_rakuten_order_push` | Push Rakuten shipments to GigaB2B API | push / external_write | High | CF Worker | `8,18,28,38,48,58` | `pipeline-push-rakuten-orders.timer` | Supabase shipments -> GigaB2B API | active |
| `ordermgmt_giga_tracking_pull` | Pull tracking from GigaB2B, patch sales_orders | pull / internal_write | Medium | CF Worker | `8,18,28,38,48,58` | sync | GigaB2B API -> Supabase | active |
| `ordermgmt_rakuten_tracking_sync` | Pull Rakuten tracking from GigaB2B, patch orders | pull / internal_write | Medium | CF Worker | `10,20,30,40,50` | — | GigaB2B API -> Supabase | active |
| `ordermgmt_rakuten_order_close` | Submit persisted tracking and close shipped Rakuten orders | push / external_write | High | CF Worker (+ VPS relay) | `10,20,30,40,50` (after tracking sync) | — | Supabase -> Rakuten RMS API | active |
| `ordermgmt_shop_order_close` | Close shipped Mercari orders on marketplace | push / external_write | High | CF Worker (+ VPS relay) | `9,19,29,39,49,59` | close | Supabase -> Mercari Shops close API | active |
| `ordermgmt_end_to_end_reconcile` | Legacy combined reconciliation/healing | reconcile / external_write | High | CF Worker | `11,21,31,41,51` | — | Mercari + Supabase + GigaB2B | active in deployed release; removed from target schedule |
| `ordermgmt_cancellation_reconcile` | Detect and reconcile Mercari cancellations | reconcile / internal_write | Medium | CF Worker (+ VPS relay) | `50 14 * * *` | — | Mercari Shops API -> Supabase | active |
| `ordermgmt_payment_reminder` | Send payment reminders to customers | push / external_write | High | CF Worker (+ VPS relay) | `0 23 * * *` | — | Supabase -> Mercari customer messages | active |
| `ordermgmt_sales_brief_reporting` | Generate multi-platform sales brief and deliver to WeCom | projection / external_write | Medium | VPS systemd | — | `order-mgmt-sales-brief.timer` | Supabase -> WeCom | active; target ledger path branch-only |

---

## Workload Details

### ordermgmt_mercari_order_pull

- **Purpose:** Discover new Mercari Shops orders, then exact-ID reconcile every known non-terminal order and publish a durable per-store freshness watermark only after complete accounting.
- **Kind / Effect / Risk:** pull / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent (VPS relay at `worker-order.homesbliss.net`)
- **Trigger / Schedule:**
  - Worker cron: `1 * * * *` (once per hour at :01), sequentially dispatching `pull_shop_orders` then `reconcile_order_lifecycle` in the implementation branch
  - Legacy systemd artifact: `pipeline-hourly.timer` is installed but disabled; it is not a production scheduler or supported failover path
- **Canonical source:** `src/lib/mercari-relay.mjs` (`runMercariIngestViaRelay`, `runMercariOrderStatusesViaRelay`) + `src/lib/lifecycle-reconciler.mjs`
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `pull_shop_orders` via `runPhase`
- **Source system(s):** Mercari Shops API (accessed through VPS relay at fixed IPv4)
- **Target system(s):** Supabase `sales_orders` table
- **Current kill switch:** Remove `1 * * * *` from `wrangler.toml` triggers and redeploy. The disabled legacy VPS timer is not an active kill-switch target.
- **Idempotency / deduplication:** Idempotent — checks `order_id` existence before inserting; skips duplicates. Paginates through Mercari orders deterministically.
- **Checkpoint / replay:** Order-pull cursors are managed by the relay. Re-running fetches only orders newer than the last known cursor. Full replay can be triggered by resetting the cursor.
- **Overlapping writers:** None — this is the sole writer for new Mercari orders.
- **Upstream dependencies:** VPS relay health (blocked if relay unreachable).
- **Downstream consumers:** payment reminders and sales brief require `accounting_complete` freshness; fulfillment gates will consume the same evidence in the next tranche.
- **Freshness contract:** Exact-ID status reads are batched at up to 50 orders per GraphQL request. Unknown status, not-found, relay failure, CAS conflict, or bounded execution prevents an `accounting_complete` watermark.
- **Known limitations:** Batched at `ORDER_MGMT_LIMIT` (default 100). Large backlogs may require multiple cycles. Relay-dependent — any relay outage blocks ingestion.
- **Completion contract:** Relay `/admin/ingest` waits for the ingest process (and enabled compatibility bridge) to exit, then returns HTTP 200 with `state=completed` and candidate/processed/skipped/failed counts. HTTP 202 is only `accepted`, never completed; the Worker records it as a non-successful phase with `completion_state=accepted`.
- **Runtime verification:** Run `POST /admin/dry-run` with `{"mode":"pull_shop_orders"}` and inspect `steps[].completion_state`, `steps[].summary.counts`, and `pipeline_run_log.result_counts`.

---

### ordermgmt_rakuten_order_pull

- **Purpose:** Pull recent Rakuten RMS orders, then exact-ID reconcile every locally known non-terminal order and publish complete freshness evidence only after full accounting.
- **Kind / Effect / Risk:** pull / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent
- **Trigger / Schedule:** Current production Worker cron: `2 * * * *` discovery only. Target branch maps the same slot to discovery followed by `reconcile_rakuten_lifecycle`; not deployed. Target orchestrator includes both in shadow.
- **Canonical source:** shared `src/lib/rakuten-ingest.mjs` (`ingestRakutenOrders`) with transport selected by runtime: Worker `src/lib/rakuten-relay.mjs`; target VPS `src/lib/rakuten-local-api.mjs`.
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `pull_rakuten_orders` via `runPhase`
- **Source system(s):** Rakuten RMS API (accessed through VPS relay)
- **Target system(s):** Supabase `sales_orders` table
- **Kill switch:** Remove `2 * * * *` from `wrangler.toml` triggers list and redeploy.
- **Idempotency / deduplication:** Idempotent — ingester checks order number before writing; upserts on collision.
- **Checkpoint / replay:** Scoped to new/unprocessed orders. Re-running a failed run is safe — already-processed orders are skipped.
- **Overlapping writers:** None — sole writer for Rakuten orders. No conflict with Mercari order pull because channels differ.
- **Upstream dependencies:** VPS relay health.
- **Downstream consumers:** `confirm_rakuten_orders`, `build_rakuten_shipments`, Rakuten Giga push/tracking/close; all target implementations require fresh complete evidence.
- **Freshness contract:** Local non-terminal identities are fetched from RMS by exact order number in batches of 50. Failed batches split recursively. Unknown/not-found/bounded/CAS-conflicted work is partial and does not release downstream phases.
- **Known limitations:** Production currently has discovery only; migration, relay/Worker release, canary, full accounting readback, and shadow evidence remain pending.
- **Runtime verification:** Verify via cron logs or admin dry-run: `POST /admin/dry-run` with `{"mode":"pull_rakuten_orders"}`.

---

### ordermgmt_mercari_message_sync

- **Purpose:** Sync Mercari buyer messages into local store for the Order Review Portal, and retry stuck webhook event processing (folded workload, Issue #131).
- **Kind / Effect / Risk:** pull / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent
- **Trigger / Schedule:** Worker cron: `3,13,23,33,43,53 * * * *` (every 10 minutes). No systemd timer.
- **Canonical source:** `src/lib/buyer-messages.mjs` (`syncMercariMessages`) + `src/lib/webhook-handler.mjs` (`retryStuckWebhookEvents`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `sync_mercari_messages`; the runner folds webhook-event retry into this phase (no separate `retry_webhook_events` phase)
- **Source system(s):** Mercari Shops messages API (through VPS relay), Supabase `order_management_message_webhook_event`
- **Target system(s):** Supabase (message store, durable state per order), `order_management_message_webhook_event`
- **Kill switch:** Remove the phase from the `SCHEDULED_CRON_MODES` entry for `3,13,23,33,43,53` in `pipeline-schedule.mjs` and redeploy. (Note: shares this cron slot with `auto_approve_orders` and `build_giga_shipments`.) Webhook retry stops when `WEBHOOK_INTAKE_ENABLED` is `false`.
- **Idempotency / deduplication:** Idempotent — uses `writeThroughMessageFacts` with message ID dedup and durable state tracking. Candidate identity is `(source_store_id, order_id)`, so identical marketplace order numbers in different shops remain isolated. Webhook retry uses atomic RPC claim (`claim_order_mgmt_webhook_event`); rows with `processing_attempts >= 3` are never reclaimed.
- **Checkpoint / replay:** Tracks last-sync cursor per order via `readDurableState`/`writeThroughMessageFacts`. Re-running from scratch re-fetches all messages for orders with unread status. Pending webhook rows are claimed in batches of up to 10 per cycle.
- **Overlapping writers:** None — sole writer for messages.
- **Upstream dependencies:** VPS relay health.
- **Downstream consumers:** Order Review Portal (displays messages, supports replies); updated `sales_order_message_state` webhook metrics.
- **Known limitations:** Webhook retry batch capped at 10 rows per cycle. Failed webhook rows after 3 attempts are terminal (marked `failed`). Requires VPS relay to fetch conversations.
- **Runtime verification:** Check portal for message presence on any order. The branch-only `POST /admin/dry-run` preview with `{"mode":"sync_mercari_messages"}` performs message reads but neither writes message facts nor persists failure state; it is not deployed evidence.

---

### ordermgmt_auto_approve_orders

- **Purpose:** Automatically approve eligible Mercari orders for fulfillment.
- **Kind / Effect / Risk:** projection / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:** Worker cron: `3,13,23,33,43,53 * * * *` (every 10 minutes). No systemd timer.
- **Canonical source:** `src/lib/auto-approval.mjs` (`autoApproveMercariOrders`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `auto_approve_orders`
- **Source system(s):** Supabase `sales_orders`
- **Target system(s):** Supabase `sales_orders` (status/approval fields)
- **Kill switch:** Remove the phase from the `SCHEDULED_CRON_MODES` entry for `3,13,23,33,43,53` in `worker/index.js` and redeploy. (Shares cron slot with message sync and shipment build.)
- **Idempotency / deduplication:** Idempotent — checks current order status before approving; only acts on eligible (unapproved, non-canceled) orders. Groups and writes by `(source_store_id, order_id)` so identical order numbers in different shops never share eligibility, message safety or approval state.
- **Checkpoint / replay:** Each run picks up orders where approval is pending. Re-running is safe — already-approved orders are skipped.
- **Overlapping writers:** None — sole auto-approval mechanism.
- **Upstream dependencies:** `pull_shop_orders` (new orders must exist before approval).
- **Downstream consumers:** `build_giga_shipments` (needs approved orders).
- **Known limitations:** Approval criteria are defined in config/logic; no manual per-order granularity in auto-approval.
- **Runtime verification:** `POST /admin/dry-run` with `{"mode":"auto_approve_orders"}`.

---

### ordermgmt_rakuten_order_confirm

- **Purpose:** Confirm received Rakuten orders via Rakuten RMS API.
- **Kind / Effect / Risk:** push / external_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent
- **Trigger / Schedule:** Worker cron: `4,14,24,34,44,54 * * * *` (every 10 minutes). No systemd timer.
- **Canonical source:** `src/lib/rakuten-confirmer.mjs` + `src/lib/rakuten-confirm-operation.mjs`; Worker transport is `src/lib/rakuten-relay.mjs`, target VPS transport is `src/lib/rakuten-local-api.mjs`.
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `confirm_rakuten_orders`
- **Source system(s):** Supabase `sales_orders` (pending confirmation orders)
- **Target system(s):** Rakuten RMS API (order confirmation endpoint)
- **Kill switch:** Remove `4,14,24,34,44,54 * * * *` from `wrangler.toml` triggers list and redeploy.
- **Idempotency / deduplication:** Target implementation deduplicates multi-line rows to one order and claims `external_operation_attempts` by capability/platform/store/order/payload hash before RMS. `CONFIRMED`/`ALREADY_APPLIED` suppress a second RMS write and may heal local persistence; `RESERVED`/`UNKNOWN_RESULT` remain blocked.
- **Checkpoint / replay:** Scoped to orders with `PENDING_CONFIRMATION` status. An ambiguous relay result triggers one exact-ID RMS read; progress `300` or `500` becomes `ALREADY_APPLIED`, while missing/failed/other evidence becomes `UNKNOWN_RESULT` and is never automatically released. Claim/finalize failures fail closed per order and later candidates continue.
- **Overlapping writers:** None — sole confirmation mechanism.
- **Upstream dependencies:** `pull_rakuten_orders` (orders must exist before confirming).
- **Downstream consumers:** `build_rakuten_shipments` (confirms must complete before shipment build).
- **Known limitations:** Target ledger behavior and evidence-gated operator recovery tooling are branch-only and not deployed. RMS progress `700` is conservatively not accepted as proof that confirmation succeeded.
- **Runtime verification:** Current production remains on the legacy behavior. Before cutover: dry-run, one exact-order canary, ledger/RMS/local-row readback, and injected ambiguous-result proof with no second provider call.

---

### ordermgmt_giga_shipment_build

- **Purpose:** Project Mercari sales order rows into Giga shipment rows in the shipment_orders table.
- **Kind / Effect / Risk:** projection / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:**
  - Worker cron: `3,13,23,33,43,53 * * * *` (every 10 minutes)
  - Legacy systemd artifact: `pipeline-hourly.timer` is installed but disabled and must not be enabled as a Worker mirror
- **Canonical source:** `src/lib/shipment-projector.mjs` (`projectMercariSalesOrdersToShipment`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `build_giga_shipments`
- **Source system(s):** Supabase `sales_orders`
- **Target system(s):** Supabase `shipment_orders`
- **Current kill switch:** Remove the phase from the `SCHEDULED_CRON_MODES` entry for `3,13,23,33,43,53` and redeploy. The disabled legacy timer is not a production path.
- **Idempotency / deduplication:** Idempotent — skips sales rows that already have shipment projections (via order_id matching). Upsert semantics.
- **Checkpoint / replay:** Full-table scan filtered to rows without existing shipment projections. Re-running is safe — already-projected sales orders are skipped.
- **Overlapping writers:** `build_rakuten_shipments` writes to the same `shipment_orders` table but for Rakuten channel rows only. No channel overlap.
- **Upstream dependencies:** `pull_shop_orders`, `auto_approve_orders`.
- **Downstream consumers:** `push_orders_to_giga`.
- **Known limitations:** Full table scan for candidate rows; no incremental cursor. Large tables may approach Worker CPU timeout.
- **Runtime verification:** Check `shipment_orders` table for recent projections. The branch-only dry-run reports planned creates, updates and duplicate removal with `side_effects=0`; mutation-spy tests prove create/patch/delete are not called.

---

### ordermgmt_rakuten_shipment_build

- **Purpose:** Project Rakuten sales order rows into Giga shipment rows.
- **Kind / Effect / Risk:** projection / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:** Worker cron: `7,17,27,37,47,57 * * * *` (every 10 minutes). No systemd timer.
- **Canonical source:** `src/lib/rakuten-projector.mjs` (`projectRakutenSalesOrdersToShipment`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `build_rakuten_shipments`
- **Source system(s):** Supabase `sales_orders`
- **Target system(s):** Supabase `shipment_orders`
- **Kill switch:** Remove `7,17,27,37,47,57 * * * *` from `wrangler.toml` triggers and redeploy.
- **Idempotency / deduplication:** Same pattern as Mercari shipment build — skips already-projected rows.
- **Checkpoint / replay:** Scoped to Rakuten channel orders without existing shipments.
- **Overlapping writers:** `build_giga_shipments` writes to the same table but for Mercari rows only. Non-overlapping due to channel filter.
- **Upstream dependencies:** `pull_rakuten_orders`, `confirm_rakuten_orders`.
- **Downstream consumers:** `push_rakuten_orders_to_giga`.
- **Known limitations:** Same full-table scan concern as Mercari shipment build.
- **Runtime verification:** The branch-only `POST /admin/dry-run` preview with `{"mode":"build_rakuten_shipments"}` reports planned creates/updates with `side_effects=0`; mutation-spy tests prove create/patch are not called. It is not deployed runtime evidence.

---

### ordermgmt_giga_order_push

- **Purpose:** Push Mercari shipment orders to GigaB2B API for fulfillment processing.
- **Kind / Effect / Risk:** push / external_write / **High**
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:**
  - Worker cron: `6,16,26,36,46,56 * * * *` (every 10 minutes)
  - Legacy systemd artifact: `pipeline-hourly.timer` is installed but disabled and has non-equivalent cadence
- **Canonical source:** `src/lib/outbound-sync.mjs` (`runOutboundSync`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `push_orders_to_giga`
- **Source system(s):** Supabase `shipment_orders`
- **Target system(s):** GigaB2B API (order creation endpoint)
- **Current kill switch:** Remove `6,16,26,36,46,56 * * * *` from `wrangler.toml` triggers and redeploy. The disabled legacy timer is not a production path.
- **Idempotency / deduplication:** Target implementation claims a durable `external_operation_attempts` row keyed by capability/platform/store/order/payload hash before calling Giga. Confirmed/already-applied operations suppress resubmission across runs.
- **Checkpoint / replay:** Shipment status remains a projection of the durable operation record. Only a governed `RELEASED` operation may be reclaimed; `RESERVED` and `UNKNOWN_RESULT` never age into an automatic retry.
- **Overlapping writers:** `push_rakuten_orders_to_giga` pushes to the same GigaB2B API but for Rakuten channel. No ID overlap expected (different order ID prefixes). Potential risk if both push the same order ID simultaneously — currently mitigated by channel separation.
- **Upstream dependencies:** `build_giga_shipments` (shipment rows must exist).
- **Downstream consumers:** `pull_giga_tracking` (needs pushed orders to query tracking).
- **Known limitations:** The current Giga client exposes create and tracking calls but no verified authoritative order lookup contract. Ambiguous create outcomes therefore require operator/provider reconciliation and remain blocked.
- **Runtime verification:** `POST /admin/dry-run` with `{"mode":"push_orders_to_giga"}` or check Giga dashboard.

#### External Write Safety (ordermgmt_giga_order_push)
- **Idempotency key:** Durable operation identity plus Giga order number; payload changes create a separately reviewable intent.
- **Unknown-result handling:** Create-order network loss, non-JSON response, 5xx, or local finalization ambiguity becomes `UNKNOWN_RESULT`. Create calls have no transport retry.
- **Reconciliation path:** No automatic release until a verified Giga lookup contract exists. The branch provides a single-operation, evidence-required resolution CLI/RPC, but tracking evidence alone is not currently treated as authoritative proof of non-creation.

#### Manual control: `ordermgmt_external_operation_resolution`

- **Purpose:** Resolve one non-reclaimable external-operation ledger record after authoritative provider reconciliation.
- **Kind / Effect / Risk:** agent_operation / internal_write / **High**
- **Trigger / Schedule:** Manual only; never scheduled or bulk invoked.
- **Canonical source:** `scripts/resolve-external-operation.mjs`, `src/lib/external-operation-ledger.mjs`, migration `20260907151000_add_external_operation_resolution.sql`.
- **Write scope:** One exact `operation_key`; CAS requires the current status to equal `--expected-status`.
- **Safety:** Dry-run by default. Write requires `--confirm-write`, evidence reference, reason, actor, and outcome. `APPLIED` → `ALREADY_APPLIED`; `NOT_APPLIED` → `RELEASED`. No age-based release.
- **Audit/readback:** RPC atomically appends `external_operation_resolutions`; client reads back both the attempt and audit row before reporting success.
- **Kill switch:** Do not grant/retain service-role credentials in the operator environment; the RPC is unavailable to `anon` and `authenticated`.
- **Runtime status:** Branch-only; migration not applied and no production canary performed.

---

### ordermgmt_rakuten_order_push

- **Purpose:** Push Rakuten shipment orders to GigaB2B API.
- **Kind / Effect / Risk:** push / external_write / **High**
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:** Worker cron: `8,18,28,38,48,58 * * * *` (every 10 min, after projection at :07). Systemd timer: `pipeline-push-rakuten-orders.timer` (`:08,18,28,38,48,58`).
- **Canonical source:** `src/lib/outbound-sync.mjs` (`runOutboundSync` with `platform: "Rakuten"`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `push_rakuten_orders_to_giga`
- **Source system(s):** Supabase `shipment_orders`
- **Target system(s):** GigaB2B API (order creation endpoint)
- **Kill switch:** Remove `8,18,28,38,48,58 * * * *` from `wrangler.toml` triggers and redeploy; OR disable `pipeline-push-rakuten-orders.timer` on VPS.
- **Idempotency / deduplication:** Same durable operation claim/finalize contract as Mercari, with Rakuten platform/store scope in the identity.
- **Checkpoint / replay:** Same fail-closed ledger semantics as Mercari; ambiguous operations do not retry on elapsed time.
- **Overlapping writers:** `push_orders_to_giga` pushes to the same API for Mercari channel. Separate channel filter prevents same-order collision.
- **Upstream dependencies:** `build_rakuten_shipments`.
- **Downstream consumers:** `sync_rakuten_tracking`.
- **Known limitations:** Same missing verified Giga lookup contract as Mercari; ambiguous results require operator/provider reconciliation.
- **Runtime verification:** `POST /admin/dry-run` with `{"mode":"push_rakuten_orders_to_giga"}`.

#### External Write Safety (ordermgmt_rakuten_order_push)
- **Idempotency key:** GigaB2B order ID. Same ALREADY_EXISTS dedup as Mercari push.
- **Unknown-result handling:** Same durable `UNKNOWN_RESULT` state as Mercari; no transport retry.
- **Reconciliation path:** No automatic release until authoritative provider lookup is implemented and accepted.

---

### ordermgmt_giga_tracking_pull

- **Purpose:** Pull tracking/shipping status from GigaB2B and patch back to sales_orders and shipment_orders.
- **Kind / Effect / Risk:** pull / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:**
  - Worker cron: `8,18,28,38,48,58 * * * *` (every 10 minutes)
  - Systemd timer: `pipeline-sync.timer` (at `*:08,18,28,38,48,58`)
- **Canonical source:** `src/lib/tracking-reconciler.mjs` (`reconcileShippingInfo`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `pull_giga_tracking`
- **Source system(s):** GigaB2B tracking API
- **Target system(s):** Supabase `sales_orders` and `shipment_orders`
- **Kill switch:** Remove `8,18,28,38,48,58 * * * *` from `wrangler.toml` triggers and redeploy; OR disable `pipeline-sync.timer`.
- **Idempotency / deduplication:** Idempotent — skips rows where `shipping_completed_at` is already set (server-side filter). Patches with latest tracking data each cycle.
- **Checkpoint / replay:** Server-side filters reduce scan to ~100 rows (down from 1000+). Replaying is safe — already-tracked rows are skipped by the `shipping_completed_at` filter.
- **Overlapping writers:** `sync_rakuten_tracking` uses the same `reconcileShippingInfo` module with different channel config. No channel overlap.
- **Upstream dependencies:** `push_orders_to_giga` (only pushed orders have tracking to pull).
- **Downstream consumers:** `close_shop_orders` (needs tracking confirmation before close).
- **Known limitations:** In rare race conditions, tracking might arrive between the filter query and the API call; handled by next cycle.
- **Runtime verification:** Check `shipping_completed_at` timestamps in `sales_orders`. The branch-only dry-run still performs the scoped Giga tracking read but reports planned shipment/sales updates with `side_effects=0`; mutation-spy tests prove the patch path is not called.

---

### ordermgmt_rakuten_tracking_sync

- **Purpose:** Pull tracking for Rakuten-channel orders from GigaB2B and patch Supabase records.
- **Kind / Effect / Risk:** pull / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:** Worker cron: `10,20,30,40,50 * * * *` (every 10 minutes, offset). No systemd timer.
- **Canonical source:** `src/lib/tracking-reconciler.mjs` (`reconcileShippingInfo` with `salesChannel: "Rakuten"`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `sync_rakuten_tracking`
- **Source system(s):** GigaB2B tracking API
- **Target system(s):** Supabase `sales_orders` and `shipment_orders` (Rakuten channel)
- **Kill switch:** Remove `10,20,30,40,50 * * * *` from `wrangler.toml` triggers and redeploy.
- **Idempotency / deduplication:** Same idempotent tracking reconciler as Mercari — skips already-tracked rows.
- **Checkpoint / replay:** Channel-agnostic reconciler filters by Rakuten channel config.
- **Overlapping writers:** `pull_giga_tracking` uses the same module for Mercari. Channel config ensures non-overlapping operation.
- **Upstream dependencies:** `push_rakuten_orders_to_giga`.
- **Downstream consumers:** `close_rakuten_orders`, executed next in the same cron invocation.
- **Known limitations:** The runner does not short-circuit later phases after a failed step. Close may still reconcile older tracking already persisted by a previous cycle, but cannot consume tracking that failed to persist in the current cycle.
- **Runtime verification:** The branch-only `POST /admin/dry-run` preview with `{"mode":"sync_rakuten_tracking"}` performs the scoped Giga read, reports planned shipment updates with `side_effects=0`, and does not patch rows. It is not deployed runtime evidence.

### ordermgmt_rakuten_order_close

- **Purpose:** Submit persisted Giga tracking to Rakuten RMS and reconcile shipped orders to completion.
- **Kind / Effect / Risk:** push / external_write / **High**
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`) through the fixed-IP VPS relay.
- **Trigger / Schedule:** Worker cron: `10,20,30,40,50 * * * *`, immediately after `sync_rakuten_tracking` in the same invocation. No systemd timer.
- **Canonical source:** `src/lib/rakuten-closer.mjs` (`closeRakutenOrders`).
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `close_rakuten_orders` after tracking sync.
- **Source system(s):** Supabase `sales_orders` and `giga_shipment_projections`.
- **Target system(s):** Rakuten RMS API through `worker-order.homesbliss.net`.
- **Kill switch:** Remove `close_rakuten_orders` from the `10,20,30,40,50 * * * *` entry in `pipeline-schedule.mjs` and redeploy; tracking sync remains active.
- **Idempotency / deduplication:** Target implementation groups all lines by normalized order ID and claims one stable order-scoped `rakuten_close_order` ledger intent before the RMS mutation. Payload changes cannot mint a second close identity. It pre-reads RMS and submits only at progress 300.
- **Checkpoint / replay:** Provider acceptance finalizes `CONFIRMED` and becomes verification-only; ambiguous failure without RMS 500 finalizes `UNKNOWN_RESULT`. An exact RMS 500 read finalizes/reconciles `ALREADY_APPLIED` and completes every local line without resubmission.
- **Overlapping writers:** None. Tracking sync writes shipment tracking first; close consumes it sequentially in the same Worker invocation.
- **Upstream dependencies:** `sync_rakuten_tracking`, Supabase, VPS relay, Rakuten RMS API.
- **Downstream consumers:** Rakuten RMS shipped state and Order Portal completed state.
- **Known limitations:** Target implementation is branch-only and deliberately unscheduled. The repository implementation names `getOrder(version 7)` and `updateOrderShipping`, but authoritative external contract verification and production mutation history audit remain required before activation.
- **Runtime verification:** First verify the official/current RMS contract and production history. Then run exact-order dry-run and a separately approved one-order canary; read back RMS progress 500, one terminal ledger record, one provider mutation, and consistent `rms_close_completed_at` across every local line.

---

### ordermgmt_shop_order_close

- **Purpose:** Close fulfilled/shipped Mercari orders on the Mercari Shops marketplace.
- **Kind / Effect / Risk:** push / external_write / **High**
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent
- **Trigger / Schedule:**
  - Worker cron: `9,19,29,39,49,59 * * * *` (every 10 minutes)
  - Systemd timer: `pipeline-close.timer` (at `*:09,19,29,39,49,59`)
- **Canonical source:** `src/lib/mercari-relay.mjs` (`runMercariShippingCloseViaRelay`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `close_shop_orders`
- **Source system(s):** Supabase `sales_orders` (rows where `shipping_completed_at` is set and tracking confirmed)
- **Target system(s):** Mercari Shops close order API (via VPS relay)
- **Kill switch:** Remove `9,19,29,39,49,59 * * * *` from `wrangler.toml` triggers and redeploy; OR disable `pipeline-close.timer`.
- **Idempotency / deduplication:** Target implementation claims one stable `mercari_close_order` intent per store/order before the multi-shipping mutation sequence. Provider idempotency keys remain a secondary backstop. Tracking/payload changes cannot create a second order-close identity.
- **Checkpoint / replay:** Exact marketplace `COMPLETED` is required before local completion. Accepted `COMPLETING` becomes verification-only; transport or partial-mutation ambiguity becomes `UNKNOWN_RESULT`. Blocked/confirmed operations cannot automatically resubmit.
- **Overlapping writers:** None — sole close mechanism for Mercari orders.
- **Upstream dependencies:** `pull_giga_tracking` (tracking must confirm shipment before close).
- **Downstream consumers:** Reconciliation (end-to-end checks that close happened).
- **Known limitations:** Target behavior is branch-only and not deployed. A partial multi-shipping sequence that does not reach marketplace `COMPLETED` requires authoritative reconciliation; it is intentionally unavailable for automatic retry.
- **Completion contract:** Relay `/admin/close-shipped-orders` waits for the bounded close batch to exit, then returns HTTP 200 with `state=completed` and candidate/processed/skipped/failed counts. A zero-candidate response is completed work with all counts zero. HTTP 202 remains `accepted`, never completed.
- **Runtime verification:** Exact-order dry-run, then one approved canary. Read back one ledger intent, marketplace `COMPLETED`, exactly one order-level mutation sequence, and identical terminal/tracking facts across every Supabase line. Inject a mid-sequence failure and prove no automatic resubmission.

#### External Write Safety (ordermgmt_shop_order_close)
- **Idempotency key:** Stable ledger identity `mercari_close_order:mercari:<store>:<order>:<order-hash>`; provider create-shipping keys are secondary protection.
- **Unknown-result handling:** Any partial/transport ambiguity without exact `COMPLETED` readback becomes `UNKNOWN_RESULT` and is never retried by age.
- **Reconciliation path:** Exact marketplace status can prove application; otherwise the governed single-operation resolution path requires authoritative evidence before release.

---

### ordermgmt_end_to_end_reconcile

- **Purpose:** Legacy combined ingest/push/tracking/close healing pass. Despite its name, the current implementation is not a read-only audit.
- **Kind / Effect / Risk:** reconcile / external_write / High
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`)
- **Trigger / Schedule:** Worker cron: `11,21,31,41,51 * * * *` (every 10 minutes, offset). No systemd timer.
- **Canonical source:** `src/lib/end-to-end-reconcile.mjs` (`runEndToEndReconcile`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `reconcile_end_to_end`
- **Source system(s):** Mercari Shops API, Supabase sales_orders + shipment_orders, GigaB2B API
- **Target system(s):** Supabase, GigaB2B and Mercari Shops through the phases it re-invokes
- **Kill switch:** Remove `11,21,31,41,51 * * * *` from `wrangler.toml` triggers and redeploy.
- **Idempotency / deduplication:** The legacy wrapper relies on the invoked phase guards; it has no independent end-to-end intent boundary.
- **Checkpoint / replay:** Re-runs multiple canonical writer phases rather than maintaining an independent read-only audit checkpoint.
- **Overlapping writers:** Competes with the separately scheduled Giga push, tracking and close writers. The target branch removes it from the Worker schedule and uses `audit_pipeline_integrity` as the read-only DAG tail instead.
- **Upstream dependencies:** All prior pipeline phases (pull, project, push, tracking, close).
- **Downstream consumers:** Pipeline health snapshot (logged after core phases).
- **Known limitations:** This is a duplicate control path and cannot be migrated as-is. It remains a current deployed-release risk until the corresponding production cutover is approved and read back.
- **Runtime verification:** Use dry-run only for diagnosis. Do not treat this legacy phase as the target integrity audit or enable it beside the canonical orchestrator.

---

### ordermgmt_cancellation_reconcile

- **Purpose:** Detect marketplace-initiated cancellations on Mercari and reconcile internal state.
- **Kind / Effect / Risk:** reconcile / internal_write / Medium
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent
- **Trigger / Schedule:** Worker cron: `50 14 * * *` (once daily at 14:50 UTC = 23:50 JST). No systemd timer.
- **Canonical source:** `src/lib/cancellation-reconciler.mjs` (`reconcileMercariCancellations`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `reconcile_cancellations`
- **Source system(s):** Mercari Shops API (order status query)
- **Target system(s):** Supabase `sales_orders` (cancellation status and audit)
- **Kill switch:** Remove `50 14 * * *` from `wrangler.toml` triggers and redeploy.
- **Idempotency / deduplication:** Checks current cancellation status before updating. Candidate comparison and shipment invalidation use `(source_store_id, normalized_order_id)`; same-number orders in other shops are out of scope. Re-running skips already-reconciled cancellations.
- **Checkpoint / replay:** Scoped to orders where internal status differs from marketplace status. Daily scan covers all active orders.
- **Overlapping writers:** `pull_shop_orders` and `close_shop_orders` could theoretically touch the same order in a different state. Mitigated by separate processing windows (cancellation runs once daily).
- **Upstream dependencies:** None directly (reads current marketplace state independently).
- **Downstream consumers:** Sales reporting (excludes canceled orders from revenue).
- **Known limitations:** Once-daily run — cancellation detection lag up to 24 hours. Does not auto-trigger downstream compensation actions.
- **Runtime verification:** `POST /admin/dry-run` with `{"mode":"reconcile_cancellations"}`.

---

### ordermgmt_payment_reminder

- **Purpose:** Send payment reminders to customers with unpaid Mercari orders.
- **Kind / Effect / Risk:** push / external_write / **High**
- **Runtime host:** Cloudflare Worker (`rp-order-mgmt`), relay-dependent
- **Trigger / Schedule:** Worker cron: `0 23 * * *` (once daily at 23:00 UTC = 08:00 JST). No systemd timer.
- **Canonical source:** `src/lib/payment-reminders.mjs` (`sendPaymentReminders`)
- **Deployment entrypoint:** `worker/index.js` — scheduled handler dispatches `send_payment_reminders`
- **Source system(s):** Supabase `sales_orders` (orders with WAITING_FOR_PAYMENT status)
- **Target system(s):** Mercari Shops customer messages API (via VPS relay)
- **Kill switch:** Remove `0 23 * * *` from `wrangler.toml` triggers and redeploy.
- **Idempotency / deduplication:** Uses the persisted per-order/day reservation and delivery state. `SENT` suppresses duplicates; unresolved `RESERVED`/`UNKNOWN_RESULT` rows are not automatically released for resend.
- **Checkpoint / replay:** Candidates require an accounting-complete Mercari lifecycle watermark, followed by an exact-ID pre-send marketplace check. Reservation is persisted before the relay call.
- **Overlapping writers:** None — sole payment reminder mechanism.
- **Upstream dependencies:** Successful Mercari lifecycle reconciliation with a fresh persisted watermark; discovery alone is insufficient.
- **Downstream consumers:** None directly.
- **Known limitations:** Sends via Mercari message API, which requires the relay. Automated proof of an ambiguously delivered message depends on provider-visible message evidence; otherwise the reservation remains blocked for evidence-gated operator resolution.
- **Runtime verification:** `POST /admin/dry-run` with `{"mode":"send_payment_reminders"}`.

#### External Write Safety (ordermgmt_payment_reminder)
- **Idempotency key:** Stable per-order/day reservation in `payment_reminders`.
- **Unknown-result handling:** Transport or response ambiguity persists `UNKNOWN_RESULT`; the next cycle does not resend it by age.
- **Reconciliation path:** Reconcile against authoritative provider message evidence where available; otherwise use the reviewed, evidence-required single-operation resolution path before confirming or releasing.

---

### ordermgmt_sales_brief_reporting

- **Purpose:** Generate a multi-platform sales summary brief and push to WeCom.
- **Kind / Effect / Risk:** projection / external_write / Medium (business-data
  reads are read-only; WeCom delivery is an external effect)
- **Runtime host:** ConoHa VPS systemd (`order-mgmt-sales-brief.timer`), verified enabled/active at the bounded 2026-09-07 readback
- **Trigger / Schedule:** VPS timer at 08:00, 11:00, 14:00, 17:00, 20:00 and 22:00 JST
- **Delivery-slot boundary:** live execution derives the current JST scheduled
  hour. An explicit value may only assert that exact current slot; past,
  future, and off-schedule identities fail closed.
- **Canonical source:** `scripts/sales-brief-report.mjs`
- **Deployment entrypoint:** `deploy/systemd/order-mgmt-sales-brief.service`
- **Target service identity:** branch asset uses non-root `rp-ordermgmt`, the
  immutable `/opt/order-mgmt-orchestrator/current` release and protected
  `/etc/ordermgmt/sales-brief.env`; current production unit remains unchanged
  until separately deployed and read back.
- **Source system(s):** Supabase `sales_orders` (read-only query)
- **Target system(s):** WeCom (via `src/wecom.js` webhook send)
- **Current kill switch:** Disable `order-mgmt-sales-brief.timer`. The legacy sibling Worker was retired by the recorded deployment decision; a direct Cloudflare trigger API re-read remains required before final cutover acceptance.
- **Idempotency / deduplication:** A stable JST delivery slot is claimed in
  `external_operation_attempts` before WeCom delivery. `CONFIRMED` skips a
  duplicate invocation; `RESERVED`, `UNKNOWN_RESULT`, and unresolved failure
  states block resending.
- **Checkpoint / replay:** Successful delivery is finalized and read back as
  `CONFIRMED`. Transport ambiguity becomes `UNKNOWN_RESULT`; explicit provider
  rejection with a parsed non-zero WeCom `errcode` becomes
  `DEFINITIVE_FAILURE`; HTTP status alone remains `UNKNOWN_RESULT`. Neither is age-retried, and the
  target oneshot service has `Restart=no`; recovery is timer/operator-driven.
- **Overlapping writers:** None — read-only workload.
- **Upstream dependencies:** All order pull and processing phases (data must be current in Supabase).
- **Downstream consumers:** Team visibility via WeCom.
- **Known limitations:** The two historical sibling Worker names are absent from the current Cloudflare account. Report delivery is still an external WeCom effect even though its business-data projection is read-only, so canaries must avoid duplicate sends.
- **Runtime verification:** Inspect `systemctl status order-mgmt-sales-brief.timer`, the latest service result/journal, and its corresponding `pipeline_run_log`/freshness evidence without sending an extra report.

---

## Scheduling Architecture

Current production and target architecture must not be conflated:

- **Current business scheduler:** the main Cloudflare Worker; direct schedule API readback returned all 13 expected cron expressions at 16:03 JST.
- **Current reporting scheduler:** the ConoHa VPS `order-mgmt-sales-brief.timer`, verified enabled and active. Direct Cloudflare API reads returned Worker-not-found for both historical sibling reporting names.
- **Migration artifacts:** the 16 installed `pipeline-*` VPS timers are disabled. They are cadence-divergent legacy assets, not a secondary production path, hot standby, or supported Worker mirror.
- **Target:** one VPS-started `order-mgmt-orchestrator.timer` owns each cut-over business capability through explicit live flags and durable ownership evidence. It is currently active only as hourly shadow; no live capability or business ownership is enabled.

### Current Layer 1: Cloudflare Worker Cron

Configured in `wrangler.toml` `[triggers] crons` array (13 cron expressions). Mapped to phases via `SCHEDULED_CRON_MODES` in `worker/index.js`.

| Cron Expression | Phases Scheduled | Frequency |
|---|---|---|
| `1 * * * *` | `pull_shop_orders` | Every hour at :01 |
| `2 * * * *` | `pull_rakuten_orders` | Every hour at :02 |
| `3,13,23,33,43,53 * * * *` | `sync_mercari_messages`, `auto_approve_orders`, `build_giga_shipments` | Every 10 min at :03/:13/:23... |
| `4,14,24,34,44,54 * * * *` | `confirm_rakuten_orders` | Every 10 min at :04/:14/:24... |
| `6,16,26,36,46,56 * * * *` | `push_orders_to_giga` | Every 10 min at :06/:16/:26... |
| `7,17,27,37,47,57 * * * *` | `build_rakuten_shipments` | Every 10 min at :07/:17/:27... |
| `8,18,28,38,48,58 * * * *` | `push_rakuten_orders_to_giga` | Every 10 min at :08/:18/:28... (after projection :07) |
| `5,15,25,35,45,55 * * * *` | `pull_giga_tracking` | Every 10 min at :05/:15/:25... |
| `9,19,29,39,49,59 * * * *` | `close_shop_orders` | Every 10 min at :09/:19/:29... |
| `10,20,30,40,50 * * * *` | `sync_rakuten_tracking` | Every 10 min at :10/:20/:30... |
| `11,21,31,41,51 * * * *` | `reconcile_end_to_end` | Every 10 min at :11/:21/:31... |
| `50 14 * * *` | `reconcile_cancellations` | Once daily at 14:50 UTC (23:50 JST) |
| `0 23 * * *` | `send_payment_reminders` | Once daily at 23:00 UTC (08:00 JST) |

**Covers:** All 15 main worker phases.

**Key behavior:** Each cron invocation dispatches one or more phases sequentially within a single scheduled handler call. Phases within the same cron slot run in the order listed in `SCHEDULED_CRON_MODES`.

### Disabled Legacy Layer: Fine-grained VPS Timers

Configured in `deploy/` and installed on the ConoHa VPS, but disabled at the latest bounded readback. These units must not be enabled timer-by-timer because their grouping and cadence do not preserve the Worker capability contracts.

| Timer | Schedule | Mode | Phases Covered | Worker Equivalent |
|---|---|---|---|---|
| `pipeline-hourly.timer` | `*:01` | `hourly` (CORE_PHASES) | `pull_shop_orders`, `build_giga_shipments`, `push_orders_to_giga` | `1 * * * *` + `3,13,23...` + `6,16,26...` |
| `pipeline-pull-giga-tracking.timer` | `*:05,15,25,35,45,55` | `pull_giga_tracking` | `pull_giga_tracking` | `5,15,25,35,45,55 * * * *` |
| `pipeline-close.timer` | `*:09,19,29,39,49,59` | `close_shop_orders` | `close_shop_orders` | `9,19,29,39,49,59 * * * *` |

**Historical design coverage:** 4 of 15 phases (only Mercari CORE_PHASES + tracking + close). **Current production coverage: none, because the timers are disabled.**

**Key behavior:** The `hourly` mode runs all 3 CORE_PHASES sequentially in a single invocation at :01, unlike the Worker which staggers them across different minutes. This is a simplification/difference from the Worker schedule. Rakuten pipeline phases, message sync, auto-approval, cancellation reconcile, payment reminders, and end-to-end reconcile are NOT covered by systemd timers.

### Current Reporting Layer: VPS Sales Brief

The canonical reporting runtime is the VPS `order-mgmt-sales-brief.timer`. The repository retains sibling Worker source/history, but it is not the declared current owner.

| Cron Expression | Phase | Frequency (JST) |
|---|---|---|
| VPS calendar entries | Sales brief generation -> WeCom | 08:00, 11:00, 14:00, 17:00, 20:00, 22:00 |

**Covers:** 1 workload (`ordermgmt_sales_brief_reporting`).

**Key behavior:** Reads from Supabase `sales_orders`, applies the freshness gate, and sends formatted markdown to WeCom. The systemd unit has an independent deployment lifecycle. Direct Cloudflare API readback found neither historical sibling reporting Worker.

### Target Layer: Canonical VPS Orchestrator

`order-mgmt-orchestrator.timer` starts the dependency-gated DAG. Shadow is the default. Live mode requires the global live gate plus at least one exact `ORCHESTRATOR_ENABLE_*` capability flag; each capability remains disabled until its legacy trigger is retired and ownership is read back. A manual canary additionally requires one declared exact-scope capability, one order, global `limit=1`, and a Mercari shop where applicable; it skips all other units and never auto-runs dependencies. Unsupported queue-head scopes fail closed. This target unit is installed and enabled only in shadow mode; Cloudflare remains the production business owner.

### Coverage Gap

| Scheduling Layer | Phases Covered | Coverage |
|---|---|---|
| Current main Worker cron | 13 directly enumerated business schedules | Current scheduler evidence captured at 16:03 JST |
| Disabled legacy VPS timers | Historical subset | No current production ownership |
| Current VPS sales-brief timer | 1 reporting workload | Enabled/active at latest bounded readback |
| Target canonical VPS orchestrator | Cross-platform dependency DAG | Immutable shadow installed/enabled; first run accepted; all live capability flags false |

---

## External Write Safety Amplification

The central `SYNC_WORKLOAD_GOVERNANCE.md` policy requires additional safety declarations for `external_write` workloads. The following OrderMgmt workloads are classified as `external_write`:

| Workload | Risk | External Target | Idempotency Key | Unknown-Result Handling | Reconciliation Path |
|---|---|---|---|---|---|
| `ordermgmt_giga_order_push` | High | GigaB2B API (order creation) | Durable capability/platform/store/order/payload-hash operation key | `UNKNOWN_RESULT`; no age-based or transport retry | Verified Giga lookup when contracted; until then evidence-gated single-operation resolution |
| `ordermgmt_rakuten_order_push` | High | GigaB2B API (order creation) | Same durable operation-key contract, channel isolated | `UNKNOWN_RESULT`; no age-based or transport retry | Same governed resolution; Mercari evidence must not resolve Rakuten operations |
| `ordermgmt_shop_order_close` | High | Mercari Shops close API | Durable order/payload operation key | Exact status readback; unresolved ambiguity remains `UNKNOWN_RESULT` | Exact marketplace status or evidence-gated operator resolution |
| `ordermgmt_rakuten_order_close` | High | Rakuten RMS close API | Durable order/payload operation key | Exact RMS progress readback; unresolved ambiguity remains `UNKNOWN_RESULT` | Remains unscheduled until contract verification and canary; then exact RMS evidence or governed resolution |
| `ordermgmt_payment_reminder` | High | Mercari customer messages | Persisted per-order/day reservation | `UNKNOWN_RESULT`; no automatic resend by age | Provider message evidence or evidence-gated operator resolution |
| `ordermgmt_rakuten_order_confirm` | High | Rakuten RMS confirm API | Durable capability/platform/store/order/payload-hash operation key | Exact-ID RMS readback; otherwise `UNKNOWN_RESULT` | Exact RMS progress or evidence-gated operator resolution |
| `ordermgmt_end_to_end_reconcile` | High | GigaB2B and Mercari via nested legacy phases | No independent intent boundary beyond invoked writers | Inherits nested writer ambiguity | Retire scheduled legacy wrapper; replace with read-only `audit_pipeline_integrity` |

---

## State Definitions

### Lifecycle State

| State | Meaning |
|---|---|
| `active` | Intended to run in production |
| `migrating` | Moving between runtimes, repos, or schedules |
| `retiring` | Scheduled for removal; still running during transition |
| `retired` | No longer running; retained for historical reference |

All 17 workloads currently `active`.

### Deployment State

| State | Meaning |
|---|---|
| `scheduled` | Registered in scheduler (cron, timer, CF trigger) |
| `deployed` | Code is present on the runtime host |
| `disabled` | Scheduler entry exists but is commented out or stopped |
| `absent` | No scheduler entry or deployed code on the runtime host |

All 17 workloads are intended to be scheduled and deployed. The bounded 2026-09-07 check found the main Cloudflare Worker cron set present, all installed VPS pipeline timers disabled, and the VPS sales-brief timer enabled. This does not prove each workload's complete operational correctness. The repository still contains contradictory Rakuten-close scheduling/contract statements that require the Phase 0 audit.

### Operational State

| State | Meaning |
|---|---|
| `healthy` | Running successfully within expected parameters |
| `degraded` | Running with known issues; output still usable |
| `broken` | Failing; output unreliable or absent |
| `paused` | Intentionally stopped by operator |
| `unknown` | Runtime state has not been verified recently |

Operational correctness remains `unknown` for the inventory as a whole. Bounded scheduler/execution evidence is recorded above, but it does not establish per-order accounting, external-write correctness, sibling-reporting trigger state, or the absence of historical ambiguous mutations.

---

## Drift Log

| Date | Workload ID | Drift description | Resolution |
|---|---|---|---|
| 2026-07-19 | _global_ | CLAUDE.md only documents 6 Mercari pipeline phases; omits 9 Rakuten, message sync, auto-approval, payment reminders, and reporting phases. | SYNC_JOB_INVENTORY.md created; CLAUDE.md updated with reference. |
| 2026-07-19 | _global_ | Code uses `createBaserowClient` naming throughout but the actual database backend is Supabase (`DATABASE_BACKEND = "supabase"`). Name is a migration artifact from the Baserow era. | No immediate action — naming is cosmetic. Track for cleanup when Supabase migration is fully complete. |
| 2026-07-19 | _global_ | VPS systemd timers only cover 4 of 15 Worker phases (CORE_PHASES + tracking + close). No timers exist for the Rakuten pipeline, message sync, auto-approval, cancellation reconcile, payment reminders, or end-to-end reconcile. | Documented in Scheduling Architecture section. Evaluate whether VPS coverage should be expanded for business continuity. |
| 2026-07-19 | _global_ | No per-phase environment-variable kill switch exists for any workload. Kill switch currently requires code/wrangler.toml change and redeployment. | Gap identified. Consider adding env-var kill switches (e.g., `DISABLE_PHASE_<NAME>=true`). |
| 2026-07-19 | ordermgmt_rakuten_order_confirm | `confirm_rakuten_orders` resets `confirm_in_progress` flag on relay failure, which could cause partial double-processing of an already-partially-confirmed batch. | Acceptable risk — RMS confirmation has its own idempotency. |

---

## Change Log

| Version | Date | Changes |
|---|---|---|
| v2.44.0 | 2026-09-07 | Bind live sales-brief intent to the exact current scheduled JST slot; reject backdated, future and off-schedule overrides. |
| v2.43.0 | 2026-09-07 | Require authoritative WeCom errcode evidence for definitive report rejection; classify HTTP-only and malformed failures as UNKNOWN_RESULT. |
| v2.42.0 | 2026-09-07 | Disable sales-brief service auto-restart so ambiguous WeCom delivery cannot enter a process retry loop; recovery follows ledger reconciliation. |
| v2.41.0 | 2026-09-07 | Correct sales-brief workload classification to external_write/Medium, prove freshness precedes intent claim, and add a dedicated production delivery-canary/readback gate. |
| v2.40.0 | 2026-09-07 | Add intent-first, slot-stable sales-brief delivery through the external-operation ledger; duplicate and unknown results now fail closed instead of re-sending WeCom. |
| v2.39.0 | 2026-09-07 | Harden the target sales-brief unit to use the non-root canonical service identity, immutable release and protected environment; mark the old root deployment plan historical. |
| v2.38.0 | 2026-09-07 | Remove the stale claim that Rakuten close is outside the DAG; distinguish represented/default-off control coverage from provider-contract acceptance. |
| v2.37.0 | 2026-09-07 | Add executable #265 fulfillment/reminder boundary proof that stale evidence reaches no runner, Marketplace read or send. |
| v2.36.0 | 2026-09-07 | Add structured sales-brief execution and #265 proof that stale lifecycle evidence blocks before reads or delivery. |
| v2.35.0 | 2026-09-07 | Add canonical-document drift tests for superseded orchestration claims and target/deployed boundaries. |
| v2.34.0 | 2026-09-07 | Add exact Mercari orderTransaction ingestion with shop/order database scope and no unrelated terminal sweep; complete the DAG canary matrix. |
| v2.33.0 | 2026-09-07 | Add exact Rakuten discovery via the bounded RMS getOrder full-order contract; retain Mercari discovery fail-closed. |
| v2.32.0 | 2026-09-07 | Add read-only platform/order-scoped integrity canaries without cross-platform scans or false global completion. |
| v2.31.0 | 2026-09-07 | Scope message ingestion and payment-reminder canaries across candidate, freshness, webhook-retry and ambiguous-reservation branches. |
| v2.30.0 | 2026-09-07 | Add pre-limit exact shop/order scope to Mercari auto-approval and admit it to the guarded canary matrix without bypassing safety gates. |
| v2.29.0 | 2026-09-07 | Add an exact-order, ownership-gated single-capability live-canary path; propagate Mercari projection/tracking/close scope and reject unsupported canaries. |
| v2.28.0 | 2026-09-07 | Add exact-order lifecycle reconciliation for both marketplaces without allowing scoped runs to publish global freshness. |
| v2.27.0 | 2026-09-07 | Apply exact order scope and a true global limit to Mercari/Rakuten tracking before Giga reads or local writes. |
| v2.26.0 | 2026-09-07 | Propagate exact normalized order scope into Rakuten confirmation selection and shipment projection before limiting or mutation. |
| v2.25.0 | 2026-09-07 | Add workload-scoped disabled-state quiescence readback covering legacy dispatch, unterminated runs, lease, open operations and exact-release shadow acceptance. |
| v2.24.0 | 2026-09-07 | Require an explicit disabled/quiescent ownership state before any workload can transfer from Cloudflare/absent to the VPS orchestrator. |
| v2.23.0 | 2026-09-07 | Add authoritative manual-shadow acceptance bound to release/owner, full DAG terminal states, skip evidence, lease release and zero legacy audit writes. |
| v2.22.0 | 2026-09-07 | Bind every canonical orchestrator start to the loaded immutable source, current pointer and exact release SHA before lease/workload execution. |
| v2.21.0 | 2026-09-07 | Add a PII-free per-phase comparison of shadow step counts with current production cron audit counts; parity remains manual and unproven. |
| v2.20.0 | 2026-09-07 | Add a read-only seven-complete-day shadow cadence/terminal/step-safety audit that cannot masquerade as production-output parity. |
| v2.19.0 | 2026-09-07 | Add immutable, main-reachable, disabled-only canonical orchestrator installation with explicit shadow-env and inactive-state readback. |
| v2.18.0 | 2026-09-07 | Align repository entrypoint and operations/deployment documentation with current Worker relay transport versus target VPS direct-local transport. |
| v2.17.0 | 2026-09-07 | Add the target Rakuten-close DAG capability and a dedicated default-off live gate without scheduling or authorizing the unverified write. |
| v2.16.0 | 2026-09-07 | Route VPS Rakuten discovery, exact lifecycle reads, confirmation and close through a bounded local IPv4 RMS adapter while retaining Worker relay transport and all write gates. |
| v2.15.0 | 2026-09-07 | Inject local IPv4 Mercari read/write adapters into VPS payment reminders without changing freshness, reservation or ambiguity gates. |
| v2.14.0 | 2026-09-07 | Inject the IPv4 local Mercari message reader into VPS scheduled sync while preserving folded webhook retry. |
| v2.13.0 | 2026-09-07 | Inject an IPv4-forced local exact-status reader into VPS Mercari lifecycle reconciliation while retaining Worker relay transport. |
| v2.12.0 | 2026-09-07 | Execute VPS Mercari close directly through the canonical local ledger/readback script with structured child failure accounting. |
| v2.11.0 | 2026-09-07 | Execute VPS Mercari discovery directly through a Node-only local runner while retaining Worker relay transport. |
| v2.10.0 | 2026-09-07 | Submit validated scoped Portal bulk-approval targets while retaining fail-closed legacy compatibility. |
| v2.9.0 | 2026-09-07 | Add scoped Portal drawer targets across detail and single-order mutations while preserving displayed business IDs. |
| v2.8.0 | 2026-09-07 | Fail closed when Portal order-ID lookup resolves to multiple channel/store scopes. |
| v2.7.0 | 2026-09-07 | Scope Mercari shipment projection grouping before allocation, line numbering, limiting and mutation. |
| v2.6.0 | 2026-09-07 | Quarantine cross-store tracking-ID collisions and scope sales tracking writes by channel/store/order. |
| v2.5.0 | 2026-09-07 | Scope terminal integrity-audit shipment joins by channel, source store and normalized order ID. |
| v2.4.0 | 2026-09-07 | Scope Worker stuck-order diagnostic joins by source store and normalized order ID. |
| v2.3.0 | 2026-09-07 | Scope Portal backlog joins and order-count metrics by channel, source store and normalized order ID. |
| v2.2.0 | 2026-09-07 | Scope cancellation before/after detection and shipment invalidation by source store plus normalized order ID. |
| v2.1.0 | 2026-09-07 | Retire the unused singular Mercari close relay endpoint and its configurable legacy script path; retain only the governed batch endpoint. |
| v2.0.0 | 2026-09-07 | Enforce `(source_store_id, order_id)` identity through Mercari auto-approval grouping and downstream safety/write calls. |
| v1.9.0 | 2026-09-07 | Make message-sync dry-run suppress failure-state writes and isolate same-number orders by source store plus order ID. |
| v1.8.0 | 2026-09-07 | Make dry-run audit log-only so a preview cannot mutate `pipeline_run_log`; live execution retains durable audit persistence. |
| v1.7.0 | 2026-09-07 | Restore true Mercari/Rakuten tracking previews: retain scoped Giga reads but skip all shipment/sales patches and report planned updates with zero side effects. |
| v1.6.0 | 2026-09-07 | Restore true Mercari/Rakuten shipment projection previews that report planned row changes while proving create/patch/delete remain uncalled. |
| v1.5.0 | 2026-09-07 | Restore a true Mercari/Rakuten Giga outbound preview: reuse candidate collection and validation but never invoke the sync writer or any provider/database mutation path. |
| v1.4.0 | 2026-09-07 | Make Worker admin runs dry-run only and fail closed before invoking projection, Giga outbound, tracking or legacy end-to-end phases whose preview paths are not yet proven side-effect free. |
| v1.3.0 | 2026-09-07 | Add the bilateral runtime fence: Cloudflare scheduled phases step down on durable ownership transfer or registry read failure; require evidence observed within 24 hours and expose ownership block reasons through the control plane. |
| v1.2.0 | 2026-09-07 | Require every enabled live orchestrator unit to pass an exact, unexpired durable ownership check for workload, VPS host, release, enabled state and legacy-trigger retirement before phase execution. |
| v1.1.0 | 2026-09-07 | Record direct Cloudflare schedule API evidence: all 13 main Worker crons present and both historical reporting Worker names absent; no trigger mutation performed. |
| v1.0.0 | 2026-09-07 | Separate bounded current scheduler facts from the target architecture; stop describing disabled legacy VPS timers as a secondary path; correct sales-brief ownership, legacy end-to-end reconcile risk, reminder ambiguity handling, and durable external-write recovery contracts. |
| v0.9.0 | 2026-09-07 | Record 15:45 JST bounded Wrangler deployment and VPS systemd readback; distinguish the enabled CatalogSync listing timer and retain direct Cloudflare trigger readback as a blocker. |
| v0.8.1 | 2026-09-07 | Make the terminal integrity audit channel-isolated and cross-platform with separate Mercari/Rakuten accounting. |
| v0.8.0 | 2026-09-07 | Add the branch-only expiring, evidence-backed scheduler ownership registry, immutable events, CAS operator CLI and Portal projection. |
| v0.7.0 | 2026-09-07 | Add env-driven orchestrator mode and fail-closed per-capability ownership flags for governed incremental cutover. |
| v0.6.1 | 2026-09-07 | Require per-phase non-PII completion/outcome accounting in durable DAG steps rather than invocation counts alone. |
| v0.6.0 | 2026-09-07 | Record the cross-platform DAG, per-phase durable steps, branch-local failure isolation, independent message ingestion, reminder dependency and integrity audit. |
| v0.5.0 | 2026-09-07 | Define the canonical null-as-full-accounting phase limit and remove conflicting zero/default semantics from target orchestrator workloads. |
| v0.4.1 | 2026-09-07 | Record control-plane review hardening: normalized cross-table IDs, Mercari-scoped deterministic backlog reads, canonical lease selection, real live executor identity, and visible truncation. |
| v0.4.0 | 2026-09-07 | Record the branch-only authenticated control-plane API/UI, evidence-qualified scheduler ownership, local kill-switch scope, and bounded backlog semantics. |
| v0.3.2 | 2026-08-30 | Narrow the `reconcile_end_to_end` pipeline-health sales and shipment projections after post-remediation measurement identified health snapshot reads as the largest remaining payload. |
| v0.3.1 | 2026-08-30 | Narrow the measured `push_orders_to_giga` and `pull_giga_tracking` Supabase projections, and reuse one outbound collection snapshot for dry-run plus sync. Production decoded JSON measurements identified these as major response-size hot paths; decoded size remains an attribution estimate, not billing-meter egress. |
| v0.3.0 | 2026-08-30 | Add per-phase Supabase client identity and response-byte attribution contract for OrderMgmt #217. |
| v0.2.0 | 2026-08-26 | Add scheduled Rakuten RMS close after tracking sync; 17 workloads. |
| v0.1.0 | 2026-07-19 | Initial inventory — baseline reconstructed. Covers 16 workloads across 3 scheduling layers. |
