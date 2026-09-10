# Current State

## Production

| Item | Value |
|------|-------|
| Canonical/default Inquiry Portal URL | `https://ops.homesbliss.net/inquiry/` |
| Staging/diagnostic URL | `https://inquiry-dashboard.pages.dev/` (not the production operator entry point; Access/API auth required) |
| Database | Shared Supabase project, `inquiry_management` domain |
| Frontend | React dashboard embedded in ops-portal |
| Backend | Cloudflare Worker + Pages Functions; Supabase-only |
| Workload declarations | `docs/SYNC_JOB_INVENTORY.md`; runtime status must be verified separately from declarations |
| Mercari inbound | API-first；四店三个 inquiry topic webhook + 每日 completeness audit |
| Legacy mail writer | 2026-09-03T14:19:05.599Z 起停止 canonical write |

## Known Limitations

- Historical migration documents mention Baserow but are not operational runbooks.
- The shared legacy product table in Baserow belongs to other workloads and is
  outside inquiry-automation retirement scope.
- API-first Worker 与 Portal 已部署；operator outbound 仍保持 fail-closed，等待新版 finalizer 的单条人工 canary。
- 四店 webhook registration 已完成，但仍需保存一条轮换后真实 Mercari payload/redelivery 的 durable receipt 证据。
- Central governance declarations 仍有状态漂移，见 `docs/SYNC_JOB_INVENTORY.md`；这不改变当前 production writer ownership。
- API inquiry product link 缺口已由 PR #101–#103 修复并完成生产验证：
  新 inquiry 以 shop + Mercari product/variant ID 自动解析，既有 26 条 eligible
  未关联记录中 25 条已确定性关联；1 条 catalog mapping 缺失保持未关联，未使用模糊匹配。

## Next Milestone

完成 operator Send finalizer canary、真实 webhook payload 证据与 Phase close governance reconciliation。

Architecture-affecting work must begin from and reconcile `docs/01_ARCHITECTURE.md` before the bounded Phase closes.

## Change log

| Date | Change |
|---|---|
| 2026-09-04 | 记录 API inquiry → canonical product link 的生产缺口、PR #101 修复边界及 runtime verification gate。 |
| 2026-09-04 | 增加最新一条 eligible API product inquiry 的事务型生产 canary；失败时整条 migration 回滚。 |
| 2026-09-04 | 在 variant-ID canary 通过后增加现有 API product inquiry 的 100-row bounded backfill；歧义/缺失 mapping 保持未关联。 |
| 2026-09-04 | 生产 backfill 完成：scanned 26、linked 25、catalog mapping missing 1；Portal 已回读近期三条 SKU/pricing。 |
