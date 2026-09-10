# Inquiry Automation Workload Inventory

This inventory describes repository-owned database workloads. Cross-repository mail
ingestion and follow-up workloads remain inventoried by their owning repositories.

| Workload ID | Purpose | Source → target | Runtime | Trigger | Status |
|---|---|---|---|---|---|
| `inquiry_historical_migration` | One-time legacy consolidation | retired sources → canonical inquiry tables | retired | none | completed; tooling removed |
| `inquiry_automation_worker` | Classify, product-link, and draft | canonical inquiries + product projection → canonical inquiries/links | Cloudflare Worker | `*/30 * * * *` | production active |
| `inquiry_dashboard_mutations` | Authenticated operator edits | Pages Function API → canonical inquiries/links | Cloudflare Pages Functions | interactive | production active |
| `inquiry_vps_enrichment` | Browser-extracted Mercari details | Mercari browser session → canonical inquiries/links | ConoHa VPS Python | bounded manual/scheduler | Supabase-only; governed separately |

No repository-owned production workload reads or writes Baserow. Historical
references and `baserow_row_id` provenance fields do not constitute an
operational dependency. Rollback keeps Supabase authoritative.

## API-first production workloads

以下 workload 属于 `docs/phases/mercari-inquiry-api-redesign/README.md` / Architecture Change Issue #92。Canonical source 与 entrypoint 已在本地实现；production release SHA 只能在合并部署并完成 runtime readback 后填写。

| Workload ID | Kind / effect / risk | Source → target | Proposed trigger | Kill switch | Status |
|---|---|---|---|---|---|
| `inquiry_mercari_webhook_ingestion` | pull / internal_write / medium | Mercari topics → raw inbox → API readback → canonical inquiry/messages | `apps/worker/src/index.ts` `/webhooks/mercari-inquiry` + async processor；event-driven via ConoHa relay | `INQUIRY_MERCARI_INGEST_WRITES_ENABLED=true` | production active at `b6d7456`；four shops × three inquiry topics registered/read back；real post-rotation receipt pending |
| `inquiry_mercari_completeness_audit` | reconcile / internal_write / medium | Mercari Inquiry API → missing/changed delta only | `apps/worker/src/mercari/audit.ts`；hourly `15 * * * *` recent recovery capped at 2 discovery pages/shop；daily `0 16 * * *` UTC full 72-hour audit | `INQUIRY_COMPLETENESS_AUDIT_WRITES_ENABLED=true` | hourly recovery added after the post-rotation webhook receipt gap; daily production audit remains active and idempotent |
| `inquiry_operator_send` | push / external_write / high | authenticated Portal → `addInquiryMessage` → readback + atomic finalize | `apps/dashboard/functions/api/inquiries/[id]/send.ts`；interactive | `INQUIRY_OUTBOUND_SEND_ENABLED=false` | deployed at `b29bbdc` but fail-closed；new finalizer canary pending explicit operator-message confirmation |

Required production declarations for each workload:

- owner repo, canonical source path, deployment entrypoint and reviewed release SHA；
- access path and least-privilege credential class；
- affected domains/tables and overlapping writer analysis；
- expected row/request/response-byte volume and freshness SLO；
- bounded concurrency, statement/request timeout and retry budget；
- idempotency, dead-letter/quarantine and unknown-result handling；
- run metrics, warning/critical thresholds, kill-switch test and rollout evidence。

Canonical design has exactly three business-write controls: canonical ingest, daily-audit repair, and outbound send. Per-shop processing pause is a control under the ingest workload, not a fourth writer kill switch. The ConoHa relay has no canonical write capability or business-state ownership.

`inquiry_mail_ingestion` 由 `retailpulses/workers` 拥有。PR #27 已部署
`MERCARI_INQUIRY_MAIL_CANONICAL_WRITE_ENABLED=false`；ownership epoch 从
`2026-09-03T14:19:05.599Z` 起属于 API writer。不得在 API writer active 时重新启用 mail writer。

自动 follow-up/batch send 不在首发 workload inventory 中。现有手工 follow-up skill 的运行事实需单独核对，不能把其历史能力自动并入新版 Portal。

## Observed governance drift（需 companion reconciliation）

- Repo source 和本 inventory 声明 `inquiry_automation_worker` 为 `*/30 * * * *`、production active；当前中央 registry 仍写 `*/10 * * * *`、`pending_approval`。
- Repo-local governance 声明 canonical policy `v1.6.0`，但 installed pointer/模板未包含最新 architecture-change governance adoption。
- 中央 inquiry domain 仍只列 Phase 1 objects，尚未声明 proposed `inquiry_messages`、webhook inbox、outbound/follow-up ledgers、views/RPCs。
- 中央 consumer/capability 仍把 workers mail ingestion 和 follow-up skill 写为当前写入者；API-first Phase 完成时必须按真实 cutover reconciliation，不能提前改成 runtime verified。

这些差异不授权修改生产。实施前应在 `rp-governance-kit` companion PR 中纠正 intended state；Phase close 时再按 deployment/runtime evidence 更新最终状态。
