# 规范执行计划（Canonical Plan）：通过 Zoho Mail 处理 Amazon 买家消息

**Issue：** <https://github.com/retailpulses/ticket-handling/issues/235>  
**状态：** 最终设计（已确认实施基线）  
**版本：** 1.0.21
**日期：** 2026-09-07 JST

本文档是 Ticket Handling #235 的 canonical 执行计划。Issue 是 canonical 工作跟踪入口；本文档负责定义范围、实施顺序、门禁和验收标准。本文列出的推荐决策已作为实施基线确认；生产 migration、定时任务启用和真实客户发送仍分别受各自上线门禁约束。

## 1. 目标结果

交付一条受治理的 Amazon 买家支持闭环：

`已验证的 Amazon 邮件 -> 持久化入站队列 -> 操作员转换/关联 -> 工单消息线程 -> 审核回复 -> Zoho reply -> 权威回读确认`

该工作流必须能够无重复地摄取客户文本和受支持的照片附件；照片附件默认保存到工单现有的 **Evidence**，不建立第二套附件系统。工作流必须保持现有工单创建权限边界，并且绝不在缺少操作员明确确认的情况下发送面向客户的回复。

## 2. 固定边界

- Ticket Handling 负责入站邮件证据、队列状态、工单关联、草稿、操作员决策、outbox、回复回读和审计。
- OrderMgmt 负责标准化的 Amazon 订单、商品、履约和物流上下文，并通过稳定的服务端只读能力提供这些信息。
- Zoho 是买家消息的唯一摄取和回复传输通道。OAuth 凭据只能保存在 Ticket Handling 后端的 secret store 中；操作员不需要、也不得获得 Zoho 登录或 OAuth 凭据。
- Ticket Handling 的本工作流不直接调用 SP-API，也不建立第二条 Amazon 消息管道。订单上下文只通过 OrderMgmt 自有的只读服务契约获取；OrderMgmt 的内部数据来源不属于本工作流。
- 现有 Mercari 和 Rakuten 行为必须保持不变。
- 禁止自动回复客户，也禁止使用浏览器输入的任意收件人。

## 3. 已确认的设计决策

### D1 — 工单创建权限

保持仓库级权限规则。Amazon 邮件先进入已验证的入站队列。通过身份验证的操作员明确选择 **Convert to Ticket**，或者将消息关联到现有工单。轮询、解析、分类、重试和对账均不得创建工单。未来如需自动建单，必须另开 issue 批准范围严格限定的例外。

### D2 — 可信邮件认证

只有具备邮件服务商可验证且通过认证结果的消息，才能获得 `customer` 语义。必要证据包括：

- DKIM 结果为 `pass`，且已认证的签名域与预期 Amazon 域对齐；以及
- DMARC 结果为 `pass`，或者在 Phase 0 POC 中证明了等价的、由邮件服务商验证的 Amazon 传输信号。

仅凭可见的 `From` 后缀永远不够。认证证据缺失、失败或不可用时，消息必须进入 `untrusted_review`，不得下载附件、关联工单或修改 `needs_reply`。

### D3 — 终态工单行为

如果一条新插入且已验证的客户消息关联到状态为 `pending_customer`、`pending_third_party`、`resolved`、`closed` 或 `canceled` 的工单，系统必须在同一事务内将工单恢复为 `in_progress` 并设置 `needs_reply=true`。卖家、系统、不可信或重复事件不得触发这些状态变化。

### D4 — 出站发件身份

固定使用 `amazon@retailpulses.com`，并由服务端账号配置解析。前端可以展示发件人和收件人，但不得覆盖它们。操作员只需登录 Ticket Portal，无需登录 Zoho。

### D5 — 单一消息管道

Amazon 买家消息的入站和回复统一使用 Zoho 邮件路线。Ticket Handling 不直接调用 SP-API，不从 SP-API 创建消息占位记录，也不把 SP-API action 与邮件线程合并。OrderMgmt 提供的订单上下文是只读业务契约，不构成第二条消息管道。

### D6 — 操作员无需 Zoho 登录的服务端发送边界

操作员点击 Send 后，系统按以下边界执行：

1. 浏览器向 Ticket Portal 的受认证端点提交 `ticket_id`、最终正文、回复意图、`client_operation_id`，以及本次操作员实际审阅到的非权威并发令牌 `reviewed_customer_message_id` 和 `last_seen_message_at`；不得提交 Zoho token、任意收件人、任意发件人或把并发令牌用作回复目标。
2. Worker 从已授权的工单/邮件线程映射中读取原始 Zoho `messageId`，并从服务端账号配置中解析 `amazon@retailpulses.com`。
3. Worker 使用 secret store 中的 `ZOHO_CLIENT_ID`、`ZOHO_CLIENT_SECRET`、`ZOHO_REFRESH_TOKEN` 和服务端账号 ID 获取短期 access token。token 不写入 Supabase、日志或前端响应。
4. Worker 从授权映射解析当前源消息，重新读取 Zoho 线程，并要求最新客户消息 ID/时间精确匹配 `reviewed_customer_message_id`/`last_seen_message_at`。随后完成权限、最终正文一致性和 outbox claim 检查；任何不匹配均在 Zoho 写入前返回 `THREAD_STALE`。
5. Worker 回读 Zoho Sent/线程状态，确认服务商消息标识后才完成本地发送记录。

当前共享密码会话只能将发送者审计为 `portal_operator`。在具名账号与角色上线之前，不得宣称已记录具体个人身份，但这不要求操作员拥有 Zoho 账号。

## 4. Phase 0 — 邮件服务商契约 POC

### 工作内容

1. 保存一份脱敏的 Zoho 消息详情响应结构，包括服务商消息/线程标识、时间戳、文件夹、邮件头/认证结果、附件元数据和回复寻址信息。测试 fixture 不得包含客户正文。
2. 证明 Zoho REST 暴露的准确 DKIM/DMARC 信号或等价的可信认证信号。如果 REST 契约无法提供该信号，则停止自动赋予客户语义，先设计并批准邮件入口验证层。
3. 通过实时脱敏证据确认列表排序、分页 token/offset 行为、最大页大小、时间戳精度、保留期和速率限制。
4. 仅通过元数据找到一封带图片附件的 Amazon 消息。获得单独批准后，以只读方式下载一张图片，验证声明大小、实际大小、MIME、magic bytes 和内容哈希，并确认默认保存为现有 `ticket_attachments`/Evidence 记录。
5. 确认使用原始 Zoho `messageId` 回复时，可以保持 Amazon 匿名收件地址和消息线程，并使用 `amazon@retailpulses.com` 作为发件身份。

### 退出门禁

- 邮件认证信号和无损分页语义均已得到证明。
- 合成 fixture 覆盖可信、不可信、重复、分页、附件和回复场景。
- 如果无法证明认证或分页行为，实施保持阻塞。

## 5. Phase 1 — 持久化且经过认证的入站队列

### 数据契约

Ticket Handling 自有状态需要记录：

- 邮件服务商账号和文件夹标识；
- 服务商消息和线程标识；
- 接收时间戳以及不可变的源幂等键 `zoho:{provider_account_id}:{provider_message_id}`；
- 认证结果和对齐域；
- 标准化订单号、消息方向、处理/审查状态、尝试次数和最后错误；
- 附件引用和内容哈希；
- 仅在操作员授权操作完成后记录关联工单 ID。

客户正文复用 `inbound_ticket_messages.latest_buyer_message`，邮件主题写入新增的 `message_subject`；两者只能由 Worker 写入，并由 Ticket Portal 受认证端点按操作员审阅所需的最小字段投影读取。附件字节只能由 Worker 和现有私有 Storage 访问，Portal 继续通过现有 Evidence 签名读取能力展示。日志只能包含聚合计数和掩码后的标识。

### Supabase 增量 schema 决策

不创建重复的 ticket、message、outbox 或 Evidence 模型。复用现有字段：

- `tickets.external_thread_id` 保存命名空间化的稳定线程键；只有 Phase 0 证明 Zoho thread 标识稳定后才写入。
- `ticket_messages.external_message_id` 保存 `zoho:{provider_account_id}:{provider_message_id}`。现有 `(platform, external_message_id)` 唯一约束负责消息去重。
- `sent_messages.platform_message_id` 保存 Zoho reply 成功后返回或回读确认的实际发件消息 ID。
- `ticket_attachments` 和现有私有 Storage 保存 Amazon 客户照片 Evidence。

需要一条由 Ticket Handling 拥有、经过治理审查的增量 migration：

1. 扩展 `inbound_ticket_messages.source`，允许 `amazon_zoho_mail`；扩展 `review_status`，允许 `untrusted_review`。
2. 为 `inbound_ticket_messages` 增加 `account_id`、`external_order_id`、`message_subject`、`source_received_at`、`provider_account_id`、`provider_folder_id`、`provider_message_id`、`provider_thread_id`、`mail_auth_status`、`mail_auth_domain` 和受限的 `provider_metadata`。Amazon 规范化正文复用现有 `latest_buyer_message`，不得把正文、匿名邮箱地址或完整邮件头复制到 `provider_metadata`。先将现有 Mercari `webhook_received_at` 回填到 `source_received_at`，再允许 `webhook_received_at` 为 NULL；Amazon 行只写 `source_received_at`，不得伪造 webhook 语义。
3. 增加 source-specific CHECK：Mercari 行继续要求现有 `shop_name`、`shop_id`、`order_transaction_id` 和 `webhook_received_at`；Amazon 行要求 provider account/folder/message ID、`source_received_at` 和明确的认证状态。预富化或映射失败的 Amazon 队列行允许 `account_id` / `external_order_id` 为 NULL；只有关联工单或 Convert 时才强制要求这两个映射。为兼容 Amazon，将 Mercari 专用列改为可空，但由该 CHECK 保持 Mercari 约束不变。
4. 增加唯一约束 `(source, provider_account_id, provider_message_id)`。现有 `idempotency_key` 同时保存 `zoho:{provider_account_id}:{provider_message_id}`，形成双重防重复保护。
5. 新增 `amazon_mail_sync_state`，按 provider account/folder 保存已提交的 `watermark_received_at`、`watermark_message_id`，以及未完成遍历的 `window_start`、冻结的 `run_to`、continuation、最后成功时间、错误和运行指标。恢复 continuation 时必须继续使用同一窗口；游标失效时从该冻结窗口起点重新遍历并依靠去重约束吸收重复，不能换用新的上界继续旧游标。
6. 为 `sent_messages` 增加可空的 `source_inbound_message_id` 外键，指向获准回复的 `inbound_ticket_messages`。Amazon 邮件发送必须设置该字段；Mercari/Rakuten 保持为空且行为不变。
7. 增加职责分离的 SECURITY DEFINER 事务 RPC，并全部从 `PUBLIC` 撤销权限：摄取 RPC 只能插入/去重源消息、追加到已有授权工单，并在新客户证据进入终态工单时原子重开；它在任何输入下均不得创建工单。另设 Amazon Convert RPC，由现有受认证的操作员 Convert 端点调用，使用 `account_id`、`external_order_id` 和 provider 映射在一个事务内创建/关联工单。普通 Link 路由必须拒绝所有 Amazon 行，避免 `untrusted_review` 或缺少映射的消息绕过事务校验；未来如需 Amazon Link，必须调用具备同等 trust/account/order 检查的专用事务 RPC。轮询、enrichment 和 reconciliation 代码不得导入或调用 Convert RPC。现有 Mercari 的应用层 Convert 路径保持不变；本 issue 不迁移其权限模型。
8. 为 `tickets` 增加单调递增的 `message_revision bigint NOT NULL DEFAULT 0` 和仅在可信客户 `ticket_messages` INSERT 时递增的 `customer_message_revision bigint NOT NULL DEFAULT 0`；历史行分别按全部消息数和客户消息数回填，trigger 使用 `COALESCE(..., 0) + 1` 防御。不得用按 `sent_at` 排序的“最新消息 ID”替代 revision，因为延迟到达的旧时间消息也必须使审阅版本失效。首次 outbox claim 必须同时冻结 `source_inbound_message_id`、`reviewed_customer_message_id`、`reviewed_customer_message_at`、完整 `reviewed_thread_revision` 和 `reviewed_customer_revision`；同一 `client_operation_id` 的重复请求若正文、意图或任一冻结证据不同，必须返回冲突。Amazon 专用 claim RPC 锁定工单，在锁内重新比较两条单调 revision，并确保每个工单最多一个 `sending|ambiguous` lease；不同 operation ID 的旧标签页不能并发通过。Amazon 专用 finalize RPC 必须先锁定工单和 outbox，只从已持久化的 outbox 读取这些 reviewed 证据；在写入本次 outbound `ticket_message` 之前比较当前 customer revision 与冻结值，并同时校验最新可信客户证据。任何审阅后插入的可信客户消息——包括 provider 时间更早但数据库插入更晚的客户邮件——都令 `newer_customer_message=true`；系统、卖家或操作员消息只改变通用 revision，不得单独设置 `needs_reply=true`。terminal 回复只有在可信客户证据仍为最新时才能清除 `needs_reply`；否则发送记录仍可完成，但必须保持 `needs_reply=true`。成功 replay 返回当前 customer-revision 比较产生的 warning，但不得修改 ticket 状态。不得信任重试请求携带的新 reviewed token，也不得直接使用会无条件清除状态的通用 finalize 路径。
9. Outbox 记录 `provider_mutation_started_at`、单调递增的 `lease_generation bigint` 和 generation-specific `lease_claimed_at timestamptz`。初次 claim 写当前时间；仅当 mutation 标记为空且 `lease_claimed_at` 超过 15 分钟时，claim RPC 才可在工单锁内回收 lease。每次回收必须同时增加 generation、把 `lease_claimed_at` 原子重置为当前时间，并把新的 generation 返回给当前 worker；不得继续使用原始行的 `created_at` 计算租约年龄。调用 Zoho 前必须使用独立 SECURITY DEFINER RPC 做最后一道原子 compare-and-set：在同一事务中锁定 ticket/outbox，核对 `client_operation_id`、当前 `lease_generation`、`delivery_status='sending'`、mutation 标记仍为空，并再次比较 `tickets.message_revision = reviewed_thread_revision`；全部成立后才设置 `provider_mutation_started_at`。任何旧 generation、已变化 revision 或非当前状态均失败关闭，worker 不得调用 Zoho。这样即使旧 worker 在 lease 被回收后恢复，也会被 fencing token 拒绝。一旦 provider mutation 可能开始，绝不能超时猜测为未发送。
10. 扩展 `sent_messages.delivery_status` 允许 durable terminal 状态 `confirmed_not_sent`，并记录 `no_send_first_observed_at`、`no_send_last_observed_at` 与 `no_send_observation_count`。只有 `ambiguous` lease 可以进入人工处置；正常 `sending` 表示原 worker 仍可能活动，Portal 只能显示状态/刷新，处置 RPC 必须拒绝。若 `provider_mutation_started_at` 已存在且该行持续 `sending` 超过 5 分钟，claim、Portal inspection 或 scheduled reconciliation 必须调用同一事务 RPC，在锁内将它原子晋级为 `ambiguous` 并写 crash-recovery audit event；该转换绝不能声明未发送或触发第二次 provider mutation。这样 mutation-boundary CAS 后的进程崩溃不会永久锁死工单。`ambiguous` lease 不自动过期：Portal 展示脱敏 Sent 候选，让操作员选择精确 provider message 完成审计。若 mutation 从未开始，当前 generation 已被 fencing 且新的权威 Sent 回读为零，可直接写 `confirmed_not_sent`。若 `provider_mutation_started_at` 已存在，单次零结果不得解除 lease：第一次权威零候选回读只记录 observation 并保持 `ambiguous`；只有同时满足 mutation 开始后至少 30 分钟、至少两次权威零候选回读、两次相隔至少 5 分钟，且第二次仍为零，才能写 `confirmed_not_sent`。任一回读出现候选即不得确认 no-send，只能精确完成发送审计或继续保持 `ambiguous`。上述状态、时间和计数条件必须在 SECURITY DEFINER RPC 内以数据库时间再次校验，浏览器不得提供或覆盖时间。每次 observation 和最终处置都写 `ticket_events`。`confirmed_not_sent` 不再占用活动 lease，但 finalize RPC 必须拒绝把它改回 `sent`；同一 `client_operation_id` 的 replay 必须稳定返回该终态且绝不发送，操作员重新审阅后只能使用新的 operation ID 再次尝试。未处置的 `sending|ambiguous` 禁止新 operation。

Amazon 源行必须显式使用不会被 Mercari 后台任务 claim 的状态：`processing_status='completed'`、`forwarding_status='failed'`、`forward_error='source_not_applicable'`。不得依赖通用默认值。成功发送的 replay 必须原样返回已持久化的 terminal 发送字段，且不得修改 `needs_reply`、ticket freshness 或消息 revision；允许只读比较当前 customer revision 与冻结值并返回 late-customer warning。当前 `needs_reply` 只能由新的可信客户证据以及其后获准发送的 finalize 决定。stale worker 的 ambiguous update 仅允许从当前 generation 的 `sending` 转换，绝不能覆盖 `sent` 或 `confirmed_not_sent`。

现有 `server_received_at`、`processing_status` 和 `processing_attempts` 的 NOT NULL/default 行为适用于 Amazon 行，但 Amazon 不复用 Mercari 专用的 `claim_pending_inbound_messages` enrichment claim。`amazonMailSyncService` 使用 Amazon 专用、最旧优先且有上限的 claim/reconciliation RPC，避免改变 Mercari 的筛选和转发语义。

Crash-recovery audit 复用现有允许的 `ticket_events.event_type='platform_sync_failed'`，payload 固定包含 `source='amazon_zoho_mail_reply_recovery'`、operation ID 和 `resolution='worker_abandoned_to_ambiguous'`；本计划不新增未登记的 event type。

不新增 `zoho_message_id` 到 `tickets` 或 `ticket_messages`，避免与现有 external ID 字段重复。OAuth token、匿名邮箱地址和完整邮件头不得写入通用 ticket 字段；必要的敏感 provider 数据只能进入 worker-only 行，并受最小字段投影约束。

### 无损轮询 checkpoint

1. 为每个邮件服务商账号/文件夹维护已提交的高水位二元组 `(received_time, message_id)`；服务商分页游标只是遍历 token，不得作为持久化 checkpoint。
2. 每次运行从已提交 `received_time` 之前 15 分钟开始，并依靠源消息唯一约束吸收重叠数据。
3. 在新遍历开始时冻结 `window_start=watermark - 15 分钟` 和 `run_to`，并与 continuation 一起持久化。遍历与 `[window_start, run_to]` 相交的所有页面，并在本地按从旧到新的顺序处理；恢复运行不得重新计算这两个边界。
4. 每次调用只遍历冻结窗口中的一个 UTC 日期分片，从该分片第一页开始，最多 20 页、每页最多 100 条；Zoho 数字 offset 只允许在这一次调用内翻页，绝不得持久化为跨调用 continuation。`continuation` 保存尚待处理的 `segment_date`，完成一个日期分片后原子移动到前一 UTC 日期，直至覆盖 `window_start`；因此跨多日且总计超过 20 页的窗口可以稳定前进，也不会为重新定位旧 anchor 消耗下一次调用的全部页预算。
5. 一个日期分片只有在读到短页（少于 100 条）并完成该分片全部候选持久化后才算完成。若第 20 页仍为满页，必须以 `day_segment_overflow` 失败关闭，保留原 `segment_date`、冻结窗口和高水位，并由人工选择更窄的已证明 provider 查询或批准临时提高已治理预算；不得跳过该日剩余消息，也不得推进到前一日。
6. 在执行 enrichment 之前先持久化每条源记录。单条消息的解析或 enrichment 失败必须进入可重试状态，不得删除原始证据。
7. 如果列表/分页请求失败、结果被截断、日期分片 overflow，或者无法确认最后一页，则不得推进高水位。
8. 只有在候选二元组之前的所有消息均已持久化或已被证明是重复消息后，才能原子推进高水位。
9. 对失败或未完成处理的源记录执行有上限、按最旧优先的 reconciliation。

Phase 0 完成速率和数据量测量后，可以降低上述上限；如果要提高上限，必须先更新 workload 声明和 egress 预算。

### 权限和生命周期

- 未匹配的可信消息进入队列，等待操作员明确转换。
- Queue API、TypeScript 类型、分组键和显示路径必须把 Mercari 专用的 shop/order/webhook 字段视为可空；Amazon 行使用 `source + account_id + external_order_id`，缺少映射时使用 provider message ID（最终回退 source row ID）形成独立分组，任何显示截断都必须先使用非空回退值。
- 如果可信消息已有先前授权的精确线程/订单映射，可以幂等地追加到对应工单；但不得创建新工单。
- 新插入的客户证据必须在同一事务内将终态工单恢复为 `in_progress`，并设置 `needs_reply=true`。

### 退出门禁

- Migration、RLS/访问级别、事务 RPC、workload 声明、kill switch、重试上限和 egress 预算均通过治理审查。
- Replay、并发运行、分页中途失败、分页期间新邮件、伪造 From 和终态工单测试全部通过。

## 6. Phase 2 — 附件管道

1. 仅接受来自可信客户消息的附件引用。
2. 对尚未关联工单的队列消息，只在受限 `provider_metadata` 中保存附件 ID、声明 MIME/大小和状态；不得下载附件字节，也不得提前创建 `ticket_attachments`。
3. 已有授权工单映射时可立即处理附件；人工 Convert 时，先在同一事务内建立 `linked_ticket_id`，再由最旧优先的附件 reconciliation 下载。这样每个 Evidence 在创建时已有合法 `ticket_id` parent，无需放宽现有 parent CHECK。
4. 下载前限制附件数量和声明大小，下载时使用严格的流式字节上限。
5. 只允许受支持的图片 MIME，并要求与 magic bytes 一致。
6. 关联工单后，reconciliation 必须重新调用 Zoho attachmentinfo，以 attachment ID 取回 filename；filename 只写入具有合法 parent 的 `ticket_attachments` Evidence，不回写未关联源消息 metadata。随后按确定性的内容哈希路径保存到现有私有 Supabase Storage；不得新增平行附件表或平行 Evidence UI。
7. 使用服务商附件标识和 SHA-256 去重。若 Storage 上传成功但数据库写入失败，reconciliation 必须通过确定性路径回读并完成同一 Evidence，而不是再次上传。
8. 队列 UI 展示附件元数据与“等待关联工单”状态；关联后展示已保存 Evidence 或被拒绝/失败状态，且附件失败不阻塞文本消息。
9. 禁止在日志中记录文件名、URL、字节、路径或客户内容。
10. 附件下载使用独立 kill switch `AMAZON_MAIL_ATTACHMENTS_ENABLED=false`，默认关闭；它与文本摄取、出站回复分别启用，以便真实照片 canary 单独批准和回滚。
11. 开关关闭时 reconciliation 不得 claim、不得发起 Zoho 附件 GET、不得写 Storage，并必须保持附件引用为 pending；重新启用后，同一引用必须可继续处理。关闭和恢复语义必须有自动化测试。
12. 每次 reconciliation 最多 claim 25 条已关联消息；每条消息最多接受 5 张图片，每张声明大小和实际流式读取均不得超过 10 MiB，因此单条消息累计最多 50 MiB、单次调用累计最多 1,250 MiB。超出数量、MIME/magic bytes 或大小限制的附件写入可审计的 `rejected` 状态；尚未处理的后续消息保持 pending，由下一次有界调用继续。
13. Evidence upsert 与 25 条源消息 final-state update 必须合并为一次受限的事务 bulk RPC；不得在附件或消息循环内逐行调用 PostgREST。最大规模调用的请求预算为 277：1 次 claim、最多 25 次 `attachmentinfo`、125 次下载、125 次 Storage 写和 1 次 bulk finalize；即每 1,000 条输入最多 11,080 requests。同一调用内不重试；每个引用跨调用最多重试 3 次（总尝试最多 4 次），使用 exponential backoff with jitter，且每次仍受相同 277 请求和 1,250 MiB 上限约束。
14. 第四次 claim 后若 worker 崩溃或 bulk finalize 失败，超过 15 分钟的 stale `processing` lease 必须先进入一次 recovery-only claim。Storage 路径格式为 `<ticket-prefix>/<message-identity-hash>/<content-hash>-<attachment-identity-hash>.<verified-extension>`；两个 identity hash 均由 provider account/message/attachment IDs 确定性计算且不可逆，使该消息前缀下最多只有本消息的 5 个对象，同时可以把每个对象精确映射回源 metadata 中的 attachment ID。recovery 允许对该消息执行一次 `attachmentinfo` 元数据读取以恢复 filename，但不得再次下载附件字节；随后对精确 Storage 前缀执行一次上限不少于 5 的 listing，按 attachment-identity hash 精确匹配，再对已上传对象执行有界读取、hash/MIME 校验并补建 Evidence/filename，不得写新 Storage 对象。禁止只列 ticket 级前缀的默认第一页后把未找到对象判定为丢失。成功恢复的引用正常完成；确实不存在或无法验证的引用才进入不可再 claim 的 terminal `failed`，记录 `attachment_retries_exhausted` 并清除 claimed/retry 时间。recovery worker 再次崩溃时，下一次 claim 直接 terminalize；不得留下永久 processing 或孤儿对象。

### 退出门禁

一条经过批准的真实照片 canary 能够通过已认证的签名访问显示；replay 不会新增任何 Storage 对象。

## 7. Phase 3 — 受治理的回复

1. 操作员只需登录 Ticket Portal，审查消息线程和订单上下文，并生成或编辑日文回复；不需要 Zoho 登录。
2. 确认弹窗展示掩码后的收件人、固定发件人、主题、回复意图和完整最终正文。
3. 后端从已授权的工单/线程/账号映射中解析原始 Zoho `messageId`、收件人和固定发件人；前端提供的 reviewed token 仅用于并发校验，不得选择或覆盖这些字段。
4. Portal 同时提交其实际审阅的 `tickets.message_revision`。Amazon claim RPC 使用 `client_operation_id` 认领 outbox，在工单锁内重新读取单调 revision 并比较完整线程版本，同时拒绝同工单其他 `sending|ambiguous` lease；按当前契约比较服务端保存的完整最终正文、意图和全部冻结 reviewed 证据，任一不一致必须失败关闭。若实施阶段增加服务端正文摘要，它只能作为补充索引/审计值，不能替代原文一致性检查。
5. 重新获取消息线程。如果最新客户消息 ID/时间与操作员审阅令牌不一致，或出现更新的客户消息，在任何外部写入前返回 `THREAD_STALE`。完成 thread GET、认证、目标解析和 Sent baseline 读取后，必须先把 baseline 持久化到 outbox；从 claim 成功到 baseline 持久化结束的任何失败都释放本次新建 claim。
6. baseline 持久化成功后、紧接 Zoho reply 前，调用第 5 节定义的原子 fencing RPC，再次核对单调 revision 与 lease generation 并设置 mutation 标记；RPC 失败时不得调用 Zoho，并释放仍属 pre-mutation 的新 claim。mutation 标记成功后不得释放，只能提交一次 Zoho reply，然后进入回读或 `ambiguous` reconciliation。
7. reconciliation 只能考虑 baseline 之后且发送时间不早于已持久化 `provider_mutation_started_at` 减 2 分钟 provider 时钟偏差的候选；不得用 outbox `created_at` 代替 mutation 时间。若有可靠的 provider reply ID，必须在已授权 provider account 内精确匹配，并验证它属于原始 `provider_thread_id` / reply target；否则候选必须同时满足已授权 provider account、原始 thread/reply target、上述发送时间边界和完整正文一致，且必须恰好一个。不得仅按正文匹配。零个或多个候选都保持 `ambiguous`，不得猜测或再次发送。
8. 重新读取 Zoho Sent/线程状态并匹配服务商消息标识，然后调用 Amazon 专用 finalize RPC。RPC 在同一事务内再次比较最新可信客户消息与操作员 reviewed token；只有 provider 回读成功且 reviewed token 仍为最新时，terminal reply 才能清除 `needs_reply`。如果期间已有新客户消息，发送审计照常完成，但保持 `needs_reply=true` 并让 Portal 提示重新审阅。
9. 提交超时或结果不确定时，状态变为 `ambiguous`；重试必须先执行上述受 thread/account/time/body 约束的 reconciliation，绝不能盲目再次提交。人工 `confirmed_not_sent` 必须遵守第 5 节的 settlement 契约：mutation 未开始时可在 fencing 后凭一次权威零候选回读终止；mutation 已开始时必须等待至少 30 分钟并取得至少两次相隔 5 分钟的权威零候选回读。若出现一个或多个候选，只能保留 `ambiguous` 或选择精确候选完成发送审计。

独立 kill switch：`AMAZON_MAIL_OUTBOUND_ENABLED=false` 为默认值。

### 退出门禁

单独批准的实时 canary 必须明确指定工单、源消息、发件人、收件人、主题和最终日文正文。Zoho 与 Supabase 权威回读结果必须一致。

## 8. Phase 4 — Portal 与订单上下文

- 仅使用 OrderMgmt 自有的只读能力；禁止直接读取跨域表。
- 保持现有 Reply Composer 位置和通用确认弹窗。
- 展示队列信任状态、映射异常、附件状态、线程过期冲突、出站禁用和模糊交付状态。
- 增加组件级行为测试，并在 `https://ops.homesbliss.net/tickets` 对移动端和桌面端执行已认证的可视化验证。

### 实施文件边界

- `web/worker/src/clients/zoho-mail.ts`：OAuth access token、列表、详情、附件、reply 与回读客户端；仅接受服务端配置。
- `web/worker/src/services/amazonMailSyncService.ts`：认证、checkpoint、持久化、重试和 reconciliation；无工单创建依赖。
- `web/worker/src/services/amazonMailSendService.ts`：outbox claim、freshness、Zoho reply、ambiguous 状态和回读完成。
- `web/worker/src/handlers/amazon-mail.ts`：受认证的手动 sync/canary 端点；不得提供任意邮件 compose。
- `web/worker/src/handlers/copywriting.ts`：在现有 send 路由中增加 `platform === "amazon"` 分支，并保持独立 kill switch。
- `web/worker/src/types.ts` 和 `web/worker/wrangler.toml`：声明 `ZOHO_ACCOUNTS_BASE`、`ZOHO_MAIL_API_BASE`、`ZOHO_MAIL_ACCOUNT_ID` 和 `AMAZON_MAIL_FROM_ADDRESS` 等非秘密配置；`ZOHO_CLIENT_ID`、`ZOHO_CLIENT_SECRET`、`ZOHO_REFRESH_TOKEN` 通过 secret store 注入，不写入仓库。
- `web/frontend/src/components/composer/Composer.tsx`、`SendConfirmModal.tsx` 和 detail health contract：增加 Amazon send capability、固定发件人/掩码收件人展示和禁用原因；不要求 Zoho 登录。
- `supabase/migrations/<timestamp>_amazon_zoho_mail_pipeline.sql`：只包含上述增量 schema、约束、索引和事务 RPC。
- `web/worker/tests/amazon-mail-*.test.ts`、composer/route 测试和 Supabase SQL 测试：覆盖认证、无损轮询、权限、Evidence、发送幂等和回读。

## 9. 上线与回滚

1. `off`：部署 schema 和代码，入站与出站均保持禁用。
2. `shadow`：运行两个健康周期；只保存聚合分类，不保存客户内容。
3. `canary`：处理一条可信入站消息，再处理一条附件 canary。
4. `active inbound`：启用有上限的定时任务；出站仍保持禁用。
5. `outbound canary`：发送一条单独批准的回复并执行权威回读。
6. `active outbound`：只允许操作员主动触发。

回滚时关闭受影响的 kill switch。已经持久化的源证据和发送审计必须保留；回滚不得删除或重写客户历史。

## 10. 验收计分卡

- 在 replay 或并发情况下，消息、工单、附件和发送均为零重复。
- 零不可信邮件获得客户消息语义。
- 在推荐权限决策下，自动创建工单数量为零。
- 分页和失败测试中没有任何静默跳过。
- 每条进入终态关联工单的新认证客户消息都能在同一事务内重开工单。
- 每次客户发送都具有已认证操作员、确认记录、操作 UUID、服务商结果和权威 reconciliation。
- 现有 Mercari/Rakuten 测试及工作流保持不变。

## 11. 文档与证据归属

后续所有设计、POC、实施、migration、上线和验收证据均保存在本仓库，并从 #235 链接。`inbox#85` 只保留跨仓库重定向。

## 变更日志

- 2026-09-07 v0.1.0：建立邮件路线架构和 POC 范围。
- 2026-09-07 v0.2.0：根据 Codex review 增加人工工单创建权限、邮件认证门禁、终态工单重开和无损轮询 checkpoint。
- 2026-09-07 v0.2.0-cn：将 canonical plan 全文转换为简体中文，技术标识保持不变。
- 2026-09-07 v1.0.0：确认邮件单一路线、后端代管 Zoho OAuth、Portal 一键发送，以及照片默认保存到现有 Evidence；移除 Ticket Handling 对 SP-API 的直接依赖。
- 2026-09-07 v1.0.1：明确队列正文/主题的最小读取投影，拆分摄取与操作员 Convert 权限，并统一 Zoho 幂等键和现有 outbox 正文一致性语义。
- 2026-09-07 v1.0.2：加入操作员已审阅线程并发令牌、冻结分页窗口持久化、真实 pending 状态，并规定未关联附件延迟下载到合法 Evidence parent。
- 2026-09-07 v1.0.3：增加 Amazon 专用原子 finalize，再次校验 reviewed token；并发新客户消息永远优先保持 `needs_reply=true`。
- 2026-09-07 v1.0.4：首次 outbox claim 冻结 reviewed ID/时间；重复 operation 拒绝证据漂移，finalize 仅信任持久化版本。
- 2026-09-07 v1.0.5：增加独立附件下载开关，并明确真实照片 canary 与文本摄取、出站回复分开批准。
- 2026-09-07 v1.0.6：允许预富化行缺少账号/订单映射；明确 claim 释放、Sent baseline/唯一候选和附件开关关闭/恢复测试。
- 2026-09-07 v1.0.7：增加数据库级每工单发送 lease 和完整线程 revision；Zoho mutation 前任何失败都释放新 claim。
- 2026-09-07 v1.0.8：线程 revision 改为每次消息插入递增；增加 provider-mutation 标记、安全回收和人工处置 ambiguous lease。
- 2026-09-07 v1.0.9：在 provider mutation 边界原子复核 revision；以 lease generation fencing 阻止被回收 worker 重复发送；将 Sent reconciliation 限定到原 account/thread/time/body；增加 durable `confirmed_not_sent` 终态及 replay 语义。
- 2026-09-07 v1.0.10：增加并重置 generation-specific `lease_claimed_at`；mutation 已开始的 no-send 处置必须经过 30 分钟 settlement 及两次相隔至少 5 分钟的权威零候选回读。
- 2026-09-07 v1.0.11：人工处置仅允许 `ambiguous`，`sending` 不可处置；finalize 不得覆盖 `confirmed_not_sent`；回读时间下界固定使用 mutation timestamp 减 2 分钟。
- 2026-09-07 v1.0.12：mutation-started `sending` 超过 5 分钟后只可原子晋级为 `ambiguous`；finalize 同时比较单调 revision，晚插入旧时间客户邮件也必须保持 `needs_reply`。
- 2026-09-07 v1.0.13：明确 revision 为 `NOT NULL DEFAULT 0` 并以 COALESCE 防御；crash recovery 使用现有允许的 `platform_sync_failed` 审计事件类型。
- 2026-09-07 v1.0.14：Amazon 行使用 Mercari 不可 claim 状态；分页 continuation 改为 provider message identity anchor；replay 排除自身 revision；terminal 不可被 stale ambiguous update 覆盖；filename 仅在关联后重读写入 Evidence。
- 2026-09-07 v1.0.15：跨调用分页改为冻结窗口内的 UTC 日期分片并对单日 overflow 失败关闭；成功 replay 不再修改 ticket freshness；补齐附件 25×5×10 MiB 与 426-request 数值预算。
- 2026-09-07 v1.0.16：附件 Evidence/source 更新收敛为单次事务 bulk RPC，预算降为 277 requests，并将 durable retry 限制为最多 3 次；finalize 仅以新可信客户证据驱动 `needs_reply`。
- 2026-09-07 v1.0.17：增加 customer-only monotonic revision 并在 replay 返回 late-customer warning；普通 Link 拒绝 Amazon；队列类型、分组和显示明确支持 nullable Amazon identifiers；耗尽附件 claim 转入 terminal failed evidence。
- 2026-09-07 v1.0.18：明确 Sent baseline 必须先于 mutation CAS 持久化；成功 replay 允许只读 late-customer warning；耗尽附件先执行一次 Storage recovery-only claim，再对不可恢复引用 terminalize。
- 2026-09-07 v1.0.19：附件确定性路径增加 message-identity hash 专用前缀，recovery 只列该消息最多 5 个对象，避免 ticket 级 listing 截断导致误 terminalize。
- 2026-09-07 v1.0.20：明确 Storage 对象名同时包含 content hash 与 attachment-identity hash，recovery 可将每个对象精确映射回 provider attachment ID 和 filename。
- 2026-09-07 v1.0.21：明确 recovery 可执行一次 `attachmentinfo` 元数据读取恢复 filename，但禁止再次下载 Zoho 附件字节或写入 Storage。
