# Commerce Ops staging environment plan

Status: Proposed for review; no staging resources have been provisioned

Tracking issue: [`commerce-ops#6`](https://github.com/retailpulses/commerce-ops/issues/6)

Prerequisite: [`commerce-ops#13`](https://github.com/retailpulses/commerce-ops/issues/13)

Program coordination: [`retailpulses/inbox#100`](https://github.com/retailpulses/inbox/issues/100)

## Purpose

Create a production-like environment in which a reviewed `commerce-ops` commit
can be deployed, exercised with synthetic data, and promoted as the same source
SHA without risking production data or external marketplace mutations.

Staging is an environment boundary, not a new application architecture. The
Ops Portal, Inquiry, Orders, and Tickets domains remain independently
deployable and independently reversible.

## Entry gate

Resource provisioning starts only after the Phase 2 deployment mechanics in
`commerce-ops#13` are sufficiently proven to reuse safely:

- every deployable surface has an owner and target inventory;
- its build artifact can be produced from `commerce-ops`;
- exact source SHA is observable after deployment;
- repository/environment secret names and permissions are mapped;
- production rollback remains independent per runtime;
- no legacy repository is required to build a staging artifact.

Planning, naming review, fixture design, and least-privilege principal design
may proceed before that gate. Production cutover does not have to be fully
finished before those read-only design tasks begin.

## Non-goals and invariants

- Do not combine the four domains into one service or one deployment.
- Do not reuse production databases, buckets, queues, Durable Objects, KV
  namespaces, webhook secrets, or privileged service-role credentials.
- Do not point staging at production marketplace mutation endpoints.
- Do not send customer messages, change orders, close inquiries/tickets, adjust
  inventory, or publish listings from staging.
- Do not change production DNS, Worker/Pages identities, VPS services,
  schedules, webhooks, Supabase ownership, or rollback boundaries.
- Do not extract shared packages as part of staging setup.
- Use synthetic or irreversibly anonymized fixtures only.

## Target topology

The proposed naming convention is descriptive and must be checked for
availability during provisioning. Final platform-generated IDs belong in a
non-secret environment inventory, not in application code.

| Domain | Staging surfaces | Isolation requirement |
|---|---|---|
| Ops Portal | Pages/site plus gateway functions | staging routes and staging-only downstream URLs |
| Inquiry | dashboard Pages project, Worker, Worker state/KV | staging Supabase principal; outbound send disabled; schedules disabled initially |
| Orders | Portal, Portal API, Worker/relay, required VPS process | staging Supabase principal; Baserow compatibility not reachable by default; marketplace writes disabled |
| Tickets | frontend, Worker, share viewer, required D1/R2/DO bindings | staging-only storage bindings; outbound/customer delivery disabled |

Suggested runtime names use the existing production identity plus a
`-staging` suffix, for example `inquiry-automation-worker-staging`. Staging must
never deploy to an existing production identity merely by selecting a
different branch.

### Data boundary

Use a dedicated staging Supabase project. Separate schemas inside the
production project are rejected because a mistaken project URL or broad key
would retain production reachability.

Within staging Supabase, preserve the existing domain ownership model and use
separate least-privilege runtime principals for Inquiry, Orders, Tickets, and
any platform-specific adapters. Ops Portal receives read/aggregation access
only where its existing contracts require it. No universal monorepo service
key is permitted.

Database migrations must be applied from reviewed repository migrations in a
deterministic order. Seed data must be synthetic, idempotent, and disposable.
The environment must have a documented reset operation that cannot resolve to
the production project.

### External integration boundary

Each external integration is classified before enablement:

1. **Provider sandbox available:** use a staging-specific account/token and
   explicitly sandbox endpoints.
2. **Read-only production access is required for contract verification:** allow
   only through a dedicated read-only principal and fixed-egress adapter after
   security review; never reuse a mutation-capable credential.
3. **No safe sandbox/read-only principal exists:** use a deterministic fake or
   sanitized recorded contract fixture. The staging runtime remains physically
   incapable of making that external write.

Feature flags are defense in depth, not the primary boundary. Mutation-capable
production credentials must be absent even when a write flag is false.

## GitHub environment and workflow model

Create one protected GitHub Environment named `staging`. Store only deployment
credentials and non-secret target identifiers required for staging. Runtime
secrets remain attached to their staging runtime where supported.

Staging workflows remain app-specific and path-scoped:

- `apps/ops-portal/**`
- `apps/inquiry/**`
- `apps/orders/**`
- `apps/tickets/**`

Each app workflow should:

1. run the app's existing parity checks;
2. build once and record the source SHA and artifact digest;
3. deploy only that app's affected surfaces to staging;
4. verify release identity, health, and domain smoke tests;
5. emit a concise deployment summary and rollback target.

Do not create a generic “deploy everything” job. A separate, manually invoked
staging acceptance workflow may orchestrate smoke tests after all required app
deployments are healthy, but it must not own their deployment credentials.

Use concurrency cancellation per app and environment. Automatic deploys from
untrusted fork pull requests are prohibited. To control Actions usage, default
to deployment on merge to `main` only for changed apps; allow a manual
same-SHA redeploy for recovery and acceptance reruns.

## Schedules and background work

All staging cron triggers, timers, queues, and background consumers start
disabled. Enable them individually only after documenting:

- the synthetic input source;
- the isolated output target;
- the maximum execution frequency and cost;
- proof that no production endpoint or dataset is reachable;
- the kill switch and rollback procedure.

Where platform configuration cannot represent a disabled schedule safely,
deploy a staging-specific configuration without the trigger rather than
depending on an early-return flag.

## Promotion and rollback

The promotion unit is an immutable source SHA plus per-surface artifact digest.
Staging acceptance records both. Production promotion rebuilds only when the
build is reproducible and digest equality is verified; otherwise it promotes
the already accepted immutable artifact.

Promotion remains manual and per runtime family. A successful Inquiry staging
deployment does not authorize Orders, Tickets, or Ops Portal production
deployment.

Every staging surface must retain at least one known-good deployment. Rollback
verification consists of reverting one surface to that deployment, confirming
health/release identity, and then restoring the candidate. Database rollback
uses a forward-compatible migration or a tested restore/reset procedure; a
destructive down migration is not assumed.

## Observability and acceptance evidence

Every HTTP surface exposes or records:

- application/domain name;
- environment (`staging`);
- exact `commerce-ops` source SHA;
- build/deployment timestamp;
- non-secret runtime target identity.

Logs and metrics must identify staging and must not be shipped into a
production alert stream without an environment label. Acceptance evidence uses
counts, synthetic identifiers, and redacted errors—never customer payloads.

Minimum business-flow acceptance:

- **Ops Portal:** authentication, navigation, and aggregation against staging
  domain URLs.
- **Inquiry:** synthetic webhook/readback, canonical persistence, dashboard
  display, and compose flow with external send physically unavailable.
- **Orders:** synthetic order ingest, status reconciliation, fulfillment state
  transition, and marketplace mutation adapter in fake/sandbox mode.
- **Tickets:** synthetic intake, evidence lifecycle, share-viewer access, and
  resolution flow with customer delivery disabled.
- **Cross-domain:** typed/read-only contracts and routing are verified without
  direct cross-domain database writes.

## Implementation sequence

### Stage 0 — inventory and decisions

- Inventory every deployable surface, binding, scheduler, URL, secret name,
  runtime principal, and rollback mechanism.
- Confirm staging naming and Cloudflare/Supabase/VPS account ownership.
- Record which external providers offer sandboxes or read-only principals.
- Define synthetic fixtures and retention/reset policy.
- Approve the cost ceiling and expected monthly Actions/runtime usage.

Deliverable: reviewed topology table and completed prerequisite section in
`commerce-ops#6`.

### Stage 1 — isolated foundations

- Create the protected GitHub `staging` Environment.
- Provision the dedicated staging Supabase project and scoped principals.
- Provision staging-only Cloudflare/VPS/storage identities without schedules.
- Seed synthetic fixtures and verify production is unreachable.

Deliverable: non-secret resource inventory plus access/isolation evidence.

### Stage 2 — deploy one domain at a time

Recommended order:

1. Ops Portal shell with downstream integrations disabled;
2. Inquiry;
3. Tickets;
4. Orders, last because it retains transitional Baserow compatibility and has
   the broadest marketplace/scheduler surface.

For each domain: deploy, verify exact SHA, run domain smoke tests, exercise
rollback, and attach evidence before proceeding.

### Stage 3 — integrated acceptance

- Point staging Ops Portal only at the accepted staging domain URLs.
- Run synthetic cross-domain business flows.
- Enable only the minimum safe background triggers needed for validation.
- Measure Actions/runtime cost and remove redundant executions.

### Stage 4 — promotion readiness

- Prove per-domain same-SHA/artifact promotion mechanics.
- Prove production remains manually gated and independently reversible.
- Publish the operator runbook and incident/rollback ownership matrix.

This stage prepares production promotion; it does not itself authorize a
production deployment.

## Review decisions required before provisioning

1. Approve a dedicated Supabase staging project and its expected cost.
2. Approve the staging runtime naming convention and account placement.
3. Decide which marketplace integrations may use sandbox/read-only access and
   which must remain fixture-only.
4. Approve the monthly GitHub Actions and platform runtime cost ceiling.
5. Name the human approver(s) for the protected `staging` environment and later
   per-domain production promotion.

## Definition of done

- [ ] topology and ownership inventory reviewed;
- [ ] dedicated staging runtime identities exist for every required surface;
- [ ] dedicated staging Supabase project and scoped principals exist;
- [ ] production credentials and customer data are absent;
- [ ] marketplace/customer writes are physically unavailable by default;
- [ ] schedules are disabled or individually proven safe;
- [ ] app-specific path-scoped staging workflows are installed;
- [ ] exact SHA and artifact digest are observable for each surface;
- [ ] representative synthetic Inquiry, Orders, and Tickets flows pass;
- [ ] authenticated Ops Portal acceptance passes against staging URLs;
- [ ] rollback is verified independently per runtime family;
- [ ] same-SHA production promotion mechanics are demonstrated but remain
      manually gated;
- [ ] Actions and runtime usage fit the approved cost ceiling;
- [ ] evidence and operating ownership are linked from `commerce-ops#6`.
