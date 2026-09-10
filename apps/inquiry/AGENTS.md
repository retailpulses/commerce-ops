# inquiry-automation AGENTS.md

## Architecture Governance

Architecture-affecting work must read in this order:

1. `docs/01_ARCHITECTURE.md` — canonical to-be architecture
2. `docs/00_CURRENT_STATE.md` — temporary operational delta
3. Governing `docs/phases/<phase-id>/README.md` or Issue
4. Relevant ADR/design
5. Database, sync-workload and deployment governance
6. Runtime evidence when production activation matters

Do not describe a declared target capability as Implemented, Deployed or Runtime verified before evidence exists. Architecture Changes require a bounded Phase, ADR, inventory updates and explicit completion evidence under `retailpulses/rp-governance-kit/docs/ARCHITECTURE_CHANGE_GOVERNANCE.md`.

## Status (2026-06-21) — Worker Runtime Canonical

The Cloudflare Worker under `apps/worker/` is the canonical runtime for inquiry
automation. The retired Python classification/drafting pipeline and its Baserow
adapter have been removed. Python remains only for the active Supabase-backed
VPS browser-enrichment runtime.

Make first-response automation, classification, product linking, drafting,
scheduling, and safety-policy fixes in `apps/worker/`. Changes under
`src/enrichment/` must remain Supabase-only and preserve the enrichment write
kill switch.

## Historical Status (2026-06-09) — Phase 2 MVP Complete

**190/190 tests passing.** Full pipeline was proven on production Baserow:
classify → link → draft → queue.

### Last Production Run (2026-06-09)

```
Pipeline: classify → draft → queue
Limit: 50 per step
Elapsed: 13.8s
Results:
  classify: 42 classified, 38 linked, 0 failed
  draft:    39 drafted (7 via LLM), 0 failed
  queue:    42 pending operator review
```

**Bugfixes applied during production validation:**
- `update_row`/`create_row` now passes `user_field_names=true` (Status writes were silently dropped)
- `products_table_id` fixed from inquiries→tickets table (was searching wrong table)
- ShopIndex disabled via `cache_ttl_minutes: 0` (VPS SSH tokens not configured)
- Status numeric option IDs confirmed: Received=5636894, Followed-up=6138517, Answered=6138516

## Credentials Map

| Env Var | Source | Status |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | scoped production secret store | ✅ Active runtime |
| `OPENAI_API_KEY` | `master_credentials.md` | ✅ Set in `.env` |
| `ZOHO_CLIENT_ID` | CF Worker `rp-mail-integration` secret | ❌ Not retrievable in plaintext |
| `ZOHO_CLIENT_SECRET` | CF Worker `rp-mail-integration` secret | ❌ Not retrievable in plaintext |
| `ZOHO_REFRESH_TOKEN` | CF Worker `rp-mail-integration` secret | ❌ Not retrievable in plaintext |

## Verified

- `rp-mail-integration` Worker healthy: `GET /health` → `{"ok":true}`
- Table 886975 (inquiries): 665 rows, field names match models
- Table 886994 (tickets/products): 5380 rows, field names match models
- Table 897440 (knowledge): 29 rows, field names match models
- Historical Python pipeline evidence is retained in Git history and reports
- Status updates persist correctly with `user_field_names=true`
- Operator queue is served by the Supabase-backed dashboard

## Key Decisions

- Worker runtime is canonical going forward
- Python monolith is retired from cron/operations
- Status flow: Received (5636894) → Followed-up (6138517) → Answered (6138516)
- LLM fallback uses gpt-4o-mini via OpenAI
- Product matching: SKU match → fuzzy search (ShopIndex disabled)
- No auto-send in Phase 1; operator reviews drafts from queue
- All scripts support `--dry-run`
- Tests must mock all external calls

## Table IDs

| Table | ID | Fields |
|---|---|---|
| inquiries | 886975 | 45 |
| tickets/products | 886994 | 131 |
| knowledge | 897440 | 9 |
| shop_listings | 884687 | 43 |

## VPS Enrichment Scripts

```bash
# Source env vars first
export $(grep -v '^#' .env | xargs)

python3 -m scripts.enrich_pending --dry-run --limit 5
python3 -m scripts.enrich_inquiry INQUIRY_ID --dry-run
```

## Cron Setup

Scheduled classification and drafting belong in `apps/worker/`. The Python
enrichment entry points must only be scheduled through their governed VPS
workload with `INQUIRY_ENRICHMENT_WRITES_ENABLED`.

## Known Gaps

1. **Email fetching**: `rp-mail-integration` syncs Zoho directly into canonical Supabase inquiries.
2. **ShopIndex product matching**: Requires VPS SSH tokens for Conoha. Falls back to SKU + fuzzy search. Slower for large batches but functional.
3. **Batch size**: Fuzzy search makes ~10 API calls per inquiry. For >50 items, batch or schedule smaller runs.

## Resume Flow (fresh session)

```bash
cd /Users/user/Documents/Retailpulses/20_REPOS/inquiry-automation

# 1. Source credentials
export $(grep -v '^#' .env | xargs)

# 2. Verify active runtimes
(cd apps/worker && npm test && npm run typecheck)
(cd apps/dashboard && npm test && npm run typecheck && npm run build)
python3 -m pytest tests/ -v

# 3. Dry-run VPS enrichment when relevant
python3 -m scripts.enrich_pending --dry-run --limit 3
```

## Supabase cutover

The Cloudflare Worker and Pages Functions are the selected production
architecture. Supabase is authoritative; the earlier Worker-vs-VPS database
decision is closed. VPS Python is limited to browser enrichment and also writes
only to Supabase.

## Test Commands

```bash
python3 -m pytest tests/ -v
(cd apps/worker && npm test && npm run typecheck)
(cd apps/dashboard && npm test && npm run typecheck && npm run build)
```

## Organization Standards

This repository follows shared organization standards defined in [`retailpulses/.github`](https://github.com/retailpulses/.github):

- **Architect Agent**: [`docs/agent-roles/architect-agent.md`](https://github.com/retailpulses/.github/blob/main/docs/agent-roles/architect-agent.md) — architecture review, design decisions, and code structure standards
- **Frontend Standards** (when UI work is involved): [`docs/agent-roles/frontend-agent.md`](https://github.com/retailpulses/.github/blob/main/docs/agent-roles/frontend-agent.md) and [`docs/frontend/frontend-design-guide.md`](https://github.com/retailpulses/.github/blob/main/docs/frontend/frontend-design-guide.md) — UI component patterns and design standards
