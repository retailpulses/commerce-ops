# Canonical Patch: Message-First Ticket Architecture

**Version**: 1.0.0
**Date**: 2026-05-26
**Author**: Jim_EC (manager)
**Status**: Draft for review

---

## 1. Principle

> **Customer messages are the unconditional priority signal. Ticket status is secondary metadata that flows FROM messages, never the reverse.**

### What this means

| Wrong (current) | Correct (canonical) |
|---|---|
| "This ticket is Closed Resolved, so we skip scanning it" | "A new buyer message EXISTS — therefore the ticket is no longer resolved" |
| Three separate scans gated by ticket status | One unified detection principle, multi-source implementation |
| Ticket status determines whether a message is seen | A message determines what the ticket status becomes |

### The rule in one sentence

**If a buyer sends a message we haven't replied to, it goes on the job list. Period.**

---

## 2. Architecture

### 2.1 Unified Detection Layer

Two complementary sources feed into one actionable queue:

```
┌─────────────────────────────────────────────────────────────┐
│                    DETECTION LAYER                           │
│  (find ALL transactions where last message role = BUYER)     │
├──────────────────────────────┬──────────────────────────────┤
│                              │                               │
│  Source A: stream            │  Source B: backscan           │
│  orderTransactions(first:100)│  Baserow ticket loop          │
│  ✅ Covers recent orders     │  ✅ Covers pagination blind   │
│     (createdAt DESC, top 100)│     spot for old orders       │
│  ⚠️  Pagination blind spot   │  ⚠️  Per-tx API call cost      │
│     for old orders           │     (cursor-paginated)        │
│                              │                               │
├──────────────────────────────┴──────────────────────────────┤
│                                                              │
│  Source B runs against ALL tickets, regardless of status:    │
│    • "Open" / "Awaiting Customer Form" / "Follow-up"         │
│    • "Closed Resolved" / "Closed Unresolved"                 │
│    • Any other status that may exist                         │
│                                                              │
│  Filter: compares Baserow Latest Message At timestamp        │
│          against actual latest buyer message createdAt       │
│          → only genuinely NEW messages pass through          │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│              UNIFIED ACTIONABLE QUEUE                        │
│              (deduplicated by transaction ID)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Processing Layer

```
For each actionable transaction:
  1. Classify message (rules → LLM)
     → greeting_only, information-only, real_ticket, suspicious
  2. Look up Baserow ticket
  3. If ticket is Closed:
     - greeting_only / information-only → keep Closed, send auto-ack
     - real_ticket / suspicious         → REOPEN (status→Open, Needs Reply→True)
  4. Send reply
  5. Update Baserow
```

**Why gating Reopen on classification matters**: A "Thank you" after resolution is not unresolved intent. Classification already distinguishes noise (greeting_only) from signal (real_ticket). Detection is unconditional — response is classified.

### 2.3 Ticket Reopening Logic

```python
if current_ticket_status in ("Closed Resolved", "Closed Unresolved"):
    if cls in ("real_ticket", "suspicious"):
        # Genuine unresolved intent → reopen
        patch_data = {
            "Status": "Open",
            "Needs Reply": True,
        }
    else:
        # greeting_only or information-only → keep closed
        # Still reply (auto-ack), but don't change status
        pass
```

---

## 3. Refactoring Plan

### 3.1 Remove status-gated scans

| Remove | Replace with |
|---|---|
| `fetch_non_closed_tickets_page()` — gated by Status != Closed | `fetch_tickets_for_backscan()` — no status filter, just pagination |
| `fetch_closed_resolved_tickets_page()` — recently added, also gated | Same unified function above |
| Separate stats: `tickets_scan` + `recently_closed_scan` | Single `backscan_stats` |

### 3.2 Unified backscan function

```python
def fetch_tickets_for_backscan(baserow_token, baserow_base, page, size=200):
    """Fetch one page of tickets from Baserow for message backscan.
    
    No status filter — covers ALL tickets to detect new buyer messages
    regardless of current ticket state.
    """
    url = (
        f"{baserow_base}/api/database/rows/table/{TICKETS_TABLE_ID}/"
        f"?user_field_names=true&size={size}&page={page}"
    )
    return baserow_request("GET", url, baserow_token)
```

### 3.3 Merged stats

```python
backscan_stats = {
    "total_tickets": int(resp.get("count", 0)),
    "page": page,
    "page_rows": len(rows),
    "actionable": 0,
    "skipped_no_order_id": 0,
    "skipped_no_new_message": 0,
    "skipped_last_not_buyer": 0,
    "skipped_no_token": 0,
    "reopened_closed": 0,   # ← new: count of closed tickets reopened
    "errors": 0,
}
```

---

## 4. Impact Assessment

### 4.1 Customer experience
- **Before**: Messages on closed tickets silently lost (Issue #11)
- **After**: Every buyer message detected and responded to, regardless of ticket status
- **Risk reduction**: Eliminates the exact class of bug that caused Issue #11

### 4.2 Operational cost
- **API calls**: ~200 per run (one page of tickets), same as current combined non-closed + closed scans
- **False positives**: Timestamp comparison (`last_msg_at > baserow_latest_at`) prevents re-detecting already-handled messages
- **LLM cost**: Only for genuinely new messages that pass the timestamp gate

### 4.3 Ticket status integrity
- **Reopening**: Closed tickets auto-reopen when new buyer message detected
- **No status decay**: Open tickets remain open; closed tickets only reopen on new customer activity
- **Audit trail**: `reopened_closed` stat tracks how many were reopened per run

---

## 5. Implementation Checklist

- [ ] Replace `fetch_non_closed_tickets_page()` with `fetch_tickets_for_backscan()` (no status filter)
- [ ] Remove `fetch_closed_resolved_tickets_page()` (merged into unified backscan)
- [ ] Add ticket reopening logic in processing layer (Closed → Open on new message)
- [ ] Merge stats into single `backscan_stats`
- [ ] Update report template
- [ ] Dry-run validation
- [ ] Update `@TOOL_REGISTRY.yaml` version bump
- [ ] Document in MEMORY.md

---

## 6. Manager's Assessment (ChatGPT Review Response)

### Valid concerns, already handled

| ChatGPT concern | Manager response |
|---|---|
| "Not all buyer messages should reopen tickets" | **Correct, and already addressed**: Classification pipeline (greeting_only → auto-ack, keep closed; real_ticket → reopen). Reopen is gated by `cls` not by message existence alone. |
| "Need actionability evaluation layer" | **Already exists**: `classify_message()` + `llm_classify_message()` provide this layer. No additional layer needed. |
| "Platform lag duplicates" | **Already handled**: `last_msg_at <= baserow_latest_at` timestamp gate prevents re-detection. |

### Valid concern, deferred

| Concern | Decision |
|---|---|
| "Malicious loops / harassment causing perpetual reopening" | Real risk. Deferred to v1.1: add "Manual Lock" status and abuse threshold counter. Current mitigation: `skip_reply` guard for Awaiting Form status prevents FUGUAI spam. |

### Concern rejected

| Concern | Reason |
|---|---|
| "Intermediate message blindness" (snapshot-diff vs event-driven) | Mercari API limitation, not architecture choice. No event-driven alternative exists. The stream+backscan dual-source approach gives best-effort coverage within API constraints. |

### Verdict

The architecture is correct. The fix is the **detection layer**: removing status-gated scans. The processing layer already has the right classification logic. Implementation proceeds.
