# Sync Workload Governance

This file is the repository-local entrypoint into Retailpulses sync workload governance. It is maintained by `rp-governance-install` and updated when the governance kit is upgraded.

**Installed from:** `retailpulses/rp-governance-kit@cd336f9ba787c985e175a2f7952a044342eed0fa`
**Installed at:** 2026-08-13T11:47:33Z

---

## What This File Is

- A local entrypoint that points to the canonical central policy
- The installed governance reference for this repository
- Auto-updated by `rp-governance-install --with-sync-governance`

## What This File Is Not

- A copy of the full canonical policy (see link below)
- A replacement for the local sync job inventory
- A place to define repository-specific workflow rules (use the inventory for that)

---

## Canonical Policy

The authoritative sync workload governance policy is maintained in `retailpulses/rp-governance-kit`:

- [`docs/SYNC_WORKLOAD_GOVERNANCE.md`](https://github.com/retailpulses/rp-governance-kit/blob/main/docs/SYNC_WORKLOAD_GOVERNANCE.md) — Central policy: invariants, classification, risk derivation, enforcement levels

Always read the canonical policy before making sync workload changes. This local file is a reference pointer, not the policy itself.

---

## Local Inventory

This repository's authoritative sync workload inventory:

- [`docs/SYNC_JOB_INVENTORY.md`](SYNC_JOB_INVENTORY.md)

The inventory records what workloads exist, how they run, and their current state. Differences between the inventory and runtime are governance drift.

---

## Agent Preflight Checklist

Before creating, changing, replacing, enabling, disabling, or deleting a production sync workload, the agent MUST:

1. Read `docs/SYNC_JOB_INVENTORY.md`.
2. Identify the existing workload ID, or confirm that this is a new job.
3. Search for existing jobs with the same source, target, or write scope.
4. Inspect the canonical source and deployment entrypoint.
5. Identify overlapping writers and concurrency controls.
6. Confirm idempotency, retry, checkpoint, and kill-switch behavior.
7. Verify runtime state when production behavior may be affected.
8. Update the inventory in the same PR when governed facts change.
9. Report repository/runtime mismatches as governance drift — do not auto-remediate.
10. Include cutover and retirement steps when replacing another job.

---

## Repository-Specific Exceptions

No exceptions.

---

## Quick Reference

| Rule | Level | Summary |
|------|-------|---------|
| Stable workload ID | MUST | Permanent `lower_snake_case` ID; never reused after retirement |
| Canonical implementation | MUST | Owner repo, source path, deployment entrypoint declared |
| Inventory update | MUST | Update inventory when governed facts change |
| Overlapping writers | MUST | Declare existing writers, coordination, and retirement plan |
| Kill switch | MUST BEFORE PRODUCTION | Documented disable mechanism for every effectful workload |
| Bounded concurrency | MUST BEFORE PRODUCTION | No unbounded parallel execution |
| Bounded retry | MUST BEFORE PRODUCTION | Capped retries with backoff |
| Idempotency | MUST BEFORE PRODUCTION | Safe to run more than once, or duplicate detection |
| Traceable source | MUST BEFORE PRODUCTION | Runtime code traceable to reviewed commit |
| External commands | MUST BEFORE PRODUCTION | Idempotency key, unknown-result handling, reconciliation path |
| High-risk rollout | MUST BEFORE PRODUCTION | Dry-run evidence, bounded canary, rollback procedure |
| Observability | SHOULD | Run summary, counts, errors, checkpoint, freshness, dead-letter |
| Numeric thresholds | ADVISORY | Repo-controlled; must be bounded and appropriate |
| Agent preflight | MUST | 10-step checklist before any production workload change |
