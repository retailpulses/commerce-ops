# TRD: Manual Reply Guardrail Fix

**Status**: reviewed (Codex feedback incorporated)
**Reviewer**: Codex (OpenAI Codex v0.137.0, model gpt-5.5)
**Review summary**: Diagnosis confirmed. Original proposed fix rejected — it would still block manual follow-ups. Corrected to outgoing-message-aware guard.
**Date**: 2026-06-10
**Branch**: `fix/manual-reply-guardrail`

## 1. Problem Statement

### Symptom

User receives HTTP 409 error when attempting to send a manual follow-up message from the Ticket Workspace:

> "Seller already replied to this thread. Refresh and review before sending again."

### Scenario

1. Automated cron handler sends FUGUAI form auto-reply to customer
2. User opens Ticket Workspace to send a manual follow-up message
3. `handleSendReply` rejects the send with HTTP 409 — **hard block, no override**

### Impact

- Manual follow-up messages are impossible after any automated reply
- User must go to Mercari dashboard directly to send follow-ups
- Defeats the purpose of the Ticket Workspace for multi-message conversations

## 2. Root Cause

`handleSendReply` (`web/worker/src/handlers/tickets.ts:542`) uses `hasSellerRepliedAfterLastBuyer()` as a pre-send guardrail. This function returns `true` if **any** seller message appears after the last buyer message — it cannot distinguish between:

| Seller message type | Should block manual send? |
|---|---|
| FUGUAI form auto-reply | Block only if sending another FUGUAI form |
| Manual reply from Mercari dashboard | No |
| Previous manual follow-up from workspace | No |

The guardrail was ported from the automated cron handler (`handler.ts`), where it serves as a belt-and-suspenders duplicate-prevention layer. On the manual send path, it is too broad.

## 3. Desired Behavior

| Scenario | Allowed? |
|---|---|
| Send manual follow-up after auto-reply (FUGUAI form) | ✅ Yes |
| Send manual follow-up after previous manual reply | ✅ Yes |
| Send FUGUAI form URL when already sent in thread | ❌ Block (duplicate) |
| Send when thread has new buyer messages since loaded | ❌ Block (stale — existing check) |

## 4. Design

### Change

Remove the ordering-based hard block. Add an **outgoing-message-aware** content guard: only block if the message the user is *currently sending* contains the FUGUAI form URL AND that URL already appears in the thread. This mirrors the cron handler pattern (`handler.ts:361`) where `fuguaiAlreadySent()` only fires when `isFugai` (the outgoing reply is a FUGUAI template).

```
BEFORE (line 542):
    // 2. Check if seller already replied after last buyer
    if (hasSellerRepliedAfterLastBuyer(mercariMessages)) {
      return err(
        "Seller already replied to this thread. Refresh and review before sending again.",
        "FUGUAI_ALREADY_SENT",
        409,
        true
      );
    }

AFTER:
    // 2. Block only if user is re-sending a FUGUAI form already in the thread
    const sendsFuguaiForm = outgoing.includes(FUGUAI_FORM_URL);
    if (sendsFuguaiForm && fuguaiAlreadySent(mercariMessages)) {
      return err(
        "FUGUAI form has already been sent in this thread.",
        "FUGUAI_ALREADY_SENT",
        409,
        true
      );
    }
```

### Rationale

- **Why outgoing-aware**: The original TRD proposed `fuguaiAlreadySent(mercariMessages)` alone, which checks only thread history. But after an auto-reply sends the FUGUAI form, the history *contains* the URL, so any manual follow-up would still 409 — reproducing the reported bug. Checking the outgoing message fixes this: only blocks when the user is actively trying to send a duplicate form.
- **Mirrors cron handler intent**: In `handler.ts:361`, `fuguaiAlreadySent()` only applies when `isFugai` (outgoing reply is a FUGUAI template). The manual path now matches this pattern.
- `hasSellerRepliedAfterLastBuyer()` remains in the automated cron handler (`handler.ts`) as a belt-and-suspenders layer — no change needed there.
- The existing `THREAD_STALE` check (step 3, based on `last_seen_message_at`) protects against sending on stale data.

### Known edge cases (from Codex review)

- `fuguaiAlreadySent()` scans all roles including buyer. If a buyer pastes the form URL into their message, it's treated as "already sent." Acceptable for duplicate prevention.
- `THREAD_STALE` compares latest buyer message only (`tickets.ts:553`), while the UI sends timestamp of the latest message of *any* role (`index.ts:521`). A seller/operator message after page load won't trigger `THREAD_STALE`. Out of scope for this fix.

### Files changed

| File | Change |
|---|---|
| `web/worker/src/handlers/tickets.ts` | Import `fuguaiAlreadySent`; replace guardrail check |
| `web/worker/design/api-spec.md` | Update error code docs if needed |

### Imports

Add `fuguaiAlreadySent` to the existing import from `../logic/templates` (or add the import if not already present).

## 5. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Duplicate FUGUAI form sent manually | Low — `fuguaiAlreadySent()` blocks it | Content check catches the URL |
| User sends message after auto-reply handled everything | Low — user intends to follow up | `THREAD_STALE` check still guards staleness |
| Regression in automated handler | None — `handler.ts` unchanged | No change to cron path |

## 6. Validation

- [ ] TypeScript typecheck passes
- [ ] `hasSellerRepliedAfterLastBuyer` still used in `handler.ts` (no regression)
- [ ] **Endpoint-level**: thread has form URL + outgoing is normal follow-up → ✅ allowed (HTTP 200)
- [ ] **Endpoint-level**: thread has form URL + outgoing contains form URL → ❌ blocked (HTTP 409)
- [ ] **Endpoint-level**: thread has NO form URL + outgoing contains form URL → ✅ allowed (first send)
- [ ] Existing `THREAD_STALE` check unchanged

## 7. Rollback

Revert the one-line change in `tickets.ts` — trivial.
