# Decision Log

## 2026-07-10 — Issue-first governance workflow

### Context
The repository lacked a formal workflow for linking code changes to GitHub Issues. Agents and humans worked without shared context, leading to duplicated effort and undocumented system changes.

### Decision
Adopt a lightweight Issue-first development workflow. All code changes merged into `main` must reference a GitHub Issue. Three helper scripts (`bin/rp-issue-*`) provide agent-friendly tooling. A PR template and docs-check GitHub Action enforce the workflow mechanically.

### Impact
- Positive: Clear traceability from issue to PR; agents always have context before coding
- Positive: Docs-check prevents system changes without doc updates
- Negative: Small overhead for trivial changes (typo fixes exempted)
- Negative: Requires agents to run extra commands (mitigated by scripts)

### Follow-up
- Add branch protection rules to require `issue-link-check` and `docs-check` before merge
- Evaluate whether a staging database should be provisioned
