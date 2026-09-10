# Commerce Ops migration

Status: Phase 1 in progress

Program SSOT: `retailpulses/inbox#100`

## Goal

Consolidate source ownership for:

- `retailpulses/ops-portal` -> `apps/ops-portal`
- `retailpulses/inquiry-automation` -> `apps/inquiry`
- `retailpulses/OrderMgmt` -> `apps/orders`
- `retailpulses/ticket-handling` -> `apps/tickets`

while preserving independent runtime and domain boundaries.

## Hard invariant

Repository consolidation causes **zero intentional runtime behavior change**.

The initial migration must not change production URLs, Cloudflare project identities, VPS services/live paths, Supabase ownership, schedulers, webhooks, external-write behavior, or independent rollback paths.

## Public target repository safety rule

`retailpulses/commerce-ops` is intentionally public during this phase, while the source application repositories are private.

Therefore Phase 1 MUST NOT perform an unfiltered history-preserving import from the private repositories. Private Git history can contain historical credentials, customer/order evidence, operational logs, or other material that is inappropriate to publish even when the current working tree is clean.

Initial import mode:

1. import a sanitized snapshot of the current default-branch tree;
2. exclude secrets, `.env` files, private operational logs/data, generated build artifacts, caches, and local tool state;
3. record the originating repository and source revision for traceability;
4. keep issue/PR/history references in the original repositories;
5. do not publish private repository history.

If the target repository later becomes private, history grafting can be evaluated separately. It is not a Phase 1 requirement.

## Initial layout

```text
commerce-ops/
├── apps/
│   ├── ops-portal/
│   ├── inquiry/
│   ├── orders/
│   └── tickets/
├── packages/          # intentionally empty initially
└── docs/
```

Each application keeps its existing internal structure on first import. Do not normalize frameworks, module names, package managers, database folders, or runtime topology while importing.

## Pre-import hygiene

Only migration hygiene is permitted before import. This is not an architecture refactor.

Allowed cleanup:

- exclude generated build output and caches;
- exclude local IDE/agent/tool state that is not required by runtime or governance;
- exclude secrets, credentials, `.env` files, PII, private logs, and production payload dumps;
- remove code only when it is provably dead and removal cannot affect current runtime behavior;
- classify legacy Baserow material according to `docs/BASE_ROW_RETIREMENT.md`.

Deferred until after parity/staging:

- shared package extraction;
- module/folder normalization;
- platform-adapter consolidation;
- runtime redesign;
- broad legacy cleanup whose reachability is not proven;
- database/domain consolidation.

## CI/deploy migration

Port existing application workflows as independent, path-scoped workflows. Do not introduce a generic shared deploy pipeline during source migration.

All workflows should scope to their application root to avoid GitHub Actions amplification:

- `apps/orders/**`
- `apps/tickets/**`
- `apps/inquiry/**`
- `apps/ops-portal/**`

Production deploy targets and rollback semantics remain unchanged until Phase 2 parity is proven.

## Phase 1 Definition of Done

- [x] Target repository exists and write access is verified.
- [x] Target source layout is fixed.
- [x] Zero-runtime-change invariant is documented.
- [x] Public-repository/private-source import safety rule is documented.
- [x] Baserow legacy classification is defined across Orders, Tickets, and Inquiry.
- [ ] Sanitized current-tree snapshot of Ops Portal imported under `apps/ops-portal`.
- [ ] Sanitized current-tree snapshot of Inquiry imported under `apps/inquiry`.
- [ ] Sanitized current-tree snapshot of Orders imported under `apps/orders`.
- [ ] Sanitized current-tree snapshot of Tickets imported under `apps/tickets`.
- [ ] Source revision/provenance recorded for each imported app.
- [ ] Existing builds/tests pass from new paths.
- [ ] Path-scoped CI checks are installed without changing production deploy targets.
- [ ] Required repository environments/secrets/permissions are inventoried for later cutover; no secrets are committed.
- [ ] Old repositories remain active and unarchived.

## Phase 2 gate

Do not start production ownership cutover until every imported app can build/test from `commerce-ops` and the source-to-target provenance is recorded.

Staging remains after source consolidation and production-source parity, as defined in the program issue.
