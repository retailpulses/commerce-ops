# Issue #265 scheduler ownership fence — independent review

- Version: 1.0
- Date: 2026-09-07
- Reviewed commit: `1d47dec`
- Review run: `20260907T161000-79417`
- Wrapper status: `complete`
- Routed provider/model: first-party `deepseek-v4-pro`
- Reviewer mode: read-only audit; no files changed
- Resolution commit: `b46db11`

## Accepted findings and resolution

### P1 — VPS-only evidence did not stop the Cloudflare scheduler

Accepted. The original live gate trusted a reviewed
`legacy_scheduler_disabled=true` registry value, but the Cloudflare scheduled
handler did not consult the registry. Incorrect or drifted evidence could
therefore allow both runtimes to dispatch.

Resolution:

- Added one canonical phase-to-workload map shared by both runtime fences.
- The Cloudflare scheduled handler now checks each phase before dispatch.
- An unregistered row preserves the legacy pre-cutover Cloudflare owner.
- Once registered, only an exact current `cloudflare_worker` row permits Worker
  dispatch; VPS/disabled ownership makes that phase step down.
- A registry read failure blocks dispatch rather than assuming Cloudflare owns
  the workload.
- Mixed cron slots retain unrelated phases whose ownership has not moved.

### P2 — Ownership evidence could remain operationally stale

Accepted. Registry expiry may be up to eight days, while the runtime did not
validate `evidence_observed_at`.

Resolution: both runtime gates require registered evidence observed within 24
hours. A later `expires_at` does not extend that runtime freshness window.

### P2 — Host/release identity depended on manual placeholders

Accepted. Exact runtime identity remains a deployment responsibility, but
literal `<...>` template values can no longer satisfy the VPS gate. Missing,
unknown, placeholder, wrong-host and wrong-release values all fail closed.

### P2 — Ownership block reason was hidden from Pipeline Health

Accepted. Scheduler and dependency rejection reasons now populate
`pipeline_steps.error_code` as well as aggregate `result_counts`. The existing
control-plane projection and Portal failed/blocked-step view therefore expose
the reason without persisting order or customer data.

## Residual findings and disposition

### P3 — Lease heartbeat is step-boundary rather than mid-phase

Retained as a shadow fault-injection item. The canonical systemd unit has a
35-minute service timeout while the lease TTL is 60 minutes, which prevents the
supported scheduled runtime from executing one phase beyond lease expiry. A
manual live invocation outside systemd must not be used as a scheduler. Shadow
acceptance must still verify timeout, service termination, lease expiry and the
next acquisition before live cutover.

### P3 — Ownership verification is point-in-time

Accepted as an external-call boundary constraint, not proof of atomicity. The
gate runs immediately before each unit, ownership updates are CAS-audited, and
the opposite runtime also fences itself. Cutover must still stop new dispatch,
wait for leases/in-flight operation intents, change ownership, then perform
authoritative readback; ownership must never be flipped as an in-flight cancel.

## Verification

- Targeted scheduler/orchestrator tests: 23 passed before the bilateral fence.
- Bilateral runtime-fence tests cover transferred ownership, mixed cron slots,
  registry read failure, wrong owner/host/release/state, expired/stale evidence,
  missing evidence, placeholder identity, and durable BLOCKED reason.
- Full repository suite after resolution: 1025 passed, 0 failed.
- Worker syntax build passed.
- Portal suite/build remained green: 20 passed, TypeScript/Vite build passed.

This audit proves branch behavior only. It does not prove hosted migration,
deployment, scheduler ownership population, shadow parity, or production
cutover.
