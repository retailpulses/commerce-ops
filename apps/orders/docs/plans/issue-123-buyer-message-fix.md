# Work Plan — Issue #123: Fix Buyer Message State After Supabase Migration

**Date:** 2026-07-13
**Status:** Draft for review
**Approach:** A — Minimal fix (add missing columns, fix aliases; defer `sales_order_message_state` adoption)

## Summary

After Baserow → Supabase cutover, all orders show 0 unread messages. Three failures:
1. Data migration didn't map buyer-message fields → `has_unread_messages` = false everywhere
2. Code writes to columns that don't exist (`latest_buyer_message_id`, `message_last_synced_at`) and wrong name (`latest_buyer_message_at` → should be `last_message_at`)
3. Unread classification reads fields that are undefined after migration

## Root Cause Diagram

```
writeThroughMessageFacts()                    classifyUnreadStatus()
       │                                              │
       │  patchRow({                                 │  reads row.has_buyer_messages ✓ (aliased)
       │    latest_buyer_message_id   ──┐             │  reads row.latest_buyer_message_id ✗ (no column)
       │    latest_buyer_message_at   ──┤             │  reads row.latest_buyer_message_at ✗ (column is last_message_at)
       │    has_buyer_messages        ──┤             │
       │    message_last_synced_at    ──┤             │
       │  })                            │             │
       │                                ▼             │
       │              toDatabasePayload() filters     │
       │              against SALES_COLUMNS:          │
       │              ✗ latest_buyer_message_id        │
       │              ✗ latest_buyer_message_at        │
       │              ✓ has_buyer_messages (aliased→has_unread_messages)
       │              ✗ message_last_synced_at
       │                                              │
       ▼                                              ▼
  3 of 4 writes silently dropped           always classifies "read" or "unknown"
```

## Changes (6 files, 1 new migration, 1 new backfill script)

### Step 1 — New Supabase Migration

**File:** `supabase/migrations/20260713000000_add_buyer_message_columns.sql`

Add two missing columns to `sales_orders`:

```sql
alter table sales_orders
  add column latest_buyer_message_id text,
  add column message_last_synced_at timestamptz;
```

These were present in the old Baserow schema. `latest_buyer_message_at` already exists as `last_message_at` (just renamed); the alias layer will bridge it.

### Step 2 — Fix Alias Layer (supabase.mjs)

**File:** `src/lib/supabase.mjs`

**2a.** Add alias entries in `SALES_ALIASES` (line 262):
```js
const SALES_ALIASES = Object.freeze({
  shop_id: "source_store_id",
  B2BItemCode: "b2b_item_code",
  shipping_tracking_info: "tracking_number",
  has_buyer_messages: "has_unread_messages",
  latest_buyer_message_at: "last_message_at",   // NEW
});
```

**2b.** Add new columns to `SALES_COLUMNS` (line 295):
```js
const SALES_COLUMNS = new Set([
  // ... existing entries ...
  "has_unread_messages", "last_message_at", "last_message_preview", "purchase_date",
  "latest_buyer_message_id",    // NEW
  "message_last_synced_at",     // NEW
]);
```

Why this works:
- **READ path** (`toApplicationRow`): copies `out.latest_buyer_message_at = out.last_message_at` when legacy key is null. `latest_buyer_message_id` and `message_last_synced_at` are already the canonical names → pass through directly.
- **WRITE path** (`toDatabasePayload`): `latest_buyer_message_at` aliases to `last_message_at`; both new columns are now in `SALES_COLUMNS` → not filtered out.
- `has_buyer_messages` → `has_unread_messages` alias already exists and works.

### Step 3 — Add FIELD Constants

**File:** `src/lib/db-fields.mjs`

Add to `FIELD.SALES`:
```js
HAS_UNREAD_MESSAGES:      "has_unread_messages",
LAST_MESSAGE_AT:           "last_message_at",
LATEST_BUYER_MESSAGE_ID:   "latest_buyer_message_id",
MESSAGE_LAST_SYNCED_AT:    "message_last_synced_at",
```

These replace `BASEROW_FIELD` numeric IDs that were previously used for message-field filter queries. Currently no code uses `FIELD.SALES.*` constants for these fields (buyer-messages.mjs uses raw string keys), but adding them completes the FIELD migration coverage.

### Step 4 — Data Backfill Script

**File:** `scripts/backfill-buyer-messages.mjs`

Backfill `has_unread_messages`, `last_message_at`, `latest_buyer_message_id`, `message_last_synced_at` from Baserow.

**Algorithm:**
1. Read all sales rows from Baserow (which still has `has_buyer_messages`, `latest_buyer_message_id`, `latest_buyer_message_at`, `message_last_synced_at`)
2. For each row where `has_buyer_messages` is truthy, read corresponding Supabase row (match on `order_id + source_store_id + sales_channel`)
3. Update Supabase row: set `has_unread_messages`, `last_message_at` (from Baserow `latest_buyer_message_at`), `latest_buyer_message_id`, `message_last_synced_at`

Flags: `--dry-run`, `--limit N`

**Risk:** Low. Only touches Supabase columns that are currently all defaults. Baserow is read-only. Idempotent by design.

### Step 5 — Verify Code Paths (no code changes needed)

After steps 2–3, these code paths self-heal through the alias layer:

| File | What it does | Fix mechanism |
|---|---|---|
| `buyer-messages.mjs:251-256` | `writeThroughMessageFacts()` writes 4 fields | Aliases + SALES_COLUMNS now pass all 4 through |
| `buyer-messages.mjs:70-74` | `classifyUnreadStatus()` reads `has_buyer_messages` | Already aliased → reads `has_unread_messages` |
| `buyer-messages.mjs:85` | `classifyUnreadStatus()` reads `latest_buyer_message_id` | Now in SALES_COLUMNS → returned from DB |
| `buyer-messages.mjs:97` | `classifyUnreadStatus()` reads `latest_buyer_message_at` | New alias → populated from `last_message_at` |
| `buyer-messages.mjs:128` | `isDurableStateStale()` reads `message_last_synced_at` | Now in SALES_COLUMNS → returned from DB |
| `order-list.mjs:416-419` | Enrichment reads 4 message fields | All now present via aliases |
| `auto-approval.mjs:792` | Safety gate reads `has_buyer_messages` | Already aliased → works after backfill |

**No changes needed in buyer-messages.mjs, order-list.mjs, or auto-approval.mjs** — the alias layer absorbs the field name differences.

### Step 6 — Tests

**File:** `test/supabase-buyer-message-alias.test.mjs` (new)

Test cases:
1. `toApplicationRow` populates `has_buyer_messages` from `has_unread_messages`
2. `toApplicationRow` populates `latest_buyer_message_at` from `last_message_at`
3. `toApplicationRow` passes through `latest_buyer_message_id` and `message_last_synced_at`
4. `toDatabasePayload` translates `has_buyer_messages` → `has_unread_messages`
5. `toDatabasePayload` translates `latest_buyer_message_at` → `last_message_at`
6. `toDatabasePayload` passes through `latest_buyer_message_id` and `message_last_synced_at`
7. `classifyUnreadStatus` correctly classifies with new field names
8. `extractBuyerMessageFacts` unchanged (pure function, no DB dependency)

**Existing tests that should still pass:**
- `test/tracking-reconciler.test.mjs`
- Any portal API tests

## Execution Order

```
Step 1 (migration)  →  Step 2 (aliases)  →  Step 6 (tests)
                                              │
                         Step 3 (FIELD consts)│
                                              │
                    Step 4 (backfill)  ←──────┘
                                              │
                         Step 5 (verify)  ←───┘
```

Steps 1-3 can be done in parallel (different files, no dependency). Step 4 requires Steps 1-2 to be deployed. Step 5 is verification only.

## What This Does NOT Do (Deferred)

- **`sales_order_message_state` table** — Remains unused. Migrating read cursors from CF KV to this table is a separate feature (tracked as #124 or similar).
- **`last_message_preview`** — The new Supabase column has no old Baserow equivalent. Populating it requires parsing message content, which is out of scope. Leave as NULL for now.
- **CF KV dependency removal** — Not touched. This fix restores the status quo, not advances the architecture.

## Rollback

If the migration causes issues:
1. Drop the two new columns: `alter table sales_orders drop column latest_buyer_message_id, drop column message_last_synced_at;`
2. Revert supabase.mjs changes (remove two alias/column entries)
3. Revert db-fields.mjs changes

The alias layer changes are purely additive — removing them restores current behavior.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration locks sales_orders table | Low (two nullable columns, no default) | Transient API errors | Run during low-traffic window |
| Backfill script writes wrong data | Low | Wrong unread state | Dry-run first, limit to 5 rows, verify |
| Alias breaks existing reads | Low | Portal shows stale data | Add to SALES_ALIASES only, existing entries untouched |
