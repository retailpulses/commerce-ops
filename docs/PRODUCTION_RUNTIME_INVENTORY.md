# Commerce Ops production runtime inventory

Status: canonical inventory; last read-only verification 2026-09-11 JST

This document is the source of truth for production topology and operational
ownership. Architecture remains in `ADR-001-MONOREPO-BOUNDARIES.md`; local
staging in `LOCAL_STAGING_POC.md`; database assembly in
`CROSS_DOMAIN_DATABASE_ASSEMBLY.md`; detailed domain runbooks remain under each
`apps/<domain>/docs` tree.

Secret values are never recorded here. Production runtime secrets remain on
their existing Cloudflare or VPS identities.

| Domain/surface | Production identity | Runtime/deploy owner | Health and freshness | Release identity | Independent rollback |
|---|---|---|---|---|---|
| Ops Portal UI | Cloudflare Pages `ops-portal`; canonical `https://ops.homesbliss.net/` | `apps/ops-portal`; owner Wrangler deployment | Cloudflare Access gate plus canonical HTML/assets | Pages deployment source SHA | select prior Pages deployment |
| Ops Portal gateway | `ops-portal-gateway.service`, `/opt/ops-portal-gateway/current` | `apps/ops-portal/deploy` | `/_gateway/health` on loopback | exact `release_sha` | repoint retained prior immutable release |
| Inquiry UI/API | Pages `inquiry-dashboard`; canonical `/inquiry/` | `apps/inquiry/apps/dashboard` | Access-authenticated HTML/assets/API | `/inquiry/api/release` | prior Pages deployment |
| Inquiry ingestion | Worker `inquiry-automation-worker`; three existing cron triggers | `apps/inquiry/apps/worker` | `/health`; ingestion/audit runs persist in `inquiry_ingestion_runs` | `commerce_ops_sha` in `/health` | prior Worker version |
| Orders portal/API | canonical `/order/`; `rp-order-mgmt-api.service`; `/opt/order-mgmt/current` | `apps/orders/portal*` and immutable VPS release | `/health`, `/api/release`, control-plane freshness/backlog | exact release SHA | `deploy/rollback-release.sh` and retained release |
| Orders scheduler | Worker `rp-order-mgmt` plus VPS shadow `order-mgmt-orchestrator.timer` | `apps/orders`; Cloudflare remains live capability owner while VPS is shadow | Worker `/health`; durable lifecycle watermarks, run/step ledger, backlog; timer state alone is insufficient | Worker `release_version`; immutable VPS SHA gate | Worker version rollback; disable VPS timer/repoint release independently |
| Sales Brief | `order-mgmt-sales-brief.timer` and service | `apps/orders/scripts/sales-brief-report.mjs` | service result plus freshness-gated delivery intent/readback | same immutable orchestrator release | disable timer and repoint retained release |
| Tickets portal | Worker `mercari-ticket-reports`; canonical `/tickets/` | `apps/tickets/web/worker` | canonical health aggregates provider readiness/freshness | `/tickets/api/release` | prior Worker version |
| Ticket providers | six platform-role Workers: Mercari/Rakuten/Amazon ingestion and send | `apps/tickets/web/worker/wrangler.*.toml` | provider `/health`: config/schema readiness, checkpoint and `last_success_at` | Cloudflare version plus exact `release_sha` | `scripts/rollback_platform_runtime.sh` per component |
| Ticket share viewer | `ticket-share-viewer.service` | `apps/tickets/web/share-viewer` | `/healthz` | immutable installed artifact; release endpoint still required | retained artifact/service rollback |
| Portal acceptance relay | `portal-acceptance-relay.service` | `apps/tickets/deploy/portal-acceptance-relay` | loopback/public `/healthz`; fixed allow-list only | immutable release symlink | repoint retained release |

## Verified production state

- Ops Portal Pages and gateway were deployed from `commerce-ops`; gateway
  readback reported `9fca7ff1f9191a9fc620f06d5d18cd902cbcaa94`.
- Inquiry Pages and Worker were deployed from `commerce-ops`; both reported
  `62e927b49019c0c0b23069b616821fe309632103`.
- The Access boundary returned the expected unauthenticated redirect. The
  existing credential-isolating acceptance relay returned authenticated 200
  responses for all three canonical HTML routes and their release endpoints.
- Orders portal/API, relay, orchestrator shadow timer, Sales Brief timer,
  gateway, share viewer, and acceptance relay were live at inspection. The
  Sales Brief entrypoint/runtime-scope defects were repaired by PRs #39/#40.
- Ticket Rakuten ingestion and Amazon mail ingestion were fresh at inspection.
  Mercari ingestion last success was stale relative to its configured daily
  triggers; this is a production-health defect, not a successful migration
  signal. Amazon SP-API send and attachment paths were intentionally disabled.
- A credential embedded in the legacy Orders checkout remote was removed.
  The active releases were unaffected; rotation remains separate security debt.

## Deployment ownership gate

The Cloudflare/VPS identities and rollback boundaries do not move. Future
deployments must originate from an exact merged `commerce-ops` SHA. Production
jobs must remain manual, domain-scoped, protected by a `production` environment,
and unavailable to fork pull requests. The four legacy repositories retain
history only until their final runtime has passed this gate; they must not
receive new engineering changes.
