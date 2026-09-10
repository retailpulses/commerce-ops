# OrderMgmt

Retailpulses' multi-platform order-operations system for marketplace ingestion, operator review, customer messaging, fulfillment orchestration, tracking reconciliation, and marketplace lifecycle updates.

Current first-class channels are Mercari Shops and Rakuten. GigaB2B is the fulfillment integration. Supabase is the canonical OrderMgmt business datastore; Baserow is legacy/compatibility only.

## Start here

- **Current operational snapshot:** [`docs/00_CURRENT_STATE.md`](docs/00_CURRENT_STATE.md)
- **Canonical architecture:** [`docs/01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md)
- **Architecture/business decisions:** [`docs/05_DECISION_LOG.md`](docs/05_DECISION_LOG.md)
- **Production sync workload inventory:** [`docs/SYNC_JOB_INVENTORY.md`](docs/SYNC_JOB_INVENTORY.md)
- **Database governance:** [`docs/16_DATABASE_GOVERNANCE.md`](docs/16_DATABASE_GOVERNANCE.md)
- **Deployment/housekeeping:** [`docs/15_DEPLOYMENT_AND_HOUSEKEEPING.md`](docs/15_DEPLOYMENT_AND_HOUSEKEEPING.md)

For current architecture, `docs/01_ARCHITECTURE.md` is the repository SSOT. Historical design reports, plans, audits, and TRDs provide rationale/evidence but do not override it.

Issue #265 的已接受目标是把业务调度逐能力迁移到 VPS 上的单一 canonical orchestrator，并以 Supabase durable control plane、依赖 DAG、freshness gate、external-operation ledger 和每能力单一 owner 保证完整性。当前 immutable release 已在 VPS 以 shadow 模式部署并通过首个 17-step run 验收；生产业务 owner 仍是 Cloudflare cron，所有 live capability 仍关闭。迁移必须经过 disabled/quiescence 中间态、exact canary、权威回读和七个完整 JST 日的 shadow parity。详见 [`docs/trd/order-pipeline-orchestration-strategy.md`](docs/trd/order-pipeline-orchestration-strategy.md)。

## Runtime components

| Component | Source | Role |
|---|---|---|
| Portal SPA | `portal/` | React/Vite/TypeScript operator UI served from VPS |
| Portal API | `portal-api/` | Node/Hono backend on VPS |
| VPS relay | `relay/` | Fixed-egress marketplace integration boundary |
| Cloudflare Worker | `worker/` | Scheduled order workloads plus webhook/admin/compatibility paths |
| VPS scheduled execution | `vps/`, `deploy/*.timer` | Declared systemd execution paths for selected workloads |
| Shared domain/runtime modules | `src/lib/` | Order pipeline and integration logic |
| CLI / maintenance | `src/index.mjs`, `scripts/` | Replay, diagnostics, migration and repair tooling |
| Database migrations | `supabase/migrations/` | OrderMgmt-owned Supabase schema evolution |

The repository contains deployment definitions for multiple scheduling layers. Do not assume a declared timer/cron is currently active without runtime verification; see `docs/SYNC_JOB_INVENTORY.md`.

## High-level architecture

```text
Operators -> order.homesbliss.net -> Cloudflare edge/tunnel -> VPS Portal SPA/API
                                                        |-> VPS marketplace relay

Mercari / Rakuten -> adapters/relay -> Supabase order_management
                                           |
                                           +-> Portal / review / messaging
                                           +-> fulfillment pipeline -> GigaB2B
                                           +<- tracking reconciliation
                                           +-> marketplace lifecycle updates

Cloudflare Worker and selected VPS systemd workloads execute governed pipeline work.
```

See [`docs/01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md) for boundaries, ownership, invariants, legacy classifications, and evidence status.

## Development

```bash
npm ci
npm run build
npm run test
```

Portal development/build commands live under `portal/`; Portal API commands live under `portal-api/`.

## Governance

Mergeable engineering work is Issue-first. Architecture-affecting work must begin from the current canonical architecture and reconcile it before the bounded change is closed.

Database, sync-workload, deployment, and worktree/session governance are inherited from `retailpulses/rp-governance-kit` with repository-local declarations where applicable.

## History

OrderMgmt was carved out from `retailpulses/workers` (`packages/order-mgmt`). See [`docs/migration-from-monorepo.md`](docs/migration-from-monorepo.md). Older architecture reports and cutover plans are retained as historical evidence; check their date/status before using them as implementation guidance.
