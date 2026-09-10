# Phase: Mercari 售前咨询 API-first 重构

**Phase 状态：** Implementation in progress；production activation pending

**Change classification：** Architecture Change

**日期：** 2026-09-03

**业务域：** `inquiry_management`

**系统所有者：** `retailpulses/inquiry-automation`

**Canonical operator URL：** `https://ops.homesbliss.net/inquiry/`

**Canonical to-be architecture：** `docs/01_ARCHITECTURE.md`

**Detailed design：** `docs/proposals/mercari-inquiry-api-source-redesign.md`

**Decision：** `docs/adr/001-mercari-inquiry-api-first.md`
**相关 POC：** `retailpulses/inquiry-automation#91`

**Architecture Change Issue：** `retailpulses/inquiry-automation#92`

`docs/01_ARCHITECTURE.md` 已由 owner 指定为 canonical to-be system architecture。本 Phase 不重复拥有架构真相，只管理从 `docs/00_CURRENT_STATE.md` 所述运行状态到 canonical to-be 的实施、cutover、evidence 和 reconciliation。

## Phase governance summary

### Problem / value

邮件摄取无法稳定表达 Mercari thread/message identity、target、完整时间线和平台发送证据。本 Phase 要把无订单售前咨询改为 API-first，使 operator 在一个 canonical Portal 完成读取、处理、人工回复和人工 follow-up。

### Current operational delta

当前仍未切换的运行事实以 `docs/00_CURRENT_STATE.md` 为准：Mercari notification email/Zoho/mail-integration 负责发现，Supabase 是业务主数据，Inquiry Worker 和 Dashboard 处理内部 workflow，API 读写仍只是 POC。这些事实不再定义未来架构。

### Target state

Canonical target 由 `docs/01_ARCHITECTURE.md` 定义。本文件第 1–15 节提供 Phase execution contract：webhook-first、每日 completeness audit、API authoritative readback、唯一 canonical writer、新版 `/inquiry/` 直接 cutover，以及仅人工 outbound/follow-up queue。

### Affected boundaries

- Components：mail integration、Inquiry Worker、Dashboard/API、VPS relay、Supabase。
- Domains/data ownership：`inquiry_management` owner objects；只读消费 `product_catalog`；向 `ticketing` 路由订单 target。
- Interfaces/APIs：Mercari webhook、Inquiry GraphQL、outbound send/finalize、ticket routing contract。
- Runtime/deployment：Cloudflare + ConoHa fixed-egress relay；canonical `/inquiry/` 原位切换。
- Production workloads：新增 webhook ingest、daily completeness audit、operator send；退役 mail ingestion writer。
- Security/trust：webhook authentication、per-shop token、service-role、operator authorization、outbound kill switch。

### Bounded implementation workstreams

1. 完成 webhook/readback、message pagination、attachment 和 routing contracts。
2. 评审并部署 owner-domain schema/RPC/views。
3. 实现 durable ingest、processing/retry 和 daily audit。
4. 实现新版 operator UI、Send/finalize 和人工 follow-up queue。
5. 完成离线 replay、canary、single cutover 和 user-led stabilization。
6. Verify implementation against canonical to-be，并 reconcile evidence state、current state、ADR、local/central inventories 和 legacy retirement。

合规 Architecture Change Issue #92 已建立。实现、部署与 cutover evidence 均在该 Issue 下闭环；在生产 gate 未通过前不得把本地实现描述为 deployed/runtime verified。

## 1. 架构决策

Mercari 无订单售前咨询使用 Mercari Shops Inquiry API 作为平台事实来源，Supabase 作为业务主数据，由新版 Inquiry Portal 完成以下闭环：

```text
Webhook ingest
  -> durable event
  -> API readback + normalize + route + process
  -> operator review
  -> operator compose
  -> operator clicks Send
  -> Mercari API mutation + authoritative readback
  -> schedule manual follow-up for JST reply date + 3 days
  -> operator handles due item in manual follow-up queue
```

首发采用以下固定决策：

1. 新版直接发布到 canonical `/inquiry/`，不运行新旧双 UI。
2. API ingestor 是售前 inquiry 的唯一 canonical writer；旧 Mercari inquiry mail writer 在 cutover 时关闭。
3. `INQUIRY_MESSAGE_CREATED`、`INQUIRY_RESOLVED`、`INQUIRY_MESSAGE_ADMIN_DELETED` 是唯一实时 change triggers。
4. 每日一次 bounded API completeness audit 初始回看 72 小时，仅修复 missing/changed delta；不是第二条实时 ingestion 路径，窗口须由 Phase 0 最大延迟证据验证。
5. Operator 打开详情及点击 Send 前，对单 thread 做 fresh read。
6. 首发只支持人工回复和人工 follow-up queue，不开发自动 follow-up segmentation 或 batch send。
7. 订单/售后 conversation 在 domain routing 时交给 ticketing，不进入 Inquiry Portal、queue 或指标分母。

## 2. 系统边界

### 2.1 In scope

- `InquiryProductTarget` 且无订单的售前咨询；
- `InquiryShopTarget` 且无订单的售前咨询；
- inquiry/message webhook intake、API 回读、幂等持久化；
- 现有 classify、product link、draft/copywrite、notes、operator review；
- operator compose、Send、发送后权威回读；
- 默认三日 follow-up date、人工覆盖、today/overdue/upcoming/history queue；
- webhook completeness、失败重试、审计和回滚。

### 2.2 Out of scope

- `InquiryOrderTransactionTarget`、已有 order ID 或其他售后 ticket；
- 自动 follow-up、`READY/WAIT/SKIP` 自动决策和 batch send；
- 自动生成并直接发送首轮回复；
- 商品、订单或 ticket 主数据重建；
- 新旧 Portal 并行运营；
- Baserow 作为 inquiry 主数据或 job log；
- 本文档本身授权代码、migration、部署或 customer-facing mutation。

## 3. 事实所有权与唯一写入者

| 事实/能力 | 权威来源 | Canonical owner | 唯一写入者 |
|---|---|---|---|
| Platform inquiry/message/status/target | Mercari Shops API | Mercari | Mercari；内部只投影 |
| Raw webhook event | Mercari webhook payload | `inquiry_management` | Inquiry webhook receiver |
| Canonical presales inquiry | Supabase | `inquiry-automation` | Inquiry ingestion contract |
| Canonical inquiry message | Supabase | `inquiry-automation` | Inquiry ingestion/send finalizer |
| Operator state/draft/notes | Supabase | `inquiry-automation` | Portal API |
| Follow-up schedule/cycle | Supabase | `inquiry-automation` | Send finalizer / schedule API |
| Product master | Supabase shared product domain | RPagentOS/Catalog owner | Existing product writer |
| Post-order ticket | Supabase `ticketing` domain | `ticket-handling` | Ticket ingestion contract |
| Mercari outbound message | Mercari | `inquiry-automation` for presales | Controlled outbound service |

禁止事项：

- mail worker 与 API ingestor 同时写同一售前 inquiry；
- webhook receiver 与 completeness audit 各自实现不同 canonical upsert；
- Inquiry 直接写 ticketing-owned tables；
- Ticket handler 直接写 inquiry-owned tables；
- 平台 status 直接覆盖内部 workflow status。

## 4. 部署拓扑

```text
Mercari Shops
  |-- INQUIRY_MESSAGE_CREATED webhook
  |       -> Cloudflare Inquiry Worker
  |             -> Supabase raw event inbox
  |             -> async processor
  |                    -> fixed-egress relay on Conoha VPS
  |                    -> Mercari GraphQL API
  |                    -> canonical Supabase RPC/upsert
  |
  |-- GraphQL read/write
          <- Conoha fixed IPv4 160.251.141.110

Operator
  -> ops.homesbliss.net/inquiry/
  -> Inquiry Portal API
  -> Supabase views/RPCs
  -> controlled outbound service
  -> fixed-egress relay
  -> Mercari addInquiryMessage
```

Cloudflare Worker/Pages Functions 承担 application boundary；VPS relay 只提供固定 IPv4 transport，不拥有业务规则、cursor 或 canonical data。

## 5. Inbound event contract

### 5.1 Webhook 主路径

Mercari 当前 Schema 已确认：

- `INQUIRY_MESSAGE_CREATED`
- `INQUIRY_RESOLVED`
- `INQUIRY_MESSAGE_ADMIN_DELETED`

首版订阅并处理全部三个 topic：`INQUIRY_MESSAGE_CREATED` 触发 thread/message 回读，`INQUIRY_RESOLVED` 回读并更新 platform terminal status，`INQUIRY_MESSAGE_ADMIN_DELETED` 回读并对已删除 message 执行 change-aware tombstone。接收顺序不得改变：

1. 验证 HTTPS、每店 secret/HMAC、timestamp replay window、topic、shop identity 和必要字段。
2. 使用稳定 `event_identity` 幂等写入 raw event inbox：优先 `shop_key + topic + external_event_id`；payload 无 event ID 时 fallback 为 `sha256(schema_version + shop_key + topic + external_inquiry_id + external_message_id/null + occurred_at)`，状态设为 `pending`。
3. 新增成功或重复已存在时立即返回 2xx；durable insert 失败时返回可重试错误。
4. 通过异步 processor 回读完整 inquiry/messages。
5. 按 target 路由业务域，再执行 normalize、message upsert 和 processing。
6. 成功设为 `completed`；失败记录错误、attempt 和 `next_retry_at`。

Webhook payload 只是 change notification，不是完整 message 事实。正文、方向、status、target、删除状态和 attachment 必须来自 API authoritative readback。真实 payload/签名/redelivery fixture 和 fallback key collision test 是 production No-Go gate。

### 5.2 每日 completeness audit

- 频率：每日一次；
- 范围：每店 bounded scan，初始回看 72 小时；Phase 0 必须用观测到的最大 delivery/API delay 证明该窗口足够；
- 策略：一次批量读取已有 inquiry status 与 external message ID/hash/status，补 missing message，并 change-aware reconcile resolved、edit 和 admin-delete delta；
- 禁止：逐 message 数据库查询、重复 insert 探测、无变化业务行重写；
- 来源标记：`delivery_source='daily_audit'`；
- 指标：scanned、compared、recovered、rows_written、errors、bytes、requests。

若 `audit_recovered_count` 连续 30 天为 0，可提案降为每周；未经数据证明不得完全取消。

### 5.3 为什么不采用纯 webhook

Ticket 生产只读样本显示，2026-08-04 至 2026-09-03 的 303 条持久化消息中，223 条在 60 秒内到达，79 条延迟超过 5 分钟，其中 75 条超过 2 小时；最终全部 completed。由于 Ticket 未独立记录 webhook/reconciliation source，延迟数据是 recovered count 的代理而非精确归因，但足以保留低频完整性审计。

### 5.4 Domain routing

```text
InquiryProductTarget or InquiryShopTarget
  AND API orderTransaction is absent
    -> inquiry_management

InquiryOrderTransactionTarget
  OR API orderTransaction exists
    -> ticketing contract
    -> never project into Inquiry Portal
```

Mercari `InquiryOrderTransactionTarget.orderTransaction` 是订单关联 authority。正文 regex 得到的 `order_id` 仅是 routing hint：hint 与 API target 冲突或 API target 不完整时保存 raw evidence 并 quarantine/fail closed 到 ticketing review，禁止进入售前 queue。

## 6. Canonical data model

正式字段名由 migration 评审确定，但实现必须表达以下实体。

### 6.1 `inquiry_webhook_events`

- `event_identity` / unique constraint；生成规则见 5.1
- `topic`
- `shop_key`, external shop ID
- event occurred time、server received time
- `delivery_source`: `webhook | daily_audit | backfill`
- minimal raw payload
- `processing_status`: `pending | processing | completed | failed`
- attempts、last error、next retry、processed time
- correlation ID

### 6.2 `inquiries`

- `(shop_key, external_inquiry_id)` canonical unique identity；稳定 `source='mercari_shops'` 只表示 platform provenance，不参与 identity
- platform status、sales channel、first opened、last activity
- target type和 external product/variant/shop references
- internal workflow status、classification、product link、notes
- follow-up due date、date source、single cycle state、cycle identity
- last confirmed outbound message/time
- source observed time、bounded raw snapshot

订单 target 不写入该 domain 的 canonical inquiry cohort。

### 6.3 `inquiry_messages`

- `(shop_key, external_message_id)` canonical unique identity；稳定 `source='mercari_shops'` 只表示 provenance
- canonical inquiry FK
- `from`, body, sent time, platform status
- attachment metadata/reference
- source payload hash、first/last observed time
- outbound operation/idempotency reference

### 6.4 Operational ledgers

- ingestion run/cursor ledger
- quarantine/exception ledger
- outbound operation ledger
- immutable workflow/follow-up events

Raw evidence、canonical projection 和 operator workflow 不得压缩为一个可被反复覆盖的 JSON 字段。

## 7. Processing contract

所有触发源调用同一个 `ingestAndProcess` application contract：

```text
fetch/readback
  -> validate
  -> normalize identities and timestamps
  -> domain route
  -> idempotent inquiry/message persistence
  -> deterministic classification/product-link dispatch
  -> update run/event state
```

外部 API、数据库和 LLM 不是假想的单一事务。Partial failure 必须通过 stable identity 重放；LLM 或 product linking 失败不能撤销已经持久化的 platform message。

## 8. Operator application contract

### 8.1 Review queue

Operator 可以：

- 查看需要首次回复的售前 inquiry；
- 查看完整消息时间线、商品关联和分类结果；
- 编辑 draft/copywritten result；
- 保存 notes；
- 点击 Send；
- 查看 today/overdue/upcoming follow-up；
- 手动 follow-up、改期、跳过和查看 history。

### 8.2 Follow-up lifecycle

每次新的 seller reply 在 Mercari 权威回读成功后：

- 开启新的 `follow_up_cycle_id`；
- `follow_up_state='scheduled'`；
- 默认 `follow_up_due_date = JST reply date + 3 calendar days`；
- operator 可以覆盖并保存其他日期；
- `due/overdue` 由日期计算，不持久化为另一套状态；新 buyer reply 使旧 cycle `superseded_by_inbound`；
- 手动 follow-up 发送并回读成功后将 cycle 标记 `followed_up`，立即移出 active queue。

首发不会因为 due date 自动发送任何消息。

## 9. Outbound send/finalize contract

Operator Send 的固定顺序：

1. 验证 operator authorization、shop scope、CSRF 和 mutation kill switch。
2. Claim inquiry/cycle，阻止两个 operator 重复发送；lease TTL 覆盖 fresh read、mutation、readback 和 finalize 的最坏允许时长，过期 operation 先 reconcile。
3. Fresh-read 最新 thread；若客户已回复或 latest message 已变化，停止并刷新 UI。
4. 使用 `sha256(shop_key + external_inquiry_id + cycle_id + operation_version)` 生成 client operation/idempotency key；同一逻辑发送的 retry 必须复用该 key。
5. 对 ambiguous result 不盲目重试；先按 operation/message evidence 回读。
6. 通过 `inquiryMessages` 找到平台 seller message，确认 ID、方向、正文 hash 和时间。
7. 在一个数据库 transaction/RPC 中 finalize outbound ledger、canonical message、workflow state 和 follow-up schedule。
8. UI 只有在 authoritative readback + finalize 成功后显示“已发送”。

未来自动 follow-up 若获批准，必须复用同一 contract，不能建立第二套发送器。

## 10. Ticket Management 复用边界

复用：

- 固定 IPv4 Mercari relay；
- webhook registration/list 管理；
- durable insert before 2xx；
- Supabase unique idempotency；
- async enrichment、claim、retry；
- completeness audit 和 freshness health；
- authoritative readback 和 outbound ledger 模式。

不复用：

- `order_transaction_id` webhook payload 假设；
- ticket table、ticket status、售后 classifier；
- Ticket queue 和 operator lifecycle；
- deprecated `ORDER_TRANSACTION_MESSAGE_CREATED` 作为新 inquiry topic。

长期应建立共享 Mercari event/transport contract，并将 modern `INQUIRY_MESSAGE_CREATED` 通过 target router 分流；共享 transport 不获得两个业务域的 canonical write ownership。

## 11. 安全与隐私

- Mercari token 按 shop 隔离，只存在 approved secret store/runtime environment。
- 所有 Mercari GraphQL 请求经固定 IPv4 relay；日志不得输出 token。
- Webhook secret 不放入日志、raw payload或 operator URL。
- Frontend 不接触 service-role key 或 Mercari token。
- Message body、nickname、附件和 raw payload 按 PII 分级并定义 retention。
- Attachment 进入私有 storage，验证 size、MIME、magic bytes 和 content hash。
- Cloudflare Access/Portal session、actor audit 和 least privilege 覆盖全部 mutation。
- 三个业务写开关相互独立：canonical ingest write、daily-audit repair write、outbound send；per-shop processor pause 属于 ingest workload control。

## 12. 可观察性与 SLO

每店至少提供：

- webhook registration topic/endpoint health；
- newest event occurred、received、durable、processed timestamps；
- received、duplicate、rejected、pending、failed counts；
- webhook-to-durable 和 durable-to-processed latency；
- daily audit scanned/compared/recovered/errors/bytes/requests；
- latest canonical inquiry/message timestamps；
- quarantine count和 oldest age；
- outbound attempted/confirmed/ambiguous/failed；
- queue today/overdue age；
- cursor/checkpoint freshness。

健康不能只依据 `scanned=0`、`recovered=0` 或 HTTP 200；必须同时看 registration、freshness、processing backlog 和 known-thread readback。

## 13. Go-live 与回滚

### 13.1 上线方式

新版一次发布到 `/inquiry/`，四店在同一 cutover window 变更 writer ownership。不存在 shop 间不同 UI，也不存在长期 mail/API 双 writer。

### 13.2 Cutover 顺序

1. 暂停 outbound。
2. 记录旧 mail writer 水位、API checkpoint 和数据库 checkpoint。
3. 关闭旧 Mercari inquiry mail canonical writes。
4. 执行边界窗口 backfill。
5. 启用 webhook、processor、daily audit 和 API canonical writer。
6. 发布新版 `/inquiry/`。
7. 完成四店 list/detail/target routing/operator Send/follow-up queue smoke test。
8. 开放人工运营并收集反馈。

### 13.3 Rollback

- Outbound 问题：先关闭 outbound kill switch，不停止 inbound durability。
- 单店 ingest 问题：关闭该店 processing/write，保留 raw event 和 cursor。
- Portal 核心不可用：回滚整个 `/inquiry/` 到上一稳定 artifact。
- UI artifact、ingest/processor workload、schema 分别回滚：UI 可单独回退；ingest/processor 暂停后从 durable inbox 重放；additive schema 默认 roll-forward，不删除已摄取事实。
- 如必须恢复 mail writer，必须建立新的 ownership epoch，确保 API writer 已关闭。
- 不删除已摄取消息；修复后从 durable checkpoint 幂等重放。

旧版本 artifact 是事故恢复手段，不是并行运营应用。

## 14. 首发验收

- 四店三个 inquiry topics registration 和 payload/signature/redelivery canary 已验证。
- Webhook 在 durable insert 后返回 2xx；duplicate delivery 不产生重复 row。
- Legacy mail observation 与 API observation 回放后，`(shop_key, external_inquiry_id)` / `(shop_key, external_message_id)` 均保持一条 canonical row（zero-duplicate backfill test）。
- Product/shop target 正确进入 Inquiry Portal；order target 只进入 ticket route。
- 新旧 thread 消息完整、顺序正确、刷新不重复。
- Daily audit 可补入故意遗漏的 message，并修复 resolved/admin-deleted/status/hash delta；正常重复检查不写业务行。
- Operator 可完成 review、compose、Send、authoritative readback。
- 每次 seller reply 默认设置 JST +3 日，人工 override 刷新后保持。
- Due item 进入人工 queue；系统不会自动发送。
- 手动 follow-up 成功后从 active queue 移除并进入 history。
- Outbound ambiguous、并发 Send、客户抢先回复均不会重复发送。
- `/inquiry/` 是唯一 operator entry，旧 app/mail writer 不再处理 Mercari inquiry。

## 15. 后续路线图

以下不属于首发：

1. 基于新版真实数据回放自动 follow-up eligibility。
2. 重新评估约 80% 售前 inquiry 使用统一提问式 CTA 的目标。
3. Shadow、supervised batch、default auto 的独立审批与开发。
4. Ticket 从 deprecated topic 迁移到 `INQUIRY_MESSAGE_CREATED`。
5. 共享 Mercari event gateway/transport contract 的跨域收敛。
6. Daily audit 连续 30 天无 recovered item 后，评估降为每周。

## 16. Governance reconciliation

### 16.1 实施前必须完成

- 创建合规 Architecture Change Issue；POC #91 不能替代完整实施 Issue。
- 在 repo-local `SYNC_JOB_INVENTORY.md` 登记所有 proposed、migrating 和 retiring workload。
- 提交 `rp-governance-kit` companion PR：更新 inquiry domain objects、capabilities/access 和 database workloads。
- 在 `retailpulses/workers` inventory 中将 `inquiry_mail_ingestion` 标记为 migrating/retiring，并记录唯一 writer cutover。
- 为 webhook ingest、daily completeness audit 和 operator outbound 分别声明 workload ID、effect/risk、entrypoint、credential、request/byte budget、concurrency、timeout、retry、kill switch 和 freshness。
- 对新增 schema/RPC/view 准备 migration proposal、ownership header、local replay 和 hosted rollout gates。

### 16.2 Phase verification evidence

- [ ] Implementation verified against approved scope
- [ ] Tests/build complete
- [x] Real webhook payload durable receipt/readback captured（4 completed receipts；duplicate/retry paths covered by automated tests）
- [ ] Daily audit missing-message fixture recovered without unchanged writes
- [ ] Operator Send canary and authoritative readback captured
- [x] Deployment SHA recorded（Worker `b6d7456`；Dashboard `b29bbdc`）
- [x] Canonical `/inquiry/` exact route/release contract verified（interactive UI acceptance pending authenticated session）
- [x] Four-shop registration/freshness verified（3 topics/shop；daily audit twice）
- [x] Mail writer disabled and ownership epoch recorded（2026-09-03T14:19:05.599Z）

### 16.3 Phase close reconciliation

- [ ] Implementation/runtime verified against `docs/01_ARCHITECTURE.md`; architecture evidence status reconciled
- [ ] `docs/00_CURRENT_STATE.md` updated
- [ ] ADR status/lifecycle reconciled
- [ ] `docs/SYNC_JOB_INVENTORY.md` statuses reconciled
- [ ] Repo-local and central database ownership/workload declarations reconciled
- [ ] Replaced mail architecture explicitly marked legacy/retired
- [ ] Unresolved drift recorded as owned follow-up Issues

### 16.4 Governance document readiness

| Artifact | Current readiness | Required action |
|---|---|---|
| `docs/01_ARCHITECTURE.md` | Completed as canonical to-be architecture | Preserve architecture contract；at Phase close reconcile evidence status or approved deviations |
| This bounded Phase | Production cutover active；closeout pending | Capture real webhook receipt and one explicitly confirmed outbound finalizer canary |
| ADR-001 | Accepted；implemented/deployed | Reconcile final runtime evidence at Phase close |
| `docs/00_CURRENT_STATE.md` | Updated to deployed API-first current state | Reconcile again after outbound canary |
| `docs/SYNC_JOB_INVENTORY.md` | Production statuses and release SHAs recorded | Reconcile final outbound status after canary |
| `docs/16_DATABASE_GOVERNANCE.local.md` | Current Phase 1 declaration only | Add approved new objects/workloads when migration design is finalized |
| Central ownership/access/capability registries | Current Phase 1 objects only | Companion `rp-governance-kit` PR before production activation |
| Central database workloads | Existing entries contain schedule/status drift | Correct `inquiry_automation_worker`; add new Phase workloads and retirement relationships |
| `retailpulses/workers` inventory | Mail writer retirement not yet declared | Companion change before cutover |
| Governance installation metadata | Drift: `.github/governance-ref.txt` points to an older ref; `governance/local.yaml` remains a placeholder-style declaration and lacks actual owned/consumed domains/workloads | Run reviewed governance-kit upgrade/adoption reconciliation in a separate governance change |

Pending governance declarations do not block this design document, but every item marked “before production” blocks production activation. None of the pending items may be marked complete from source text alone.

Repository owner 已决定 `docs/01_ARCHITECTURE.md` 表达 canonical to-be，而不是继续维护旧 mail-based architecture；ADR-001 记录了这项有限文档角色偏离。`docs/00_CURRENT_STATE.md` 仍保留实际运行差异，evidence 和 Phase reconciliation 要求不变。

## 17. 变更控制

`docs/01_ARCHITECTURE.md` 是 canonical to-be architecture；本文件是 bounded execution/cutover/reconciliation contract。Proposal、Issue、PR 或实现如改变目标 architecture，必须先更新 `docs/01_ARCHITECTURE.md` 和 ADR，再同步本 Phase。

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-09-03 | 建立 API-first、webhook-first、daily completeness audit、人工 Send 和人工 follow-up queue 的 bounded Phase target architecture |
| 1.1 | 2026-09-03 | 关联 Architecture Change Issue #92；记录 schema/Worker/Portal 本地实现与测试进行中，生产 activation 尚未开始 |
| 1.1 | 2026-09-03 | 同步 architecture review closure：canonical identity、三个 webhook topic、change-aware audit、authority routing、send lease/key、single follow-up state 和 rollback units |
| 1.2 | 2026-09-04 | 对账生产 writer epoch、四店三 topic registration、Worker/Dashboard release 与双轮 daily audit；保留真实 webhook receipt/outbound canary close gates |
