# Issue #4: Product Not Assigned to Inquiry

- **Status**: Open
- **Source**: https://github.com/retailpulses/inbox/issues/4
- **Created**: 2026-05-23
- **Evidence**: https://baserow.io/database/393156/table/886975/1899718/row/10495

---

## Evidence Summary

| Field | Value |
|---|---|
| Inquiry Row | #10495 |
| Customer | リク |
| Shop | Shop2 (`ZaMyGWzp6hUdgDh5E9ADob`) |
| Type | Product availability |
| Status | Received |
| Product Name (parsed) | `全新品 【スタンド搭載】自転車倉庫 2台用 物置 屋外 スチール 施錠可能...` |
| Products (linked) | **empty** — no product assigned |
| Draft | Stock Out (Date Unconfirmed) — sent despite product not linked |

## Root Cause

`master_handler.py::find_product_id()` uses keyword-only fuzzy search with no scoring or validation:
1. Extracts first "clean" word from inquiry product name
2. Runs Baserow `search=` (global fuzzy) 
3. Blindly accepts `res[0]` as the match
4. When Baserow returns empty or irrelevant results, `Products` field stays empty
5. `auto_draft_replies.py` does not check whether product was successfully linked before generating a draft

### Failure modes observed
| Case | Product Name Contains | Match Result | Row |
|---|---|---|---|
| Common first word | `ナチュラル テーブル...` | Mapped to Eames Chair (wrong) | #7162 |
| Long product name | `自転車倉庫 2台用 物置...` | No match (empty) | #10495 |
| No keyword match | Various | No match (empty) | #10495 |

## Existing Fix Plan

See `/Users/user/Documents/Mercari/Techstack/Inquiries/product_mapping_fix_plan.md`

### Phase 1: Enhanced Tokenization
- SKU pattern regex (`[A-Z0-9]{10,}`) → exact field lookup first
- Stop-word expansion (colors, styles, Mercari-speak)
- Script-switching tokenizer (split by Kanji/Katakana/Alphanumeric)

### Phase 2: Multi-Candidate Scoring
- Fetch top-10 candidates using specific tokens
- IoU token overlap scoring
- Katakana bonus (+0.3), color match (+0.2), length penalty (-0.2)

### Phase 3: Threshold & Safeguards
- Confidence threshold: > 0.45 to auto-link
- Ambiguity detection: top-2 score diff < 0.05 → flag for human review

---

## Additional Fix: Draft Gate

Even after Phase 1–3, there will always be edge cases with no match. Add a gate in `auto_draft_replies.py`:

```python
if not inquiry.get("Products") or len(inquiry.get("Products", [])) == 0:
    # Do NOT auto-draft; flag as "Needs product match" for manual review
    return
```

This prevents misleading drafts (e.g., "Stock Out" when we don't know which product the customer is asking about).

---

## Implementation Order

| Step | File | Change |
|---|---|---|
| 1 | `master_handler.py` | Phase 1: enhanced tokenization + SKU priority |
| 2 | `master_handler.py` | Phase 2: IoU scoring + top-10 fetch |
| 3 | `master_handler.py` | Phase 3: threshold + ambiguity flag |
| 4 | `auto_draft_replies.py` | Add product-link gate before drafting |
| 5 | Test suite | Run against #7162, #10495, and 10 recent inquiries |

---

## Related
- [product_mapping_fix_plan.md](/Users/user/Documents/Mercari/Techstack/Inquiries/product_mapping_fix_plan.md)
- [master_handler.py](/Users/user/Documents/Mercari/Techstack/Inquiries/Scripts/master_handler.py)
- [auto_draft_replies.py](/Users/user/Documents/Mercari/Techstack/Inquiries/Scripts/auto_draft_replies.py)
