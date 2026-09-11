# Local disposable Commerce Ops staging

Status: full local-first acceptance verified on 2026-09-11

This is the default Commerce Ops staging/integration environment. It is a
disposable Supabase/PostgreSQL 17 stack named
`commerce_ops_cross_domain_local`; it is not linked to a hosted project and it
does not provision cloud infrastructure.

## Operator workflow

From the repository root in a VS Code Terminal:

```bash
# Supabase CLI 2.109.1 publishes on wildcard interfaces. Enable the macOS
# firewall or use an isolated/trusted network before acknowledging this.
LOCAL_ENV_ALLOW_WILDCARD_BINDINGS=1 make local-env-start
make local-env-status
make local-env-smoke
make local-env-reset
make local-env-measure
make local-env-destroy
```

The equivalent script accepts `start`, `status`, `smoke`, `reset`, `measure`,
`stop`, `destroy`, and `check-bindings`. Docker Desktop and Supabase CLI are
prerequisites; the scripts check them and install nothing. Verified versions
were Docker Desktop 29.4.1 (ARM64) and Supabase CLI 2.109.1.

`start` regenerates `.tmp/cross-domain-local`, assembles the pinned owner
migrations, starts Supabase, checks actual network bindings, and runs the
synthetic smoke transaction. `reset` rebuilds from zero and repeats acceptance.
`destroy` uses `--no-backup`, removes the generated workdir, and verifies that
the project database container is gone.

## Canonical assembly and ownership

The assembly preserves the bounded owners:

| Stream | Canonical source |
|---|---|
| Product catalog/shared schema | `retailpulses/RPagentOS@cdb1f936c210744f8ed604c3cecc075e58083d5e` |
| Inquiry | `apps/inquiry/supabase/migrations` |
| Tickets | `apps/tickets/supabase/migrations` |
| Orders | `apps/orders/supabase/migrations` |

Inquiry migrations are not independently complete: they consume RPagentOS
catalog objects. Tickets also carries grandfathered/shared history and Orders
depends broadly on catalog state. `scripts/prepare-local-db-assembly` therefore
creates 117 ordered migration/contract steps and a SHA-256 manifest recording
owner, source path, original order, local execution identity, and content hash.
Monotonic local identities handle cross-repository timestamp collisions without
renaming deployed owner history.

RPagentOS PRs
[#128](https://github.com/retailpulses/RPagentOS/pull/128) and
[#130](https://github.com/retailpulses/RPagentOS/pull/130) restored the missing
pricing baseline/function and CatalogSync operational tables at their owner.
Five local compatibility steps only bridge deterministic replay mechanics: four
drop derived Ticket views before their owner migrations recreate incompatible
shapes, and one supplies the schema-only `mercari_before_discount_price`
contract described below. See
[`CROSS_DOMAIN_DATABASE_ASSEMBLY.md`](CROSS_DOMAIN_DATABASE_ASSEMBLY.md).

Two RPagentOS migrations are deliberately recorded but not executed locally:

- `20260824080100_seed_mercari_monthly_metrics.sql` contains production-derived
  business aggregates and assumes hosted shop accounts.
- `20260905090000_shop4_listing_prices.sql` contains production listing IDs and
  prices. Its required column/constraint are supplied by the explicit local
  schema contract, with no canonical ownership claim or data rows.

The exclusions are emitted in `assembly-exclusions.tsv`; release identity in
`release.env` records both repository revisions, the manifest hash, and
`SYNTHETIC_ONLY=true`, `OUTBOUND_ENABLED=false`, and
`SCHEDULES_ENABLED=false`.

## Acceptance evidence

The full clean replay completed through the latest Order migration. The smoke
test runs in one transaction and rolls back its fixed synthetic identities.
It proved:

- Inquiry intake, persistence, product relation, detail readback, and compose
  draft with outbound physically unavailable;
- Ticket intake, evidence, lifecycle, share/view data, and information-only
  resolution with delivery disabled;
- Order ingest, status reconciliation, fulfillment transition, and the pending
  deterministic fake-adapter boundary;
- one shared catalog variant read by all domains without cross-domain writes;
- no inquiry outbound operation, sent ticket message, external operation
  attempt, platform account, or durable synthetic business row remained.

The returned result marked `inquiry`, `tickets`, `orders`,
`cross_domain_catalog_relation`, and `outbound_physically_unavailable` as
`pass`. A clean reset reproduced the result. App-level evidence also passed:
Inquiry Worker 78 tests (1 skipped), Tickets Worker 307 tests, Orders 1,124
tests (2 skipped), and Ops Portal 18 gateway/auth/deep-link tests plus its Vite
build. Ops Portal's local JWT/access tests are the safe development-auth
equivalent; no Cloudflare identity was provisioned.

## Isolation and network safety

- Hosted Supabase variables are unset; no `.env`, production URL/token/data,
  marketplace credential, or customer-message credential is read.
- No Worker, timer, webhook, scheduler, or external adapter is started.
- Storage is local and exists only because canonical Ticket migrations require
  its schema. Studio, Realtime, mail, analytics, and Edge Runtime are disabled.
- Supabase CLI 2.109.1 exposes Kong and Postgres on `0.0.0.0`/`::` and has no
  per-project bind-address option. The wrapper detects the actual Docker
  bindings, fails closed, destroys the stack, and exits nonzero by default.
  The explicit override is valid only with a host firewall or isolated/trusted
  network. The tested Mac firewall was disabled, so the default behavior is the
  safe one.
- Destroy targets only this project; it does not prune unrelated Docker state.

## Measured footprint

Measured on the MacBook M1 Pro with 32 GiB RAM; Docker Desktop exposed 7.75
GiB. CPU and memory are point-in-time observations.

| Measurement | Observed value |
|---|---:|
| Active containers | 5: Postgres, Storage, PostgREST, GoTrue, Kong |
| CPU snapshot | 3.41% aggregate |
| Resident memory snapshot | 575.47 MiB aggregate |
| PostgreSQL logical database | 20,737,171 bytes |
| Project database volume | 86.28 MB |
| Generated runtime workdir | 7.4 MiB (7,540 KiB) |
| Clean start, cached images | 25.24 seconds |
| Clean database reset | 24.97 seconds |

Destroy removed both the generated runtime and all project containers. No paid
cloud project was created.
