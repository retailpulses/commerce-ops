# Ticket Portal 发送失败：`sent_messages` schema drift 根因与修复计划

- 状态：Historical incident diagnosis；实施状态与目标架构已由 `docs/trd/platform-aware-message-boundaries.md` 取代
- 日期：2026-09-08（JST）
- 领域/事实所有者：`ticketing` / `retailpulses/ticket-handling`
- 影响：Mercari Ticket Portal 的操作员回复目前无法越过本地 outbox claim；本次已见失败未调用 Mercari 外发 API

> 本文保留 2026-09-08 的故障证据与当时诊断。后续实现已推进，本文中的路线示意、阶段状态和 Amazon outbound 描述不得作为当前实现依据；当前唯一 canonical contract 是 `docs/trd/platform-aware-message-boundaries.md`。

## 1. 事件定义与证据

在 `https://ops.homesbliss.net/tickets/ef7db370-536e-42b8-89e7-ebbaa0228db0`，操作员确认向 Mercari 发送回复时，页面显示：

> Failed to claim sent message: Could not find the `reviewed_customer_message_at` column of `sent_messages` in the schema cache

该错误发生在 `MessageSendService.sendReply()` 的第一步，即先写入 `sent_messages` 的 durable claim；它发生在获取 Mercari thread、freshness 校验和 `sendReply` GraphQL mutation 之前。因此：

- 本次失败不能视为 Mercari API、令牌或买家线程问题；
- 本次操作没有成功创建 `sending` outbox row，也不应产生平台回复；
- 不能为了恢复可用性删除幂等 claim、freshness 检查或双写审计。

截图是当前托管 PostgREST schema cache 缺列的运行时证据。本文未执行生产数据库查询、写入或外部消息发送；实际 Worker release SHA、migration ledger、`information_schema` 和同一服务身份的 PostgREST column probe 仍需在上线门禁中权威读回。

## 2. 根因

Amazon Zoho mail 功能在 migration `20260907160000_amazon_zoho_mail_pipeline.sql` 中为 `public.sent_messages` 新增 `source_inbound_message_id`、`reviewed_customer_message_id`、`reviewed_customer_message_at` 等列。与此同时，通用 `SupabaseCopywritingRepository.claimSentMessage()` 改为对每个平台的 claim 都序列化前三个 Amazon 字段，并以 `null` 作为缺省值。

PostgREST 不会忽略 insert payload 中的未知列，即使其值为 `null`。因此，当前已确认的 canonical root cause 是 **Worker 与 PostgREST 暴露 schema 之间的 contract drift**，导致 Mercari 在预外发 claim 阶段失败。缺列的底层原因可能是 migration 未执行、执行失败、只部分生效或 schema cache 未刷新；在完成生产 readback 前不得把其中任一项写成已确认事实。

造成 drift 的发布控制缺口是：该 additive schema 是 Amazon 专用能力的前提，但共享的 Mercari write path 被修改为依赖它；现有部署文档所述 migration preflight 只承认旧 pending migration，未将此 migration 的安装验证与会调用该字段的 Worker artifact 绑定为同一 gate。

## 3. Required target architecture: platform-aware, isolated send routes

`platform` is a safety boundary, not merely a request parameter. A send must be dispatched once, server-side, to exactly one platform route. Mercari, Rakuten R-Messe, and Amazon Zoho mail have different provider identity, freshness, mutation, readback, retry, and evidence contracts; they must not share a platform-specific request payload, RPC, schema assumption, feature flag, or rollout gate.

```text
Portal confirm (platform + one operation UUID)
  -> authenticated route selector (allow-listed platform)
     -> MercariSendRoute  -> Mercari outbox contract -> Mercari GraphQL + readback
     -> RakutenSendRoute  -> Rakuten outbox contract -> RMS relay + readback
     -> AmazonSendRoute   -> allow-listed SP-API action-specific adapter
                           -> otherwise fail closed + manual Seller Central fallback

Only platform-neutral result:
  operation UUID, ticket ID, platform, final body, reply intent,
  generic delivery state, platform message ID, timestamps, operator audit
```

The current code already has separate `MessageSendService` (Mercari), `RakutenRmesseSendService`, and Amazon service paths, but Mercari and Rakuten still share `CopywritingRepository.claimSentMessage()`. That shared persistence method is the coupling point which allowed an Amazon column change to break Mercari. The durable design is therefore:

- give each route its own typed claim/replay/preflight/release/ambiguous/finalize repository contract; no platform-specific optional fields in a generic send DTO;
- retain `sent_messages` only for the platform-neutral audit/outbox fields, or make each platform's durable context a separate one-to-one table/RPC owned by that platform;
- keep Amazon reviewed evidence, revision, lease and provider-mutation fields in Amazon-only persistence/RPCs; do not add them to Mercari/Rakuten serialization;
- keep provider client, retry/reconciliation logic, feature flag, migration verifier, tests and canary per route;
- a platform route may use shared primitives (operation-ID validation, immutable body comparison, audit result type) only when those primitives have no platform-specific columns or provider behavior.

Each platform deployment must prove its own contract independently. A Mercari release must not require Amazon migration installation or Amazon configuration; likewise a Rakuten relay change must not modify Mercari/Amazon payloads or gates. 共享 Worker artifact 只允许作为迁移期 containment，不满足最终隔离；Portal router 必须是薄 facade，三平台 provider adapter 与 scheduler 分别使用独立 Worker/release artifact、service binding、资源预算、health、version 和 rollback。

Amazon generic reply 必须在 token/outbox/provider mutation 之前返回稳定 `PLATFORM_SEND_UNSUPPORTED`（或更具体的稳定 capability code）。只有后端根据 authoritative ticket/context 选择且 allow-list 明确允许的 SP-API action-specific operation 才能进入 Amazon send adapter；Zoho 仅用于 ingestion，legacy Zoho outbound 保持 disabled。人工 Seller Central fallback 只提供操作路径，不创建 send claim 或伪造 provider mutation/readback。

## 4. Current Mercari contract and invariants

```text
Portal confirm
  -> Worker authenticated send endpoint
  -> sent_messages claim (idempotency boundary)   [当前失败点]
  -> Mercari thread read + freshness check
  -> persist pre-send baseline
  -> Mercari mutation
  -> atomic finalize: sent_messages + ticket_messages + ticket state/event
```

必须保留：

- `client_operation_id` 的单次 claim/replay 语义，禁止以盲目重试替代；
- Mercari 外发前的 thread freshness 和 pre-send baseline；
- 外发后原子完成审计、`ticket_messages` 与 terminal `needs_reply` 语义；
- Amazon 的 reviewed-customer evidence、lease 与专用 RPC 语义；
- 所有生产 schema 写入、Worker 部署和实际 canary 仍需明确人工批准。

非目标：不修改历史 `sent_messages`、不重放本次失败操作、不绕过 PostgREST schema cache、不启用 Amazon outbound，也不在未经批准的情况下发送 Mercari 测试消息。

## 5. 修复方案

### Phase A — Immediate containment: restore Mercari without Amazon dependency

1. Split the entire persistence lifecycle before changing behaviour: `MercariOutboxRepository` and `RakutenOutboxRepository` own claim, replay lookup, preflight, release, ambiguous marking and finalize using only their declared columns/RPCs; `AmazonOutboxRepository` owns reviewed-source, revision, lease and provider-mutation evidence.
2. As the smallest safe hotfix, make every Mercari/Rakuten query and payload contain no Amazon-only fields—not even `null`. This includes `provider_mutation_started_at` currently referenced by preflight/release logic. A claim-only fix is insufficient: it would merely move the failure later and could leave a `sending` row whose safe release failed.
3. Keep Amazon send exclusively on `claim_amazon_mail_send` and its Amazon finalize/fencing RPCs. Do not call the generic claim method from Amazon.
4. Add one repository contract test per platform, using a schema mock that contains only that platform's declared objects. Mercari/Rakuten tests must exercise the full local lifecycle through provider-mutation boundary and fail if any Amazon column/RPC appears; the Amazon test must fail if required reviewed evidence is omitted.
5. 以最小、独立 PR 发布该兼容补丁。部署前执行 Worker tests、typecheck/build 和 dry-run；部署后以只读方式确认健康端点和实际 Worker release SHA。

这一步是向后兼容止血：即使 Amazon migration 尚未安装，也只恢复原本不依赖该 schema 的 Mercari/Rakuten 路径；它不替代 Amazon migration，且不改变任一平台的 provider mutation semantics。

### Phase B — Durable route isolation

1. Create an explicit per-platform send-contract module and test suite. The route selector must reject an unsupported platform before any outbox write; each route must own its provider client and error mapping.
2. Separate Amazon-only durable context from the generic Mercari/Rakuten outbox. If the pending Amazon migration has not been installed anywhere, revise the unreleased implementation before first installation; if it has been installed in any environment, add a forward-only migration and compatibility read path—never rewrite history or delete audit rows.
3. Define a migration verifier per platform. A verifier may inspect shared neutral `sent_messages` fields, but it must not make Mercari/Rakuten availability depend on Amazon-only objects.
4. Add change ownership rules: any PR changing a platform's send route, provider contract, or schema must run that platform's test/canary matrix plus cross-platform non-regression tests; it may not modify another route's request payload without an explicitly reviewed cross-platform contract change.

### Phase C — Complete and verify Amazon schema (controlled hosted change)

1. **阻断当前 `20260907160000_amazon_zoho_mail_pipeline.sql` 直接上线。** 它改变了 Mercari-owned shared queue constraint，但当前 Mercari insert 不满足新契约；在 isolation 修复完成前不得执行，也不得以手工补列或刷新 schema cache 代替。
2. 先权威读回该 migration 是否已在任何环境安装、是否完整，以及 PostgREST 是否暴露相同 contract。若所有环境均未安装，在首次发布前修订未上线实现及 migration source；若任一环境已安装，则保留 ledger/history，新增 forward-only compatibility/isolation migration。
3. 更新部署 gate，使含有 Amazon Worker 代码的 release 必须验证 Amazon migration 的全部对象及 Mercari/Rakuten non-regression contract，而不是只检查 migration 文件存在。验证至少包含新增 objects、Amazon RPC signatures、revision trigger、migration marker，以及一条 rollback transaction 内的 Mercari insert fixture。
4. 执行前取得明确 hosted-write 批准、精确 release SHA 绑定、备份/PITR readback 和 migration ledger readback。现有 `SUPABASE_MIGRATION_APPROVED_SHA` 机制应拒绝任何 SHA 不匹配的执行。
5. 在批准的 staging/共享环境按单一 installer 或 CI migration path 执行 migration，随后以同一受限服务身份读回所有验证项；失败则停止，不部署依赖该 schema 的 Worker。
6. 只有验证通过后，才部署包含 Amazon feature 的 Worker；保持 `AMAZON_MAIL_INGESTION_MODE=off`、`AMAZON_MAIL_ATTACHMENTS_ENABLED=false`、`AMAZON_MAIL_OUTBOUND_ENABLED=false`，三项各自按独立 gate/canary 推进。

### Phase D — Deployment gates that prevent recurrence

1. CI runs a three-platform matrix: each route against its declared schema, plus a legacy/shared-schema compatibility fixture that proves one route does not serialize another route's fields.
2. Deploy workflow requires the affected platform's migration verifier before activating that platform's changed capability; merged source is never evidence of hosted schema installation.
3. Worker health exposes only aggregate per-platform capability status (no customer content or secrets). If Amazon schema is unavailable, Amazon fails closed while a verified Mercari/Rakuten route stays available; equivalent isolation applies to every platform.
4. Store migration installer and readback results as release artifacts, including release SHA, migration hash, executor, time and PII-free verification result.

## 6. 验收与上线顺序

| Gate | 验收条件 | 允许的动作 |
|---|---|---|
| A1 | Mercari 与 Rakuten 的 claim/replay/preflight/release/ambiguous/finalize 均不引用 Amazon 字段/RPC；三条 route 各自的幂等、freshness、ambiguous-recovery tests 通过 | 代码 PR |
| A2 | 已部署补丁的 Worker SHA 与待验 artifact 匹配；以同一 service identity 执行只读 PostgREST column/function capability probe，不调用 send endpoint | 只读 schema/API 验证；不创建 claim、不发送 |
| B1 | 每个平台的 route/repository/schema ownership 已隔离，并有另一平台字段不可出现的负向测试 | 合并 durable isolation PR |
| C1 | 明确 hosted-write 批准、备份/PITR、ledger 和 SHA 都已 readback | 批准后 Amazon migration |
| C2 | Amazon verifier 对 columns、constraints、indexes、triggers、RPCs 全部 readback 为 installed | 部署 Amazon capability |
| D1 | Mercari 经过单独批准的一个最小 canary：平台 readback、`sent_messages`、`ticket_messages`、事件与 `needs_reply` 结果一致 | 一个外发 canary |
| D2 | Amazon outbound 仍为关闭，直至单独的已批准 canary | 不执行 Amazon send |

若 A2 仍失败，保留请求 ID、Worker release SHA 和完整（脱敏）PostgREST error，再检查是否有另一处 claim serializer 或 Cloudflare 路由指向旧 artifact。不得通过反复点击 Confirm Send 重试；每次操作 UUID 可能有幂等/ambiguous 含义。

## 7. 回滚

- Phase A：回滚 Worker 到前一已验证 release；不删除 `sent_messages` 或 ticket history。
- Phase B：优先关闭 Amazon 功能开关并回滚 Worker。该 migration 是 additive 且可能已有引用数据，不执行 destructive schema rollback；保留数据和审计，另行设计前向修复。
- 对任何 `sending`/`ambiguous` row，按既有 reconciliation 处理；禁止删除以“解锁”重试。

## 8. 实施边界与参考

- 当前共享 claim（待拆分）owner：`web/worker/src/repositories/supabaseCopywritingRepository.ts`
- Mercari orchestration owner：`web/worker/src/services/messageSendService.ts`
- Rakuten orchestration owner：`web/worker/src/services/rakutenRmesseSendService.ts`
- Amazon schema/RPC owner：`supabase/migrations/20260907160000_amazon_zoho_mail_pipeline.sql`
- Amazon canonical feature plan：`docs/plans/issue-235-amazon-mail-canonical-plan.md`
- Hosted change governance：`docs/16_DATABASE_GOVERNANCE.md` 与 `docs/16_DATABASE_GOVERNANCE.local.md`
- Canonical implementation TRD：`docs/trd/platform-aware-message-boundaries.md`

## 9. Ingestion platform-isolation review

### 结论

当前 ingestion 是“入口与主要 service 已平台化，但 persistence、scheduler 和发布边界尚未完全独立”。建议实施与 send route 相同的隔离原则，且在 Amazon migration 上线前完成最小阻断修复。

| 平台 | 已有独立边界 | 仍存在的耦合/风险 | 结论 |
|---|---|---|---|
| Mercari | 专用 webhook route、签名/字段校验、Mercari enrichment、幂等键与外部转发 | 与 Amazon 共享 `inbound_ticket_messages`；generic retry claim 未过滤 source；Amazon migration 重写其 constraint | 未完全独立 |
| Rakuten | 专用 RMS relay client、`rakuten_rmesse_inquiries`、`rakuten_rmesse_sync_state`、ingest RPC、mode/cursor/reconciliation | 与其他平台共用同一 cron invocation、Worker artifact、核心 `tickets/ticket_messages` migration/release gate | 数据路径基本独立，运行发布仍耦合 |
| Amazon | 专用 Zoho client、`amazon_mail_sync_state`、ingest/attachment RPC、三个独立 kill switches | 复用并改变 Mercari queue table；migration 和 Worker 发布可影响 Mercari；与 Rakuten/Mercari 共用 cron 资源 | 未完全独立，当前保持 off 是正确状态 |

### Confirmed cross-platform defects

1. **Amazon migration can break Mercari ingestion.** Migration adds `source_received_at` and replaces the shared source CHECK so every `source='mercari_webhook'` row must have `source_received_at IS NOT NULL`. Current Mercari webhook insert writes `webhook_received_at` but does not write `source_received_at`; the migration only backfills historical rows. After installation, new Mercari inserts would fail the constraint.
2. **Mercari retry claim is not source-scoped.** `claim_pending_inbound_messages()` claims every `pending|failed` row from `inbound_ticket_messages`. `processStuckInboundMessages()` sends each claimed row to Mercari enrichment. The enrichment has a defensive source guard but then marks a claimed non-Mercari row failed, so an eligible non-Mercari row could be mutated and consume Mercari retry capacity. Normal Amazon ingest currently writes `processing_status='completed'`, so this is a confirmed isolation defect, not evidence that production Amazon rows have already been corrupted.
3. **Cron failure is caught, but resource isolation is absent.** Amazon, Rakuten and Mercari scheduled paths execute sequentially in one Worker invocation. Separate `try/catch` blocks prevent a normal thrown error from aborting later code, but provider latency, invocation limits or resource exhaustion in one platform can still delay/starve another. The nominal two-minute Rakuten trigger also executes Amazon first whenever Amazon is enabled.
4. **Deployment blast radius remains shared.** One Worker artifact and broad `supabase db push --include-all` gate can combine unrelated platform migrations. The workflow applies migration before deploying the compatible Worker, while staging and production share one Supabase project, so an incompatible schema can affect live traffic during the rollout window. Existing tests cover individual behaviour but do not prove that an Amazon-only schema/code change leaves Mercari and Rakuten ingestion operational.

### Required ingestion changes

#### I1 — Release blocker before Amazon activation

1. Do not install the current Amazon migration until the hosted ledger is read back and the Mercari compatibility defect is fixed.
2. For the immediate compatible migration, remove the Mercari CHECK arm's new `source_received_at IS NOT NULL` requirement and preserve the existing Mercari write contract. If `source_received_at` is later approved as a platform-neutral required field, use a three-release expansion: add nullable/backfill support, deploy a dual-schema-compatible Mercari writer and retire all old Workers, then add the shared constraint in a separately reviewed core migration. Do not make this contract change inside an Amazon-only migration.
3. Replace `claim_pending_inbound_messages()` with a Mercari-named/source-scoped claim such as `claim_pending_mercari_webhook_messages`, including `WHERE source='mercari_webhook'`. The repository and retry worker must reject any returned non-Mercari row without mutating it.
4. Add a transaction-scoped SQL test that applies the proposed migration and executes one representative ingestion transaction per platform (Mercari queue insert, Rakuten ingest RPC and Amazon ingest RPC), then rolls back. This test is a release gate, not a post-deploy smoke substitute.

#### I2 — Durable persistence isolation

1. Define an immutable platform-neutral inbound envelope: `id`, `platform/source`, native identity, received time, processing state, linked ticket, created/updated timestamps. Provider-specific metadata and lifecycle fields belong in one-to-one platform tables or platform-specific RPC-owned records.
2. Mercari owns webhook payload, shop/order transaction identity, enrichment/retry and OrderMgmt forwarding. Amazon owns Zoho account/folder/message identity, authentication, checkpoint, attachment processing and trust state. Rakuten retains its inquiry and sync-state tables/RPC.
3. No platform migration may drop/recreate another platform's CHECK constraint or relax another platform's required fields. Shared envelope migrations require all-platform owners/tests and an explicit cross-platform change classification.
4. Queue projection may unify the three sources through a stable read-only view/API DTO. It must not make write contracts generic or use `select('*')` as a cross-platform schema contract.

#### I3 — Runtime and release isolation

1. Give each platform a separate scheduled entrypoint/queue or separately deployable Worker. If infrastructure consolidation is retained, dispatch independent bounded jobs with explicit per-platform timeout/budget and durable continuation; a platform timeout must not consume another platform's scheduled opportunity.
2. Keep independent kill switches and health capability: `mercari_ingestion`, `rakuten_ingestion`, `amazon_ingestion`. One red capability must not turn the whole ingestion service green or red without per-platform detail.
3. Run a platform matrix in CI: platform fixture + its migration/RPC + negative assertions that other-platform columns, RPCs and provider calls are absent. Also run a shared-core compatibility suite whenever `tickets`, `ticket_messages`, queue views or common envelope objects change.
4. Deploy and canary one platform at a time. Activation evidence must include exact release SHA, platform migration verifier, source-specific metrics, idempotent replay and authoritative provider/database readback.

### Ingestion acceptance criteria

- Enabling/disabling or breaking Amazon ingestion does not change Mercari webhook acceptance/retry or Rakuten polling.
- A Mercari retry claim can never claim or mutate Amazon/Rakuten evidence; equivalent source isolation applies to every worker.
- Installing a platform-specific migration leaves representative ingest transactions for the other two platforms successful.
- One provider timeout/exhausted page budget does not prevent the other platforms' scheduled checkpoints from advancing.
- Duplicate/replay keys are platform-namespaced and cannot collide across providers.
- Queue/API can display all platforms while each write path remains separately typed and owned.

## 10. 变更日志

- 2026-09-08 v1.0：根据 Ticket Portal 运行时错误、当前 source/migration 合约和部署文档完成根因与修复计划；未进行生产写入、部署或消息发送。
- 2026-09-08 v1.1：将修复目标提升为严格的平台 aware route isolation；Mercari、Rakuten 和 Amazon 不得再通过共享 platform-specific outbox payload、schema 依赖或 rollout gate 相互影响。
- 2026-09-08 v1.2：完成 ingestion isolation review；确认 Amazon migration 会使当前 Mercari webhook insert 违反新 CHECK、Mercari retry claim 缺少 source filter、三平台 cron 共享资源，并将 ingestion 隔离列为 Amazon activation 前置工作。
- 2026-09-08 v1.3：根据独立复核补齐完整 send lifecycle 隔离；将根因收敛为 Worker/PostgREST contract drift；明确当前 Amazon migration 必须保留既有 Mercari `source_received_at` 契约，并区分已确认隔离缺陷与尚未证实的生产数据影响。
- 2026-09-08 v1.4：链接 canonical platform-isolation TRD；incident plan 保留诊断和修复门禁，具体实施契约以 TRD 为准。
- 2026-09-08 v1.5：纳入 Codex-B 审查结论；当前 WP1/WP2 代码不得进入 PR，直至 deploy migration allow-list、新 RPC capability failure、SQL platform predicate、三平台完整 lifecycle 测试四项 P0/P1 缺口关闭。
