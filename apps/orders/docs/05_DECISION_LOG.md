# Decision Log

## 2026-09-10 — Repair Mercari close completion against canonical tracking columns

- A production canary reached Mercari `COMPLETED`, then the local atomic
  completion RPC failed because it referenced the legacy
  `sales_orders.shipping_tracking_info` column, which is not part of the
  canonical Supabase schema.
- Keep the existing RPC signature, advisory lock, scoped CAS and all-line
  completion semantics, but persist tracking only through canonical
  `tracking_carrier` and `tracking_number` columns.
- Apply the corrective migration before reconciling the completed canary or
  processing the remaining close candidates. Never resend the already accepted
  marketplace mutation.

## 2026-09-07 — Start the governed seven-day shadow window

- Host and read back the eight Issue #265 control-plane migrations.
- Install immutable release `37b1e7513b978298949b9cc5249bac0eb82ae603`
  and accept run `run_1788788321770_t5jic55j` with 17/17 steps, released lease,
  and all external/business writes skipped.
- Enable only the hourly shadow timer. Cloudflare keeps every production
  business capability; all VPS live flags remain false until later gates.

## 2026-09-07 — Carry same-run lifecycle evidence to shadow consumers

- Shadow must not publish a production freshness watermark merely to let a
  downstream dry-run execute.
- Payment-reminder shadow may consume only an in-memory Mercari
  `accounting_complete` proof from the same shadow `run_id` and dependency DAG.
- Live execution ignores this path and continues to require authoritative,
  current Supabase lifecycle watermarks.

## 2026-09-07 — Treat a non-truncating shadow cap as complete accounting

- A configured safety limit is bounded only when the discovered candidate set
  exceeds it; a limit larger than the full set does not make evidence partial.
- Shadow lifecycle reads may report `accounting_complete` without publishing a
  production freshness watermark or applying planned status changes.
- Provider failures and true truncation remain partial and fail the shadow run.

## 2026-09-07 — Resolve the systemd entrypoint through the immutable symlink

- Determine direct CLI execution by comparing real paths, not the literal
  `current` symlink path against the resolved ESM `import.meta.url`.
- A successful oneshot with no durable run row is not a successful shadow run;
  acceptance requires the Supabase run/step ledger and release readback.

## 2026-09-07 — Make immutable releases traversable by the service identity

- Immutable release content remains root-owned and non-writable by the runtime.
- Grant `rp-ordermgmt` group read access and directory traversal so the hardened
  non-root unit can enter its working directory and load Node modules.
- The disabled installer must verify both access properties as the service user
  before reporting success; timer and live capability gates remain disabled.

## 2026-09-07 — Promote VPS orchestration target into canonical architecture

- `docs/01_ARCHITECTURE.md` remains the architecture SSOT; Issue #265 strategy and implementation facts must be reflected there rather than living only in a TRD.
- Keep Cloudflare as the verified current business scheduler until governed per-capability transfer; this is current-state evidence, not the preferred target.
- Adopt one VPS-started canonical orchestrator with Supabase durable control plane, exact canaries, freshness and external-operation gates, and explicit single-owner CAS.
- Require `disabled` quiescence between owners and seven complete JST days of shadow parity before retirement. Reporting remains independently owned and ledger-gated.
- Treat branch implementation, deployed assets, runtime activation, canary evidence, and completed cutover as distinct states.

## 2026-09-07 — Bind report delivery identity to the current scheduled slot

- Permit live delivery only during 08/11/14/17/20/22 JST.
- An explicit slot is an assertion of the current hour, not authority to
  backdate, predate or create an off-schedule delivery.
- Recovery of an old ambiguous slot remains an evidence-resolution action; it
  must not send current report data under an old identity.

## 2026-09-07 — Require provider evidence for definitive report failure

- A parsed non-zero WeCom `errcode` is authoritative rejection evidence.
- HTTP 5xx, missing/malformed JSON and transport exceptions are ambiguous and
  finalize as `UNKNOWN_RESULT`, never `DEFINITIVE_FAILURE`.
- Both states block automatic resend; operator resolution requires external
  evidence rather than inference from HTTP status alone.

## 2026-09-07 — Disable automatic service retry for report delivery

- Remove `Restart=on-failure` from the sales-brief oneshot service.
- Let the durable delivery intent decide whether a later timer/manual run may
  proceed; `UNKNOWN_RESULT` must be reconciled rather than process-retried.
- Add a unit-file test rejecting `on-failure`, `always`, or a restart interval.

## 2026-09-07 — Classify WeCom reporting as an external write

- Keep report aggregation read-only, but classify the complete workload as
  `external_write`/Medium because WeCom delivery changes external state.
- Prove lifecycle freshness passes before the delivery-intent claim, not only
  before the final HTTP request.
- Track production report canary/readback as its own strategy-completion gate.

## 2026-09-07 — Make sales-brief delivery intent-first

- Treat WeCom delivery as an external effect, not a naturally idempotent
  read-only report.
- Claim one stable JST slot in the shared external-operation ledger before
  sending; confirmed slots skip and all ambiguous/unresolved states block.
- Finalize transport ambiguity as `UNKNOWN_RESULT` and explicit provider
  rejection as `DEFINITIVE_FAILURE`; never retry either by age.
- Keep dry-run ledger-free and require freshness before order reads or intent.

## 2026-09-07 — Remove root from the sales-brief runtime target

- Run both canonical VPS services as `rp-ordermgmt`, with the sales brief using
  the immutable release and a protected environment under `/etc/ordermgmt`.
- Apply `NoNewPrivileges`, private temp, strict filesystem protection and a
  restrictive umask to the reporting service.
- Mark the old Issue #178 mutable-checkout/root/enable-now procedure historical;
  production remains unchanged until governed deployment and readback.

## 2026-09-07 — Audit the complete strategic canonical-document set

- Expand readiness beyond entrypoint docs to the deployment, database,
  workload-governance, operations, relay and status-reconciliation documents
  named by Phase 5.
- Require target-versus-deployed language at current-state entrypoints while
  treating policy/runbook documents as required existence evidence.
- A final production consistency audit and dated readback remain external
  completion gates.

## 2026-09-07 — Reject stale Rakuten-close DAG descriptions

- Canonical inventory must say Rakuten close is represented after tracking in
  the target DAG with a dedicated default-off flag.
- DAG/control-plane coverage does not constitute RMS contract acceptance or
  authorization to schedule the external write.
- Add the superseded outside-the-DAG sentence to the contradiction test.

## 2026-09-07 — Prove canonical live limits beyond legacy queue caps

- Exercise 61 eligible candidates through the auto-approval selector and the
  Rakuten confirmation dry-run path.
- Require canonical live `limit=null` to retain all 61 while positive canary
  limits and missing manual limits remain bounded.
- Keep provider pagination and production-scale acceptance as separate gates;
  an in-memory fixture does not prove external API behavior.

## 2026-09-07 — Separate repository readiness from strategy completion

- Add one executable, structured audit for the 17 exact-canary contracts,
  required migrations, canonical systemd/verification assets and canonical docs.
- Repository artifacts may prove `local_implementation_ready`; they can never
  prove hosted migration, deployment, parity, provider canary, ownership
  transfer, cutover or retirement evidence.
- Keep `strategy_complete=false` until those gates have authoritative external
  readback, preventing a green static check from being reported as production
  completion.

## 2026-09-07 — Test #265 gates at consumer boundaries

- Inject partial lifecycle evidence into the real fulfillment execution wrapper
  and prove the phase runner is never invoked.
- Inject the same evidence into payment reminders and prove candidate loading,
  ambiguous reservation reconciliation, Marketplace reads and sends remain at
  zero.
- Pure freshness evaluation is insufficient acceptance; each consequential
  consumer must prove the gate precedes its first side effect.

## 2026-09-07 — Prove #265 reporting fails before data consumption

- Model the sales brief as a structured runner so freshness, order-read and
  delivery boundaries are independently observable and testable.
- On missing/stale/partial freshness, return `blocked_by_freshness` before any
  order query, aggregation or WeCom call; do not generate a plausible report
  from stale canonical rows.
- Keep dry-run delivery-free and move required-env validation from import time
  to the actual runtime operation.

## 2026-09-07 — Test canonical docs for superseded architecture claims

- Canonical documents must update in the same tranche as capability behavior,
  but additive history can still leave contradictory current-state sentences.
- Run a repository test that rejects known superseded scheduler/canary claims
  and requires target-versus-deployed boundaries at canonical entrypoints.
- The test detects repository drift only; runtime truth still requires direct
  production readback and dated evidence.

## 2026-09-07 — Make Mercari discovery exact at the ingestion source

- Query one `orderTransaction(id)` with the complete normal-ingestion field
  projection instead of fetching a list and selecting its first row.
- Require one shop, scope existing-row reads to shop/order, verify provider
  identity, and suppress the unrelated terminal-status sweep before reusing
  the canonical multi-line writer and stale-line cleanup.
- All DAG capabilities now have exact canary contracts in code. This does not
  replace fixed-IPv4 provider-contract canaries or authorize production writes.

## 2026-09-07 — Use RMS getOrder for exact Rakuten discovery

- Exact Rakuten discovery bypasses search-order queue position and calls the
  existing bounded `getOrder` contract with one order number.
- Verify the provider response contains exactly that identity before passing
  the full order to the shared ingestion writer; zero or ambiguous matches
  fail closed.
- Mercari discovery requires a separately verified direct transaction lookup
  with the complete ingestion field contract.

## 2026-09-07 — Separate scoped integrity evidence by platform

- Require `platform + order_id`, plus shop for Mercari, for an integrity-audit
  canary; Rakuten rejects Mercari shop scope.
- Apply channel/store/order filters to both canonical sales and shipment reads,
  retain defensive filtering, and never scan or repair the other platform.
- Scoped success is `scoped_complete`, never global accounting completion; a
  target absent from both tables fails closed.

## 2026-09-07 — Scope every message/reminder side branch in canaries

- Message-ingestion canaries filter by exact shop/order before marketplace
  reads and fact persistence, then skip the global stuck-webhook retry path.
- Payment-reminder canaries use only the target shop's lifecycle watermark and
  scope both candidate selection and ambiguous-reservation reconciliation to
  the same shop/order before stock checks or sends.
- A scoped target that is absent or ineligible fails closed; a zero-work result
  cannot serve as successful canary evidence.

## 2026-09-07 — Scope Mercari auto-approval before eligibility work

- Select an auto-approval canary by exact Mercari shop and normalized order ID
  before limiting, product resolution, rule evaluation, approval or messaging.
- Missing targets and non-single-shop exact requests fail closed; queue-head
  neighbors cannot consume the canary bound.
- Exact scope does not bypass working-hours, lifecycle freshness, buyer-message,
  idempotency, multi-line or notification-safety gates.

## 2026-09-07 — Open only exact, single-capability live canaries

- A canonical live canary requires explicit `--live`, one supported capability,
  one exact order, `--limit 1`, and an exact Mercari shop where applicable.
- Unsupported discovery
  scopes fail closed instead of degrading to the first queue item.
- A canary executes no upstream or neighboring DAG unit. It still requires the
  selected capability flag, exact durable VPS ownership and the phase's
  persisted freshness gate; dependency work must be proven beforehand.
- This adds a branch-only control path. It neither authorizes a provider write
  nor proves a marketplace contract, deployment, cutover or canary result.

## 2026-09-07 — Keep scoped lifecycle canaries out of global freshness

- Filter exact normalized order identity before provider batching, limits and
  CAS mutation for both Mercari and Rakuten.
- A successful exact-order reconciliation is `scoped_complete`, not
  `accounting_complete`, and cannot update the global lifecycle watermark.
- If the requested order is not a local non-terminal candidate, fail before
  provider access rather than reporting a zero-work success.

## 2026-09-07 — Scope and globally bound tracking before provider reads

- Apply channel/shop/exact-order scope before building the Giga order map and
  before any provider request.
- Apply `limit` once to the full candidate list, then chunk the selected set by
  the provider batch size. The former per-batch slicing could process more than
  the requested bound.
- Return candidate, selected and exact-filter evidence for canary readback.

## 2026-09-07 — Apply Rakuten canary scope before queue mutation

- Exact-order scope is normalized and applied before confirmation stuck-lock
  reset/claim and before projection limiting/mutation.
- A neighboring queue-head order cannot consume the canary limit or be changed.
- This adds phase-level scope support but does not yet authorize or expose a
  live orchestrator canary command.

## 2026-09-07 — Prove workload quiescence before VPS acquisition

- Waiting a nominal interval is insufficient; query both recent workload phase
  audits and all unterminated matching audits.
- Require aged/unexpired disabled ownership, no dispatch after disable, no
  active orchestrator lease, no open external operation, and an accepted shadow
  run for the exact target release/host.
- Use the conservative global open-operation gate until every operation type
  has an authoritative workload mapping; unrelated ambiguity may block cutover
  but cannot be silently ignored.

## 2026-09-07 — Require disabled quiescence before VPS ownership

- An atomic owner-row change blocks future Worker dispatch but does not prove an
  already-started legacy execution has drained.
- Every first cutover must transition `cloudflare_worker`/absent → `disabled`,
  wait the reviewed drain interval and reconcile open operations, then move
  `disabled` → `vps_order_orchestrator`.
- Both JavaScript validation and the service-role RPC reject direct transfer.
  VPS-to-VPS renewal remains allowed with fresh disable evidence.

## 2026-09-07 — Verify a manual shadow run from authoritative records

- Do not accept systemd exit status or journal text as business-run proof.
- Bind the run to exact release and owner host, require one terminal successful
  shadow run and every canonical DAG step in sequence.
- Require all external-write units to be `SKIPPED` with explicit skip evidence,
  the run lease to be absent, and no same-run `pipeline_run_log` row because
  dry-run audit must be log-only.

## 2026-09-07 — Revalidate immutable release identity on every start

- Installation-time SHA checks are insufficient because the `current` pointer
  or protected environment can drift afterward.
- The systemd runtime requires immutable enforcement; orchestrator startup
  resolves the loaded source release and `current` symlink and matches both to
  the exact 40-character `RELEASE_VERSION`.
- Any mismatch fails before lease acquisition, durable run creation or workload
  execution. Tests may omit enforcement outside the production unit contract.

## 2026-09-07 — Compare shadow and production evidence without auto-approval

- Join only by phase and aggregate numeric count fields; never emit per-order
  results or customer/provider payloads.
- Report totals and per-run averages because current cron cadences differ from
  the hourly shadow orchestrator. Missing sides, missing common metrics or any
  failed run prevent comparison readiness.
- Keep `parity_proven=false` regardless of numeric similarity: capability-level
  meaning and every material difference still require reviewed explanation.

## 2026-09-07 — Make the seven-day shadow window machine-checkable

- Audit complete JST days only, require a configurable minimum cadence (20/day
  by default), successful terminal runs, every expected read/preview step, and
  every external-write step `SKIPPED`.
- Keep the audit read-only and fail closed on missing run/step evidence.
- A healthy window is not output parity. The report always states
  `parity_proven=false` until sanitized production-owner results are compared
  and every material difference is explained separately.

## 2026-09-07 — Install the target orchestrator as a disabled immutable release

- Give the orchestrator its own `/opt/order-mgmt-orchestrator/releases/<sha>`
  root so its pointer cannot silently move the Portal API release.
- Accept only exact commits reachable from `origin/main`; validate the protected
  environment is shadow-only and contains no template placeholders.
- Installation atomically updates the inactive release pointer, installs and
  verifies units, and reads back disabled/inactive state. Starting shadow and
  every production capability cutover remain separate approvals.

## 2026-09-07 — Keep runtime documentation aligned with transport ownership

- Describe Worker-to-relay as the current production transport and direct local
  marketplace clients as the target VPS orchestrator transport.
- Do not use “relay only” as a timeless architecture rule: it is true for the
  current Worker path, not for the accepted co-located VPS runtime.
- Keep branch-only, deployed and cut-over states explicit in repository,
  operations and deployment entrypoints.

## 2026-09-07 — Represent Rakuten close as a separately gated target capability

- Add `rakuten_close` after `rakuten_tracking` in the target DAG with workload
  ID `ordermgmt_rakuten_order_close` and a dedicated live flag.
- Default the flag false and skip this external write in shadow. The capability
  remains unscheduled and cannot run live without matching ownership evidence,
  upstream success, global live opt-in and its explicit flag.
- This closes a target-control-plane omission; it does not verify the RMS close
  contract or authorize a production canary.

## 2026-09-07 — Execute Rakuten RMS provider I/O directly on the VPS

- Inject a Node-only local RMS adapter into Rakuten discovery, exact lifecycle
  reads, confirmation and close; reuse the existing ingest, reconciliation,
  operation-ledger and exact-readback business logic.
- Force IPv4, cap exact reads and confirmations at 50 orders, bound requests to
  30 seconds and 1 MiB responses, and expose stable errors without response
  bodies or credentials.
- Keep Cloudflare Worker relay adapters until each capability ownership cutover.
  Rakuten close remains unscheduled pending authoritative RMS contract and canary
  proof; transport migration does not authorize the external write.

## 2026-09-07 — Execute payment-reminder provider I/O directly on the VPS

- Inject the same IPv4 local Mercari client into ambiguous reconciliation,
  exact pre-send status/message checks and the final reminder write.
- Preserve lifecycle freshness, durable reservation, authoritative message-ID
  readback and `UNKNOWN_RESULT` handling; transport migration does not weaken
  customer-message safety.
- Worker reminders retain relay adapters and VPS live execution still requires
  the explicit capability and ownership gates.

## 2026-09-07 — Read scheduled Mercari messages directly on the VPS

- Reuse the Node-only IPv4 Mercari client for message/status reads and inject it
  into the existing message-sync writer; do not fork message fact derivation.
- Keep webhook retry folded into the same phase. Dry-run skips retry writes;
  live preserves the bounded retry behavior.
- Worker execution continues to inject the relay reader.

## 2026-09-07 — Read Mercari lifecycle status directly on the VPS

- Inject a Node-only exact-ID status reader into the shared lifecycle
  reconciler; do not duplicate reconciliation/mapping logic.
- Force IPv4, require an explicit shop token, cap each request at 50 IDs and
  fail closed on HTTP, GraphQL, timeout, parse or response-size errors.
- Cloudflare retains the relay implementation of the same reader contract.

## 2026-09-07 — Move VPS Mercari close to direct local execution

- The VPS orchestrator starts the canonical Mercari batch-close script locally;
  that script retains the operation ledger, exact marketplace readback and
  atomic local completion rules.
- Preserve shop, limit and dry-run scope and parse failure counts even when the
  child exits non-zero; process failure cannot be reported as a completed step.
- Cloudflare Worker close keeps relay transport until ownership cutover retires
  its business trigger.

## 2026-09-07 — Move VPS Mercari discovery to direct local execution

- Keep Node process execution in the Node-only orchestrator boundary; never
  statically import `child_process` into the shared Cloudflare pipeline bundle.
- The VPS orchestrator injects a local phase runner for `pull_shop_orders`,
  preserving explicit scope and relay-compatible accounting while skipping
  relay health/HTTP.
- Cloudflare Worker execution continues through the fixed-IPv4 VPS relay.
  Remaining Marketplace phases migrate capability by capability.

## 2026-09-07 — Fail closed on ambiguous Portal order lookup

- An order ID is not a globally unique Portal mutation target.
- If lookup finds more than one channel/store scope, return
  `ambiguous_order_scope` instead of selecting the first marketplace row.
- List rows carry a separate `portal_target_id` containing encoded channel,
  source-store and business-order identity. Drawer routes propagate this target
  through detail and mutations while UI labels and marketplace links retain the
  original order ID.
- Bulk selection submits validated scoped `order_targets`; raw values are
  rejected in that field. Legacy `order_ids` remain backward-compatible and
  fail closed on collisions.

## 2026-09-07 — Scope shipment projection before order-level processing

- Group Mercari source lines by channel, source store and normalized order ID
  before price allocation, line numbering, limiting or shipment mutation.
- Same-number orders from different shops are separate projection units even
  when a multi-shop run loads them together.

## 2026-09-07 — Quarantine ambiguous cross-store tracking IDs

- Giga tracking responses identify orders only by `orderNo`; they do not carry
  the marketplace source-store identity required for a safe cross-store join.
- If one normalized order ID is present in multiple source stores, exclude it
  from the Giga request and every local write, return an explicit scope
  conflict, and fail the phase for operator reconciliation.
- For unambiguous results, update sales rows only when channel, source store and
  normalized order ID all match the shipment scope.

## 2026-09-07 — Make integrity-audit shipment joins store-scoped

- Join health-audit sales and shipment rows by
  `(sales_channel, source_store_id, normalized_order_id)`.
- Missing scope evidence fails closed as a missing projection; an order ID alone
  cannot prove that the correct store/channel has a shipment.
- Shadow parity and cutover acceptance must use this scoped backlog evidence.

## 2026-09-07 — Scope Worker stuck-order diagnostics by store

- Join diagnostic sales and shipment evidence by
  `(source_store_id, normalized_order_id)`.
- Do not let a same-number shipment from another Mercari shop overwrite or
  satisfy the target shop's stuck-order evidence.

## 2026-09-07 — Preserve scoped identity in operator health and metrics

- Count and join orders by `(sales_channel, source_store_id, normalized_order_id)`
  in the Portal control plane and commercial/order metrics.
- A same-number shipment projection in one shop must not satisfy another shop's
  projection backlog, and same-number orders across shops/channels remain
  distinct business orders in aggregate counts.
- Include channel and source-store fields in the bounded canonical queries so
  the UI cannot infer scope from order ID alone.

## 2026-09-07 — Remove false dry-run and direct Worker manual writes

- `/admin/run-once` is now a dry-run alias and rejects `confirm_write`; an
  authenticated HTTP endpoint is not sufficient authority for production
  mutations.
- Until a phase has an explicitly tested side-effect-free preview, dry-run
  fails closed before invoking its phase code. The legacy write-capable
  end-to-end wrapper remains blocked and is targeted for retirement. Mercari/Rakuten shipment
  projection now reports planned row mutations without executing them, and
  Giga outbound returns its collected preview without invoking the sync writer.
  Tracking preview performs the required Giga read but skips every shipment and
  sales-row patch while reporting planned update counts.
- Dry-run audit evidence is emitted to structured logs only. It does not write
  `pipeline_run_log`; otherwise a preview claiming zero database side effects
  would contradict its own execution path.
- Governed manual canaries must use the canonical orchestrator/capability
  ownership path with exact scope, durable intent and authoritative readback.
- This deliberately removes misleading availability: returning
  `dry_run_unsupported` is safer than executing a real mutation under a
  `dryRun=true` request.
- Message-sync preview must also suppress failure-state persistence on
  unresolvable shops, relay errors and thrown reads. Candidate identity is
  `(source_store_id, order_id)`, never order ID alone.
- Auto-approval uses that same scoped identity through grouping and every
  downstream safety/write call; marketplace order IDs are not globally unique
  across stores.

## 2026-09-07 — Retire the singular Mercari close relay path

- Remove `/admin/close-shipped-order` and `MERCARI_SHIPPING_CLOSE_SCRIPT_PATH`.
- Keep only `/admin/close-shipped-orders`, whose bounded batch routes external
  mutation through the durable close-operation ledger and authoritative
  readback contract.
- The standalone legacy script remains source history/manual diagnostic code;
  it is no longer reachable through the production relay control surface.

## 2026-09-07 — Scope cancellation reconciliation by store and order

- Use `(source_store_id, normalized_order_id)` for candidate snapshots,
  post-ingest cancellation detection and shipment invalidation.
- Never infer that a same-number order in another Mercari shop was canceled.
- This hardens the current writer while it remains live; the target architecture
  still retires the separate cancellation workload after lifecycle cutover.

## 2026-09-07 — Enforce scheduler ownership on both runtimes

- Use one canonical phase-to-workload map for the VPS DAG and Cloudflare
  scheduled handler.
- Every enabled VPS live unit must pass the exact durable owner, host, release,
  enabled-state, legacy-retirement and freshness checks before phase execution.
- Once a workload has a registry row, Cloudflare dispatches it only while that
  row explicitly names `cloudflare_worker`; transfer to the VPS or a registry
  read failure makes the Worker step down. Missing rows preserve the legacy
  Cloudflare owner only before that workload enters governed cutover.
- Require ownership evidence observed within 24 hours even when the registry
  row expires later. Reject literal deployment placeholders as runtime identity.
- Persist ownership rejection in `pipeline_steps.error_code` so Pipeline Health
  shows why the unit was blocked.
- This is branch-only safety enforcement. It does not authorize seeding the
  registry, deploying either runtime, or changing a production trigger.

## 2026-09-07 — Make the integrity audit cross-platform

- Collect Mercari and Rakuten health snapshots independently and persist a
  per-platform count object; one platform's filters or failure cannot silently
  erase the other platform from audit accounting.
- Scope sales rows by canonical `sales_channel`; apply Mercari shop IDs only to
  Mercari and use the Rakuten source identity for Rakuten.
- The audit remains read-only and diagnostic. Backlog does not authorize a
  competing repair writer, and branch tests do not replace shadow parity.

## 2026-09-07 — Make scheduler ownership an expiring evidence-backed fact

- Add one current row per workload plus an immutable event log. Ownership
  updates require compare-and-set against the expected owner, recent runtime
  evidence, actor, host, release, kill-switch state, and an expiry no more than
  eight days away.
- Claiming `vps_order_orchestrator` requires explicit evidence that the legacy
  scheduler was disabled. A code flag, target architecture, recent run, or
  transient lease is insufficient.
- Keep the operator CLI dry-run by default and require one reviewed
  `--confirm-write`; then read back both the current row and audit event.
- Grant `service_role` read-only table access and revoke direct DML; the
  SECURITY DEFINER CAS RPC is the only supported write path, preventing an
  operator client from bypassing immutable event creation.
- Do not seed the migration with assumed production state. Initial Cloudflare
  and VPS-reporting ownership rows require fresh authoritative runtime readback.

## 2026-09-07 — Make live ownership explicit per capability

- Read shadow/live mode from the systemd environment so immutable service assets
  do not hard-code shadow forever, while retaining CLI flags for controlled
  manual execution and rejecting conflicting sources.
- Require three gates for production work: `ORCHESTRATOR_MODE=live`, the global
  live-enable flag, and at least one explicit capability flag. Every committed
  capability flag defaults false; there is no whole-pipeline enable switch.
- Disabled capabilities are durable `SKIPPED` steps. An enabled descendant with
  a disabled or failed upstream is `BLOCKED`, preventing partial ownership from
  bypassing the dependency contract.
- Capability flags may be enabled only in the same governed cutover that
  disables and reads back the matching legacy trigger. Code readiness alone is
  not scheduler ownership.

## 2026-09-07 — Persist useful, non-PII step accounting

- Store each phase's completion state and allowlisted aggregate outcome counts
  in `pipeline_steps.result_counts`; a count of invoked phase functions alone
  is not business-completion evidence.
- Reuse the existing audit count extractor so per-order result arrays, customer
  data and provider payloads are not copied into control-plane rows.
- Missing phase-level accounting remains visible as an empty count object and
  must be closed before that capability's live cutover acceptance.

## 2026-09-07 — Expand the orchestrator to explicit independent workload branches

- Replace the global "any prior failure blocks everything" rule with named DAG
  dependencies. Mercari failures block only Mercari descendants, Rakuten
  failures block only Rakuten descendants, and message ingestion remains an
  independent low-priority branch.
- Give eligibility, projection, Giga outbound, tracking, and close separate
  durable steps so a failed phase cannot be hidden inside a multi-phase unit or
  allow its downstream phase to continue.
- Add payment reminders as a Mercari-lifecycle dependent workflow and a
  read-only terminal integrity audit. Write-capable units remain skipped in
  shadow; Rakuten close remains excluded pending contract/canary approval.
- This is branch implementation only. Reporting remains the separately owned
  VPS fresh-snapshot consumer and is not duplicated inside the orchestrator.

## 2026-09-07 — Use one explicit full-accounting phase-limit contract

- Reserve `null` for full live accounting and positive integers for bounded
  shadow, canary, or manual execution. Do not use `0`, because legacy phases
  interpreted it as zero work, per-batch 20, fallback 50/100, or unbounded.
- Preserve explicit `null` through the VPS relay and make auto-approval,
  Rakuten confirmation, and Rakuten projection process the complete candidate
  set in live mode. Existing safe defaults remain for omitted/invalid limits.
- This removes silent queue starvation in the target live orchestrator but does
  not authorize live execution; provider scale and completion accounting still
  require the governed rollout canaries.

## 2026-09-07 — Expose an evidence-qualified operator control plane

- Add an authenticated, read-only Portal endpoint and Pipeline Health view for
  release, scheduler ownership, lease, run/step failures, lifecycle freshness,
  external-operation attention states, and bounded workload backlog.
- Treat the accepted VPS owner as a target fact only. Current VPS production
  execution is displayed only for a matching live run with an active database
  lease; a shadow lease remains explicitly non-production. Absence of that
  evidence is `unverified`, never inferred from configuration or a recent run.
- Report the Portal host's live-enable setting as local configuration and
  explicitly state that it does not prove Cloudflare business triggers are off.
- Bound broad backlog reads and surface truncation instead of presenting partial
  counts as complete accounting. This is branch implementation, not deployment.

## 2026-09-07 — Make Mercari close a durable order-level operation

- Treat create-shipping, tracking update, and shipping completion mutations as
  one order-scoped external intent. Existing Mercari idempotency keys remain a
  provider backstop, not the canonical retry decision.
- Re-read the exact marketplace order after the mutation sequence. Only
  `COMPLETED` permits local terminal persistence; accepted `COMPLETING` remains
  verification-only and transport/partial failures become `UNKNOWN_RESULT`.
- A pre-existing `COMPLETING` order is never blindly resubmitted. A blocked or
  confirmed ledger row cannot cause another provider mutation.
- Replace per-line completion/backfill writes with one service-role RPC that
  atomically persists terminal and tracking facts for all matching order lines,
  followed by exact readback.
- Require Supabase for live close. This is branch implementation only and does
  not change the current production scheduler or runtime.

## 2026-09-07 — Make Rakuten close order-scoped and ambiguity-safe

- Deduplicate all eligible sales lines into one order-scoped close intent and
  one RMS shipping mutation; persist completion or error evidence to every line.
- Use a stable order-level operation identity so tracking-payload changes cannot
  mint a second close attempt for the same marketplace order.
- Exact RMS progress `500` is the only authoritative completion evidence. A
  relay failure followed by non-500/missing evidence becomes `UNKNOWN_RESULT`;
  an accepted but lagging submission becomes `CONFIRMED` and verification-only.
- Reconcile blocked states automatically only when an exact RMS read proves
  progress `500`; otherwise require the governed operator resolution path.
- Keep `close_rakuten_orders` out of the target schedule until the external
  contract, one-order canary, ledger rows and all local lines are read back.

## 2026-09-07 — Resolve ambiguous external operations only from evidence

- Add a service-role-only, single-operation CAS RPC and append-only resolution
  audit table; no status may be released by age, batch sweep, or transport error.
- Require exact expected status, authoritative evidence reference, written
  reason, and operator identity for every resolution.
- Map proven `APPLIED` evidence to `ALREADY_APPLIED`; map proven `NOT_APPLIED`
  evidence to `RELEASED`. A later authoritative provider observation may mark
  any blocked state as applied; the original status remains in the audit row.
- Keep the CLI dry-run by default and require `--confirm-write` for one reviewed
  mutation. RPC result, operation row, and immutable audit row all require
  authoritative readback.
- This is branch implementation only; the new migration and tool are not live.

## 2026-09-07 — Persist Rakuten confirmation intent and ambiguous outcomes

- Deduplicate multi-line candidates and claim one durable
  `rakuten_confirm_order` operation before each order-scoped RMS call.
- Do not release `confirm_in_progress` after an ambiguous relay result. Perform
  one exact-ID RMS read; only progress `300` or `500` proves that confirmation
  was applied, otherwise finalize as `UNKNOWN_RESULT` and block resubmission.
- Finalize provider success before local confirmation persistence. A confirmed
  ledger may heal local rows on a later run without repeating the RMS write.
- Isolate claim/finalize/local-persistence failures per order so one failed
  operation does not prevent later candidates from reaching a terminal result.
- This decision records branch implementation only; deployment, migration and
  live scheduler behavior remain unchanged.

## 2026-09-07 — Persist Giga create-order intent and ambiguous outcomes

- Claim each Giga create-order operation in Supabase before the provider call,
  using capability/platform/store/order/payload hash as its stable identity.
- Remove automatic retries for create-order transport errors and 5xx responses;
  they may have committed remotely and therefore become `UNKNOWN_RESULT`.
- A confirmed or already-applied ledger record suppresses resubmission. Reserved,
  unknown, and definitive-failure records remain blocked unless a governed
  reconciliation explicitly releases them.
- Giga exposes no verified order-status lookup in the current client contract.
  Do not invent automatic reconciliation or equate a local timeout with failure.

## 2026-09-07 — Extend exact-ID lifecycle accounting to Rakuten

- Keep the 72-hour RMS discovery overlap, but follow it with exact-ID reads for
  every locally known non-terminal Rakuten order.
- Apply RMS mapping evidence and order status through one order-scoped CAS RPC;
  all lines converge together and terminal RMS truth invalidates unsent Giga
  projections.
- Unknown/missing IDs, partial batches, bounded runs, and CAS conflicts remain
  retryable and cannot publish `accounting_complete`.
- Rakuten confirm, projection, Giga push, tracking, and close fail closed without
  a fresh `rakuten:Rakuten` watermark. Code readiness is not live activation.

## 2026-09-07 — Add the shadow orchestration control plane

- Added a VPS-started initial order DAG with shadow as the default and live mode
  requiring both `--live` and `ORCHESTRATOR_LIVE_ENABLED=true`.
- Added durable orchestration run/step records and a database lease with
  ownership-bound heartbeat/release RPCs. Control-plane writes require exact
  readback; unexpected exceptions finalize the run as `FAILED`.
- Shadow executes only discovery and lifecycle dry-runs; projection and all
  external/business writes are explicitly skipped.
- The systemd unit and timer are repository assets only. They are not installed
  or enabled, and this decision does not authorize a production scheduler change.

## 2026-09-07 — Implement first lifecycle freshness tranche

- Added batched exact-ID Mercari reconciliation after discovery; unknown,
  not-found, bounded, failed, or CAS-conflicted scopes cannot claim complete.
- Added durable per-store watermarks and shared fail-closed gates for payment
  reminders and the VPS sales brief.
- Split reminder reservation from confirmed delivery state so ambiguous sends
  remain `UNKNOWN_RESULT` for reconciliation.
- This is code and migration readiness, not deployment or scheduler cutover.

## 2026-09-07 — Extend external-action integrity gates

- Ambiguous payment-reminder sends are reconciled by exact seller-message text
  and post-reservation timestamp before an idempotency slot may be reused.
- Approval, Mercari projection, Giga push, and Mercari close consume the same
  lifecycle freshness contract; Giga eligibility is re-read per order just
  before the external write.
- The target Worker schedule no longer dispatches the duplicate cancellation
  writer, write-capable legacy end-to-end reconciler, or unverified Rakuten
  close. These are implementation facts only until live trigger readback.

## 2026-09-07 — Accept single-orchestrator order-pipeline integrity strategy

### Context

Issue #265 showed that green scheduled runs and aggregate processed counts did
not prove that a paid Mercari order had converged in Supabase before reporting.
The review also found minute-based dependency coupling, multiple conflicting
timer generations, a write-capable `reconcile_end_to_end`, and an active Worker
mapping for `close_rakuten_orders` despite repository text that still calls its
RMS contract unverified.

### Decision

- Accept `docs/trd/order-pipeline-orchestration-strategy.md` as the canonical
  target architecture.
- Use one VPS-started OrderMgmt orchestrator as the target business scheduler;
  Cloudflare retains Portal/API/monitoring responsibilities and must not remain
  a duplicate business scheduler after capability cutover.
- Separate discovery from lifecycle reconciliation and require durable
  freshness evidence before approval, fulfillment, close, reminders, or normal
  reporting.
- Preserve one writer per fact and add intent/idempotency/readback/unknown-result
  handling for external writes.
- Execute migration capability-by-capability with dry-run, canary, authoritative
  readback, rollback, and canonical-document updates in the same change.

### Impact

- This accepts a strategy, not its implementation. No scheduler, schema,
  credential, production code, or external-write change is authorized here.
- Existing Cloudflare cron remains the current scheduler until an approved
  cutover proves the replacement and confirms single ownership.
- The Rakuten-close contradiction is a Phase 0 safety audit, not evidence that
  the capability is safe or authorized.

### Follow-up

- Complete Phase 0 runtime and workload ownership reconciliation.
- Prepare separately reviewed Phase 1 freshness and external-write safety
  changes.
- Update all affected canonical documents during each capability cutover and
  keep deployed facts distinct from target-state design.

## 2026-08-04 — Rakuten sales-brief recognition and legacy reporter retirement

- Retired the legacy `rp-mercari-reporting` Cloudflare Worker after the VPS
  multi-platform timer became the canonical reporter.
- Rakuten `PENDING_CONFIRMATION` now counts as recognized sales because it
  represents a purchased order awaiting shop acknowledgement, not payment.
- Rakuten revenue now multiplies unit price by quantity before adding shipping.

## 2026-07-15 — Terminal orders have no review state

### Context

`review_status` controls operator review while an order is active. The
Baserow-to-Supabase migration copied historical review values onto completed
and canceled orders, even though the application derives terminal state from
`order_status` and blocks review mutations after termination. This left
terminal orders displaying actionable labels such as `Pending Review`.

Using `PENDING_REVIEW` as a terminal default would preserve the inconsistency.
Adding a second terminal marker to `review_status` would duplicate lifecycle
state and require every review-status consumer to understand that marker.

### Decision

For `order_status IN ('COMPLETED', 'CANCELED')`, `review_status` is `NULL`
because review is not applicable. Active orders continue to use
`PENDING_REVIEW`, `AUTO_APPROVED`, `APPROVED`, or `ON_HOLD` unchanged.

The database migration and runtime writers must preserve this invariant.
Portal responses expose the absent value as blank and the UI renders its
existing not-available placeholder.

### Impact

- Historical terminal rows require a one-time, scoped normalization.
- Terminal transitions and migration/import tooling must clear review state.
- Active review queues, approval gates, and Giga projection eligibility do not
  change.
- Hosted execution is a separate, explicitly approved operation because the
  shared Supabase project has no isolated staging environment.

### Follow-up

- Apply the governance-compliant schema/data migration for issue #144.
- Run the repair diagnostic and record the preflight/postflight counts.
- Verify portal terminal filters and observe normal pipeline health after the
  hosted write.
- After cleanup, add a cross-column constraint or trigger enforcing null review
  on terminal orders and non-null review on active orders. This is deferred
  until historical violations no longer prevent validation.

## 2026-07-17 — Rakuten Supabase migration: lifecycle columns and audit script

### Context

Issue #161 completes the Rakuten order lifecycle migration from Baserow to
Supabase. Six lifecycle/audit columns (`last_synced_at`, `sync_error`,
`rms_confirm_result`, `rms_confirmed_at`, `rms_close_result`,
`rms_close_completed_at`) are added to `public.sales_orders`. A read-only
parity audit script compares legacy Baserow rows against Supabase rows.

### Decision

- Migration `20260716203000` adds six nullable columns with `ADD COLUMN IF NOT
  EXISTS`.
- All Rakuten reads are channel-scoped (`sales_channel=rakuten`) to prevent
  cross-channel order-ID collisions.
- Runtime writes validate expected fields against the `SALES_COLUMNS`
  allow-list before mutating (fail-closed).
- RMS close success atomically sets `order_status=COMPLETED`,
  `review_status=null`, and close audit fields; close failure preserves
  `order_status=RMS_CONFIRMED`.
- The parity audit is strictly read-only; artifacts are written only after
  complete reads from both backends.

### Impact

- No existing Mercari behavior changes.
- Close remains unscheduled pending RMS contract verification.
- Production migration, Worker/Relay deploy, and parity audit execution are
  separately approved hosted-write gates.
- Amazon is out of scope (tracked in #164).

### Follow-up

- Apply migration, deploy Worker and Relay.
- Observe two scheduled Rakuten cycles, then run parity audit.
- Verify RMS close with dry-run and one-order canary before scheduling.

## YYYY-MM-DD — Decision title

### Context

### Decision

### Impact

### Follow-up
