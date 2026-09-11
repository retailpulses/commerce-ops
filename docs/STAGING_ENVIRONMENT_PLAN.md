# Commerce Ops staging environment plan

Status: Local-first staging implemented and verified; no hosted staging
resources are authorized or currently required

Local evidence: [`LOCAL_STAGING_POC.md`](LOCAL_STAGING_POC.md) proves the full
disposable database lifecycle and synthetic domain acceptance. Canonical
provenance and completed owner repairs are recorded in
[`CROSS_DOMAIN_DATABASE_ASSEMBLY.md`](CROSS_DOMAIN_DATABASE_ASSEMBLY.md).

Tracking issue: [`commerce-ops#6`](https://github.com/retailpulses/commerce-ops/issues/6)

Prerequisite: [`commerce-ops#13`](https://github.com/retailpulses/commerce-ops/issues/13)

Program coordination: [`retailpulses/inbox#100`](https://github.com/retailpulses/inbox/issues/100)

## Purpose

Create a production-like local environment in which a reviewed `commerce-ops`
commit can be assembled from canonical owner migrations and exercised with
synthetic data without risking production data or external marketplace
mutations. Hosted deployment and same-SHA promotion remain future, separately
approved extensions of this local evidence; they are not prerequisites for the
local staging program.

Staging is an environment boundary, not a new application architecture. The
Ops Portal, Inquiry, Orders, and Tickets domains remain independently
deployable and independently reversible.

## Local-first entry gate

Local implementation may proceed now and requires no cloud provisioning,
production-source cutover, hosted credential, or marketplace credential. Its
entry conditions are:

- Docker Desktop and a pinned/recorded Supabase CLI are available locally;
- the database assembly uses canonical migrations from each domain owner;
- owner provenance and collision handling are recorded in the repository;
- fixtures are synthetic and external mutation credentials are absent;
- reset and destroy fail closed and cannot resolve to a hosted project.

Phase 2 deployment mechanics in `commerce-ops#13` become an entry gate only if
a later proposal asks to provision hosted staging runtimes or demonstrate
same-SHA cloud promotion. Local database and application acceptance must not be
blocked on that future work.

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

## Local-first target topology

The current target is one disposable Supabase CLI stack on the operator's
MacBook. It may contain multiple owner-controlled database domains so their
real foreign keys and read contracts can be tested together, but it does not
collapse their ownership or runtime boundaries. Applications connect only to
the generated local endpoints; external integrations remain fixture-only.

No new Supabase cloud project, GitHub Environment, Cloudflare identity, VPS
service, DNS record, schedule, webhook, or external credential is part of this
stage.

## Future hosted topology (not authorized)

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

The current environment is the disposable local Supabase project generated
from repository-controlled configuration. It must not link to or reuse any
hosted Supabase project. Creating a dedicated hosted staging project is not
approved by this plan and requires a later explicit decision if local evidence
shows that a hosted environment is necessary.

Within local Supabase, preserve the existing domain ownership model and test
the same role/grant boundaries where the canonical migrations define them.
Local CLI development keys are disposable and must never be treated as a
shared runtime principal. No universal hosted monorepo service key is
permitted or required.

Database migrations must be applied from reviewed repository migrations in a
deterministic order. Seed data must be synthetic, idempotent, and disposable.
The environment must have a documented reset operation that cannot resolve to
the production project.

The deterministic order cannot be inferred by globally sorting the current app
directories. Orders and Tickets contain real timestamp collisions, Tickets
retains mixed migration-history forms, and Inquiry depends on RPagentOS-owned
catalog migrations. Stage 1 must therefore record the owner migration source,
cross-repository assembly order, and collision handling before hosted replay.

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

## Future GitHub environment and workflow model

This section is deferred and is not part of the local-first implementation.
It requires a separate approval before any GitHub Environment or deployment
credential is created.

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

### Stage 0 — local inventory and decisions

- Inventory every deployable surface, binding, scheduler, URL, secret name,
  runtime principal, and rollback mechanism.
- Record canonical migration provenance and cross-domain dependencies.
- Resolve migration identity collisions without changing domain ownership.
- Define synthetic fixtures and retention/reset policy.

Deliverable: repository-controlled assembly manifest and dependency report.

### Stage 1 — canonical local database assembly

- Assemble RPagentOS/product-catalog, Inquiry, Tickets, and Orders migrations
  from their canonical owner sources in an explicit deterministic order.
- Rebuild from zero in the disposable local Supabase stack.
- Seed synthetic cross-domain fixtures and verify production is unreachable.
- Prove reset and destroy with no hosted credential.

Deliverable: passing local assembly plus provenance, collision, reset, resource,
and isolation evidence.

### Stage 2 — run local applications one domain at a time

Recommended order:

1. Inquiry;
2. Tickets;
3. Orders, last among domain backends because it retains transitional Baserow compatibility and has
   the broadest marketplace/scheduler surface.
4. Ops Portal shell and safe development authentication with downstream
   integrations disabled.

For each domain: run against local endpoints, verify exact source SHA, run
synthetic smoke tests, exercise reset, and attach evidence before proceeding.

### Stage 3 — integrated acceptance

- Point staging Ops Portal only at the accepted staging domain URLs.
- Run synthetic cross-domain business flows.
- Enable only the minimum safe background triggers needed for validation.
- Measure Actions/runtime cost and remove redundant executions.

### Stage 4 — optional hosted/promotion proposal

- Decide from local evidence whether hosted staging adds necessary coverage.
- If it does, submit a separate architecture/cost/security proposal before
  provisioning any cloud resource or credential.
- Keep production manually gated and independently reversible.

This stage is not authorized by the local-first plan and does not itself
authorize hosted provisioning or production deployment.

## Cloud acceptance gap analysis

Local acceptance does not reproduce Cloudflare deployment/bindings and Access,
public webhook reachability, managed-Supabase-specific behavior, or provider
IAM/network behavior. Current contract, safety, migration, and business-flow
tests do not require those surfaces. Therefore no recurring cloud staging
resource or second Supabase project is technically justified now.

If a future change specifically requires one of these gaps, propose the
smallest manually invoked and preferably ephemeral resource, including monthly
cost, teardown, and the risk it validates, before provisioning. Production
promotion remains manually gated.

## Decisions deferred until a hosted environment is proposed

1. Decide whether hosted staging is necessary after local acceptance.
2. If necessary, approve its runtime naming, account placement, and cost.
3. Decide which marketplace integrations may use sandbox/read-only access and
   which must remain fixture-only.
4. Approve the monthly GitHub Actions and platform runtime cost ceiling.
5. Name the human approver(s) for the protected `staging` environment and later
   per-domain production promotion.

## Local-first definition of done

- [x] topology and ownership inventory reviewed;
- [x] canonical cross-domain owner migrations rebuild locally from zero;
- [x] no hosted Supabase project or production credential is required;
- [x] production credentials and customer data are absent;
- [x] marketplace/customer writes are physically unavailable by default;
- [x] schedules are disabled;
- [x] exact local source and owner revisions are observable;
- [x] representative synthetic Inquiry, Orders, and Tickets flows pass;
- [x] Ops Portal safe development auth/navigation/deep-link acceptance passes;
- [x] database reset and destroy are verified;
- [x] optional hosted/promotion work remains separately gated;
- [ ] final evidence and operating ownership are linked from `commerce-ops#6`.
