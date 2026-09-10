# Mercari Inquiry API 源端重构方案

**状态：** 规划草案，不授权实现或生产变更  
**版本：** 0.8
**日期：** 2026-09-03  
**业务域所有者：** `retailpulses/inquiry-automation`  
**相关 POC：** `retailpulses/inquiry-automation#91`
**Canonical to-be architecture：** `docs/01_ARCHITECTURE.md`

**Bounded architecture Phase：** `docs/phases/mercari-inquiry-api-redesign/README.md`
**Architecture decision：** `docs/adr/001-mercari-inquiry-api-first.md`

## 1. 决策摘要

建议将 Mercari 咨询的主摄取源从 Zoho 通知邮件改为 Mercari Shops `Inquiry` API，同时保留现有 Supabase、自动分类、草稿/润色、人工审核和 Portal 能力。

本方案只规划，不实施。当前 POC 已证明以下能力：

- `inquiries` API 返回商品咨询、店铺咨询和订单交易会话；本方案只接收无订单的售前咨询，订单交易会话转交 ticket/售后域；
- `inquiryMessages` 返回会话消息；
- 商品咨询直接返回 `productId` 和 nullable `productVariantId`；
- 订单咨询返回 `orderTransaction`；
- Schema 还支持 `InquiryShopTarget`。
- Shop1–Shop4 均可通过各自 token 读取 `inquiries` 和 `inquiryMessages`；
- 2026-08-29 至 2026-08-31（JST）的 33 条 thread 已完成跨四店分页发现和消息时间线核对；
- Shop2 已完成一次明确批准的 `addInquiryMessage` canary，使用唯一 `idempotencyKey`，API 回读和 operator UI 均确认消息成功送达。

这足以批准“读侧替换”的设计工作，并证明受控单条 API 发送的基本可行性；但不足以批准邮件摄取下线、自动发送或批量发送。正式切换仍必须经过完整历史分页、增量一致性、附件和影子对账。

上线建议采用**单一 operator 应用直接切换**：新版直接发布到 `https://ops.homesbliss.net/inquiry/`，不保留新旧两个 UI 供 operator 并行操作，也不允许新旧两个 canonical writer 并行。切换前完成离线 replay/backfill 和验收；切换后由真实用户边使用边反馈，以小步发布修正。旧版本只保留不可运行的构建产物和数据库 checkpoint，供严重故障时受控回滚，不作为并行应用继续服务。

消息发现建议采用**Webhook 主触发 + 每日一次轻量 API completeness audit**，而不是高频双重读取。2026-09-03 对 Mercari 生产 GraphQL Schema 的只读 introspection 已确认 `INQUIRY_MESSAGE_CREATED`、`INQUIRY_RESOLVED`、`INQUIRY_MESSAGE_ADMIN_DELETED`；同时 `ORDER_TRANSACTION_MESSAGE_CREATED` 已被描述为 deprecated，并指向 `INQUIRY_MESSAGE_CREATED`。

同日实时读取四店 `webhooks` 结果确认：Shop1–Shop4 当前都只注册了 `ORDER_TRANSACTION_MESSAGE_CREATED`，共同指向 Ticket endpoint `https://tickets.homesbliss.net/api/webhooks/mercari-message`；尚无 `INQUIRY_MESSAGE_CREATED` 注册。这证明 Ticket webhook 已在用，也说明 Inquiry 上线前必须新增并验证现代 topic，不能把“Ticket 已 webhook 化”误解为售前 inquiry 已有通知覆盖。

## 2. 目标与非目标

### 2.1 目标

1. 使用 Mercari 原生 ID 建立稳定、可去重、可重放的售前咨询事实。
2. 只摄取无订单的 `InquiryProductTarget` 和 `InquiryShopTarget`；`InquiryOrderTransactionTarget` 归 ticket/售后域，不进入 inquiry workflow。
3. 保持当前 operator-visible 功能：列表、搜索、详情、分类、商品关联、草稿、润色、状态和备注。
4. 以 Supabase 继续作为 inquiry 业务主数据源。
5. 将邮件从 Mercari 咨询事实来源降级为切换期对账信号。
6. 将 API 回复纳入目标架构，但只能通过统一、受控的 send/finalize contract；是否上线 operator Send 或自动 follow-up 仍需按阶段单独审批。
7. 覆盖完整 operator loop：`ingest + processing`（同一 orchestration function）→ operator review → operator compose reply → operator click Send → authoritative readback。
8. 每次成功确认的 operator reply 默认生成一个三天后的 follow-up date；operator 可覆盖并保存其他日期。
9. 首发提供可运营的人工 follow-up review queue：今日/逾期列表、人工跟进、改期、跳过和已跟进移出；数据合同为未来程序跟进预留兼容性，但本期不实现 batch send。
10. 首发只提供人工 follow-up queue；约 80% 售前咨询自动跟进及提问式购买/支持 CTA 保留在后续路线图，本期不开发、不启用。
11. 新版 Inquiry Portal 在 canonical `/inquiry/` 路径一次切换，不运行新旧双 UI 或双 writer。
12. 复用 Ticket Management 已验证的 webhook durability 模式，同时用每日 completeness audit 发现漏投、乱序和 webhook 注册异常。

### 2.2 非目标

- 不修改本方案阶段的任何代码、数据库、Cloudflare/VPS 配置或生产任务。
- 不处理有订单的售后 ticket；这些会话属于独立 ticket domain 和生命周期。
- `rp-mail-integration` 当前不是目标架构的一部分；新 API ingestion 稳定上线并完成对账后，应规划退役其 Mercari inquiry 邮件路径。其他仍在使用的邮件职责需单独盘点，不能默认一起删除。
- 本规划阶段不启用 `addInquiryMessage`、`updateInquiryStatus` 或任何 customer-facing mutation；首发实施范围只包含经审批后的 operator Send，`READY` 自动 follow-up 属于后续路线图。
- 不建立通用事件总线、第二数据仓库或新的产品主数据。
- 不让 Mercari API 数据覆盖 Supabase 中的人工草稿、备注或内部 workflow 状态。
- 首发不开发或启用自动 follow-up、自动 eligibility segmentation 或 batch send；只提供人工 follow-up queue、人工改期、人工 compose 和人工 Send。

### 2.3 目标功能范围

本次 redesign 的产品范围固定为：

```text
API ingest
  -> normalize + deduplicate + classify/link (same orchestration function)
  -> operator review
  -> operator composes/edits final reply
  -> operator clicks Send
  -> Mercari API send + authoritative readback
  -> persist outbound evidence
  -> default follow-up date = reply date (JST) + 3 calendar days
  -> operator may overwrite and save follow-up date
  -> due date surfaces in manual follow-up review queue
  -> operator reviews, composes and clicks Send
```

“同一 function”指一个受治理的 application orchestration boundary，而不是把外部 API、数据库和 LLM 假装成单一原子事务。该 function 负责一次 ingest batch 的 fetch、normalize、idempotent persistence 和 processing dispatch；任何一步失败都必须可重放，并且不得重复创建 inquiry/message。

## 3. 当前状态

当前 Mercari 咨询路径：

```text
Mercari notification email
  -> Zoho
  -> rp-mail-integration (10-minute cron)
  -> parse subject/body/URL
  -> upsert public.inquiries
  -> inquiry-automation classification
  -> Portal operator workflow
```

现有边界：

- `rp-mail-integration` 是 Mercari 邮件发现和 inquiry create/update 的当前写入者。
- `inquiry-automation` 拥有 canonical inquiry domain 和 Portal/automation。
- Supabase `public.inquiries` 是当前业务主表。
- `inquiry_messages` 尚未标准化；历史消息主要依赖 `message_log_raw` 等扁平字段。
- 自动向客户发送回复当前关闭。
- Mercari 生产 API 必须经 Conoha VPS 固定 IPv4 `160.251.141.110`，不能假定 Cloudflare Worker 可直接调用。

邮件路径的主要限制：

- 依赖邮件投递、模板和解析规则；
- 产品/订单关系需从 URL 或正文推断；
- 无稳定 message ID；
- 线程更新、重开和排序容易受邮件延迟影响；
- 附件和平台状态不是原生结构化事实。

## 4. 目标能力所有权

| 能力 / 事实 | 唯一所有者 | 唯一写入者 | 说明 |
|---|---|---|---|
| Mercari 原始 inquiry/message 发现 | `inquiry-automation` | `inquiry-automation` Cloudflare ingest service（经 ConoHa relay） | 每店 token、固定 IPv4；relay 仅 transport |
| Canonical inquiry | `inquiry-automation` | Ingestion service/RPC | 受约束 upsert，不覆盖人工字段 |
| Canonical inquiry message | `inquiry-automation` | Ingestion service/RPC | 以 Mercari message ID 幂等写入 |
| Product master | RPagentOS/Catalog owner | 现有 product writer | Inquiry 只保存引用和 snapshot |
| Operator workflow/draft/notes | `inquiry-automation` | Portal/automation APIs | 与平台状态分离 |
| Follow-up due date | `inquiry-automation` | Send finalizer 或 operator date API | 默认规则 + 人工 override；到期后进入人工 review queue |
| Mail ingestion 非 inquiry 职责 | `workers` | `rp-mail-integration` | 不在本次迁移范围 |
| Customer-facing Mercari reply | `inquiry-automation`（拟议） | 统一受控 outbound service | 首发只有 operator Send；未来 batch auto-follow-up 若获批必须复用同一 contract |

原则：同一个 Mercari message 不允许 API ingestor 和 mail worker 同时作为 canonical writer。API ingestor 的业务 owner 是 `inquiry-automation` Cloudflare application service；ConoHa 只提供无状态固定出口 relay，不保存 cursor、不做 normalize/route、不写 canonical data。影子期 API 结果写入隔离 evidence/staging，或由同一 canonical ingestion contract 以 `observe_only` 禁止业务投影。

## 5. 目标数据流

```text
Mercari Shops Inquiry API (per shop)
  -> INQUIRY_MESSAGE_CREATED / INQUIRY_RESOLVED / INQUIRY_MESSAGE_ADMIN_DELETED webhooks
      -> authenticate + validate + durable raw Supabase insert
      -> return 2xx
      -> async fetch inquiry/inquiryMessages through fixed-IPv4 relay
      -> route by target: presales inquiry vs order/ticket
  -> daily API completeness audit (correctness safety net)
      -> bounded discovery / rolling overlap
      -> direct reconciliation for known active threads
      -> recover missing messages and status/edit/admin-delete changes
  -> authenticated ingestion contract
  -> Supabase transaction
      -> external inquiries
      -> normalized messages
      -> target references
      -> run/cursor/error ledger
  -> existing inquiry classification and operator workflows
      -> operator review + compose
      -> operator clicks Send
      -> Mercari mutation + message readback
      -> outbound evidence + follow-up due date
  -> ops.homesbliss.net/inquiry/

Zoho Mercari emails
  -> shadow reconciliation only
  -> mismatch report/quarantine
  -> retired from canonical Mercari inquiry writes after acceptance
```

## 6. 源端 API 合同

### 6.1 Bootstrap 与 completeness audit discovery

- Operation：`inquiries(first, after)`
- 用于首次 backfill、每日 webhook 漏投恢复和周期完整性审计；不是正常低延迟消息发现的并行高频触发源。
- 每个 shop 独立调用和独立 cursor。
- 显式选择最小字段：
  - `id`
  - `status`
  - `salesChannel`
  - `firstOpenedAt`
  - `lastActivityAt`
  - `target.__typename`
  - target-specific IDs
- 持续分页直到 `hasNextPage=false` 或达到治理上限。
- 不用“某次扫描返回 0”证明同步完成。

### 6.2 Thread reconciliation

- Operation：`inquiryMessages(inquiryId, first, after)`
- 已知活跃 thread 需要独立调度，不能只依赖新 inquiry discovery。
- 显式选择：`id`、`inquiryId`、`body`、`from`、`sentAt`、`status`、attachments metadata。
- 对 `lastActivityAt` 变化、非终态和近期终态 thread 进行重读。
- 未确认 message pagination 行为前，不允许只取第一页后推进完成水位。

### 6.3 Webhook 主触发合同

Mercari 生产 Schema 当前公开以下 inquiry 主题：

- `INQUIRY_MESSAGE_CREATED`
- `INQUIRY_RESOLVED`
- `INQUIRY_MESSAGE_ADMIN_DELETED`

首版订阅并处理三个 topic：`INQUIRY_MESSAGE_CREATED` 触发完整 thread/message 回读，`INQUIRY_RESOLVED` 回读并更新 platform terminal status，`INQUIRY_MESSAGE_ADMIN_DELETED` 回读并对已删除 message 执行 change-aware tombstone。payload 精确字段、签名、重投行为和 buyer/seller 两个方向是否都触发，必须在实施前以受控 webhook canary 固化为 fixture。Webhook 只作为“某 thread 可能发生变化”的通知，不把通知 payload 当作完整会话事实。

接收顺序固定为：

1. 验证 HTTPS、每店 endpoint secret/HMAC（constant-time compare）、timestamp replay window、topic、shop identity 和必要字段。
2. 立即按稳定 `event_identity` 幂等写入 Supabase raw inbox：优先 `shop_key + topic + Mercari external_event_id`；若 canary 证明没有 event ID，fallback 为 `sha256(schema_version + shop_key + topic + external_inquiry_id + external_message_id/null + occurred_at)`。不得用整个可变 payload hash 作为 identity。
3. raw insert 成功或事件已存在时返回 2xx；数据库无法持久化时返回可重试错误。
4. 异步经固定 IPv4 relay 回读 `inquiry` / `inquiryMessages`，再 normalize、路由和 processing。
5. 以 `InquiryOrderTransactionTarget.orderTransaction` 为 authority：Product/Shop target 且 authority 无订单时进入 inquiry domain；OrderTransaction target 路由 ticket domain，绝不进入 Inquiry Portal；正文 regex order ID 只作冲突 hint。
6. enrichment 失败保留 durable event，由定时 worker 重试；不得因 LLM、商品关联或 Portal API 失败丢失通知。

### 6.4 与 Ticket Management 的复用边界

应复用 Ticket 已在生产验证的模式：固定 IPv4 GraphQL relay、webhook registration/list 管理、先持久化后 2xx、Supabase unique idempotency、异步 enrichment、pending/failed retry、定时 reconciliation、per-shop freshness 和发送后权威回读。

不应复制 Ticket 的订单数据模型、分类器、ticket queue/status 或 `order_transaction_id` webhook payload 假设。Ticket 当前 handler 只接受 `ORDER_TRANSACTION_MESSAGE_CREATED` 和 `order_transaction_id`；不能直接作为售前 inquiry handler 使用。

当前 Ticket 实际也是混合策略：webhook 负责低延迟触发，既有 cron 继续执行 reconciliation、失败 enrichment retry 和 webhook registration 检查。因此 Inquiry 应复用其可靠性结构，但不照搬其扫描频率。

### 6.5 Ticket 生产数据对 webhook 可靠性的评估

2026-09-03 对 `inbound_ticket_messages` 做了只读聚合，不读取 message body 或客户 PII：

| 范围 | 持久化消息 | 事件后 60 秒内到达 | 延迟超过 5 分钟 | 最终状态 |
|---|---:|---:|---:|---|
| 2026-08-04 至 2026-09-03 | 303 | 223（73.6%） | 79（26.1%） | 303 completed，0 failed/pending |
| 2026-07-14 至 2026-09-03 | 568 | 442（77.8%） | 124（21.8%） | 568 completed |

其中过去 30 天有 75 条延迟超过 2 小时，且 303 条的 `processing_attempts > 0` 为 0。说明 webhook 一旦进入 durable inbox，后续处理非常可靠；主要风险在事件未即时覆盖或未即时投递，而不是 enrichment retry。

当前表把 webhook 与 reconciliation 都保存为 `source='mercari_webhook'`，因此无法直接得到精确的 recovered count。上表以 `server_received_at - webhook_received_at` 超过 5 分钟作为 reconciliation 高可信代理；它不能替代未来显式 `delivery_source` 字段，但足以否定“完全不做完整性检查”的方案。

Ticket 当前 rolling reconciliation 每日运行四次，并对扫描到的 buyer message 逐条尝试 insert，重复项再依赖 unique constraint 返回 `23505`。该实现保证了正确性，但会产生不必要的 API 扫描和 duplicate write attempts；Inquiry 不应照搬这一数据访问形态。

结合 Inquiry 每日约 8–10 条的量级，首发建议：

- `INQUIRY_MESSAGE_CREATED` 作为唯一低延迟主触发；
- 每日一次、每店一次 bounded completeness audit，初始回看最近 72 小时；Phase 0 必须以实际最大 webhook/API delay 证明窗口覆盖，证据不足则扩大窗口并重新核算预算；
- operator 打开 inquiry 详情和点击 Send 前，按单 thread fresh read；
- 批量读取现有 inquiry status 与 message ID/hash/status；补 missing message，同时 change-aware reconcile resolved、edit、admin-delete；禁止逐 message N+1 数据库查询和 duplicate insert 探测；
- 显式保存 `delivery_source=webhook|daily_audit|backfill`，使 recovered count 成为直接指标，而不是依赖时间差推断；
- 每周评估 `audit_recovered_count`。若连续 30 天为 0，再评审降为每周；不能未经数据证明直接取消。

这样每日通常只有每店一个 bounded list scan、一次批量 ID 比较和零到少量 delta write；对 Supabase 的负担可忽略，相比每 10 分钟执行可减少约 99.3% 的 scheduled runs（144 次/日降为 1 次/日）。

建议把通用能力抽象为共享 Mercari transport/event contract，但 canonical inquiry 写入仍由 `inquiry-automation` 独占。为避免阻塞首次上线，可以先在 Inquiry runtime 内实现相同 contract；后续再将 Ticket 从 deprecated topic 迁移到 `INQUIRY_MESSAGE_CREATED` 并由统一 target router 分流。不得让两个服务对同一售前 inquiry 同时写 canonical 表。

### 6.6 Target mapping

| Mercari target | Canonical mapping |
|---|---|
| `InquiryProductTarget` | `external_product_id`, nullable `external_product_variant_id`,再映射 canonical product variant |
| `InquiryOrderTransactionTarget` | 不写入 inquiry workflow；交给 ticket/售后 ingestion contract |
| `InquiryShopTarget` | `external_shop_id`，商品/订单字段为空 |

`InquiryOrderTransactionTarget.orderTransaction` 是订单关系 authority；正文 regex 得到的 `order_id` 只可作为 hint。hint 与 API target 冲突、target 缺失或展开失败时必须保存原始 payload 并 fail closed 到 ticketing review/quarantine，不能进入售前 Inquiry Portal。未知 `__typename` 同样 quarantine。

## 7. 建议数据模型（仅设计）

### 7.1 `inquiries` 调整

保留现有内部 workflow 字段，新增或明确：

- `source = 'mercari_shops'`（稳定 platform family/provenance；mail/API delivery 差异另存于 event/observation metadata）
- `external_inquiry_id`
- `platform_account_id` / `shop_key`
- `external_status`
- `external_sales_channel`
- `external_first_opened_at`
- `external_last_activity_at`
- `external_target_type`
- `external_product_id`
- `external_product_variant_id`
- `external_order_transaction_id`
- `external_shop_id`
- `source_observed_at`
- `source_payload`（受限 JSONB，禁止复制不需要的 PII）

唯一约束：`(shop_key, external_inquiry_id)`。现有 `(source, shop_key, external_inquiry_id)` migration 在实施时必须由新 migration 替换；cutover 前先把 mail/API observation 映射到同一 canonical row，并以 zero-duplicate backfill fixture 验证，禁止通过改变 `source` 建第二条 inquiry。

`status`、`automation_status` 和 follow-up cycle state 继续属于内部工作流，禁止直接用 Mercari status 覆盖。

新增 follow-up schedule 字段（名称为设计建议，正式 migration 另审）：

- `follow_up_due_date DATE`：下一次 operator follow-up review 日期，按 `Asia/Tokyo` 解释；
- `follow_up_date_source TEXT`：`auto_after_reply` 或 `operator_override`；
- `follow_up_date_updated_at TIMESTAMPTZ`；
- `follow_up_date_updated_by TEXT/UUID`；
- `follow_up_state TEXT`：单一 cycle state，取值 `scheduled`、`superseded_by_inbound`、`followed_up`、`do_not_follow_up`、`cleared`；`due/overdue` 由 due date 投影计算，不持久化为第二套状态；
- `follow_up_cycle_id UUID`：每次确认的新卖家回复开启的新排程周期；
- `follow_up_cycle_started_at TIMESTAMPTZ`；
- `last_confirmed_outbound_message_id TEXT`：生成默认日期的权威发送证据；
- `last_confirmed_outbound_at TIMESTAMPTZ`。

现有 `follow_up_sent_at` 表示“follow-up 实际已发送时间”，不能复用为未来排程日期。实施 migration 必须将旧 `follow_up_status` 明确映射到 `follow_up_state` 或保留为只读 legacy provenance，不能让两者同时驱动 queue。

### 7.2 `inquiry_messages`

建议建立规范化消息表：

- `id` canonical PK
- `inquiry_id` FK
- `source`
- `shop_key`
- `external_message_id`
- `external_inquiry_id`
- `direction` / `external_from`
- `body`
- `sent_at`
- `external_status`
- `attachments_metadata`
- `source_observed_at`
- `source_payload_hash`
- `created_at` / `updated_at`

唯一约束：`(shop_key, external_message_id)`；mail/API 是 observation/delivery provenance，不是另一条 canonical identity。

同一 message ID 内容发生变化时执行 change-aware update，并保留变更审计；不追加重复日志字符串。

### 7.3 Cursor 和运行账本

每店保存：

- discovery cursor
- cursor observation time
- last successful full-page completion
- active-thread reconciliation watermark
- run ID、release SHA、started/finished、page/message counts
- retry/error/quarantine counts
- last authoritative success

cursor 只能在本页所有 inquiry 和 message 达到 durable terminal 或显式 exception 状态后推进。

## 8. 幂等、排序与恢复

1. Inquiry upsert key：`shop_key + external_inquiry_id`，不含 source。
2. Message upsert key：`shop_key + external_message_id`，不含 source。
3. 使用 `sentAt + message ID` 排序；不得只用时间戳去重。
4. Discovery cursor 是 opaque 值，不解析、不自行构造。
5. 每轮包含时间重叠窗口，捕获迟到更新。
6. 已知非终态 thread 使用 `next_poll_at` 单独重读。
7. API timeout/5xx 最多三次指数退避；401 fail closed；429 尊重 backoff。
8. 单条 schema/数据异常进入 quarantine，不推进越过未处理范围。
9. 重放相同 API page 必须得到 `created=0` 且无人工字段变化。

## 9. Status 合同

已观察的 Mercari inquiry status：

- `OPENED_BY_BUYER`
- `AWAITING_BUYER`
- `AWAITING_SELLER`

已观察的 message status/from：

- `status=ACTIVE`
- `from=BUYER`

迁移初期只保存原始 enum。内部状态映射需单独批准，并遵循：

- `AWAITING_SELLER` 可触发“需要回复”候选，但不能自动发送。
- `AWAITING_BUYER` 不自动等同内部 `answered`，需要消息方向和最新消息核对。
- 未知 enum fail closed 并告警。
- 平台 status 回退/重开不得被单向状态机丢弃。
- `follow_up` 是 proactive manual operator action，不是 inbound customer reply，也不是到期排程状态。

### 9.1 Reply 与 follow-up lifecycle

1. API ingestor 发现新客户消息并完成 processing；记录进入 operator review。
2. Operator 查看完整 thread、分类和商品/订单关联，编辑最终回复。
3. Operator 点击 Send 后，server 生成唯一 operation/idempotency key，并执行 Mercari mutation。
4. 只有 `inquiryMessages` 回读确认新 seller message 后，才持久化 outbound evidence、更新内部 answered state，并开启新的 follow-up cycle。
5. 默认值：`DATE(confirmed_outbound_at AT TIME ZONE 'Asia/Tokyo') + 3`。
6. Operator 可通过 date picker 覆盖并保存其他日期；保存后 `source=operator_override`。
7. 若后续客户消息在 due date 前到达，原排程标记为 `superseded_by_inbound`，该 inquiry 回到 reply review queue。
8. Due date 到达只进入 follow-up review queue；operator 仍需复核 thread、compose 并点击 Send。
9. Follow-up 成功发送并回读后写 `follow_up_sent_at`、本轮 `follow_up_state='followed_up'`，并立即从 active queue 移除。
10. 任意新的 seller reply（人工 Portal 发送或未来受控程序发送）权威回读成功后，都以该回复日重新计算 `+3`，关闭旧 cycle、开启新 cycle并设 `follow_up_state='scheduled'`。若 operator 随后覆盖日期，以最新人工保存值为准。

人工覆盖规则：

- Operator 可在发送前选择日期；发送成功后保留该选择，不再由默认规则覆盖。
- Operator 可在发送后重新选择并保存日期。
- 修改日期不发送消息，也不改变平台 status。
- 每次 override 保存 immutable audit event，包含旧值、新值、actor、时间和原因（reason 可选）。
- 日期保存失败不能导致重发消息；通过 outbound message ID 对账后只重试内部 schedule write。

### 9.2 Follow-up review queue 管理

Queue 是 Supabase canonical 数据的稳定 projection，不使用浏览器内存、KV 或客户端自行计算作为事实来源。

Active queue 的建议 predicate：

```sql
follow_up_due_date <= (now() AT TIME ZONE 'Asia/Tokyo')::date
AND follow_up_state = 'scheduled'
AND deleted_at IS NULL
AND status NOT IN ('closed_won', 'closed_lose')
AND latest_active_message_from = 'SELLER'
AND latest_active_message_id = last_confirmed_outbound_message_id
```

JST date 必须由数据库或服务端按 `Asia/Tokyo` 计算。最后两项精确定义“无未回复客户消息”：最新 ACTIVE message 是 SELLER，且其 ID 等于本 cycle 的权威 outbound message ID。默认列表包含“今日到期 + 历史逾期”，分组显示，避免未在当天处理的记录第二天消失。进入详情和点击 Send 时仍须 fresh-read Mercari thread；queue snapshot 本身不授权发送。

Queue item 最小字段：

- canonical inquiry ID、shop、target type；
- customer-safe display name；
- product/order summary；
- last inbound/outbound time；
- last confirmed outbound message preview；
- `follow_up_due_date`、逾期天数、date source；
- `follow_up_state`、cycle ID；
- draft/final reply state；
- concurrency claim/lease 状态；
- exception/block reason。

Operator 功能：

1. 查看今日和逾期数量，并按 shop、target、日期、状态筛选。
2. 打开 item 后读取最新完整 thread，而不是只依赖 queue snapshot。
3. Compose/edit follow-up；Send 前显示 shop、thread、最终文本。
4. 发送成功并回读后自动从 active queue 移除。
5. 修改 due date 并保存；保存后立即按新日期重新投影。
6. `do_not_follow_up`/clear schedule，并记录理由和 audit event。
7. 查看 followed-up history，但 history 不混入 active queue。

Queue removal rules：

| 事件 | Active queue 结果 |
|---|---|
| `follow_up_state=followed_up` | 立即移除 |
| `follow_up_state=do_not_follow_up` | 立即移除 |
| Operator 将日期改到未来 | 从今日/逾期移除，进入 upcoming |
| 新客户消息到达 | 移除并进入 reply review queue |
| Inquiry 进入 terminal/soft-deleted | 移除 |
| 新 seller reply 权威确认 | 旧 cycle 关闭；新 cycle 按回复日 +3 排入 upcoming |

“从 queue 移除”表示不再出现在 active projection；历史 schedule、status event 和 outbound evidence 不删除。

### 9.3 未来人工与程序批量 follow-up 共存合同（本期不实现 batch）

人工发送和程序批量 follow-up 必须调用同一个 send/finalize contract：

1. Claim inquiry/cycle，生成 lease；TTL 必须覆盖该 workload 允许的 fresh read + mutation + authoritative readback + finalize 最坏时长；TTL 到期只允许进入 unknown-result reconciliation，不允许直接重发；
2. fresh-thread read，确认无更新客户消息；
3. 检查当前 cycle 仍为 `scheduled` 且已经 due；
4. 使用 `sha256(shop_key + external_inquiry_id + follow_up_cycle_id + operation_version)` 生成稳定 operation/idempotency key；同一逻辑发送的重试复用相同 key；
5. 通过 `inquiryMessages` 权威回读；
6. 在一个数据库事务中写 outbound message evidence、`follow_up_sent_at`、`follow_up_state=followed_up` 和 immutable event；
7. release lease，active queue projection 自动移除。

批处理不得仅直接 PATCH `follow_up_state=followed_up` 来伪造发送成功。若存在已由外部程序发送但内部 finalize 失败的 case，必须提供 Mercari message ID 进行 readback/reconciliation，再补写 terminal state。

并发规则：同一 `inquiry_id + follow_up_cycle_id` 同时只能有一个 active lease。Operator 打开页面不等于 claim；点击 Send 或 batch 准备发送时才 claim。若另一执行者已完成，当前 UI 刷新并显示“已跟进”，不得再次发送。

### 9.4 Queue API / projection（设计）

建议只读 view/RPC：

- `follow_up_review_queue_vw`：active due/overdue projection；
- `follow_up_upcoming_vw`：未来排程；
- `follow_up_history_vw`：已完成/取消周期；
- `GET /inquiry/api/follow-ups?bucket=due|overdue|upcoming&shop=...`；
- `GET /inquiry/api/follow-ups/:inquiryId`：fresh detail/thread summary。

建议 mutation contract：

- `PATCH /inquiry/api/follow-ups/:inquiryId/schedule`：operator override/clear；
- `POST /inquiry/api/follow-ups/:inquiryId/send`：人工 Send；
- 内部 `claim_follow_up_cycle` / `finalize_follow_up_cycle` RPC：人工和 batch 共用。

所有 mutation 受 Cloudflare Access、actor audit、CSRF/authorization、mutation kill switch 和 shop scope 约束。

## 10. 商品关联策略

优先级：

1. `InquiryProductTarget.productVariantId` -> canonical platform listing/product variant exact mapping。
2. `productId` -> Mercari product mapping，再解析 primary/available variant。
3. 原生商品 ID 无法解析时，保留外部 ID并明确标记，交给 operator 人工关联。

`InquiryOrderTransactionTarget` 不参与本节商品关联；它在领域路由时直接交给 ticket/售后域。

API 原生关联不直接修改 product master。无法映射的外部 ID进入 operator-visible exception，不阻塞 inquiry 和 message 摄取。

## 11. 附件与 PII

附件能力在 cutover 前必须单独验证：metadata 字段、授权下载、URL 生命周期、最大尺寸、MIME/signature、重复附件和已删除附件。

目标规则：

- 原始附件只进入私有 storage；
- 下载需使用正确 shop credential 和固定出口；
- 校验 MIME、magic bytes、大小和 hash；
- 以 `(shop, inquiry, message, attachment identity/hash)` 幂等；
- Portal 使用短期授权 URL；
- 日志禁止 message body、用户信息、token 和附件 URL；
- `userInfo` 只选择当前 UX 确实需要的字段，并定义留存期。

## 12. 出站回复边界

早期方案曾把本次工作限定为“只切换读侧，不包含出站 API”。该边界对当前 redesign scope 已不再适用：首发包含 operator 点击 Send；对 `READY` 售前 inquiry 的程序化 follow-up 仅保留为后续路线图。

首发 operator Send 必须通过统一 send/finalize contract。未来若实现 batch auto-follow-up，也必须复用其 idempotency、发送前 fresh-thread read、发送后 authoritative readback、outbound ledger、cycle lease 和 kill switch；不得形成第二套写路径。

这仍是设计边界，不是实施或生产发送授权。每个 rollout 阶段必须按审批和验收条件单独启用。

2026-09-03 已完成一次 Shop2 `addInquiryMessage` 生产 canary：发送前核对最新 message ID/方向，使用唯一 `idempotencyKey`，mutation 返回 `ACTIVE`/`SELLER` message，随后通过 `inquiryMessages` API 回读，并由 operator 在 Mercari UI 确认可见。

该证据只证明单条受控发送，不证明自动化、批量发送、异常重试或 `updateInquiryStatus`。未来启用 outbound workload 前仍必须完成：

- 完整 mutation contract 和错误矩阵；
- 精确人工批准的单 thread canary；
- operation/idempotency key；
- 发送前 fresh-thread check；
- 发送后 `inquiryMessages` authoritative readback；
- ambiguous result 禁止自动 retry；
- 外部发送 kill switch 与数据库写入 kill switch 分离；
- 发送 ledger 与平台 message ID 对账。
- Send finalizer 必须将 outbound evidence、内部 reply state 和 follow-up schedule 写入同一个数据库事务；外部发送成功而事务失败时，按 message ID 回读补偿，禁止再次发送。

在这些条件完成前，生产 API ingestor 仍保持 read-only；现有 canary 不构成启用 operator Send、自动发送或批量发送任务的授权。

## 13. 后续路线图：自动跟进适用性 Segment（首发不开发）

本节是 non-governing roadmap appendix，不属于本 Architecture Change 的实施、schema、workload 或验收范围。首发到期项目全部进入人工 follow-up queue，由 operator review、compose 并点击 Send；系统不计算或执行 `READY` 自动发送。后续实施时必须把本节迁移为独立 Phase/ADR 并重新审批；本节不能作为开发授权。

### 13.1 简化原则

先按业务域切开，再做简单 eligibility 判断：

1. `InquiryOrderTransactionTarget` 或已有订单 ID：这是 ticket，转交售后域，本方案不处理。
2. 无订单的 `InquiryProductTarget` / `InquiryShopTarget`：这是售前 inquiry，进入 follow-up 规则。
3. 售前 inquiry 到期后默认可以自动跟进；目标覆盖约 80%，而不是只允许极少数样本。
4. 自动消息不声明库存、价格、优惠或配送事实，只询问购买决定并邀请继续提问；建议模板见 13.6。
5. 只有最新轮到客户、尚未跟进、客户未明确拒绝，以及没有未回答问题这几个必要条件。

### 13.2 数据来源

| 决策维度 | Mercari API 事实 | Supabase 事实 |
|---|---|---|
| 当前轮到谁回复 | `Inquiry.status`、最新 `InquiryMessage.from/sentAt` | latest inbound/outbound projection |
| 咨询对象/领域路由 | `target.__typename`、product/order/shop IDs | canonical product/order links；有订单即转 ticket |
| 会话完整性 | 全分页 `inquiryMessages`、message status | ingestion cursor、message dedupe/exception |
| 到期与周期 | confirmed seller message time | `follow_up_due_date`、cycle/status/state |
| 是否已处理 | 最新 seller message / mutation readback | `follow_up_state`、`follow_up_sent_at`、outbound ledger |
| 是否已有订单 | `InquiryOrderTransactionTarget` | `order_id`、target mapping |
| 简单例外 | 最新 message body | operator skip/do-not-follow-up flag |
| 业务关闭 | Mercari status | `status`、`deleted_at`、`do_not_follow_up` |

Supabase 是 queue 和 decision 的业务主数据；Mercari API 是 platform conversation、target、message 和 send delivery 的权威来源。两者冲突时 fail closed 并进入 reconciliation。

### 13.3 三种简单结果

| 结果 | 是否进入 active queue | 动作 | 条件 |
|---|---|---|---|
| `READY` | 是 | 可由程序直接发送，也可由 operator 手动发送 | 到期售前 inquiry，满足最小条件；这是默认结果，目标约 80% |
| `WAIT` | 否，显示在 upcoming 或 reply queue | 等待日期或先回复客户 | 未到期，或最新消息来自客户 |
| `SKIP` | 否 | 不做售前自动跟进 | 已跟进、明确拒绝、do-not-follow-up、关闭/删除、未回答问题 |

订单/ticket 在进入本表前已经路由出 inquiry domain，不属于 `SKIP`，也不计入任何 follow-up segment 或覆盖率分母。

### 13.4 `READY` 最小判断

同时满足以下条件即为 `READY`：

1. `follow_up_due_date <= JST today`。
2. `follow_up_state='scheduled'`。
3. API 权威 target 不是 `InquiryOrderTransactionTarget` 且 `orderTransaction` 为空；Supabase/regex `order_id` 只作为冲突检测 hint，不可反向授权进入售前 cohort。
4. Mercari 状态为 `AWAITING_BUYER`，最新 ACTIVE message 来自 `SELLER`。
5. 当前 cycle 尚未成功 follow-up，也没有 pending/ambiguous send。
6. 客户未明确表示拒绝、不需要或停止联系。
7. Seller 没有尚未兑现的“确认后回复”，客户问题也不是仍未回答。
8. Inquiry 未关闭、删除或标记 `do_not_follow_up`。

发送程序仍在最后一刻 fresh-read thread，并使用 idempotency key/lease 防重复。这是技术正确性检查，不是复杂的商业 segmentation。

### 13.5 `SKIP` 的少量明确原因

- `ALREADY_FOLLOWED_UP`：当前 cycle 已跟进；
- `CUSTOMER_REPLIED`：最新消息来自客户，应进入回复 queue；
- `CUSTOMER_DECLINED`：客户明确拒绝或不再需要；
- `UNANSWERED_QUESTION`：前一问题没有被 seller 完整回答；
- `PENDING_SELLER_PROMISE`：seller 承诺稍后确认但尚未完成；
- `DO_NOT_FOLLOW_UP`：operator 明确排除；
- `CLOSED_OR_DELETED`：记录已结束。

不再因为 bulk purchase、price negotiation、附件、多个问题、shop target 或商品事实 freshness 自动排除。只要上一轮已经回答完毕，统一的非事实性问句 follow-up 仍可安全发送。

### 13.6 默认 follow-up 文案与 CTA

默认文案采用两级 CTA：

1. 首要 CTA：询问客户是否已经决定购买，并邀请继续完成购买。
2. 次要 CTA：如果仍有疑问，邀请提出新问题或寻求支持。

建议日文模板：

```text
お世話になっております。先日はお問い合わせいただき、誠にありがとうございました。

その後、ご購入についてはお決まりになりましたでしょうか。
商品についてご不明な点や、確認したいことがございましたら、どうぞお気軽にご連絡ください。ご購入にあたり必要なサポートがございましたら、喜んでお手伝いいたします。

すでにご購入いただいている場合は、行き違いとなりましたことをご容赦いただき、本メッセージはご放念ください。

ホムブリスカスタマーサポート
```

该模板不声称库存、售价、促销或配送日期，可适用于大多数已经得到回答的售前 inquiry。

### 13.7 简化 projection 与 audit

建议 view/RPC 输出：

- `follow_up_decision`：`READY` / `WAIT` / `SKIP`
- `eligibility_rule_version`
- `eligible_computed_at`
- `reason_codes[]`
- `source_freshness_at`
- `latest_message_id/from/sent_at`
- `target_type`
- `reason_code`（`READY` 时可为空）

建议稳定 reason codes：

- `NOT_DUE`
- `CUSTOMER_REPLIED`
- `ALREADY_FOLLOWED_UP`
- `CUSTOMER_DECLINED`
- `UNANSWERED_QUESTION`
- `PENDING_SELLER_PROMISE`
- `DO_NOT_FOLLOW_UP`
- `CLOSED_OR_DELETED`
- `AMBIGUOUS_SEND_STATE`
- `ACTIVE_LEASE`

每次 batch 必须保存 decision snapshot、rule version、message IDs、reason codes、action、最终 Mercari message ID 和 readback。只保存最终 segment 而不保存原因不可审计。

### 13.8 初始 rollout 建议

1. **Future replay**：新版稳定后，对历史 30 天计算 `READY/WAIT/SKIP`，确认 `READY` 接近目标 80%，并抽查错误排除/错误纳入。
2. **Shadow**：每日生成 queue 但不发送，与 operator 判断比较 7 天。
3. **Supervised batch**：operator 审核 READY 列表并批准批量发送。
4. **Default auto**：READY 默认程序发送；保留每店/每日 cap 和 kill switch。

Go gate 同时看两个指标：READY 覆盖率目标约 80%，以及抽查中没有订单/ticket、未回答问题或明确拒绝的错误发送候选。

### 13.9 结合已核对样本的校准

2026-08-29 至 2026-08-31 的 33 条 thread 可作为第一批 replay fixture：

- 已 follow-up 的售前咨询 -> `SKIP / ALREADY_FOLLOWED_UP`；
- 订单、付款、配送、退款、取消 -> 在 segmentation 前排除并路由 ticket，不产生 inquiry follow-up decision；
- 仅要求客户从商品页重新咨询、未回答原问题 -> `SKIP / UNANSWERED_QUESTION`；
- 承诺后续确认但未完成 -> `SKIP / PENDING_SELLER_PROMISE`；
- 其余到期、轮到客户、已回答的售前咨询 -> 默认 `READY`。

此前把 33 条 API thread 全部混在一起评估，导致订单 ticket 拉低了自动跟进覆盖率。重新校准时必须先排除 `InquiryOrderTransactionTarget`，只以售前 inquiry 作为分母，并以约 80% READY 为产品目标。

## 14. Go-live strategy：单一应用直接切换

### 14.1 决策

新版直接部署到 canonical route `https://ops.homesbliss.net/inquiry/`。Operator 不进入双系统并行期，不需要判断“应该在哪个应用处理”，也不允许旧邮件写入者与新 API 写入者同时拥有 canonical inquiry。

“直接切换”指 UI 和 writer ownership 在一个明确 cutover window 内一次变更；它不等于跳过上线前验证，也不等于没有回滚。推荐保留：上一稳定 release artifact、切换前数据库 checkpoint、webhook registration 清单、API cursor/ledger 和一个可立即关闭 outbound 的 kill switch。

### 14.2 上线前（不向 operator 提供第二套应用）

- 完成历史 API backfill/replay，建立 inquiry/message 唯一约束。
- 注册并 canary 验证 `INQUIRY_MESSAGE_CREATED`，记录真实 payload、重投和方向行为。
- 运行 webhook 与 polling reconciliation 的离线差异报告；不建立第二个 operator UI。
- 用真实脱敏 fixture 完成 list/detail/reply/follow-up queue 和 target routing 验收。
- 确认旧 mail writer 可在 cutover 时一次关闭，新 API writer 可一次启用。
- 准备上一版 artifact 的受控 rollback，但不让旧版继续在线接单。

### 14.3 Cutover window

1. 暂停 customer-facing outbound。
2. 记录 mail writer 最终水位、API cursor 和数据库 checkpoint。
3. 关闭旧 Mercari inquiry mail canonical writes。
4. 执行边界窗口 API reconciliation/backfill。
5. 启用 webhook intake、API reconciliation 和新 canonical writer。
6. 将 `/inquiry/` 原位发布为新版应用，完成 operator smoke test。
7. 开放 operator review/compose/Send；自动 follow-up 不随本次 cutover 开启，必须由独立 roadmap Phase 获批后实施。

### 14.4 上线后 user-led stabilization

- 用户直接在新版处理真实咨询，并通过应用内或既定 issue 渠道反馈。
- 首日重点看新消息延迟、漏消息、重复、target 路由、Send/readback 和 queue removal。
- 采用小步 release 修正，不恢复长期双 UI。
- 严重故障时先关 outbound；若核心 ingest/list/detail 不可用，再按 checkpoint 回滚整个 `/inquiry/` release。回滚是事故动作，不是并行运营模式。

## 15. 实施阶段

### Phase 0 — Contract completion（无生产业务写入）

- 四店 auth 和最小读取已验证；补充记录稳定 shop identity/account mapping。
- 验证完整分页、message pagination、排序稳定性和 rate limit。
- 验证新回复、重开、删除/隐藏消息。
- 验证三种 target 和 product/order 展开字段。
- 验证附件下载合同。
- 输出字段字典、enum 清单、响应大小和调用预算。

退出条件：四店均通过；所有未知字段/状态已有 fail-closed 规则。

### Phase 1 — Local/shadow adapter

- 实现只读 Mercari client 和 normalized mapper（未来实施，当前不做）。
- 生成不写 canonical 表的 evidence artifact。
- 使用固定 fixture 和真实脱敏样本做 contract tests。
- 验证相同 page/message 重放的确定性。
- 定义并测试单一 `ingestAndProcess` orchestration contract，包括 partial failure 和 replay fixtures。

退出条件：相同输入产生相同 identity、target、message 和 hash。

### Phase 2 — Pre-go-live shadow evidence

- API 数据写入隔离 evidence/schema 或 observe-only ledger，不向 operator 暴露第二套应用。
- Mail ingestion 在 cutover 前暂时保持 canonical writer；这是后台证据比较，不是双 UI 运营。
- 按 shop/thread/message 对账至满足量化 gate；不强制设置固定并行天数。
- 分类 mismatch：missing、duplicate、late、status mismatch、target mismatch、attachment mismatch。

退出条件：所有差异有量化结果和解释；无未解释数据丢失。

### Phase 3 — Four-shop single cutover

- 四店在同一个受控窗口切换到新 API writer 和新版 `/inquiry/`，不按 shop 运行不同 UI。
- 每店仍保留独立 webhook registration health、cursor、kill switch 和 reconciliation 指标，便于隔离故障。
- 旧 mail writer 在新 writer 启用前关闭；切换边界通过 API backfill 补齐。
- Operator 在 canonical route 完成 list/detail/compose/Send/readback/follow-up smoke test。

退出条件：四店新事件持续到达、backlog 可处理、无重复 canonical writer、operator 可以完成核心闭环。

### Phase 4 — User-led stabilization 与自动跟进 gate

- 新版是唯一在用应用；收集 operator 实际反馈并小步发布。
- 后续如重新批准自动 follow-up，再按 replay/shadow、supervised batch、default auto 顺序单独开发和上线。
- UI 上线成功不自动授权自动发送；两个 gate 分开。

### Phase 5 — Retirement

- 从 `rp-mail-integration` 移除 Mercari inquiry scheduled integration。
- 保留其其他邮件职责。
- 删除只属于 Mercari inquiry email parsing 的 secret/config/KV state（需独立审查）。
- 更新 runbook、ownership、workload inventory 和 incident response。

## 16. 回滚与补偿

UI artifact、ingest/processor workload、schema 是三个独立 rollback unit；三项业务写开关（canonical ingest、daily-audit repair、outbound send）仍按 shop 隔离：

1. 关闭该 shop API ingest write switch。
2. 保留 API cursor 和失败 run evidence，不回退 cursor。
3. 只有新版核心功能无法快速恢复时才回滚上一稳定 release；不把旧版作为长期并行入口。
4. 如必须临时恢复 mail canonical writes，先确定唯一 writer 的时间边界和 ownership epoch，禁止与 API writer 重叠。
5. 对边界窗口读取 API/mail evidence，按 external inquiry/message identity 对账。
6. 仅通过幂等 ingestion contract 补写；禁止手工覆盖整行。
7. 修复后从最后 durable checkpoint 重放 API。

UI 可单独回滚上一 artifact；ingest/processor 暂停后保留 raw inbox 并重放；additive schema 默认 roll-forward，禁止通过 destructive down migration 删除已摄取事实。

数据库回滚不得删除已摄取消息。错误投影通过 superseding correction 或 soft quarantine 补偿。

## 17. 可观察性与运行指标

每店至少监控：

- discovery pages / inquiries scanned
- active threads reconciled
- messages created/updated/deduplicated
- API latency、HTTP/GraphQL error、429 rate
- cursor age / last successful run
- oldest unresolved thread
- quarantine count/age
- mail-vs-API shadow mismatch
- payload bytes和调用次数
- webhook received/duplicate/rejected counts
- webhook newest received 与 newest successfully processed timestamp
- webhook-to-Supabase durability latency、enrichment latency
- reconciliation recovered count，以及 webhook-vs-API gap
- per-shop webhook registration/topic/endpoint health

`candidates=0` 或 `scanned=0` 不能单独证明健康；必须同时检查 cursor age、API freshness 和已知 thread reconciliation。

## 18. User-visible acceptance

在 `https://ops.homesbliss.net/inquiry/` 对每个 canary shop 验证：

- 新商品咨询按正确 JST 时间出现；
- 旧 thread 新回复更新详情和“需要回复”判断；
- 售前显示正确 product/product variant；
- 有订单的会话不进入 Inquiry Portal 或 follow-up queue，而是正确路由到 ticket/售后域；
- 无商品/订单的 shop inquiry 仍可操作；
- 多消息顺序正确且不重复；
- 搜索、分类、人工 link/unlink、draft、copywrite、notes 不回归；
- 邮件延迟或重复不会创建第二条 canonical inquiry。
- Operator 可从详情页 review 完整 thread 并编辑最终回复。
- 点击 Send 前显示正确 shop、recipient/thread、最终文案和发送状态。
- 点击一次只创建一条 Mercari seller message；刷新/超时/retry 不重复发送。
- 平台回读成功后，Portal 显示已发送消息及默认 follow-up date（JST reply date + 3 天）。
- Operator 可覆盖 follow-up date、保存、刷新页面后仍保持覆盖值。
- 新客户回复到达后，旧 follow-up schedule 不再出现在 due queue，并进入 reply review。
- Follow-up date 到期后进入人工 queue，不自动发送；Operator review 后手动 compose/Send，或覆盖日期。
- Active queue 同时显示今日和逾期 item，未来 item 只在 upcoming 中显示。
- 人工发送成功后，该 item 无刷新延迟地从 active queue 消失，并可在 history 找到。
- 本期不存在程序批量 follow-up；未来若上线，必须经同一 finalizer 设置 `followed_up` 并从 queue 移除。
- 直接伪造 status 而无外部 message evidence 的请求被拒绝或进入 reconciliation exception。
- 两个 operator 或 operator+batch 同时尝试同一 cycle 时，最多一方发送成功。

### 18.1 Follow-up date 示例

| 事件 | 系统结果 |
|---|---|
| 9 月 3 日 JST 16:49 reply 回读成功，无人工日期 | 默认 `follow_up_due_date=2026-09-06` |
| Operator 发送前选择 9 月 8 日 | 发送成功后保存 9 月 8 日，`source=operator_override` |
| Operator 将 9 月 8 日改为 9 月 10 日 | 保存新值并写 audit event，不发送消息 |
| 客户在 9 月 5 日回复 | 原 schedule 标记 `superseded_by_inbound`，进入 reply review |
| 9 月 6 日到期且无客户回复 | 进入 follow-up review queue，等待 operator compose + Send |
| 9 月 6 日 operator 发送 follow-up 并回读成功 | `follow_up_state=followed_up`，立即从 active queue 移除并进入 history |
| Batch 已 claim 同一 cycle | Operator Send 被阻止并刷新状态，避免重复发送 |
| 9 月 7 日新增 seller reply | 开启新 cycle，due date 重置为 9 月 10 日，`follow_up_state=scheduled` |

## 19. Go/No-Go gates

### 允许进入实现

- POC #91 通过（Shop4 read proof、四店 bounded discovery/message read、Shop2 单条 send canary）。
- 本设计获得业务域、数据、安全和运行所有者批准。
- 固化所有权：`inquiry-automation` Cloudflare application service 经 ConoHa transport relay 摄取；部署清单需记录两个 entrypoint，但 relay 不拥有业务状态。
- 明确 shadow storage 与 retention。
- `INQUIRY_MESSAGE_CREATED` webhook payload 与重投行为已由 canary 固化。
- 新旧 writer 的单一 cutover 顺序、checkpoint 和 rollback runbook 已演练。

### 禁止 cutover

以下任一未完成则 No-Go：

- 任一 shop token/account mapping 失效或无法独立归属；
- 全量和增量 pagination 未证明无漏数；
- message/attachment 合同不完整；
- unique constraints、cursor ledger、quarantine 未部署验证；
- webhook 和 API reconciliation 尚未完成差异验证；
- 未建立 per-shop kill switch 和 rollback epoch；
- Portal 未完成 operator acceptance。

## 20. 待决策项

1. Shadow 数据使用独立表、schema 或对象存储 evidence；需要 retention/PII 决策。
2. `inquiry_messages` 是否作为本次迁移前置 schema；建议是。
3. Completeness audit 初始建议每日一次回看 72 小时；Phase 0 依据最大延迟验证窗口，每周评估 recovered count，连续 30 天为 0 后再决定是否降为每周。
4. `userInfo` 最小字段和 customer nickname 的必要性。
5. 共享 webhook ingress 是由 Ticket runtime 临时承载，还是建立中立 Mercari event gateway；无论部署位置，业务 handler 均归 `inquiry-automation` Cloudflare service，relay 仅做 transport。
6. Ticket 从 deprecated `ORDER_TRANSACTION_MESSAGE_CREATED` 迁移到 `INQUIRY_MESSAGE_CREATED` 的独立计划和 target router ownership。

## 21. 实施前交付清单

- [x] 四店 read/auth bounded POC 证据
- [x] 单条 `addInquiryMessage` canary 与 API/UI 双重回读证据
- [ ] 完整历史 pagination、错误矩阵和 rate-limit contract 报告
- [ ] GraphQL field/enum version snapshot
- [ ] API call/response-byte budget
- [ ] Canonical field mapping specification
- [ ] Status mapping decision record
- [ ] Reply/follow-up lifecycle state machine and event contract
- [ ] Follow-up date default/override API and UI specification
- [ ] Queue view/RPC predicate、索引和 response contract
- [ ] Operator/batch shared claim/finalize contract
- [ ] Concurrency lease、stale-thread check 和 duplicate-send test plan
- [ ] Message/attachment identity specification
- [ ] Database migration proposal（未执行）
- [ ] VPS/relay interface contract
- [ ] Shadow reconciliation specification
- [ ] Per-shop rollout/rollback runbook
- [ ] `INQUIRY_MESSAGE_CREATED` webhook payload/retry/direction canary fixture
- [ ] Durable webhook inbox、async enrichment、retry 与 reconciliation contract
- [ ] 单一 `/inquiry/` cutover checklist 和上一 release rollback drill
- [ ] Production acceptance checklist
- [ ] Ownership/governance documentation updates

## 22. 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1 | 2026-09-03 | 初始 API-source redesign 方案；仅规划和文档，无实现授权 |
| 0.2 | 2026-09-03 | 记录四店读取、33 条 thread 核对和 Shop2 单条发送 canary；保持自动/批量发送 No-Go |
| 0.3 | 2026-09-03 | 固定完整 operator loop；新增发送后三天默认 follow-up date、人工覆盖、due queue 和生命周期规则 |
| 0.4 | 2026-09-03 | 设计 today/overdue/upcoming queue、followed-up removal、循环重置和人工/批量发送统一并发合同 |
| 0.5 | 2026-09-03 | 基于 Mercari API 和 Supabase 事实定义自动跟进 hard gates、eligibility segments、reason codes 和 precision-first rollout |
| 0.6 | 2026-09-03 | 将订单/售后 ticket 移出 inquiry scope；简化为 READY/WAIT/SKIP，目标约 80% 售前 inquiry 默认发送提问式购买/支持 CTA |
| 0.7 | 2026-09-03 | 改为新版 `/inquiry/` 单一应用直接切换；采用 `INQUIRY_MESSAGE_CREATED` webhook 主触发 + API reconciliation，并明确复用 Ticket durability 模式而非订单领域模型 |
| 0.8 | 2026-09-03 | 依据 Ticket 生产数据将 reconciliation 从每 10 分钟降为每日 completeness audit；首发只做人工 follow-up queue，自动跟进移至后续路线图 |
| 0.9 | 2026-09-03 | 闭环独立架构审查：移除 source identity 分裂、补齐 resolved/admin-delete、固化 event/send idempotency、order target authority、Cloudflare/relay ownership、单一 follow-up state 和独立 rollback unit |
