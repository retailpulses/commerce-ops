# Source provenance

Phase 1 imports sanitized snapshots of the current default branch, not private Git history.

| Target path | Source repository | Source revision |
|---|---|---|
| `apps/ops-portal` | `retailpulses/ops-portal` | `6740e9a6116ce3d4d9bd9980caa78538ad02bb97` |
| `apps/inquiry` | `retailpulses/inquiry-automation` | `e02ba5f2b81ff67252d2a22a41ec0b0e42464b75` |
| `apps/orders` | `retailpulses/OrderMgmt` | `66008ae6d7394746459649c20ed123e391c9dff8` |
| `apps/tickets` | `retailpulses/ticket-handling` | `7434487ad33e3b3d2d0b89ba9e8c3da054c07ec6` |

These revisions are the audit baseline. If a source repository changes before its snapshot is imported, update this document to the exact imported revision.

## History policy

The source repositories are private while `commerce-ops` is public during this phase. Full history must not be grafted into the public repository. Historical issues, PRs and commits remain available in the original repositories for traceability.
