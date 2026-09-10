# OrderMgmt Canonical Architecture

Status: **Canonical current architecture**  
Last reconciled: 2026-09-07  
Related: #260, #265

This document is the single source of truth for OrderMgmt's current system architecture. Detailed operational inventories, database rules, deployment runbooks, and historical design documents remain authoritative only for their narrower subjects. When another top-level document conflicts with this file about current architecture, this file wins unless newer production evidence shows that reconciliation is required.

## 1. System purpose

OrderMgmt is Retailpulses' multi-platform order-operations system. It ingests and manages marketplace orders, supports operator review and customer messaging, orchestrates fulfillment through GigaB2B, reconciles tracking and order lifecycle state, and exposes the internal Order Portal.

Current first-class marketplace channels are Mercari Shops and Rakuten. Amazon-related documents are plans unless explicitly promoted by later production evidence.

## 2. System boundary and ownership

OrderMgmt owns the `order_management` business domain in the shared Supabase project.

OrderMgmt does **not** own the canonical product catalog. Product/catalog data owned by RPagentOS must be consumed through the governed internal API boundary rather than by creating a second canonical catalog or introducing new direct cross-domain database coupling.

Supabase is the canonical business datastore for OrderMgmt. Baserow is legacy/compatibility infrastructure and must not be expanded without explicit governance approval.

## 3. Current runtime topology

```text
Marketplace operators
        |
        v
order.homesbliss.net
        |
Cloudflare Tunnel / edge routing
        |
        v
ConoHa VPS
  +-- nginx -> React/Vite Portal SPA
  +-- Hono Portal API
  +-- marketplace relay / fixed-egress integration boundary
  +-- selected systemd-scheduled workloads
        |
        +--------------------+
        |                    |
        v                    v
    Supabase           Mercari / Rakuten
 order_management             APIs
        |
        +--------------------+
        |
        v
Cloudflare Worker
  +-- scheduled order workloads
  +-- webhook/admin/compatibility endpoints
        |
        v
      GigaB2B
```

The diagram describes implemented and declared architecture. It does not claim that every declared systemd timer or Cloudflare cron is live at audit time; runtime activation must be verified from the hosting environment when operational behavior depends on it.

## 4. Major components

### Portal SPA

- Source: `portal/`
- React + Vite + TypeScript.
- Built in CI and served from the VPS through nginx.
- The legacy inline Worker Portal UI is retired and is not a rollback target.

### Portal API

- Source: `portal-api/`
- Node/Hono API on the VPS.
- Primary backend for the Portal.
- Uses Supabase service-side access and the VPS relay where marketplace operations require it.

### Supabase order domain

- Schema migrations: `supabase/migrations/`.
- Canonical store for OrderMgmt business state.
- Domain ownership and schema changes are governed by the central database governance policy plus repository-local declarations.

### Cloudflare Worker

- Source: `worker/` plus shared `src/lib/` modules.
- Runs scheduled order workloads and webhook/admin/compatibility paths.
- It is **not** the primary Portal runtime.
- Cloudflare-specific behavior must remain separable from core domain logic in line with platform-dependency policy.

### VPS relay

- Source: `relay/`.
- Fixed-egress marketplace integration boundary, particularly where marketplace APIs require stable network origin or server-side credentials.
- Marketplace-specific behavior should remain adapter/integration logic rather than define the core order domain.
- Rakuten inquiry transport uses route-scoped credentials: ingestion may access list, detail, and
  attachment routes; send may access only reply. Neither credential falls back to the shared
  OrderMgmt/Mercari relay secret.

### VPS scheduled execution

- Sources: `vps/` and `deploy/*.timer` / systemd definitions.
- Provides declared execution paths for selected pipeline/reporting workloads.
- Repository declarations are not equivalent to runtime verification; verify active timers on the VPS before making production scheduling assumptions.

### Accepted target orchestrator (Issue #265)

- A single VPS-started Node orchestrator is the accepted target business scheduler. It runs a cross-platform dependency DAG and records durable run/step, lease, freshness, ownership, external-operation intent, and readback evidence in Supabase.
- Marketplace adapters execute locally on the fixed-egress VPS; Cloudflare remains an edge/API/monitoring component after business-scheduler retirement.
- Reporting remains a separate canonical VPS consumer and must pass lifecycle freshness plus external-delivery-ledger gates.
- The target control plane and orchestrator are deployed as an immutable VPS shadow release with an hourly timer and one accepted 17-step run. Current production business scheduling remains Cloudflare cron; every VPS live capability is disabled and installed legacy VPS pipeline timers remain disabled.
- Ownership transfers one capability at a time through `current owner -> disabled/quiescent -> VPS owner`. Direct Cloudflare-to-VPS transfer is forbidden. Exact canary, authoritative readback, and seven complete JST days of shadow parity are mandatory gates.
- Rakuten close is represented in the DAG but remains default-off until its provider contract and live canary are verified. No authoritative Giga order-lookup contract is assumed.

### Local CLI and maintenance tooling

- `src/index.mjs` and `scripts/` support replay, diagnostics, repair, migration, and maintenance.
- One-off scripts are not automatically part of canonical production architecture merely because they exist in the repository.

## 5. Canonical data and integration flow

At architecture level, the order lifecycle is:

```text
Mercari / Rakuten
       |
       v
marketplace adapters / relay / ingestion
       |
       v
Supabase: order_management
       |
       +--> operator review / Portal / messaging
       |
       +--> fulfillment projection and outbound sync --> GigaB2B
       |                                                   |
       +<------------- tracking / fulfillment reconciliation+
       |
       +--> marketplace lifecycle updates / close / messages
```

The exact production workload list, cadence, write scope, idempotency controls, overlap and kill-switch declarations live in `docs/SYNC_JOB_INVENTORY.md`. That inventory is authoritative for declared workload facts but must state its runtime-verification status.

## 6. Data ownership rules

1. Supabase is the source of truth for OrderMgmt business data.
2. Baserow is legacy/compatibility only; new canonical business entities must not be created there.
3. `order_management` is owned by OrderMgmt.
4. Cross-domain data such as canonical product catalog remains owned by its declared owner and is consumed through governed interfaces.
5. Marketplace APIs are integration boundaries, not canonical domain stores.
6. Database migrations and ownership changes follow `docs/16_DATABASE_GOVERNANCE.md` and central `rp-governance-kit` policy.

## 7. Architecture invariants

- Core order business logic should remain reusable and marketplace-neutral where practical.
- Mercari/Rakuten-specific behavior belongs at adapters and integration boundaries.
- Portal clients must not receive service-role credentials.
- Production writes must preserve idempotency and lifecycle invariants.
- A compatibility path must not silently become a second source of truth.
- A declared deployment definition must not be described as runtime-active without runtime evidence.
- Architecture-affecting changes must reconcile this document before their bounded change/phase is closed.
- Every scheduled capability has exactly one production scheduler owner; file presence or timer installation is not ownership evidence.
- Unknown external-write results are never retried merely because time elapsed; reconciliation requires authoritative provider evidence.
- Downstream fulfillment, reminders, reporting, and marketplace writes fail closed on missing, partial, failed, future-dated, or stale lifecycle evidence.

## 8. Legacy and compatibility boundaries

### Baserow

Legacy. Existing compatibility code and historical migration tooling may remain while retirement is incomplete. Its presence in source code does not make Baserow a canonical datastore.

### Cloudflare KV / legacy Portal state

Compatibility only where still retained during post-cutover parity/retirement work. Supabase is the target/canonical business-state layer.

### Worker Portal endpoints

Legacy/compatibility and diagnostic paths may remain, but the VPS Portal SPA/API is the primary Portal architecture.

### Historical architecture documents

`OrderMgmt架构分析报告.md`, migration plans, cutover plans, audits, TRDs, and issue plans are evidence/history unless explicitly designated current canonical state. They must not override this document merely because they contain more implementation detail.

## 9. Evidence model

Architecture statements should distinguish these states when ambiguity matters:

- **Implemented** — present in current code/schema/deployment definitions.
- **Declared** — recorded in governed inventory/configuration.
- **Deployed** — deployment evidence confirms release to an environment.
- **Runtime verified** — the live environment has been directly checked.

Do not promote `implemented` or `declared` to `runtime verified` without evidence.

## 10. Canonical reading order

For architecture-affecting work:

1. `docs/00_CURRENT_STATE.md` — concise operational snapshot.
2. `docs/01_ARCHITECTURE.md` — canonical system architecture (this file).
3. `docs/05_DECISION_LOG.md` and applicable ADR/design/TRD — rationale/history.
4. `docs/16_DATABASE_GOVERNANCE.md` when data/schema is affected.
5. `docs/SYNC_JOB_INVENTORY.md` and `docs/17_SYNC_WORKLOAD_GOVERNANCE.md` when production workloads are affected.
6. Relevant deployment/runbook documents and actual runtime evidence when production activation matters.

If implementation or runtime evidence contradicts this file, treat that as architecture drift: do not silently choose one description. Reconcile the architecture explicitly.
