# Commerce Ops engineering guardrails

This repository consolidates source ownership for operator-facing commerce operations. It does **not** collapse bounded domains or runtime failure boundaries.

## Domain ownership

- `apps/ops-portal` — operator shell/gateway and cross-domain navigation/aggregation.
- `apps/inquiry` — presales inquiry lifecycle.
- `apps/orders` — order, fulfillment and marketplace order lifecycle.
- `apps/tickets` — post-sales ticket lifecycle and customer-resolution workflows.

A repository boundary is not a business-domain boundary. Do not move domain authority merely because code is now adjacent in one monorepo.

## Cross-domain rules

- No direct cross-domain database writes without explicit architecture approval.
- Prefer typed service/API contracts for cross-domain reads/actions.
- `ops-portal` may aggregate/present data; it must not silently become the owner of Inquiry, Order or Ticket state.
- Platform adapters must not decide Inquiry/Order/Ticket lifecycle ownership.

## Migration invariant

Until Phase 2 production-source parity is complete:

> Repository consolidation must cause zero intentional runtime behavior change.

Do not change production URLs, Cloudflare project/Worker identities, VPS service names, Supabase domain ownership, schedulers, webhooks, external-write semantics or rollback boundaries as part of source migration.

## Baserow policy

- Inquiry: Baserow runtime dependency is retired and must not be reintroduced.
- Tickets: Baserow runtime dependency is retired and must not be reintroduced.
- Orders: Baserow remains only as a temporary, explicit compatibility/audit boundary. New code must not expand it. Do not move Baserow support into shared packages.
- Supabase is the target canonical datastore for all three domains.

See `docs/BASEROW_RETIREMENT.md`.

## Staging-aware planning

Local-first staging is an established repository capability. Before implementing a bug fix, feature, migration, scheduler/runtime change, or cross-domain change, the implementation plan must classify the **lowest sufficient validation level**:

- `NONE` — documentation or other change with no executable behavior impact.
- `LOCAL_TEST` — unit/type/build/static validation is sufficient.
- `DOMAIN_STAGING` — run the affected domain against the disposable local staging environment.
- `CROSS_DOMAIN_STAGING` — run the relevant synthetic cross-domain flow in local staging.
- `PRODUCTION_CANARY` — a production-only boundary remains after all reproducible local validation is complete.

Changes involving database state, lifecycle/status transitions, reconciliation, schedulers/timers, retries/idempotency, cross-domain contracts, or external-write intent must explicitly consider local staging.

Every implementation plan must state:

- staging classification;
- what will be validated locally;
- what cannot be validated locally;
- residual production-only risk;
- whether a production canary is required.

Prefer the lowest sufficient level; do **not** require full staging for trivial changes. If an important boundary cannot be reproduced locally, validate everything reproducible locally first, then identify the residual risk and use the smallest possible production canary. Production is not the default integration-test environment.

See `docs/STAGING_ENVIRONMENT_PLAN.md` and the root `make local-env-*` commands.

## Shared packages

Do not extract shared platform clients, auth, messaging, UI or other packages merely because similar code exists in multiple apps. Shared packages require a separate issue/PR with an explicit owner and compatibility contract.

## Public repository safety

While this repository is public:

- never commit secrets, private keys, tokens, `.env` files or production credentials;
- never commit customer/order PII, raw support messages, production payload dumps or private operational logs;
- do not graft private source-repository Git history;
- use synthetic/anonymized test fixtures only;
- preserve sensitive historical evidence in the original private repositories.

## CI and deploy rules

- CI must be path-scoped by application to avoid Actions amplification.
- Importing source `.github/workflows` unchanged is prohibited.
- Production deploy workflows remain disabled/not ported until secret/environment mapping and source parity are complete.
- Preserve independent deploy and rollback capability for each runtime surface.
- Never replace platform-specific least-privilege Supabase runtime credentials with one broad monorepo service key.

## Work discipline

Use Issue → branch → PR → review/verification. Architecture-affecting changes must state:

- domain ownership impact;
- runtime/deployment impact;
- database/Supabase impact;
- secrets/permissions impact;
- external platform impact;
- rollback plan.
