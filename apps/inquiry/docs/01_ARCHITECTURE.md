# Inquiry Automation Canonical To-Be Architecture

Status: **Canonical to-be system architecture; local implementation in progress, not yet deployed**

Version: **1.1**

Last updated: **2026-09-03**

本文档定义 Inquiry Automation 唯一的目标系统架构。未来设计、Issue、Phase 和实现必须以此为准；旧邮件架构不再属于 architecture contract，只在 `docs/00_CURRENT_STATE.md` 中作为 cutover 前运行事实保留。

“Canonical”表示目标合同唯一，“to-be”表示尚未自动获得 Implemented、Deployed 或 Runtime verified 状态。实施进度和 cutover evidence 由 `docs/phases/mercari-inquiry-api-redesign/README.md` 管理。

## 1. 系统目的

Inquiry Automation 管理 Mercari 无订单售前咨询的完整 operator workflow：

```text
ingest
  -> processing
  -> operator review
  -> operator compose reply
  -> operator clicks Send
  -> platform readback
  -> schedule follow-up
  -> operator handles manual follow-up queue
```

系统目标是让 operator 在 `https://ops.homesbliss.net/inquiry/` 内完成售前咨询闭环，并以 Mercari 原生 inquiry/message identity 建立可去重、可重放、可审计的数据事实。

## 2. 系统边界

### 2.1 In scope

- 无订单的 `InquiryProductTarget`；
- 无订单的 `InquiryShopTarget`；
- Mercari webhook intake 与 API authoritative readback；
- inquiry/message normalize、deduplicate、classification 和 product linking；
- operator review、draft/copywrite、notes、compose 和 Send；
- seller reply 后默认 JST +3 日 follow-up date；
- operator date override；
- today、overdue、upcoming、history 人工 follow-up queue；
- webhook retry、每日 completeness audit、quarantine 和回滚。

### 2.2 Out of scope

- `InquiryOrderTransactionTarget`、已有订单的售后 conversation；
- ticket、order 或 product master 的生命周期；
- 首发自动 follow-up、自动 eligibility segmentation 和 batch send；
- 首发自动生成并直接发送客户消息；
- Baserow canonical data 或 Baserow job log；
- 新旧 Inquiry Portal 并行运营；
- 邮件作为 Mercari inquiry canonical source。

## 3. Architecture decisions

1. Mercari Shops Inquiry API 是 platform inquiry/message/target/status 的权威来源。
2. Supabase `inquiry_management` 是业务主数据。
3. 三个 inquiry topic webhook 是唯一低延迟 change trigger：message-created、resolved、admin-deleted。
4. 每日一次 bounded completeness audit 初始回看 72 小时；它只修复 missing/changed delta，不是第二条实时 reader，窗口须由 Phase 0 延迟证据验证。
5. Operator 打开详情和点击 Send 前，按单 thread fresh read。
6. 新版直接发布到 canonical `/inquiry/`，不运行双 UI。
7. API ingestor 与旧 mail writer 不得在同一 ownership epoch 并行写 canonical inquiry。
8. 订单 target 在 ingestion routing 时转交 ticketing，不进入 Inquiry Portal 或 follow-up queue。
9. 首发只提供 operator Send 与人工 follow-up queue。
10. 自动 follow-up 仅为后续路线图，必须另行批准、开发和上线。

## 4. Runtime topology

```text
Mercari Shops
  |-- INQUIRY_MESSAGE_CREATED / INQUIRY_RESOLVED / INQUIRY_MESSAGE_ADMIN_DELETED
  |       -> Inquiry webhook receiver (Cloudflare)
  |             -> Supabase durable raw event inbox
  |             -> async processing/retry
  |                    -> ConoHa fixed-egress relay
  |                    -> Mercari Inquiry GraphQL readback
  |                    -> target router
  |                    -> canonical Supabase ingest contract
  |
  |-- Inquiry GraphQL reads/writes
          <-> ConoHa relay, fixed IPv4 160.251.141.110

Daily completeness audit
  -> bounded Mercari Inquiry API scan per shop
  -> bulk compare inquiry status + message IDs/hashes/status
  -> persist missing/changed delta only

Operator
  -> ops.homesbliss.net/inquiry/
  -> Inquiry Portal/API
  -> Supabase views/RPCs
  -> controlled send/finalize service
  -> ConoHa relay
  -> Mercari addInquiryMessage
  -> inquiryMessages authoritative readback
```

Cloudflare Worker/Pages Functions 是 application boundary。ConoHa relay 只负责固定 IPv4 transport，不拥有业务规则、cursor、message ledger 或 canonical records。

## 5. Major components

| Component | Responsibility | Boundary |
|---|---|---|
| Inquiry webhook receiver | 验证、幂等持久化 raw event、快速返回 2xx | 不执行 LLM、product link 或 outbound send 后才确认 receipt |
| Async processor | API readback、normalize、route、canonical persistence、retry | 所有 trigger 共用同一 processing contract |
| Target router | 区分 presales inquiry 与 post-order ticket | 不把 order target 写入 inquiry cohort |
| Daily completeness audit | 发现 webhook 漏投并补 missing delta | 每日一次；无变化不写业务行 |
| Mercari relay | 固定 IPv4 GraphQL transport | 无业务 ownership、无持久化事实 |
| Inquiry Portal/API | Operator review、compose、Send、schedule、queue | Frontend 不接触 privileged credentials |
| Send/finalize service | Fresh read、idempotent mutation、readback、atomic finalize | Operator Send 的唯一 outbound writer |
| Supabase `inquiry_management` | Canonical business data、views、RPC、ledger | Domain owner 为 `inquiry-automation` |
| Ticket routing contract | 接收 order/post-order conversation | Ticketing owner 决定后续生命周期 |

## 6. Canonical inbound flow

### 6.1 Webhook receipt

1. 验证 HTTPS、每店 webhook secret/HMAC（constant-time compare）、timestamp/replay window、topic、shop identity 和必要字段；secret 只存在 approved secret store。
2. 按稳定 `event_identity` 写入 raw inbox，状态为 `pending`。优先键为 `shop_key + topic + Mercari external_event_id`；若 canary 证明 payload 没有 event ID，fallback 为 `sha256(schema_version + shop_key + topic + external_inquiry_id + external_message_id/null + occurred_at)`。禁止以整个可变 payload hash 作为唯一身份。
3. 新事件 durable insert 成功或 duplicate 已存在时返回 2xx。
4. 数据库无法持久化时返回 retryable error。
5. 异步 processor claim event 并执行 API readback。

首发必须订阅并处理 `INQUIRY_MESSAGE_CREATED`、`INQUIRY_RESOLVED` 和 `INQUIRY_MESSAGE_ADMIN_DELETED`。三者都只表示“thread 可能发生变化”，processor 均回读完整 inquiry/messages；resolved 更新 platform status 并退出 active queues，admin-deleted 以平台 message 状态/缺失事实执行 change-aware tombstone，禁止继续展示已删除正文。真实 payload、签名和 redelivery fixture 未经 canary 固化时为 No-Go。

### 6.2 Normalize and route

```text
InquiryProductTarget / InquiryShopTarget
  AND authoritative orderTransaction is absent
    -> inquiry_management

InquiryOrderTransactionTarget
  OR authoritative orderTransaction exists
    -> ticketing contract

unknown target
    -> quarantine
```

### 6.3 Daily completeness audit

- 每日、每店一次 bounded discovery，回看 72 小时；
- cursor pagination，不使用 unbounded/offset scan；
- 批量读取现有 inquiry status 与 external message ID/hash/status；
- 对 missing message、status change、message edit/admin-delete 写 delta；
- 对窗口内已知 active/recently-terminal thread 执行完整分页，窗口起点由 Phase 0 测得的最大 webhook/API 延迟验证；72 小时只是初始上限，证据不足不得 cutover；
- `unchanged_rows_written=0`；
- `delivery_source='daily_audit'`；
- 保存 requests、bytes、scanned、compared、recovered、written、errors。

若连续 30 天 `audit_recovered_count=0`，可提出降为每周；不得自动取消。

## 7. Canonical data ownership

| Fact/capability | Authority | Domain owner | Unique writer |
|---|---|---|---|
| Platform inquiry/message/status/target | Mercari | Mercari | Mercari；内部只投影 |
| Raw event receipt | Supabase | `inquiry-automation` | Inquiry webhook/audit ingress contract |
| Canonical presales inquiry/message | Supabase | `inquiry-automation` | Canonical ingestion RPC/service |
| Operator state/draft/notes | Supabase | `inquiry-automation` | Portal API |
| Follow-up schedule/cycle | Supabase | `inquiry-automation` | Send finalizer / schedule API |
| Product master | Supabase product domain | RPagentOS/Catalog owner | Existing product writer |
| Post-order ticket | Supabase ticketing domain | `ticket-handling` | Ticket ingestion contract |
| Presales outbound message | Mercari | `inquiry-automation` | Controlled send/finalize service |

禁止跨域直接写 owner-owned tables。跨域交互使用稳定 view、RPC 或 authenticated service contract。

## 8. Canonical data model

### 8.1 Durable event inbox

- `event_identity` unique constraint，生成规则见 6.1；
- topic、shop identity；
- event occurred/server received timestamps；
- `delivery_source = webhook | daily_audit | backfill`；
- minimal raw payload；
- `processing_status = pending | processing | completed | failed`；
- attempts、next retry、last error、processed time、correlation ID。

### 8.2 `inquiries`

- `(shop_key, external_inquiry_id)` canonical unique identity；`source='mercari_shops'` 是稳定 platform family/provenance，不参与 writer identity；
- platform status、sales channel、first opened、last activity；
- target type、external product/variant/shop references；
- internal workflow、classification、product links、draft/notes；
- follow-up due date、date source、单一 cycle state、cycle identity；
- last confirmed outbound message/time；
- observed time、bounded raw snapshot。

### 8.3 `inquiry_messages`

- `(shop_key, external_message_id)` canonical unique identity；`source='mercari_shops'` 仅为 provenance；
- inquiry FK；
- `from`、body、sent time、platform status；
- attachment metadata/reference；
- source hash、first/last observed time；
- outbound operation/idempotency reference。

### 8.4 Operational records

- ingestion run/cursor ledger；
- quarantine/exception ledger；
- outbound operation ledger；
- immutable workflow/follow-up events。

Raw evidence、canonical projection 与 operator workflow 不得压缩成一个反复覆盖的 JSON 字段。

## 9. Processing contract

Webhook、daily audit 和 backfill 必须调用同一个 `ingestAndProcess` contract：

```text
fetch/readback
  -> validate
  -> normalize identity/time/direction
  -> domain route
  -> idempotent canonical persistence
  -> classify/link dispatch
  -> finalize event/run status
```

外部 API、数据库和 LLM 不是单一事务。Message durable persistence 不得依赖 LLM、product matching 或 notification 成功；partial failure 通过 stable identity 重放。

## 10. Operator workflow

### 10.1 Primary queue

Operator 能够查看 inquiry list/detail、完整 message timeline、分类、商品关联、draft/copywritten result 和 notes，并编辑最终回复。

### 10.2 Send

Operator 点击 Send 后：

1. 验证 actor、shop scope、CSRF 和 outbound kill switch。
2. Claim inquiry/cycle，lease TTL 必须覆盖 fresh read + mutation + authoritative readback + finalize 的最坏允许时长；超时进入 unknown-result reconciliation，不能直接重发。
3. Fresh-read thread；若客户已回复或 latest message 改变，停止并刷新 UI。
4. 使用 `sha256(shop_key + external_inquiry_id + follow_up_cycle_id-or-reply_cycle_id + operation_version)` 生成唯一 client operation/idempotency key 调用 `addInquiryMessage`；相同逻辑发送重试复用同一 key。
5. Ambiguous result 不盲目 retry，先查询平台事实。
6. 通过 `inquiryMessages` 确认 seller message ID、方向、正文 hash 和时间。
7. 以数据库 transaction/RPC finalize ledger、canonical message、workflow 和 follow-up schedule。
8. 只有 authoritative readback + finalize 成功后 UI 才显示已发送。

### 10.3 Manual follow-up queue

每次新的 seller reply 权威回读成功后：

- 新建 `follow_up_cycle_id`；
- `follow_up_state='scheduled'`；
- 默认 `follow_up_due_date = JST reply date + 3 calendar days`；
- operator 可覆盖并保存其他日期；
- `due/overdue` 由日期投影计算，不另存第二套状态；新 buyer reply 使旧 cycle `superseded_by_inbound`；
- 到期进入 today/overdue manual queue；
- operator 手动 follow-up 并回读成功后将 cycle 标记 `followed_up`，移出 active queue并进入 history；另有 terminal state `do_not_follow_up`、`cleared`。

首发不会因 due date 自动发送消息。

## 11. Ticket Management relationship

复用 Ticket 已验证的模式：

- fixed-IP Mercari relay；
- webhook registration/list administration；
- durable insert before 2xx；
- database unique idempotency；
- async claim/enrichment/retry；
- completeness audit/freshness health；
- authoritative outbound readback。

不复用：

- `order_transaction_id` payload assumption；
- ticket schema/status/classifier/queue；
- deprecated `ORDER_TRANSACTION_MESSAGE_CREATED` 作为新 topic；
- Ticket 对 inquiry canonical tables 的直接写入。

长期可共享 Mercari event/transport contract，但共享 transport 不能拥有 inquiry 或 ticket 两个 domain 的 business data。

## 12. Security and trust boundaries

- Shop token 独立，保存在 approved secret store/runtime environment。
- Mercari GraphQL 只经固定 IPv4 relay；不得记录 token。
- Webhook credential 不进入日志、raw payload 或 operator URL。
- Frontend 不获得 service-role 或 marketplace credential。
- Message body、customer identity、attachment 和 raw payload 按 PII 分类和 retention 管理。
- Attachment 写入 private storage，并校验 size、MIME、signature 和 content hash。
- Cloudflare Access/session、actor audit、least privilege 覆盖全部 mutation。
- 三个业务写开关相互独立：webhook/API canonical ingest write、daily-audit repair write、outbound send；processor pause 使用 ingest workload 的 per-shop processing control，不虚构第四个 writer switch。

## 13. Architecture invariants

1. 一个售前 inquiry/message 只有一个 canonical identity 和 writer contract。
2. Webhook receipt 必须先 durable，再执行 enrichment。
3. Webhook 不等于完整 message；平台事实必须 readback。
4. Completeness audit 只写 delta，禁止 unchanged rewrites 和 N+1 database/API loops。
5. Order target 永不进入售前 inquiry cohort。
6. Platform status 与 internal workflow status 分离。
7. External send success 必须以 Mercari message evidence 证明。
8. Ambiguous external result 先 reconcile，禁止 blind retry。
9. Product catalog 和 ticketing 通过 owner-defined contract 访问。
10. 旧 mail writer 与新 API writer 不得重叠。
11. Canonical Portal 只有 `/inquiry/`，不运行双 UI。
12. 自动 follow-up 不属于首发，不能由配置偶然启用。
13. Mail/API 是同一 Mercari platform fact 的不同 delivery provenance；不得借 `source` 分裂 canonical identity。

## 14. Observability and health

每店至少监控：

- webhook registration topic/endpoint；
- newest occurred/received/durable/processed timestamps；
- received/duplicate/rejected/pending/failed counts；
- webhook-to-durable、durable-to-processed latency；
- daily audit requests/bytes/scanned/compared/recovered/written/errors；
- quarantine count/oldest age；
- outbound attempted/confirmed/ambiguous/failed；
- queue today/overdue age；
- cursor/checkpoint freshness。

`HTTP 200`、`scanned=0` 或 `recovered=0` 不能单独证明健康。

## 15. Go-live architecture

新版 `/inquiry/` 在一个受控 cutover window 直接替换旧 operator app 和 writer ownership：

1. 暂停 outbound。
2. 记录 mail writer waterline、API checkpoint 和 database checkpoint。
3. 关闭旧 Mercari inquiry mail writes。
4. 执行边界 backfill。
5. 启用 webhook、processor、daily audit 和 API writer。
6. 原位发布新版 `/inquiry/`。
7. 完成四店 list/detail/routing/operator Send/manual follow-up smoke test。
8. 开放真实 operator 使用和反馈。

旧 release artifact 只用于事故回滚，不作为并行应用。

## 16. Failure and rollback model

- Outbound 异常：先关闭 outbound，不停止 inbound durability。
- 单店 ingest 异常：停止该店 processing/write，保留 raw events 和 checkpoint。
- Portal 核心不可用：整体回滚 `/inquiry/` release。
- UI artifact、ingest/processor workload、schema 三者是独立 rollback unit：UI 可单独回滚；ingest/processor 用开关暂停并从 durable inbox 重放；已部署 additive schema 默认 roll-forward，不以 destructive down migration 删除事实。
- 如临时恢复 mail writer，必须先关闭 API writer并建立新的 ownership epoch。
- 不删除已摄取 message；修复后幂等重放。

## 17. Evidence status

| Capability | Evidence state |
|---|---|
| Four-shop `inquiries`/`inquiryMessages` read | Runtime verified POC |
| Shop2 single `addInquiryMessage` canary | Runtime verified POC and operator UI confirmation |
| `INQUIRY_MESSAGE_CREATED` schema availability | Runtime verified by production introspection |
| API-first production ingestion | Deployed；ingest writer active；四店三 topic registration readback verified；4 条真实 receipt 均 completed/attempts=1 |
| New `/inquiry/` application | Deployed；exact route/release contract verified；interactive acceptance 受当前 Access session 限制 |
| Operator API Send | Deployed but fail-closed；旧 POC canary 不替代新版 finalizer canary |
| Manual follow-up queue | Deployed；schema/RPC 与 local lifecycle verified；等待 authenticated operator acceptance |
| Daily completeness audit | Active；四店连续两轮 errors/recovered/rowsWritten 均为 0 |
| Automatic follow-up | Roadmap only；out of first-release scope |

## 18. Canonical reading order

1. `docs/01_ARCHITECTURE.md` — canonical to-be architecture
2. `docs/00_CURRENT_STATE.md` — temporary operational delta until cutover
3. `docs/phases/mercari-inquiry-api-redesign/README.md` — implementation/cutover/reconciliation Phase
4. `docs/adr/001-mercari-inquiry-api-first.md` — decision rationale
5. `docs/proposals/mercari-inquiry-api-source-redesign.md` — detailed design/evidence
6. Database, sync-workload and deployment governance

## 19. Change control

任何改变 boundary、ownership、trigger model、data semantics、outbound contract、follow-up scope、runtime topology 或 major invariant 的变更，必须先更新本文件和 ADR，再进入实现。

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-09-03 | 初始 current-state architecture，现已被 1.1 取代 |
| 1.1 | 2026-09-03 | 按 owner 决策将本文档改为唯一 canonical to-be architecture；旧架构仅留在 Current State |
| 1.2 | 2026-09-03 | 闭环独立架构审查：统一 source-neutral identity、三 topic/status/delete reconciliation、event/send idempotency、order authority、runtime ownership、单一 follow-up state 与分层 rollback |
| 1.3 | 2026-09-03 | 关联实施 Issue #92 并将 evidence state 更新为本地实现/测试完成、生产尚未部署；不改变 canonical target contract |
| 1.4 | 2026-09-04 | 对账生产 cutover：API writer、四店三 topic、daily audit 与 legacy mail retirement 已生效；保留真实 payload 与新版 outbound canary 门槛 |
