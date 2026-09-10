# ADR-001: Commerce Ops monorepo boundaries

Status: Accepted
Date: 2026-09-10

## Context

Order management, presales inquiries, post-sales tickets and the Ops Portal increasingly share operator workflows, platform integration concerns and release coordination. Maintaining them in separate repositories creates duplicated governance, fragmented issues and cross-repo change friction.

At the same time, these systems have distinct business authority and independently releasable runtimes. Order management extends into fulfillment and marketplace lifecycle; Inquiry owns presales; Ticketing owns post-sales case resolution; Ops Portal is an operator shell/gateway.

## Decision

Consolidate source ownership into `retailpulses/commerce-ops` while preserving bounded domains and independent runtime/deployment boundaries.

Initial source layout:

```text
commerce-ops/
├── apps/
│   ├── ops-portal/
│   ├── inquiry/
│   ├── orders/
│   └── tickets/
├── packages/          # intentionally empty during initial migration
└── docs/
```

### Routing concept

```text
Mercari / Rakuten / Amazon
        ↓
platform integration boundary
        ↓
   presales  → Inquiry
   order     → Orders
   post-sale → Ticketing
        ↓
Ops Portal presents/coordinates operator workflows
```

## Explicit non-decisions

This ADR does **not** approve:

- merging the three Supabase domain models;
- a single runtime/Worker for all domains;
- a single deployment or rollback boundary;
- one universal platform client/package during migration;
- one broad Supabase service credential;
- moving lifecycle authority into Ops Portal;
- changing production routes, schedulers, webhook endpoints or external-write behavior.

## Migration strategy

1. Import sanitized current-tree snapshots only.
2. Preserve each application's internal structure initially.
3. Prove complete source/build/test parity from monorepo paths.
4. Map GitHub secrets/environments without moving runtime-held secrets unnecessarily.
5. Prove deployment/runtime parity and rollback from the monorepo.
6. Archive old repos only after parity is proven.
7. Establish unified staging after source/runtime ownership stabilizes.
8. Consider shared-package extraction only after staging and evidence of a genuinely shared contract.

## Public target constraint

During this migration `commerce-ops` is public while source repositories are private. Full private Git history must not be imported. Sensitive operational evidence remains in the original private repositories. Current-tree import is sanitized and source revision provenance is recorded.

## Consequences

Positive:

- one coordination surface for Inquiry → Order → Ticket operator workflows;
- easier cross-domain issue/PR review;
- shared governance and future path-scoped CI;
- clearer path toward a unified staging strategy;
- later platform-adapter reuse becomes possible without forcing it prematurely.

Costs/risks:

- monorepo CI can amplify Actions usage unless path-scoped;
- source-path changes can break VPS/Cloudflare deployment assumptions;
- shared-code proximity can tempt domain coupling;
- public visibility requires stricter source/history/secret hygiene.

## Invariants

- Repo consolidation ≠ domain consolidation.
- Source location ≠ runtime location.
- No intentional runtime behavior change during initial consolidation.
- Inquiry, Orders and Ticketing retain explicit state ownership.
- Ops Portal remains the whole operator shell/gateway.
