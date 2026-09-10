# Order pipeline first-tranche rollout

Version: 6.7 (2026-09-07)
Status: implementation ready; production execution pending

## Scope

This rollout activates Mercari exact-ID lifecycle reconciliation, durable
freshness watermarks, payment-reminder/reporting/fulfillment freshness gates,
ambiguous reminder reconciliation, per-order Giga eligibility readback, and
retires the duplicate cancellation schedule, write-capable legacy reconciler,
and unverified Rakuten-close dispatch.

## Ordered rollout

Before production work, run `npm run audit:strategy-readiness`. A successful
command proves only repository-local prerequisites. Its structured output must
continue to report `strategy_complete=false` until the separately governed
runtime evidence gates are proven by authoritative readback.

1. Record current Worker/relay release, all live cron triggers, the sales-brief
   timer, recent run results, and current reminder/report behavior.
2. Apply `20260907090000_add_lifecycle_freshness_watermarks.sql`,
   `20260907100000_add_orchestrator_control_plane.sql`, and
   `20260907110000_add_external_operation_ledger.sql` plus the subsequent
   resolution/atomic-completion migrations through
   `20260907155000_add_scheduler_ownership_registry.sql`; read back all tables,
   RPC privileges, constraints, and payment-reminder columns. Do not deploy consumers
   first because they intentionally fail closed without this schema.
3. Deploy the relay release and canary `/admin/order-statuses` with one known
   non-terminal order per shop. Verify returned ID/status and fixed IPv4 path;
   do not log customer data.
4. Run `reconcile_order_lifecycle` with
   `LIFECYCLE_RECONCILE_CANARY_LIMIT=1`. Confirm it reports `partial`, updates
   only the expected order atomically, and does not publish a complete scope.
5. Remove the canary limit and run a full dry-run, then one full manual run.
   Read back all four `order_lifecycle_watermarks`, per-store counts, the target
   #265 order status, and multi-line consistency.
6. Repeat the exact-ID sequence for Rakuten with
   `RAKUTEN_LIFECYCLE_RECONCILE_CANARY_LIMIT=1`, then unbounded dry-run and
   one full manual run. Read back `rakuten:Rakuten`, mapping evidence, a
   multi-line order, and terminal projection invalidation. Unknown/missing RMS
   evidence must keep the watermark partial.
7. Deploy the Worker schedule change. Read back the live trigger set and prove
   `reconcile_cancellations` and `close_rakuten_orders` are no longer dispatched.
8. Configure the VPS sales-brief freshness scopes and SLA. Run it once with a
   deliberately stale watermark (must exit 2 without WeCom), then restore a
   fresh complete watermark through reconciliation and run one separately
   approved delivery-slot canary. Read back its `sales_brief_delivery` intent
   and `CONFIRMED` finalization. Re-run the same slot and prove zero additional
   WeCom sends; inject transport ambiguity and prove `UNKNOWN_RESULT` blocks
   automatic resend.
9. Run payment reminders in dry-run. Confirm stale/partial evidence blocks and
   fresh complete evidence reaches the existing exact-ID pre-send check.
10. Run one exact-order Giga dry-run, then a canary whose provider result is
   independently verified. Read back the claim/finalize row and shipment
   projection. Separately inject a transport failure and prove it creates
   `UNKNOWN_RESULT` with exactly one provider attempt and no timed retry.
11. Run Rakuten confirmation in dry-run, then one exact-order canary. Read back
   the operation identity/status, exact RMS progress, and every local line.
   Inject a lost relay response and prove that RMS `300`/`500` reconciles as
   `ALREADY_APPLIED`; any other/missing evidence must remain `UNKNOWN_RESULT`,
   keep local confirmation in progress, and produce no second RMS call.
   Before activation, replay and permission-test the operator resolution
   migration. Run the CLI dry-run against one synthetic/canary blocked record,
   then resolve it only from authoritative evidence and read back the operation
   plus immutable audit row. Release must never be based on age alone.
12. Install `order-mgmt-orchestrator.service` and `.timer` without enabling the
   timer. Run one manual shadow cycle and read back its run, every step terminal
   state, release, owner, lease release, skip counts, and zero external writes.
13. After manual acceptance, enable only the shadow timer. Observe at least
   seven days of explained parity before proposing any live capability cutover.
   Existing Cloudflare business cron remains the production owner during shadow.
14. Keep Rakuten close unscheduled until the current RMS contract and historical
   production behavior are independently verified. Then run one exact-order
   dry-run and one separately approved canary. Prove one ledger intent/provider
   mutation per order, RMS progress 500, and identical terminal state across
   every local line. Inject an ambiguous response and prove no resubmission.
15. For Mercari close, run one exact-order dry-run and one approved canary per
   distinct shipping shape before scheduler cutover. Read back the order-level
   intent, marketplace `COMPLETED`, atomic all-line Supabase state and tracking.
   Inject failure between shipping mutations and prove the operation becomes
   blocked/unknown with no second mutation sequence.
16. Deploy the authenticated control-plane endpoint and Portal view without
   changing scheduler ownership. Verify unauthenticated access returns 401;
   authenticated readback must show the deployed release, no fabricated current
   owner without an active lease, lifecycle freshness, recent failed/blocked
   steps, operation attention states, bounded backlog and truncation flags.
   During shadow, prove the active lease appears and expires correctly. Treat
   the local live-enable flag only as configuration; independently read back
   Cloudflare triggers before any capability cutover.
17. Before any full live orchestrator schedule, verify every phase receives
   `null` as the explicit full-accounting limit and returns complete
   candidate/processed evidence. Exact live canaries must instead receive the
   explicit global bound `1`. Exercise more than 50 auto-approval/Rakuten candidates in a
   non-writing fixture or controlled dry-run to prove no legacy 50/100 fallback
   or queue-head starvation remains. Validate RMS discovery/get-order provider
   batch limits separately; `null` does not by itself prove provider pagination.
18. In shadow fault injection, fail Mercari discovery and prove the Rakuten
   discovery/reconciliation branch still completes while Mercari descendants
   and payment reminders are `BLOCKED`. Fail message ingestion and prove it does
   not block either fulfillment branch. Verify every eligibility/projection/
   outbound/tracking/close capability has its own durable step, write-capable
   steps remain skipped, and the read-only integrity audit records bounded
   backlog without becoming a second writer.
19. Read back every `pipeline_steps.result_counts.by_phase` object and reconcile
   candidate/processed/outcome totals with `pipeline_run_log`. Reject cutover if
   a capability has empty or internally inconsistent accounting. Verify no
   order IDs, customer fields, message text, credentials, or provider payloads
   are persisted in step summaries.
20. For each capability cutover, keep all other `ORCHESTRATOR_ENABLE_*` flags
   false. In the same governed change, disable/read back its legacy trigger,
   enable only the selected capability after independently proving required
   upstream facts/freshness, then read back `SKIPPED` non-selected steps and
   the selected step's terminal result. Prove a normal scheduled descendant
   with a disabled upstream becomes `BLOCKED`. Never use a bulk
   all-capabilities flag.
21. After collecting the same-change legacy-trigger and new-runtime readbacks,
   run `record:scheduler-ownership` in dry-run for one exact workload. Confirm
   expected owner, evidence reference/time, host, release, kill-switch state,
   legacy-disabled proof and expiry, then separately approve `--confirm-write`.
   Read back the current row and immutable event in Supabase and the Portal.
   Reject stale/expired evidence and CAS conflicts; never bulk seed target-state
   ownership from repository intent.
22. Read back terminal integrity-audit counts for Mercari and Rakuten
   separately. Inject a Mercari-only filter/failure and prove Rakuten rows are
   still counted, and vice versa. Reconcile a known row from each channel to
   the canonical sales/shipment tables; the audit must not perform any repair
   or external write.
23. Deliberately test each live ownership rejection before canary: missing row,
   wrong owner, wrong VPS host, wrong release, disabled state, missing
   legacy-trigger proof and expired evidence must each create a `BLOCKED` step
   without invoking the phase. Only the exact current workload ownership row
   may permit execution.
24. After recording one canary workload owner as `vps_order_orchestrator`,
   invoke the still-present Cloudflare schedule in a non-writing acceptance
   fixture and prove that exact phase steps down while unrelated Cloudflare
   phases retain their owners. Registry read failure must dispatch no phase.
   Verify the VPS `BLOCKED` ownership reason appears in Pipeline Health. Do not
   rely on the operator-supplied `legacy_scheduler_disabled` boolean alone.
25. Prove every advertised dry-run is side-effect free. The Worker
   `/admin/run-once` must reject write confirmation. Giga outbound preview must
   prove its sync writer was never invoked. Mercari/Rakuten projection previews
   must prove create/patch/delete were never invoked. Tracking preview may use
   the scoped Giga read but must prove shipment/sales patch functions remain
   uncalled. The legacy end-to-end preview remains `dry_run_unsupported` and is
   retired in favor of the read-only integrity audit. Dry-run audit must remain
   log-only and must not persist a `pipeline_run_log` row. Approved live canaries run only through the canonical
   ownership-gated orchestrator, never by converting an admin dry-run request.
26. Prove message-sync preview does not persist success or failure state on any
   branch, and prove identical order IDs from different stores remain separate
   `(source_store_id, order_id)` candidates.
27. Prove auto-approval uses `(source_store_id, order_id)` from candidate
   grouping through durable/live message gates, transactional approval and
   optional post-approval notice.
28. Prove the relay no longer exposes the singular legacy Mercari close
   endpoint or its script-path configuration; only the bounded canonical batch
   endpoint may remain reachable.
29. Prove cancellation detection and shipment invalidation use the full
   `(source_store_id, normalized_order_id)` identity and cannot affect a
   same-number order in another shop.
30. Prove Portal backlog joins and order-count metrics preserve
   `(sales_channel, source_store_id, normalized_order_id)`, including a
   same-number cross-shop projection case.
31. Prove the Worker stuck-order diagnostic joins sales and shipment evidence
   by `(source_store_id, normalized_order_id)` and cannot consume another
   shop's same-number shipment.
32. Prove terminal integrity-audit shipment matching uses
   `(sales_channel, source_store_id, normalized_order_id)` so shadow parity and
   acceptance cannot be satisfied by another shop's same-number projection.
33. Prove tracking quarantines an order ID found in multiple source stores
   before any Giga read or local write, and that unambiguous sales updates use
   the shipment's channel/store/order scope.
34. Prove Mercari shipment projection separates same-number orders by source
   store before commercial allocation, line numbering, limit enforcement and
   shipment mutation.
35. Prove Portal order lookup returns `ambiguous_order_scope` instead of
   selecting an arbitrary row when one order ID exists in multiple
   channel/store scopes. Prove list-provided `portal_target_id` round-trips
   channel/store/order through drawer detail and single-order mutations without
   changing the displayed business order ID. Prove bulk selection submits only
   validated scoped `order_targets`; legacy `order_ids` remain fail-closed on
   collisions.
36. Prove VPS `pull_shop_orders` runs through the Node-only local capability
   runner without relay HTTP or relay-health dependency, while a Cloudflare
   Worker bundle dry-run still succeeds and retains relay transport.
37. Prove VPS `close_shop_orders` directly invokes the canonical ledger/readback
   batch with exact shop/limit/dry-run scope, preserves a failed result on
   non-zero child exit, and does not contaminate the Worker bundle.
38. Prove VPS lifecycle reconciliation injects an IPv4-only exact-status reader
   with store scope, 50-ID bounds and fail-closed HTTP/GraphQL/timeout/parse/
   response-size handling while Cloudflare retains relay transport.
39. Prove VPS scheduled message sync injects the IPv4 local reader without
   changing message-fact ownership or folded webhook retry; dry-run must skip
   retry writes and Worker execution must retain relay transport.
40. Prove VPS payment reminders use local IPv4 reads for ambiguous and pre-send
   checks plus a local IPv4 reply writer, while freshness, reservation,
   authoritative message ID and `UNKNOWN_RESULT` gates remain unchanged.
41. Prove VPS Rakuten discovery, exact lifecycle reads, confirmation and close
   use the local IPv4 RMS adapter with 50-order, timeout and response-size
   bounds while reusing shared ingest/CAS/watermark/operation-ledger/readback
   logic. Prove the Worker bundle retains relay transport and Rakuten close
   remains unscheduled until its governed contract canary succeeds.
42. Prove the target DAG models Rakuten close after Rakuten tracking under a
   dedicated default-off capability flag. Shadow must skip it, and live must
   require the global gate, upstream success and exact durable ownership before
   execution; this control-plane coverage is not RMS contract acceptance.
43. Prove the canonical orchestrator install resolves an exact main-reachable
   SHA into an isolated immutable release, rejects template/live configuration,
   refuses to replace an active owner, and reads back timer disabled plus
   service inactive. Installation must not start shadow or change any legacy
   scheduler.
44. Run the read-only shadow-window audit over at least seven complete JST days.
   Require at least 20 successful terminal runs per day, every expected
   read/preview step `SUCCEEDED`, and every external-write step `SKIPPED`.
   Treat this only as window-health evidence; separately compare sanitized
   production-owner outcomes and explain every material difference before
   calling parity proven.
45. Use the same audit to compare only common numeric per-phase metrics from
   shadow steps and production `cron` audit rows, including totals and per-run
   averages. Missing evidence or failures must block readiness. Reviewers must
   explain cadence and semantic differences; the tool must never auto-approve
   parity or expose per-order/customer/provider data.
46. Prove every systemd-started orchestrator resolves its loaded source and the
   canonical `current` pointer to the same immutable release directory named by
   exact `RELEASE_VERSION`. Inject source, pointer and environment drift and
   prove startup fails before lease acquisition or workload execution.
47. After the first manual shadow execution, run the read-only exact-run
   verifier. Require matching release/owner host, terminal `SUCCEEDED`, every
   canonical step in order, preview/read success, external-write `SKIPPED`
   evidence, released lease, and zero same-run `pipeline_run_log` writes.
48. For every first ownership transfer, publish a CAS transition from the
   current Cloudflare/absent state to owner `disabled` with kill switch
   `disabled`. Wait the capability-specific maximum in-flight duration and
   prove no active run/open ambiguous operation before a second CAS from
   `disabled` to `vps_order_orchestrator`. Direct Cloudflare/absent-to-VPS
   transfer must fail in both client validation and the database RPC.
49. Before `disabled` → VPS, run the workload-scoped quiescence verifier. It
   must read back an aged/unexpired disabled row, no post-disable dispatch, no
   unterminated matching legacy run, no active orchestrator lease, no open
   external operation, and a fully accepted shadow run for the exact target
   release and host.
50. Invoke an approved exact live canary only as
   `--live --canary <supported-capability> --order-id <id> --limit 1`, adding
   exact `--shop Shop1..Shop4` for Mercari. Prove all non-selected steps are
   durably `SKIPPED`, only the selected phase receives the exact scope, and
   ownership/freshness rejection occurs before provider or database mutation.
   Mercari discovery uses exact `orderTransaction(id)` with the complete ingest
   projection and Rakuten discovery uses RMS `getOrder`; both require provider
   contract canaries before production acceptance.

## Rollback

Stop the new Worker release before restoring any old trigger. Do not restore
the independent cancellation writer or Rakuten close without an explicit
single-writer decision. Preserve lifecycle watermarks and reminder intents;
never resend an `UNKNOWN_RESULT` operation during rollback.

## Acceptance evidence

- one live scheduler owner per affected workload;
- four fresh `accounting_complete` Mercari watermarks with release/run IDs;
- #265-style paid transition converges before report/reminder consumption;
- stale/partial tests produce no WeCom or customer message;
- no multi-line status split and no terminal status regression;
- canonical docs updated with deployed commit and runtime verification time.
- operator reconciliation/release tooling exists and has a dry-run/readback
  acceptance for every non-reclaimable operation-ledger state.

## Version history

| Version | Date | Change |
|---|---|---|
| 7.4 | 2026-09-07 | Add stable-slot sales-brief delivery intent, duplicate suppression, unknown-result blocking and authoritative ledger readback acceptance. |
| 7.3 | 2026-09-07 | Add 61-order non-writing fixtures proving canonical live null limits do not fall back to the legacy 50-candidate cap for auto-approval or Rakuten confirmation. |
| 7.2 | 2026-09-07 | Add #265 execution-boundary tests proving stale evidence prevents fulfillment runner invocation and all reminder reads/sends. |
| 7.1 | 2026-09-07 | Add executable #265 sales-brief acceptance: stale freshness blocks before order reads and WeCom delivery. |
| 7.0 | 2026-09-07 | Add canonical-document contradiction tests and remove superseded canary/discovery statements. |
| 6.9 | 2026-09-07 | Add exact Mercari orderTransaction discovery at the ingestion source; all DAG capabilities now have exact canary scope. |
| 6.8 | 2026-09-07 | Route exact Rakuten discovery through RMS getOrder and reject missing/ambiguous identity before shared ingestion. |
| 6.7 | 2026-09-07 | Add platform-separated exact integrity-audit canaries with database-level sales/shipment scope and scoped completion semantics. |
| 6.6 | 2026-09-07 | Exact-scope message ingestion and payment reminders, including webhook-retry and ambiguous-reservation side paths. |
| 6.5 | 2026-09-07 | Add exact shop-plus-order scope to Mercari auto-approval before limiting, product lookup, evaluation or mutation. |
| 6.4 | 2026-09-07 | Add the ownership-gated exact single-capability live-canary CLI and reject unsupported scopes. |
| 6.3 | 2026-09-07 | Add exact lifecycle scope while preventing scoped runs from publishing global freshness. |
| 6.2 | 2026-09-07 | Add exact-order tracking scope and fix limit to apply globally before 20-order provider batching. |
| 6.1 | 2026-09-07 | Add pre-limit exact-order scope to Rakuten confirmation and projection as canary-control groundwork. |
| 6.0 | 2026-09-07 | Add authoritative workload quiescence verification before disabled-to-VPS acquisition. |
| 5.9 | 2026-09-07 | Require explicit disabled quiescence and drain evidence before VPS ownership acquisition. |
| 5.8 | 2026-09-07 | Add authoritative exact-run acceptance for the first manually started shadow cycle. |
| 5.7 | 2026-09-07 | Bind every systemd start to an exact immutable source/current/release identity. |
| 5.6 | 2026-09-07 | Add sanitized shadow-versus-production metric comparison while retaining explicit human parity review. |
| 5.5 | 2026-09-07 | Add a strict read-only shadow-window audit without conflating internal health with production-output parity. |
| 5.4 | 2026-09-07 | Add immutable, disabled-only canonical orchestrator installation and fail-closed configuration/state readback. |
| 5.3 | 2026-09-07 | Align canonical runtime entrypoints with the current Worker-relay and target VPS-direct transport split. |
| 5.2 | 2026-09-07 | Add a separately ownership-gated, default-off Rakuten-close target capability without scheduling the unverified write. |
| 5.1 | 2026-09-07 | Route VPS Rakuten RMS reads/writes through a bounded local IPv4 adapter while retaining the shared lifecycle and operation-safety contracts. |
| 5.0 | 2026-09-07 | Move VPS payment-reminder provider reads/writes to injected local IPv4 adapters without weakening send safety. |
| 4.9 | 2026-09-07 | Move VPS scheduled Mercari message reads to the local IPv4 client while preserving webhook retry semantics. |
| 4.8 | 2026-09-07 | Move VPS Mercari lifecycle exact-status reads to an injected IPv4-only local client. |
| 4.7 | 2026-09-07 | Move VPS Mercari close to direct local execution through the canonical operation-ledger batch script. |
| 4.6 | 2026-09-07 | Move VPS Mercari discovery to direct local execution without contaminating the Worker bundle with Node process APIs. |
| 4.5 | 2026-09-07 | Extend scoped Portal targets to bulk approval with strict new-field validation and fail-closed legacy compatibility. |
| 4.4 | 2026-09-07 | Add scoped Portal drawer targets across detail and single-order mutations; retain a bulk-approval scope gate. |
| 4.3 | 2026-09-07 | Fail closed on ambiguous Portal order-ID lookup and record the scoped-route follow-up gate. |
| 4.2 | 2026-09-07 | Scope Mercari shipment projection grouping before any order-level calculation or mutation. |
| 4.1 | 2026-09-07 | Quarantine ambiguous cross-store tracking IDs and scope all unambiguous sales updates. |
| 4.0 | 2026-09-07 | Scope terminal integrity-audit shipment matching by channel, source store and normalized order ID. |
| 3.9 | 2026-09-07 | Scope Worker stuck-order diagnostic joins by source store and normalized order ID. |
| 3.8 | 2026-09-07 | Require scoped identity in Portal backlog joins and order-count metrics, including cross-shop same-number regression coverage. |
| 3.7 | 2026-09-07 | Prevent cross-shop cancellation and shipment invalidation by using scoped order identity. |
| 3.6 | 2026-09-07 | Retire the singular Mercari close relay control path and retain only the governed batch endpoint. |
| 3.5 | 2026-09-07 | Enforce cross-shop order identity throughout Mercari auto-approval. |
| 3.4 | 2026-09-07 | Remove message-sync dry-run failure writes and enforce cross-shop candidate isolation. |
| 3.3 | 2026-09-07 | Remove the hidden dry-run audit-row mutation; retain structured log evidence without database persistence. |
| 3.2 | 2026-09-07 | Add Mercari/Rakuten tracking previews that retain provider reads but prove all database patch paths remain uncalled. |
| 3.1 | 2026-09-07 | Add mutation-spy-proven Mercari/Rakuten shipment projection previews with explicit planned actions and zero side effects. |
| 3.0 | 2026-09-07 | Add tested no-sync-writer Giga outbound preview while keeping remaining unsupported previews fail closed. |
| 2.9 | 2026-09-07 | Remove direct Worker manual writes and make unsupported dry-run phases fail closed before phase execution. |
| 2.8 | 2026-09-07 | Add bilateral Cloudflare/VPS ownership fencing, 24-hour evidence freshness, placeholder rejection and visible BLOCKED-reason acceptance. |
| 2.7 | 2026-09-07 | Add runtime-enforced durable ownership rejection cases as a pre-canary gate, not merely an operator visibility check. |
| 2.6 | 2026-09-07 | Add channel-isolated cross-platform integrity-audit acceptance and no-repair proof. |
| 2.5 | 2026-09-07 | Add expiring evidence-backed scheduler ownership registry, CAS/audit CLI and Portal readback acceptance. |
| 2.4 | 2026-09-07 | Add env-driven mode, explicit per-capability live ownership flags, disabled-step and missing-upstream acceptance. |
| 2.3 | 2026-09-07 | Add durable per-phase outcome accounting and non-PII step-summary acceptance. |
| 2.2 | 2026-09-07 | Add branch-local failure isolation, independent message ingestion, per-capability durable steps, reminder dependency and read-only integrity-audit acceptance. |
| 2.1 | 2026-09-07 | Add null-as-full-accounting phase-limit acceptance and explicit scale/provider pagination gates. |
| 2.0 | 2026-09-07 | Require real matching live executor identity, canonical lease scope, normalized cross-table IDs, Mercari isolation, deterministic bounded reads and visible truncation in operator acceptance. |
| 1.9 | 2026-09-07 | Add authenticated operator control-plane deployment, lease expiry, ownership evidence, bounded backlog and canonical-route acceptance. |
| 1.8 | 2026-09-07 | Add Mercari close order-level ledger, marketplace readback, atomic multi-line and partial-failure acceptance. |
| 1.7 | 2026-09-07 | Add Rakuten close contract audit, order-scoped ledger, multi-line and ambiguity canary acceptance. |
| 1.6 | 2026-09-07 | Add migration replay, permissions and bounded canary acceptance for the implemented resolution CLI/RPC. |
| 1.5 | 2026-09-07 | Make governed operation-ledger reconciliation/release tooling a live-activation blocker. |
| 1.4 | 2026-09-07 | Add Rakuten confirm ledger, exact-ID ambiguity readback, and no-resubmission canary evidence. |
| 1.3 | 2026-09-07 | Add external-operation ledger migration and Giga success/unknown-result canary evidence. |
| 1.2 | 2026-09-07 | Add Rakuten exact-ID lifecycle canary, full-accounting readback, and downstream gate acceptance. |
| 1.1 | 2026-09-07 | Add control-plane migration and disabled-install/manual-shadow/readback sequence. |
| 1.0 | 2026-09-07 | Initial governed rollout, canary, readback, rollback, and acceptance sequence. |
