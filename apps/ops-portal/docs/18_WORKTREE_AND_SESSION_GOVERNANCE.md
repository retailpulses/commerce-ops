# Worktree and Session Governance (Local Reference)

This file is the repository-local entrypoint for Retailpulses worktree/session isolation governance. It is installed and updated by `rp-governance-kit`.

**Canonical policy:** [`retailpulses/rp-governance-kit` → `docs/WORKTREE_AND_SESSION_GOVERNANCE.md`](https://github.com/retailpulses/rp-governance-kit/blob/4eb1c7229ddee7b1cf2d813c6adbc86302615287/docs/WORKTREE_AND_SESSION_GOVERNANCE.md)

**Installed governance ref:** `4eb1c7229ddee7b1cf2d813c6adbc86302615287`
**Installed at:** `2026-09-01T09:00:44Z`

---

## What This File Is

- An entrypoint that agents must read before starting or closing out a work session.
- A pointer to the canonical central policy, which is the source of truth.
- This file may be updated by `rp-governance-install` during governance upgrades.

## What This File Is Not

- A copy of the full canonical policy.
- A replacement for the repository-specific constraints in `governance/local.yaml`.
- A lock or enforcement mechanism — it is a reference pointer only.

## Core Invariant

**One writable session per Issue / branch / worktree.**

Each unit of work is owned by one session, on one branch, in one worktree. The same branch must not be checked out in more than one worktree, and a worktree must not have more than one session writing to it. When two or more non-prunable worktrees exist, the primary checkout is coordination-only and writable sessions must use dedicated linked worktrees.

## Start Gate

Before beginning work on an Issue:

```bash
bin/rp-worktree-hygiene --strict --base-ref <default-branch>
```

A violation means the session MUST NOT begin. Resolve it and re-run. Never reuse a branch already merged into the canonical base.

## Closeout Gate

Before opening a PR or finishing work:

```bash
bin/rp-worktree-hygiene --strict --base-ref <default-branch>
```

At closeout the intended work must be committed, so the worktree is clean. Open or update the PR, record its disposition, and release the ownership record only when the session is finished. A later check after merge deliberately rejects reuse of the merged branch.

## Session Ownership Record

Record the owning session in the worktree's git directory (never in tracked files):

```text
issue=65
branch=feat/issue-65-worktree-isolation
session=<agent>-<host>
started_at=<ISO-8601 UTC>
base_ref=main
```

Location: `$(git rev-parse --git-dir)/rp-session-owner`. Never commit it; never put credentials in it.

## Checker Safety

`bin/rp-worktree-hygiene` is **read-only**. It never removes worktrees, prunes metadata, checks out, resets, cleans, or deletes branches. Cleanup is ownership-gated and done separately.

## CI Limitation

`rp-worktree-hygiene` inspects local git state that does not exist on a CI runner. It runs as a **local agent-side gate**, not as a GitHub Action. Worktree/session isolation is out of scope for CI enforcement in v1.

## Repository Declaration

This repository's stricter session/worktree rules (if any) live in `governance/local.yaml` under `worktree_session`. Local rules may be stricter than central invariants but must never weaken them.

## Quick Reference

| Rule                        | Level          | Summary                                                           |
| --------------------------- | -------------- | ----------------------------------------------------------------- |
| One writable session        | MUST           | One session per Issue / branch / worktree                         |
| Concurrent primary checkout | MUST           | Primary checkout is coordination-only while 2+ active worktrees   |
| Start gate                  | MUST           | `rp-worktree-hygiene --strict` before work                        |
| Closeout gate               | MUST           | `rp-worktree-hygiene --strict` before PR                          |
| Ownership record            | SHOULD         | Worktree-scoped `rp-session-owner`, never committed               |
| Ownership-gated cleanup     | MUST           | Only the owning session (or a verifying human) removes a worktree |
| Checker is read-only        | MUST           | No destructive git actions in `rp-worktree-hygiene`               |
| CI enforcement              | NOT APPLICABLE | Local gate only; not a CI check in v1                             |

---

_This file is part of the Retailpulses governance kit. Do not edit manually — it is updated by `rp-governance-install`. Repository-specific constraints belong in `governance/local.yaml`._
