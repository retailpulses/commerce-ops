# OrderMgmt VPS orchestration deployment

Status: **immutable shadow installed and timer enabled; all live capabilities disabled**  
Canonical architecture SSOT: `docs/01_ARCHITECTURE.md`  
Canonical strategy: `docs/trd/order-pipeline-orchestration-strategy.md`  
Rollout runbook: `docs/plans/order-pipeline-first-tranche-rollout.md`

## Canonical target

Runtime readback (2026-09-07 22:39 JST): release
`37b1e7513b978298949b9cc5249bac0eb82ae603` is installed under the immutable
release root. Its first accepted run recorded all 17 steps, released the lease,
and skipped every external/business write step. The hourly shadow timer is
enabled; this is observation-only execution and does not transfer business
scheduler ownership from Cloudflare.

`order-mgmt-orchestrator.service` is the target VPS entrypoint for the
dependency-gated order pipeline. `order-mgmt-orchestrator.timer` starts the
service; `ORCHESTRATOR_MODE=shadow` in `pipeline.env` is the authoritative
default. Shadow mode executes bounded message/discovery/lifecycle dry-runs and
the read-only integrity audit, while business/external-write steps are skipped.
The Node-only orchestrator injects direct local Mercari and Rakuten order API
adapters for migrated capabilities; it does not call the co-located relay over
HTTP. The Worker retains relay transport until each ownership cutover.
Every systemd start also resolves the loaded module and `current` symlink and
requires both to match the exact 40-character `RELEASE_VERSION`; startup fails
before lease acquisition or workload execution on any drift.

The `pipeline-*.timer` files and `pipeline-scheduler@.service` are transitional
legacy assets. **Do not enable them.** Their schedules do not encode the full
business DAG and can create competing writers while Cloudflare cron remains the
production scheduler.

Run `npm run audit:strategy-readiness` before installation. It validates local
orchestration prerequisites only; `strategy_complete=false` is expected until
hosted migrations, installation, shadow parity, provider canaries, ownership
cutover and final retirement have authoritative runtime evidence.

## Prerequisites

- release is immutable and reachable from the governed deployment branch;
- both control-plane migrations in the rollout runbook have been applied and
  read back;
- `/etc/ordermgmt/pipeline.env` is readable only by the service owner and sets
  `DATABASE_BACKEND=supabase` plus the existing runtime credentials;
- `/etc/ordermgmt/sales-brief.env` is mode `0600`, owned by `rp-ordermgmt`, and
  contains only the reporting process credentials; the sales-brief service
  uses the same immutable `current` release and never runs as root;
- the external-operation ledger migrations are applied before enabling the
  sales-brief target, because live WeCom delivery now fails closed unless its
  stable JST slot intent can be claimed and finalized;
- local marketplace credentials are present: `MERCARI_TOKENS_PATH` points to
  an existing protected file under `/etc/ordermgmt`, and Rakuten ESA secret/key
  values are populated without placeholders;
- `ORCHESTRATOR_MODE=shadow`, `ORCHESTRATOR_LIVE_ENABLED=false`, and every
  `ORCHESTRATOR_ENABLE_*` capability flag is `false` during shadow;
- live Cloudflare trigger inventory and kill switches have been captured.

## Install disabled

Preferred: manually dispatch `install-orchestrator-shadow.yml`. It resolves an
exact commit reachable from `origin/main`, materializes an immutable release at
`/opt/order-mgmt-orchestrator/releases/<sha>`, atomically points `current` to
it, verifies the protected shadow-only environment, installs the units, and
reads back that the timer is disabled and service inactive. It refuses to
replace an active/enabled orchestrator and never starts shadow or live work.

Equivalent manual unit installation from an already verified immutable release:

```bash
sudo install -o root -g root -m 0644 /opt/order-mgmt-orchestrator/current/deploy/systemd/order-mgmt-orchestrator.service /etc/systemd/system/
sudo install -o root -g root -m 0644 /opt/order-mgmt-orchestrator/current/deploy/systemd/order-mgmt-orchestrator.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable order-mgmt-orchestrator.timer
systemctl is-enabled order-mgmt-orchestrator.timer
```

Expected state is `disabled`. Installation is not activation.

## Manual shadow acceptance

```bash
sudo systemctl start order-mgmt-orchestrator.service
systemctl show order-mgmt-orchestrator.service -p Result -p ExecMainStatus
journalctl -u order-mgmt-orchestrator.service --since "15 min ago"
```

Read back the exact `pipeline_orchestration_runs` row and its `pipeline_steps`:

- release and owner match the deployed process;
- run is terminal, never stranded as `RUNNING`;
- discovery/lifecycle are terminal with explainable counts;
- later shadow steps are `SKIPPED`;
- the lease row has been released;
- marketplace/Giga/customer-message external writes are zero.

Use the read-only verifier instead of accepting journal output alone:

```bash
npm run verify:shadow-run -- \
  --release-version '<exact-40-char-sha>' \
  --runtime-host '<exact-system-hostname>' \
  --since-minutes 60
```

It requires the exact release/owner host, one terminal `SUCCEEDED` shadow run,
every canonical DAG step in sequence, `SUCCEEDED` preview/read steps,
`SKIPPED` external-write steps with skip evidence, a released lease, and no
same-run `pipeline_run_log` rows.

Do not enable the timer if any item is missing or ambiguous.

## Enable shadow only

After manual acceptance:

```bash
sudo systemctl enable --now order-mgmt-orchestrator.timer
systemctl list-timers --all order-mgmt-orchestrator.timer
```

Cloudflare remains the sole production business scheduler during the required
shadow parity window. Enabling the shadow timer is not a live cutover.

After seven complete JST days, run `npm run audit:shadow-parity`. The read-only
audit requires at least 20 terminal successful runs per complete day, every
read/preview step successful, and every external-write step skipped. A healthy
window is necessary but explicitly does **not** prove output parity. The same
command also builds a sanitized, per-phase comparison of common numeric counts
from shadow steps and current `cron`-owned `pipeline_run_log` rows, normalized
per run. It still returns `parity_proven=false`: an operator must explain every
material difference before proposing cutover.

## Live capability cutover

There is no whole-pipeline enable command. Cut over one capability at a time
using the canonical strategy: dry-run, bounded canary, disable its existing
Cloudflare production path by recording owner `disabled`, drain and reconcile
in-flight operations, then transfer from `disabled` to VPS with authoritative
single-owner readback, canonical document update, and expansion. Direct
Cloudflare/absent-to-VPS transfer is rejected. Set `ORCHESTRATOR_MODE=live`,
`ORCHESTRATOR_LIVE_ENABLED=true`, and only the reviewed capability flag(s).
Live startup fails if no capability flag is enabled; an enabled descendant is
`BLOCKED` when its upstream owner remains disabled. These technical gates are
not authorization.

After authoritative legacy-trigger and new-runtime readback, use
`npm run record:scheduler-ownership -- ...` in dry-run for one exact workload.
Only a separately approved `--confirm-write` may publish the expiring ownership
fact and immutable event. Never populate the registry from desired config alone.

During the `disabled` interval, run the read-only quiescence verifier before
transferring ownership to VPS:

```bash
npm run verify:workload-quiescence -- \
  --workload-id '<exact-workload-id>' \
  --release-version '<exact-40-char-sha>' \
  --runtime-host '<exact-system-hostname>' \
  --drain-minutes 40
```

It requires aged, unexpired disabled evidence; no post-disable or unterminated
legacy phase audit; no active orchestrator lease; no open external operation;
and an accepted shadow run for the exact target release.

After separately approved ownership transfer, run one exact canary directly
through the immutable release (not the recurring systemd timer):

```bash
sudo -u ordermgmt /usr/bin/node /opt/order-mgmt-orchestrator/current/src/orchestrator.mjs \
  --live --canary mercari_tracking --shop Shop1 \
  --order-id '<exact-order-id>' --limit 1
```

Use a capability from the orchestrator's declared canary matrix. Message and
payment-reminder canaries also suppress or scope their background recovery
branches so they cannot touch neighboring orders. Rakuten omits
`--shop`. The command rejects unsupported capabilities, missing scope, any
limit other than one, a disabled capability flag, or mismatched ownership. It
executes only the selected unit; required upstream state and freshness must
already be authoritative. This command shape is a safety mechanism, not write
authorization. Read back the exact run and step rows plus provider/local state.

Integrity audit additionally requires `--platform mercari|rakuten`; Mercari
also requires `--shop`, while Rakuten rejects it. The scoped audit reads only
the selected platform/order and returns `scoped_complete`, never global
accounting evidence.

Discovery canaries use provider exact-order contracts rather than queue-head
limits: Mercari `orderTransaction(id)` requires one `--shop`; Rakuten uses RMS
`getOrder`. Both verify returned identity before invoking shared ingestion.
Their first fixed-IP provider calls remain separately approved contract
canaries, even though the command path exists.

## Stop and rollback

```bash
sudo systemctl disable --now order-mgmt-orchestrator.timer
sudo systemctl stop order-mgmt-orchestrator.service
```

Before restoring any prior production trigger, verify there is no active lease
or in-flight external operation. Never retry `UNKNOWN_RESULT` actions without
authoritative reconciliation.

## Version history

| Version | Date | Change |
|---|---|---|
| 3.4 | 2026-09-07 | Document exact provider discovery canaries and retain separate contract acceptance. |
| 3.3 | 2026-09-07 | Document platform-separated, read-only exact integrity-audit canaries. |
| 3.2 | 2026-09-07 | Document exact message/reminder canaries and their scoped recovery side paths. |
| 3.1 | 2026-09-07 | Document the exact single-capability live-canary command and its ownership, scope and readback gates. |
| 3.0 | 2026-09-07 | Add workload-scoped authoritative quiescence verification before disabled-to-VPS transfer. |
| 2.9 | 2026-09-07 | Require disabled quiescence, drain and ambiguity reconciliation before VPS ownership transfer. |
| 2.8 | 2026-09-07 | Add authoritative single-shadow-run acceptance for release, owner, steps, skip evidence, lease release and zero legacy audit writes. |
| 2.7 | 2026-09-07 | Revalidate immutable source/current/release identity at every orchestrator start. |
| 2.6 | 2026-09-07 | Add sanitized shadow-versus-production per-phase count comparison without automatic parity approval. |
| 2.5 | 2026-09-07 | Add a read-only, fail-closed seven-complete-day shadow-window audit while preserving separate production-output comparison. |
| 2.4 | 2026-09-07 | Add a main-reachable immutable-release workflow that installs canonical orchestrator units disabled and refuses active/live state. |
| 2.3 | 2026-09-07 | Document direct VPS marketplace transports and the separately default-off Rakuten-close target gate. |
| 2.2 | 2026-09-07 | Add evidence-backed per-workload ownership recording and Portal readback after each cutover. |
| 2.1 | 2026-09-07 | Add env-driven shadow/live mode and fail-closed per-capability cutover flags; whole-pipeline activation remains unavailable. |
| 2.0 | 2026-09-07 | Replace legacy three-timer activation guide with canonical shadow-first orchestration rollout and capability cutover controls. |
| 1.x | historical | Legacy Gate 3 per-phase timer instructions; retained in Git history only. |
