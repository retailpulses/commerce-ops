# Source provenance

Phase 1 imports sanitized snapshots of the current default branch, not private Git history.

| Target path | Source repository | Source revision |
|---|---|---|
| `apps/ops-portal` | `retailpulses/ops-portal` | `6740e9a6116ce3d4d9bd9980caa78538ad02bb97` |
| `apps/inquiry` | `retailpulses/inquiry-automation` | `e02ba5f2b81ff67252d2a22a41ec0b0e42464b75` |
| `apps/orders` | `retailpulses/OrderMgmt` | `f3789ca5ca27f8a23b0b6db09c82c0579c3d6702` |
| `apps/tickets` | `retailpulses/ticket-handling` | `7434487ad33e3b3d2d0b89ba9e8c3da054c07ec6` |

These revisions are the audit baseline. If a source repository changes before its snapshot is imported, update this document to the exact imported revision.

## Intentional omissions

The snapshot is not a byte-for-byte copy. Files are omitted when they are generated, operationally sensitive, deployment-specific, or clearly superseded documentation that would misrepresent the current architecture.

Common omissions include source `.git/` and `.github/`, private `.env` files, generated build/cache directories, logs, local work/session reports, and other artifacts listed in `scripts/import-current-snapshots.sh`.

Repo-specific omissions currently include:

| Source repository | Omitted path | Reason |
|---|---|---|
| `inquiry-automation` | `REFACTOR-WORKER.md` | Retired pre-Supabase Baserow/Python Worker migration plan; conflicts with current Supabase-only architecture. |
| `inquiry-automation` | `ROADMAP.md` | Legacy Baserow/CLI roadmap that no longer represents the production system. |
| `ticket-handling` | `scripts/migrate_baserow_ticket_pipeline.py` | Completed one-time Baserow migration tooling; not an active runtime dependency. |
| `ticket-handling` | `TicketHandling架构分析报告.md` | Historical report that still describes Baserow ticket creation and the old inline-SPA topology as current. |

The original private repositories and their Git history remain the historical source of truth for omitted material.

## History policy

The source repositories are private while `commerce-ops` is public during this phase. Full history must not be grafted into the public repository. Historical issues, PRs and commits remain available in the original repositories for traceability.
