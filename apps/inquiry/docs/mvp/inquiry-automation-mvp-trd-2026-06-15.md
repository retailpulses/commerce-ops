# Inquiry Automation MVP - Technical Requirements Document

**Date:** 2026-06-15
**Status:** Canonical MVP launch plan
**Version:** 1.0

---

## 1. MVP Scope

The MVP delivers an automated inquiry processing pipeline that reads new customer inquiries from Baserow, classifies them, links relevant products, and drafts replies for operator review - without sending any reply automatically.

### In Scope

- Read inquiries from Baserow table `886975` filtered by Status = Received (5636894)
- Classify inquiry type via keyword matching with LLM (gpt-4o-mini) fallback when keyword returns "Others"
- Link products to inquiries via SKU match then fuzzy name search (bounded 3-5 calls)
- Generate draft replies: template-based first, LLM fallback when no template matches
- Write classified type, product links, and draft back to Baserow with correct status transitions (Received -> Followed-up -> Answered)
- Operator review queue: inquiries with drafts, sorted by Inquiry Date
- Dry-run mode: log intended mutations without writing to Baserow
- Auth-protected HTTP endpoints: bearer token required for mutation endpoints
- Cron-driven execution: `*/30 * * * *` running classify then draft sequentially
- Python pipeline as production-validated fallback (190 tests passing)
- Cloudflare Worker as intended MVP runtime (dry-run safe until explicitly launched)

### Out of Scope (MVP)

- Auto-send replies to customers
- Email fetching from Zoho Mail (handled by `rp-mail-integration` Worker)
- ShopIndex product matching via Mercari API (no VPS fixed egress IP)
- Baserow job-log table writes (table 921591), unless explicitly requested later
- `/queue` HTTP endpoint
- Webhook or event-driven pipeline triggers
- Multi-language support beyond Japanese
- Dashboard, notification, or alerting beyond console/baserow logs
- Performance optimization for batches >50 rows per run

---

## 2. Non-Goals

- Production-grade observability (no Datadog, no Sentry; console logs, row state, and Durable Object metadata only)
- Zero-downtime deployments
- Horizontal scaling beyond single DO lock
- Handling duplicate or concurrent cron invocation beyond DO lock rejection
- Auto-retry of failed rows within same run (re-run on next cron)
- CI/CD pipeline automation

---

## 3. Source of Truth

| Layer | Source of Truth | Notes |
|-------|----------------|-------|
| Inquiry data | Baserow table `886975` | Inquiries arrive via `rp-mail-integration` Worker |
| Product data | Baserow table `886994` | Synced from GigaB2B; ~5380 rows |
| Knowledge base | Baserow table `897440` | 29 rows of FAQ/support patterns |
| Status | Baserow `Status` field (id `7670145`) | Single-select: Received (5636894), Followed-up (6138517), Answered (6138516) |
| Cursor position | Durable Object state | Supplementary only; status filter is primary |
| Lock state | Durable Object `JobStateDO` | Singleton writer guarantee |
| Secrets | Cloudflare `wrangler secret` | Not in `[vars]` or `.env` |

---

## 4. Architecture

```
+-----------------------------+
| rp-mail-integration Worker  |
| Zoho Mail -> Baserow        |
+--------------+--------------+
               |
               | new rows with Status=Received
               v
+------------------------------------------------------------+
| inquiry-automation Worker                                  |
|                                                            |
| Cron Trigger: */30 * * * *                                 |
|   scheduled() entry point                                  |
|   - if DRY_RUN=true: skip, log, and return                 |
|   - if cron matches */30 * * * *:                          |
|     1. runMasterHandler()                                  |
|        - acquire DO lock                                   |
|        - fetch Received rows by status filter              |
|        - classify with keywords, then LLM fallback         |
|        - link products by SKU, then fuzzy search           |
|        - patch row with type, products, and status         |
|        - advance cursor                                    |
|        - release DO lock                                   |
|     2. runAutoDraftReplies()                               |
|        - acquire DO lock                                   |
|        - fetch Followed-up rows by status filter           |
|        - select template or LLM draft                      |
|        - patch row with draft and status                   |
|        - release DO lock                                   |
|                                                            |
| HTTP handlers:                                             |
|   GET  /health                  unauthenticated            |
|   POST /run                     auth: Bearer ADMIN_TOKEN   |
|   POST /admin/reset-cursor      auth                       |
|   GET  /admin/state             auth                       |
|   POST /admin/release-lock      auth                       |
+------------------------------------------------------------+
```

### Runtime Options

| Environment | Pipeline Runtime | Dry-Run | Cron | Notes |
|-------------|-----------------|---------|------|-------|
| Local dev | Python | true only with `--dry-run` | disabled | `python3 -m scripts.run_pipeline --dry-run` |
| Worker staging | Cloudflare Worker | true | enabled (skips) | `DRY_RUN=true` in `wrangler.toml` |
| Worker production | Cloudflare Worker | false | enabled | After explicit launch decision |

---

## 5. Data / Status Flow

### Status State Machine

```
Received (5636894)
  -> classify + link: writes Inquiry Type + Products + Status=Followed-up (6138517)

Followed-up (6138517)
  -> draft: writes Inquiry Skill Reply + Reply Drafted At + Status=Answered (6138516)

Answered (6138516)
  -> operator reads from queue (no automated mutation)
```

### Guard Rules

- **Classification:** Skip if `Inquiry Type` already set and `FORCE_REGENERATE=false`
- **Product link:** Skip if `Products` already populated and `FORCE_REGENERATE=false`
- **Draft:** Skip if `Inquiry Skill Reply` already set and `FORCE_REGENERATE=false`
- **Status:** Verify current status matches expected before writing; skip row if mismatch
- **Okinawa:** Skip drafting for Okinawa-related inquiries (operator handles manually)
- **Price negotiation:** Skip template drafting (operator negotiates manually)

---

## 6. Baserow Fields / Table Assumptions

### Inquiries Table (886975) - Key Fields

| Field Name | Type | ID | Notes |
|------------|------|----|-------|
| Status | Single-select | 7670145 | Received/Followed-up/Answered/Closed |
| Inquiry Type | Single-select | (via API) | 10 types: Okinawa, Bulk, Price, etc. |
| Products | Link to table | (via API) | Links to tickets/products table |
| Inquiry Skill Reply | Long text | (via API) | Generated draft reply |
| Reply Drafted At | Date | (via API) | Timestamp of last draft write |
| Inquiry Date | Date | (via API) | Used for cursor ordering |
| Last Custom Message | Long text | (via API) | Latest customer message content |
| Inquiry body | Long text | (via API) | Original inquiry body |
| Product Name | Text | (via API) | Product name from source |
| Customer Nickname | Text | (via API) | Customer display name |
| Last inbound time | Date | (via API) | Used for stale-draft detection |
| OrderID | Text | (via API) | Extracted order ID |

### Products / Tickets Table (886994) - Key Fields

| Field Name | Type | Notes |
|------------|------|-------|
| item code | Text | SKU for product matching |
| Item Name | Text | Product display name |
| ... | 131 total | Full product catalog |

### Field ID Discovery

All field IDs must be verified against live Baserow API before deployment changes. The `src/config.ts` and Python `src/config.py` contain the current known mapping.

---

## 7. Endpoint Contract

### `GET /health`

**Auth:** None

Response:
```json
{
  "ok": true,
  "name": "inquiry-automation-worker",
  "version": "0.1.0",
  "dryRun": true
}
```

### `POST /run`

**Auth:** Bearer `ADMIN_TOKEN`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `dryRun` | bool | `true` | Log actions without writing to Baserow |
| `rowIds` | string | (all filtered) | Comma-separated explicit row IDs |
| `step` | enum | `all` | `classify`, `draft`, or `all` |
| `limit` | int | `MAX_ROWS_PER_RUN` | Max rows to process |
| `force` | bool | `false` | Override no-overwrite guards |

Response:
```json
{
  "status": "completed",
  "runId": "run-1718465400000",
  "step": "all",
  "results": {
    "classify": { "status": "completed" },
    "draft": { "status": "completed" }
  }
}
```

### `POST /admin/reset-cursor`

**Auth:** Bearer `ADMIN_TOKEN`

**Query Parameters:** `job=master-handler`, `to=<ISO timestamp>`

### `GET /admin/state`

**Auth:** Bearer `ADMIN_TOKEN`

**Query Parameters:** `job=master-handler`

### `POST /admin/release-lock`

**Auth:** Bearer `ADMIN_TOKEN`

**Query Parameters:** `job=master-handler`

---

## 8. Dry-Run / Live-Run Gates

| Gate | Mechanism | Default |
|------|-----------|---------|
| Worker level | `DRY_RUN` env var in `wrangler.toml` | `true` |
| Per-request | `dryRun` query param on `POST /run` | true (uses env default) |
| Cron execution | Checks `config.runtime.dryRun` before processing | skipped when `true` |
| Python scripts | `--dry-run` flag | live writes unless `--dry-run` is explicitly provided |

**Live-run launch protocol (sequential, not concurrent):**

1. Deploy Worker with `DRY_RUN=true` (default - no flag change needed)
2. Run explicit-row dry-run smoke: `POST /run?dryRun=true&rowIds=<known_ids>&step=all`
3. Review proposed payloads match expected output
4. Run explicit-row live pilot: `POST /run?dryRun=false&rowIds=<known_ids>&step=all`
5. Verify Baserow state directly
6. Stop Python cron: `crontab -l | grep -v inquiry-automation | crontab`
7. Set `DRY_RUN=false` in production Worker environment
8. Enable Worker cron trigger
9. Monitor first 3 production cron runs

---

## 9. Rollout Phases

| Phase | Description | Success Criteria |
|-------|-------------|-----------------|
| 0 | Python pipeline production-validated | 190/190 tests; full pipeline run on prod data |
| 1 | Worker port complete, tests passing | 37+ Worker tests passing; `npx tsc --noEmit` clean |
| 2 | Worker dry-run verification on prod | `POST /run?dryRun=true&rowIds=x,y,z` matches Python output |
| 3 | Explicit-row live pilot | `POST /run?dryRun=false&rowIds=x,y,z` writes correct data |
| 4 | Python cron disabled | `crontab -l` confirms no inquiry-automation entries |
| 5 | Worker DRY_RUN=false, cron enabled | Worker handles production traffic; monitor first 3 runs |
| 6 | Python pipeline retired | Repo cleanup; Python code archived |

---

## 10. Rollback Plan

1. Disable Worker cron immediately (remove or comment cron trigger in `wrangler.toml`)
2. Deploy or confirm `DRY_RUN=true` in Worker env
3. Re-enable Python cron: copy from `crontab.bak` or `crontab.example`
4. Verify Python pipeline processes backlog
5. Confirm no Worker and Python write mode are running concurrently
6. Investigate root cause from Worker console logs (`wrangler tail`)

---

## 11. Observability

| Layer | Mechanism | Durable? |
|-------|-----------|----------|
| Worker console | `console.log` / `console.error` | No (debugging only) |
| Cloudflare dashboard | `wrangler tail`, dashboard logs | 7-day retention |
| Baserow job log table | Table 921591 (excluded from MVP unless requested) | Not active |
| Baserow row state | Status field transitions on each row | Yes |
| Run metadata | `JobStateDO` run metadata | Yes (DO persistence) |

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Baserow field ID drift | Medium | High | Verify IDs against live API before deployment; `src/config.ts` is single source |
| DO lock failure | Low | Medium | Manual `/admin/release-lock` endpoint; re-run on next cron |
| Subrequest limit (1000/free) | Low | Medium | Budget ~140/run at 20 rows; monitor with `wrangler tail` |
| Worker execution timeout (15min) | Low | Low | Start with `MAX_ROWS_PER_RUN=20`; classify+draft complete in <60s at 50 rows in Python |
| OpenAI cost spike | Medium | Medium | `LLM_MAX_CALLS_PER_RUN=10` cap; dry-run disables LLM calls |
| Python + Worker write overlap | Low (process) | High | Sequential migration protocol; DO lock prevents intra-Worker overlap only |
| KV eventual consistency | Low | Low | Cursor is optional/supplementary; not used for correctness |

---

## 13. Acceptance Criteria

- [ ] Python: `python3 -m pytest tests/ -q` passes (190 tests)
- [ ] Worker: `npm test` (fork pool) passes (37+ tests)
- [ ] Worker: `npx tsc --noEmit` produces no errors
- [ ] Worker: `GET /health` returns 200 with correct payload
- [ ] Worker: `POST /run?dryRun=true` returns proposed payloads without Baserow mutations
- [ ] Worker: `POST /run` without auth returns 401
- [ ] Worker: cron with `DRY_RUN=true` logs skip and returns (no Baserow writes)
- [ ] Worker: cron with `DRY_RUN=false` runs classify then draft sequentially
- [ ] Worker: status filter selects only Received rows for classify, Followed-up for draft
- [ ] Worker: no-overwrite guards prevent duplicate classification/draft
- [ ] Worker: per-job DO lock prevents overlapping classify jobs and overlapping draft jobs
- [ ] Worker: global `/run` lock decision is documented as a post-MVP gap
- [ ] Worker: explicit `rowIds` path works for both steps
- [ ] Migration: `docs/worker/migration-status.md` accurately tracks current state
- [ ] Documentation: TRD + runbook committed at `docs/mvp/`
