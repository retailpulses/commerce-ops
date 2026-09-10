# TRD: Needs Reply State Hardening

**Status**: implemented
**Date**: 2026-06-14
**Scope**: Ticket Workspace + automated handler

## 1. Problem Statement

`Needs Reply` is currently cleared too aggressively after automated or manual replies. This breaks the ticket portal workflow for tickets that still require a later formal operator response.

The concrete failure case is a holding acknowledgement, such as:

- "We received your message"
- "We will review this during business hours"
- "We will follow up later"

These are not terminal replies. They should not remove the ticket from the operator reply queue.

## 2. Confirmed Business Rules

### 2.1 System-owned default

`Needs Reply` remains primarily system-computed.

### 2.2 Operator override allowed

Operators may manually update `Needs Reply` in the portal via the Toggle button. The system accepts the change directly with no timer-based guard — the next automated run recomputes its own value based on message classification.

### 2.3 Informational acknowledgements

Pure informational acknowledgements may be system-resolved with:

- `Needs Reply = false`

Examples:

- greeting-only acknowledgement
- information-only acknowledgement
- other low-touch informational auto-acks that do not require later formal follow-up

### 2.4 Holding acknowledgements

Holding acknowledgements are not terminal replies. After sending them:

- `Needs Reply` must remain `true`

Examples:

- business-hours acknowledgement
- "we are checking and will reply later"
- other temporary holding replies

### 2.5 Formal replies

A formal reply may set:

- `Needs Reply = false`

but only when the sender explicitly marks the reply as terminal via `reply_intent = "terminal"`.

## 3. Design Direction

Keep the model simple:

- `Needs Reply` stays as the final queue field used by the portal
- system computes a recommended value based on message classification
- operator can manually adjust the final value via the portal
- manual send path uses explicit `reply_intent` to distinguish terminal vs holding replies

No timer-based override mechanism or new Baserow schema fields are needed.

## 4. Implementation

### 4.1 Reply intent classification

The automated handler uses template-based classification:

| Reply Template | Classification | Needs Reply |
|---|---|---|
| `GREETING_CLOSE_ACK` | Informational ack | `false` |
| `INFO_CLOSE_ACK` | Informational ack | `false` |
| `HOLDING_ACK` | Holding ack | `true` |
| `FOLLOWUP_FORM_HELPER` | Holding ack (follow-up) | `true` |
| `FUGUAI_TEMPLATE` / `FUGUAI_LITE_TEMPLATE` | Form request (sent) | `false` |
| `FUGUAI_TEMPLATE` / `FUGUAI_LITE_TEMPLATE` | Form request (skipped — already sent) | `true` |
| Cancel-fee / catch-all | Fallback | `true` |

### 4.2 Manual send `reply_intent`

The `POST /api/tickets/:id/send` endpoint accepts an optional `reply_intent` field:

- `"terminal"` — clears `Needs Reply` to `false` after sending
- `"holding"` or absent — preserves current `Needs Reply` value

The frontend shows a "Final reply (clear Needs Reply)" checkbox that sets `reply_intent` to `"terminal"` when checked.

### 4.3 Operator override

The `PATCH /api/tickets/:id` endpoint accepts `needs_reply` directly with no timer extension. The operator toggle in the portal writes the field immediately.

### 4.4 Removed components

- **Stale scan**: Previously cleared `Needs Reply` when the last Mercari message was from SELLER. Removed because holding acknowledgements sent by the seller should allow `Needs Reply` to remain `true`.
- **`Needs Reply Override Until`**: The 30-minute timer-based guard field is removed entirely. No new Baserow schema field is required.

## 5. Acceptance Criteria

- [x] informational auto-ack tickets can end with `Needs Reply = false`
- [x] holding acknowledgement tickets stay `Needs Reply = true`
- [x] sending any reply no longer universally implies `Needs Reply = false`
- [x] operator can manually change `Needs Reply` from the portal with no timer mechanism
- [x] terminal manual replies can clear `Needs Reply` via explicit `reply_intent`
- [x] ticket list filtering still works off the final `Needs Reply` value

## 6. Residual Risks

- **No stale-scan**: Tickets where the seller sent a final message and the operator has not cleared Needs Reply will remain in the Needs Reply queue until the operator manually resolves them. The report enrichment section still flags stale tickets (>48h without update) for visibility.
- **No override guard**: If the operator toggles Needs Reply between automated runs, the next run may overwrite it based on message classification. The absence of a timer guard is acceptable per the design — the system computes its own value each run.
