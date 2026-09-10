# Issue 46 Implementation Plan: Operator-Action Ticket Creation

## Decision

Do not use `Needs Reply` as the source of truth for ticket creation.

Add an independent classifier signal:

- `operator_action_required: boolean`
- optional `operator_action_reason: string`

Ticket creation must be driven by customer intent and operational actionability, not by the reply template selected later in the handler.

## Problem

Some aftersales messages require operator action but are not quality issues:

- payment confirmation requests
- tracking number / delivery company inquiries
- delivery status questions
- product/order checks
- generic "please confirm/check/respond" requests

Today these can be classified as `information-only`, which causes:

1. no Baserow ticket to be created
2. no portal visibility
3. later buyer follow-ups can be missed if a seller reply makes the transaction invisible to the deep scan

## Core Invariant

If the latest buyer message requires a human/operator action, the transaction must have a Baserow ticket.

This invariant is independent from whether the automation sends:

- an informational close acknowledgement
- a holding acknowledgement
- a FUGUAI form request
- no reply because a seller already replied

## Required Code Changes

### 1. Extend classification metadata

File:

- `web/worker/src/types.ts`
- `web/worker/src/logic/classifier.ts`

Add metadata fields:

```ts
operator_action_required?: boolean;
operator_action_reason?: string;
```

These fields may live inside `Classification.meta` initially to minimize schema churn.

### 2. Add deterministic rule-based action indicators

File:

- `web/worker/src/logic/classifier.ts`

Add a helper similar to:

```ts
function detectOperatorAction(text: string): { required: boolean; reason: string | null }
```

It must return `required=true` for examples including:

- `ご確認お願いします`
- `確認お願いします`
- `支払いましたのでご確認お願いします`
- `配送会社と問い合わせ番号を教えて頂けないでしょうか`
- `配送会社とその問い合わせ番号を教えてください`
- `問い合わせ番号`
- `追跡番号`
- `配送会社`
- `発送状況`
- `いつ届きますか`
- `いつ発送`
- `教えてください`
- `ご対応お願いします`
- `ご返信お願いします`

Important: generic `お願いします` alone must not trigger this signal.

### 3. Extend the LLM schema

File:

- `web/worker/src/logic/classifier.ts`

Update the LLM JSON contract to include:

```json
{
  "has_operator_action_request": true,
  "operator_action_reason": "payment_confirmation | tracking_inquiry | delivery_status | product_order_check | other"
}
```

Prompt rule:

If the buyer asks the shop to confirm, check, reply, provide information, provide tracking/carrier details, or perform an order-related action, `has_operator_action_request` must be true even if the message also contains informational text.

Override order:

1. defect/damage/missing parts -> `real_ticket/quality_issue`
2. refund/exchange/cancel request -> `real_ticket/request`
3. delivery/product question -> `real_ticket/inquiry`
4. operator action request -> `real_ticket/inquiry` or `suspicious/manual_action`
5. greeting/info-only -> closeable only if no operator action request exists

### 4. Add a handler-level ticket visibility boolean

File:

- `web/worker/src/handler.ts`

After classification and before Baserow write, compute:

```ts
const operatorActionRequired = meta.operator_action_required === true;
const ticketVisibilityRequired =
  isFugai ||
  operatorActionRequired ||
  cls === "real_ticket" ||
  cls === "suspicious";
```

Then replace the current create condition:

```ts
isFugai || (newStatus !== null && cls !== "greeting_only" && cls !== "information-only")
```

with:

```ts
ticketVisibilityRequired
```

Do not use `needsReplyVal` as the create condition.

### 5. Keep `Needs Reply` as queue state only

File:

- `web/worker/src/handler.ts`

`Needs Reply` should continue to mean "this ticket belongs in the operator reply queue."

For operator-action tickets:

- if the automation sends `HOLDING_ACK`, set `Needs Reply = true`
- if no reply is sent because a seller already replied, set `Needs Reply = true`
- if a terminal informational acknowledgement is genuinely sufficient, set `Needs Reply = false`

But `Needs Reply` must not decide whether the ticket row exists.

### 6. Avoid FUGUAI Lite for generic manual action

File:

- `web/worker/src/handler.ts`

Current behavior maps `cls === "suspicious"` to `FUGUAI_LITE_TEMPLATE`.

Change this so generic operator-action / manual-review messages receive `HOLDING_ACK`.

Only send `FUGUAI_TEMPLATE` or `FUGUAI_LITE_TEMPLATE` when defect, damage, missing part, shortage, wrong item, or similar product-quality evidence is detected.

### 7. Improve deep-scan visibility for no-ticket transactions

File:

- `web/worker/src/clients/mercari.ts`
- `web/worker/src/handler.ts`

Current deep scan only returns transactions whose latest overall message is `BUYER`.

Add a no-ticket visibility path:

1. recent `COMPLETED` transactions may be evaluated when they contain a latest buyer message that is newer than any known Baserow ticket state
2. if latest overall message is `SELLER`, do not send a duplicate reply
3. still create a ticket if the latest buyer message has `operator_action_required=true`

This prevents permanent invisibility when an auto/manual seller message follows an action-required buyer message before the cron run.

### 8. Persist per-transaction skip/action logs

Files:

- `web/worker/src/handler.ts`
- `web/worker/src/clients/baserow.ts`
- `web/worker/src/types.ts`

Current `_log_entries` are built in memory but not persisted.

Implement one of these deterministic options:

Preferred:

- write per-transaction rows to the configured log table if schema supports the required fields

Fallback:

- write one JSON audit object to KV per run under a key like `audit:<run_id>`

The audit must include at least:

- run_id
- transaction_id
- shop
- latest_buyer_message_id
- classification
- operator_action_required
- operator_action_reason
- ticket_visibility_required
- baserow_action
- auto_reply_sent
- skip reason, when skipped

## Required Regression Tests

Add focused tests for classifier behavior. If the project has no test harness yet, add a minimal TypeScript test script under `web/worker`.

Required cases:

| Message | Expected |
|---|---|
| `購入させて頂きました。明日中には支払いますのでよろしくお願いします` | closeable info/greeting, `operator_action_required=false` |
| `支払いましたのでご確認お願いします` | `operator_action_required=true`, ticket visible |
| `ありがとうございます。配送会社と問い合わせ番号を教えて頂けないでしょうか` | `operator_action_required=true`, inquiry ticket visible |
| `配送会社とその問い合わせ番号を教えてください` | `operator_action_required=true`, inquiry ticket visible |
| `ありがとうございます。よろしくお願いします` | `operator_action_required=false` |
| `ご確認お願いします` | `operator_action_required=true` |
| `よろしくお願いします` | `operator_action_required=false` |

Add handler-level tests or a pure helper test for the create condition:

| Classification | operator_action_required | Expected create |
|---|---:|---:|
| `information-only` | false | false |
| `information-only` | true | true |
| `greeting_only` | false | false |
| `real_ticket/inquiry` | true | true |
| `suspicious` | true | true |
| `real_ticket/quality_issue` | true/false | true |

## Acceptance Criteria

- The four messages in issue 46 produce exactly one Baserow ticket for the order.
- `支払いましたのでご確認お願いします` no longer disappears as pure `information-only`.
- tracking-number/carrier inquiries create or update a visible ticket.
- generic action-required messages receive `HOLDING_ACK`, not a FUGUAI form request.
- FUGUAI templates are only sent for defect/damage/missing-part style cases.
- `Needs Reply` remains the operator queue field, not the ticket-existence rule.
- deep scan does not permanently lose action-required buyer messages just because a seller message followed them.
- skipped/no-ticket decisions are persisted in a per-run audit trail.

## Non-Goals

- Do not broaden ticket creation to every buyer message.
- Do not make generic `お願いします` action-required.
- Do not use `Needs Reply` as a proxy for ticket creation.
- Do not introduce new Cloudflare platform lock-in for core classification logic.

## Suggested Agent Execution Order

1. Implement classifier action detection and tests.
2. Update LLM prompt/schema and metadata propagation.
3. Add `ticketVisibilityRequired` helper and handler tests.
4. Change suspicious/manual-action reply selection away from FUGUAI Lite.
5. Add no-ticket deep-scan visibility path.
6. Add audit persistence.
7. Run `npm test` or the new test script, then `npm run typecheck` if available.
8. Dry-run the handler against the affected Shop4 order before production deploy.
