# 同步任务清单

本文件记录 Ticket Handling 拥有的外部消息同步和相关高风险任务。组织级风险、预算和审批状态以 `retailpulses/rp-governance-kit/docs/DATABASE_WORKLOADS.yaml` 为准。

## `ticketing_amazon_zoho_mail_sync`

- Canonical Issue：`retailpulses/ticket-handling#235`
- 入口：Cloudflare Worker scheduled handler；受认证的 `POST /api/ticketing/amazon-mail/sync`
- 生命周期：`off → shadow → active`；默认 `off`
- Kill switch：`AMAZON_MAIL_INGESTION_MODE=off`
- 范围：单一已授权 Zoho account/inbox；每次处理一个 UTC 日期分片，20 页 × 100 条/次；15 分钟重叠；冻结 `run_to` 和 `segment_date` continuation；单日第 20 页仍满时以 `day_segment_overflow` 失败关闭
- 写入：`amazon_mail_sync_state`、`inbound_ticket_messages`；仅对已有授权映射追加 `ticket_messages`，轮询不得创建工单
- 失败证据：sync state 错误码/运行指标及去除 PII 的 Worker structured logs
- 上线门禁：两次 shadow、单订单文本 canary、人工 full run、至少两个健康 scheduled cycles

## `ticketing_amazon_zoho_attachment_reconciliation`

- Canonical Issue：`retailpulses/ticket-handling#235`
- 入口：Amazon mail sync 后的 oldest-first reconciliation
- 生命周期：独立于文本摄取；默认关闭
- Kill switch：`AMAZON_MAIL_ATTACHMENTS_ENABLED=false`
- 范围：最多 25 条已关联消息，每条最多 5 张、每张最多 10 MiB；单次累计最多 1,250 MiB、277 requests；Evidence 与源状态使用一次事务 bulk RPC；每个引用最多 3 次跨调用 retry；仅接受 magic bytes 与 MIME 一致的 JPEG/PNG/GIF/WebP
- 写入：私有 `ticket-attachments` Storage bucket 和 `ticket_attachments` Evidence；确定性 hash path 幂等
- 失败证据：源消息 attachment 状态、重试时间/错误码及无 PII 指标
- 上线门禁：单独批准一条真实图片 canary；验证签名读取及 replay 不增加对象

## `ticketing_amazon_zoho_outbound_reply`

- Canonical Issue：`retailpulses/ticket-handling#235`
- 入口：受认证 Ticket Portal `POST /api/ticketing/tickets/:id/send`
- 恢复入口：`GET|POST /api/ticketing/tickets/:id/amazon-send-resolution`
- 生命周期：操作员审阅 → claim/fence → 单次 Zoho reply → Sent readback → 原子 finalize；默认关闭
- Kill switch：`AMAZON_MAIL_OUTBOUND_ENABLED=false`；已存在 lease 的只读检查/人工处置在开关关闭时仍可用
- 幂等与并发：`client_operation_id`、每工单单 lease、`message_revision`、`lease_generation` fencing、mutation-boundary CAS
- 失败证据：`sent_messages`、`ticket_events`；`ambiguous` 不自动过期。provider mutation 已开始时，需等待至少 30 分钟并取得两次相隔至少 5 分钟的权威零候选回读，才能进入 durable terminal `confirmed_not_sent`
- 上线门禁：单独批准工单、源消息、固定 sender、掩码 recipient、subject 与最终日文正文；Zoho Sent 和 Supabase 权威回读一致

## 变更日志

- 2026-09-07 v1.0.0：登记 Amazon Zoho 文本摄取、附件 reconciliation 和 Portal outbound reply 三个独立任务。
- 2026-09-07 v1.0.1：登记 generation-specific lease clock 与 ambiguous send settlement 门禁。
- 2026-09-07 v1.0.2：同步使用 UTC 日期分片 continuation 并对单日 overflow 失败关闭；附件任务登记 1,250 MiB/277-request 上限和事务 bulk finalize。
