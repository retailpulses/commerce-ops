# Fix Plan: `delivery_request` Classification

**Version**: 1.0  
**Date**: 2026-05-28  
**Author**: Jim_EC  
**Issue**: [GH#11](https://github.com/retailpulses/inbox/issues/11#issuecomment-4560098242) — `2JRmmHNKebKsUtd9kepQV5` (Shop2)  
**Status**: Draft — pending review

---

## 1. Problem

Customer message:

> 午前中配送でお願い致します。早めの時間がよいです。宜しくお願い致します。

Classification trace:
1. `quality_keywords` → no match
2. `real_ticket` (shipping): "いつ届く"/"いつ発送"/"発送されましたか" → no match — "午前中配送" not in list
3. `info_keywords` → no match
4. `greeting_keywords`: "**宜しくお願い致します**" → **match** → misclassified as `greeting_only`

**Root cause**: Polite closing phrase "宜しくお願い致します" triggers greeting match, ignores the substantive delivery-time request.

**Consequence**: Auto-ack sent ("ご連絡ありがとうございます。こちらこそ、引き続きよろしくお願いいたします。"), customer's delivery instruction ignored.

---

## 2. Design Decision

Delivery-time requests are **not** `real_ticket` (they don't have unresolved intent) and **not** `greeting_only` (they contain actionable instruction). They are operational instructions that require manual review.

### Rule
- **No auto-reply** — delivery instruction is an operational action, not a customer service interaction
- **No Baserow ticket** — no ticket creation/update for delivery_request
- **Report-only** — listed in the daily report for manual handling

---

## 3. Planned Changes

### 3.1 Classification (`classify_message`)

```python
# New block: placed BEFORE greeting check in classify_message()
delivery_request_keywords = [
    "午前中配送", "午前配送", "午後配送", "配送時間", "時間指定", "日時指定",
    "午前中に", "午前中で", "時間帯指定", "何時配送", "配送時間帯",
]
if any(k in text for k in delivery_request_keywords):
    return "delivery_request", ""
```

### 3.2 Processing — template selection

```python
# New branch in reply template selection
# (no template — delivery_request gets no reply)
elif cls == "suspicious":
    reply_text = FUGUAI_LITE_TEMPLATE

# delivery_request: no auto-reply
# (reply_text remains None, skip_reply set below)
```

### 3.3 Processing — status/action

```python
elif cls == "delivery_request":
    skip_reply = True
    new_status = None          # No Baserow change
    needed_action = "Manual — delivery time request"
    report_data["delivery_request_count"] += 1
```

### 3.4 Baserow — skip entirely

```python
# delivery_request: do NOT create/update Baserow tickets
# Guarded by skip_reply = True in the processing block
```

### 3.5 Report data init

```python
"delivery_request_count": 0,
```

### 3.6 Report output

```markdown
## Delivery Requests (Manual Review)
- count: 1

| # | Order ID | Shop | Message |
|---|---|---|---|
| 1 | 2JRmmHNKebKsUtd9kepQV5 | Shop2 | 午前中配送でお願い致します。早めの時間がよいです。 |
```

---

## 4. Post-Patch Business Process

### 4.1 Detection Flow (updated)

```
┌──────────────────────────────────────────────────────────┐
│                  DETECTION LAYER                          │
│     orderTransactions stream + Baserow backscan           │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│              CLASSIFICATION                               │
├───────────────────┬──────────────────┬───────────────────┤
│   greeting_only   │   real_ticket    │  delivery_request  │
│   information-only│   suspicious     │   (NEW)            │
├───────────────────┼──────────────────┼───────────────────┤
│   Auto-reply ✅   │   Auto-reply ✅  │   Auto-reply ❌   │
│   Baserow ✅      │   Baserow ✅     │   Baserow ❌      │
│   Report ✅       │   Report ✅      │   Report ✅       │
└───────────────────┴──────────────────┴───────────────────┘
```

### 4.2 Daily Report Sections (updated)

| Section | Content | Auto-reply? |
|---|---|---|
| Greeting Closes | Auto-ack sent | Yes |
| Real Tickets / Quality Issues | HOLDING_ACK or FUGUAI sent | Yes |
| **Delivery Requests** | **Listed — manual review** | **No** |
| Suspicious | FUGUAI_LITE sent (if auto-reply enabled) | Conditional |

### 4.3 Manual Handling Workflow for Delivery Requests

```
1. Check daily report → Delivery Requests section
2. For each delivery request:
   a. Open the order in Mercari Shops
   b. Confirm the delivery instruction (morning/afternoon/time-specific)
   c. If actionable: arrange delivery time manually
   d. Reply to customer confirming the arrangement
3. No Baserow ticket created — operational action, not customer service
```

---

## 5. Verification

| Test Case | Expected Classification |
|---|---|
| `午前中配送でお願い致します。宜しくお願い致します。` | `delivery_request` |
| `午前中に配送をお願いします。` | `delivery_request` |
| `時間指定お願いします。` | `delivery_request` |
| `日時指定をお願いします。` | `delivery_request` |
| `配送時間を午前にしてほしいです。` | `delivery_request` |
| `よろしくお願いいたします。` | `greeting_only` (no regression) |
| `商品が破損していました。交換してください。` | `real_ticket` (no regression) |
| `いつ発送されますか？` | `real_ticket/inquiry` (no regression) |
| `支払いしました。よろしくお願いいたします。` | `information-only` (no regression) |

---

## 6. Impact

| Metric | Impact |
|---|---|
| API calls | No change (delivery_request skipped in processing) |
| Auto-replies | Fewer — delivery requests removed from auto-reply pipeline |
| Baserow | Fewer — no ticket created for delivery instructions |
| Manual workload | +1 per delivery request (report review + manual reply) |
| Regression risk | Zero — new classification type, independent code path |
