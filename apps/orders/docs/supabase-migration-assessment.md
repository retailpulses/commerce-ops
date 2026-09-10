# Supabase Migration Assessment

## Executive Summary

**Assessment Date:** 2026-07-10  
**Repo:** `retailpulses/OrderMgmt` (standalone, carved from `retailpulses/workers` on 2026-06-07)  
**Current DB:** Baserow (hosted Airtable-alternative, REST API)  
**Target DB:** Supabase (hosted PostgreSQL + built-in auth, realtime, storage, edge functions)  

**Overall assessment: The codebase is well-prepared for migration.** The repository/adapter pattern is cleanly enforced, the channel-config abstraction is excellent, and documentation quality is above average. The primary challenges are: (1) Baserow's spreadsheet-like data model does not map 1:1 to relational PostgreSQL, (2) the Worker-based Portal SPA needs a full rewrite for a modern UI framework, and (3) the Worker `index.js` monolithic file needs decomposition before migration.

---

## 1. Current State Summary

### 1.1 Architecture

```
┌──────────────────────────────────────────────────────┐
│  Cloudflare Worker  (rp-order-mgmt.workers.dev)      │
│  ┌─ 13 cron triggers (pipeline orchestration)        │
│  ├─ Portal SPA (inline HTML + vanilla JS)            │
│  ├─ Portal REST API  (~20 endpoints)                  │
│  ├─ Admin API  (run-once, dry-run, stuck-*)           │
│  └─ Pipeline executor (6 phases × 2 channels)         │
└──────────┬───────────────────────────────────────────┘
           │ HTTPS                    │ HTTPS
┌──────────▼──────────────┐  ┌───────▼──────────────────┐
│  VPS Relay (ConoHa)     │  │  Baserow (api.baserow.io) │
│  Node HTTP on :8787     │  │  - Mercari Sales (903318) │
│  - Mercari GraphQL proxy│  │  - Rakuten Sales (1015675)│
│  - Rakuten RMS proxy    │  │  - Giga Shipments (903319)│
│  - Script spawner       │  │  - Products (886994)      │
└─────────────────────────┘  └──────────────────────────┘
```

### 1.2 Stats

| Metric | Value |
|--------|-------|
| Total code lines | ~33,855 |
| Source modules (lib/) | 33 `.mjs` files + 5 portal sub-modules |
| Test files | 21 files |
| Tests passing | **558 / 558** (100%) |
| Worker entry | 2,698 lines (single file — too large) |
| Relay server | 1,265 lines |
| CLI entry | 384 lines |
| Scripts | 27 one-off maintenance scripts |
| Documentation | 14 markdown files |
| Runtime dependencies | **0** (only `wrangler` devDep) |
| CalVer | `v2026.6.2.1` |

### 1.3 Pipeline Phases

| # | Phase | Cron | Channel |
|---|-------|------|---------|
| 1 | `pull_shop_orders` | hourly x:01 | Mercari |
| 2 | `build_giga_shipments` | every 10 min (x:03/13/...) | Mercari + Rakuten |
| 3 | `push_orders_to_giga` | every 10 min (x:06/16/...) | Mercari + Rakuten |
| 4 | `pull_giga_tracking` | every 10 min (x:08/18/...) | Mercari + Rakuten |
| 5 | `close_shop_orders` | every 10 min (x:09/19/...) | Mercari |
| 6 | `reconcile_end_to_end` | every 10 min (x:11/21/...) | Mercari |
| — | `reconcile_cancellations` | daily 14:50 | Mercari |
| — | `pull_rakuten_orders` | hourly x:02 | Rakuten |
| — | `confirm_rakuten_orders` | every 10 min (x:04/14/...) | Rakuten |

---

## 2. Documentation Quality Review

### 2.1 What's Good

| Document | Quality | Notes |
|----------|---------|-------|
| `CLAUDE.md` | ★★★★★ | Excellent architecture reference. Covers identity, stack, pipeline, conventions, deployment. ~200 lines of dense, accurate documentation. |
| `README.md` | ★★★★☆ | Clean, accurate. Covers quickstart, commands, URLs, secrets, deployment, rollback. |
| `docs/operations.md` | ★★★★☆ | Practical ops runbook: health checks, logs, systemd, failure cases. |
| `docs/deployment.md` | ★★★★★ | Thorough: flow, smoke tests, secrets, rollback, dev-skip rationale. |
| `docs/vps-relay.md` | ★★★★☆ | Detailed migration guide with exact systemd unit, env vars, rollback steps. |
| `docs/sales-order-review.md` | ★★★★★ | Comprehensive design doc: architecture diagrams, file-by-file changes, edge cases, migration plan, auto-approval spec. |
| `docs/migration-from-monorepo.md` | ★★★★☆ | Clean migration record with source SHA, path changes, removal plan. |
| `OrderMgmt架构分析报告.md` | ★★★★★ | Professional third-party architecture audit (Chinese). Identifies exact problems with fix priorities. Already actioned P0-P1 items. |
| `docs/testing/tracking-reconciler-cases.md` | ★★★★☆ | Integration test cases. |
| `docs/testing/portal-mobile-test-plan.md` | ★★★☆☆ | Mobile test plan exists, could use more detail. |
| `docs/trd/order-pipeline-integrity-control-plane-hardening.md` | ★★★★☆ | Technical design doc for pipeline integrity. |
| `docs/gate-9-runtime-smoke-test.md` | ★★★☆☆ | Smoke test doc. |
| `docs/test-plan-rakuten-order-cycle.md` | ★★★★☆ | Test plan for Rakuten. |
| `docs/unread-message-detection-design.md` | ★★★★☆ | Design for message detection feature. |
| `docs/rms-api-unknowns.md` | ★★★☆☆ | Documents API uncertainties (useful but incomplete). |

### 2.2 Gaps to Address Before Migration

| Gap | Severity | Action |
|-----|----------|--------|
| `docs/00_CURRENT_STATE.md` is a template (all fields empty) | Low | Fill or delete — it's misleading as-is |
| `docs/05_DECISION_LOG.md` is a template (no entries) | Medium | Either populate with key decisions (monorepo split, channel-config pattern, review gate) or delete |
| No data model documentation | **High** | Must document the Baserow schema before migrating to Supabase — table structures, field types, relationships, option IDs |
| No API contract docs (Portal REST API) | Medium | The Portal has ~20 endpoints but no OpenAPI/Swagger spec — will be needed for new UI |
| No entity-relationship diagram | **High** | Sales → Shipments → Giga tracking → Marketplace close — the data flow needs formal modeling |
| No VPS inventory doc referenced from this repo | Low | `CLAUDE.md` mentions `docs/infra/vps-inventory.md` but it doesn't exist in this standalone repo |

### 2.3 Documentation Score: **7.5/10**

Strong operational docs and design specs. Main gap is the **absence of formal data model documentation**, which is critical for any database migration.

---

## 3. Codebase Health Review

### 3.1 Architecture Strengths (Confirmed by Audit)

1. **Repository/Adapter pattern enforced.** Business logic (`src/lib/*.mjs`) never calls vendor APIs directly. `baserow.mjs`, `giga-client.mjs`, `mercari-relay.mjs`, `rakuten-relay.mjs` are the only adapter files. This makes replacing Baserow with Supabase a **single-adapter change**.

2. **Channel-config abstraction.** `src/lib/channel-config.mjs` uses pure data objects to parameterize multi-platform behavior. Adding a new sales channel requires zero code changes to the tracking reconciler, outbound sync, or pipeline health modules. This pattern should be **preserved and extended** in Supabase.

3. **State machine hardening.** `src/lib/order-state.mjs` defines all status constants, `getPipelineState()` composite state computation, and `isValidReviewMutation()` transition validation. Recently hardened (2026-06-18), 228 tests passing.

4. **Idempotency and safety.** All pipeline phases support `--dry-run`. Bulk operations have `--limit`. Order ID normalization (`order_` prefix stripping) is consistent. Run IDs (`run_{timestamp}_{random8}`) enable audit trails.

5. **Test coverage.** 558 tests passing, 0 failures. Coverage spans order state, auto-approval, shipment projection, tracking reconciliation, product resolution, buyer messages, fee orders, and more.

### 3.2 Technical Debt (from Architectural Audit + Verified)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Worker/CLI pipeline code duplication | 🔴 High | Not yet addressed |
| 2 | `worker/index.js` is 2,698-line monolith | 🔴 High | Not yet addressed |
| 3 | Portal handler logic lives in Worker, not in `src/lib/portal/` | 🟡 Medium | Partially addressed |
| 4 | `package.json` has zero runtime dependencies (implicit deps) | 🟡 Medium | By design (CF Workers) |
| 5 | `scripts/` directory has 27 files with no subdirectory organization | 🟡 Medium | Not yet addressed |
| 6 | Relay uses raw `http` module (no routing framework) | 🟢 Low | Not blocking |
| 7 | No TypeScript | 🟢 Low | Architectural choice |
| 8 | Rakuten close API unverified | 🔴 High | ✅ **Fixed** — cron removed, manual-only |

### 3.3 P0-P1 Fixes Already Completed (from Audit)

- ✅ Rakuten close cron removed from production
- ✅ CI false-passes fixed (PR checks now fail-closed)
- ✅ `npm test` now runs all test files (was missing `test/*.test.mjs`)
- ✅ Wrangler pinned as exact-version devDep
- ✅ CLI hardcoded path replaced with project-relative `.env`
- ✅ All deployed to production (Cloudflare Version `b97bd42b`)

### 3.4 Codebase Health Score: **7.0/10**

The foundation is solid with clear architectural patterns. The two 🔴 issues (Worker monolith + code duplication) are the main blockers to address **before** migration, as they create unnecessary complexity in the migration itself.

---

## 4. Baserow → Supabase Migration Analysis

### 4.1 Current Baserow Usage

| Table | Baserow ID | Rows (est.) | Role |
|-------|-----------|-------------|------|
| Mercari Sales Orders | `903318` | ~1,000+ | Source of truth — all Mercari orders |
| Rakuten Sales Orders | `1015675` | ~100+ | Source of truth — all Rakuten orders |
| Giga Shipment Orders | `903319` | ~1,000+ | Projected shipments, sync status, tracking |
| Products | `886994` | ~100+ | Product catalog for margin/stock lookups |
| Pipeline Runs | (optional) | — | Audit log table |

### 4.2 Baserow-Specific Patterns That Must Change

| Baserow Pattern | Current Usage | Supabase Equivalent |
|-----------------|---------------|---------------------|
| `?user_field_names=true` | All API calls use field names, not IDs | Native SQL column names |
| `filter__field_{ID}__{operator}` | Server-side filtering via query params | PostgreSQL `WHERE` clauses via PostgREST or raw SQL |
| Single-select fields | `order_status`, `review_status`, `giga_sync_status` as option IDs | PostgreSQL `ENUM` types or lookup tables with foreign keys |
| `listAllRows()` pagination | Baserow pagination with `next` URL | PostgreSQL `LIMIT`/`OFFSET` or keyset pagination |
| Row-level `id` (integer) | Baserow auto-increment row ID | Supabase `id` (UUID or serial) |
| No transactions | Each API call is independent | PostgreSQL transactions for consistency |
| No foreign keys | Cross-table lookups done client-side in JS | Proper `FOREIGN KEY` constraints |
| No unique constraints | Dedup done in application code | `UNIQUE` constraints at database level |
| Baserow "option IDs" | Option values stored as opaque IDs like `"59xxxxx"` | Human-readable ENUM values or lookup references |

### 4.3 What the Migration Enables

| Capability | Baserow Today | Supabase Tomorrow |
|------------|---------------|-------------------|
| Relational integrity | ❌ Client-side joins | ✅ Foreign keys, constraints |
| Transactions | ❌ | ✅ Atomic multi-table operations |
| Rich queries | ❌ Basic filters only | ✅ Full SQL: JOINs, aggregations, window functions |
| Real-time updates | ❌ | ✅ Supabase Realtime (WebSocket subscriptions) |
| Auth (row-level security) | ❌ API token only | ✅ RLS policies, multi-role auth |
| File/asset storage | ❌ | ✅ Supabase Storage |
| Edge functions | ❌ (separate CF Worker) | ✅ Supabase Edge Functions (Deno) |
| Full-text search | ❌ Basic `__contains` | ✅ PostgreSQL full-text search (`tsvector`) |
| Backup/point-in-time recovery | ❌ | ✅ Supabase managed backups |
| API auto-generation | ❌ Manual REST client | ✅ PostgREST auto-generated API |

### 4.4 Migration Scope — What Moves Where

```
BEFORE (Current)                          AFTER (Supabase Migration)
─────────────────────────────             ─────────────────────────────

┌─ Baserow ────────────────┐             ┌─ Supabase PostgreSQL ─────┐
│ Mercari Sales (903318)    │             │ mercari_sales             │
│ Rakuten Sales (1015675)   │    ────▶    │ rakuten_sales             │
│ Giga Shipments (903319)   │             │ giga_shipments            │
│ Products (886994)         │             │ products                  │
│ Pipeline Runs (audit)     │             │ pipeline_runs             │
└───────────────────────────┘             │ order_memos              │
                                          │ message_read_states       │
┌─ Cloudflare KV ──────────┐             │ portal_templates          │
│ Portal session cache      │    ────▶    └───────────────────────────┘
│ Durable message state     │
│ Portal templates          │             ┌─ Supabase Storage ───────┐
└───────────────────────────┘             │ (future: CSV exports,     │
                                          │  product images, etc.)    │
┌─ Cloudflare Worker ──────┐             └───────────────────────────┘
│ Portal SPA (inline HTML)  │
│ Portal REST API           │    ────▶    ┌─ New Frontend App ────────┐
│ Admin API                 │             │ React/Next.js SPA         │
│ Pipeline cron orchestrator│             │ Hosted on VPS or Vercel   │
└───────────────────────────┘             │ Uses Supabase JS client   │
                                          │ Replaces Baserow UI       │
┌─ VPS Relay ──────────────┐             │ Replaces Worker Portal     │
│ Mercari GraphQL proxy     │    ────▶    └───────────────────────────┘
│ Rakuten RMS proxy         │    KEEP
│ Script spawner            │    (Unchanged — IP-restricted)
└───────────────────────────┘

                                          ┌─ Pipeline Runtime ───────┐
                                          │ Option A: Keep on CF      │
                                          │ Option B: Supabase Edge   │
                                          │ Option C: VPS cron+Node   │
                                          └───────────────────────────┘
```

### 4.5 Adapter Replacement Strategy

The `src/lib/baserow.mjs` adapter (~28% of codebase interaction surface) is the **only file that directly calls Baserow APIs**. All business logic imports from it:

```javascript
// Current (baserow.mjs adapter)
import { createBaserowClient, listAllRows, patchRow, createRow } from "./baserow.mjs";

// Future (supabase adapter — same interface)
import { createSupabaseClient, listAllRows, patchRow, createRow } from "./supabase.mjs";
```

**Migration approach:** Write a `src/lib/supabase.mjs` adapter that implements the same function signatures. The 33 business-logic modules should require **zero changes** if the adapter interface is preserved.

Key functions to port:
- `createBaserowClient(env)` → `createSupabaseClient(env)`
- `listAllRows(client, tableId, filters)` → query with filters
- `listRowsWithLimit(client, tableId, filters, limit)` → query with LIMIT
- `patchRow(client, tableId, rowId, fields)` → UPDATE
- `createRow(client, tableId, fields)` → INSERT
- `BASEROW_FIELD` / `BASEROW_OPTION` constants → Column name constants

---

## 5. Modern UI Application — Target Architecture

### 5.1 Recommended Stack

| Layer | Recommendation | Rationale |
|-------|---------------|-----------|
| **Frontend Framework** | **Next.js 15** (App Router) | Server components, API routes, ISR for caching. Deployable to VPS or Vercel. |
| **UI Components** | **shadcn/ui** (Radix + Tailwind) | Accessible, customizable, Japanese-friendly. |
| **Database** | **Supabase** (PostgreSQL) | Managed Postgres + auto-generated REST API + auth + realtime. |
| **API Layer** | **Next.js API Routes** + **Supabase JS Client** | Thin API layer using Supabase client directly. Auth via Supabase Auth. |
| **State Management** | **TanStack Query** (React Query) | Server-state caching, auto-refetch, pagination. |
| **Real-time** | **Supabase Realtime** | Live order status updates in the dashboard. |
| **Background Jobs** | **pg_cron** (Supabase) or **VPS cron** | Pipeline phases as scheduled PostgreSQL functions or Node scripts on VPS. |
| ** LLM / AI** | Keep existing `openai-client.mjs` | Already working — port to Edge or API route. |

### 5.2 Why This Stack

1. **Supabase eliminates Baserow's limitations** — foreign keys, transactions, rich queries, RLS, real-time subscriptions.
2. **Next.js on VPS** aligns with the project's VPS-first philosophy (CLAUDE.md: "VPS is the runtime target").
3. **shadcn/ui** is lightweight, copy-paste components (no npm dependency), and easy to customize for Japanese business needs.
4. **Single database** — Supabase becomes the sole source of truth, replacing Baserow + Cloudflare KV.
5. **Keeps the Relay** — Mercari/Rakuten APIs still need the VPS relay for fixed-IP access. This architecture preserves that.

### 5.3 New UI Pages (Replacing Baserow + Worker Portal)

| Page | Replaces | Priority |
|------|----------|----------|
| **Order Review Queue** | Baserow filtered view + Worker Portal | P0 |
| Order Detail (with messages, memo, edit) | Worker Portal `/api/portal/orders/:id` | P0 |
| Bulk Approve | Worker Portal `/api/portal/orders/bulk-approve` | P0 |
| Fee Orders | Worker Portal `/api/portal/fee-orders` | P1 |
| Presale Dashboard | Worker Portal `/api/portal/presale` | P1 |
| Pipeline Health Dashboard | Worker `/admin/run-once` health snapshot | P1 |
| Stuck Orders / Tracking / Close | Worker admin endpoints | P1 |
| Message Templates CRUD | Worker Portal templates | P2 |
| Product Catalog | Baserow Products table | P2 |
| Settings / Config | `.env` + `wrangler.toml` | P2 |

### 5.4 Pipeline Runtime Decision

The pipeline (cron → ingest → project → sync → track → close) currently runs on Cloudflare Workers. After migration, three options:

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **A: Keep on CF Worker** | Zero changes to pipeline, proven reliability | Two platforms to maintain (CF + VPS) | Keep for Phase 1 |
| **B: Supabase Edge Functions** | Single platform, Deno runtime | 60s timeout (CF has 30s CPU); needs Deno porting | Evaluate later |
| **C: VPS cron + Node** | Full control, no timeout, already have VPS | More ops burden (systemd timers) | Target for Phase 2 |

**Recommendation: Option A → Option C.** Keep pipeline on CF Workers during Phase 1 (data migration + UI build). Move to VPS cron in Phase 2 for full platform consolidation.

---

## 6. Phased Migration Roadmap

### Phase 0 — Pre-Migration Cleanup (2-3 days)

**Goal:** Address the 🔴 technical debt before adding migration complexity.

| Step | Action | Effort |
|------|--------|--------|
| 0.1 | Extract `pipeline-runner.mjs` from Worker and CLI — single shared `runPipeline`/`executePhase`/`runPhase` | 1 day |
| 0.2 | Split `worker/index.js` into `worker/router.js` + `worker/handlers/portal.js` + `worker/handlers/admin.js` | 1 day |
| 0.3 | Document current Baserow schema as formal data model (`docs/data-model.md`) | 0.5 day |
| 0.4 | Create OpenAPI spec for Portal API (`docs/api/portal-openapi.yaml`) | 0.5 day |

### Phase 1 — Supabase Database Migration (1 week)

**Goal:** Replicate Baserow schema in Supabase, write adapter, switch over with zero downtime.

| Step | Action | Effort |
|------|--------|--------|
| 1.1 | Design Supabase schema: tables, columns, types, foreign keys, indexes, RLS policies | 1 day |
| 1.2 | Create migration SQL (`supabase migration new`) | 0.5 day |
| 1.3 | Write `src/lib/supabase.mjs` adapter with same interface as `baserow.mjs` | 2 days |
| 1.4 | Write data migration script: Baserow → Supabase one-time export/import | 1 day |
| 1.5 | Switch Worker env vars: `DATABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` replaces `BASEROW_DATABASE_TOKEN` | 0.5 day |
| 1.6 | Parallel run: write to both Baserow and Supabase for 48h, compare | 1 day |
| 1.7 | Cut over: stop Baserow writes, full Supabase | 0.5 day |

### Phase 2 — Modern UI Application (2-3 weeks)

**Goal:** Replace Baserow UI + Worker Portal SPA with Next.js application.

| Step | Action | Effort |
|------|--------|--------|
| 2.1 | Initialize Next.js 15 project with shadcn/ui, Tailwind, Supabase JS client | 1 day |
| 2.2 | Build auth layer: Supabase Auth (email/password) + RLS policies | 1 day |
| 2.3 | Build Order Review Queue page (filterable table, review status, badges) | 3 days |
| 2.4 | Build Order Detail page (messages, memo, edit fields, approve/hold) | 3 days |
| 2.5 | Build Bulk Approve flow | 1 day |
| 2.6 | Build Pipeline Health dashboard | 2 days |
| 2.7 | Build Presale dashboard + Fee Orders | 2 days |
| 2.8 | Deploy to VPS (Docker + systemd, behind Cloudflare Tunnel) | 1 day |

### Phase 3 — Pipeline Consolidation (1-2 weeks)

**Goal:** Move pipeline from CF Workers to VPS cron, eliminate Cloudflare dependency.

| Step | Action | Effort |
|------|--------|--------|
| 3.1 | Port pipeline runner to standalone Node script using Supabase adapter | 2 days |
| 3.2 | Replace 13 CF cron triggers with systemd timers | 0.5 day |
| 3.3 | Parallel run for 72h | 1 day |
| 3.4 | Decommission CF Worker (keep relay, keep Cloudflare Tunnel for VPS) | 0.5 day |

### Phase 4 — Polish & Advanced Features (ongoing)

| Feature | Effort |
|---------|--------|
| Real-time order status updates via Supabase Realtime | 1 day |
| Email/push notifications for new orders needing review | 2 days |
| CSV export for accounting (replaces manual Baserow exports) | 1 day |
| Dark mode (shadcn/ui built-in) | 0.5 day |
| Mobile-responsive PWA | 2 days |
| TypeScript migration (incremental) | Ongoing |

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Data migration errors** (wrong types, missing rows, encoding issues with Japanese text) | Medium | High | Parallel run for 48h with automated diffing. Dry-run import first. |
| **Supabase adapter behavior differences** (pagination, filtering, option IDs vs. ENUMs) | Medium | Medium | Comprehensive adapter test suite before switch. Keep Baserow adapter as fallback. |
| **Pipeline downtime during cutover** | Low | High | Parallel write strategy. Rollback = switch `DATABASE_URL` env var back. |
| **Worker timeout with Supabase queries** (different latency profile) | Low | Medium | Keep server-side filtering. Benchmark before cutover. |
| **VPS relay remains single point of failure** | Low | Medium | Already the case today. No change. Future: add health-check + auto-restart. |
| **Japanese character encoding issues** (Shift-JIS, full-width chars in Supabase) | Low | Medium | Supabase uses UTF-8. Test with real Japanese data during migration. |
| **CF KV → Supabase migration** (message read state, templates) | Low | Low | Simple key-value → table migration. Low volume. |
| **Team learning curve** (Next.js, Supabase, PostgreSQL) | Medium | Low | Start with small PR. Team already proficient in JS/Node. |

---

## 8. Supabase Schema Design (Draft)

### 8.1 Core Tables

```sql
-- ENUM types replacing Baserow single-select options
CREATE TYPE order_status AS ENUM (
  'WAITING_FOR_PAYMENT', 'WAITING_FOR_SHIPPING', 
  'SHIPPED', 'COMPLETED', 'CANCELING', 'CANCELED'
);

CREATE TYPE review_status AS ENUM (
  'PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'ON_HOLD'
);

CREATE TYPE giga_sync_status AS ENUM (
  'PENDING', 'SYNCED', 'ALREADY_EXISTS', 'ERROR', 'INVALID'
);

CREATE TYPE sales_channel AS ENUM ('Mercari', 'Rakuten', 'Amazon');

-- Sales orders (unified table with channel discriminator)
CREATE TABLE sales_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      TEXT NOT NULL,
  sales_channel sales_channel NOT NULL,
  shop_id       TEXT NOT NULL,
  product_name  TEXT,
  b2b_item_code TEXT,
  quantity      INTEGER DEFAULT 1,
  product_price DECIMAL(10,2),
  shipping_price DECIMAL(10,2),
  order_status  order_status DEFAULT 'WAITING_FOR_PAYMENT',
  review_status review_status DEFAULT 'PENDING_REVIEW',
  -- Shipping address
  shipping_name         TEXT,
  shipping_postal_code  TEXT,
  shipping_state        TEXT,
  shipping_city         TEXT,
  shipping_address_1    TEXT,
  shipping_address_2    TEXT,
  shipping_phone_number TEXT,
  shipping_method       TEXT,
  shipping_carrier      TEXT,
  -- Delivery preferences
  requested_delivery_date TEXT,
  requested_delivery_time TEXT,
  -- Buyer info
  buyer_name     TEXT,
  order_comments TEXT,  -- memo log
  -- Platform IDs
  mercari_transaction_id TEXT,
  rakuten_order_number   TEXT,
  -- Tracking (written by P4)
  shipping_completed_at TIMESTAMPTZ,
  tracking_carrier      TEXT,
  tracking_number       TEXT,
  -- Close status (written by P5)
  shop_close_status        TEXT,
  shop_close_attempted_at  TIMESTAMPTZ,
  shop_close_completed_at  TIMESTAMPTZ,
  shop_close_error         TEXT,
  -- Auto-approval
  auto_approval_rule TEXT,
  auto_approved_at   TIMESTAMPTZ,
  -- Timestamps
  purchase_date  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(order_id, shop_id, product_name)
);

CREATE INDEX idx_sales_orders_status ON sales_orders(order_status);
CREATE INDEX idx_sales_orders_review ON sales_orders(review_status);
CREATE INDEX idx_sales_orders_channel ON sales_orders(sales_channel);
CREATE INDEX idx_sales_orders_shop ON sales_orders(shop_id);

-- Giga shipment orders
CREATE TABLE giga_shipments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        TEXT NOT NULL,
  sales_order_id  UUID REFERENCES sales_orders(id),
  sales_channel   sales_channel NOT NULL,
  source_store_id TEXT NOT NULL,
  giga_sync_status giga_sync_status DEFAULT 'PENDING',
  giga_sync_attempted_at  TIMESTAMPTZ,
  giga_sync_processed_at  TIMESTAMPTZ,
  giga_sync_request_id    TEXT,
  order_date       TIMESTAMPTZ,
  shipping_completed_at TIMESTAMPTZ,
  tracking_carrier  TEXT,
  tracking_number   TEXT,
  -- Giga-specific fields
  order_from       TEXT,
  b2b_item_code    TEXT,
  quantity         INTEGER,
  -- Address (mirrored from sales for Giga API)
  shipping_name        TEXT,
  shipping_postal_code TEXT,
  shipping_address     TEXT,
  shipping_phone       TEXT,
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_giga_shipments_status ON giga_shipments(giga_sync_status);
CREATE INDEX idx_giga_shipments_order ON giga_shipments(order_id);

-- Products catalog
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code       TEXT UNIQUE NOT NULL,
  product_name    TEXT,
  seller          TEXT,
  effective_tcogs DECIMAL(10,2),
  owned_qty       INTEGER DEFAULT 0,
  qty_available   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_products_item_code ON products(item_code);

-- Pipeline run audit log
CREATE TABLE pipeline_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        TEXT NOT NULL,
  trigger_type  TEXT,
  mode          TEXT,
  cron          TEXT,
  step          TEXT,
  shop_scope    TEXT,
  ok            BOOLEAN,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  error_message TEXT,
  result_counts JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Message read state (replaces CF KV)
CREATE TABLE message_read_state (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  last_read_transaction_id TEXT,
  last_read_message_id     TEXT,
  last_read_at             TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(shop_id, order_id)
);

-- Portal templates (replaces CF KV)
CREATE TABLE portal_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### 8.2 RLS Policies

```sql
-- Enable RLS on all tables
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE giga_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

-- Operators can read/write sales orders
CREATE POLICY "Operators can read sales orders"
  ON sales_orders FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Operators can update review fields"
  ON sales_orders FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Service role bypasses RLS (for pipeline backend)
-- The pipeline uses the service_role key, which bypasses RLS entirely
```

---

## 9. Key Decisions Needed

| # | Decision | Recommendation | Rationale |
|---|----------|---------------|-----------|
| 1 | **Unified vs. per-channel sales tables?** | **Unified** `sales_orders` with `sales_channel` enum | Simpler queries, shared review workflow, consistent schema. Channel-specific fields as nullable columns. |
| 2 | **Pipeline runtime?** | **Phase 1: Keep CF Worker. Phase 3: VPS cron.** | Minimizes initial migration risk. Consolidates later. |
| 3 | **Frontend hosting?** | **VPS (Dockerized Next.js)** behind Cloudflare Tunnel | Aligns with VPS-first philosophy. No new platform costs. |
| 4 | **Supabase project?** | **New dedicated Supabase project** for OrderMgmt | Clean isolation. Use `retailpulses` org. |
| 5 | **TypeScript migration?** | **Incremental** — start with new UI, port lib modules later | Don't block migration on TS. New code in TS, old code stays JS. |
| 6 | **Keep or replace CF KV?** | **Replace** with Supabase tables | One less platform to manage. KV only has ~3 use cases. |
| 7 | **Keep VPS Relay as-is?** | **Yes** — keep `relay/server.mjs` | Mercari/Rakuten still need fixed IP. No Supabase impact. |

---

## 10. Summary & Recommendation

### Readiness Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| Codebase readiness for migration | **8/10** | Clean adapter pattern, well-tested. Two 🔴 tech-debt items should be fixed first. |
| Documentation readiness | **7.5/10** | Strong ops docs. Need data model + API spec docs. |
| Data model portability | **7/10** | Baserow schema is flat and simple. ENUMs/text replace single-select. Main work is adding constraints + indexes. |
| Team readiness | **8/10** | JS/Node proficiency. Next.js + Supabase have gentle learning curves. |
| Risk level | **Medium** | Well-understood domain, clear migration path. Main risk is data migration accuracy. |

### Overall: **7.6/10 — Ready to proceed with preparation**

### Recommended Sequence

1. **This week:** Complete Phase 0 cleanup (extract pipeline-runner, split Worker, document data model)
2. **Week 2-3:** Phase 1 (Supabase schema + adapter + data migration)
3. **Week 4-6:** Phase 2 (Next.js UI application)
4. **Week 7-8:** Phase 3 (pipeline consolidation)
5. **Ongoing:** Phase 4 (polish + features)

### Immediate Actions

- [ ] Fill `docs/00_CURRENT_STATE.md` with actual current state
- [ ] Create `docs/data-model.md` documenting all Baserow tables, fields, types, and relationships
- [ ] Create `docs/api/portal-openapi.yaml` for the Portal REST API
- [ ] Extract `src/lib/pipeline-runner.mjs` to eliminate Worker/CLI duplication
- [ ] Split `worker/index.js` into router + handler modules
- [ ] Set up Supabase project under `retailpulses` org
- [ ] Create `src/lib/supabase.mjs` adapter (can be done in parallel with cleanup)

---

*Assessment prepared 2026-07-10. Based on full repository review including architecture audit, 558 tests, 33,855 lines of code across 130 files.*
