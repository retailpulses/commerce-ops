# Commerce Ops

Unified source repository for Retailpulses operator-facing commerce operations.

## Scope

This monorepo consolidates source ownership for four existing applications while preserving their independent runtime and domain boundaries:

- `apps/ops-portal` ← `retailpulses/ops-portal`
- `apps/inquiry` ← `retailpulses/inquiry-automation`
- `apps/orders` ← `retailpulses/OrderMgmt`
- `apps/tickets` ← `retailpulses/ticket-handling`

## Migration invariant

**Repository consolidation must cause zero intentional runtime behavior change.**

During the migration we preserve existing production URLs, Cloudflare project identities, VPS service names and live paths, Supabase ownership, schedules, webhooks, marketplace write behavior, and independent rollback paths.

## Architecture

`ops-portal` remains the whole operator shell/gateway. Inquiry, Orders, and Tickets remain bounded domains and independently releasable runtimes.

Shared packages are intentionally deferred until production parity is proven and staging is established.

## Current status

Phase 0: complete — GO decision recorded in `retailpulses/inbox#100`.

Phase 1 source consolidation: complete — all four sanitized source trees, exact
provenance, monorepo-path parity, and independent path-scoped CI are on `main`.

Phase 2 production-source cutover: in progress under `commerce-ops#13`. Ops
Portal and Inquiry production surfaces now run traceable Commerce Ops releases;
Orders and Tickets remain gated on their final deploy/freshness evidence.

See `docs/MIGRATION.md` for the migration plan and acceptance criteria.
See `docs/PRODUCTION_RUNTIME_INVENTORY.md` for canonical production topology,
health/freshness signals, deployment ownership, and rollback boundaries.

## Disposable local Commerce Ops staging

With Docker Desktop running and Supabase CLI installed:

```bash
LOCAL_ENV_ALLOW_WILDCARD_BINDINGS=1 make local-env-start # after firewall/network isolation
make local-env-reset
make local-env-destroy
```

This assembles the canonical RPagentOS, Inquiry, Tickets, and Orders database
streams, runs synthetic cross-domain acceptance, and uses only local Docker
resources. It starts no application schedule or external-write adapter. See
[`docs/LOCAL_STAGING_POC.md`](docs/LOCAL_STAGING_POC.md) for safety boundaries,
migration ownership gaps, measurements, and the full command set.
