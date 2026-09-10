# ADR-001: Mercari 售前咨询采用 API-first 与 webhook-first 架构

**状态：** Accepted；Implemented and deployed，runtime closeout in progress

**日期：** 2026-09-03

**相关 Phase：** `docs/phases/mercari-inquiry-api-redesign/README.md`
**相关 POC：** `retailpulses/inquiry-automation#91`

## Context

当前 Mercari inquiry 依赖 Zoho notification email 摄取，缺少稳定 message identity、原生 target/product relationship 和完整 thread facts。POC 已证明四店可读取 `inquiries`/`inquiryMessages`，并完成单条 `addInquiryMessage` API/UI readback。

Mercari Schema 提供 `INQUIRY_MESSAGE_CREATED`，而 Ticket 当前使用的 `ORDER_TRANSACTION_MESSAGE_CREATED` 已 deprecated。Ticket 生产数据同时表明 webhook 并非完整性绝对保证：过去 30 天 303 条 durable message 中，79 条在事件时间后超过 5 分钟才进入系统，需保留低频 completeness check。

## Decision

1. Mercari Inquiry API 取代邮件，成为售前 inquiry platform fact source。
2. 首发订阅 `INQUIRY_MESSAGE_CREATED`、`INQUIRY_RESOLVED`、`INQUIRY_MESSAGE_ADMIN_DELETED`；payload 仅作 change trigger，完整事实由 API 回读。
3. 每日一次 bounded completeness audit 初始回看 72 小时，同时 reconcile missing message、inquiry status、message edit/admin-delete；Phase 0 必须以最大观测延迟验证窗口。
4. Operator 打开详情与发送前执行单 thread fresh read。
5. 新版直接替换 canonical `/inquiry/` UI 和 writer ownership，不运行新旧双 UI/双 writer。
6. `InquiryOrderTransactionTarget` 在 domain router 转交 ticketing，不进入 inquiry cohort。
7. 首发支持 operator Send 和人工 follow-up queue；自动 follow-up 只保留后续路线图。
8. Supabase 继续是业务主数据，VPS 只提供 Mercari 固定 IPv4 transport。
9. `docs/01_ARCHITECTURE.md` 直接定义 canonical to-be system；旧运行状态只保留在 `docs/00_CURRENT_STATE.md`，不继续维护一份 mail-based architecture。
10. Canonical inquiry/message identity 分别为 `(shop_key, external_inquiry_id)` 与 `(shop_key, external_message_id)`；`source='mercari_shops'` 仅为稳定 provenance，不参与 identity。
11. `InquiryOrderTransactionTarget.orderTransaction` 是售前/售后路由 authority；正文 regex order ID 仅为 hint，冲突时 fail closed 到 ticketing review。
12. Ingest application owner 为 `inquiry-automation` Cloudflare service；ConoHa VPS 仅为无状态固定 IPv4 transport relay。
13. Follow-up 采用单一 `follow_up_state` cycle state；due/overdue 从 JST due date 派生，不保存第二套 schedule status。

## Alternatives considered

### 纯定时 polling

拒绝。低流量并不消除不必要的延迟和重复扫描；Mercari 已提供现代 inquiry webhook。

### 每 10 分钟 reconciliation

拒绝。每日约 8–10 条 inquiry 不需要 144 次/日扫描；每日一次可将 scheduled runs 减少约 99.3%。

### 纯 webhook、无 completeness audit

暂不采用。Ticket 时间差数据表明仍有显著 delayed/recovered cohort；待新系统显式记录 `delivery_source` 且连续 30 天 recovered=0 后再评审。

### 新旧应用并行运营

拒绝。会造成 operator 入口和 canonical writer ownership 模糊。上线前使用离线 replay/canary，上线后保留 artifact rollback，而不是双系统运营。

## Consequences

- 新增 webhook raw inbox、normalized messages、processing/retry 和 daily audit contracts。
- 必须声明新的生产 workloads、kill switches、request/byte budgets 和 source identities。
- Mail writer 必须在 cutover epoch 退役。
- Ticket 复用 transport/durability pattern，但不复用订单 data model 或 lifecycle。
- 自动 follow-up 不阻塞首发，也不得随 Portal 上线被默认启用。
- 这项 repository-specific documentation decision 偏离中央模板默认的“`01_ARCHITECTURE.md` 描述 current architecture”角色。偏离仅限 architecture-document temporal semantics，不削弱 ownership、Phase、evidence、workload、database、rollout 或 reconciliation 治理；所有未部署能力必须明确标记为 declared to-be。

## Lifecycle

本 ADR 已实现并部署。API writer、legacy mail retirement、四店三 topic registration 与每日 audit 已 runtime verified；真实 post-rotation webhook receipt 和新版 operator Send finalizer canary 仍是 Phase close 门槛。如实际决策变化，标记 Superseded 并链接替代 ADR。
