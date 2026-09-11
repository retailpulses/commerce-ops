# Commerce Ops migration

Status: Phase 1 complete; Phase 2 production cutover in progress (`#13`)

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
- classify legacy Baserow material according to `docs/BASEROW_RETIREMENT.md`.

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

## Secret and environment migration gate

Secret migration is a separate gate from source import. Do not enable production deployment workflows in `commerce-ops` until the inventory and mapping below is complete.

### Repository-scoped GitHub configuration

Inventory and recreate where required:

- repository Actions secrets referenced by each migrated workflow;
- GitHub Environments (for example `production`) and their protection rules;
- environment-scoped secrets and variables;
- repository variables such as production URLs;
- organization-level secrets/variables whose selected-repository access must be extended to `commerce-ops`;
- workflow permissions and any GitHub App/deployment permissions tied to the source repository identity.

GitHub secret values are write-only and must never be copied into this repository or migration documentation. Values must be re-seeded from their approved source.

### Runtime-scoped secrets that should stay in place initially

Because Phase 1/2 preserves runtime identities, do not rotate or relocate these merely because source control moves:

- Cloudflare Worker/Pages secrets attached to existing production projects;
- protected VPS `.env` files and systemd/runtime environment values;
- marketplace/provider credentials already stored at the runtime boundary;
- webhook/shared secrets already provisioned to unchanged endpoints.

Only the deployment credential needed for `commerce-ops` to reach those existing runtimes should be recreated at the GitHub layer.

### Supabase/runtime principals

Preserve existing least-privilege runtime principals. Do not collapse app/platform-specific runtime keys into one monorepo-wide super-key. Any GitHub-hosted deploy/runtime keys must be mapped to the corresponding app/workflow and re-seeded without exposing values.

### Public-repository safeguard

While `commerce-ops` is public:

- no real secret value may appear in tracked files, examples, workflow defaults, test fixtures, logs, or migration notes;
- production deployment workflows should remain disabled/manual-only until the secret inventory and environment protections are complete;
- source import must not trigger deployment as a side effect.

## Phase 1 Definition of Done

- [x] Target repository exists and write access is verified.
- [x] Target source layout is fixed.
- [x] Zero-runtime-change invariant is documented.
- [x] Public-repository/private-source import safety rule is documented.
- [x] Baserow legacy classification is defined across Orders, Tickets, and Inquiry.
- [x] Secret/environment migration strategy and deployment gate are documented.
- [x] Sanitized current-tree snapshot of Ops Portal imported under `apps/ops-portal`.
- [x] Sanitized current-tree snapshot of Inquiry imported under `apps/inquiry`.
- [x] Sanitized current-tree snapshot of Orders imported under `apps/orders`.
- [x] Sanitized current-tree snapshot of Tickets imported under `apps/tickets`.
- [x] Source revision/provenance recorded for each imported app.
- [x] Existing builds/tests pass from new paths.
- [x] Path-scoped CI checks are installed without changing production deploy targets.
- [x] Production deployment workflows remain disabled until the secret/environment gate is complete.
- [x] Old repositories remain active and unarchived.

Phase 1 source consolidation completed on 2026-09-10 via `commerce-ops#26`
and `commerce-ops#28`. New engineering changes should originate in this
repository. Until Phase 2 cuts over each production surface, emergency
production fixes must be mirrored between this repository and the applicable
legacy deployment-authority repository to prevent divergence.

## Phase 2 gate

Do not start production ownership cutover until the remaining gates are complete:

- [ ] Required GitHub repository secrets/variables/environments/permissions are inventoried and mapped to source ownership; no secret values are documented.
- [ ] Runtime-scoped secret locations (Cloudflare/VPS/provider) are confirmed unchanged for initial cutover.
- [ ] Each independently deployable surface proves exact-SHA deploy, smoke checks, and rollback from `commerce-ops`.

Local staging is the default integration gate and is already complete. Current
production topology and per-runtime cutover evidence are maintained in
`PRODUCTION_RUNTIME_INVENTORY.md`.
