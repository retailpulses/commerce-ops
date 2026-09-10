# Canonical TRD：平台隔离的消息发送与摄取架构

- 文档状态：Canonical implementation baseline；WP1-WP4c 已合并；WP5-WP7 待完成；hosted migration 与生产 activation 未获批准
- 版本：v1.7.5
- 日期：2026-09-09 JST
- 领域：`ticketing`
- 所有者：`retailpulses/ticket-handling`
- 适用平台：Mercari Shops、Rakuten R-Messe、Amazon SP-API + Zoho Mail ingestion
- Canonical incident plan：`docs/plans/2026-09-08-ticket-portal-send-schema-drift.md`
- 相关 Amazon 设计：`docs/plans/issue-235-amazon-mail-canonical-plan.md`、`docs/trd/amazon-buyer-message-mail-workflow.md`（以本 TRD 的跨平台边界为准）

本文定义 Ticket Portal 消息发送与客户消息摄取的长期架构边界。平台专有功能文档只能在本边界内扩展；若发生冲突，本 TRD 对跨平台隔离、发布门禁和共享对象治理具有优先权。

## 1. 背景与问题

2026-09-08，Mercari 操作员回复在外发前失败：Worker 的通用 outbox repository 向 `sent_messages` 提交 Amazon 专有字段，而当前 PostgREST 暴露 schema 不包含该字段。该事件确认了 Worker/PostgREST contract drift，并暴露出更根本的问题：平台 service 已分开，但 persistence lifecycle、migration、scheduler 和 release gate 仍可跨平台传播故障。

### 1.1 证据与根因分层

| 层级 | 已验证事实 | 结论 |
|---|---|---|
| 用户可见症状 | Ticket Portal 在确认发送 Mercari 回复后显示：PostgREST schema cache 找不到 `sent_messages.reviewed_customer_message_at` | 失败发生在 claim/persistence 阶段，截图不能证明 provider 收到消息 |
| 直接技术原因 | 通用 repository 序列化 `reviewed_customer_message_at`；该列由 Amazon migration 定义，而当时运行环境未暴露该列 | Mercari send 对 Amazon schema capability 形成了不应存在的硬依赖 |
| 系统性根因 | 三个平台虽有 adapter 名称，但共享 send artifact、通用 persistence payload、scheduler invocation、迁移与发布门禁 | 一个平台的开发或 schema 漂移可以阻断另一平台 |
| 控制缺口 | 发布前没有以目标 Worker service identity 验证 exact RPC/column/PostgREST contract，也没有逐平台 canary/readback | source/CI 绿色无法证明 hosted runtime 可发送 |

事件边界：没有 provider-side authoritative readback 时，不得把该失败标记为“未发送”或“已发送”；对应 operation 必须按平台规则确认是否在 provider mutation 前失败，或进入 `ambiguous` reconciliation。本文不授权重试该真实消息。

事件发生时的摄取侧也存在相同风险（WP2 已在代码中修复 Mercari source fence，但 hosted 安装/readback 仍待 WP6）：

- Amazon migration 修改 Mercari 原有 `inbound_ticket_messages` 的 nullability 和 CHECK；
- 事件发生时的新 CHECK 要求 Mercari `source_received_at` 非空，但当时 Mercari webhook writer 不写该字段；
- legacy Mercari retry claim 没有 source filter；
- Amazon、Rakuten 与 Mercari scheduled work 共用一个 invocation 和资源预算。

## 2. 目标与完成定义

### 2.1 目标

1. `platform` 成为后端强制执行的安全与故障域边界。
2. 任一平台的 provider、schema、RPC、feature flag、retry 或部署变化不得使另一平台的既有发送/摄取路径失败。
3. 保留单次外发、权威回读、线程 freshness、客户消息幂等、`needs_reply` 正确性和完整审计。
4. Portal 保持统一操作体验；统一展示不等于统一 write contract。
5. 所有 schema 与生产动作具备明确所有者、兼容顺序、readback、canary、kill switch 和 forward recovery。

Supabase 是 ticket、normalized messages、outbox、审计与幂等状态的唯一内部事实主库；Baserow 不参与该 contract。平台 provider 的权威 readback 是外部投递/接收事实来源，两者必须通过平台 RPC 对账，不得以内部 `sent` 单方面替代 provider 证据。

### 2.2 Definition of done

- 三个平台各有独立 typed adapter、repository/RPC、provider client、配置、health、测试和 canary。
- Mercari/Rakuten 完整 send lifecycle 在不含 Amazon objects 的 legacy schema fixture 上通过。
- Amazon migration 不修改 Mercari/Rakuten 专有约束或 writer contract。
- Mercari retry worker 无法 claim 或 mutate 非 Mercari evidence；其他平台同理。
- 任一 provider 超时或 schema capability 缺失不会阻止另两个平台执行或保持可用。
- shared-core migration 对三平台 transaction fixtures 全部通过后才能发布。
- 生产验收包含精确 release SHA、migration ledger/schema/PostgREST readback 和每个平台单独批准的 canary。

### 2.3 当前事实与剩余缺口（2026-09-09）

| 范围 | 当前状态 | 尚不能宣称完成的原因 |
|---|---|---|
| WP1/WP2 send containment + Mercari source fence | 已合并 | hosted objects/readback 尚未完成 |
| WP3 isolated schema baseline | 已合并 | 尚未在 hosted Supabase 按平台安装并验证 |
| WP4 send router | 已合并；Amazon generic reply fail-closed | provider adapter 仍共用一个 Worker release artifact |
| WP4b Amazon mail ingestion v3 | 已合并；staging deployment 已运行 | staging smoke/promotion evidence 尚需收敛；功能保持关闭 |
| WP4c unified queue | 代码已合并（PR #245，`7cc5eff8fceb5d7c666873838206f478719631ce`） | list DTO 正文最小化、versioned cursor、hosted schema/readback 与生产验收未关闭 |
| WP5 physical runtime isolation | 未完成 | scheduler 与发送 adapter 仍可能共享 invocation/artifact/resource budget |
| WP6 installer/verifier | 未完成 | 缺逐平台 hosted installer、ACL/signature/ledger/PostgREST readback artifact |
| WP7 production activation | 未开始 | 缺新鲜 PITR/backup、exact-SHA approval、逐平台 canary 与 rendered production acceptance |

合并、CI 绿色或 staging health 不能单独满足本 TRD 的完成定义。

## 3. 非目标

- 不改变当前 Ticket Portal 的 Reply Composer 位置、确认弹窗或操作员主要流程。
- 不把 Baserow 恢复为消息 master；Supabase 继续是业务事实源。
- 不统一三个 provider 的 native thread/message identity、freshness 或 retry 规则。
- 不以删除 `sending`/`ambiguous` 行、清理历史证据或盲目重试作为恢复方案。
- 不在本 TRD 中批准生产 migration、Worker deployment、Amazon activation 或真实客户消息发送。

## 4. 架构原则

### 4.1 Single route selection

Portal 继续调用一个认证端点：

`POST /tickets/api/ticketing/tickets/:ticket_id/send`

请求不得选择 provider credentials、账号、线程或收件人。后端读取 authoritative ticket，依据 `tickets.platform` 从 allow-list 选择唯一 adapter。请求中的 platform（如未来保留）只能作为一致性断言；与数据库不一致时返回 `PLATFORM_MISMATCH`，且不得写 outbox。

```text
Authenticated send endpoint
  -> load authoritative ticket
  -> PlatformSendRouter
       mercari -> MercariSendAdapter
       rakuten -> RakutenRmesseSendAdapter
       amazon  -> AmazonSpApiSendAdapter（仅 action-specific；否则人工 fallback）
       other   -> PLATFORM_SEND_UNSUPPORTED
```

### 4.2 Stable core, isolated platform context

共享 core 只保存所有平台都具有相同语义的事实：

- ticket ID；
- platform discriminator；
- client operation UUID；
- immutable final body；
- reply intent；
- generic delivery state；
- provider message ID；
- operator、created/sent timestamps 和非 PII error code。

Provider baseline、reviewed source、thread revision、lease generation、mail authentication、folder/account identity、attachment lifecycle 等不得加入共享 DTO 或由其他平台 repository 序列化。

### 4.3 Common reads, separate writes

统一 Portal queue/thread 可以读取稳定的 versioned view/API projection。平台 writer 只能调用本平台 table/RPC。禁止使用 `select('*')` 作为跨平台 API contract；所有 read projection 必须显式列字段并有版本。

### 4.4 Fail one platform closed

平台缺配置、schema capability、provider availability 或 migration 时，仅该平台返回明确 unavailable 状态。共享 health 不得以单一绿色状态掩盖平台失败，也不得因一个平台红色而错误宣布其他平台不可用。

## 5. 目标组件

### 5.1 Application interfaces

```ts
type Platform = "mercari" | "rakuten" | "amazon";

interface SendCommand {
  ticketId: string;
  clientOperationId: string;
  body: string;
  replyIntent: "terminal" | "holding";
  reviewedToken?: unknown; // router 不解释；交给选中的 adapter 验证
  actorId: string; // 仅由已认证 server session 注入，客户端不可提供/覆盖
}

interface SendResult {
  platform: Platform;
  platformMessageId: string;
  sentAt: string;
  replayed: boolean;
  warningCode?: string;
}

interface PlatformSendAdapter {
  readonly platform: Platform;
  send(ticket: TicketDetail, command: SendCommand): Promise<SendResult>;
}
```

`reviewedToken` 在 route 层保持 opaque。每个平台定义自己的 schema：Mercari/Rakuten 使用实际 thread freshness；Amazon 使用 reviewed customer ID/time/revisions。不得建立包含三个平台全部 optional 字段的 mega DTO。

### 5.2 Platform send ownership

| 能力 | Mercari | Rakuten | Amazon |
|---|---|---|---|
| Adapter | `MercariSendAdapter` | `RakutenRmesseSendAdapter` | `AmazonSpApiSendAdapter` |
| Provider | Mercari GraphQL | fixed-egress RMS relay | SP-API Messaging action-specific operation |
| Freshness | latest buyer message/thread snapshot | latest R-Messe user reply | reviewed customer source + customer/thread revision |
| Mutation | Mercari reply mutation | R-Messe reply endpoint | allow-listed SP-API action；不支持则人工 Seller Central fallback |
| Reconciliation | new seller message vs baseline | new merchant reply vs baseline | account/thread/time/body/provider ID constrained Sent readback |
| Kill switch | `MERCARI_OUTBOUND_ENABLED` | `RAKUTEN_RMESSE_OUTBOUND_ENABLED` | `AMAZON_SPAPI_OUTBOUND_ENABLED` |
| Repository/RPC | Mercari-only | Rakuten-only | Amazon-only claim/fence/finalize |

### 5.3 Send state machine

每个平台独立实现相同的抽象阶段，但不得共享 platform-specific SQL/payload：

```text
new
 -> claimed
 -> baseline_persisted
 -> provider_mutation_started
 -> sent
                 \-> ambiguous -> reconciled_sent
                              \-> confirmed_not_sent (仅满足该平台安全证明后)
```

要求：

1. claim/replay lookup/preflight/release/ambiguous/finalize 是一个完整平台 contract；不得只拆 claim。
2. provider mutation 前失败可仅在本平台规则允许时 release。
3. mutation 开始后不得盲目 release 或再次发送；必须 reconciliation。
4. finalize 必须验证 operation、ticket、platform 和 immutable body/intent。
5. terminal reply 只有在该平台最新可信客户证据仍与 reviewed state 一致时才能清除 `needs_reply`。

## 6. 数据模型

### 6.1 Send core

保留 `public.sent_messages` 作为稳定 core，允许字段仅包括：

- `id`, `ticket_id`, `platform`, `client_operation_id`；
- `body`, `reply_intent`, `sent_by`；
- `delivery_status`, `delivery_error_code`；
- `platform_message_id`, `sent_at`, `created_at`, `updated_at`。

不得再向 core 增加单一 provider 才理解的字段。现有 `platform_message_ids_before_send` 可在兼容期保留只读，但新代码将 baseline 移入 platform context。

Canonical idempotency domain 为现有 `UNIQUE(ticket_id, client_operation_id)`；ticket 的 authoritative platform 是该 operation 的平台边界。同一 operation 在同一 ticket 重放相同 immutable body/intent 时返回原结果，重放不同 body/intent 时返回 `CLIENT_OPERATION_CONFLICT` 且不得调用 provider。claim/finalize/release 必须同时核对 ticket、authoritative platform、operation、body 与 intent。

### 6.2 Platform send context

新增或收敛为一对一 Worker-only tables：

- `mercari_send_context(sent_message_id PK/FK, transaction_id, message_ids_before_send, mutation_started_at, ...)`
- `rakuten_rmesse_send_context(sent_message_id PK/FK, inquiry_number, reply_ids_before_send, mutation_started_at, ...)`
- `amazon_spapi_send_context(sent_message_id PK/FK, action_type, external_order_id, request_fingerprint, provider_mutation_started_at, spapi_request_id, ...)`

每个 context table、constraint、index 和 RPC 由对应平台 migration 拥有。Amazon mail evidence 不属于 outbound context；SP-API action payload 只保存不可逆 fingerprint，不保存 raw request。跨表 finalize 通过平台专用 SECURITY DEFINER RPC 在单一事务中更新 core、context、`ticket_messages`、`ticket_events` 和 ticket state。

### 6.3 Ingestion persistence

现有 `inbound_ticket_messages` 是 Mercari webhook queue，保留为 Mercari-owned compatibility object；Amazon 不再向其增加 provider 字段或修改其 CHECK/nullability。

- Mercari：`inbound_ticket_messages` + Mercari-only claim/enrichment/forwarding RPC；
- Rakuten：`rakuten_rmesse_inquiries` + `rakuten_rmesse_sync_state` + Rakuten ingest RPC；
- Amazon：新建 `amazon_mail_messages` + `amazon_mail_sync_state` + Amazon ingest/attachment RPC；
- Shared normalized facts：三个平台仅通过各自 RPC 幂等写入 `tickets`、`ticket_messages`、`ticket_events`。

如果 hosted readback 发现 Amazon migration 已安装，禁止 destructive move。先新增 Amazon-owned table，执行有界、可审计、显式批准的 copy/backfill，双读核对后切换 writer/read view；原字段保留到独立清理 Issue。

### 6.4 Unified operator queue

使用 Worker `ticket_inbound_queue_v1` composition API；不得创建同时硬依赖三套平台 table 的数据库 view。这里的 composition 是三个独立 repository projection 的应用层合并，不是 SQL `UNION`：

```text
MercariQueueRepository  ─┐
RakutenInquiryRepository ├─ allSettled -> normalize -> sort/page -> queue DTO
AmazonMailRepository     ─┘
```

统一字段仅包括 source/platform、native display identity、received time、masked customer/display context、queue/review state、linked ticket 和 attachment summary。Provider secrets、完整邮件头、匿名邮箱、tokens、原始附件路径不得进入该 view。

所有 queue action 必须经 typed dispatcher 路由到且仅路由到一个 authoritative source；不能只隔离 list：

- opaque ID 必须 source-qualified，例如 `mercari:<uuid>`、`amazon:v2~<uuid>`、`amazon:legacy~<uuid>`；不得凭 UUID 试探多个 repository；
- list/detail/update/ignore/link/convert/by-ticket/unread 分别声明每个平台的 `allowed_actions`；不支持的动作在 UI 禁用且后端返回稳定的 `ACTION_UNSUPPORTED`；
- 并行读取使用 `Promise.allSettled`。单一 source 失败返回 `partial=true` 与脱敏 source error code，其他 source 的结果仍返回；不得把失败平台伪装成零条，也不得把整页升级为 HTTP 500；
- 目标全局顺序固定为 `(received_at DESC, source ASC, id ASC)`；versioned cursor 必须包含同一 tuple。当前 offset 实现只能作为受限过渡路径，并发 ingestion 时可能重复/漏项，不满足最终稳定分页 exit gate；
- Amazon legacy/v2 双读以 provider account + native message ID 去重，优先 v2；冲突进入 review/error，不静默覆盖；
- Rakuten inquiry 是已关联 ticket 的 aggregate，不得伪装成 Mercari 未处理 queue row，也不得开放不适用的 convert/link 动作；
- projection 使用显式 PII allowlist；正文、原始 headers、匿名邮箱、token 与内部 storage path 不进入 list DTO。当前 Mercari `latest_buyer_message` 与 Amazon `body` 仍需移出 list projection，仅允许认证 detail endpoint 返回，因此 WP4c 的 PII gate 尚未关闭。

| Action | Mercari owner | Rakuten owner | Amazon owner | 强制规则 |
|---|---|---|---|---|
| detail/review | Mercari queue repo | Rakuten inquiry repo | Amazon mail repo | 服务端重读 source row；client source 仅作断言 |
| ignore | Mercari queue RPC | 不支持或 Rakuten 专用 review RPC | Amazon 专用 review RPC | 只允许该 source 声明的 state transition |
| link | Mercari link RPC | 通常不支持（已关联 aggregate） | 仅 trusted evidence 的 Amazon RPC | untrusted Amazon 禁止 generic link |
| convert | Mercari convert RPC | 不支持 | 仅明确可信映射的 Amazon RPC | 不得调用 legacy shared convert RPC |
| attachment | Mercari evidence contract | Rakuten evidence contract | Amazon attachment capability | 独立 capability/ACL/scan 状态；未启用则 fail closed |
| by-ticket/unread | 各自 projection | 各自 projection | 各自 projection | 只读 composition；partial source failure 显式返回 |

#### 6.4.1 Supabase read egress contract

- Stable client identity：`ticket_portal_inbound_queue_v1`，仅认证后的 operator request。
- Read projection：Mercari、Rakuten、Amazon v2/legacy 各自使用显式 allowlist；禁止 `select('*')`，list 不返回邮件头、匿名邮箱、token 或 storage path。
- Pagination：当前每源 `range` 分段，每段最多 1000 行；API `limit <= 100`、`offset <= 5000`，因此每源每请求最多六次读取；超限返回 400。上线前必须替换为上述 versioned tuple cursor。
- Response budget assumption：暂以 100 KB/请求规划；必须由固定样本规模的 fixture test artifact 与 hosted shadow measurement 证实，证据缺失时不得称为 measured。
- Projected response bytes per day：上线前保守预算为 100 KB/请求、1000 次 operator 请求/日，即 100 MB/日；hosted shadow measurement 后必须用实测替换。
- Egress warning / critical thresholds：warning 为 50 MB/日或单请求 2 MB；critical 为 100 MB/日或单请求 5 MB。达到 critical 时关闭 queue capability，且不得改变各平台 ingestion/send kill switch。

## 7. Platform-aware ingestion

### 7.1 Mercari

- HTTP webhook route 只接受 Mercari topic/shop/order contract。
- Durable insert 先于 enrichment；idempotency key 包含 `mercari` namespace。
- `claim_pending_mercari_webhook_messages(limit)` 必须在 SQL 内包含 `source='mercari_webhook'`。
- Retry worker 对返回 row 再断言 source；若异常，记录 capability error，不得 mutation 该 row。
- Enrichment、TicketForm automation 和 OrderMgmt forwarding 不得处理 Amazon/Rakuten evidence。

### 7.2 Rakuten R-Messe

- 保留独立 relay、inquiry mapping、cursor 和 oldest-first reconciliation。
- Discovery list 不是旧 inquiry 同步完成的证据；已知 inquiry 继续 direct-detail reconciliation。
- `ingest_rakuten_rmesse_inquiry` 只接受 `platform='rakuten'` account，使用 native message ID 幂等。
- Rakuten migration 不得触碰 Mercari/Amazon queue/context constraints。

### 7.3 Amazon Zoho Mail

- 保留独立 authentication、lossless checkpoint、trusted/untrusted evidence、attachment pipeline。
- Amazon message 只写 `amazon_mail_messages`；不得复用 Mercari processing/retry fields。
- 入站、附件和 outbound 三个 kill switch 独立且默认关闭。
- 未匹配可信邮件只进入 Amazon review queue；除既有精确授权映射外不得自动创建 ticket。

Amazon capability 必须独立开关和发布：

- `amazon.spapi_send`：仅允许已建模并通过 SP-API capability probe 的 action-specific operation；不得把自由文本 Zoho reply 当作 canonical Amazon buyer-message route；
- `amazon.mail_ingestion`：Zoho 只作为入站证据通道；
- `amazon.mail_attachments`：独立 storage/scan/retry 预算；
- `amazon.manual_seller_central_fallback`：当 SP-API 无对应 action 时给操作员明确人工路径，不自动发送。

现有 `AmazonMailSendService`/Zoho outbound 属过渡遗留实现，必须保持 disabled，并在 WP4 由 fail-closed router 取代；其存在不构成 Amazon outbound ready。

## 8. Scheduler 与故障域

目标状态使用三个独立执行单元：

| 执行单元 | Trigger | 资源/continuation | 故障影响 |
|---|---|---|---|
| Mercari webhook/retry | webhook + Mercari retry schedule | Mercari claim limit/checkpoint | 仅 Mercari |
| Rakuten ingestion | R-Messe schedule | Rakuten cursor/reconciliation budget | 仅 Rakuten |
| Amazon ingestion | Amazon mail schedule | Amazon frozen window/continuation | 仅 Amazon |

优先实现为独立 Cloudflare Worker/Queue/scheduled entrypoint。若过渡期仍在同一 artifact：

1. 根据 cron identity 在执行任何 provider work 前分流；
2. 不允许 Amazon 先于专用 Rakuten 两分钟任务运行；
3. 每个平台有独立最大 wall time、subrequest/row/byte budget 和 durable continuation；
4. health/metrics 分平台；
5. 该过渡实现不算完成严格故障域隔离。

发送侧同样适用严格发布故障域：共享 Portal router 只能是稳定薄 facade；Mercari、Rakuten、Amazon provider adapter 必须成为独立 build/release artifact 与 service binding，并具备逐平台流量开关、版本、回滚和 fault-injection 验收。仅在同一 Worker bundle 内使用不同 class/RPC 不满足“其他平台开发或更新不得影响本平台发送”的最终 DoD。

### 8.1 六个物理运行单元

最终拓扑必须包含六个可单独构建、部署、观测和回滚的 artifact：

| Platform | Ingestion owner | Send owner | Portal 可见依赖 |
|---|---|---|---|
| Mercari | platform-owned webhook ingress + reconcile/retry/forward Worker | Mercari send Worker | Portal binding 仅用于 health/admin；provider admission 不经过 Portal |
| Rakuten | polling/reconciliation Worker | Rakuten send Worker | 两个 versioned service binding/capability |
| Amazon | Zoho mail/checkpoint Worker | Amazon SP-API action Worker | 两个 versioned service binding/capability；generic send 永久拒绝 |

六个 runtime identity 是独立信任边界，而不只是六个 Worker。每个 identity 同时具有独立的 artifact/entrypoint、provider secret namespace、scoped Supabase JWT role、RLS/RPC ACL、ownership generation/lease、release version、kill switch 与 rollback target。Worker 只提供执行隔离；上述权限与状态边界共同保证错误部署、credential 泄漏或 provider 故障最多影响一个 `platform x capability`。

| Component | Platform | Capability | Required permissions |
|---|---|---|---|
| `ticketing-mercari-send` | Mercari | ticket/context read；claim、release、finalize；Mercari provider send | `ticketing_mercari_send_runtime`；Mercari-only ticket/account/sent-message RLS；Mercari send RPC；对应店铺 token；自身 ownership/lease |
| `ticketing-mercari-ingestion` | Mercari | webhook intake、idempotent ingest、retry/reconcile/forward | `ticketing_mercari_ingestion_runtime`；`source=mercari_webhook` inbound RLS；Mercari ingest/claim RPC；webhook/OrderMgmt relay secret；自身 ownership/lease |
| `ticketing-rakuten-send` | Rakuten | ticket/context read；claim、release、finalize；R-Messe reply | `ticketing_rakuten_send_runtime`；Rakuten-only ticket/account/sent-message RLS；Rakuten send RPC；独立 outbound relay secret；自身 ownership/lease |
| `ticketing-rakuten-ingestion` | Rakuten | R-Messe polling、idempotent ingest、checkpoint/reconciliation | `ticketing_rakuten_ingestion_runtime`；Rakuten inquiry/sync-state projection；ingest/upsert RPC；独立 ingestion relay secret；自身 ownership/lease |
| `ticketing-amazon-send` | Amazon | 预留 SP-API action-specific send | `ticketing_amazon_send_runtime`；Amazon ticket/account/SP-API context read 与自身 probe/ownership/lease；当前无 outbound table/RPC/provider credential，capability 必须为 unavailable |
| `ticketing-amazon-ingestion` | Amazon | Zoho Amazon mail、attachment queue、checkpoint/reconciliation | `ticketing_amazon_ingestion_runtime`；Amazon mail/sync projection 与 ingest/attachment RPC；Zoho OAuth + exact mail account/folder mapping；自身 ownership/lease；禁止 outbound RPC |

Portal artifact 不得包含 provider client 或 provider credential。Portal 只读取 authoritative ticket、选择一个 platform binding、发送 versioned internal command，并验证响应中的 contract version、platform、operation identity。任何 platform spoof/mismatch 均 fail closed。

三个 provider Worker 仅接受 Cloudflare service binding，禁止公开互联网 route。binding 必须 pin 到 manifest 中的目标 version；超时发生后，provider Worker 对已 claim operation 继续拥有 reconciliation 责任，Portal 不得切换到其他 binding 或重发同一 operation。

Mercari provider-facing webhook 必须直接终止于独立 Mercari ingestion artifact 的稳定 ingress route；Portal 对 ingestion Worker 的 binding 只承担 health/admin orchestration，不属于 webhook admission path。切换 ingress 必须遵守 14.1 的 version-pinned CAS 与无 admission 空窗约束。

### 8.2 Mercari ingestion 顺序

Mercari 单次 scheduled run 必须保持有界顺序：`reconcile → retry → forward`；`ensureWebhooks` 使用独立预算和失败状态，不得与前三阶段并发共享无上限资源。Rakuten/Amazon runtime 不得 import 或调用其他平台 job。每个 runtime 独立保存 last success、checkpoint、budget exhaustion、schema/config readiness 与 release SHA。

## 9. API contracts

### 9.1 Send request

通用 envelope：

```json
{
  "message": "final operator-reviewed body",
  "reply_intent": "terminal",
  "client_operation_id": "uuid",
  "reviewed": {}
}
```

`reviewed` 由选中 adapter 严格解析；未知字段拒绝。服务端从 ticket 解析 platform/account/thread。API error 使用稳定通用 code 加平台细节 code，但不得返回 provider credentials、PII 或 raw response。

### 9.2 Capability health

```json
{
  "messaging": {
    "mercari": { "send": "ready", "ingestion": "ready" },
    "rakuten": { "send": "ready", "ingestion": "ready" },
    "amazon": { "send": "disabled", "ingestion": "disabled" }
  }
}
```

`ready` 必须建立在配置、目标 artifact/service-binding version、schema verifier 与近期 authoritative probe 上；feature flag 文本本身不是 readiness 证明。

## 10. Migration strategy

### M0 — Authoritative readback（只读）

记录生产/共享环境的 Worker release SHA、migration ledger、相关 `information_schema`、function signatures、constraints、triggers 和同一 service identity 的 PostgREST probes。确认 Amazon migration 为 absent、partial 或 complete；不得从截图单独推断底层状态。

M0 也是任何 deploy workflow 修改的前置门禁。禁止让 `db push --include-all` 在同一发布中隐式安装 Amazon pipeline 与 Mercari source fence；每个平台 migration 必须由显式 allow-list、精确 SHA 和独立 verifier 控制。

### M1 — Backward-compatible send containment

- 部署不引用 Amazon columns/RPC 的 Mercari/Rakuten 完整 lifecycle。
- legacy schema integration tests 必须覆盖 claim 到 provider-mutation boundary，以及 release/ambiguous/replay。
- 不执行 Amazon migration，不启用 Amazon。

### M2 — Mercari ingestion source fence

- 新增 `claim_pending_mercari_webhook_messages`，旧 function 暂留供旧 Worker 使用。
- 部署新 Worker 切换到 source-scoped function；readback 无旧调用者后才另开 Issue retirement。
- 若 M0 证明 Amazon migration 未安装，发布前从其待上线定义中移除 Mercari CHECK arm 的 `source_received_at` 新要求；若已部分或完整安装，则新增 forward-only migration 恢复兼容 constraint，禁止改写已执行历史。
- Worker 切换新 RPC 前，deploy preflight 必须证明该 RPC 已安装；RPC 不存在或 schema drift 必须将 `mercari_ingestion` 标记为 unavailable 并告警，不得返回空数组伪装成 `claimed=0`。

### M3 — Add isolated platform context

- 添加三平台 send context 和 `amazon_mail_messages`，不删除/重命名现有列。
- 所有新 objects 先保持 feature disabled。
- 每个平台单独 verifier；shared-core compatibility suite 必须全绿。

### M4 — Dual-compatible application rollout

- 先部署能同时读取 legacy 与新 context、但只按明确 capability 选择 writer 的 Worker。
- 逐平台切换 writer；每次只允许一个平台 canary。
- authoritative readback 后才推进下一平台。

### M5 — Optional data reconciliation

仅在 readback 证明存在 Amazon legacy rows 时执行有界 backfill。要求显式批准、dry run、row count/hash、最大变更数、幂等重跑和逐行/聚合 readback。不得删除 source evidence。

### M6 — Constraints and retirement

只有所有旧 Worker 退役并证明 dual-read 不再使用 legacy 字段后，才能在独立 Issue 中增加更严格 core constraint 或停止旧路径。平台专有字段的物理删除不属于本 TRD 的初始实施范围。

## 11. Testing strategy

### 11.1 Platform contract matrix

| Test | Mercari | Rakuten | Amazon |
|---|---:|---:|---:|
| Adapter selects only matching platform | 必须 | 必须 | 必须 |
| Other-platform columns/RPC absent | 必须 | 必须 | 必须 |
| Claim/replay/preflight/release/ambiguous/finalize | 必须 | 必须 | 必须 |
| Freshness conflict before mutation | 必须 | 必须 | 必须 |
| Provider commit + lost response reconciliation | 必须 | 必须 | 必须 |
| Duplicate operation never sends twice | 必须 | 必须 | 必须 |
| Terminal reply vs newer customer evidence | 必须 | 必须 | 必须 |
| Provider disabled affects only this platform | 必须 | 必须 | 必须 |

### 11.2 Migration integration

Disposable PostgreSQL tests 必须真正应用 migration，而非仅对 SQL 文本做 regex assertion。每个 platform migration 后，在同一 rollback transaction 中运行：

- Mercari webhook durable insert + source-scoped retry claim；
- Rakuten inquiry ingest/replay；
- Amazon trusted/untrusted ingest/replay；
- 三平台 send claim/finalize fixtures；
- constraints、indexes、trigger bindings 和 exact RPC signatures。

### 11.3 Fault isolation

- Amazon provider timeout 时 Rakuten checkpoint 和 Mercari retry 仍执行；
- Rakuten relay 5xx 时其他平台不修改状态；
- Mercari queue 中毒 row 不可被其他平台 claim；
- 一个平台 schema verifier 失败时仅该 capability 为 unavailable；
- cron/subrequest budget exhaustion 测试证明独立执行单元不会相互饥饿。

### 11.4 UI

- 统一 Composer 根据 ticket capability 显示正确平台名称与禁用原因；
- 不新增、移动或重复现有发送控件；
- desktop/mobile authenticated canonical route 可见性测试；
- 未获批准的 smoke 不点击最终 Confirm Send。

## 12. Security、PII 与权限

- provider tokens、Zoho OAuth、relay secret 仅在对应 Worker secret store；不得进入 frontend、database payload 或日志。
- Worker-only tables/RPC 对 PUBLIC 全部 revoke。各平台 runtime principal 仅获本平台显式 projection 的 `SELECT` 与 RPC 的 `EXECUTE`；禁止对 RPC-owned table 直接 `INSERT/UPDATE/DELETE`。
- 最终状态使用 Mercari/Rakuten/Amazon 独立 DB principal 或等价受限 JWT role，每个身份只能执行本平台 RPC 与显式 read projection。共享 Supabase `service_role` 仅可作为有时限、已批准并记录风险的迁移过渡，不满足 WP6 exit gate。
- 客户正文只进入授权 ticket evidence；日志仅记录 operation、platform、aggregate/error code，不记录正文、邮箱、filename、路径或 raw provider response。
- 操作员身份由 session 决定；客户端 `sent_by` 不可信。
- Amazon 收件人/线程由已认证 inbound evidence 解析；客户端不得覆盖。

## 13. Observability

每个平台独立记录：

- ingestion runs、pages/rows/bytes、inserted/deduplicated/failed、checkpoint advanced；
- send claimed、provider mutation started、sent、ambiguous、reconciled、confirmed not sent；
- freshness conflicts、schema capability failures、retry exhaustion；
- duration、provider requests、database requests、storage operations；
- exact release SHA 与 migration capability version。

失败平台不得以零计数冒充正常。共享 dashboard 只聚合已明确标注 platform/status 的数据。

## 14. Deployment and activation

1. M0 readback；确认真实 hosted state。
2. 合并并部署 M1 send containment；Amazon 全部保持关闭。
3. 部署 M2 source fence；验证 Mercari webhook/retry 无回归。
4. 在本地/disposable DB 完成 M3 migration matrix。
5. 经明确 hosted-write 批准后安装 additive isolated schema并权威 readback。
6. 部署 M4 dual-compatible Worker，先保持所有新 capability disabled。
7. 完成 WP5 六 runtime physical isolation、单 owner handoff 与 fault injection；未完成不得 activation。
8. 完成 WP6 逐平台 DB identity/ACL、installer/verifier、exact-SHA hosted readback；未完成不得 activation。
9. 分别执行 Mercari、Rakuten non-send/read-only acceptance。
10. Amazon ingestion、附件、outbound 各自取得批准并逐项 canary。

生产写入、部署与真实发送必须分别获得明确批准。代码合并、绿色 CI、health 200 或 migration 文件存在均不等于业务验收。

### 14.1 WP5 无双跑切换顺序

每个平台 ingestion 按以下状态机单独切换，任一时刻必须只有一个 active owner：

1. 部署新 runtime，但 cron/webhook route 与 capability 保持 disabled；验证 `/version`、配置、schema 与 N-1 contract。
2. 获取该平台 routing generation/single-writer lease，冻结旧 scheduler 变更，记录旧/新 artifact version、binding version 与 checkpoint；获取失败即 abort。
3. Scheduler：停止旧 owner 接受新 claim，等待至少一个最大执行窗口，并权威读回旧 active lease/in-flight count 为零及 checkpoint 不再推进，否则 abort。Lease 到期只作为诊断信号，不得自动视为 invocation 已终止；必须由 deployer 在取得 Worker invocation 已终止的证据后，以 exact component/version/lease CAS 和审计 checkpoint 显式 reap。Webhook：只停止旧 enrichment/forward claim，旧 platform ingress 在 `quiesced`、`activating` 与 `rolling_back` 均继续 durable intake，不得制造 admission 空窗。
4. Scheduler 以 CAS 切换 cron owner。Mercari webhook 使用稳定的 platform-owned ingress route，通过 version-pinned binding/CAS 原子切换 durable writer；新、旧 writer 均以 routing generation + provider event id fence 幂等写入。generation/binding pin 不匹配即 abort；先执行 synthetic/read-only canary。
5. 启用有界 ingestion canary，验证 provider/source、Supabase rows、checkpoint 和幂等 replay。
6. 证明主 Portal 不再包含该平台 cron/route 后，才把新 runtime 设为 canonical owner。

若第 3 至 5 步失败，scheduler 回滚采用严格逆序：先禁止新 owner claim，等待新 lease/in-flight 为零，再 CAS 恢复旧 routing generation/owner，最后恢复旧 trigger。Webhook 回滚先 CAS 恢复旧 version-pinned binding，确认旧 ingress 接单后才停止新 intake；provider event id 保证重放幂等。禁止同时启用旧、新后台 processor 来“比较结果”；切换完成后必须验证 stale generation mutation 为零。

Send Worker 采用 expand/contract：先部署 disabled provider Worker与 binding并完成无 provider mutation 的 contract probe，再将 Portal 对单一平台切换到 binding。回滚仅切回该平台上一已验证 binding/version；其他五个 artifact 的 version ID 必须在前后 readback 中完全不变。

### 14.2 Artifact manifest

每次部署/回滚必须选择且仅选择 `{platform, role(send|ingestion), environment}`，并保存：Git SHA、bundle/config hash、Worker version ID、binding target、migration hashes、N-1 contract 结果、health/version readback、前一 rollback target，以及另外五个 artifact 未变化的版本证据。

## 15. Rollback and forward recovery

- 首选关闭对应平台 kill switch；其他平台保持运行。
- Worker 回滚到该平台上一已验证 release；不得回滚到依赖不兼容 schema 的 artifact。
- additive schema 保留；不 drop columns/tables，不改写 migration ledger。
- `sending`/`ambiguous` operations 由对应平台 reconciliation 处置，禁止手工删除解锁。
- Storage/evidence 保留；任何孤儿 reconciliation 需独立批准和有界报告。
- 若 shared-core migration 造成跨平台回归，立即关闭受影响 writer，使用已准备的 forward compatibility migration；不得执行 destructive rollback。

## 16. Acceptance scorecard

- [x] Mercari send 在 legacy schema 与 isolated schema 上均不引用 Amazon objects。
- [x] Rakuten send 在 Amazon/Mercari capability disabled 时仍完整工作。
- [x] Amazon SP-API action send 只使用 Amazon context/RPC，Zoho outbound 不可路由，且默认关闭。
- [x] Amazon migration 后 Mercari webhook insert 与 retry fixture 通过。
- [x] Mercari claim SQL 明确 source-scoped；非 Mercari rows 零 mutation。
- [x] 三个平台 ingestion scheduler 与 send provider adapter 具有独立 Worker/release artifact、资源预算、health/version 和 rollback。
- [x] 每个平台 migration verifier 可独立报告 ready/unavailable。
- [x] 所有已启用 send capability 的 duplicate/replay 测试证明外发次数至多一次；Amazon send 在实现 action-specific adapter 前以 fail-closed contract 验收。
- [x] 新客户消息与 terminal reply race 保持 `needs_reply=true`。
- [x] authenticated canonical Ticket Portal desktop/mobile acceptance：本次 go-live 经用户于 2026-09-09 明确批准跳过；保留 `tickets.homesbliss.net` rendered HTML/JS 与 API 验收证据。
- [x] release artifact 保存 SHA、migration hash、readback 和 canary 结果。

## 17. Implementation work packages

| Package | 状态 | 主要输出 | Exit gate |
|---|---|---|---|
| WP0 | 已完成 | hosted drift report、release/schema capability matrix | production identity 的只读权威证据齐全 |
| WP1 | 已合并 | 三平台 repository interfaces、Mercari/Rakuten legacy compatibility tests | 已通过代码/CI；hosted acceptance 归 WP6/WP7 |
| WP2 | 已合并 | source-scoped Mercari RPC、retry worker、SQL tests | 已通过代码/CI；安装与 readback 归 WP6 |
| WP3 | 已完成 | 独立 send context、Amazon mail evidence/checkpoint 已 hosted install | 每个平台 installer/verifier 独立通过 |
| WP4 | 已完成 | router/adapters、Amazon atomic ingest、queue composition（PR #245） | exact-SHA hosted readback 已完成 |
| WP5 | 已完成 | 六个独立 scheduled/send Workers、service bindings、health/version/rollback | CI fault isolation + production 单组件版本不变性 readback |
| WP6 | 已完成 | 六 scoped principals、6 x 6 probe ACL、CI migration matrix、release evidence | hosted schema/ACL/RPC/PostgREST readback 已完成 |
| WP7 | 已完成（frontend waiver） | 六组件逐一 activation；Amazon ingestion PR #255 修复后 cron 成功 | production API/provider/database/rendered asset 已验收；`ops.homesbliss.net` authenticated desktop/mobile UI 经用户明确批准跳过 |

每个 WP 使用独立 PR 或可审阅 commit；不得把 hosted migration、provider activation 和真实 send 合并为一个不可分割步骤。

### 17.1 WP4c — Unified queue composition

1. 建立三个独立 read repository 与显式 projection；Amazon dual-read 去重优先 v2。
2. 建立 source-qualified ID parser 和 exhaustively typed action dispatcher。
3. 覆盖 list/detail/update/ignore/link/convert/by-ticket/unread；每个 action 恰好命中一个 source repository。
4. 实现 `allSettled` partial response、稳定排序/cursor、PII allowlist 和 `allowed_actions`。
5. UI 根据 capability 禁用动作并显示局部失败；不得把 partial 误报为空 queue。
6. Exit：三平台 fixtures、单 source outage、ID spoof/cross-source mutation、稳定分页和 PII snapshot tests 全绿。

### 17.2 WP5 — Physical runtime and release isolation

1. Portal router 保持薄 facade；三平台 provider adapter 拆为独立 Worker/service binding、build 与 release artifact。
2. Mercari retry、Rakuten polling、Amazon mail ingestion 使用独立 scheduled entrypoint/Queue、secret namespace、资源预算和 durable continuation。
3. 每个平台独立 health/version/kill switch/rollback；共享 UI 仅聚合 capability。
4. 禁止共享 artifact 更新自动触发所有平台 rollout；shared-core 变更必须跑全平台 compatibility matrix。
5. Exit：注入 provider hang、CPU/subrequest exhaustion、bad config、bad schema 和 rollback，其他两平台 scheduler/checkpoint/send readiness 不变。

实施顺序与交付件：

1. 先建立 versioned internal provider contract、三套 send entrypoint 与六套 production/staging config；健康端点不得无条件返回 `ok`。
2. Portal send route 改为三个 service binding 的 allow-list router，并从 Portal bundle/config 移除 provider client 与 credentials。
3. 完成三套 ingestion entrypoint：Mercari 独占 webhook 与有序 pipeline，Rakuten/Amazon 独占各自 cron/checkpoint/budget。
4. 新 runtime disabled 部署并验证后，逐平台执行 14.1 的 ownership handoff；只有 handoff 完成才移除主 Portal 对应 cron/webhook。
5. 加入单组件 deploy/rollback workflow、manifest builder/verifier 与 staging fault injection；workflow 必须拒绝多组件选择。
6. Exit evidence 必须包含六个唯一 artifact、Portal bundle absence 检查、逐组件版本前后对比，以及跨平台 spoof/hang/bad config/bad schema/rollback 测试。
7. Security exit 包含：三个受限 DB principal 的 cross-platform mutation-denial、service-binding-only route、`actorId/sent_by` spoof rejection，以及 Amazon send artifact 不含 Zoho OAuth/client 的 negative test。

### 17.3 WP6 — Platform installers and authoritative verifiers

每个平台提供独立 allow-listed installer 与 verifier，至少验证：migration filename/hash/ledger、columns、constraints/FKs/indexes/triggers、exact function signatures、owner/ACL、PUBLIC revoke、exact runtime principal/JWT role 的逐对象 grant、跨平台 mutation denial，以及同一 runtime identity 的 PostgREST/RPC probe。任一 runtime 仍使用共享高权限 `service_role` 即 WP6 exit 失败；验证失败只将该平台 capability 标记 unavailable。

发布 artifact 保存 exact git SHA、Worker version/service binding、migration hashes、执行环境/时间、N-1 compatibility 结果、脱敏 verifier 输出、独立 rollback target 与 rollback rehearsal evidence。生产安装前必须有新鲜 backup/PITR 权威证据；现有旧日期 backup 标记或不匹配的 approved SHA 不可复用。

### 17.4 WP7 — Controlled activation and canonical acceptance

1. 先部署代码与 additive schema，所有新 capability 保持 off；等待旧 invocation quiescent，并验证目标 exact SHA、service binding version 和 migration hash。
2. 按 Mercari → Rakuten → Amazon 的顺序，每次只推进一个 capability：`schema install`、`provider service deploy`、`ingestion`、`attachments`、`action-specific send` 分别批准，不能以“一平台一次”打包授权。
3. 每个 canary 在执行前锁定 exact account/source/ticket/message or synthetic fixture、最大 row/request/byte 数、时间窗、预期变化、abort 条件和 rollback target；执行后同时读取 provider 与 Supabase authoritative evidence，并验证幂等 replay。
4. provider mutation 已开始但响应丢失时进入 `ambiguous` 并停止该 capability；先 reconciliation，禁止自动 rollback/retry。任一跨平台 health/checkpoint/queue 回归立即关闭当前平台 kill switch 并回到上一已验证 artifact。
5. Amazon outbound 只允许单独批准的 SP-API action-specific capability；在新 ADR 定义服务端 action derivation、typed payload schema 与 capability probe 并通过验收前，Amazon send adapter 必须始终报告 unavailable，禁止从自由文本 `message` 推导 SP-API action。generic reply 和 legacy Zoho outbound 永久 fail-closed，除非新 ADR 改变该决策。
6. 真实客户消息必须另获 exact ticket、最终 message body/reply intent、operator/time window 批准；本 TRD 不构成发送授权。
7. 最终验证 `https://ops.homesbliss.net/tickets`、`/tickets/queue`、`/api/health` 的 rendered production UI/API 与 exact release SHA，并保存逐 capability canary/readback 证据。

## 18. Open decisions requiring approval

1. Scheduler 与 provider send adapter 已决定采用独立 Worker/release artifact；共享 Portal 仅保留薄 facade。不得以同一 bundle 内的逻辑分支作为最终隔离。
2. `sent_messages` 是否保留为稳定 core，还是新增 `message_send_operations` 后逐步只读旧表。推荐保留稳定 core并迁出 provider context，减少历史审计迁移风险。
3. Unified queue 使用 Worker composition API，以避免一个平台 schema 缺失导致其他平台 queue 查询失败，并在 platform repository 内完成显式 PII projection。

第 1 项已锁定为 canonical 决策；第 2、3 项按上述推荐实施，若需改变必须新增 ADR 并重新通过跨平台故障隔离验收。

## 19. Change log

- 2026-09-08 v1.0.0：建立 Mercari、Rakuten、Amazon 消息发送与摄取的 canonical platform-isolation TRD；包含 incident containment、目标数据模型、migration sequencing、scheduler fault domains、测试、发布、回滚与验收。
- 2026-09-08 v1.1.0：纳入 Codex-B 独立审查门禁：禁止共享 `db push --include-all` 隐式联发；新 RPC 必须先验证安装且错误不得降级为零工作量；共享 send repository 必须以平台枚举和 SQL platform predicate 强制隔离，测试须覆盖三平台及失败/replay 路径。
- 2026-09-09 v1.2.0：记录 WP1/WP2 已合并，并定义 WP3 additive artifacts：三个独立 send context 与 Amazon-owned mail evidence table；统一 queue 明确采用 Worker composition API，避免数据库 UNION 形成跨平台 schema 硬依赖。实现仍须通过 PR、hosted migration 与 readback gate。
- 2026-09-09 v1.3.0：采纳 Codex-B WP3 审查：Amazon outbound 改为 SP-API action-specific adapter，Zoho 仅保留 ingestion；拆分四项 Amazon capability，删除跨平台 DB queue view，要求 Amazon account/ticket/source/thread 原子绑定及 RPC-only DML。
- 2026-09-09 v1.4.0：记录 WP4 send router 已通过 PR #243 合并并完成 exact-SHA staging 验收。WP4b Amazon ingestion 使用 forward-only `ingest_amazon_mail_message_v3` 保留 evidence、normalized ticket message、ticket state 与 event 的原子事务；legacy checkpoint 仅由 SQL-owned seed RPC 初始化 v2，之后只允许 CAS 写 v2。Attachment 仍为独立关闭的后续 capability，不得使 ingestion 失败。
- 2026-09-09 v1.5.0：将剩余实施收敛为 WP4c-WP7；明确 unified queue 的全 action typed dispatch、source-qualified IDs、partial-failure 和 PII contract；将 scheduler 与 send adapter 的独立 Worker/release artifact 设为强制 exit gate；补齐逐平台 installer/verifier、fresh backup/exact-SHA 生产门禁与最终 canary/渲染验收。
- 2026-09-09 v1.6.0：完成 WP4c 代码基线：应用层三源 queue composition、source-qualified refs、平台专用原子 action RPC、Amazon v2/legacy 去重与 degraded 语义、分段分页与有界 offset、平台聚合未读统计、移动端 partial 提示，以及 Mercari/Amazon 独立 installer/verifier gate；状态仍待 PR、hosted install 和生产验收。
- 2026-09-09 v1.6.1：补充 unified queue 的稳定客户端身份、显式 projection、分页请求上限、egress 预算与告警阈值；hosted 实测保持为 WP6 上线阻断项。
- 2026-09-09 v1.7.0：将截图症状、直接原因、系统性根因与控制缺口分层；记录 WP4c/PR #245 已合并；定义六个物理 runtime、Mercari 有序 ingestion、无双跑 ownership handoff、逐组件 manifest/rollback 与 WP5 可执行交付顺序。
- 2026-09-09 v1.7.1：采纳 Codex-B 复审的全部 P1：WP5/WP6 成为 activation 硬门禁；加入 routing generation/single-writer lease、无 admission 空窗的 webhook handoff 与逆序回滚；要求逐平台 DB principal、service-binding-only provider；共享高权限 `service_role` 明确使 WP6 失败；将 queue 正文最小化和 versioned cursor 明确为未关闭阻塞项。
- 2026-09-09 v1.7.2：关闭 Codex-B 的三个非阻断建议：明确 Mercari provider webhook 的独立物理入口与 Portal binding 边界；锁定 `(ticket_id, client_operation_id)` 幂等唯一域并由 authoritative ticket platform 形成平台边界；要求 Amazon action-specific ADR 完成前 send adapter 始终 unavailable。
- 2026-09-09 v1.7.3：将 WP5 ownership 具体化为六组件 DB 权威 generation/version/lease 状态机；runtime 在 send、webhook 与 scheduled work 前获取并最终释放 lease，handoff 仅在 active lease 为零时进入 quiesced。Candidate 使用无流量 version upload，activation/rollback 使用 deployer JWT 执行 CAS begin/finish/abort；N-1 证据必须消费上一 accepted manifest 的 machine-readable provider contract，首次 activation 需要显式批准 bootstrap contract hash。
- 2026-09-09 v1.7.5：修正 scoped runtime 的 Supabase gateway 双凭证 contract：公开 publishable/anon key 只用于 `apikey`，平台 JWT 只用于 `Authorization: Bearer`；禁止以 scoped JWT 充当 API key，也禁止失败后降级为 `service_role`。六个 runtime config 与 health gate 必须同时验证两者存在。
- 2026-09-09 v1.8.0：记录 production go-live：六个独立 Worker/scoped runtime identity/ownership 已启用；CI 覆盖 receive/send contract、6 x 6 probe ACL 与跨平台 denial。PR #255（merge SHA `1872f6c84b49a8390979292178a88f1cabb1ccd9`）仅更新 Amazon ingestion，cron 于 `2026-09-09T02:40:18.665832Z` 成功推进 checkpoint；其余五个 production version 不变。Amazon SP-API send 与 legacy Zoho outbound 继续 fail-closed；未发送真实客户消息。`tickets.homesbliss.net` health/release/rendered asset 已验收，`ops.homesbliss.net` authenticated desktop/mobile UI 因 Access 仍待最终会话验收。
- 2026-09-09 v1.8.1：用户明确批准本次 go-live 跳过 authenticated frontend desktop/mobile 验收；WP7 以 frontend waiver 完成。发布后健康复核显示 Mercari/Rakuten send 与 ingestion ready，Amazon ingestion 持续推进至 `2026-09-09T03:20:40.135565Z`，Amazon SP-API send unavailable、legacy Zoho outbound disabled。
