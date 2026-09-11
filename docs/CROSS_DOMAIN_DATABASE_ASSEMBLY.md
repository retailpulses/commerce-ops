# Canonical cross-domain database assembly

Status: blocked at an RPagentOS-owned migration gap

Tracking: `commerce-ops#6`; owner remediation:
[`RPagentOS#127`](https://github.com/retailpulses/RPagentOS/issues/127)

## Scope and provenance

The local assembly combines owner SQL without changing its contents:

| Stream | Canonical source |
|---|---|
| Shared/product domains | `retailpulses/RPagentOS@6bb5ee7a1da850f3f76b0b3399e75a5ebc3aa61f` |
| Inquiry | `apps/inquiry/supabase/migrations` in the current `commerce-ops` commit |
| Tickets | `apps/tickets/supabase/migrations` in the current `commerce-ops` commit |
| Orders | `apps/orders/supabase/migrations` in the current `commerce-ops` commit |
| Ownership registry inspected | `retailpulses/rp-governance-kit@8efef5cecf7cf336a95a48c8b86c0af0fdf9921b` |

`scripts/prepare-local-db-assembly` fetches the pinned RPagentOS commit when an
exact local checkout is not supplied. It emits a generated manifest containing
the local execution sequence, original ordering key, owner, source path, and
SHA-256 for every executable migration.

Supabase CLI migration versions cannot represent the existing cross-repository
timestamp collisions. Generated execution copies therefore receive monotonic
local versions. This is a local runner identity only; the manifest retains the
owner identity and the owner SQL is byte-for-byte unchanged.

History-only `_shared_remote.sql` / zero-byte `_remote.sql` files are not
executed when the actual owner migration is present. The two Ticket-owned
copies of RPagentOS migrations `20260708000002` and `20260708000003` are also
excluded; RPagentOS is their registered owner.

## Verified assembly progress

Clean PostgreSQL 17 replays repeatedly reached:

1. RPagentOS product/task/project/listing foundations;
2. Ticket grandfathered `0001` and `0002` history;
3. timestamped Ticket core/hardening and later Ticket migrations through
   `20260715000005`;
4. Order core and migrations through `20260716203000` where ordered;
5. RPagentOS catalog reader/auth/projection migrations through
   `20260717130000`;
6. failure at RPagentOS
   `20260718000000_add_mercari_pricing_trigger.sql`.

The runner currently prepares 116 executable steps: 112 canonical owner SQL
files and four local compatibility steps.

### Ticket history compatibility

Ticket's grandfathered and timestamped core migrations replace derived views
with incompatible column order/name/count. PostgreSQL cannot perform those
changes through `CREATE OR REPLACE VIEW`. Four local compatibility steps drop
only `ticket_list_view` / `ticket_detail_view` immediately before the
unmodified owner migration recreates them. They change no owner table or data
and are recorded as `local-assembly#6` in the generated manifest.

Ticket migrations also require `storage.buckets`; the cross-domain local stack
therefore enables Supabase Storage with a 20 MiB file limit. No real attachment
or external data is loaded.

## Blocking owner gap

RPagentOS migration
`20260718000000_add_mercari_pricing_trigger.sql` creates a trigger over:

- `product_commercials.manual_cost_price`;
- `product_commercials.baseline_price`;
- `product_commercials.rma_rate`;
- `public.compute_effective_cost_price(numeric, numeric, numeric, numeric)`.

None of those three columns or the function is created by any executable SQL in
RPagentOS `main` at the pinned commit. The migration comments state that the
function was retained from a prior migration and that related objects were
applied through direct hosted DDL, but that prior schema is absent from the
canonical migration stream.

The first observed PostgreSQL failure is:

```text
ERROR: column "baseline_price" of relation "product_commercials" does not exist
CREATE TRIGGER trg_pricing BEFORE INSERT OR UPDATE OF ... baseline_price ...
```

This cannot be corrected authoritatively in `commerce-ops`: `product_catalog`
is owned by RPagentOS. The minimum unblock is an RPagentOS-owned, reviewed
baseline/forward migration that creates the missing columns and function with
their authoritative types and semantics, and states where it belongs before
`20260718000000` in a clean replay. A commerce-ops local shim would prove only
an invented contract and is rejected.

## Commands

Prepare the generated runtime and provenance manifest:

```bash
make local-db-assembly-prepare
```

An exact existing owner checkout can avoid a fresh clone:

```bash
RPAGENTOS_SOURCE_DIR=/path/to/RPagentOS make local-db-assembly-prepare
```

The checkout must be exactly at the pinned commit. The generated runtime lives
under `.tmp/cross-domain-local` and contains no hosted project link or runtime
credential.
