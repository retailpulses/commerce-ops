# TRD: Copy Form Images to Ticket Attachments

**Status**: in-progress
**Date**: 2026-06-26
**Scope**: Ticket handling worker (cron + portal)
**Related**: Issue #74 (Media optimization)

## 1. Problem Statement

Ticket form images live only in the **Ticket Forms table** (893037) and are accessed via a dynamic cross-table lookup (`fetchLinkedFormData()`) every time a ticket detail is viewed. This indirection:

- **Surprises operators** — the mental model is that images belong to the ticket, not the form
- **Silently fails** — if Order ID normalization misses a form→ticket match, images disappear from the portal with no error
- **Adds per-request latency** — an extra Baserow API call on every ticket detail view
- **Makes the form transient** — if a form row is deleted, the customer's images are lost even though the ticket remains

The Ticket table already has an `Attachments` file field (Baserow field ID 7670326) — it's just never populated.

## 2. Design Decision

**Copy form Attachments to ticket.Attachments at form-processing time.**

| | Before (dynamic lookup) | After (copy at processing) |
|---|---|---|
| Image source | Form table only | Ticket table (primary), Form table (fallback) |
| Portal display | Cross-table lookup per request | Direct from ticket row |
| Failure mode | Silent missing images | Fails visibly at processing time |
| Form deletion | Images lost | Images survive on ticket |
| Extra API calls | +1 per detail view | 0 |
| Mental model | Hidden indirection | Matches user expectation |

## 3. Implementation Plan

### 3.1 Worker: `markTicketFormReceived` adds Attachments

File: `web/worker/src/clients/baserow.ts`

In the PATCH body of `markTicketFormReceived()`, add the form's `Attachments` array under the `Attachments` key. Baserow file fields accept existing file objects with `url`/`name`/`mime_type`/`thumbnails` — copying the full file objects from the form row makes Baserow reuse the stored files.

```ts
// Add to the PATCH object:
"Attachments": form["Attachments"],
```

The form's `Attachments` field is a Baserow file array. Since the ticket is in "Awaiting Customer Form" status (freshly created by the system), there are no existing attachments to merge — direct assignment is safe.

### 3.2 Portal: Use ticket Attachments as primary image source

File: `web/worker/src/handlers/tickets.ts` — `handleGetTicket()`

After fetching the ticket row, extract `row["Attachments"]` and merge it into the `images` array. The cross-table `fetchLinkedFormData()` lookup continues to provide form metadata (description, expected_solution) and acts as a fallback for images.

File: `web/worker/index.ts` — no changes needed

The portal rendering (`renderImages()`, `renderDescription()`) already uses the `TicketImage` interface with `thumbnail_url`/`display_url`/`url` fallback chain. Ticket images from `row["Attachments"]` follow the same `mapFormImages()` path so rendering works without changes.

### 3.3 Backfill: One-time Python script

File: `scripts/backfill_ticket_attachments.py`

Pattern: Same as `scripts/backfill_awaiting_forms.py` — dry-run by default, `--execute` to apply.

Logic:
1. Fetch ALL forms from table 893037 that have non-empty `Attachments`
2. For each form, find the linked ticket via Order ID matching (same variants as `fetchLinkedFormData`)
3. Check if the ticket already has attachments — merge if needed, set if not
4. PATCH the ticket with the merged `Attachments` array
5. Report: `[SKIP]` (no form attachments), `[SKIP]` (no ticket found), `[SKIP]` (already has same files), `[UPDATE]` (patching)

Safety:
- Dry-run mode shows what would change
- Never deletes existing ticket attachments
- Deduplicates by `url` to avoid adding the same file twice
- Logs all PATCH operations

## 4. Files Changed

| # | File | Change |
|---|------|--------|
| 1 | `web/worker/src/clients/baserow.ts` | Add `Attachments` to `markTicketFormReceived` PATCH |
| 2 | `web/worker/src/handlers/tickets.ts` | Extract ticket `Attachments` via `mapFormImages()` in `handleGetTicket` |
| 3 | `scripts/backfill_ticket_attachments.py` | New: one-time backfill script |

No new dependencies. No route changes.

## 5. Backward Compatibility

- **Portal continues to call `fetchLinkedFormData`** for form metadata (description, expected_solution) — images will appear from both sources
- **`mapFormImages()` already handles the same Baserow file field shape** — ticket `Attachments` and form `Attachments` are identical structure
- **If ticket.Attachments is empty/absent**, the portal falls back to form images from the cross-table lookup — no regression

## 6. Acceptance Criteria

- [ ] `markTicketFormReceived` patches ticket with form Attachments
- [ ] Portal shows ticket images from `row["Attachments"]` 
- [ ] Backfill script runs dry-run → shows changes without applying
- [ ] Backfill script runs `--execute` → copies images, no duplicates, no data loss
- [ ] `npm run typecheck && npm run test` passes
- [ ] Manual: form submission → ticket gets Attachments → portal shows images without cross-table lookup dependency

## 7. Residual Risks

- **File URL stability**: If Baserow file URLs change, copied references break. Mitigation: Baserow file URLs are stable; this is the same mechanism Baserow uses internally for file fields.
- **Form→ticket Order ID matching**: The backfill uses the same `orderIdSearchVariants` logic as the worker — edge cases with unusual Order ID formats could miss matches. Mitigation: dry-run output is auditable.
