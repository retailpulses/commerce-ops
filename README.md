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

Phase 2 production-source cutover: not started. The four legacy repositories
remain the deployment/runtime authority until each production surface passes
the secret/environment, exact-SHA deploy, smoke, and rollback gates.

See `docs/MIGRATION.md` for the migration plan and acceptance criteria.
