# Rakuten RMS R-Messe Order Ticket Pipeline

Status: **Order-qualified automatic ticketing and reviewed outbound approved for production rollout**  
Version: 2.4  
Date: 2026-08-29  
Issue: [#192](https://github.com/retailpulses/ticket-handling/issues/192)

## 1. Decision

Production ingestion and outbound replies must use the official Rakuten RMS
R-Messe API. Zoho/email is not an allowed production source. Undocumented RMS
UI endpoints and browser scraping are also prohibited.

Only inquiries explicitly associated by R-Messe with a Rakuten `受注番号` are
eligible. Product/pre-sale inquiries without that association are excluded.

## 2. Verified facts and current gate

Authenticated RMS inspection confirms that an R-Messe inquiry exposes a stable
`問い合わせ番号`, an exact `受注番号` when order-related, a customer/seller
timeline, attachments, and a reply/send UI.

The zero-write API POC in
`docs/poc/rakuten-rmesse-api-read-poc.md` confirmed that the existing Homebliss
ESA credential can call the official inquiry list and detail endpoints. A
bounded August request returned four order-qualified inquiries; the known
inquiry detail returned its order association, 12 replies, and one reply
attachment reference without exposing customer content in the POC output.

The remaining external/API gates are:

- official rate-limit, retention, pagination-edge, and credential-renewal rules;
- an explicitly approved test inquiry and reply text for the first live send canary.

The operator confirmed `inquirymngapi.reply.post` is `利用中`; outbound API
entitlement is not a blocker.

OrderMgmt currently implements RMS order APIs only. It has no R-Messe client or
credential contract that can be reused as-is.

## 3. Architecture

```text
R-Messe official API
  -> OrderMgmt-owned RMS egress relay (credentials, rate limit, renewal)
  -> ticket-handling scheduled pull
  -> durable inquiry/event inbox
  -> exact order-only qualification
  -> transactional ticket create/find + message append
  -> Ticket Portal timeline + AI draft
  -> reviewed send request/outbox
  -> OrderMgmt relay -> official R-Messe send API
  -> reconcile sent platform message into ticket timeline
```

Ownership:

- OrderMgmt owns RMS credential storage, API egress, license renewal, and
  exact-order enrichment. It must not write ticketing tables.
- ticket-handling owns polling state, inquiry/event durability, qualification,
  tickets/messages, AI drafts, send approval, outbox, and reconciliation.

## 4. Normalized API contract

The API adapter must emit platform-native identifiers, not email identifiers:

```ts
interface RakutenRmesseEvent {
  accountId: string;
  inquiryId: string;
  platformMessageId: string;
  orderNumber: string | null;
  direction: "customer" | "seller" | "system";
  body: string | null;
  occurredAt: string;
  updatedAt: string;
  attachmentRefs: Array<{ id: string; name: string; mimeType?: string }>;
}
```

Exact field mapping remains blocked until the official schema is supplied.

## 5. Order-only qualification

1. Trust only events returned by the authenticated official API.
2. Qualify an inquiry only from the API's explicit order association.
3. Persist `(account_id, inquiry_id) -> order_number` before ticket writes.
4. Later events may inherit only that exact persisted association.
5. Never infer an order from message text, customer identity, product URL, or
   fuzzy matching.
6. Keep unqualified inquiry metadata/body out of ticket storage; record only
   aggregate exclusion metrics.

## 6. Durable inbound behavior

Add ticketing-owned worker-only inquiry, event, and cursor state plus a narrow
transactional ingest RPC. Do not weaken the repository-wide manual-only
`createTicket()` guard.

For each replay-safe platform message ID:

- find or create exactly one active Rakuten ticket by exact account and order
  number; only an official API inquiry with an explicit order association has
  this narrow ticket-creation authority;
- link the inquiry and append customer/seller history;
- set Needs Reply/reopen only for a strictly newer customer event;
- never reopen for seller/system events;
- make overlap polling safe through platform-message-ID uniqueness.
- persist every initial/reply attachment reference directly as idempotent
  `platform_message` evidence, including attachment-only customer replies;
- download image attachments through the fixed-egress OrderMgmt relay using
  the official `attachment?label={label}&path={path}` operation;
- validate a 20 MiB maximum, declared MIME, and binary signature before writing
  to private `ticket-attachments` Storage under a content-hash path;
- idempotently upgrade the existing `platform_message` reference row in place,
  retaining `reference_only` evidence for bounded retry when download, validation,
  Storage, or metadata update fails.

The repository-wide operator `createTicket()` guard remains unchanged. Product
and pre-sale inquiries without an explicit API order association cannot use the
narrow ingest RPC and remain excluded without storing their content.

`InquiryManagementAPI` does not expose the direction of the initial inquiry
message. The adapter must therefore store it as `system`, never infer customer
direction from its content, and grant customer-message semantics only to
replies explicitly marked `replyFrom=user`. New tickets require the same
authenticated manual or validated TicketForm authority used by Mercari.

The production poller must declare a bounded workload, kill switch, request
budget, overlap window, retry cap, cursor semantics, and release mapping before
activation.

Pull strategy:

- dedicated Cloudflare cron every two minutes;
- query from the durable `cursor_updated_at` minus a ten-minute overlap;
- page through at most 20 pages of 100 summaries per invocation;
- fetch detail only when the summary has a non-empty `orderNumber`;
- advance the cursor only after the complete active run succeeds;
- deduplicate the initial message by inquiry identity and replies by native
  `replies[].id`;
- leave the existing heavier Mercari cron schedules unchanged.

The available InquiryManagementAPI does not expose a webhook/event-subscription
operation. Polling is therefore the supported near-real-time mechanism unless
Rakuten adds a separate push API.

## 7. Portal AI copywriting and send

Rakuten tickets must use the existing Ticket Portal composer to:

1. generate/edit an AI reply using the ticket timeline, order context, and the
   current resolution guide;
2. require an operator review and explicit Send action;
3. create an idempotent send intent before calling RMS;
4. send through the official R-Messe API using the inquiry identifier;
5. reconcile the returned platform message ID into `sent_messages` and
   `ticket_messages`;
6. clear Needs Reply only after confirmed platform acceptance/reconciliation.

Timeout or ambiguous responses remain `unknown` and must be reconciled before
retrying. Never blindly resend. Attachments are disabled until the official
upload/send contract is verified.

## 8. Rollout

1. Obtain official docs/license and run a zero-write API discovery POC.
2. Implement relay/client, migrations, normalized ingestion, and tests.
3. Shadow-poll with zero ticket/message writes for at least two healthy cycles.
4. With explicit hosted-write approval, canary one exact order inquiry and its
   conflict-safe automatic Ticket creation.
5. Enable AI draft; canary one reviewed text-only reply and reconcile it.
6. Activate bounded polling; backfill only within the documented API retention
   window after separate approval.

Kill switches must independently disable inbound polling and outbound send.

## 9. Acceptance criteria

- An order-associated inquiry creates or links exactly one Rakuten ticket.
- Platform ingestion cannot create a ticket without an explicit order association.
- Later messages append idempotently through the exact inquiry mapping.
- Pre-sale/unqualified inquiries never create, link, append, or reopen tickets.
- Ticket Portal can generate, edit, review, and send a Rakuten reply.
- Ambiguous send results cannot produce duplicate customer messages.
- Confirmed seller sends append to the timeline and clear Needs Reply safely.
- Logs contain no body, customer PII, full order number, credential, or share URL.
- Canonical `ops.homesbliss.net/tickets` behavior is verified after deployment.

## 10. Version history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-08-22 | Email-source design after notification-format POC |
| 2.0 | 2026-08-23 | Replaced email source with official API; added Portal AI/send and send safety |
| 2.1 | 2026-08-23 | Recorded successful official read API POC and isolated outbound permission gate |
| 2.2 | 2026-08-23 | Corrected outbound entitlement: reply.post confirmed active |
| 2.3 | 2026-08-24 | Removed platform auto-create authority and made directionless initial messages neutral |
| 2.4 | 2026-08-30 | Added direct evidence-reference ingestion for R-Message attachments |
| 2.5 | 2026-09-01 | Verified official binary download and added private Evidence storage with reference fallback |
| 2.4 | 2026-08-29 | Restored narrowly scoped, order-qualified automatic Ticket creation and capability-aware Portal send controls |
