# Worker Migration Status

Date: 2026-06-15
Source: `inquiry-handler` → `inquiry-automation/apps/worker/`

## Safety Contract Status

Patches applied per `REFACTOR-WORKER.md`:

| Requirement | Status | Notes |
|---|---|---|
| Admin bearer auth guard | Implemented | `authGuard()` checks `ADMIN_TOKEN` secret on `/run` and `/admin/*` |
| `/health` endpoint (unauthenticated) | Implemented | Returns `ok`, name, version, dryRun |
| `/run` endpoint with `dryRun`, `rowIds`, `limit`, `step`, `force` | Implemented | `POST /run?dryRun=true&rowIds=1,2,3&step=classify` |
| Status-field filtering as primary selector | Implemented | `filter__field_7670145__single_select_equal=<option_id>` used; cursor supplementary only |
| Correct status transitions | Fixed | classify → Followed-up (6138517); draft → Answered (6138516) |
| No-overwrite guards | Implemented | Skips classification if `Inquiry Type` exists; skips draft if `Inquiry Skill Reply` exists; skips product link if `Products` exists; all guardable unless `force=true` |
| Dry-run safe by default | Implemented | `DRY_RUN=true` in wrangler.toml; cron skips when dry-run |
| Explicit rowIds path | Implemented | `POST /run?rowIds=1,2,3` fetches individual rows by ID |
| ShopIndex disabled | Implemented | `getShopListings: null` in master-handler; TTL=0 |
| DO singleton lock | Preserved | `JobStateDO` with `acquireLock`/`releaseLock` |
| `user_field_names=true` | Preserved | In Baserow client fetchRows/patchRow |
| fetchRows bounded by size | Fixed | fetchRows stops following next pages after accumulating `size` rows; callers using `size: "1"` or `size: "100"` now get at most that many rows |
| acquireLock lock expiry | Fixed | `lockedUntil` now stores `now + ttlMs` instead of `now`; lock properly prevents concurrent runs for the full TTL window |

## Remaining Gaps

| Gap | Priority | Notes |
|---|---|---|
| Worker tests | Medium | Tests ported from inquiry-handler; pass/fail depends on Vitest/CF Workers environment |
| `/queue` HTTP endpoint | Low | Not yet implemented; `operator_queue` available in Python scripts |
| Baserow job-log table writes | Excluded from MVP | Not wired; add only if explicitly requested for a later phase |
| DO singleton lock for `/run` endpoint | Medium | Lock acquired per-job (master, draft) but `/run` could overlap classify+draft |
| Cron schedule alignment | Resolved | `*/30 * * * *` trigger now matches `wrangler.toml`; scheduled handler runs classify then draft sequentially |
| Cloudflare-pool test harness | Medium | `npm test` runs stable unit tests with the fork pool; `npm run test:cf` currently exits because Wrangler cannot write to `/Users/user/.wrangler/logs` in this sandbox |
| MVP TRD | Published | `docs/mvp/inquiry-automation-mvp-trd-2026-06-15.md` - canonical requirements document |
| MVP runbook | Published | `docs/mvp/inquiry-automation-mvp-runbook-2026-06-15.md` - operator launch/rollback steps |
| Worker README | Published | `apps/worker/README.md` - self-describing entry point linking to TRD/runbook/migration |

## Blockers

- Worker tests require Cloudflare Vitest pool which may need `wrangler.toml` config and KV/DO simulation
- Admin token must be set via `wrangler secret put ADMIN_TOKEN` before any authenticated endpoint works

## Test Results

Unit tests passing as of 2026-06-15:

| Suite | Tests | Result |
|---|---|---|
| Python (`python3 -m pytest tests -q`) | 190 | Passed |
| Worker unit (`npm test`) | 37 | Passed (3 files: classify, templates, product-match) |
| Worker Cloudflare pool (`npm run test:cf`) | n/a | Blocked by local Wrangler log write permission: `EPERM` opening `/Users/user/.wrangler/logs/...`; no test failures are emitted |

### Worker test suites

- `test/classify.test.ts` — 18 tests: keyword classification, isOkinawa
- `test/product-match.test.ts` — 6 tests: SKU match, fuzzy search, shop index, issue #7162 scenario
- `test/templates.test.ts` — 13 tests: Stock_Out_A/B, Bulk_Purchase, Shipping, Product_Spec, No_Product_Info, Price negotiation skip, Others fallback

## Version

Source absorbed from `inquiry-handler` (unfinished Worker port) on 2026-06-15.
