# Baserow Ticket Pipeline Retirement

Cutover date: 2026-07-14 JST

## Final migration

- Source Tickets table `884687`: 452 rows
- Source Ticket Form table `893037`: 75 rows
- Supabase legacy tickets reconciled: 452/452
- Source product relationships reconciled: 417/417 (418 total legacy-ticket
  links in Supabase because one matched ticket already had a valid link)
- Customer submissions reconciled: 75/75
- Customer submissions linked to tickets: 74/75
- Deterministic legacy order-ID corrections: form `265` (missing final `m`) and
  form `958` (legacy ` Copy` suffix)
- Intentional standalone exception: form `793` has no corresponding legacy
  ticket and remains `needs_manual_review`
- Source attachment references: 437
- Exact duplicate attachment references collapsed: 10
- Unique attachment records reconciled: 427/427
- Orphan attachment records: 0
- Standard evidence in private Supabase Storage: 423
- Oversized evidence references in private R2 archive: 4 references to 2 unique originals
- Source snapshot SHA-256: `963ed833f833cad9fb25305e4c41236ca48a36418e73d0c23fe86d1d182099ba`

The raw snapshot and detailed reconciliation reports are stored under the
gitignored `outputs/baserow-retirement/` directory.

## Incremental reconciliation — 2026-07-30 JST

- Source Ticket Form table `893037`: 77 rows
- Customer submissions reconciled: 77/77
- Customer submissions linked to tickets: 76/77
- Intentional standalone exception remains form `793`
- Unique form attachment records reconciled: 216/216
- Historical form-submission timeline events: 76/76 linked forms
- New forms `1610` and `1611` were linked to order
  `2JSHWwT2bzoQ9dg6RQBik7`
- The two new forms include three evidence files: two JPEGs in private Supabase
  Storage and one PDF in the private `ticketing-legacy-evidence` R2 archive
- Source snapshot SHA-256:
  `5e28b21b5aa90d207836814fd8a6309040e220d9cec812962462f1f735cec2f3`

## Runtime invariant

- Supabase is the sole ticket and customer-submission writer.
- Webhook enrichment classifies directly from Mercari data.
- Scheduled execution performs retry, reconciliation, and webhook checks only.
- Scheduled execution cannot send customer replies.
- Production and staging Workers contain no Baserow credential or binding.
- New after-sales requests use tokenized `/forms/after-sales/:token` URLs.

## Rollback

Rollback means reverting the Supabase application deployment while keeping the
legacy system read-only. The retired Baserow writer must not be restored.

## Change log

- 2026-07-30: Recorded the 77-form incremental reconciliation, linked-form
  timeline-event backfill, and priority-order evidence placement.
- 2026-07-14: Recorded the initial Baserow retirement and 75-form migration.
