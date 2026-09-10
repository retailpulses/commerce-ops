# Stale Terminal Review Status Audit

Date: 2026-07-15
Issue: #144
Scope: Supabase `sales_orders`

## Finding

`review_status` is meaningful only while an order is active, but terminal
orders migrated from Baserow retained their previous review value. The portal
therefore showed labels such as `Pending Review` for orders that were already
completed or canceled and could no longer accept review mutations.

The verified production diagnostic found **4,565 terminal rows** representing
**4,564 unique orders**. The grouped baseline was:

| Order status | Review status | Rows |
| --- | --- | ---: |
| `COMPLETED` | `PENDING_REVIEW` | 3,836 |
| `CANCELED` | `PENDING_REVIEW` | 418 |
| `COMPLETED` | `APPROVED` | 252 |
| `COMPLETED` | `AUTO_APPROVED` | 59 |
| **Total** |  | **4,565** |

These counts supersede the preliminary counts in the issue description. The
one-row difference between rows and unique orders is consistent with the
line-level uniqueness of `sales_orders`.

## Cause

The migration preserved historical review values without validating the
combination with `order_status`. The original Supabase schema also made
`review_status` non-null with `PENDING_REVIEW` as its default, even though the
application derives completed/canceled pipeline state solely from
`order_status` and rejects review mutations for terminal orders.

## Decision

Terminal orders use `review_status = NULL` to mean not applicable. Active
orders retain the existing four-value review workflow. This avoids encoding
lifecycle state twice and is recorded in `docs/05_DECISION_LOG.md`.

## Resolution

Status: **implementation pending**

- Migration PR: `<pending>`
- Repair/tooling PR: `<pending>`
- Hosted-write approval: `<pending>`
- Hosted execution timestamp/operator: `<pending>`
- Updated rows: `<pending; expected 4,565 if baseline is unchanged>`
- Postflight diagnostic: `<pending>`
- Portal verification: `<pending>`

Pre-production verification completed:

- Combined repository suite: 700 tests passed.
- Focused terminal-review suite: 173 tests passed.
- PostgreSQL 17 shadow replay: migration applied twice successfully.
- Shadow assertions: column nullable, active default preserved, existing CHECK
  retained, invalid review value rejected.
- Local Supabase CLI: `2.109.1`; Docker Engine: `29.4.1`.

Do not replace these placeholders until the corresponding operation has
completed and its result has been verified.

## Execution Runbook

1. Re-run the read-only grouped diagnostic immediately before execution.
2. Confirm the terminal-row count and capture `id`, `order_status`, and the
   previous `review_status` in an access-controlled rollback artifact.
3. Stop if the live count differs from the reviewed preflight count without an
   explained delta.
4. Obtain explicit approval for the hosted write under database governance.
5. Apply the reviewed nullable schema migration as its own hosted-write gate.
6. Deploy the reviewed Worker and relay prevention paths.
7. Run a fresh read-only audit and have its aggregate result reviewed separately.
8. Run the guarded repair with the reviewed exact expected count. Audit and
   remediation must remain separate commands. The repair uses bounded,
   independently committed batches; it is resumable, not transactional.
   If any batch fails, some earlier batches may already be committed. Do not
   reuse the original expected count: re-run the read-only audit, review the
   new aggregate, and resume with that exact remaining stale count.
9. Re-run diagnostics and require:
   - zero terminal rows with non-null `review_status`;
   - zero active rows with null `review_status` (`active_null`);
   - unchanged terminal row and unique-order totals;
   - unchanged review-status distribution for active orders.
10. Verify the portal:
   - terminal order details show review as not applicable;
   - Completed/Canceled plus Pending Review returns zero rows;
   - Active plus Pending Review continues to return active review work.
11. Observe application health and pipeline error logs for at least two normal
   cron cycles before closing issue #144.

## Rollback

If the nullable contract causes a regression, restore each affected row's
captured previous review value, revert the application change, and repeat the
postflight diagnostics. Project-wide point-in-time recovery is a last resort
because the Supabase project is shared and its blast radius is substantially
larger than this repair.

## Follow-up Debt

After production cleanup is verified, add a database-level cross-column
constraint or trigger enforcing terminal review as null and active review as
non-null. It is intentionally deferred because the constraint cannot validate
while the 4,565 historical violations still exist. Until that follow-up lands,
runtime writers and the postflight `active_null`/terminal diagnostics are the
enforcement boundary.
