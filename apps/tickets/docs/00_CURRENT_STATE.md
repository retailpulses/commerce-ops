# Current State

## Production

| Item | Value |
|------|-------|
| Production URL | `https://tickets.homesbliss.net` (Cloudflare Worker) |
| Staging URL | Cloudflare Worker (staging deploy via workflow) |
| Health Check | `GET /api/health` |
| Database | Supabase (project linked via `supabase link`) |
| Frontend | React SPA (`web/frontend`) |
| Backend | Cloudflare Worker (web/worker/index.ts) |
| KV Storage | Sessions and managed templates; not webhook durability |
| CRON Schedule | 4x daily (10:00, 14:00, 16:00, 18:00 JST) |

## Database

- Source of truth: Supabase (Postgres)
- Migrations in `supabase/migrations/`
- Key tables: tickets, ticket_messages, ticket_products, copywriting_logs, inbound_ticket_messages, and related
- Mercari webhook events are inserted into Supabase before enrichment; processing state and retries are stored on `inbound_ticket_messages`
- Reconciliation uses per-message idempotency and can recover webhook gaps without sending replies
- Rakuten R-Messe ingestion discovers new inquiries from the list API and also reconciles a bounded, oldest-first set of known inquiries through detail reads every two minutes.
- The R-Messe attachment ingestion function includes Supabase's `extensions` schema in its fixed `search_path`, so `pgcrypto.digest` resolves during idempotent evidence-key generation.
- Queue conversion is idempotent: later messages for an existing platform order link to its existing ticket
- Ticket list search only queries columns exposed by `ticket_list_view`, preventing order-ID searches from failing with HTTP 500
- Historical Baserow tickets/forms/evidence are migrated with immutable provenance IDs
- Ticket runtime has no Baserow credential or API dependency

## Frontend

- React SPA built with Vite/TypeScript (`web/frontend/`)
- Ticket workspace with two-pane layout
- Portal state management for ticket views

## Backend

- Cloudflare Worker (TypeScript) at `web/worker/`
- Clients: Mercari GraphQL, Supabase, OpenAI, WeCom webhook
- Services: ticket management, message sending, classification, template engine
- Tests in `web/worker/tests/`

## Known Limitations

- Supabase migrations are manually ordered (no squash)
- No dedicated staging database — staging worker uses same Supabase project
- Agent workflow relies on local docs; no hard enforcement of Issue-first governance yet

## Retired System

- Baserow Tickets table `884687` and Ticket Form table `893037` are historical/read-only.
- The old Python and Worker ticket processors have been removed.
- Scheduled jobs perform Supabase retry/reconciliation and webhook checks only.
