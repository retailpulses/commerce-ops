# Amazon Buyer Message Mail Workflow

Issue: <https://github.com/retailpulses/ticket-handling/issues/235>

Canonical execution plan:
[`docs/plans/issue-235-amazon-mail-canonical-plan.md`](../plans/issue-235-amazon-mail-canonical-plan.md).
If this summary conflicts with the canonical plan, the canonical plan wins.

## Capability and ownership

| Capability | Fact owner |
|---|---|
| Amazon buyer-message source, thread evidence, draft, decision, send audit | Ticket Handling |
| Amazon order, item, fulfillment, and shipment context | OrderMgmt read-only capability |
| Mail list/detail/attachment/reply operations and OAuth token | Server-side Zoho provider |
| Amazon buyer-message transport and OAuth credentials | Ticket Handling server-side Zoho provider |

Ticket Handling must not read OrderMgmt-owned tables directly. OAuth tokens and
service credentials must never reach frontend code.

Zoho is the single Amazon buyer-message transport for this workflow. Ticket
Handling does not directly call SP-API and does not build a parallel message
pipeline. Operators require only Ticket Portal access; the Worker uses
backend-only OAuth credentials to execute Zoho replies.

## Inbound contract

1. Poll a narrowly scoped Zoho folder/search for randomized
   `@marketplace.amazon.co.jp` senders, but assign customer semantics only after
   provider-verifiable aligned DKIM/DMARC or an approved equivalent passes.
2. Persist source identity before enrichment. Canonical idempotency key:
   `zoho:{provider_account_id}:{provider_message_id}`.
3. Normalize source thread/message identity, order number, anonymized sender,
   direction, subject, body, timestamp, reply headers, and attachment metadata.
4. Preserve ordinary Amazon order notifications, marketing, and messages
   without a single valid order number in an observable review/error state;
   neither these nor accepted buyer messages may trigger automatic ticket
   creation.
5. Resolve the Amazon platform account and OrderMgmt order capability.
6. Transactionally append to an existing authorized mapping, or place the
   message in the queue for explicit operator conversion. Polling cannot create
   a ticket. A new customer event on a terminal linked ticket returns it to
   `in_progress` and sets `needs_reply=true` in the same transaction.

The normalized body reuses `inbound_ticket_messages.latest_buyer_message`; a
new `message_subject` column holds the subject. Only the Worker writes these
fields, and the authenticated Ticket Portal reads a minimum review projection.
Ingestion and reconciliation cannot call the separately scoped Amazon Convert
transaction. Existing Mercari conversion remains unchanged.

Polling uses the lossless checkpoint contract in the canonical plan: a durable
`(received_time, message_id)` high-water tuple, a 15-minute overlap, persisted
frozen `window_start/run_to` alongside continuation, bounded complete paging,
and no checkpoint advance after truncated or failed traversal.

Ingestion modes are `off`, `shadow`, and `active`. Shadow mode records only
aggregate classifications and stores no customer content. Active mode writes
the immutable source evidence before enrichment.

## Attachment contract

- For an unmatched queue message, persist only restricted attachment metadata;
  do not download bytes until an operator links or converts it to a ticket.
- Fetch only attachments referenced by an accepted buyer message that already
  has a valid `ticket_id` parent.
- Maximum count and bytes are bounded before download.
- Allowlisted image MIME types must match magic bytes.
- Store in the existing private Supabase Storage under a content-hash path and
  create an existing `ticket_attachments` Evidence record; do not create a
  parallel attachment table or Evidence UI.
- Deduplicate by source attachment identity and SHA-256.
- Do not log filenames, content, paths, addresses, or bytes.

## Outbound contract

1. Operator signs in only to Ticket Portal, generates/edits a draft, and selects
   holding or terminal intent; no Zoho login is required.
2. Confirmation displays order, approved sender, masked recipient, subject, and
   exact final body.
3. Browser also submits the non-authoritative `reviewed_customer_message_id`
   and `last_seen_message_at` that the operator actually reviewed.
4. Database triggers increment `tickets.message_revision` on every message
   insertion, including delayed older evidence, and
   `tickets.customer_message_revision` only for trusted customer messages.
   Browser submits both reviewed monotonic revisions. An Amazon-specific claim
   locks the ticket, revalidates both revisions, and permits at most one
   `sending|ambiguous` lease per ticket.
5. Backend resolves the authorized source thread, re-fetches it, and fails
   closed unless the latest customer message ID/time exactly matches the
   reviewed token.
6. Reply uses the original Zoho `messageId`; recipient, fixed from-address, and
   OAuth credentials are resolved server-side from the ticket/account contract.
   The browser cannot provide or override them.
7. Submission is performed once.
8. The initial outbox claim freezes the reviewed customer-message ID/time and
   rejects conflicting retries. Zoho Sent/thread state is read back before an
   Amazon-specific transactional finalize rechecks that persisted version against the latest
   trusted inbound evidence. A terminal reply clears `needs_reply` only when
   that version is still latest; otherwise the send is audited and
   `needs_reply` remains true.
9. Timeout or uncertain submission becomes `ambiguous`. Retry reconciles first.

`AMAZON_MAIL_INGESTION_MODE=off|shadow|active`,
`AMAZON_MAIL_ATTACHMENTS_ENABLED=false|true`, and
`AMAZON_MAIL_OUTBOUND_ENABLED=false|true` are independent kill switches.
With attachment download disabled, reconciliation performs no claim, provider
attachment GET, or Storage write, and pending references remain resumable.

## Acceptance tests

- Non-buyer Amazon mail never becomes a customer message.
- Missing or ambiguous account/order mapping fails closed.
- Overlap and replay cannot duplicate tickets, messages, or attachments.
- Seller/system events do not set `needs_reply`.
- Browser input cannot override recipient, source message, or sender identity.
- Stale thread blocks sending.
- Pre-send rejection releases a newly-created outbox claim.
- Distinct operation IDs from stale tabs cannot hold concurrent send leases;
  the locked full-thread revision must still match.
- A `sending` lease is reclaimable only after 15 minutes when the persisted
  provider-mutation marker is still null. Ambiguous leases never auto-expire;
  authenticated operator resolution must either select an exact Sent message
  or confirm no provider send, with an audit event.
- A mutation-started `sending` lease older than 5 minutes is promoted to
  `ambiguous`; it is never treated as proof that no provider send occurred.
- Ambiguous reconciliation uses the persisted Sent baseline and finalizes only
  an exact provider ID or exactly one post-baseline body match.
- Attachment disablement performs zero provider/Storage writes and re-enabling
  resumes the same pending references.
- Same operation UUID cannot send twice; changed content conflicts.
- Ambiguous submission does not clear `needs_reply` and can reconcile without a
  second mutation.
- Existing Mercari and Rakuten behavior remains unchanged.

## Release sequence

1. Provider contract plus synthetic fixtures.
2. Metadata-only attachment POC, then one approved photo download canary.
3. Schema/RPC and shadow ingestion.
4. Operator UI and governed outbox integration.
5. Two healthy shadow cycles.
6. One inbound canary and one separately approved reply canary.
7. Authenticated verification at `https://ops.homesbliss.net/tickets`.
8. Bounded scheduled activation with rollback evidence.

## Change log

- 2026-09-07: Initial architecture and rollout contract.
