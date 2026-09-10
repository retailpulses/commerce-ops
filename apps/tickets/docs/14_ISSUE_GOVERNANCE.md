# Issue Governance

## Issue-First Development

Retailpulses uses Issue-first development for mergeable engineering work. Exploration and local investigation can happen before an Issue. Mergeable coding cannot start without a compliant Issue. Emergency hotfixes may create a minimal Issue first, but the Issue must be corrected before PR merge.

## Issue Creation Rule

No raw `gh issue create --body` for normal development work.

Agents must create Issues using:

1. `bin/rp-issue-create`, or
2. The repository GitHub Issue Form/template through the GitHub UI, or
3. An explicit user-approved exception.

If an Issue is created outside governance format, it must be corrected before coding begins.

## Creating Issues

Use `bin/rp-issue-create` with the appropriate type:

```
bin/rp-issue-create feature
bin/rp-issue-create bug
bin/rp-issue-create architecture
bin/rp-issue-create data-model
bin/rp-issue-create docs
bin/rp-issue-create workflow
```

The command generates `.tmp/issue-draft.md` with all required governance sections. Review and edit the draft before submission.

## Auditing Existing Issues

Run `bin/rp-issue-audit <issue-number>` to check whether an existing Issue follows governance.

- **PASS** — all required sections present
- **WARN** — sections present but impact may be inconsistent
- **FAIL** — sections missing

Generate a correction draft with `bin/rp-issue-audit <issue-number> --fix-draft`.

## Correcting Non-Compliant Issues

If an Issue fails audit, it must be corrected before mergeable coding starts. Use the generated correction draft to update the Issue.

## Exceptions

- Exploration and local investigation can happen before an Issue.
- Mergeable coding cannot start without a compliant Issue.
- Emergency hotfixes may create a minimal Issue first, but the Issue must be corrected before PR merge.
