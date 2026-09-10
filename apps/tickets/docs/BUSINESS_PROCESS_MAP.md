# Ticket Handling Business Process Map

Status: current-code review baseline
Reviewed: 2026-07-14 JST

P0/P1 delivery plan: `docs/CORE_PROCESS_P0_P1_REMEDIATION_PLAN.md`

This document maps the business processes implemented by the repository. It is
the control document for detecting drift between business policy, application
behavior, database behavior, and older design documents.

## 1. Governing business rules

1. Supabase is the only live ticket-system source of truth.
2. Baserow ticket data is historical and read-only.
3. Receiving or classifying a platform message must not create a ticket.
4. Ticket creation is allow-listed to:
   - an explicit operator action, including the queue's **Convert to Ticket**
     action; or
   - successful receipt of a validated tokenized after-sales form.
5. Automatic processes may create and enrich inbound queue records, retry
   failed enrichment, reconcile missed webhooks, and link messages to an
   already-existing ticket. They must not create tickets.
6. Customer evidence must remain linked to its submission and, once a ticket
   exists, also be linked to that ticket.
7. Scheduled processing must not send customer replies.
8. Platform-specific adapters may fetch conversations and send replies, but
   must not decide ticket lifecycle policy.

## 2. System boundaries

| Boundary | Business role | System of record |
|---|---|---|
| Mercari | Order conversation and reply delivery | Mercari |
| Inbound queue | Durable intake and operator triage | Supabase `inbound_ticket_messages` |
| Ticket workspace | Case management | Supabase ticket tables |
| Public after-sales form | Customer intake and evidence | Supabase submissions and private Storage |
| Product/account masters | Shared reference data | Existing Supabase master tables |
| Sessions/templates | Short-lived authentication and managed template state | Cloudflare KV |
| Baserow | Historical provenance only | Read-only Baserow records and migrated snapshots |

Terminology used in this map:

- **TicketForm** means the public, token-protected after-sales webpage. The page
  is customer-facing; it is not a private form.
- **Private evidence storage** means the submitted photos/videos are not
  anonymously browsable. Access must use authenticated or time-limited URLs.
- **TicketForm request message** means the Mercari message containing the
  tokenized TicketForm URL. It may be sent automatically after classification.
- **Convert to Ticket** means an authenticated operator deliberately creates a
  ticket from a queue message. This is valid manual ticket creation, not
  message-driven automatic creation.

## 3. Core business process

```text
Buyer message
    |
    v
1. Message-to-TicketForm
   classify -> decide -> auto-reply with tokenized form
   NO TICKET CREATED
    |
    v
Validated TicketForm submission + evidence
    |
    v
2. TicketForm-to-Ticket
   create exactly one ticket -> link submission and evidence
    |
    v
3. Ticket-to-Resolution
   investigate -> communicate -> act -> resolve -> close
```

Manual operator creation is a controlled bypass into process 3. It does not
change the rule that messages themselves cannot create tickets.

### 3.1 Message-to-TicketForm

**Business purpose:** detect an after-sales case, acknowledge it quickly, and
collect structured customer evidence without creating a premature ticket.

**Trigger:** Mercari sends `order_transaction_message_created`.

Approved process:

1. Authenticate and validate the webhook.
2. Persist an idempotent `inbound_ticket_messages` record before processing.
3. Fetch the complete order conversation.
4. Classify the full conversation, not only the latest message.
5. Decide whether the message needs:
   - no action;
   - operator review;
   - a non-form acknowledgement; or
   - an after-sales TicketForm request.
6. When a TicketForm is required, create a pre-ticket submission token carrying
   platform, account, order, and product context.
7. Apply confidence, seller-replied, duplicate-form, and duplicate-holding-reply
   guardrails.
8. Send the approved automatic TicketForm request message containing the
   tokenized form URL.
9. Store classification, decision, reply outcome, and reason in the queue row.
10. If an existing ticket already matches the order, link the message to it;
    otherwise leave the message in the operator queue.

**Hard boundary:** this process never creates a ticket. Classification fields
are advisory and must not call a ticket-creation method.

Current implementation status:

- Durable intake, full-conversation classification, retry, reconciliation, and
  linking to existing tickets are implemented.
- Webhook enrichment currently cannot send a reply.
- Token creation currently happens only during an operator send on an existing
  ticket, not before ticket creation.
- The operator's **Convert to Ticket** action is an approved manual path. The
  classification field `should_convert_to_ticket` and “Auto-Convert” label are
  only recommendations today, but their names are ambiguous and must never be
  wired to automatic execution.

**Primary code:** `handlers/webhooks.ts`,
`services/inboundClassificationService.ts`, `services/inboundMessageService.ts`,
`services/messageSendService.ts`, `logic/templates.ts`.

**Primary issue:** #131 for webhook-triggered reply execution. Its acceptance
criteria must prohibit ticket creation.

### 3.2 TicketForm-to-Ticket

**Business purpose:** treat a completed, validated form as confirmed customer
intent and create a fully evidenced case exactly once.

**Trigger:** customer submits `/api/forms/submit/:token`.

Approved process:

1. Validate token hash, status, expiry, allowed submission type, and the
   approved upload policy: up to 100 MB per file so customer videos are
   accepted.
2. Claim the token or operation idempotently so concurrent submissions cannot
   create duplicates.
3. Validate the description, expected solution, and evidence files.
4. Create one `customer_submissions` row.
5. Store accepted evidence in private Storage and create attachment records.
6. If the token already references a valid ticket, link the submission to it
   without creating another ticket.
7. Otherwise create exactly one ticket with `origin=form_submission` using the
   token and form context.
8. Link `customer_submissions.ticket_id` to the ticket.
9. Link every evidence row with both `customer_submission_id` and `ticket_id`.
10. Link the applicable product/SKU when the token contains resolvable product
    context.
11. Record ticket-created, submission-received, and attachment-added events.
12. Mark the token used only after all required database relationships succeed.
13. On retry, return the same ticket/submission result without duplicate rows or
    files.

The system must accept the original upload before any later compression job.
Compression may create a smaller working copy asynchronously, but must not make
form submission depend on long-running video processing or discard the original
until retention policy explicitly permits it.

Current implementation status:

- Token validation, submission persistence, private upload, and attachment rows
  are implemented.
- The handler currently rejects files above 10 MB, so the approved 100 MB video
  requirement is not implemented.
- Existing-ticket forms can be linked.
- Pre-ticket form submission does not create a ticket.
- Pre-ticket attachments remain linked only to the submission and are not
  back-linked to a ticket.
- The operation is not yet a single transactional/idempotent business action.

**Primary code:** `handlers/customer-form.ts`, `handlers/copywriting.ts`,
Supabase `customer_submissions`, `submission_tokens`, `ticket_attachments`, and
`tickets` tables.

**Primary issue:** #136.

### 3.3 Ticket-to-Resolution

**Business purpose:** give an operator one controlled case record from confirmed
intake through remedy and closure.

**Entry paths:**

- a ticket created by process 3.2 after validated TicketForm receipt;
- explicit operator creation from `/ticketing/new`; or
- an explicit operator **Convert to Ticket** action in the inbound queue.

Approved process:

1. Confirm platform, account, external order, customer, problem description,
   priority, and issue type.
2. Link products/SKUs and all available customer evidence.
3. Review the complete platform conversation and internal event history.
4. Investigate and add internal notes.
5. Define a resolution guide or action: information, replacement, refund,
   return, supplier escalation, or another controlled outcome.
6. Generate an AI-assisted reply when useful; the operator reviews it.
7. Before sending, fetch the current platform thread and block stale replies.
8. Send the operator-approved reply and write platform, message, and audit
   records.
9. Move the ticket through valid statuses while recording actor and reason.
10. Record the actual resolution action and close the ticket.
11. Reopen only for a verified new customer/platform follow-up or an explicit
    operator decision.

Current implementation status:

- Manual creation, queue conversion, field/status updates, product links,
  notes, events, AI drafting, thread freshness checks, and manual Mercari send
  are implemented.
- Queue conversion is human-triggered but is audited as `platform_ingest` with
  a system actor rather than as an operator decision.
- Operator attachment upload/list/delete is not wired end to end.
- Resolution-action tables exist, but the active UI/API does not expose a clear
  resolution-action process.
- Adding any ticket message currently reopens closed/resolved/canceled tickets,
  even when it is not verified customer follow-up.

**Primary code:** `services/ticketService.ts`,
`services/copywritingService.ts`, `services/messageSendService.ts`,
`repositories/supabaseTicketRepository.ts`, `components/tickets/detail/*`.

## 4. Supporting processes

### 4.1 Missed-message recovery

Four times daily, scheduled processing retries failed enrichment and reconciles
recent Mercari conversations for webhook gaps. It may insert queue records and
link them to existing tickets. It must not create tickets, send replies, or
access Baserow.

### 4.2 Operator queue control

Operators can mark messages read/unread, ignore them, link them to existing
tickets, or explicitly create a ticket. The current **Convert to Ticket** action
counts as manual creation because it requires an authenticated human action.
Classification must never trigger it automatically.

### 4.3 Evidence storage

Evidence may come from a customer TicketForm, migrated Baserow history, or an
operator upload. The TicketForm is public through an unguessable expiring token;
the uploaded evidence is private. Records must preserve source, submission,
ticket, media metadata, and immutable storage location.

### 4.4 Deployment and operational control

Pull requests build and validate the frontend and Worker. Pushes to `main`
deploy staging; production requires workflow dispatch from `main`. Health
reports inbound processing counts. Staging and production currently share the
same Supabase project.

## 5. Ticket lifecycle

```text
open
  -> in_progress | pending_customer | pending_third_party | closed | canceled
in_progress
  -> pending_customer | pending_third_party | resolved | closed | canceled
pending_customer
  -> in_progress | resolved | closed | canceled
pending_third_party
  -> in_progress | resolved | closed | canceled
resolved | closed | canceled
  -> open
```

The transition map is enforced in TypeScript and status values are also
constrained in Postgres.

## 6. Drift and control register

| Priority | Finding | Business risk | Required decision/action |
|---|---|---|---|
| P1 | Form receipt cannot yet create a ticket or back-link evidence | Approved creation path is incomplete | Implement issue #136 transactionally and idempotently |
| P1 | Operator attachment component is disconnected and backend routes are absent | Original manual MVP evidence workflow is unavailable | Implement or explicitly remove from product scope |
| P1 | Queue conversion is operator-triggered but writes `origin=platform_ingest` and a system creation event | Audit trail cannot prove the human creation decision | Record operator actor and manual/queue-review origin |
| P1 | TicketForm currently rejects files above 10 MB instead of the approved 100 MB | Customer videos cannot enter the evidence process | Add a 100 MB-capable upload path; compress asynchronously later |
| P2 | Status options come from `ticket_statuses`, while service transitions and DB checks are hard-coded | Dashboard-added statuses can appear in UI but fail on save | Choose truly configurable workflow or explicitly fixed statuses |
| P2 | Adding any ticket message reopens closed/resolved/canceled tickets | An operator-side record can reopen a case without new customer contact | Restrict automatic reopen to verified customer/platform follow-up |
| P2 | `should_convert_to_ticket` and “Auto-Convert” sound automatic although conversion requires an operator | Future code may mistake advice for authority | Rename to `recommended_for_manual_creation`; retain explicit operator action |
| P2 | Auto-reply strategy document still describes Baserow writes and ticket mutations | Stale design may be reimplemented accidentally | Rewrite it around Message-to-TicketForm with no ticket creation |
| P2 | Staging and production share Supabase | Tests can mutate production data | Establish isolated staging data or strict read-only fixtures |
| P3 | WeCom client exists with no caller or configured Worker secret | Dead capability obscures the real notification process | Retire it or define and test its business trigger |

## 7. Review checklist for every process-changing PR

1. Which business trigger starts the process?
2. Is the action automatic or explicitly operator-authorized?
3. Can it create a ticket? If yes, is it one of the two allow-listed paths?
4. Which tables, storage objects, and external systems are mutated?
5. What idempotency key or unique constraint prevents duplication?
6. What actor and origin will the audit trail record?
7. What happens on partial failure and retry?
8. Can it send a customer-facing message?
9. Does it change status, `needs_reply`, or reopen a ticket?
10. Are attachments linked to both their submission and ticket where required?
11. Does it depend on platform-specific details inside the core ticket domain?
12. Which test proves the governing business rule remains true?

Any PR that changes the answers must update this process map and its relevant
decision record before deployment.
