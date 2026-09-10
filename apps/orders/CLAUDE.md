# CLAUDE.md — OrderMgmt

## Role

Act as an implementation partner for OrderMgmt. Preserve system context, business invariants, governance, and production safety while moving quickly.

This file is **agent/developer guidance, not an architecture source of truth**. Do not duplicate or reconstruct the current architecture here.

## Mandatory reading order

Before mergeable work:

1. Read `docs/00_CURRENT_STATE.md` for the concise operational snapshot.
2. Read `docs/01_ARCHITECTURE.md` for canonical current architecture, boundaries, ownership, major flows, legacy classifications, and evidence status.
3. Read the governing Issue and relevant design/TRD/decision material.
4. If data/schema is affected, read `docs/16_DATABASE_GOVERNANCE.md` and `docs/16_DATABASE_GOVERNANCE.local.md` plus central database governance.
5. If a production sync workload is affected, read `docs/SYNC_JOB_INVENTORY.md` and `docs/17_SYNC_WORKLOAD_GOVERNANCE.md`.
6. If deployment/runtime activation matters, inspect the relevant deployment definitions and obtain runtime evidence rather than inferring live state from repository files.

If code, deployment evidence, runtime evidence, or another document conflicts with `docs/01_ARCHITECTURE.md`, treat it as **architecture drift**. Stop architecture assumptions, identify the conflict, and reconcile the canonical architecture as part of the bounded change.

## Repository identity

OrderMgmt is Retailpulses' multi-platform order-operations system. Current first-class channels include Mercari Shops and Rakuten; GigaB2B is the fulfillment integration. The repository owns the `order_management` domain.

Do not infer current component topology, database primacy, or workload activation from this summary. Use the canonical architecture and workload inventory.

## Engineering workflow

- All mergeable engineering work is Issue-first.
- Before coding, establish user impact, system impact, data impact, architecture impact, and documentation impact.
- Small patches may stay small. Do not turn an unrelated patch into an unbounded refactor.
- Feature/architecture work should have an explicit bounded change/phase with scope and non-goals.
- Architecture-affecting work is not complete until implementation/deployment evidence and canonical architecture are reconciled.
- Do not describe `implemented` or `declared` state as `runtime verified` without live evidence.

## Architecture and business-logic rules

- Supabase is the canonical OrderMgmt business datastore.
- Baserow is legacy/compatibility and must not be expanded without explicit governance approval.
- OrderMgmt owns `order_management`; do not create duplicate canonical entities for another domain.
- Canonical product/catalog ownership is external to OrderMgmt and must be consumed through the governed RPagentOS boundary.
- Keep core order logic reusable and marketplace-neutral where practical.
- Keep Mercari/Rakuten-specific behavior in adapters/integration boundaries.
- Cloudflare-specific behavior must not become unavoidable core business logic.
- Compatibility paths must not silently become a second source of truth.

## Source areas

Use `docs/01_ARCHITECTURE.md` for current roles. The principal source areas are:

- `portal/` — Portal SPA.
- `portal-api/` — Portal backend API.
- `src/lib/` — shared order/domain/integration modules.
- `worker/` — Cloudflare Worker execution/HTTP paths.
- `relay/` — VPS marketplace relay.
- `vps/` and `deploy/` — VPS scheduling/deployment definitions.
- `supabase/migrations/` — OrderMgmt schema migrations.
- `src/index.mjs` and `scripts/` — CLI, diagnostics, migration, repair, and maintenance tooling.

The existence of a script, timer, Worker route, or compatibility module does not by itself make it canonical production architecture.

## Running locally

```bash
npm ci
npm run build
npm run test
```

Use package-specific commands under `portal/` and `portal-api/` when working on those components.

Prefer dry-run/read-only diagnostics before hosted writes. Production mutations, migrations, deployment, and scheduling changes must follow the relevant governance and approval gates.

## Database governance

Before any Supabase, migration, schema, RLS, Storage, or generated-types work:

1. Read `docs/16_DATABASE_GOVERNANCE.md`.
2. Follow canonical policy in `retailpulses/rp-governance-kit` → `docs/DATABASE_GOVERNANCE.md`.
3. Read `docs/16_DATABASE_GOVERNANCE.local.md`.
4. Check central database ownership/capability declarations.

Central governance wins unless repository rules are stricter. If there is a conflict, stop and report it.

Migration naming: `YYYYMMDDHHMMSS_description.sql`, unique across Retailpulses repositories.

## Sync workload governance

The authoritative declared inventory is `docs/SYNC_JOB_INVENTORY.md`.

Before creating, changing, replacing, enabling, disabling, or deleting a production sync workload:

1. Identify the existing workload ID or establish that the workload is new.
2. Search for overlapping source, target, write scope, and schedule.
3. Inspect canonical source and deployment entrypoint.
4. Confirm idempotency, retry, checkpoint, concurrency and kill-switch behavior.
5. Verify runtime state when production behavior may be affected.
6. Update the inventory in the same PR when governed facts change.
7. Report repository/runtime mismatches as governance drift; do not silently auto-remediate them.
8. Include cutover and retirement steps when replacing another workload.

## Change closeout

Before declaring an architecture-affecting change complete:

- Verify the implementation matches the approved scope.
- Capture deployment/runtime evidence appropriate to the change.
- Update `docs/00_CURRENT_STATE.md` if operational state changed.
- Reconcile `docs/01_ARCHITECTURE.md` if architecture changed.
- Record material architectural/business decisions in the appropriate decision/ADR mechanism.
- Update workload/database inventories when governed facts changed.
- Explicitly identify unresolved drift or follow-up rather than hiding it in prose.

## Historical documents

Plans, audits, TRDs, migration documents, and `OrderMgmt架构分析报告.md` can be useful evidence but may describe earlier architecture. Check their date/status and reconcile against `docs/01_ARCHITECTURE.md` before using them as current implementation guidance.