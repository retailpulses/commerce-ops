# Unread Message Detection Enhancement

## Outcome

The order portal opens on **Active + Unread** orders. Unread detection is based on
Mercari message facts synchronized during ingest, then upgraded to durable read-state
tracking. Auto-approval uses the same message facts and retains a live, fail-closed
Mercari check immediately before approval.

## Problems in the current implementation

- Message state is discovered only when an operator opens or refreshes an order.
- The KV record holding message bodies and unread metadata expires after 24 hours.
- Missing or failed KV reads are interpreted as `has_unread = false`.
- The order list can read a legacy shop-label key that the detail drawer does not read.
- Refresh both fetches messages and marks them read; those are separate operator actions.
- There is no durable evidence of when Mercari was last checked or why an order was
  classified as unread.
- Auto-approval performs a safe live check, but its result is not reused to improve
  portal message state.

## State model

Use a phased state model so the current stale-KV problem is removed quickly without
waiting for the full durable read-state implementation.

### Phase 1: ingest-backed message facts in Baserow

The Mercari ingest already fetches `messages` on each transaction. Use that existing
payload to compute and write the latest buyer-message facts directly onto each sales
row during sync.

Recommended fields:

- `latest_buyer_message_id`
- `latest_buyer_message_at`
- `has_buyer_messages`
- `message_last_synced_at`

This makes the order list independent from the 24-hour message-body cache for buyer
message detection. It also gives auto-approval a durable per-row signal that is
refreshed every ingest cycle.

Phase 1 is intentionally incomplete: it solves stale unread detection on the list,
but read state is still separate and must not rely on expiring cache semantics.

### Phase 2: durable read state in KV

Keep the body cache separate from the read cursor. Read state belongs in a durable KV
record keyed by order and shop, with no routine TTL.

### Durable message state

Key: `message-state:v1:{shop_id}:{order_id}`

No routine TTL. Delete only after a defined retention period for completed/canceled
orders.

```json
{
  "version": 1,
  "order_id": "...",
  "shop_id": "...",
  "latest_buyer_message_id": "...",
  "latest_buyer_message_at": "2026-07-03T05:00:00.000Z",
  "last_read_message_id": "...",
  "last_read_at": "2026-07-03T05:05:00.000Z",
  "last_checked_at": "2026-07-03T05:06:00.000Z",
  "last_check_status": "ok",
  "last_check_error": null,
  "consecutive_check_failures": 0
}
```

Unread is true when the latest buyer message ID differs from the last-read message
ID. Timestamp comparison is only a temporary fallback for legacy rows or records that
do not yet have message IDs populated.

The state has three portal outcomes:

- `unread`: a buyer message exists after the read cursor.
- `read`: synchronization succeeded and the read cursor covers the latest buyer message.
- `unknown`: the order has never synchronized, or its last successful check is stale.

`unknown` must not be displayed as read. It should have a visible “Message check
pending/failed” badge and be included in an attention queue.

### Message-body cache

Key: `messages:v2:{shop_id}:{order_id}`

This stores normalized message bodies for drawer rendering and may retain the existing
24-hour TTL. Expiry of this record must not alter unread status.

## Synchronization

### Phase 1 sync behavior

During `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs`, compute buyer
message state from `transaction.messages` while each order is already in memory:

1. Filter transaction messages to `role === BUYER`.
2. Sort by `createdAt`, using `id` as the stable cursor.
3. Derive `latest_buyer_message_id`, `latest_buyer_message_at`, and
   `has_buyer_messages`.
4. Write those values into each order row together with `message_last_synced_at`.

The portal order list should read these Baserow fields instead of the current KV
message cache.

If read-state KV is missing in Phase 1, the row must not silently resolve to `read`.
Treat it as `unknown` unless there is enough state to prove `read`.

### Phase 2 sync behavior

Add a `sync_mercari_messages` pipeline phase.

1. Load distinct active Mercari orders from Baserow.
2. Prioritize orders in this order:
   - Pending Review and not successfully checked recently
   - currently unread
   - Waiting for Shipping
   - Waiting for Payment
3. Fetch transaction messages from the VPS relay with bounded concurrency.
4. Normalize and sort messages by `createdAt`, using message ID as the stable cursor.
5. Update the body cache and durable state atomically from the same response.
6. Preserve the existing read cursor. Synchronization never marks a message read.
7. Record failures in durable state and expose them to the portal and health checks.

Run after Mercari ingestion and before auto-approval. Target freshness is five minutes
during operating hours. Batch size and concurrency must stay below Cloudflare Worker
subrequest and CPU limits. If per-order GraphQL polling cannot meet this target, extend
the relay with a bulk endpoint that performs bounded parallel transaction queries on
the VPS.

## Read semantics

Opening a drawer does not implicitly mark messages read. Add an explicit
`POST /api/portal/orders/:id/messages/read` endpoint. It advances the read cursor to
the latest buyer message currently rendered, then invalidates the portal list cache.

The UI may invoke this automatically only after the live/cached message list has
rendered successfully and the drawer is visible. A refresh fetches current data but
does not independently change read state.

## Auto-approval linkage

Auto-approval remains conservative:

1. Any buyer transaction message, read or unread, blocks auto-approval. A read reply
   does not imply that the order is safe for automatic processing.
2. Unread state is an immediate block signal.
3. `has_buyer_messages = true` from ingest is also a block signal, even when the
   message has already been marked read.
4. Missing, stale, or failed durable synchronization is an `unknown` signal and blocks
   auto-approval until the existing live Mercari safety check succeeds.
5. Immediately before patching `Auto-Approved`, fetch live messages from Mercari as
   the authoritative check. Relay failure continues to fail closed.
6. Write the successful live result through to durable state and the body cache so the
   portal benefits from the check.
7. Use compare-before-patch protection: if the durable latest buyer message changes
   between evaluation and patch, abort approval.

Do not automatically change an unread order to `On Hold`. Unread is an orthogonal
attention state; changing review status would require a separate operator/business
policy and would make transient message-check errors mutate workflow state.

## Portal behavior

- Initial filters: `lifecycle=active`, `attention=unread`.
- Keep “Any Attention” one selection away.
- In Phase 1, derive attention from Baserow message facts plus KV read cursor:
  `unread`, `read`, or `unknown`.
- Show last successful message-check time and synchronization errors.
- After marking read, remove the row from the Unread view without waiting for the
  30-second list cache.
- Remove legacy shop-label-key fallback after a one-time migration to canonical
  shop-ID keys.

## Build plan

### Phase 0: schema and compatibility

1. Add Baserow sales fields for `latest_buyer_message_id`, `latest_buyer_message_at`,
   `has_buyer_messages`, and `message_last_synced_at`.
2. Keep existing message-body KV reads working during rollout.
3. Add helper functions that compute latest buyer-message facts from Mercari message
   arrays using message ID as the primary cursor.

### Phase 1: ingest-first unread correction

1. Update `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs` to compute
   buyer-message facts from `transaction.messages` and write them to Baserow.
2. Update `src/lib/portal/order-list.mjs` so `enrichUnreadStatus` reads buyer-message
   facts from Baserow rows, not from the 24-hour body-cache KV record.
3. Keep `last_read_*` in KV temporarily, but if KV read state is missing, classify the
   row as `unknown`, not `read`.
4. Add unit tests for buyer-message extraction and list classification for
   `unread`/`read`/`unknown`.

Deliverable: the portal list no longer depends on stale or missing message-body cache
records to detect buyer messages.

### Phase 2: explicit read semantics

1. Add durable `message-state:v1:{shop_id}:{order_id}` KV records with no routine TTL.
2. Add `POST /api/portal/orders/:id/messages/read` to advance
   `last_read_message_id` and `last_read_at`.
3. Stop treating drawer refresh as a read-side effect.
4. Invalidate portal list cache immediately after marking read.

Deliverable: unread/read state becomes explicit and operator-controlled.

### Phase 3: scheduled durable synchronization

1. Add `sync_mercari_messages` after ingest and before auto-approval.
2. Reconcile Baserow buyer-message facts, durable KV state, and body cache from the
   same Mercari response.
3. Record `last_checked_at`, sync errors, and consecutive failures.
4. Surface `unknown` and sync-failure state in the portal.

Deliverable: unread classification remains durable even if the message drawer is never
opened.

### Phase 4: auto-approval integration hardening

1. Continue blocking on any buyer message, not only unread ones.
2. Treat `unknown` message state as blocking unless the live Mercari check succeeds.
3. On successful live check, write through the latest buyer-message facts and durable
   state so portal and approval logic converge.
4. Abort approval if the latest buyer-message cursor changes during evaluation.

Deliverable: unread logic and approval safety use the same message model without
weakening the live fail-closed rule.

## Rollout and acceptance criteria

1. Add unit tests for unread/read/unknown state transitions, ingest-derived
   buyer-message facts, message-ID cursors, synchronization failures, and legacy
   migration.
2. Add integration tests proving that synchronization never marks read and that
   marking read cannot hide a subsequently arriving message.
3. Add auto-approval tests for unread, read buyer message, stale state, relay failure,
   and a message arriving during approval.
4. Deploy Phase 1 field writes in shadow mode and compare portal classifications for
   24 hours.
5. Migrate existing canonical and legacy cache records into durable state.
6. Enable scheduled durable synchronization after mismatch review.
7. Remove legacy shop-label fallback and old unread-from-body-cache logic.

Acceptance targets:

- New buyer messages appear in the portal within five minutes during operating hours.
- No cache expiry can convert unread to read.
- No synchronization error is represented as read.
- No order with any buyer message can be auto-approved.
- Every unread classification exposes its latest message ID/time and last-check time.
