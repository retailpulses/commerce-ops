# Ticket Mgmt — Cloudflare Worker

Mercari ticket management automation running on Cloudflare Workers.

## Architecture

- **Worker**: `web/worker/index.ts` — routing, session management, CRON, static assets
- **Clients**: Mercari GraphQL, Supabase, OpenAI, WeCom webhook
- **Storage**: Supabase for tickets/messages/evidence; Cloudflare KV for sessions and templates
- **Schedule**: 4x daily Supabase retry/reconciliation CRON (10:00, 14:00, 16:00, 18:00 JST)

The legacy Baserow ticket pipeline is retired. Scheduled processing cannot send
customer replies and does not read or write Baserow.

## Business Process Control

Review [`docs/BUSINESS_PROCESS_MAP.md`](docs/BUSINESS_PROCESS_MAP.md) before
changing ticket creation, inbound-message handling, forms, evidence, lifecycle,
or reply behavior. It records the approved process boundaries and current drift
register.

## Deploy

```bash
cd web/worker
npm ci
npx wrangler deploy          # production
npx wrangler deploy --config wrangler.staging.toml   # staging
```

CI/CD via `.github/workflows/deploy.yml`:
- **PR** → validate (tsc + dry-run)
- **Push to main** → validate → deploy → smoke test

## Health

```
GET https://tickets.homesbliss.net/api/health
```

## Organization Standards

This repository follows shared organization standards defined in [`retailpulses/.github`](https://github.com/retailpulses/.github):

- **Architect Agent**: [`docs/agent-roles/architect-agent.md`](https://github.com/retailpulses/.github/blob/main/docs/agent-roles/architect-agent.md) — architecture review, design decisions, and code structure standards
- **Frontend Standards** (when UI work is involved): [`docs/agent-roles/frontend-agent.md`](https://github.com/retailpulses/.github/blob/main/docs/agent-roles/frontend-agent.md) and [`docs/frontend/frontend-design-guide.md`](https://github.com/retailpulses/.github/blob/main/docs/frontend/frontend-design-guide.md) — UI component patterns and design standards
