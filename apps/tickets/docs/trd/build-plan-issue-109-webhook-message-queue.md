# Build Plan: Issue 109 — Mercari Webhook Message Queue in Supabase Ticketing

| Field | Value |
|-------|-------|
| **Status** | Draft — pending review |
| **Date** | 2026-07-10 |
| **Author** | Planning agent |
| **Issue** | [#109](https://github.com/retailpulses/ticket-handling/issues/109) |
| **Repo** | `ticket-handling` |
| **Related docs** | [Supabase Ticketing MVP Spec](./supabase-ticketing-mvp-spec.md), [Build Plan: Supabase Ticketing MVP](./build-plan-supabase-ticketing-mvp.md), [Build Plan: Issue 100 Two-Pane React](./build-plan-issue-100-two-pane-react.md) |

---

## 1. Context

### 1.1 Current State

The Mercari webhook receiver (`POST /api/webhooks/mercari-message`) already exists and works:

- Validates `WEBHOOK_SHARED_SECRET` (Bearer token or `?secret=` query param)
- Maps incoming `shop_id` → internal `Shop1..Shop4` via `MERCARI_SHOP_ID_TO_NAME` from `config/shops.ts`
- Deduplicates via KV (`mercari:webhook:message:{shop_id}:{order_transaction_id}:{created_at}`)
- Fetches the full order transaction from Mercari API
- Processes in **shadow mode** (classify, evaluate workflow, build report — but does NOT send replies, mutate Baserow, or notify WeCom)
- Persists audit log + dedup marker to KV with 7-day TTL
- Webhook admin/setup handler is currently restricted to Shop4

The new Supabase ticketing app (`/ticketing` and `/api/ticketing/*`) is live with:

- `tickets` table with full MVP schema (status, priority, issue_types, account linking, etc.)
- `ticket_messages` table for customer/platform/operator communication
- `ticket_events` table for immutable audit trail
- `ticket_list_view` and `ticket_detail_view` for querying
- Repository → Service → Handler layered architecture (`SupabaseTicketRepository` → `TicketService` → `handlers/ticketing.ts`)
- React 18 + Vite + TypeScript frontend with React Router, TanStack Query, Tailwind CSS
- Two-pane workspace (list left, detail right)
- Copywriting/response composer for Mercari threads

The webhook path currently writes **only to KV** — webhook messages are not surfaced in the ticketing app. Operators cannot see webhook-landed messages unless they manually check KV audit logs.

### 1.2 Target State

Webhook messages become an operator-visible inbound message queue:

- Webhook events are persisted to a new `inbound_ticket_messages` table in Supabase
- If an existing Supabase ticket matches the Mercari transaction, the inbound message is auto-linked to that ticket
- If no ticket exists, the message appears in a new **Message Queue** view in the ticketing app
- Operators can: mark read/unread, ignore, link to existing ticket, convert to new ticket
- Every landed message carries structured LLM classification metadata
- Read/unread status is tracked per row
- Duplicate webhook deliveries are idempotent (Supabase unique constraint + KV dedup)
- Phase 1 deploys for Shop4 only; Phase 2 enables Shop1-3

### 1.3 What Stays the Same

- Existing webhook URL and auth mechanism (`WEBHOOK_SHARED_SECRET`, Bearer or query param)
- Shop configuration (`config/shops.ts` — `SHOP_IDS`, `SHOP_TOKENS`, `MERCARI_SHOP_ID_TO_NAME`)
- Shadow mode processing (no auto-send, no buyer-facing mutations)
- KV dedup layer (remains as first-line dedup before Supabase write)
- Existing ticket API schema — no breaking changes to `/api/ticketing/*`
- All existing ticket operations

---

## 2. Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Table name: `inbound_ticket_messages`** | Descriptive; avoids collision with `ticket_messages` which stores direct ticket communication, not queued inbound events |
| 2 | **KV dedup first, Supabase unique constraint second** | KV check is fast (<5ms) and prevents unnecessary Supabase writes on retries; the unique index catches edge cases KV misses (e.g., KV expiry) |
| 3 | **`queue_status` and `review_status` as separate dimensions** | Read/unread is an operator workflow concern; review/triage is a content concern. Independent state machines. |
| 4 | **Auto-link by `(platform, account_id, external_order_id)`** | Matches the existing `idx_tickets_platform_order` unique partial index. The strongest available key for Mercari transactions. |
| 5 | **Classification stored as `jsonb` column** | Structured model output with variable fields (classification, workflow_route, confidence, etc.). JSONB allows flexible queries without schema changes per model version. |
| 6 | **New API endpoints under `/api/ticketing/queue/*`** | Clean separation from ticket CRUD. The queue is a distinct resource with its own lifecycle. |
| 7 | **Queue UI as a new top-level route `/ticketing/queue`** | The two-pane workspace is ticket-focused. The queue is a separate concern — a list → action flow, not a list → detail split. |
| 8 | **Webhook handler stays in `handlers/webhooks.ts`** | The webhook is an ingress concern. The handler gains a Supabase write path but remains an HTTP ingress handler, not a service. |
| 9 | **New `InboundMessageService` in service layer** | Business logic for linking, converting, status transitions, and classification parsing lives in a dedicated service, following the existing `TicketService` pattern. |
| 10 | **Phase 2 shop expansion is config-only + admin handler update** | The queue model is shop-agnostic. Adding Shop1-3 requires: (a) update admin handler to accept all shops, (b) register webhooks per shop, (c) verify `shop_id` mapping. No queue schema changes. |

---

## 3. Data Model

### 3.1 `inbound_ticket_messages` Table

```sql
CREATE TABLE IF NOT EXISTS inbound_ticket_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                text NOT NULL DEFAULT 'mercari_webhook'
                          CHECK (source IN ('mercari_webhook')),
  shop_name             text NOT NULL,          -- Shop1, Shop2, Shop3, Shop4
  shop_id               text NOT NULL,          -- Mercari shop ID from webhook payload
  order_transaction_id  text NOT NULL,
  external_thread_id    text,                   -- from fetched transaction
  customer_display_name text,                   -- from transaction buyer info
  product_summary       jsonb DEFAULT '{}',     -- {product_name, sku, price, ...}
  order_summary         jsonb DEFAULT '{}',     -- {order_status, total, ...}
  latest_buyer_message  text,                   -- most recent buyer message body
  full_payload          jsonb NOT NULL DEFAULT '{}',  -- full normalized webhook payload + fetched transaction snapshot
  linked_ticket_id      uuid REFERENCES tickets(id) ON DELETE SET NULL,
  queue_status          text NOT NULL DEFAULT 'unread'
                          CHECK (queue_status IN ('unread','read','linked','converted','ignored','archived')),
  review_status         text NOT NULL DEFAULT 'needs_review'
                          CHECK (review_status IN ('needs_review','reviewed','automation_candidate')),
  classification        jsonb NOT NULL DEFAULT '{}',  -- structured LLM output (see §3.2)
  classifier_version    text,                   -- model name/version/prompt version
  webhook_received_at   timestamptz NOT NULL,   -- from webhook payload created_at
  received_at           timestamptz NOT NULL DEFAULT now(),
  read_at               timestamptz,
  reviewed_at           timestamptz,
  idempotency_key       text UNIQUE NOT NULL,   -- {shop_id}:{order_transaction_id}:{webhook_created_at}
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

### 3.2 Classification JSONB Structure

```json
{
  "classification": "quality_issue",
  "workflow_route": "ticket_handling",
  "recommended_operator_action": "create_ticket",
  "should_convert_to_ticket": true,
  "suggested_ticket_type": "quality_issue",
  "suggested_category": "defect",
  "suggested_priority": "normal",
  "confidence": 0.87,
  "reasoning_summary": "Customer reports stitching defect with photo evidence",
  "automation_eligible": false,
  "automation_blockers": ["requires_photo_review", "refund_amount_unclear"],
  "model": "deepseek-v4-flash",
  "prompt_version": "mercari-classifier-v3",
  "raw_classifier_response": { }
}
```

### 3.3 Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_inbound_queue_status ON inbound_ticket_messages (queue_status);
CREATE INDEX IF NOT EXISTS idx_inbound_review_status ON inbound_ticket_messages (review_status);
CREATE INDEX IF NOT EXISTS idx_inbound_shop ON inbound_ticket_messages (shop_name);
CREATE INDEX IF NOT EXISTS idx_inbound_linked_ticket ON inbound_ticket_messages (linked_ticket_id);
CREATE INDEX IF NOT EXISTS idx_inbound_transaction ON inbound_ticket_messages (order_transaction_id);
CREATE INDEX IF NOT EXISTS idx_inbound_received_at ON inbound_ticket_messages (received_at DESC);

-- Unique constraint on idempotency_key also serves as an index
```

---

## 4. API Design

### 4.1 New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/ticketing/queue` | List queue items (paginated, filterable) |
| `GET` | `/api/ticketing/queue/:id` | Get single queue item detail |
| `PATCH` | `/api/ticketing/queue/:id` | Update queue item (mark read/unread, change review status) |
| `POST` | `/api/ticketing/queue/:id/ignore` | Mark as ignored (no ticket needed) |
| `POST` | `/api/ticketing/queue/:id/link` | Link to existing ticket (`{ticket_id}`) |
| `POST` | `/api/ticketing/queue/:id/convert` | Convert to new ticket (returns created ticket) |
| `GET` | `/api/ticketing/queue/unread-count` | Return `{total, by_shop}` unread counts |
| `GET` | `/api/ticketing/queue/by-ticket/:ticketId` | Get queue items linked to a specific ticket |

### 4.2 Queue List Query Params

```
GET /api/ticketing/queue?shop_name=Shop4&queue_status=unread&review_status=needs_review&
    classification=quality_issue&q=search_term&sort=received_at.desc&limit=20&offset=0
```

### 4.3 Webhook Handler Change

The existing `handleMercariMessageWebhook` in `handlers/webhooks.ts` gains a Supabase persist step **after** successful processing but **before** the KV write. The flow becomes:

```
Validate → KV dedup check → Fetch transaction → Process (shadow mode) → Persist to Supabase → KV audit log → Return 200
```

If Supabase persist fails, the handler returns 500 (retryable) — the KV dedup marker is NOT written, so Mercari will retry. The webhook path remains non-sending.

---

## 5. Agent Team Structure

Five specialized teams across three phases. Phase 1 teams run in parallel after the schema is finalized. Phase 2 teams build on Phase 1. Phase 3 is frontend-only.

### 5.1 Dependency Graph

```text
Phase 1: Backend Foundation (sequential start, then parallel)
=============================================================
Team Queue Schema ──> Team Queue API ──> Team Webhook Wiring
                            |
Phase 2: Integration & Classification (parallel)
=============================================================
Team Auto-Link          Team Classification Store
       |                         |
Phase 3: Frontend (depends on Phase 1 API)
=============================================================
Team Queue UI ──> Team Queue Actions (convert/link/ignore)
       |                         |
Phase 2b (deferred): Shop1-3 Expansion
=============================================================
Team Multi-Shop (admin handler + webhook registration per shop)
```

### 5.2 Team Assignments

| # | Team | Agents | Key Deliverable | Depends On |
|---|------|--------|-----------------|------------|
| 1 | **Queue Schema** | 1 | Migration SQL, table, indexes, RLS | — |
| 2 | **Queue API** | 1 | `InboundMessageRepository`, `InboundMessageService`, 8 API handlers | Team 1 |
| 3 | **Webhook Wiring** | 1 | Updated `handlers/webhooks.ts` — Supabase persist path | Team 2 |
| 4 | **Auto-Link** | 1 | Transaction→ticket matching logic, auto-link on webhook ingest | Team 2 |
| 5 | **Classification Store** | 1 | Parse classifier output → structured JSONB, store per inbound row | Team 3 |
| 6 | **Queue UI** | 1 | New `/ticketing/queue` route, list view, detail panel | Team 2 |
| 7 | **Queue Actions** | 1 | Convert/link/ignore/mark-read operator workflows in UI | Team 6 |
| 8 | **Multi-Shop** | 1 | Shop1-3 webhook admin, registration, token verification | Teams 2-3 |

---

## 6. Team Scopes

### Team 1: Queue Schema

**Agent count**: 1
**Phase**: 1 (Foundation)
**Depends on**: —

**Deliverable**: Supabase migration SQL file.

**Files**:
```
supabase/migrations/XXXXXXXXXX_inbound_ticket_messages.sql
```

**Scope**:
- `inbound_ticket_messages` table with all columns from §3.1
- All indexes from §3.3
- `updated_at` trigger (reuse `update_updated_at_column()`)
- RLS enabled, no anon policies (service_role only, matching existing tables)
- Foreign key to `tickets(id)` with `ON DELETE SET NULL`
- UNIQUE constraint on `idempotency_key`
- CHECK constraints on `source`, `queue_status`, `review_status`

**Validation**:
- Migration runs without error against local/staging Supabase
- Table appears in `\dt` with correct columns
- `idempotency_key` unique constraint prevents duplicate inserts

---

### Team 2: Queue API

**Agent count**: 1
**Phase**: 1 (Foundation)
**Depends on**: Team 1 (Queue Schema)

**Deliverable**: Repository + Service + Handler layers for queue operations.

**Files**:
```
web/worker/src/repositories/inboundMessageRepository.ts   (new)
web/worker/src/services/inboundMessageService.ts           (new)
web/worker/src/handlers/ticketing.ts                       (edit — add 8 routes)
web/worker/src/handler.ts                                  (edit — register new routes)
```

**Scope**:

`InboundMessageRepository` (interface + Supabase implementation):
- `listQueue(filters)` → `{rows, total}`
- `getQueueItem(id)` → `InboundMessage | null`
- `updateQueueItem(id, patch)` → `InboundMessage`
- `getByTicketId(ticketId)` → `InboundMessage[]`
- `getUnreadCount(shopName?)` → `{total, by_shop}`
- `findExistingTicket(platform, account_id, external_order_id)` → `Ticket | null`

`InboundMessageService` (business logic):
- `listQueue(filters)` — delegates to repo, enriches with ticket summary
- `markRead(id)` / `markUnread(id)` — status transitions with timestamps
- `markReviewed(id)` — sets `review_status = 'reviewed'`, `reviewed_at = now()`
- `ignoreMessage(id)` — queue_status → `ignored`
- `linkToTicket(id, ticketId)` — validates ticket exists, sets `linked_ticket_id`, `queue_status → 'linked'`
- `convertToTicket(id, overrides?)` — creates ticket from queue item fields, links queue row → `converted`

Handler routes to add in `handlers/ticketing.ts`:
- `handleListQueue` → `GET /api/ticketing/queue`
- `handleGetQueueItem` → `GET /api/ticketing/queue/:id`
- `handleUpdateQueueItem` → `PATCH /api/ticketing/queue/:id`
- `handleIgnoreQueueItem` → `POST /api/ticketing/queue/:id/ignore`
- `handleLinkQueueItem` → `POST /api/ticketing/queue/:id/link`
- `handleConvertQueueItem` → `POST /api/ticketing/queue/:id/convert`
- `handleQueueUnreadCount` → `GET /api/ticketing/queue/unread-count`
- `handleQueueByTicket` → `GET /api/ticketing/queue/by-ticket/:ticketId`

**Validation**:
- All endpoints return correct JSON shapes
- `convertToTicket` creates a valid ticket with `origin = 'platform_ingest'` and prefilled fields
- `linkToTicket` rejects invalid/nonexistent ticket IDs
- Unread count aggregates correctly per shop

---

### Team 3: Webhook Wiring

**Agent count**: 1
**Phase**: 1 (Foundation)
**Depends on**: Team 2 (Queue API)

**Deliverable**: Updated webhook handler that persists to Supabase in addition to KV.

**Files**:
```
web/worker/src/handlers/webhooks.ts  (edit)
```

**Scope**:
- After shadow processing succeeds (step 6 in current `handleMercariMessageWebhook`), call `InboundMessageService` to persist the inbound message
- Generate `idempotency_key` as `{shop_id}:{order_transaction_id}:{webhook_created_at}`
- Extract fields from webhook payload + fetched transaction:
  - `shop_name` from `MERCARI_SHOP_ID_TO_NAME`
  - `customer_display_name` from transaction buyer
  - `product_summary` / `order_summary` from transaction
  - `latest_buyer_message` from transaction thread
  - `full_payload` as normalized snapshot
- On Supabase unique constraint violation (23505 on idempotency_key), return 200 `{status: "duplicate"}` — the KV dedup should catch most, this is defense-in-depth
- On Supabase connection/other errors, return 500 (retryable) WITHOUT writing the KV dedup marker — Mercari retries ensure durability
- Classification metadata: call `InboundMessageService.storeClassification()` to parse the classifier output (already in `result.logEntry`) into structured JSONB

**Validation**:
- Webhook endpoint smoke test with `curl` → 200 with `{status: "ok"}`
- Duplicate webhook payload → 200 with `{status: "duplicate"}`
- Row appears in `inbound_ticket_messages` with correct fields
- Missing Supabase → 500, KV dedup NOT written (retry safe)

---

### Team 4: Auto-Link

**Agent count**: 1
**Phase**: 2 (Integration)
**Depends on**: Team 2 (Queue API)

**Deliverable**: Auto-link logic that matches inbound webhook messages to existing tickets.

**Files**:
```
web/worker/src/services/inboundMessageService.ts  (edit — add auto-link logic)
web/worker/src/handlers/webhooks.ts               (edit — call auto-link after persist)
```

**Scope**:
- `InboundMessageService.autoLink(inboundMessage)`:
  1. Look up existing ticket by `(platform = 'mercari', account_id = platform_accounts.id matching shop, external_order_id = order_transaction_id)` using the existing partial unique index `idx_tickets_platform_order`
  2. If found: set `linked_ticket_id`, `queue_status = 'linked'`, `review_status = 'reviewed'`
  3. Add `ticket_event` of type `message_received` to the linked ticket
  4. Update ticket's `latest_customer_message` and `needs_reply = true` (if buyer message)
  5. If not found: leave `linked_ticket_id = null`, `queue_status = 'unread'`, `review_status = 'needs_review'`
- Shop→account mapping: resolve `shop_name` to `platform_accounts.id` via `platform_accounts.shop_code` or display_name match
- Webhook handler calls `autoLink` after persisting the inbound row

**Validation**:
- Webhook for existing ticket's transaction → auto-linked, ticket event created
- Webhook for unknown transaction → appears in queue as unread + needs_review
- Same transaction, second webhook → idempotent (duplicate detected, no second auto-link)

---

### Team 5: Classification Store

**Agent count**: 1
**Phase**: 2 (Integration)
**Depends on**: Team 3 (Webhook Wiring)

**Deliverable**: Parse existing classifier output into structured JSONB and persist on each inbound row.

**Files**:
```
web/worker/src/services/inboundMessageService.ts  (edit — add classification parsing)
web/worker/src/logic/classifier.ts                (edit — optional: export classification schema type)
```

**Scope**:
- `InboundMessageService.parseClassification(logEntry)`:
  - Extract from `result.logEntry` (already produced by shadow processing):
    - `classification` — the primary intent label
    - `workflow_route` — routing decision
    - `recommended_operator_action` / `should_convert_to_ticket`
    - `suggested_ticket_type` / `suggested_priority`
    - `confidence` — model confidence score
    - `reasoning_summary` — brief explanation
    - `automation_eligible` / `automation_blockers`
  - Add `model`, `prompt_version` from config
  - Store `raw_classifier_response` (the full classifier output) for audit
- Store as JSONB in `classification` column
- Store `classifier_version` as `{model}::{prompt_version}`
- Preserve the existing `classifier.ts` logic — webhook shadow processing already runs classification. This team only parses the already-produced output into a structured store.

**Validation**:
- Queue item has non-empty `classification` JSONB after webhook ingest
- `classification->>'classification'` is a valid label
- `classification->>'confidence'` is a number between 0 and 1
- Different message types produce different classifications (not all identical)

---

### Team 6: Queue UI

**Agent count**: 1
**Phase**: 3 (Frontend)
**Depends on**: Team 2 (Queue API)

**Deliverable**: New `/ticketing/queue` route with list view and detail panel in the React frontend.

**Files**:
```
web/frontend/src/pages/MessageQueuePage.tsx          (new)
web/frontend/src/components/queue/QueueList.tsx       (new)
web/frontend/src/components/queue/QueueListItem.tsx   (new)
web/frontend/src/components/queue/QueueDetail.tsx     (new)
web/frontend/src/components/queue/QueueFilterBar.tsx  (new)
web/frontend/src/api/queue.ts                         (new)
web/frontend/src/App.tsx                              (edit — add route)
```

**Scope**:

`api/queue.ts` — typed API client:
- `fetchQueue(filters)` → `{items: InboundMessage[], total: number}`
- `fetchQueueItem(id)` → `InboundMessage`
- `fetchUnreadCount()` → `{total, by_shop}`
- `updateQueueItem(id, patch)` → `InboundMessage`
- `ignoreQueueItem(id)` → `InboundMessage`
- `linkToTicket(id, ticketId)` → `InboundMessage`
- `convertToTicket(id, overrides?)` → `{ticket, queue_item}`

`MessageQueuePage.tsx` — page layout:
- Top bar: title "Inbound Messages" + unread count badge
- Filter bar: shop filter, queue_status filter, review_status filter, classification filter, search
- Queue list with columns: status icon, shop, customer, product summary, latest message preview, classification badge, received time
- Click row → expand detail panel or navigate to detail

`QueueList.tsx` / `QueueListItem.tsx`:
- TanStack Query for data fetching with pagination
- Unread rows visually distinct (bold or blue left-border)
- Classification badge (color-coded by type)
- Queue status badge (unread/read/linked/converted/ignored)

`QueueDetail.tsx` — detail panel:
- Full message body
- Customer/order/product info
- Classification details (label, confidence, reasoning, recommended action)
- Action buttons: Mark Read/Unread, Link to Ticket, Convert to Ticket, Ignore
- Linked ticket link (if linked)

`App.tsx` changes:
- Add `/ticketing/queue` route
- Add navigation link to queue (with unread count badge) in header/sidebar

**Validation**:
- `/ticketing/queue` renders list of queue items
- Unread count badge shows correct number
- Clicking a row shows detail with classification info
- Filters work: shop, status, review_status
- Queue item with linked ticket shows ticket link

---

### Team 7: Queue Actions

**Agent count**: 1
**Phase**: 3 (Frontend)
**Depends on**: Team 6 (Queue UI)

**Deliverable**: Operator action workflows in the queue UI: mark read/unread, ignore, link to existing ticket, convert to new ticket.

**Files**:
```
web/frontend/src/components/queue/QueueActions.tsx          (new)
web/frontend/src/components/queue/ConvertToTicketModal.tsx  (new)
web/frontend/src/components/queue/LinkTicketModal.tsx       (new)
web/frontend/src/components/queue/QueueDetail.tsx           (edit — wire actions)
web/frontend/src/api/queue.ts                               (edit — add action mutations)
```

**Scope**:

`QueueActions.tsx` — action button bar:
- **Mark Read / Unread** — toggle button, optimistic update via TanStack Query mutation
- **Ignore** — confirmation dialog ("This message does not require a ticket"), sets `queue_status = 'ignored'`
- **Link to Ticket** — opens `LinkTicketModal`
- **Convert to Ticket** — opens `ConvertToTicketModal`

`LinkTicketModal.tsx`:
- Search input for ticket lookup (by ticket_number, customer name, or order ID)
- Search results dropdown (debounced API call to existing ticket search)
- "Link" button → calls `POST /api/ticketing/queue/:id/link`
- On success: refresh queue list, show toast

`ConvertToTicketModal.tsx`:
- Pre-filled form from queue item: platform, account, subject, description, customer name, order ID
- Editable fields before creation
- "Create & Link" button → calls `POST /api/ticketing/queue/:id/convert`
- On success: navigate to new ticket, queue item status updates to `converted`

**Validation**:
- Mark read updates row appearance immediately (optimistic) and persists
- Ignore removes row from default view (or shows as grayed out)
- Link to ticket: search finds tickets, linking updates queue row
- Convert to ticket: creates valid ticket, queue row links to it
- All actions show error toast on failure

---

### Team 8: Multi-Shop Expansion (Phase 2b)

**Agent count**: 1
**Phase**: Deferred (after Shop4 validation)
**Depends on**: Teams 2, 3 (Queue API + Webhook Wiring)

**Deliverable**: Enable webhook processing for Shop1, Shop2, and Shop3.

**Files**:
```
web/worker/src/handlers/mercari-webhook-admin.ts  (edit — remove Shop4 restriction)
web/worker/src/config/shops.ts                     (no change needed — already has all 4)
web/worker/src/handlers/webhooks.ts                (no change needed — already shop-agnostic)
```

**Scope**:
- Update `mercari-webhook-admin.ts` to accept shop parameter for list/create/verify/delete operations (currently hardcoded to Shop4)
- Verify each shop's token is configured in env
- Register the `order_transaction_message_created` webhook for Shop1-3
- Test webhook delivery for each shop with a real transaction
- Confirm `shop_id` mapping works correctly for all 4 shops
- Queue behavior is identical across all shops — no per-shop logic branches

**Validation**:
- Webhook admin: list/create/verify for each shop succeeds
- Incoming webhooks for each shop produce correct `shop_name` in queue
- A missing token for one shop fails clearly (503, "Webhook endpoint disabled") without affecting other shops
- At least one test webhook per shop produces a queue row

---

## 7. Implementation Phases

### Phase 1: Backend Foundation (Teams 1-2-3)

**Goal**: Webhook messages land in Supabase and are queryable via API.

1. **Team 1 (Queue Schema)**: Write and run migration. (~1 session)
2. **Team 2 (Queue API)**: Build repository, service, and 8 handler routes. (~2 sessions)
3. **Team 3 (Webhook Wiring)**: Update webhook handler to persist to Supabase. (~1 session)

**Exit criteria**: `curl POST /api/webhooks/mercari-message` → row appears in `inbound_ticket_messages`. `GET /api/ticketing/queue` returns the row.

### Phase 2: Integration & Classification (Teams 4-5)

**Goal**: Auto-linking works, classification is stored.

4. **Team 4 (Auto-Link)**: Transaction→ticket matching + auto-link on ingest. (~1 session)
5. **Team 5 (Classification Store)**: Parse classifier output → structured JSONB. (~1 session)

**Exit criteria**: Webhook for existing ticket auto-links. Queue item shows classification with confidence. Unmatched messages remain unread + needs_review.

### Phase 3: Frontend (Teams 6-7)

**Goal**: Operators can see and act on the queue from the ticketing UI.

6. **Team 6 (Queue UI)**: `/ticketing/queue` route with list and detail views. (~2 sessions)
7. **Team 7 (Queue Actions)**: Convert, link, ignore, read/unread workflows. (~1 session)

**Exit criteria**: Operators can view queue, mark read, convert to ticket, link to existing ticket, ignore — all from the UI.

### Phase 4 (Deferred): Multi-Shop

8. **Team 8 (Multi-Shop)**: Enable Shop1-3. (~1 session)

**Exit criteria**: All 4 shops produce queue rows. One shop's failure doesn't break others.

---

## 8. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| 1 | **Supabase write in webhook path adds latency** | Medium | Medium | KV dedup remains first (fast). Supabase write is async from webhook response perspective — the webhook acknowledges after KV audit, Supabase write can be fire-and-forget with retry. |
| 2 | **Webhook volume overwhelms queue** | Low | Medium | Mercari webhooks are per-message, not high-frequency. Add pagination + archive from day one. Monitor queue depth. |
| 3 | **Classification fields mismatch between webhook processor output and storage schema** | Medium | Low | The classifier output (`result.logEntry`) is already produced. Team 5 only parses it; if fields change, JSONB absorbs it. No strict schema on classification column. |
| 4 | **Shop→account mapping gap** | Medium | Medium | `platform_accounts.shop_code` may not map 1:1 to `Shop1..Shop4`. Team 4 resolves this by matching on `display_name` containing shop name, or adding a `shop_code` column if needed. |
| 5 | **Frontend queue route not integrated into two-pane workspace** | Low | Low | The queue is a separate top-level route, not a pane. Add navigation link from workspace header. Unread count badge drives discovery. |
| 6 | **Existing SPA (inline HTML in ticketing.ts) doesn't get queue features** | High | Medium | The inline SPA is on a deprecation path (issue #100 React migration). Queue UI targets React only. If operators still use inline SPA, direct them to React frontend or add a basic queue link. |

---

## 9. Acceptance Criteria Mapping

### Phase 1 / Shop4 (this build plan)

| AC | Covered by |
|----|------------|
| Shop4 webhook for existing ticket → linked, has unread activity | Team 4 (Auto-Link) |
| Shop4 webhook without existing ticket → appears in queue, mark read/unread | Team 3 (Webhook) + Team 6 (UI) |
| Operator can convert queued message to ticket | Team 7 (Queue Actions) |
| Operator can link queued message to existing ticket | Team 7 (Queue Actions) |
| Each message stores structured LLM classification metadata | Team 5 (Classification) |
| Duplicate webhook deliveries are idempotent | Team 1 (Schema — unique constraint) + Team 3 (KV dedup) |
| Tests cover: existing ticket, no ticket, duplicate, read, convert, link, Shop4 mapping | Each team's validation |

### Phase 2 / Shop1-3 (Team 8)

| AC | Covered by |
|----|------------|
| Webhook setup supports Shop1-3 | Team 8 |
| Each shop can list/create/verify webhook | Team 8 |
| shop_id maps correctly to internal account | Team 8 (test per shop) |
| Queue behavior consistent across shops | Team 8 (test per shop) |
| Missing token for one shop fails clearly | Team 8 |
| Tests cover all-shop mapping + one ingest per shop | Team 8 validation |

---

## 10. Session Budget Estimate

| Phase | Teams | Estimated sessions |
|-------|-------|--------------------|
| Phase 1: Backend | 1, 2, 3 | 3–5 sessions |
| Phase 2: Integration | 4, 5 | 2–3 sessions |
| Phase 3: Frontend | 6, 7 | 3–4 sessions |
| Phase 4 (deferred): Multi-Shop | 8 | 1–2 sessions |
| **Total** | | **9–14 sessions** |

Each session ≈ one focused agent run on one team deliverable. Teams within a phase can be parallelized but share the same codebase, so serial execution per phase is recommended to avoid merge conflicts.

---

## 11. Next Steps

1. **Review & approve** this build plan
2. **Start Phase 1 — Team 1 (Queue Schema)**: Write and run the `inbound_ticket_messages` migration
3. **Validate**: Confirm the table exists and constraints work before Team 2 builds on it
4. **Proceed sequentially** through Teams 2→3→4→5→6→7, validating each team's exit criteria before starting the next
