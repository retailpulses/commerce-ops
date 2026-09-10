# BRD - Ticket Mgmt MVP

Version: v1.0.3
Status: Draft
Owner: Engineering
Last Updated: 2026-04-06

Summary of changes:
- Defined the Ticket Mgmt MVP process from the updated Baserow project row
- Added conservative message segmentation rules for greeting-only, real tickets, and suspicious tickets
- Added a minimal schema design for operator-confirmed reply sending
- Kept AI usage limited to the cases where it is needed for stability and controlled drafting
- Tightened send-state rules, ticket status mapping, and acceptance criteria
- Updated intake to Mercari Shop API `取引メッセージ` instead of mail ingestion
- Clarified that the only operator-facing interface is the Baserow `Tickets` table
- Added the known Mercari API transaction-message shape for implementation planning

## Change Log

2026-04-06 - v1.0.3
- Added the observed Mercari API transaction-message field mapping used by the hourly intake loop.
- Author: Agent

2026-04-06 - v1.0.2
- Updated the intake boundary to Mercari Shop API `取引メッセージ` and clarified the operator surface.
- Author: Agent

2026-04-06 - v1.0.1
- Tightened the BRD with explicit send-state behavior, ticket status mapping, and acceptance criteria.
- Author: Agent

2026-04-06 - v1.0.0
- Initial BRD draft for Ticket Mgmt MVP.
- Author: Agent

## 1. Purpose

This BRD defines the minimum viable business process for Ticket Mgmt MVP.

The intended operating model is:
- identify unreplied Mercari Shop `取引メッセージ`
- separate greeting-only messages from real ticket messages
- route suspicious messages conservatively into `Tickets`
- send an immediate acknowledgment template for real and suspicious tickets
- use Knowledge-assisted AI drafting only where needed
- require operator confirmation before sending outbound replies

## 2. Source of Truth

This BRD is based on the current Baserow project row:
- `Project Name`: `Ticket Mgmt MVP`

And the linked backlog item:
- `Mercari Ticket Mgmt`

Current success definition from the project row:
- segment greeting-only transaction messages vs real tickets
- classify suspicious tickets at 95% confidence
- auto reply greeting-only messages and do not land in Baserow ticket
- auto reply 1st line templates
- auto draft real replies with Knowledge support and await review from operator
- once operator confirmed, automatically send the reply

Current operating assumption:
- `transaction message` means Mercari Shop `取引メッセージ`
- messages are fetched via Mercari API, not mail ingestion
- the only operator working interface is the Baserow `Tickets` table

## 3. Business Goal

The business goal is to reduce manual ticket handling work while keeping reply quality and system stability high.

Success means:
- greeting-only traffic is handled automatically without polluting the ticket table
- real support cases become durable ticket records
- suspicious cases are not lost
- AI is used only when needed for drafting or ambiguity handling
- operator approval remains the control point before send

## 4. In Scope

- fetch unreplied Mercari Shop `取引メッセージ`
- classify inbound messages
- auto reply greeting-only messages
- create or upsert real tickets into Baserow `Tickets`
- create or upsert suspicious messages into Baserow `Tickets`
- draft real replies with Knowledge support
- show the draft to the operator for review
- send the reply only after operator confirmation
- track send state on the ticket row

## 5. Out of Scope

- fully autonomous support handling
- auto-send without operator confirmation
- replacing human review for suspicious or sensitive cases
- building a separate AI-heavy routing engine when deterministic rules are enough
- redesigning the full ticketing UI in this BRD

## 6. Message Classification

Each inbound transaction message must be classified into one of three buckets:

### 6.1 Greeting Only

Definition:
- short acknowledgement or greeting
- no issue content
- no request for action
- no problem, question, or logistics detail

Examples:
- `了解しました`
- `承知しました`
- `ありがとうございます`

Business rule:
- send a pure auto-reply using a base template
- do not create a `Tickets` row
- do not enter the AI draft workflow

Recommended JP template:
- `ご連絡ありがとうございます。内容を確認のうえ対応しております。順次ご返信いたしますので、今しばらくお待ちください。`

### 6.2 Real Ticket

Definition:
- contains a product issue, delivery issue, refund request, replacement request, return request, payment request, or complaint that needs support handling

Business rule:
- create or upsert into `Tickets`
- send an immediate acknowledgment template in Japanese
- attach Knowledge if available
- generate a draft reply only when necessary
- route to operator review

Recommended JP template:
- `ご連絡ありがとうございます。内容を確認のうえ対応しております。順次ご返信いたしますので、今しばらくお待ちください。`

### 6.3 Suspicious

Definition:
- message is not clearly greeting-only
- message is not clearly a real ticket
- confidence is below the greeting-only threshold

Business rule:
- do not suppress it
- create or upsert into `Tickets`
- mark it as suspicious for review
- send an immediate acknowledgment template in Japanese
- do not auto-send anything

Recommended JP template:
- `ご連絡ありがとうございます。内容を確認のうえ対応しております。順次ご返信いたしますので、今しばらくお待ちください。`

## 7. Confidence Rule

Greeting-only detection target:
- `95%` confidence level

Policy:
- if the classifier is not confident, classify the message as suspicious
- suspicious is safer than false suppression
- the system should favor keeping borderline cases visible to humans

## 8. Process

### Step 1: Fetch unreplied Mercari Shop `取引メッセージ`

The system fetches new or unreplied Mercari Shop `取引メッセージ` via the Mercari API.

The application should run on an hourly cycle for this handling loop.

Known live API shape from the Mercari POC notes:
- the relevant post-order objects are `orderTransaction` and `orderTransactions`
- documented message fields include:
  - `createdAt`
  - `id`
  - `message`
  - `role`

Implementation note:
- use the transaction object as the conversation container
- use the message `id` together with the transaction `id` for deduplication if the API exposes multiple messages in one transaction
- use `createdAt` as the polling and ordering reference for the hourly loop

### Step 2: Segment

The system applies a conservative segmentation rule:
- greeting-only
- real ticket
- suspicious

Deterministic rules should be used first.
AI should not be the primary classifier unless mandatory for ambiguous cases.

### Step 3: Handling

#### 3a. Greeting-only

- automatically draft or send the base template reply
- do not write into Baserow `Tickets`
- record only the operational event needed outside the ticket table

#### 3b. Real ticket

- create or upsert into Baserow `Tickets`
- use the live ticket schema
- link Knowledge when available
- send the acknowledgment template immediately
- prepare the AI draft only if the rule-based reply is not sufficient

#### 3c. Suspicious ticket

- create or upsert into Baserow `Tickets`
- mark as suspicious
- send the acknowledgment template immediately
- require human review
- avoid auto-send

### Step 4: Agent draft

The reply drafting step should:
- use ticket context
- use linked Knowledge
- stay within the approved support policy
- keep the generated draft simple and stable

AI use is mandatory only when:
- a rule-based template is not enough
- a reply must be drafted from ticket context
- Knowledge support is needed to reduce inconsistency

### Step 5: Operator review

The operator reviews the AI draft and edits it inside the Baserow `Tickets` table only.

The operator then changes a specific field on the ticket to confirm the reply is ready to send.

### Step 6: System send

When the confirmed send state is set, the system sends the reply and marks the ticket as sent.

## 9. Ticket Schema Design

The current `Tickets` schema is the only operator-facing work surface for this MVP.
It already supports most of the ticket context needed for this MVP:
- `Order ID`
- `Customer Name`
- `Description`
- `Status`
- `Priority`
- `Latest Message At`
- `Latest Customer Message`
- `Needs Reply`
- `Message log`
- `Sender Email Address`
- `Platform`
- `AI Reply`
- `Knowledge`
- `Knowledge detail`

### 9.1 Recommended New Field

Add one field to control reply sending:

- `Reply Send State`
  - type: `single select`
  - suggested values:
    - `Draft`
    - `Ready to Send`
    - `Sent`

Why this field is needed:
- `Needs Reply` answers whether the ticket needs attention
- `Status` answers workflow progress for the case
- `Reply Send State` answers whether the reply is approved for system send

This prevents the business process from overloading one field with three different meanings.

Field behavior:
- `Draft`: AI draft exists, not reviewed
- `Ready to Send`: operator reviewed and approved
- `Sent`: system already sent the reply

Recommended default flow:
- new real or suspicious ticket row starts in `Reply Send State = Draft`
- after acknowledgment is sent, the row remains in `Draft` until the operator review step completes
- operator moves it to `Ready to Send`
- system sends the reply and then moves it to `Sent`

### 9.2 Ticket Status Mapping

Use `Status` for case progress, not reply approval.

Recommended mapping:
- `Open`: newly created case or waiting on operator handling
- `In Progress`: draft/review underway
- `Closed Resolved`: case finished and reply sent when applicable
- `Closed Unresolved`: case cannot be resolved or was closed without completion

Rules:
- do not use `Status` as the send trigger
- do not use `Needs Reply` as the send trigger
- use `Reply Send State = Ready to Send` as the send trigger

### 9.3 Optional Later Field

If needed later, add:
- `Reply Approved At`
  - type: `date/time`

This is optional for MVP.

## 10. Success Criteria

The MVP is successful when:
- greeting-only messages are reliably auto-replied and kept out of `Tickets`
- suspicious messages are retained in `Tickets` and visible for review
- real tickets are created or updated correctly
- real and suspicious tickets receive an immediate acknowledgment template
- Knowledge improves draft quality on standard cases
- operator approval is the gate for sending replies
- AI usage remains limited to drafting and ambiguity handling

## 11. Acceptance Checklist

Minimum acceptance conditions:
- greeting-only messages receive the base Japanese reply and do not create `Tickets` rows
- real tickets create or update `Tickets` rows and receive an acknowledgment template
- suspicious tickets create or update `Tickets` rows and receive an acknowledgment template
- `Reply Send State` exists and controls send readiness
- `Status` reflects case progress only
- operator can review and set a ticket to `Ready to Send`
- system sends only when `Reply Send State = Ready to Send`
- AI is not used for routing when deterministic rules are sufficient
- AI is used only when a draft is needed for stability or consistency
- hourly intake can read the live Mercari transaction-message objects without depending on mail ingestion

## 12. Stability Rule

AI usage must be limited to what is necessary for system stability.

That means:
- do not use AI when a deterministic template is sufficient
- do not use AI for routing if rules are good enough
- do not use AI for auto-send
- use AI only for drafting real replies or handling ambiguity that cannot be resolved safely by rules

## 13. Risks

- If greeting-only detection is too aggressive, real tickets could be suppressed.
- If suspicious classification is too loose, the ticket table may get noisy.
- If `Reply Send State` is not implemented cleanly, send operations may become ambiguous.
- If AI is allowed too broadly, reply quality and stability will get worse, not better.

## 14. Recommendation

Proceed with:
- conservative rule-based segmentation
- pure auto-reply for greeting-only messages
- ticket creation for real and suspicious messages
- Knowledge-assisted AI drafting only when needed
- operator-confirmed reply sending using a dedicated send-state field

That is the smallest design that satisfies the current success definition while keeping AI usage restrained.
