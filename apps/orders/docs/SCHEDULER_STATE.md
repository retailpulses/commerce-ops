# Scheduler State — OrderMgmt

Status: **shadow active / target business cutover not started**  
Last reconciled: 2026-09-07 22:39 JST  
Related: #262, #265

This document separates scheduler implementation and deployment intent from live activation. It is the narrow canonical record for scheduler topology and ownership evidence.

## 0. Latest production readback

- Direct Cloudflare control-plane readback returned the 13 expected cron expressions for `rp-order-mgmt`; deployed Worker version was 238 with release binding `4e1373fe03dd711a1351381e2b6f99012f19ef94`.
- VPS readback found 16 legacy `pipeline-*` timers installed but disabled. The canonical hourly orchestrator timer is installed and enabled in shadow mode at immutable release `37b1e7513b978298949b9cc5249bac0eb82ae603`.
- `order-mgmt-sales-brief.timer` was enabled/active and its latest service exit was 0. Historical reporting Worker names were absent from Cloudflare.
- Therefore Cloudflare is the current business scheduler owner and the VPS sales-brief timer is the observed reporting owner. This is current-state evidence, not an endorsement of the split architecture or authorization to enable another writer.
- Issue #265 accepts VPS-started canonical orchestration as the target. Each capability must pass shadow/canary/readback and enter an explicit disabled/quiescent state before VPS ownership can be acquired.
- First accepted shadow evidence: run `run_1788788321770_t5jic55j`, 17/17 expected steps, exact VPS owner/release, lease released, and all external/business writes skipped. Seven complete JST days with at least 20 accepted runs/day are still required.

## 1. Cloudflare Worker scheduler

Repository evidence:

- `wrangler.toml` declares 13 cron expressions covering the production pipeline schedule.
- `worker/index.js` implements a scheduled handler and dispatches phases through the shared pipeline runner/schedule modules.
- `DATABASE_BACKEND="supabase"` is declared in `wrangler.toml`.

Evidence state:

- Implemented: **yes**
- Declared for deployment: **yes**
- Deployed: **not proven by repository state alone**
- Runtime verified: **no**

Until Cloudflare runtime evidence says otherwise, do not remove the Worker scheduler from architecture or assume that VPS timers have replaced it.

## 2. VPS scheduler — legacy three-timer generation

`deploy/README.md` documents an earlier Gate 3 design using:

- `pipeline-hourly.timer`
- `pipeline-sync.timer`
- `pipeline-close.timer`

The document instructs operators to `enable --now` those timers and describes the design as replacing Worker cron triggers.

Evidence state:

- Implemented in repository: **yes**
- Historical deployment intent: **yes**
- Current deployment intent: **superseded/ambiguous**
- Runtime verified active: **no**

This document must not be used as evidence that these three timers are currently enabled.

## 3. VPS scheduler — fine-grained sixteen-timer generation

`.github/workflows/install-pipeline-timers.yml` installs 16 phase-specific timer units plus `pipeline-scheduler@.service`.

Important behavior: the installer explicitly runs `systemctl disable --now` for every installed timer. Therefore successful execution of that workflow proves installation/verification of timer files, not activation.

Evidence state:

- Implemented in repository: **yes**
- Install workflow: **yes**
- Installer default activation state: **disabled**
- Runtime verified active: **no**

## 4. Reporting scheduler

`SYNC_JOB_INVENTORY.md` declares `order-mgmt-sales-brief.timer` as the VPS systemd runtime for sales brief reporting.

Evidence state:

- Declared: **yes**
- Runtime verified active: **no**

## 5. Reconciliation finding

There are currently three scheduler descriptions in repository evidence:

1. Cloudflare Worker cron — full schedule declared in `wrangler.toml`.
2. Legacy VPS 3-timer design — documented as an intended replacement for parts of Worker cron.
3. Fine-grained VPS 16-timer design — installable but explicitly disabled by its installation workflow.

Therefore the earlier `SYNC_JOB_INVENTORY.md` representation of selected workloads as simultaneously having Worker and active systemd execution paths must be interpreted as **declared/possible topology, not verified dual execution**.

The safe current architectural statement is:

> Cloudflare cron is the only complete scheduler currently declared as enabled by repository configuration. VPS timer definitions exist in two generations, but repository evidence does not prove which, if any, are live-enabled.

This is not proof that Cloudflare cron is actually deployed or firing; that requires live Cloudflare evidence.

## 6. Live verification contract

A runtime verification is complete only when both hosting layers are directly checked and evidence is timestamped.

### VPS

Capture:

```bash
systemctl list-timers --all --no-pager | grep -E 'pipeline-|order-mgmt'
systemctl list-unit-files --no-pager | grep -E 'pipeline-|order-mgmt'
systemctl is-enabled pipeline-hourly.timer pipeline-sync.timer pipeline-close.timer 2>&1 || true
```

For every enabled phase-specific timer, capture:

```bash
systemctl is-enabled <timer>
systemctl status <timer> --no-pager
journalctl -u <timer> -u 'pipeline-scheduler@*' --since '24 hours ago' --no-pager
```

### Cloudflare

Capture the deployed `rp-order-mgmt` Worker version plus its currently configured Cron Triggers from the Cloudflare control plane, not only `wrangler.toml`.

### Acceptance

Update this file with:

- verification timestamp (JST),
- deployed Worker release/SHA,
- live Cloudflare cron list,
- live enabled VPS timer list,
- last-success evidence for each active scheduler path,
- any duplicate workload execution.

Any difference from `docs/SYNC_JOB_INVENTORY.md` is governance drift and must be resolved deliberately; do not auto-enable/disable jobs as part of verification.

## 7. Immediate architecture consequence

Until live verification is captured:

- Do not migrate or retire a Worker workload based on the existence of a VPS timer file.
- Do not enable a VPS timer whose workload is already scheduled in Cloudflare without an explicit cutover plan.
- Treat `deploy/README.md` as historical scheduler design guidance rather than current runtime truth.
- Use `docs/SYNC_JOB_INVENTORY.md` for workload definitions and this file for scheduler evidence status.
