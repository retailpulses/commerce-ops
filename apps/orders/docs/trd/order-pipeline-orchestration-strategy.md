# OrderMgmt 订单流水线完整性与编排战略

- **状态：** Accepted strategy / Phase 1-3 shadow implementation present, deployment pending
- **日期：** 2026-09-07
- **负责人：** OrderMgmt
- **触发事件：** Issue #265
- **相关设计：** Issue #259、`platform-order-status-reconciliation.md`、`order-pipeline-integrity-control-plane-hardening.md`
- **授权边界：** 战略方向已接受；本文不授权代码、数据库、调度器或生产环境变更。每个实施 phase 仍需独立评审、canary 和生产批准。

## 版本变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 8.7 | 2026-09-07 | 将 sales-brief live intent 绑定当前计划 JST slot；拒绝 past/future/off-schedule override，禁止以旧 slot 身份发送当前数据。 |
| 8.6 | 2026-09-07 | sales-brief 仅在 WeCom 返回可解析非零 `errcode` 时记 definitive rejection；HTTP-only/malformed/transport failure 均为 `UNKNOWN_RESULT`，禁止推断未送达。 |
| 8.5 | 2026-09-07 | 移除 sales-brief oneshot 的 `Restart=on-failure`，避免 ambiguous WeCom result 进入进程级自动重试；恢复必须经过 ledger reconciliation。 |
| 8.4 | 2026-09-07 | 将完整 sales-brief workload 正确归类为 external_write/Medium，证明 freshness 在 delivery intent 前阻断，并新增独立生产 canary/readback gate。 |
| 8.3 | 2026-09-07 | 将 sales-brief WeCom delivery 纳入 shared external-operation ledger：稳定 JST slot intent、confirmed duplicate skip、unknown/failure 阻断重发、dry-run 零写；生产 migration/canary 尚未执行。 |
| 8.2 | 2026-09-07 | 将 sales-brief target unit 从 root/mutable checkout 改为 `rp-ordermgmt`、canonical immutable release、protected env 与 systemd hardening，并以测试阻止回归；生产 unit 尚未变更。 |
| 8.1 | 2026-09-07 | 扩大 strategy-readiness audit，使其覆盖 Phase 5 明确列出的部署、数据库、workload governance、operations、relay 与 status-reconciliation canonical docs，而非只检查入口文档。 |
| 8.0 | 2026-09-07 | 清除 inventory 中“Rakuten close 在 DAG 外”的过期声明并纳入 contradiction test；继续区分 DAG/default-off control coverage 与 RMS contract/canary acceptance。 |
| 7.9 | 2026-09-07 | 增加 61-order fixture，证明 auto-approval 与 Rakuten confirmation 在 canonical live `limit=null` 下不会回退到 legacy 50-candidate cap；保留 bounded manual/canary 默认。 |
| 7.8 | 2026-09-07 | 新增可执行 strategy-readiness audit，统一核验 17 capability exact-canary、必要 migration/assets/canonical docs，并强制将所有生产 readback gate 保持为外部未满足证据，禁止静态仓库状态冒充战略完成。 |
| 7.7 | 2026-09-07 | #265 consumer-boundary tests 证明 partial freshness 时 fulfillment runner 不执行，payment reminder 不读候选/Marketplace、不处理 reservation 且不发送。 |
| 7.6 | 2026-09-07 | 新增 #265 sales-brief 执行级验收：stale/partial freshness 在订单读取、聚合与 WeCom 发送前阻断；dry-run 明确零发送。 |
| 7.5 | 2026-09-07 | 新增 canonical-doc contradiction test，阻止已被实现推翻的 canary/discovery 声明残留，并持续验证 target 与 deployed facts 的边界。 |
| 7.4 | 2026-09-07 | Mercari discovery 在 canonical ingest source 增加单 shop `orderTransaction(id)` 完整字段路径、exact DB scope 与 identity check，并跳过无关 terminal sweep；DAG canary matrix 全覆盖。 |
| 7.3 | 2026-09-07 | Rakuten discovery canary 直接使用 RMS getOrder exact full-order contract，零/多/错配结果在 shared ingestion 前 fail closed；Mercari discovery 继续拒绝。 |
| 7.2 | 2026-09-07 | Integrity audit canary 强制 platform/order identity（Mercari 另需 shop），数据库级限定 sales/shipment，只读单平台并返回 scoped completion；双表无目标时 fail closed。 |
| 7.1 | 2026-09-07 | Message sync 与 payment reminder canary 的候选、freshness、webhook retry、ambiguous reservation 全链路绑定 exact shop/order；目标缺失 fail closed。 |
| 7.0 | 2026-09-07 | Mercari auto-approval 在 product lookup、规则评估、limit、审批和通知前按 exact shop/order 过滤；缺失目标或非单 shop scope fail closed，并加入 canonical canary matrix。 |
| 6.9 | 2026-09-07 | 开放唯一 canonical live-canary 控制路径：单 capability、exact order、全局 `limit=1`，Mercari 强制 shop scope；非目标 DAG steps 跳过，unsupported scope fail closed，仍需 ownership/freshness 与人工批准。 |
| 6.8 | 2026-09-07 | Mercari/Rakuten lifecycle 支持 exact order scope；scoped success 仅为 `scoped_complete` 且禁止发布 global freshness，target 缺失时 provider-read 前失败。 |
| 6.7 | 2026-09-07 | Mercari/Rakuten tracking 在 Giga read 前应用 exact order scope，并将 `limit` 从 per-batch 修正为全局 bound，防止 canary 越界处理。 |
| 6.6 | 2026-09-07 | Rakuten confirm candidate 与 projection 在 limit/mutation 前支持 exact normalized order scope；作为 canonical canary control 的前置实现，尚未开放 live canary CLI。 |
| 6.5 | 2026-09-07 | 新增 workload-scoped quiescence verifier：disabled evidence、post-disable dispatch、unterminated run、lease、open operation 与 exact-release shadow acceptance 缺一不可。 |
| 6.4 | 2026-09-07 | Ownership cutover 强制经过 `disabled` quiescence：先阻断新 Worker dispatch 并排空在途/歧义操作，再允许 VPS acquisition；禁止 absent/Cloudflare 直转 VPS。 |
| 6.3 | 2026-09-07 | 新增单次 shadow 权威验收：绑定 release/owner、完整 DAG 终态、external-write skip evidence、lease release 与 dry-run 零 `pipeline_run_log` 写。 |
| 6.2 | 2026-09-07 | 每次 orchestrator 启动重新校验 loaded source、current pointer 与 exact `RELEASE_VERSION` 一致；漂移时在 lease/workload 前失败。 |
| 6.1 | 2026-09-07 | Shadow audit 增加按 phase 的无 PII production-cron count 对比与 per-run normalization；缺证据即不 ready，工具始终不自动批准 parity。 |
| 6.0 | 2026-09-07 | 新增七个完整 JST 日的只读 shadow-window audit：校验 cadence、终态、完整 step 与 external-write skip；明确该结果不等于 production output parity。 |
| 5.9 | 2026-09-07 | 新增 canonical orchestrator 独立 immutable release 安装流程：仅接受 main-reachable SHA，校验 shadow-only 配置，安装后保持 disabled/inactive，不触发任何运行或 cutover。 |
| 5.8 | 2026-09-07 | 同步 README、CLAUDE、operations 与 deploy 入口，明确当前 Worker-relay 和目标 VPS-direct transport，继续区分 branch-only 与 deployed/cutover 事实。 |
| 5.7 | 2026-09-07 | 在 target DAG 补齐独立 `rakuten_close` capability 与默认关闭的 live flag；依赖 Rakuten tracking、shadow 跳过，仍不构成 RMS contract/canary 授权。 |
| 5.6 | 2026-09-07 | VPS Rakuten discovery、exact lifecycle read、confirm 与 close 改为 bounded IPv4 local RMS adapter；复用既有 ingest/CAS/ledger/readback，Worker 继续 relay，close 仍不授权调度。 |
| 5.5 | 2026-09-07 | VPS payment reminder 的 ambiguous/pre-send read 与最终 reply 全部注入 IPv4 local client，同时保留 freshness/reservation/UNKNOWN_RESULT 门禁。 |
| 5.4 | 2026-09-07 | VPS scheduled message sync 注入 IPv4 local reader，同时保留 folded webhook retry 与 dry-run 零写；Worker 继续 relay。 |
| 5.3 | 2026-09-07 | VPS Mercari lifecycle 注入 IPv4-only local exact-status reader，保留 50-ID bound 与 fail-closed provider contract；Worker 继续 relay。 |
| 5.2 | 2026-09-07 | VPS Mercari close 改为直接启动 canonical ledger/readback batch；保留 scoped 参数与非零退出失败计数，Worker 仍走 relay。 |
| 5.1 | 2026-09-07 | VPS orchestrator 的 Mercari discovery 改为 Node-only local runner，跳过本机 relay HTTP/health；Cloudflare Worker 保持 fixed-IP relay transport，其他 capability 逐步迁移。 |
| 5.0 | 2026-09-07 | Bulk approval 改为提交并校验 scoped `order_targets`；legacy `order_ids` 保持兼容但碰撞时 fail closed。 |
| 4.9 | 2026-09-07 | Portal list 新增 scoped `portal_target_id`，drawer 全部单订单读写沿 channel/store/order target；显示仍使用原业务 ID，bulk approval 保持 fail-closed 待 scoped payload。 |
| 4.8 | 2026-09-07 | Portal order lookup 遇到多 channel/store scope 时返回 `ambiguous_order_scope`，禁止按首行猜测 mutation target；显式 scoped route contract 保持为上线门禁。 |
| 4.7 | 2026-09-07 | Mercari shipment projection 在 allocation、line numbering、limit 与 mutation 前按 channel/store/order 分组，杜绝跨店同号订单合并。 |
| 4.6 | 2026-09-07 | Giga tracking 对跨店同号订单 fail closed：在 provider read/write 前隔离冲突；正常结果按 channel/store/order 限定 sales 更新。 |
| 4.5 | 2026-09-07 | 修复 terminal integrity audit 的跨店 shipment join；shadow parity 与验收 backlog 必须使用完整 scoped identity。 |
| 4.4 | 2026-09-07 | 修复 Worker stuck-order diagnostic 仅按订单号关联：改为 `(source_store_id, normalized_order_id)`，禁止跨店 shipment 覆盖诊断事实。 |
| 4.3 | 2026-09-07 | 将 scoped identity 延伸到 Portal control-plane backlog join 与订单指标；跨店/跨渠道同号订单不得互相掩盖或合并计数。 |
| 4.2 | 2026-09-07 | 修复 cancellation reconciler 跨店串单：before/after snapshot 与 shipment invalidation 全部使用 `(source_store_id, normalized_order_id)`，同号订单不能跨店传播取消状态。 |
| 4.1 | 2026-09-07 | 开始执行 Phase 5 control-path retirement：删除未使用的 singular `/admin/close-shipped-order` relay endpoint 与 legacy script-path config，仅保留有 operation ledger/readback 的 bounded batch close endpoint。 |
| 4.0 | 2026-09-07 | 清除 canonical docs 中已被 16:03 JST Cloudflare API 读回推翻的旧表述：两个 historical reporting Worker 均不存在；当前 blocker 是 ownership transfer、VPS live lease 与切换后 single-owner readback，而非 trigger listing 缺失。 |
| 3.9 | 2026-09-07 | 将 `(source_store_id, order_id)` identity 贯彻到 Mercari auto-approval grouping、durable/live message safety、transactional review update 与通知，消除跨店同号订单共用 eligibility group 的风险。 |
| 3.8 | 2026-09-07 | 修复 message sync 完整性：dry-run 在 unresolved shop、relay error 与 exception 路径均不写 failure state；候选以 `(source_store_id, order_id)` 隔离，避免跨店同号订单被错误去重。 |
| 3.7 | 2026-09-07 | 清除 hidden dry-run side effect：preview audit 仅输出结构化日志，不再写 `pipeline_run_log`；live 执行继续持久化审计。 |
| 3.6 | 2026-09-07 | 恢复 Mercari/Rakuten tracking 真实 preview：保留 scoped Giga tracking read，但不调用 shipment/sales patch，返回 planned updates 与 `side_effects=0`；legacy end-to-end wrapper 继续阻断并按计划退役。 |
| 3.5 | 2026-09-07 | 恢复 Mercari/Rakuten shipment projection 真实 preview：返回 planned create/update/deduplication，测试注入 mutation spies 并证明 create/patch/delete 均未调用。 |
| 3.4 | 2026-09-07 | 恢复首个真实 preview：Mercari/Rakuten Giga outbound dry-run 只复用候选读取和 payload validation，不调用 sync writer、不 claim intent、不改 shipment、不触发 Giga create-order。 |
| 3.3 | 2026-09-07 | 封堵 false dry-run/manual bypass：Worker `/admin/run-once` 默认 dry-run 且拒绝 confirm_write；未证明无副作用的 projection/Giga/tracking/legacy reconcile preview 在进入 phase 前 fail closed。 |
| 3.2 | 2026-09-07 | 根据独立二审补齐双边 runtime fence：Cloudflare scheduled handler 在 durable owner 转移后逐 phase step-down，registry 读取失败同样阻断；VPS/Worker evidence 最长 24 小时，placeholder identity 无效，BLOCKED 原因进入 operator control plane。 |
| 3.1 | 2026-09-07 | 将 durable scheduler ownership 从 operator 可见证据提升为 live 执行前硬门禁：逐 enabled unit 校验 workload、VPS owner、host、release、enabled state、legacy-disabled proof 和有效期；不匹配则先持久化 BLOCKED，phase 不执行。 |
| 3.0 | 2026-09-07 | 记录 16:03 JST Cloudflare schedule API 权威只读结果：主 Worker 13 条 cron 全部存在，两个历史 reporting Worker 名称均不存在；补齐 Phase 0 scheduler owner 证据但未改变任何 trigger。 |
| 2.9 | 2026-09-07 | 记录 15:45 JST bounded runtime readback：Worker version/release、VPS canonical unit 未安装、16 个 legacy timers disabled、sales brief enabled/healthy；direct Cloudflare trigger API readback 仍是 cutover blocker。 |
| 2.8 | 2026-09-07 | terminal integrity audit 分别采集 Mercari/Rakuten，显式按 channel 隔离 sales，并持久化逐平台 backlog counts；保持只读，不成为第二 writer。 |
| 2.7 | 2026-09-07 | 新增 per-workload scheduler ownership registry：CAS、近期证据、8 天内过期、VPS owner 必须证明 legacy disabled、不可变事件与默认 dry-run operator CLI；表对 service_role 只读，唯一写入口为审计 RPC；Portal 区分 durable owner 与瞬时 executor。 |
| 2.6 | 2026-09-07 | 增加 fail-closed per-capability live ownership：systemd env 决定 mode，global gate + 显式 capability flag 双重启用，未拥有 workload 为 SKIPPED，缺失上游的已启用下游为 BLOCKED。 |
| 2.5 | 2026-09-07 | `pipeline_steps` 持久化逐 phase completion state 与 allowlisted aggregate counts，不再只记调用数量；禁止把订单级结果或客户/provider payload 写入控制面。 |
| 2.4 | 2026-09-07 | 扩展 cross-platform DAG：Mercari/Rakuten 分支故障隔离、消息独立、每 capability 独立 durable step、付款提醒 lifecycle 依赖与尾部只读 integrity audit；Rakuten close 仍不上线。 |
| 2.3 | 2026-09-07 | 统一 orchestrator live phase accounting：`null` 明确表示全量，正整数表示 shadow/canary 上限，禁止用含义冲突的 `0`；仍保留 provider pagination/scale canary 上线门槛。 |
| 2.2 | 2026-09-07 | 二审加固 operator surface：统一跨表 order ID、按 Mercari 渠道隔离 backlog、限定 canonical lease、确定性 bounded query 并显示截断；shadow lease 不再冒充生产 owner，实例 owner 来自匹配的 live run/lease。 |
| 2.1 | 2026-09-07 | 实现 branch-only operator control-plane API/UI：展示 release、证据限定的 scheduler owner、lease、run/step、freshness、operation backlog 和 bounded workload backlog；尚未部署或完成 runtime acceptance。 |
| 2.0 | 2026-09-07 | 明确 repository strategic canonical docs 是每个 capability cutover 的同步交付物；Phase 5 仅做最终一致性审计、补漏与旧控制路径退役，不得延后记录已发生的架构和运行时事实。 |
| 1.9 | 2026-09-07 | Mercari close 接入整单 durable intent 与 exact marketplace completion readback；多 shipping mutation 的部分/歧义结果禁止重发，Supabase 全部订单行通过单一 RPC 原子完成。 |
| 1.8 | 2026-09-07 | Rakuten close 实现逐单 durable intent、整单多行去重/一致落库、RMS 500 权威对账和歧义禁止重发；仍保持 unscheduled，正式 contract verification 与 canary 未完成。 |
| 1.7 | 2026-09-07 | operation ledger 恢复闭环：新增单操作 CAS resolution RPC、不可变审计表和默认 dry-run 的 operator CLI；只允许依据权威证据标记已执行或释放，禁止按年龄自动恢复；尚未部署。 |
| 1.6 | 2026-09-07 | Rakuten confirm 接入逐单 operation ledger；确认写入先 claim，歧义结果 exact-ID 读回，无法证明时保留 `UNKNOWN_RESULT`，禁止自动释放重试；尚未部署。 |
| 1.5 | 2026-09-07 | 外部写第一批：新增通用 operation ledger，Giga create-order 采用持久 claim/finalize/readback，取消不安全的写请求自动重试并保留 `UNKNOWN_RESULT`；尚未部署。 |
| 1.4 | 2026-09-07 | 跨平台 lifecycle 实现：Rakuten 已知非终态订单 exact-ID 对账、整单多行 CAS、freshness watermark 与下游 fail-closed gate 接入目标 schedule/orchestrator；尚未部署。 |
| 1.3 | 2026-09-07 | Phase 3 shadow 实现：新增持久 run/step ledger、数据库 lease/heartbeat、readback、异常终态收口和 hardened systemd unit；尚未迁移数据库、安装 timer 或产生 runtime evidence。 |
| 1.2 | 2026-09-07 | 第二批实现：reminder ambiguous-send reconciliation、fulfillment freshness gate、Giga 外部写即时资格重读，并从目标 Worker schedule 移除 write-capable legacy reconcile 与未验证 Rakuten close；尚未部署。 |
| 1.1 | 2026-09-07 | 首批实现：Mercari exact-ID lifecycle reconciliation、持久 freshness watermarks、提醒/日报 fail-closed gate 与 reminder delivery state；尚未部署。 |
| 1.0 | 2026-09-07 | 战略定稿：同步 canonical repo 入口，明确 Accepted strategy 与 implementation authorization 边界。 |
| 0.3 | 2026-09-07 | 将 repository canonical documents 的同步更新纳入每阶段 cutover、Phase 5 和最终验收，避免目标架构落地后继续保留冲突的调度、部署和运行说明。 |
| 0.2 | 2026-09-07 | 纳入独立二审：提升 Rakuten close 未验证却被调度的风险，修正 cron/工作量计数，区分日报事故与付款提醒残余风险，明确现有 end-to-end reconciler 是重复 writer，并补充 timer/reporting/runtime drift。 |
| 0.1 | 2026-09-07 | 根据 #265 运行时调查建立完整订单流水线、单一编排控制面和产品完整性门控战略。 |

## 1. 执行摘要

#265 不是单纯的日报分类错误，也不能仅靠增加一次订单补查解决。事故证明，当前 OrderMgmt 缺少一个对订单端到端业务结果负责的编排者：多个独立 cron 以固定分钟错峰模拟依赖关系，但下游任务无法证明上游数据新鲜、成功且完整。

战略决策如下：

1. **Supabase 继续作为规范化订单业务主库，Marketplace API 继续作为外部生命周期事实来源。**
2. **每个业务事实只能有一个 writer，每个 workload 只能有一个生产 scheduler owner。**
3. **订单发现与订单状态对账分离。** 列表接口负责发现；所有本地非终态订单必须持续接受权威状态对账。
4. **以持久化运行账本驱动依赖，不再以 `:01 → :03 → :06 → :09` 的时间间隔代表完成。**
5. **所有外部写入在执行前必须重新读取权威门控状态；超时或不确定结果不得直接重试。**
6. **近期由 VPS systemd 启动唯一 OrderMgmt orchestrator。** Mercari 固定 IPv4 使 VPS 成为不可替代的执行环境；Cloudflare 保留 API、Portal 和监控职责，不再并行调度业务流水线。
7. **报告和付款提醒是流水线消费者。** 它们只有在依赖的新鲜度与完整性条件成立时才可产生正常输出或外部消息。

该战略不是要求把现有 13 个 Worker cron（承载 16 个 pipeline phase，另有 1 个 reporting workload）原样搬到 VPS，而是将它们重构为有依赖、有租约、有检查点、有读回和可恢复语义的订单工作流。

## 2. 事故证据与架构含义

2026-09-07 的运行时证据：

- 目标 Mercari 订单在 06:14 JST 起由单订单读取持续返回 `WAITING_FOR_SHIPPING`。
- Cloudflare `pull_shop_orders` 在 07:01 和 08:01 JST 均运行完成且记录 `failed=0`。
- 08:00 JST 销售简报仍从 Supabase 将该订单读为 `WAITING_FOR_PAYMENT`。
- 付款提醒同样在 08:00 JST 执行，并检查到一个候选订单；下一次订单拉取安排在 08:01。现有提醒实现已经包含 exact-ID pre-send live check 和 reserve-before-send，因此 #265 没有证明该提醒实际误发；残余缺口是持久化 freshness gate 和未知发送结果的自动对账。
- Cloudflare 在线配置包含完整 cron 集；VPS pipeline timers 已安装但全部 disabled。
- 销售简报实际由 VPS `order-mgmt-sales-brief.timer` 运行，与仓库 inventory 中的 sibling Worker 描述不一致。
- `close_rakuten_orders` 存在高风险自相矛盾：代码注释和 VPS timer 声明 RMS close endpoint/payload 未验证且不应调度，但 `pipeline-schedule.mjs` 已把它加入 Worker cron；`pipeline_run_log` 证明过去 24 小时执行了 120 次。当前候选是否始终为 0、是否曾发生真实 RMS mutation，必须作为实施前立即核查项。
- `reconcile_end_to_end` 当前不是只读检查：它会再次执行 Mercari pull、Giga push、tracking pull 和 marketplace close，因此是事实上的重复外部 writer。
- 仓库存在约 16 个细粒度 VPS timer 和 3 个 legacy timer；其 cadence 与 Worker 并不等价，例如 shipment build/auto-approve 分钟数不同。它们不能作为 Worker cron 的逐项镜像直接启用。
- 仓库仍保留 historical sibling reporting Worker 代码/cron 配置，但 16:03 JST Cloudflare API 对 `rp-order-mgmt-reporting` 与 `rp-mercari-reporting` 均返回 Worker-not-found；结合 VPS timer enabled/active 读回，当前 observed reporting scheduler owner 为 VPS。保留的旧代码仍应在 Phase 5 明确退役，未来重建必须经过 single-owner gate。

由此得到的架构结论：

- scheduler 确实触发不等于订单状态已经收敛；`processed` 聚合计数也不证明具体订单得到处理。
- Marketplace 列表返回不能作为已知订单持续新鲜的证明。
- 报告在刷新前运行且没有 freshness gate，是本次已确认的产品完整性缺陷。付款提醒虽然已有发送前 live check，但调度顺序仍不合理，且缺少持久 freshness 证明与 ambiguous-send 自动 reconciliation。
- 当前跨 Cloudflare、Tunnel、VPS relay、子进程的同步调用链扩大了失败面，却没有订单级完成凭证。
- 当前 scheduler 文档、部署意图和实际运行状态存在治理漂移。
- 未验证契约的 `close_rakuten_orders` 被实际 scheduler dispatch，是高于一般迁移工作的即时 release-safety 风险；必须先确认其生产行为，不能等到最终架构迁移。

## 3. 产品完整性不变量

以下条件是实现和发布的硬性要求：

### 3.1 事实所有权

| 事实 | 权威来源 | 规范化事实所有者 / writer |
|---|---|---|
| Marketplace 原始订单状态 | Mercari / Rakuten API | OrderMgmt lifecycle reconciler |
| 规范化订单状态与状态观测证据 | Supabase `sales_orders` | OrderMgmt lifecycle reconciler |
| 人工审核、地址修订、配送偏好、备注 | Operator / Portal | 对应 Portal mutation；自动化不得覆盖 |
| Shipment projection | Supabase sales facts | channel-specific projector |
| Giga 提交状态（目标态） | Giga API + 待新增的本地请求账本 | Giga outbound writer |
| Tracking | Giga API | tracking reconciler |
| Marketplace close 状态 | Mercari / Rakuten API | channel-specific close writer |
| 消息、提醒与发送结果 | Marketplace message API + outbox | message writer |
| 报告快照 | 已验证的新鲜 Supabase 事实 | reporting projector，只读业务事实 |

报告聚合本身只读，但向 WeCom 投递是外部写。每个 JST delivery slot 必须先持久化稳定 intent；已确认 slot 跳过重复发送，传输结果不确定时进入 `UNKNOWN_RESULT` 并阻断自动重发。

### 3.2 单调性与门控

- 未付款订单不得进入审批、shipment projection、Giga push 或 close。
- 已取消/取消中的订单不得进入新的履约外部写。
- 已完成/已取消状态不得被旧的非终态响应回退。
- 没有新鲜 Marketplace 状态凭证的订单不得发送付款提醒。
- 没有已持久化且读回验证的 tracking，不得执行 marketplace close。
- `UNKNOWN`、mapping 缺失、API 结果不完整或数据过期必须 fail closed。
- 下游资格在外部写入前即时重读，不能只依赖早先生成的候选列表。

### 3.3 完成与业务成功

- HTTP 2xx、进程退出 0、cron green 都不是业务完成的充分条件。
- 每个阶段必须记录输入候选、逐订单结果、持久化写入、权威读回及未解决项。
- 一次运行只有在所有纳入范围的订单都有 `changed / unchanged / deferred / retryable_failed / terminal_failed` 明确归属时，才可声明 accounting complete。

## 4. 目标架构

```text
VPS systemd timer
  -> OrderMgmt orchestrator（唯一 scheduler owner）
       -> 获取 execution lease + 创建 pipeline_run
       -> Marketplace discovery
       -> 非终态 lifecycle reconciliation
       -> eligibility / approval
       -> shipment projection
       -> Giga outbound + result reconciliation
       -> tracking reconciliation
       -> Marketplace close + close readback
       -> end-to-end integrity check
       -> 发布 fresh snapshot watermark
            -> reporting 可消费
            -> payment reminder 可进入独立发送门控

Cloudflare Worker
  -> Portal / Admin API
  -> 健康状态与只读运行视图
  -> 告警入口
  -> 不作为第二套生产业务 scheduler
```

### 4.1 为什么近期选择 VPS 作为 orchestrator host

- Mercari API 强制使用 ConoHa 固定 IPv4，订单拉取、消息、取消、提醒和关单最终都必须到 VPS。
- 在 VPS 内直接执行可消除 Cloudflare → Tunnel → relay HTTP → 子进程这一内部控制链。
- systemd 提供进程级 timeout、restart、journal、资源限制和启动依赖。
- 同一部署单元可运行共享代码，减少 Worker bundle 与 VPS checkout 的版本分裂。

选择 VPS 不代表接受单机无保护运行。上线前必须具备 systemd watchdog、主机/磁盘监控、自动启动、备份恢复说明和 Cloudflare 只读健康监控。Cloudflare 不能作为同时启用的“热备 scheduler”；故障切换必须由显式人工或受控自动化改变 scheduler lease owner。

### 4.2 长期控制面

运行状态必须持久化在 Supabase，而不是只存在于 systemd journal。现有 `pipeline_run_log` 是阶段完成与聚合计数的部分基础，但尚不能替代步骤依赖、订单级 intent/outcome 和 lease：

- 扩展或演进现有 `pipeline_run_log`：一次 orchestration 的版本、触发、范围、开始/结束、整体状态。
- `pipeline_steps`（待新增或以等价模型实现）：阶段依赖、尝试、租约、计数、错误类别和水位。
- `order_operation_attempts` 或等价 outbox（待新增）：高风险外部写的 intent、idempotency key、结果与 reconciliation 状态。
- Marketplace status evidence：原始状态、mapping 状态、observed/check/changed 时间和错误。
- Freshness watermark：按平台/店铺标记最后一次 accounting-complete 的权威同步。

具体表结构必须另行完成数据库治理与 migration 评审；本文不授权建表。

## 5. 全部 workload 的目标归属

| Inventory workload ID | 当前 phase | 目标阶段 | 目标执行位置 | 关键完整性要求 |
|---|---|---|---|---|
| `ordermgmt_mercari_order_pull` | `pull_shop_orders` | Mercari discovery | VPS | 只负责发现与幂等建档；不得宣称所有已知订单已更新 |
| `ordermgmt_rakuten_order_pull` | `pull_rakuten_orders` | Rakuten discovery | VPS | 与 reconciliation 共用状态 mapping |
| `ordermgmt_mercari_message_sync` | `sync_mercari_messages` | Message ingestion | VPS，独立低优先队列 | 不得阻塞审批/投影主链；消息事实单一 writer |
| `ordermgmt_auto_approve_orders` | `auto_approve_orders` | Eligibility | orchestrator 内部 | 要求新鲜状态；CAS 写入 |
| `ordermgmt_rakuten_order_confirm` | `confirm_rakuten_orders` | Rakuten external write | VPS | intent-first、幂等、unknown-result reconciliation |
| `ordermgmt_giga_shipment_build` | `build_giga_shipments` | Mercari projection | orchestrator 内部 | 只消费新鲜、可履约订单；order-line 完整性 |
| `ordermgmt_rakuten_shipment_build` | `build_rakuten_shipments` | Rakuten projection | orchestrator 内部 | 同上，使用 Rakuten 门控 |
| `ordermgmt_giga_order_push` | `push_orders_to_giga` | Mercari Giga outbound | VPS | 外部写前重读资格；请求账本；ALREADY_EXISTS 对账 |
| `ordermgmt_rakuten_order_push` | `push_rakuten_orders_to_giga` | Rakuten Giga outbound | VPS | 与 Mercari 共享同一 outbound contract，channel 隔离 |
| `ordermgmt_giga_tracking_pull` | `pull_giga_tracking` | Tracking reconciliation | VPS | 多包裹完整持久化和读回 |
| `ordermgmt_rakuten_tracking_sync` | `sync_rakuten_tracking` | Tracking reconciliation | VPS | 与 close 明确完成依赖 |
| `ordermgmt_shop_order_close` | `close_shop_orders` | Mercari close | VPS | 仅消费已验证 tracking；未知结果先查后重试 |
| `ordermgmt_rakuten_order_close` | `close_rakuten_orders` | Rakuten close | VPS | endpoint/payload 先完成权威验证；之后才允许受控启用 |
| `ordermgmt_end_to_end_reconcile` | `reconcile_end_to_end` | Integrity audit/healing | orchestrator 尾部及周期补偿 | 当前会重跑 push/close；目标实现必须移除竞争外部写，只修复明确拥有的内部事实 |
| `ordermgmt_cancellation_reconcile` | `reconcile_cancellations` | Lifecycle reconciliation | 合并进统一状态对账 | 切换后退役独立 writer/schedule |
| `ordermgmt_payment_reminder` | `send_payment_reminders` | 独立高风险消息 workflow | VPS | 保留现有 pre-send exact-ID check/outbox；新增 persisted freshness gate 和 unknown-result reconciliation |
| `ordermgmt_sales_brief_reporting` | reporting runtime | Fresh snapshot consumer | VPS 或单一 reporting runtime | 必须验证 watermark 和 live scheduler 唯一性，防止重复 WeCom 推送 |

`sync_mercari_messages` 不再与 `auto_approve_orders` 和 `build_giga_shipments` 绑定在同一 cron invocation。消息同步时长不应决定履约主链延迟。

现有 `reconcile_end_to_end` 必须在迁移中改造，不能原样迁移：它当前再次调用 `pull_shop_orders`、`push_orders_to_giga`、`pull_giga_tracking` 和 `close_shop_orders`。目标态的 integrity audit 可以检测、隔离和触发由 canonical writer 处理的补偿任务，但不能自己成为第二个 Giga/close writer。

## 6. 生命周期状态对账

采用 `platform-order-status-reconciliation.md` 的设计作为本战略的核心能力：

- Discovery 用列表接口发现新订单。
- Reconciliation 从 Supabase 选择全部本地非终态订单，按精确外部订单 ID 获取状态；平台不支持 exact-ID 时，批量扫描必须对每个候选给出 matched/not-found/failed accounting。
- Mercari 初始覆盖付款、待发货、完成中、完成、取消中和取消。
- Rakuten 初始覆盖所有已验证 `orderProgress`，未知 mapping 持久化为 UNKNOWN 并阻断履约。
- 同一 pure mapping 被 discovery、reconciliation、Portal gate、projection、push、close 和 reporting 使用。
- 状态 observation 持久化后执行数据库 readback，再更新 freshness watermark。

统一 reconciliation 启用并证明 parity 后，退役独立的 `reconcile_cancellations` scheduler，避免竞争 writer。

## 7. 外部写入契约

### 7.1 Giga 下单

1. 在数据库持久化 intent 与稳定 idempotency key。
2. 即时重读订单资格和取消/付款 freshness。
3. 调用 Giga。
4. 明确成功时持久化结果并读回。
5. timeout/连接中断记为 `UNKNOWN_RESULT`，先查询 Giga 是否已创建，再决定是否重试。

### 7.2 Marketplace close

1. 要求所有 shipment packages 均有已验证 tracking。
2. 即时读取 marketplace 当前状态，排除已关闭、取消或不兼容状态。
3. 使用订单 ID 作为幂等边界提交 close。
4. 提交后按权威接口读回状态。
5. 未知结果进入 reconciliation，不直接重复 close。

### 7.3 付款提醒

现有实现已经具备 reserve-before-send、exact-ID live status check 和发送结果记录；目标改造不得重复建立第二套 outbox。

1. 在现有机制前增加 persisted freshness watermark gate，只从新鲜、权威确认为 `WAITING_FOR_PAYMENT` 的订单生成候选。
2. 保留发送前 exact-ID 付款/取消状态复核。
3. 保留现有 reservation/outbox intent，再调用消息 API。
4. 保留平台消息 ID 或可验证发送结果记录。
5. 为现有保留 reservation 的失败状态增加明确 `UNKNOWN_RESULT` reconciliation；先查询是否已发送，再决定释放、确认或人工处理。

## 8. 调度与依赖策略

初始建议 cadence 不是最终 SLA；实现前应以 API 限流、订单量和运营要求校准。

| Workflow | 建议触发 | 依赖 |
|---|---|---|
| Discovery + lifecycle reconcile | 每小时，并支持事件/人工触发 | Marketplace 可用；每店铺隔离 |
| Fulfillment main chain | 上游产生 eligible change 后，或周期性补偿 | fresh lifecycle watermark |
| Tracking + close | 目标约每 10 分钟，以依赖状态触发为准 | 已确认 Giga submission；tracking durable。当前 Rakuten tracking cron 为每小时 5 次并缺少 `:00`，不能表述为严格 10 分钟 cadence |
| Message ingestion | 每 10 分钟独立运行 | 不阻塞 fulfillment |
| Payment reminder | 每日业务时点 | 当日 fresh lifecycle reconcile 完成后 |
| Sales brief | 运营时点 | 对应平台/店铺 freshness watermark 达标 |
| End-to-end audit | 每小时/每日深度检查 | 只修复明确拥有的内部事实 |

调度时间只表示“开始尝试”，依赖满足必须读取持久状态。若上游失败或过期，下游记录 `blocked_by_freshness`，而不是生成看似正常的空报告或执行外部写。

## 9. 并发、幂等与恢复

- orchestrator 获取全局 run lease；订单级外部写另取 order-operation lease。
- lease 带过期时间和 owner/run ID，崩溃后可安全接管。
- 所有内部更新使用预期旧状态/版本的 CAS；影响 0 行视为并发冲突并重新读取。
- retry 只能针对明确可重试错误；认证、mapping、schema 和永久业务错误直接隔离告警。
- 每个平台、店铺和订单失败相互隔离，但整个运行必须如实报告 partial，而不是 green。
- 已持久化的权威事实不因 rollback 被批量回退。

## 10. 可观测性与运营界面

最低指标：

- 每个平台/店铺最后 accounting-complete 时间与数据年龄；
- oldest overdue non-terminal order；
- discovery、reconciliation 的 candidates/matched/changed/unchanged/not-found/failed；
- 各阶段 blocked-by-freshness 数；
- Giga push、close、reminder 的 intent/succeeded/unknown/reconciled；
- 状态 backlog、tracking backlog、close backlog；
- 当前 scheduler owner、release SHA、host 与最近心跳；
- 文档 inventory 与 live runtime drift。

日志只包含订单业务键、店铺、状态、run ID、错误类别和计数；不得记录 token、地址、姓名、电话、消息正文或完整 API payload。

Portal/运维页应显示：当前 release、scheduler owner、最近成功、partial/failed、freshness、积压和 kill switch 状态。`updated_at` 不得作为 Marketplace freshness 代理。

## 11. 安全与权限

- VPS 使用独立低权限服务用户；systemd unit 不以 root 运行。
- 按 workload 拆分或限制 Marketplace、Supabase 与 Giga 凭据权限。
- Cloudflare 与 VPS 不共享不必要的写凭据；迁移完成后撤销已不使用的 secret。
- Admin/manual run 必须鉴权、记录操作者和 run ID，并默认 dry-run。
- 报告 webhook 与客户消息发送权限不得暴露给只读 reconciliation。

## 12. 分阶段迁移

### Phase 0：冻结事实与运行基线

- 将全部 17 个 workload 的 live scheduler、host、release、secret owner 和最后成功时间对账。
- 修正 `SYNC_JOB_INVENTORY.md` 与 sales brief 实际 runtime 漂移。
- 立即核查 `close_rakuten_orders`：确认 live Worker 是否实际 dispatch、历史是否有非零候选或 RMS mutation、endpoint/payload 是否已经权威验证；在未得到证据前不得把它当作已批准能力。
- 已通过 Cloudflare schedule API 查询两个历史 sibling reporting Worker 名称，均返回 Worker-not-found；结合 VPS timer 的 enabled/active 读回，当前 observed reporting owner 为 VPS。任何未来重建仍必须经过 single-owner gate。
- 将现有细粒度/legacy VPS timers 标记为 schedule-divergent migration artifacts；不得逐个启用作为 Worker mirror。
- 为现状建立 7 天失败率、时长、backlog 和状态矛盾基线。

**退出条件：** 每个 workload 只有一个可证明的当前生产 scheduler owner；所有未知项显式列出。

### Phase 1：先封住客户与资金风险

- Payment reminder 保留现有 exact-ID pre-send check 与 reservation/outbox，增加 persisted freshness gate 和显式 unknown-result reconciliation。
- Sales brief 增加 watermark gate 和 stale/partial 标识。
- Giga push 与 close 增加即时资格重读和 unknown-result reconciliation。

**退出条件：** 已付款/取消/过期订单无法进入提醒、Giga push 或 close；测试覆盖 race 与 timeout。

### Phase 2：统一 lifecycle reconciliation

- 实现 Mercari + Rakuten discovery/reconciliation 分离和共享 mapping。
- 加入状态证据、候选 accounting、CAS 和 readback。
- canary 后退役独立 cancellation writer。

**退出条件：** 已知非终态订单最终收敛；#265 类案例在 freshness SLA 内修复且可追溯。

### Phase 3：建立 VPS orchestrator shadow run

- 实现 run/step ledger、lease、DAG gate 和 systemd hardening。
- VPS 以 dry-run/shadow 模式执行计划，不产生外部写；与 Cloudflare 当前结果对比。
- 验证 restart、网络中断、Supabase/Giga/Mercari 限流和部分失败。

**退出条件：** 连续至少 7 天 shadow accounting 与生产一致，无未解释漏单或重复候选。

### Phase 4：逐 capability cutover

迁移顺序：

1. lifecycle discovery/reconciliation；
2. internal eligibility/projection；
3. tracking；
4. Giga external writes；
5. marketplace confirm/close；
6. messages/reminders；
7. reporting。

每一 capability：部署 VPS → dry-run → 小范围 canary → ownership CAS 到 `disabled` 阻断新 Cloudflare dispatch → 等待并读回旧执行排空、无 unresolved operation → ownership CAS 到 VPS 并仅启用该 capability → 读回确认只有一个 scheduler owner → 同一变更中更新 canonical repo docs → 扩大范围。禁止从 absent/Cloudflare 直接转给 VPS，也禁止同时启用两个 production writer。现有 VPS per-phase timers 与 Worker cadence 不等价，因此不得 timer-by-timer 直接启用；必须按完整 capability contract cutover。

这里的 canonical repo docs 不只是 runbook：每次 cutover 必须同步更新本战略及相关 TRD、架构/决策、当前状态、workload ownership、部署治理、数据库治理和运维入口。文档变更与代码、部署配置、迁移和 runtime readback 属于同一个 capability cutover 交付物；缺少任一项，该 capability 不得宣告完成。Phase 5 只负责最终一致性审计与退役残留清理，不能把前序阶段已经改变的事实延后到 Phase 5 才记录。

### Phase 5：退役旧控制路径

- 删除/归档 legacy 三 timer 与重复的细粒度 timer 设计，只保留 canonical units。
- 移除 Worker business cron、未使用 relay control endpoints 和不再需要的 secrets。
- 对所有受影响的 repository canonical documents 做最终一致性审计，补齐遗漏并清除过期表述；这些文档应已随各 capability cutover 更新，Phase 5 不是首次更新点。审计必须确认代码、部署配置、运行时和文档表达同一个事实：
  - `CLAUDE.md`：生产架构、阶段模型、scheduler owner、运行入口和部署方式；
  - `README.md`：产品能力边界、快速开始和 canonical runtime；
  - `docs/00_CURRENT_STATE.md`：当前已验证状态、未完成项和最近核验日期；
  - `docs/05_DECISION_LOG.md`：scheduler/runtime 选型、single-writer 边界、分阶段 cutover 决策、替代方案与回滚条件；
  - `docs/15_DEPLOYMENT_AND_HOUSEKEEPING.md`：部署事实所有者、不可变发布、旧 unit/trigger 清理和部署后 readback；
  - `docs/17_SYNC_WORKLOAD_GOVERNANCE.md`：所有同步/对账/外部写 workload 的 ownership、幂等性、freshness、partial failure 与退役规则；
  - `docs/16_DATABASE_GOVERNANCE.md` 及适用的 local companion：control-plane 表/RPC、RLS/grants、migration ownership、审计与数据保留；
  - `docs/SYNC_JOB_INVENTORY.md`：全部 workload 的 owner、schedule、host、source/target、writer、kill switch、last-success verification 和 lifecycle；
  - `docs/deployment.md`、`docs/operations.md` 与 `docs/vps-relay.md`：部署、运维、故障处理和 relay 退役后的实际边界；
  - `deploy/README.md`：唯一 canonical systemd units、安装、验证、rollback 和禁止启用的 legacy units；
  - `docs/SCHEDULER_STATE.md`：若保留，则更新 live verification、唯一 scheduler owner 和最后核验时间；若其职责已被 inventory/runtime view 完整取代，则通过独立可审查变更明确退役，而不是静默删除；
  - `docs/trd/platform-order-status-reconciliation.md` 与本战略：记录最终实现选择、偏差和完成状态；
  - 架构图、runbook、故障切换、恢复演练和 operator acceptance checklist。
- 搜索并清理仓库内所有声称 Cloudflare business cron 为 primary、VPS timers 为 secondary/alternative、旧三 timer 可启用或 reporting runtime 位于错误主机的过期描述。
- 文档更新必须包含版本变更记录，并引用对应 PR、部署证据与 runtime readback；不能把“设计完成”写成“已迁移/已上线”。

## 13. 回滚原则

- 每个 capability 独立回滚，不进行全系统瞬时切换。
- 回滚先停止新 scheduler，再确认无在途 lease/外部写，随后恢复旧 scheduler。
- `UNKNOWN_RESULT` 操作必须先对账，不能因回滚重新发送。
- 保留 run ledger、status evidence、outbox 和已确认状态；不回退真实业务事实。
- 回滚完成后验证 scheduler owner 唯一性、下一次运行、数据库 readback 和 operator surface。

## 14. 验收标准

战略实施完成必须同时满足：

1. 全部 workload 的 live runtime 与 inventory 一致。
2. 每个 workload 只有一个 scheduler owner；每个事实只有一个 writer。
3. 非终态 Marketplace 订单在 SLA 内完成权威对账，不依赖 discovery 窗口。
4. 报告和提醒在上游 stale/partial 时 fail closed，并向 operator 显示原因。
5. Giga push、Marketplace confirm/close、付款提醒具备 intent、幂等键、unknown-result reconciliation 和 readback。
6. 多行订单状态、projection、tracking 和 close 保持 order-level 一致。
7. crash、timeout、重复触发、乱序响应和平台限流测试不产生重复外部动作或状态回退。
8. VPS 重启后 systemd 恢复正确，Cloudflare 不会并行触发同一业务 workload。
9. 运维界面可看到 release、owner、freshness、last success、partial failure 和 backlog。
10. #265 场景端到端测试证明：付款状态变化后，错误报告、错误提醒和错误履约均被阻止。
11. `CLAUDE.md`、`README.md`、`docs/00_CURRENT_STATE.md`、`docs/SYNC_JOB_INVENTORY.md`、部署/运维/runbook、scheduler state、相关 TRD 与架构图已经与最终代码和 live runtime 对齐；仓库搜索不再发现相互冲突的 active scheduler 或 runtime 声明。

## 15. 明确不采用的方案

- 只修改 sales brief 分类，使其从 `payment_date` 推断付款。
- 只提高 `pull_shop_orders` 频率。
- 仅为 #265 订单或 Shop4 增加特殊补丁。
- 将现有独立 cron 原样复制到 VPS。
- 同时启用 Cloudflare 和 VPS 作为“冗余”生产 scheduler。
- 以 `updated_at`、HTTP 200、cron green 或聚合 `processed` 作为订单完整性证明。
- 在没有 intent/readback 的情况下自动重试高风险外部写。

## 16. 待评审决策

以下事项必须在实施前明确：

1. VPS 单主 orchestrator 的可接受恢复时间，以及是否需要第二台 standby executor。
2. run ledger/outbox/status evidence 的最终 schema 与 RLS。
3. 各平台状态 freshness SLA、API rate limit 和 batch 上限。
4. Giga、Mercari、Rakuten 对 idempotency 和查询已提交结果的正式能力。
5. payment reminder 的业务审批、发送时间和 ambiguous-send 人工处理流程。
6. 每个 migration phase 的 canary 店铺/订单范围和批准人。
