# Deployment and Housekeeping

## Why Deploy Closeout Is Different From PR Closeout

PR closeout (`rp-issue-closeout`) happens before the PR is opened. It checks Issue governance, generates the PR summary, and ensures docs are updated.

Deploy closeout (`rp-deploy-closeout`) happens after the code is deployed to production or staging. It records what was deployed, confirms the environment, and captures smoke test results.

Repo housekeeping (`rp-repo-housekeeping`) runs after deploy or before the next task. It checks whether the repo is clean, documented, and ready for the next engineering task.

## Lifecycle

| Step | When | Tool |
|------|------|------|
| Before coding | Issue audit and work brief | `rp-issue-work` |
| Before PR | Governance checks and PR summary | `rp-issue-closeout` |
| After deploy | Deploy closeout report | `rp-deploy-closeout` |
| After deploy / before next task | Repo housekeeping check | `rp-repo-housekeeping` |

## Default Output Destinations

Reports default to GitHub-native destinations in order of preference:

1. **GitHub Actions job summary** (`$GITHUB_STEP_SUMMARY`) — available when run as a workflow step
2. **PR comment** — when a related PR can be detected and `--comment-pr` is passed
3. **Issue comment** — when a related Issue can be detected and `--comment-issue` is passed
4. **GitHub Actions artifact** — when `--artifact` is requested (uploaded as workflow artifact)

Reports are written temporarily to `.tmp/` during workflow runs. The `.tmp/` directory is gitignored and reports must not be committed.

## Rules

- Do not commit routine deploy reports to the repo.
- Only update docs (CURRENT_STATE, DECISION_LOG, DATA_MODEL) when system state, data model, or architecture actually changed.
- Follow-up Issues should be created for real problems, not routine noise.
- v1 is informational and non-blocking.

## Related Scripts

- `bin/rp-deploy-closeout` — generate a post-deploy closeout report
- `bin/rp-repo-housekeeping` — check repo hygiene after deployment
