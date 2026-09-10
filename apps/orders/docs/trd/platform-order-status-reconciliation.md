# TRD: Platform-Aware Order Status Reconciliation

## Status

Proposed. This document defines a new reconciliation capability; it does not authorize production writes or deployment.

## Revision History

| Version | Date | Change |
|---|---|---|
| 0.2 | 2026-09-03 | Make Mercari and Rakuten mandatory initial scope; define Mercari policy and legacy reconciler cutover |
| 0.1 | 2026-09-03 | Initial change request following the stale Rakuten cancellation incident |

## Problem

Order discovery and lifecycle reconciliation currently share the same Rakuten pull. The pull runs hourly but searches by order date over only the previous 72 hours. That overlap is useful for reliable discovery, yet an older order whose marketplace status changes later is no longer returned.

Order `440058-20260806-0503746783` demonstrated the gap: RMS returned `orderProgress=900` while Supabase retained `PENDING_CONFIRMATION` with missing mapping evidence. The Portal correctly failed closed, but it could not converge to the authoritative cancellation. Rakuten exposed the defect; the required correction is application-wide. Mercari currently has separate active-order ingest, terminal scanning, and a once-daily cancellation reconciler, so it also lacks one continuous, auditable non-terminal reconciliation contract.

## Decision

Keep the rolling 72-hour discovery window and add a separate, platform-aware status reconciliation workload.

- **Discovery** finds new or recently created marketplace orders and idempotently upserts them.
- **Reconciliation** selects locally non-terminal orders, reads their current marketplace status by exact external order ID, and persists authoritative lifecycle evidence.
- A marketplace-specific policy defines status mapping, terminality, query cadence, batching, and retry behavior.

Discovery must not be treated as evidence that older active orders are current.

## Goals

- Eventually converge every locally non-terminal order to the marketplace's authoritative status.
- Detect late cancellation, completion, payment, confirmation, and shipment transitions outside the discovery window.
- Reuse one status mapping contract across ingest, reconciliation, Portal gates, projection, push, and close.
- Preserve idempotency, operator-owned fields, and unrelated orders when one marketplace read fails.
- Make freshness, backlog, failures, and unknown statuses visible to operators.

## Non-Goals

- Removing or shortening the 72-hour discovery safety buffer.
- Polling terminal orders indefinitely.
- Treating Portal page views as the primary synchronization mechanism.
- Automatically confirming, shipping, canceling, refunding, or messaging marketplace orders.
- Guessing unknown marketplace statuses or repairing historical rows without an authoritative read.
- Enabling Amazon or other platforms before their terminal-state contracts are verified. Mercari and Rakuten are both mandatory initial scope.

## Capability Ownership and Data Flow

OrderMgmt owns the `order_management` lifecycle and is the sole writer of reconciled status evidence in `sales_orders`.

```text
Supabase non-terminal candidates
  -> platform policy and cadence filter
  -> exact-ID marketplace read via approved connector/relay
  -> normalized status observation
  -> guarded idempotent sales_orders update
  -> Portal and downstream lifecycle consumers
```

Marketplace APIs remain authoritative for marketplace state. Supabase remains the business master for normalized operational state, audit evidence, and downstream eligibility.

## Workload Contract

Proposed workload ID: `ordermgmt_platform_order_status_reconcile`.

The scheduler invokes one phase, `reconcile_platform_order_statuses`. The phase processes platforms independently so one platform failure cannot block the others. Initial production scope is Mercari and Rakuten in the same governed change. Additional platforms require an approved policy and fixtures.

Each run:

1. Selects bounded candidate orders from Supabase using the platform policy.
2. Deduplicates line-item rows by `(sales_channel, source_store_id, order_id)`.
3. Fetches current marketplace status by exact order ID where supported, or by a complete bounded platform status scan that accounts for every selected candidate.
4. Normalizes the response through the same pure mapping contract used by ingest.
5. Writes all rows for that marketplace order consistently, subject to ownership and transition guards.
6. Records terminal, changed, unchanged, unknown, missing, failed, and deferred counts.
7. Advances retry/freshness evidence only after an authoritative response is durably persisted.

No external marketplace mutation is permitted in this phase.

## Platform Policy Contract

Every enabled platform must declare:

- supported raw statuses and their normalized lifecycle states;
- authoritative terminal statuses;
- temporarily blocking but non-terminal statuses;
- exact-ID or batch-read adapter and maximum batch size;
- cadence tiers, maximum reconciliation age, and retry/backoff rules;
- transition guards and downstream capabilities;
- redacted fixtures proving response shape and status semantics.

Missing or unknown mappings fail closed and remain eligible for reconciliation and alerting.

### Rakuten Initial Policy

| RMS `orderProgress` | Normalized status | Terminal for reconciliation | Handling |
|---:|---|---|---|
| 100 | `PENDING_CONFIRMATION` | No | Continue checking |
| 200 | `WAITING_FOR_PAYMENT` | No | RMS confirm allowed; fulfillment blocked |
| 300 | `RMS_CONFIRMED` | No | Shipment-ready; continue until fulfilled or canceled |
| 400 | `PENDING_CONFIRMATION` | No | Continue checking |
| 500 | `COMPLETED` | Yes | Stop after durable write/readback |
| 600 | `WAITING_FOR_PAYMENT` | No | RMS confirm allowed; fulfillment blocked |
| 700 | `CONFIRMED` | No | Payment complete; fulfillment blocked pending fresh 300 |
| 800 | `CANCELED` | No | Block immediately; continue until definitive 900 |
| 900 | `CANCELED` | Yes | Stop after durable write/readback |

`800` is operationally cancellation-blocked but not reconciliation-terminal. Compatibility strings remain fail-closed for fulfillment unless their semantics are verified as equivalent to the required numeric state.

### Mercari Initial Policy

| Mercari transaction status | Normalized status | Terminal for reconciliation | Handling |
|---|---|---|---|
| `WAITING_FOR_PAYMENT` | `WAITING_FOR_PAYMENT` | No | Continue checking; fulfillment blocked |
| `WAITING_FOR_SHIPPING` | `WAITING_FOR_SHIPPING` | No | Continue checking; normal review/fulfillment gates apply |
| `COMPLETING` | Existing verified completion-transition mapping | No until authoritative `COMPLETED` | Block duplicate lifecycle actions and continue checking |
| `COMPLETED` | `COMPLETED` | Yes | Stop after durable write/readback |
| `CANCELING` | `CANCELED` operationally | No | Block fulfillment and continue until `CANCELED` |
| `CANCELED` | `CANCELED` | Yes | Stop after durable write/readback and governed downstream invalidation |

Mercari reconciliation covers payment, shipping, completion, canceling, and cancellation transitions, not cancellation alone. If the Mercari API cannot fetch one transaction directly, the adapter may use paginated status queries per shop, but it must prove candidate accounting: every selected order is either matched, explicitly not found, or failed. A truncated recent-first scan is not successful reconciliation.

## Candidate Selection and Cadence

Candidate selection is database-first and server-side. For every enabled platform, include orders that meet any of these conditions:

- normalized status is not terminal;
- raw status or mapping state is missing/unknown;
- a previous reconciliation attempt is retryable;
- local terminal state lacks durable terminal source evidence.

Exclude fee/component rows from independent marketplace reads, but update all owned order lines after a successful observation. Mercari candidates include both `WAITING_FOR_PAYMENT` and `WAITING_FOR_SHIPPING`, plus any transitional/missing/unknown state that is not backed by authoritative terminal evidence.

Default cadence tiers, configurable without schema changes:

| Order age | Target cadence |
|---|---|
| 0–3 days | Hourly |
| 4–14 days | Every 6 hours |
| 15–60 days | Daily |
| More than 60 days and still non-terminal | Daily exception queue with alerting |

Each run must use a stable ordering, bounded limit, and continuation strategy so old orders cannot starve behind recent orders. Suggested ordering is `next_status_check_at`, then oldest successful observation, then order ID.

## Data Model

Reuse the existing Rakuten evidence fields for backward compatibility:

- `rakuten_order_progress`
- `rakuten_status_mapping_state`
- `rakuten_order_progress_observed_at`

Mercari requires equivalent durable raw-status, mapping-state, and observation evidence. Implementation discovery must define platform-neutral evidence rather than adding another channel-specific special case, for example:

- `marketplace_order_status_raw`
- `marketplace_order_status_mapping_state`
- `marketplace_order_status_observed_at`
- `marketplace_status_checked_at`
- `marketplace_status_changed_at`
- `marketplace_status_reconcile_error`
- `marketplace_status_reconcile_attempts`
- `marketplace_status_next_check_at`

Any schema addition requires a separate reviewed migration under OrderMgmt ownership. Do not overload `updated_at` as freshness evidence, because unrelated Portal or pipeline writes change it.

## Write, Idempotency, and Transition Rules

- The unique business identity is `(sales_channel, source_store_id, order_id)`; all non-fee line rows for one order receive the same status evidence.
- Repeat observations with identical raw status are idempotent and must not rewrite operator-owned fields.
- `observed_at` records the authoritative observation policy consistently; `changed_at`, if added, changes only when raw status changes.
- Marketplace terminal states override stale non-terminal local states.
- A partial or malformed API response never clears previously valid evidence.
- Unknown statuses persist `UNKNOWN`, block downstream actions, and remain retryable.
- Network, authentication, rate-limit, and persistence failures do not advance the successful-check watermark.
- After a terminal write, perform authoritative database readback before removing the order from the candidate set.

## Scheduling, Limits, and Backpressure

- Run independently from 72-hour discovery so discovery health and reconciliation health are distinguishable.
- Initial schedule: hourly after both platform discovery pulls, with cadence filtering performed in the candidate query.
- Use API-supported batch reads and a configurable per-run cap.
- Apply bounded exponential backoff with jitter for transient failures and honor marketplace rate-limit responses.
- Continue processing unrelated batches after an order-scoped error.
- Provide a kill switch that disables reconciliation without disabling discovery.
- Fold or retire the existing `reconcile_cancellations` schedule during cutover. There must not be two independent Mercari reconciliation writers after enablement.
- Register the new workload and its actual schedule in `docs/SYNC_JOB_INVENTORY.md` in the implementation PR.

## End-to-End Workflow Integration

Reconciliation is inserted after discovery as the recurring refresh of marketplace authority. It does not replace downstream internal healing and it must not create a parallel lifecycle state machine.

| Existing phase/capability | Integration requirement | Regression that must be prevented |
|---|---|---|
| `pull_shop_orders` / `pull_rakuten_orders` | Keep the 72-hour discovery window; share status normalizers with reconciliation | Duplicate rows, status regression, discovery outage caused by reconciliation failure |
| Review / `auto_approve_orders` | Re-check persisted platform eligibility and fail closed on canceling/canceled/missing/unknown states | Approving an order after marketplace cancellation |
| `send_payment_reminders` | Candidate must have fresh authoritative payment-pending evidence; perform its existing pre-send readback | Messaging a paid, canceled, completed, or stale order |
| `confirm_rakuten_orders` | Preserve the explicit 200/600 RMS-confirm exception; reconciliation performs no confirmation | Removing valid confirmation or treating confirmation as shipment readiness |
| `build_giga_shipments` / `build_rakuten_shipments` | Require current platform-specific projection eligibility | Projecting canceled or non-shipment-ready orders |
| `push_orders_to_giga` / Rakuten equivalent | Revalidate source eligibility immediately before external push | Pushing a projection queued before a later cancellation |
| Tracking reconciliation | Preserve terminal marketplace state while applying tracking facts | Reviving or reopening a canceled/completed order |
| `close_shop_orders` / `close_rakuten_orders` | Preserve existing mutation idempotency and authoritative close readback | Duplicate close, stale close, or reconciliation performing the mutation |
| `reconcile_end_to_end` | Continue healing internal projection/tracking/close gaps using the same terminal guards | Competing writers or contradictory lifecycle repair |
| Reporting / Portal | Read durable normalized status and freshness; no inferred freshness from `updated_at` | Stale actionable UI or incorrect revenue/status counts |

Concurrency must be resolved by order-scoped locking or compare-and-set guards around lifecycle writes. A reconciliation observation that becomes stale before persistence must not overwrite a newer terminal observation. External-write phases must read the authoritative persisted gate immediately before their mutation, not rely only on an earlier candidate list.

Implementation is incomplete until the existing end-to-end tests cover these intersections for both Mercari and Rakuten. Unit tests of the reconciler alone are insufficient.

## Observability and Operator Experience

Every run records:

- candidates, deferred by cadence, fetched, changed, unchanged, terminalized;
- missing, unknown, retryable failures, permanent failures, and oldest overdue candidate;
- platform, release SHA, run ID, duration, and API request counts;
- redacted error classification without customer PII or credentials.

Portal order detail should display the last authoritative marketplace check and current blocking reason. Monitoring must alert on:

- oldest overdue non-terminal order beyond its cadence;
- repeated platform/API failures;
- unknown raw statuses;
- local terminal state without terminal source evidence;
- reconciliation backlog growth.

## Security and Privacy

- Reuse existing marketplace credentials and fixed-IP relay paths; introduce no browser automation fallback.
- Do not log full marketplace responses, customer names, addresses, remarks, or credentials.
- The workload has read authority on marketplace orders and bounded write authority only over declared OrderMgmt-owned status/audit fields.
- Marketplace mutations remain outside this workload and require their existing explicit controls.

## Rollout and Recovery

1. Implement the pure platform policy and candidate planner with fixtures.
2. Add dry-run mode that performs candidate planning and marketplace reads but no database writes.
3. Quantify the current Mercari and Rakuten non-terminal backlogs by shop/platform and age tier.
4. Run zero-write comparisons against known Mercari lifecycle examples and Rakuten order `440058-20260806-0503746783`.
5. Enable one explicitly approved canary per platform; verify source status becomes durable normalized status in every order line.
6. Enable bounded batches, verify database readback and Portal rendering, then enable the unified schedule.
7. Disable the legacy Mercari `reconcile_cancellations` schedule only after parity is proven.
8. Observe at least two healthy cycles per platform and confirm the oldest-overdue metrics decrease.

Rollback disables only the reconciliation schedule/kill switch. Already persisted authoritative observations are retained; they must not be bulk-reverted to stale local values.

## Test Plan

- Candidate selection covers every Rakuten numeric status, missing/unknown evidence, age tiers, retries, and terminal exclusions.
- Candidate selection covers every Mercari active, transitional, and terminal source status.
- Authoritative fetch includes Mercari and Rakuten orders older than 72 hours.
- Order-level dedup performs one marketplace read and updates all owned line rows.
- Repeated identical observations are idempotent.
- `800` remains blocked and eligible; `500` and `900` become terminal after readback.
- Mercari `CANCELING` remains blocked and eligible; `COMPLETED` and `CANCELED` become terminal after readback.
- Mercari paginated/status-scan fallback proves accounting for every selected candidate and fails incomplete pages closed.
- Unknown/missing and partial responses fail closed without erasing valid evidence.
- One failed batch does not prevent unrelated batches from completing.
- Pagination and per-run limits cannot permanently starve old candidates.
- Discovery and reconciliation metrics, kill switches, and schedules remain independent.
- Portal renders fresh status and no longer shows `MISSING` after successful authoritative reconciliation.
- Race tests cover reconciliation versus review, projection, Giga push, tracking, and marketplace close; terminal/cancellation evidence always wins.
- Payment-reminder tests prove a reconciliation change to paid/canceled/completed prevents customer contact.
- Existing Mercari and Rakuten discovery, approval, projection, push, tracking, close, reporting, and `reconcile_end_to_end` suites remain green.
- A full lifecycle fixture per initial platform proves discovery -> reconciliation -> review/payment gate -> projection -> push -> tracking -> close -> terminal retirement.

## Acceptance Criteria

- The 72-hour discovery window remains unchanged and continues hourly.
- Mercari and Rakuten orders outside that window are reconciled until their platform-authoritative terminal state is durably stored.
- Mercari reconciliation covers all non-terminal lifecycle transitions, not only cancellations.
- Rakuten uses exact order ID; Mercari uses exact ID when supported or a complete, candidate-accounted paginated status query.
- `800`, missing, and unknown states remain blocked and continue to be checked.
- Mercari `CANCELING`, missing, and unknown states remain blocked and continue to be checked.
- The incident order reconciles from missing evidence to mapped RMS `900`/`CANCELED` through the governed workload, not a manual database edit.
- No reconciliation path performs a marketplace mutation or overwrites operator-owned fields.
- Failed reads never advance freshness/watermarks; successful terminal writes receive database readback.
- Backlog, freshness, unknown statuses, failures, and release identity are observable.
- Unit, integration, dry-run, canary, Portal, and two-cycle production acceptance pass.
- End-to-end regression tests cover every downstream consumer and concurrency boundary listed above before schedule enablement.
- Workload inventory and Rakuten pipeline documentation are updated in the implementation PR.
- The legacy Mercari cancellation workload is folded/retired with an explicit cutover and no overlapping writer left active.

## Open Questions for Implementation Discovery

- Confirm Rakuten `getOrder` maximum batch size and production rate limits.
- Decide whether generic audit fields should live on `sales_orders` or in a separate observation table.
- Verify whether Mercari supports efficient exact transaction lookup; otherwise specify the complete paginated candidate-accounting algorithm and cost ceiling.
- Establish a verified terminal-state policy for Amazon before enabling it.
- Set initial caps and alert thresholds from a read-only backlog measurement.

## Related Evidence

- Closed mapping/fail-closed work: GitHub Issue #212.
- Existing discovery and lifecycle contract: `docs/rakuten-order-pipeline.md`.
- Existing Mercari cancellation and terminal sync: `src/lib/cancellation-reconciler.mjs` and `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs`.
- Workload ownership and scheduling inventory: `docs/SYNC_JOB_INVENTORY.md`.
- Incident order: `440058-20260806-0503746783` (RMS `900`; stale Supabase mapping evidence at diagnosis time).
