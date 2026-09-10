# Phase 1 import omissions

These omissions are intentional and are not treated as lost source. The original private repositories remain the historical record through migration and archive.

## Omitted from all four initial snapshots

- `.git/` and all private Git history
- source-repository `.github/` workflows/templates; monorepo CI is ported separately and path-scoped
- local environment files and `.dev.vars`
- dependency trees and generated build output (`node_modules`, `dist`, `build`, coverage, caches)
- local IDE/agent state such as `.serena`
- logs and runtime artifacts
- operational report/worklog/session-closeout folders that have not been reviewed for public release
- raw browser/network captures such as HAR files

## Baserow-specific handling

- `apps/inquiry`: no Baserow runtime implementation may be imported. Historical architecture documents may be retained only after review.
- `apps/tickets`: no Baserow runtime implementation may be imported. `scripts/migrate_baserow_ticket_pipeline.py` remains in the original private repository as historical migration tooling and is deliberately omitted from the active monorepo tree.
- `apps/orders`: Baserow compatibility remains temporarily because current OrderMgmt still carries a governed compatibility path. It must not be extracted into shared packages or used by new code.

## Why source `.github/workflows` are not copied with app snapshots

Nested workflow files would not execute as GitHub Actions workflows, while copying them to the monorepo root unchanged could accidentally deploy production or multiply Actions usage. CI/deploy workflows are therefore migrated separately after path, secret, environment and runtime-target review.

## Recovery

Anything omitted remains available in the original private source repositories. Old repositories must not be archived until Phase 2 production-source parity and rollback verification are complete.
