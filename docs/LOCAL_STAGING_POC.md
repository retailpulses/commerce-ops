# Local disposable Commerce Ops staging POC

Status: Inquiry POC verified locally on 2026-09-10

This is a disposable developer environment, not the hosted staging environment
proposed in `docs/STAGING_ENVIRONMENT_PLAN.md`. It creates only Docker resources
named for `commerce_ops_inquiry_local`. It does not link a Supabase cloud
project, run application schedules, or invoke marketplace adapters.

## Quick start

From the repository root in a VS Code Terminal:

```bash
# Supabase CLI 2.109.1 publishes on wildcard interfaces. First enable a host
# firewall or use an isolated/trusted network, then acknowledge that boundary:
LOCAL_ENV_ALLOW_WILDCARD_BINDINGS=1 make local-env-start
make local-env-reset
make local-env-measure
make local-env-destroy
```

The equivalent direct interface is:

```bash
LOCAL_ENV_ALLOW_WILDCARD_BINDINGS=1 ./scripts/local-env start
./scripts/local-env reset
./scripts/local-env smoke
./scripts/local-env status
./scripts/local-env stop
./scripts/local-env destroy
```

Prerequisites are Docker Desktop and Supabase CLI. The script checks both and
installs nothing. Verified versions were Docker Desktop 29.4.1 on ARM64 and
Supabase CLI 2.109.1. The database uses PostgreSQL 17.

`start` creates a generated CLI workdir at `.tmp/local-env`, copies the
canonical Inquiry migrations into it without editing them, applies a local-only
dependency contract first, seeds synthetic records, and runs the smoke flow.
`reset` recreates the database and repeats the same migration, seed, and smoke
sequence. `stop` stops the stack; `destroy` uses `--no-backup`, removes the
generated workdir, and asserts that the database container no longer exists.

The wrapper is fail-closed for network binding. After the CLI starts, it
inspects the actual Kong and Postgres Docker port bindings. If either resolves
to `0.0.0.0` or `::`, the default command immediately destroys the stack. The
explicit `LOCAL_ENV_ALLOW_WILDCARD_BINDINGS=1` acknowledgement is accepted only
when the operator has enabled a host firewall or is using an isolated/trusted
network. Re-check a running stack with `./scripts/local-env check-bindings`.

## Migration ownership and order

The repository has three independent migration owners. They share one hosted
Supabase project today, but adjacency in this monorepo does not create a single
safe global migration stream.

| App | Owned domain | SQL files | Replay finding |
|---|---|---:|---|
| `apps/inquiry` | `inquiry_management` | 7 | Ordered by its seven timestamped filenames; not independently complete because it consumes catalog-owned objects. |
| `apps/orders` | `order_management` | 24 | App-owned order stream; consumes `product_catalog`; not an Inquiry bootstrap source. |
| `apps/tickets` | `ticketing` | 70 | Mixed grandfathered sequential/timestamp names, shared-history placeholders, and RPagentOS dependencies; not an Inquiry bootstrap source. |

The canonical POC sequence is:

1. a local-only, non-authoritative contract shape for RPagentOS-owned catalog
   objects;
2. `apps/inquiry/supabase/migrations/*.sql`, lexically ordered by their unique
   14-digit timestamps;
3. `local-env/supabase/seed.sql` containing synthetic fixtures only.

The dependency contract provides only `platform_accounts`, `product_variants`,
`platform_listings`, `platform_listing_skus`, and `product_platform_links`.
Inquiry does not become owner of those tables. A production-like shared staging
replay must replace this stub with reviewed canonical RPagentOS migrations.

There is no currently valid repo-wide “sort every SQL filename and apply”
order. Confirmed gaps are:

- Inquiry governance already states that its migration set needs externally
  owned `platform_accounts` and `product_variants`; the current catalog linker
  also requires three listing/link tables.
- Orders and Tickets both use migration timestamp `20260710000000` for
  different SQL. Additional filename overlaps exist at `20260716000000` and
  `20260716120000`, where Ticket files are shared hosted-history artifacts.
- Tickets retains `0001_`/`0002_` migrations, later timestamped core SQL, 18
  zero-byte/shared history artifacts documented by its governance file, and
  dependencies on several RPagentOS-owned domains.
- The authoritative cross-repository bootstrap order therefore remains outside
  this repository. It must come from the owner migration registry/history, not
  be inferred from app directory order.

## Synthetic Inquiry proof

The seed creates one fake account, variant, listing/SKU, and inquiry using
reserved-looking stable UUIDs and `synthetic-*` identifiers. The Inquiry
catalog-link trigger creates exactly one product link. The smoke SQL then:

1. reads the synthetic inquiry by external identity;
2. asserts the product link exists;
3. writes a synthetic note;
4. reads the note back through `inquiry_detail_vw`.

The verified result after both start and reset was one inquiry, zero messages,
one product link, and `result=pass`. Eight migrations appear in local migration
history: one local dependency contract plus seven unmodified Inquiry
migrations.

## Isolation and safety

- Generated client URLs use loopback and ports 55321/55322; no hosted project
  reference exists. Actual Docker binding is checked separately and fails
  closed as described above.
- Hosted Supabase control variables are unset by the wrapper. No `.env` file is
  read and no production URL, token, customer record, or marketplace credential
  is needed.
- Studio, Storage, Realtime, local mail, analytics, and Edge Runtime are
  disabled. No app Worker, timer, webhook, or external-write code is started.
- Supabase CLI 2.109.1 publishes the API and database Docker ports on
  `0.0.0.0`/`::`, despite the generated URLs using `127.0.0.1`, and exposes no
  supported per-project bind-address flag. The wrapper therefore destroys such
  a stack by default. The override requires a macOS host firewall or an
  isolated/trusted network; synthetic data and public local-development keys do
  not make wildcard binding acceptable by themselves.
- `destroy` is deliberately narrower than global Docker cleanup: it targets
  only this project and does not prune unrelated images, containers, or volumes.

## Measured footprint

Measured on a MacBook M1 Pro with 32 GiB physical RAM. Docker Desktop exposed
7.75 GiB (8,321,712,128 bytes) to containers.

| Measurement | Observed value |
|---|---:|
| Active containers | 4: Postgres, PostgREST, GoTrue, Kong |
| Idle CPU snapshot | 0.34% aggregate |
| Idle resident memory snapshot | 309.83 MiB aggregate |
| Postgres logical database size | 11 MB |
| Project Docker volume | 51.93 MB |
| Container writable layers | about 254 KiB aggregate |
| Four referenced image contents | 594,825,005 bytes total; already cached, so no incremental pull in this run |
| Clean start, cached images | 23.13 seconds |
| Full database reset | 12.94 seconds |

CPU and RAM are point-in-time idle measurements and will vary. Docker block I/O
is cumulative and is not a disk-footprint measure. The project volume and
logical database values are the relevant disposable data footprint.

## Implications for hosted staging and PR #33

This POC validates the local lifecycle and Inquiry-owned SQL, but does not close
the hosted staging migration gate. `docs/STAGING_ENVIRONMENT_PLAN.md` / PR #33
should retain the dedicated Supabase project requirement and add an explicit
owner-ordered database assembly deliverable:

- obtain the canonical RPagentOS catalog baseline and migration history;
- define collision-free cross-repository migration identities/order without
  renaming already-applied hosted history casually;
- replay Inquiry against the real owner migrations, then Tickets and Orders as
  separately owned streams;
- keep domain-specific principals and external writes physically unavailable;
- treat this synthetic POC as developer feedback, not production-source parity
  or hosted runtime acceptance evidence.
