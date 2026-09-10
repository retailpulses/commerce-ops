# 007 — Mercari Inquiry Browser Enrichment

**Created:** 2026-06-24
**Branch:** `feature/mercari-browser-enrichment`
**Status:** Implementation

---

## Problem Statement

Mercari does not expose inquiry details via API. Five critical fields exist only on the Mercari Shops inquiry detail page and cannot be obtained from Zoho email notifications or any other data source. These fields must be extracted via browser automation from the logged-in Mercari Shops seller dashboard.

## Fields to Extract

| # | Extraction Key | Mercari Label | Baserow Table | Baserow Field Name | Field ID |
|---|---------------|---------------|---------------|-------------------|----------|
| 1 | `skuCode` | 商品管理コード | Products (886994) | item code (for product lookup) | 7670272 |
| 2 | `productId` | 商品ID | Inquiries (886975) | `MercariProdID` | 9199463 |
| 3 | `variantName` | 種類名 | Inquiries (886975) | `MercariVariantName` | 9199465 |
| 4 | `customerName` | お客さま名 | Inquiries (886975) | `Customer Nickname` | 7670090 |
| 5 | `messageContent` | (inquiry body) | Inquiries (886975) | `Inquiry body` | 7670144 |

- `skuCode` is used to look up/verify the linked product in the Products table — not written directly to Inquiries.
- The other four fields are written directly to the Inquiries table.

## Approach

### Extraction Script

A DevTools console script already exists at `outputs/extract-mercari-inquiry-fields.js` (Codex workspace). It queries the Mercari Shops inquiry detail page DOM — the page uses GraphQL `ShopInquiryPage` query rendering to `InquiryProductTarget` type — and extracts all five fields.

### Browser Automation

Codex CLI (computer-use) navigates a logged-in Chrome profile to the inquiry URL, evaluates the extraction JS, and returns the JSON result. Codex is chosen over Playwright/Puppeteer because previous scripted automation attempts failed against Mercari anti-bot detection.

### Runtime: MacBook + Cron (Path A)

- MacBook with existing Chrome profiles (4 shops)
- Cron every 10 min during business hours (JST weekdays)
- One-by-one processing: each inquiry gets its own Codex invocation
- Volume: ~3-5 inquiries/day → ~5-10 min total Codex time

## Deliverables

| File | Purpose |
|------|---------|
| `scripts/enrich_inquiry.py` | Process one inquiry: `python3 scripts/enrich_inquiry.py <row_id> [--dry-run]` |
| `scripts/enrich_pending.py` | Backfill all pending: `python3 scripts/enrich_pending.py [--dry-run] [--limit N] [--confirm]` |
| `src/enrichment/__init__.py` | Package init |
| `src/enrichment/extractor.py` | `MercariExtractor` class |
| `src/enrichment/extract-inquiry-fields.js` | Extraction script (copied from Codex workspace) |
| `src/enrichment/error.py` | `EnrichmentError`, `CodexError` |

### Modified

| File | Change |
|------|--------|
| `src/errors.py` | Add `EnrichmentError` |
| `config.yaml` | Add `enrichment:` section |
| `src/config.py` | Add enrichment config properties |
| `.gitignore` | Add `.runtime/enrichment/` |

## Shop → Chrome Profile Mapping

Each Mercari Shops seller account requires its own logged-in Chrome profile.

| Shop ID | Shop Name | Chrome Profile | Mercari Shop URL ID |
|---------|-----------|---------------|---------------------|
| 5637408 | Shop1 | TBD | TBD |
| 5637409 | Shop2 | TBD | TBD |
| 5637410 | Shop3 | TBD | TBD |
| 5637411 | Shop4 | TBD | TBD |

## Safety

- `--dry-run` prints diffs, makes zero Baserow writes
- `--confirm` prompts before each batch write
- Codex prompt explicitly forbids page mutation or message sending
- Single-inquiry isolation: one failure doesn't affect others
- Idempotent: skips rows that already have all four Inquiries fields populated

## Verification Plan

1. Copy extraction JS into `src/enrichment/extract-inquiry-fields.js`
2. `--dry-run` on one inquiry → inspect predicted writes
3. Run one real inquiry → verify Baserow fields
4. Spot-check: manually open same Mercari URL, compare values
5. Backfill: `--limit 10 --confirm` → validate → scale to all pending

## References

- DOM analysis: `outputs/mercari-inquiry-dom-analysis.md` (Codex workspace 2026-06-24)
- Extraction script: `outputs/extract-mercari-inquiry-fields.js` (Codex workspace 2026-06-24)
- Improvement proposal: `docs/proposals/inquiry-automation-improvement-2026-06-20.md` §3.6
- Implementation plan: `.claude/plans/explore-codebase-and-suggest-nifty-alpaca.md`
