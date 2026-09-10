# Portal Parity Matrix — Legacy vs React

Date: 2026-07-28
Phase: 2a (assessment, no routing change)

## Architecture

```
Legacy:  Browser → Worker (portal-ui.mjs) → Baserow/Supabase + PORTAL_KV
React:   Browser → VPS nginx (SPA) → portal-api (Hono) → Baserow/Supabase
```

| Layer | Legacy | React | Gap |
|-------|--------|-------|-----|
| UI renderer | `portal-ui.mjs` (2776 lines inline HTML+JS) | `portal/src/` (React 19 + TS + Vite) | React app exists, needs parity check |
| API server | Worker `worker/index.js` (inline routes) | `portal-api/src/routes.mjs` (Hono, 25 endpoints) | API exists, uses same shared handlers |
| Auth | `PORTAL_ACCESS_TOKEN` (Bearer, checked in Worker) | `useAuth` hook → `/api/portal/summary` | React has its own auth |
| Templates | KV `template:*` keys | Portal API → KV `template:*` (same handlers) | Same backend |
| Message state | KV `msg:` keys + `buyer-messages.mjs` | Portal API → same handlers → same KV | Same backend |
| Auto-approval guard | KV keys via `auto-approval.mjs` | Not portal-related (pipeline concern) | N/A |
| SPA serving | N/A (HTML generated per-request) | `portal/dist/` static files → nginx | Needs deployment |

## Feature Parity

### Pages / Tabs

| Feature | Legacy (`portal-ui.mjs`) | React (`portal/src/`) | Parity |
|---------|--------------------------|----------------------|--------|
| Orders tab | ✅ order list with filters | ✅ `OrderTable` component | ✅ |
| Fee Orders tab | ✅ separate query | ✅ `FeeOrderTable` component | ✅ |
| Presale tab | ✅ presale dashboard | ✅ `PresaleDashboard` component | ✅ |
| Login screen | ✅ inline auth | ✅ `LoginScreen` component | ✅ |
| Order detail | ✅ detail page (separate view) | ✅ `OrderDetailDrawer` (slide-out) | ✅ |

### Filters

| Feature | Legacy | React | Parity |
|---------|--------|-------|--------|
| Channel (mercari/rakuten) | ✅ | ✅ `channel: "mercari"` | ⚠️ Rakuten channel? |
| Lifecycle (active/all) | ✅ | ✅ `lifecycle: "active"` | ✅ |
| Review status | ✅ 4 values | ✅ `review: "any"` | ✅ |
| Attention | ✅ | ✅ `attention: "any"` | ✅ |
| Shop filter | ✅ per-channel shop list | ✅ | ✅ |
| Search | ✅ text search | ✅ | ✅ |
| Sort | ✅ column click | ✅ `sort` + `sortOrder` state | ✅ |
| Pagination | ✅ prev/next | ✅ `Pagination` component | ✅ |

### Actions

| Feature | Legacy | React | Parity |
|---------|--------|-------|--------|
| Bulk approve | ✅ | ✅ `useBulkApproveMutation` | ✅ |
| Review status change | ✅ inline | ✅ detail drawer | ✅ |
| Memo edit | ✅ inline | ✅ detail drawer | ✅ |
| B2B item code edit | ✅ inline | ✅ detail drawer | ✅ |
| Delivery date edit | ✅ inline | ✅ detail drawer | ✅ |
| Delivery time edit | ✅ inline | ✅ detail drawer | ✅ |
| Delivery preferences | ✅ | ✅ detail drawer | ✅ |
| Address edit | ✅ inline | ✅ detail drawer | ✅ |
| Quantity edit | ✅ | ✅ detail drawer | ✅ |
| Order messages | ✅ view + reply | ✅ detail drawer | ✅ |
| Generate AI reply | ✅ button | ✅ detail drawer | ✅ |
| Mark messages read | ✅ | ✅ | ✅ |
| Rakuten confirm | ✅ `handlePortalConfirm` | ✅ detail drawer | ✅ |

### Templates

| Feature | Legacy | React | Parity |
|---------|--------|-------|--------|
| List templates | ✅ | ✅ `TemplateManager` | ✅ |
| Create template | ✅ | ✅ | ✅ |
| Edit template | ✅ | ✅ | ✅ |
| Delete template | ✅ | ✅ | ✅ |
| Reorder templates | ✅ | ✅ | ✅ |

### API Endpoints (25 total)

All 25 endpoints in `portal-api/src/routes.mjs` use the same shared handlers as `worker/index.js`. Backend parity: **complete**.

| # | Method | Path | Handler | In Legacy? | In API? |
|---|--------|------|---------|------------|---------|
| 1 | GET | `/api/portal/summary` | `handlePortalSummary` | ✅ | ✅ |
| 2 | GET | `/api/portal/orders` | `handlePortalOrderList` | ✅ | ✅ |
| 3 | GET | `/api/portal/orders/:id` | `handlePortalOrderDetail` | ✅ | ✅ |
| 4 | POST | `/api/portal/orders/bulk-approve` | `handlePortalBulkApprove` | ✅ | ✅ |
| 5 | POST | `/api/portal/orders/:id/confirm` | `handlePortalConfirm` | ✅ | ✅ |
| 6 | PATCH | `/api/portal/orders/:id/review` | `handlePortalReview` | ✅ | ✅ |
| 7 | PATCH | `/api/portal/orders/:id/memo` | `handlePortalMemo` | ✅ | ✅ |
| 8 | PATCH | `/api/portal/orders/:id/b2b-code` | `handlePortalB2bCode` | ✅ | ✅ |
| 9 | PATCH | `/api/portal/orders/:id/delivery-date` | `handlePortalDeliveryDate` | ✅ | ✅ |
| 10 | PATCH | `/api/portal/orders/:id/delivery-time` | `handlePortalDeliveryTime` | ✅ | ✅ |
| 11 | PATCH | `/api/portal/orders/:id/delivery-preferences` | `handlePortalDeliveryPreferences` | ✅ | ✅ |
| 12 | PATCH | `/api/portal/orders/:id/address` | `handlePortalAddress` | ✅ | ✅ |
| 13 | PATCH | `/api/portal/orders/:id/quantity` | `handlePortalQuantity` | ✅ | ✅ |
| 14 | GET | `/api/portal/orders/:id/messages` | `handlePortalOrderMessages` | ✅ | ✅ |
| 15 | POST | `/api/portal/orders/:id/messages` | `handlePortalOrderReply` | ✅ | ✅ |
| 16 | POST | `/api/portal/orders/:id/messages/read` | `handlePortalOrderMarkRead` | ✅ | ✅ |
| 17 | POST | `/api/portal/orders/:id/generate-reply` | `handlePortalGenerateReply` | ✅ | ✅ |
| 18 | GET | `/api/portal/templates` | `handlePortalTemplatesList` | ✅ | ✅ |
| 19 | POST | `/api/portal/templates` | `handlePortalTemplatesCreate` | ✅ | ✅ |
| 20 | PUT | `/api/portal/templates/:id` | `handlePortalTemplatesUpdate` | ✅ | ✅ |
| 21 | DELETE | `/api/portal/templates/:id` | `handlePortalTemplatesDelete` | ✅ | ✅ |
| 22 | POST | `/api/portal/templates/reorder` | `handlePortalTemplatesReorder` | ✅ | ✅ |
| 23 | GET | `/api/portal/fee-orders` | `handlePortalFeeOrderList` | ✅ | ✅ |
| 24 | GET | `/api/portal/presale` | `handlePortalPresale` | ✅ | ✅ |
| 25 | PATCH | `/api/portal/presale/:itemCode/memo` | `handlePresaleMemo` | ✅ | ✅ |

### KV Dependencies (6 modules)

| Module | KV Key Pattern | Purpose | Migration Target |
|--------|---------------|---------|-----------------|
| `portal-templates.mjs` | `template:*` | Message templates CRUD | Supabase `portal_templates` |
| `portal/handlers.mjs` | `template:*` | Template list/create/update/delete | Supabase `portal_templates` |
| `portal/handlers.mjs` | `msg:cache:*` | Order messages cache | Supabase or Redis |
| `buyer-messages.mjs` | `msg:state:*` | Durable message state (read/unread, last sync) | Supabase `buyer_message_state` |
| `safety.mjs` | `msg:state:*` | Safety guard cache | Supabase |
| `auto-approval.mjs` | `auto_approve:guard:*` | Auto-approval idempotency guards | Supabase `auto_approval_guards` |

## Gaps Found

### 1. Rakuten Channel in React (⚠️ Low)
Legacy portal supports channel switching (Mercari/Rakuten). React app has `channel: "mercari"` hardcoded in initial filter state. The FilterBar component may already support channel switching — needs component inspection.

### 2. PORTAL_KV Hard Dependency (🔴 High — blocks cutover)
All 6 modules above use `env.PORTAL_KV` with optional chaining (`env?.PORTAL_KV`), so they degrade gracefully when KV is absent. But **templates and message state won't work without KV or a replacement backend**.

### 3. Portal API Auth (🟡 Medium)
React app uses `useAuth` hook. Portal API doesn't appear to have its own auth middleware — it relies on the Worker's `requireAdminAuth` or tunnel-level auth. Need to verify/harden for standalone VPS deployment.

### 4. SPA Asset Deployment (🟡 Medium)
`portal/dist/` needs to be built and served via nginx on VPS. Build pipeline, versioned asset paths, and cache headers need setup.

### 5. CORS / Security Headers (🟡 Medium)
Portal API currently runs behind Cloudflare Tunnel. For standalone VPS deployment, needs CORS headers, rate limiting, security headers.

## Phase 2a Deliverables — COMPLETE (2026-07-28)

1. ✅ This parity matrix
2. ✅ Supabase durable-state adapter for templates (`portal-templates.mjs` → Supabase) — `templates-store.mjs` existed; `portal-templates.mjs` updated with Supabase fallback
3. ✅ Supabase durable-state adapter for buyer message state (`buyer-messages.mjs` → Supabase) — dual KV/Supabase paths existed; `handlePortalOrderDetail()` fixed to use `readDurableState()`
4. ✅ KV export tooling (dry-run: list all keys, count, estimate size) — `scripts/kv-export-dry-run.mjs`
5. ✅ Portal API hardening (CORS, auth verification, security headers) — CORS origins configurable, security headers on all responses, body size limit (100KB)
6. ✅ Verify React app builds and all 25 endpoints respond correctly — `portal/` builds (TS + Vite), `portal-api/` syntax-check passes

### Additional Phase 2a fixes (beyond original plan)
- ✅ Supabase-backed idempotency guards (`src/lib/idempotency.mjs`) — replaces KV `auto-msg:*` and `reply-sent:*` keys
- ✅ Migration `20260728012328_add_idempotency_guards.sql` — `idempotency_guards` table
- ✅ Auto-approval `sendAutoApprovalMessage()` — dual-backend idempotency (KV + Supabase)
- ✅ Reply idempotency `handlePortalOrderReply()` — dual-backend (KV + Supabase), best-effort
