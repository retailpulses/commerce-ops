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

## Shared packages

Do not extract shared platform clients, auth, messaging, UI or other packages merely because similar code exists in multiple imported apps. First prove source/build/runtime parity and establish staging. Shared packages require a separate issue/PR with an explicit owner and compatibility contract.

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

Phase 1 program coordination remains `retailpulses/inbox#100`; source import execution is tracked in `commerce-ops#3`.
