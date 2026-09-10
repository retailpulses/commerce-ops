# AGENTS.md — ticket-handling

## Database Governance

Before any Supabase, migration, schema, RLS, Storage, or generated-types work:

1. Read `docs/16_DATABASE_GOVERNANCE.md` — the local entrypoint
2. Follow the canonical policy at `retailpulses/rp-governance-kit` → `docs/DATABASE_GOVERNANCE.md`
3. Read `docs/16_DATABASE_GOVERNANCE.local.md` for this repository's declarations
4. Check `docs/DATABASE_OWNERSHIP.yaml` in `rp-governance-kit` for domain ownership

**Central governance wins unless repo rules are stricter. If there is a conflict, stop and report it.**

This repository owns the `ticketing` domain. Do not modify objects owned by other repositories (see DATABASE_OWNERSHIP.yaml) without an explicit cross-domain exception and an Issue.

Migration naming: `YYYYMMDDHHMMSS_description.sql` — unique across all Retailpulses repos.
