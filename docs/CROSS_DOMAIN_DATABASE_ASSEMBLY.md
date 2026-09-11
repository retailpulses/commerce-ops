# Canonical cross-domain database assembly

Status: clean PostgreSQL 17 replay complete

Tracking: [`commerce-ops#6`](https://github.com/retailpulses/commerce-ops/issues/6)

## Ownership and provenance

The assembly consumes, rather than duplicates, owner-controlled SQL:

| Stream | Canonical source |
|---|---|
| Shared/product domains | `retailpulses/RPagentOS@cdb1f936c210744f8ed604c3cecc075e58083d5e` |
| Inquiry | `apps/inquiry/supabase/migrations` at the current Commerce Ops revision |
| Tickets | `apps/tickets/supabase/migrations` at the current Commerce Ops revision |
| Orders | `apps/orders/supabase/migrations` at the current Commerce Ops revision |

The generated manifest records the local execution sequence, original order,
owner, source path, and SHA-256. Monotonic local versions resolve filename
collisions without changing historical owner filenames. Empty/shared remote
history artifacts and Ticket copies of registered RPagentOS migrations are not
re-executed.

## Owner gaps repaired

The initial replay exposed real RPagentOS source-of-truth gaps. They were fixed
in the owner repository, not papered over here:

- [RPagentOS#127](https://github.com/retailpulses/RPagentOS/issues/127) /
  [PR #128](https://github.com/retailpulses/RPagentOS/pull/128) restored the
  provenance-backed pricing columns and `compute_effective_cost_price(...)`.
- [RPagentOS#129](https://github.com/retailpulses/RPagentOS/issues/129) /
  [PR #130](https://github.com/retailpulses/RPagentOS/pull/130) restored the
  owner-adopted CatalogSync run, failure, and outbox tables.

The resulting pin is `cdb1f936c210744f8ed604c3cecc075e58083d5e`.

## Local contracts and exclusions

The runner prepares 117 executable migration/contract steps. Four local Ticket
steps drop only derived views immediately before unmodified owner migrations
recreate incompatible shapes. Ticket's canonical Storage dependency is enabled
with a 20 MiB local file limit.

Two production-derived RPagentOS data migrations are listed in
`assembly-exclusions.tsv` and excluded from synthetic staging. The Shop4 file
also contains a schema addition, so a narrowly scoped local contract adds only
`platform_listings.mercari_before_discount_price` and its positive-value
constraint. It creates no product data and does not claim canonical ownership.

## Result and commands

Clean replay completed through all assembled owner streams. The transactional
smoke test then passed Inquiry, Tickets, Orders, shared-catalog relation, and
outbound-unavailable assertions; reset reproduced the result.

```bash
make local-db-assembly-prepare
LOCAL_ENV_ALLOW_WILDCARD_BINDINGS=1 make local-env-start
make local-env-reset
make local-env-destroy
```

An exact owner checkout may be supplied with `RPAGENTOS_SOURCE_DIR`; the script
rejects any revision other than the pin and any dirty owner migration tree.
Generated artifacts live only under `.tmp/cross-domain-local` and contain no
hosted project link or runtime credential.
