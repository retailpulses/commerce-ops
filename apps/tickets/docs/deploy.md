# Deploy Guide

## Required secrets (GitHub Actions)

Set in repo → Settings → Secrets and variables → Actions:

| Secret | Source |
|--------|--------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens (edit Workers + KV) |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI access token; CI uses a temporary login role so a database password is not stored in GitHub |

The Worker itself reads these via `wrangler secret` (or `--secret` in CI):

| Secret | Staging | Production |
|--------|---------|------------|
| `OPENAI_API_KEY` | same | same |
| `SHOP1_API_TOKEN`..`SHOP4_API_TOKEN` | per-shop | per-shop |
| `WECOM_WEBHOOK_URL` | yes | yes |
| `CLOUDFLARE_KV_API_TOKEN` | KV-specific | KV-specific |
| `SUPABASE_SERVICE_ROLE_KEY` | same | same |
| `SUPABASE_ANON_KEY` | same | same |
| `TICKETFORM_TOKEN_SIGNING_SECRET` | stable per environment | stable per environment |

Non-secret Worker vars for the new ticketing MVP live in `wrangler*.toml`:

| Var | Default |
|-----|---------|
| `ENABLE_NEW_TICKETING` | `"true"` |
| `SUPABASE_URL` | Retailpulses Supabase project URL |
| `TICKETFORM_PUBLIC_BASE_URL` | `https://tickets.homesbliss.net` |
| `TICKETFORM_AUTOMATION_MODE` | `"shadow"` until rollout gates pass |

GitHub Actions repository variables:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_MIGRATION_APPROVED_SHA` | Exact commit SHA approved after the hosted ledger/conflict/backup preflight; deployment fails if it differs from `GITHUB_SHA` |
| `SUPABASE_BACKUP_VERIFIED` | Must be `yes` only after confirming a recent Dashboard backup/PITR restore point |
| `SUPABASE_STORAGE_100MIB_VERIFIED` | Must be `yes` only after verifying the hosted project object limit is at least 100 MiB |
| `STAGING_SMOKE_URL` | Stable staging URL; when unset, the workflow uses the `workers.dev` URL printed by Wrangler |
| `PRODUCTION_SMOKE_URL` | Production smoke target; defaults to `https://tickets.homesbliss.net` |
| `DEPLOY_RUNNER_LABEL` | Optional trusted self-hosted runner label; unset after release to return to `ubuntu-latest` |

The project is on a paid Supabase plan. Before staging acceptance, verify the
Storage project setting permits at least `104857600` bytes per object; paid
plan eligibility alone does not change an existing lower project limit.

## Deploy behaviours

| Trigger | Action |
|---------|--------|
| PR (push to PR branch) | Validate only — application tests/typecheck/build, Worker dry-run, and disposable PostgreSQL migration/race contracts |
| Manual dispatch → staging | Validate → deploy via `wrangler.staging.toml` → automated health and retirement smoke → publish same-SHA promotion marker |
| Push to `main` | Validate → deploy to staging via `wrangler.staging.toml` → automated health and retirement smoke → publish same-SHA promotion marker |
| Manual dispatch → production | Validate main branch and successful staging marker for the exact commit → deploy via `wrangler.toml` → automated smoke on the production domain |

Every staging or production Worker deployment first runs the read-only hosted
preflight in `scripts/preflight_supabase_remediation.sh`, then `supabase db
push`. The preflight requires the exact approved SHA, backup and hosted Storage
confirmations, a migration ledger with either none or exactly
`20260830090000_rakuten_rmesse_attachment_evidence.sql` pending for this release, and
zero conflicting order groups or unsafe attachment paths. Compatible duplicate
legacy R2 references are consolidated with provenance. Timestamp ordering enforces migration
order. Any missing confirmation, ledger mismatch, conflict, or migration
failure blocks the Worker deployment.

The automated smoke gate requires health to report the Supabase-only pipeline
with TicketForm automation still in `shadow`, verifies the workspace and
canonical `/queue` login app are reachable, and confirms retired Baserow API
routes return `404`. Production cannot deploy until a completed successful
staging workflow for the same commit has published its promotion marker.

A temporary self-hosted runner may execute this same workflow without paid
GitHub-hosted minutes. It must run only reviewed `main` commits, have the
required Docker and Node tooling, be removed after release, and must not bypass
the exact-SHA staging marker or any migration and backup gate.

Because staging and production currently share the same Supabase project,
staging migration and stateful evidence tests affect production database and
Storage infrastructure. Before production promotion, record the manual
stateful staging acceptance required by issues #102, #116, #139, and #140:
real 100 MiB upload, retry/concurrency, authenticated queue/manual conversion,
evidence visibility, resolution/reply/close, cleanup isolation, and absence of
Baserow/prohibited automatic ticket creation.

## Rollback

```bash
npx wrangler rollback                # production — revert to previous deployment
npx wrangler rollback --config wrangler.staging.toml  # staging
```

List past deployments:
```bash
npx wrangler deployments list
```

> **Warning**: Do not deploy production manually unless explicitly approved.

## Retirement invariant

Deployments must not contain `BASEROW_TOKEN`, `BASEROW_BASE_URL`, the legacy
ticket processor, or a scheduled customer-reply path. Production cron is only
for Supabase retry/reconciliation and Mercari webhook registration checks.
