# Baserow retirement policy for Commerce Ops

This document defines how Baserow-related code and documentation from the three operational domains are handled during consolidation.

## Classification

| Domain | Classification | Migration rule |
|---|---|---|
| Tickets | **RETIRED** | No Baserow runtime dependency is carried forward. Preserve only migration/provenance material that explains current Supabase records. |
| Inquiry | **RETIRED** | No Baserow runtime dependency is carried forward. Preserve the no-Baserow regression guard and selected historical migration documentation. |
| Orders | **TRANSITIONAL** | Carry the existing compatibility boundary unchanged during Phase 1 because current code can still route through the Baserow adapter if `DATABASE_BACKEND` is not explicitly Supabase. Retire only after parity/staging and explicit reachability proof. |

Supabase remains the canonical operational store for all three domains.

## Tickets

Current Ticket state declares Baserow historical/read-only and states that the Ticket runtime has no Baserow credential or API dependency.

### Import

Carry:

- current Supabase runtime/application code;
- migrations and provenance fields required to interpret migrated records;
- selected historical migration/closeout documentation when it remains useful.

Do not treat as current architecture:

- Baserow-backed ticket processors;
- Baserow-backed form/workspace implementations;
- old Baserow table IDs/configuration;
- Baserow-based template/knowledge proposals that have newer Supabase-native replacements.

Open issues whose implementation premise is Baserow must be re-triaged before being recreated in Commerce Ops.

## Inquiry

Current Inquiry state declares the backend Supabase-only. The repository also has an automated `test_no_baserow_runtime.py` guard that rejects Baserow URLs, tokens, and client references in active runtime paths.

### Import

Carry:

- current Worker/dashboard/enrichment runtime;
- Supabase migrations;
- `test_no_baserow_runtime.py` or an equivalent monorepo guard;
- selected migration/exception reports for provenance.

Do not reactivate:

- Baserow writers/readers;
- old Baserow inquiry pipeline assumptions;
- Baserow-backed rule/template storage designs unless deliberately redesigned against the current architecture.

## Orders

OrderMgmt is different. Production is configured for Supabase and the current workload inventory is Supabase-centric, but `src/lib/db.mjs` still imports both Supabase and Baserow adapters and defaults to Baserow when `DATABASE_BACKEND` is absent. The repository's compatibility inventory treats this as a bounded retirement path.

### Phase 1 import

Carry unchanged:

- `src/lib/baserow.mjs` and any still-referenced compatibility helpers;
- DB facade behavior;
- compatibility/parity tests;
- migration/audit tooling that still has a documented purpose.

Label these as **transitional compatibility**, not canonical architecture.

Do not add new business features that depend on Baserow.

### Retirement gate

Order Baserow compatibility may be removed only when all of the following are proven:

1. all production and supported operational entrypoints explicitly use Supabase;
2. no active runtime, scheduled job, deploy script, recovery procedure, or operator tool depends on the Baserow adapter;
3. all business modules use canonical Supabase-native DTOs rather than legacy Baserow shapes;
4. migration/audit scripts that still need Baserow are either completed, archived, or moved outside the active runtime surface;
5. full Order flow regression passes without the compatibility adapter;
6. rollback/recovery policy no longer relies on Baserow;
7. retirement is performed as a separate reviewed change after source parity and staging exist.

## Monorepo guardrail

After import, add a repository-level Baserow boundary test:

```text
apps/inquiry/**  -> Baserow runtime references forbidden
apps/tickets/**  -> Baserow runtime references forbidden
apps/orders/**   -> allowed only through an explicit compatibility allowlist
```

Historical references are allowed in designated migration/archive documentation.

The purpose is to ensure consolidation does not accidentally make Baserow a shared Commerce Ops dependency.

## Issue handling

Baserow-era issues are not copied mechanically.

- **still valid business need, obsolete implementation** -> rewrite against current Supabase architecture;
- **replaced by newer Supabase issue/design** -> close/supersede in source repo and reference successor;
- **historical migration evidence** -> leave in source repository;
- **Order compatibility retirement work** -> consolidate under one post-parity Order-domain retirement issue.

## Strategic end state

```text
Commerce Ops
├── Inquiry  -> Supabase only
├── Tickets  -> Supabase only
└── Orders   -> Supabase only

Baserow -> historical/migration evidence only
```

The consolidation itself does not force the final Order Baserow removal. It establishes the boundary that prevents the compatibility layer from spreading further.
