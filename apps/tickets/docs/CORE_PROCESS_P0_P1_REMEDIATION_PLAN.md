# Core Process P0/P1 Remediation Plan

Status: implemented; deployment gates pending
Date: 2026-07-14 JST
Business process baseline: `docs/BUSINESS_PROCESS_MAP.md`

## 1. Objective

Make the following funnel complete, safe, observable, and regression-tested:

```text
Message-to-TicketForm -> TicketForm-to-Ticket -> Ticket-to-Resolution
```

The ticket creation allow-list remains:

1. explicit authenticated operator creation, including **Convert to Ticket**;
2. successful finalization of a validated TicketForm.

Webhook intake, classification, automatic replies, cron, and reconciliation
must never create a ticket.

## 2. Priority assessment

There is no confirmed whole-system outage. Issue #140 tracks the P0 evidence
integrity boundary: silent upload skipping, concurrent same-token submission,
and ambiguous committed-response cleanup could each lose evidence or falsely
confirm it. These code paths are now fail-closed and regression-tested; the P0
remains open until the migrated staging flow passes a real private-object test.

The remaining gaps are P1 because the core automated funnel cannot complete or
operators cannot use its evidence and resolution records end to end.

## 3. Issue definitions

### P0-A — Prevent silent TicketForm evidence loss

**Issue:** #140 — `P0: TicketForm must not succeed or consume token when selected evidence fails`

**Current evidence:** `handlers/customer-form.ts` skips files above 10 MB and
continues after Storage upload errors. It later marks the token used and can
return success.

**Business impact:** irreversible loss of customer evidence and false customer
confirmation.

**Acceptance criteria:**

1. Validate selected file count, type, and size before final submission.
2. Approved maximum is 100 MB per file.
3. No selected file may be silently skipped.
4. If any required upload or attachment-row write fails, return a clear error
   and keep the token retryable.
5. A retry must not duplicate successfully staged objects or database rows.
6. Success response lists every accepted file and matches stored attachment
   rows exactly.
7. Structured logs distinguish validation, upload, database, and token errors.
8. Regression tests cover 10 MB, 100 MB, over-100 MB, partial failure, retry,
   and concurrent submit.
9. A concurrent losing submission returns conflict and never claims its staged
   evidence was linked.
10. An ambiguous RPC outcome preserves evidence unless an authoritative read
    proves the token remains active and unlinked.
11. A replay succeeds only when the finalized attachment path set exactly
    matches the original submission.

**Immediate containment:** fail closed with the current transport before
enabling 100 MB. Do not wait for the complete direct-upload implementation to
stop silent success.

**Dependencies:** none.

### P1-B — Message-to-TicketForm automatic request

**Existing issue:** #131, rewrite its scope and acceptance criteria.

**Proposed title:** `P1: Message-to-TicketForm classification and idempotent automatic request`

**Scope:** webhook message -> full-thread classification -> guarded automatic
TicketForm request message -> audited outcome. No ticket creation.

**Acceptance criteria:**

1. Classify the full conversation and record model, prompt version, confidence,
   decision, and reasons.
2. Decision output distinguishes `no_action`, `operator_review`,
   `non_form_reply`, and `ticketform_request`.
3. `ticketform_request` creates a pre-ticket token containing platform,
   account, order, product name, and SKU context.
4. Send the tokenized TicketForm request through the webhook action path.
5. Idempotency guarantees at most one automatic message per inbound event and
   prevents repeated TicketForm requests for the same active case window.
6. Seller-replied, confidence, duplicate-form, duplicate-holding, account, and
   order-status guardrails fail to operator review rather than sending.
7. Persist reply state: `not_attempted`, `blocked`, `sending`, `sent`, or
   `failed`, plus platform message ID and reason.
8. Retry may resend only when no successful platform message exists.
9. Static/runtime tests prove this path cannot insert into `tickets` or call a
   ticket-creation method.
10. Feature flag supports shadow, limited-shop, and active modes.

**Dependencies:** P0-A containment. Pre-ticket token schema from P1-D may be
landed first without enabling ticket creation.

### P1-C — 100 MB private evidence transport and operator access

**Existing issue:** #102, rewrite because it currently claims the attachment
baseline is fully wired when it is not.

**Proposed title:** `P1: 100 MB TicketForm evidence upload and authenticated ticket access`

**Architecture:** direct browser-to-private-Supabase upload using signed upload
authorization or TUS resumable upload. Do not proxy 100 MB multipart bodies
through the Worker. Compression is asynchronous and preserves the original
until retention policy permits deletion.

**Acceptance criteria:**

1. Token validation authorizes uploads only under a server-selected staging
   prefix; customers cannot choose arbitrary object paths.
2. Accept supported image/video files up to 100 MB each.
3. Browser shows upload progress, retry, completion, and actionable errors.
4. Server finalization verifies object existence, size, MIME/signature, token,
   and staging prefix; client metadata alone is not trusted.
5. Storage remains private. Operators receive short-lived signed read URLs.
6. Ticket detail mounts the attachment tab and supports list, preview/download,
   operator upload, and audited deletion.
7. Abandoned staged uploads are removed by a safe cleanup job after a defined
   retention window.
8. Compression runs after acceptance, creates a working derivative, records
   original/derivative relationship, and cannot block form completion.
9. Tests cover interrupted/resumed upload, expired token, wrong path, spoofed
   MIME, 100 MB boundary, signed-read expiry, and cleanup exclusion for linked
   evidence.

**Dependencies:** paid Supabase project upload-size configuration verified at
or above 100 MB; P0-A error semantics.

### P1-D — TicketForm-to-Ticket transactional finalization

**Existing issue:** #136.

**Scope:** validated token + staged evidence -> exactly one submission and one
ticket -> complete evidence/product/event linkage.

**Acceptance criteria:**

1. Finalization is implemented as one database RPC/transaction or equivalent
   server-enforced idempotent operation.
2. Lock or atomically claim the token before ticket creation.
3. Existing-ticket token links to that ticket without creating another.
4. Pre-ticket token creates exactly one ticket with
   `origin=form_submission`.
5. The platform/account/order unique constraint is handled deterministically;
   an existing matching ticket is linked rather than treated as an unknown
   failure.
6. Create/link `customer_submissions` exactly once.
7. Every finalized attachment retains `customer_submission_id` and receives
   `ticket_id`.
8. Resolve and link product/SKU context when available; unresolved products do
   not lose the submission.
9. Record ticket-created, submission-received, and attachment-added events with
   correct actors and payloads.
10. Mark the token used only after required relationships succeed.
11. Return the same ticket/submission result on retry or concurrent submission.
12. Surface irrecoverable failures in an operator-visible review queue.

**Dependencies:** P1-C upload finalization contract. Can be developed against
small fixture objects in parallel.

### P1-E — Enforce ticket-creation authority and audit attribution

**Proposed title:** `P1: Enforce ticket creation allow-list and operator attribution`

**Scope:** prevent future architecture drift and accurately record manual queue
conversion.

**Acceptance criteria:**

1. Centralize ticket creation behind a domain command that requires creation
   source and actor.
2. Allowed sources are explicit operator creation, operator queue conversion,
   and TicketForm finalization.
3. Webhook, classifier, retry, reconciliation, and automatic-reply modules have
   no ticket-create dependency.
4. Queue conversion records the authenticated operator, not actor `system`.
5. Queue conversion uses a clear manual source/origin while preserving inbound
   message provenance separately.
6. Rename advisory `should_convert_to_ticket`/“Auto-Convert” to
   `recommended_for_manual_creation` or equivalent.
7. Architecture tests fail when a prohibited module gains ticket-write access.

**Dependencies:** coordinate with P1-B and P1-D domain interfaces.

### P1-F — Ticket-to-Resolution evidence and outcome workflow

**Proposed title:** `P1: Complete Ticket-to-Resolution evidence and resolution-action workflow`

**Scope:** ensure operators can use the ticket created by the funnel through a
recorded business outcome.

**Acceptance criteria:**

1. Ticket detail displays all customer and operator evidence using signed URLs.
2. Operator can add evidence up to the approved limit and delete it with an
   audit event and explicit confirmation.
3. UI/API can record resolution action type, amount/currency where applicable,
   notes, external reference, and actor.
4. Closing/resolving a ticket requires or explicitly waives a resolution action
   according to agreed business rules.
5. Status, resolution action, customer reply, and `needs_reply` changes have one
   coherent transaction/order of operations.
6. Automatic reopen occurs only for verified new customer/platform contact;
   operator-added notes/messages do not silently reopen a ticket.
7. Existing duplicate timeline issue #120 is fixed or explicitly tolerated by
   deterministic message deduplication.

**Dependencies:** P1-C signed evidence access. Resolution portion can proceed in
parallel.

### P1-G — Core funnel end-to-end deployment gate

**Proposed title:** `P1: Add end-to-end contract test for Message-to-TicketForm-to-Resolution`

**Scope:** prevent future twists from silently breaking a handoff.

**Acceptance criteria:**

1. Test fixture creates an inbound buyer message without creating a ticket.
2. Classification produces a TicketForm request and one pre-ticket token.
3. Duplicate webhook/retry does not send a second message.
4. Simulated 100 MB evidence flow finalizes one form and one ticket.
5. Submission and all attachments are visible on the ticket.
6. Operator records a resolution action, sends a reply, and closes the ticket.
7. Retry of every external boundary remains idempotent.
8. Test asserts no Baserow call and no prohibited automatic ticket creation.
9. Staging deployment fails if the contract smoke test fails.
10. Test data is isolated from production business records and cleaned safely.

**Related issue:** #12 covers only generic staging health and should be expanded
or linked, not treated as sufficient coverage.

**Dependencies:** P1-B through P1-F.

### P1-H — Authenticated queue acceptance

**Existing issue:** #116.

This is a short verification gate rather than a new build if the current route
works. Complete an authenticated browser test covering queue render, API calls,
manual link, and manual Convert to Ticket. Close or narrow #116 based on the
evidence.

## 4. Issue hygiene before implementation

1. Rewrite #131, #102, and #136 to the contracts above.
2. Create P0-A and P1-E through P1-G.
3. Keep #116 only until authenticated acceptance is proven.
4. Close or re-scope stale overlaps:
   - #90: classifier history handling appears implemented; automatic request
     delivery belongs to #131.
   - #85: close after current classifier contract tests are mapped to its
     acceptance criteria.
   - #92: manual ticket creation is implemented.
   - #99: old Baserow runtime/frontend retirement is implemented.
   - #105: PR frontend build is implemented and recent PR checks pass.
   - #13: legacy Python decision is complete except the intentional migration
     utility.
5. Every issue must contain business trigger, automatic/manual authority,
   mutations, idempotency, actor/origin, failure behavior, observability,
   rollout, rollback, and tests.

## 5. Execution sequence

### Phase 0 — Same-day safety containment

1. Implement P0-A fail-closed behavior.
2. Add telemetry for upload failures and token consumption.
3. Deploy behind no feature flag because silent success is unsafe.
4. Verify an upload failure leaves the token usable.

**Exit gate:** no selected file can be silently lost while the customer receives
success.

### Phase 1 — Evidence transport foundation

1. Implement P1-C signed/resumable 100 MB uploads.
2. Verify paid-project Storage upload configuration.
3. Add private signed reads and abandoned-upload cleanup.

**Exit gate:** 100 MB fixture uploads, resumes, finalizes, and can be viewed by
an authenticated operator.

### Phase 2 — TicketForm-to-Ticket

1. Implement P1-D transactional finalization.
2. Add creation-authority primitives from P1-E.
3. Validate existing-ticket and pre-ticket token paths.

**Exit gate:** repeated/concurrent finalization produces one ticket, one
submission, correct evidence links, and complete events.

### Phase 3 — Message-to-TicketForm

1. Implement P1-B decision and reply outbox/idempotency.
2. Run shadow mode and compare decisions with operator review.
3. Enable one shop, then expand after defined error/duplicate thresholds pass.

**Exit gate:** eligible message receives one TicketForm request and creates no
ticket until the form is submitted.

### Phase 4 — Ticket-to-Resolution

1. Complete P1-F operator evidence and resolution actions.
2. Correct manual conversion audit attribution.
3. Correct reopen and timeline dedup behavior.

**Exit gate:** operator can see the form evidence, record the remedy, send the
final response, and close the ticket with a complete audit trail.

### Phase 5 — Regression and rollout gate

1. Implement P1-G end-to-end contract test.
2. Complete #116 authenticated queue acceptance.
3. Add the contract test to staging deployment.
4. Roll production by feature flag with monitoring and rollback switches.

## 6. Observability and release gates

Track at minimum:

- webhook received, deduplicated, enriched, failed;
- classification decision by type and confidence;
- TicketForm request attempted, blocked, sent, failed, duplicate-prevented;
- token created, opened, expired, submitted, retried;
- upload started, completed, failed, abandoned, cleaned;
- submission finalized, ticket created, existing ticket linked, failed;
- attachment count selected versus finalized;
- ticket resolution action and time-to-resolution;
- prohibited ticket-creation attempt count, expected to remain zero.

Production activation gates:

1. zero silent upload-success mismatches;
2. zero duplicate automatic replies in replay tests;
3. zero duplicate tickets under concurrent finalization;
4. 100% attachment selected/finalized reconciliation for successful forms;
5. no Baserow runtime dependency;
6. successful authenticated queue and complete-funnel smoke tests.

## 7. Definition of done

The remediation is complete only when a real or production-equivalent buyer
message can receive one TicketForm request, submit a 100 MB video, create one
ticket with visible evidence, and be resolved and closed by an operator—with
every retry remaining idempotent and no automatic message path creating a
ticket directly.

## 8. Current issue and release state

| Issue | Priority | Implementation | Release gate |
|---|---:|---|---|
| #140 evidence integrity | P0 | Complete in worktree | Real direct upload + ambiguous retry on staging |
| #141 creation authority | P1 | Guarded; manual conversion and form finalization only | Static guard + authenticated conversion smoke |
| #131 Message-to-TicketForm | P1 | Complete, default `shadow` | Shadow review, then one-shop `limited` |
| #102 private 100 MB evidence | P1 | Direct upload/read implemented | Supabase object limit and 100 MB fixture |
| #136 transactional finalization | P1 | Complete | Migration + concurrency smoke |
| #138 Ticket-to-Resolution | P1 | Complete | Operator evidence/resolution smoke |
| #139 full-funnel E2E gate | P1 | Unit/contract coverage complete | Production-equivalent end-to-end smoke |

No P0/P1 issue is considered released merely because its code is present. The
database migrations, stable signing secret, private Storage limit, R2 binding,
and staging acceptance checks are hard deployment gates.
