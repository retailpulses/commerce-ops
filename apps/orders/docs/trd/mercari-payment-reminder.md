# Mercari Payment Reminder — TRD

## Outcome

Automatic payment reminders sent to Mercari buyers on day 2 and day 3 after purchase
for orders stuck in `WAITING_FOR_PAYMENT`, with guardrails against duplicate reminders
and reminders after buyer-initiated contact.

## Background

### Mercari auto-cancellation rule

《コンビニ/ATM払いの場合》

購入者の支払い期限（購入日を含めて3日目の23:59:59）までに支払いが確認できない場合、
注文は購入日から4日目の0:00に自動でキャンセルされます。

- Day 1 = purchase date (購入日)
- Day 3 = deadline at 23:59:59 JST
- Day 4 = auto-cancel at 00:00 JST

Auto-cancellation does not affect shop quality rating (優良ショップ認定). Stock is
automatically returned after auto-cancel.

### Current state

- Mercari sends an automatic notification to the buyer when the order is placed (built
  into the platform — not our system).
- Our system does not send any payment reminders today.
- Message sync (`syncMercariMessages`) runs every 10 minutes and populates
  `has_buyer_messages` / `latest_buyer_message_id` on `sales_orders`.
- The relay already supports sending seller messages via
  `POST /admin/order-reply` → Mercari GraphQL `addOrderTransactionMessage`.

### Problem

Orders stuck in `WAITING_FOR_PAYMENT` receive no follow-up from us. The buyer may
forget to pay, leading to auto-cancellation and lost sales. A well-timed reminder
on day 2 and day 3 can recover these orders.

## Requirements

| # | Requirement | Detail |
|---|-------------|--------|
| R1 | Day 2 reminder | Send at 8:00 AM JST on the calendar day after purchase |
| R2 | Day 3 reminder | Send at 8:00 AM JST on the 2nd calendar day after purchase |
| R3 | Day 2 message | Stock secured, please pay ASAP |
| R4 | Day 3 message | Stock secured till end of today, please pay ASAP; order will be auto-cancelled |
| R5 | Product stock filter | Only send if ALL ordered products are still in stock (all line items' B2B item codes resolve to products with `owned_qty >= 1` or `qty_available >= 1`). Skip if any product is out of stock — no point reminding buyer to pay for something we can't ship |
| R6 | Buyer-contact guard | Do NOT send if the latest transaction message is from the buyer (customer already contacted us — don't double-remind) |
| R7 | Idempotency | Never send the same reminder type twice. Atomically reserve before sending. Retain the reservation after any send error because delivery may have succeeded despite a lost response. |
| R8 | Live status check | Fetch live Mercari transaction status via relay immediately before sending. Only send if `status === 'WAITING_FOR_PAYMENT'`; missing or unknown status fails closed. |

## Reminder timeline

```
Purchase          Day 2            Day 3            Day 4
  │                 │                │                │
  │  Mercari auto   │  8:00 AM       │  8:00 AM       │  00:00
  │  notification   │  Reminder #1   │  Reminder #2   │  Auto-cancel
  │                 │                │                │
  ▼                 ▼                ▼                ▼
┌─●─────────────────●────────────────●────────────────●──►
Day 1             Day 2            Day 3            Day 4
```

Example:
- Purchase: July 16 (Mon) 14:30 JST
- Day 2 reminder: July 17 (Tue) 08:00 JST
- Day 3 reminder: July 18 (Wed) 08:00 JST
- Auto-cancel: July 19 (Thu) 00:00 JST

## Design

### Architecture overview

```
Worker cron (0 23 * * * = 8:00 JST)
  └── send_payment_reminders phase
        ├── Query sales_orders: WAITING_FOR_PAYMENT, mercari channel
        ├── For each order:
        │     ├── Calculate reminder day (day 2 or day 3 based on purchase_date)
        │     ├── Check product stock via B2BItemCode → product inventory
        │     ├── Check idempotency (payment_reminders table)
        │     ├── Fetch live messages via relay → check last message role
        │     ├── Verify order still WAITING_FOR_PAYMENT on Mercari
        │     ├── Send reminder via relay /admin/order-reply
        │     └── Record in payment_reminders table
        └── Return summary
```

### New database table: `payment_reminders`

```sql
CREATE TABLE IF NOT EXISTS payment_reminders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          text NOT NULL,
  source_store_id   text NOT NULL,
  reminder_type     text NOT NULL CHECK (reminder_type IN ('day2', 'day3')),
  message_text      text NOT NULL,
  mercari_message_id text,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- One reminder type per order per store
  CONSTRAINT uq_payment_reminder UNIQUE (order_id, source_store_id, reminder_type)
);

CREATE INDEX IF NOT EXISTS ix_payment_reminders_order
  ON payment_reminders(order_id, source_store_id);
```

Table is keyed by `(order_id, source_store_id, reminder_type)`, not by
`sales_order_id`, because one Mercari transaction can produce multiple
`sales_orders` rows (one per product line item), but the reminder is sent at the
transaction level.

### New Worker phase: `send_payment_reminders`

**Cron**: `0 23 * * *` → fires at 23:00 UTC = 08:00 JST (next day)

**Phase aliases**: `payment_reminders`, `send_payment_reminders`

**Relay-dependent**: Yes (needs message fetch + reply)

### New module: `src/lib/payment-reminders.mjs`

```
sendPaymentReminders(env, { limit, dryRun })
  → { ok, orders_checked, day2_sent, day3_sent, skipped_out_of_stock,
      skipped_buyer_contact, skipped_already_sent, skipped_not_waiting, failed }

Functions:
  getReminderDay(purchaseDate, nowJst)
    → null | 'day2' | 'day3'

  shouldSendReminder(env, orderId, sourceStoreId, reminderType)
    → { send: bool, reason: string }

  fetchLatestMessageRole(env, shopLabel, orderId)
    → 'BUYER' | 'SELLER' | null

  sendReminder(env, shopLabel, transactionId, templateBody)
    → { ok, mercariMessageId }

  recordReminderSent(env, orderId, sourceStoreId, reminderType, messageText, mercariMessageId)
    → void
```

### Reminder day calculation

```js
function getReminderDay(purchaseDate, nowJst) {
  // purchaseDate is stored as timestamptz; convert both to JST calendar dates
  const purchaseDay = toJstDate(purchaseDate);  // e.g., 2026-07-16
  const todayJst = toJstDate(nowJst);           // e.g., 2026-07-17

  const diffDays = daysBetween(purchaseDay, todayJst); // today - purchase

  if (diffDays === 1) return 'day2';   // Next calendar day after purchase
  if (diffDays === 2) return 'day3';   // 2 calendar days after purchase
  return null;                          // Not a reminder day
}
```

Only orders purchased exactly 1 or 2 calendar days ago (in JST) are candidates.
Orders purchased 0 days ago or 3+ days ago are skipped (day 4 = auto-cancelled,
not worth reminding).

### Buyer-contact guard (R6)

Before sending, fetch live messages from Mercari via the relay:

1. Call `POST /admin/order-messages` with `{ shopLabel, orderId }`
2. Sort messages by `createdAt` descending
3. If the most recent message has `role === 'BUYER'` → skip (buyer already
   contacted us; automated reminder would be intrusive)
4. If no messages or latest is SELLER → proceed

This is a **live check**, not based on cached message state. Cached state
(`has_buyer_messages`) tells us whether buyer messages exist, but not whether the
*latest* message is from the buyer. A live check is the authoritative source.

### Live status check (R8)

The Mercari API returns the current transaction status in the message response.
Alternatively, we verify `order_status` on the `sales_orders` row is still
`WAITING_FOR_PAYMENT`. Since ingest runs every minute (`1 * * * *`), the DB
state is at most 1 minute stale. Use the DB state as the primary check.

If `order_status != 'WAITING_FOR_PAYMENT'` → skip (already paid or cancelled).

### Product stock filter (R5)

Check the **ordered product's current inventory stock**, not the order line's
`quantity` field. The order line `quantity` is always >= 1 for valid orders —
the real question is whether we still have stock to fulfill.

For each order, resolve the product via `B2BItemCode` → `findProductByItemCode()`
from `product-resolver.mjs`, then check:

- `owned_qty >= 1` OR `qty_available >= 1` → product has stock → proceed
- Both are `0` or `null` → out of stock → **skip** (no point reminding buyer to
  pay for something we can't ship; auto-cancellation is actually preferable)

If the product lookup fails (missing B2BItemCode, product not found, etc.):
skip with a logged reason. Fail closed.

### Message templates

Templates are stored in the `message_templates` table (reusing the existing
template infrastructure from auto-approval). Default templates:

**Day 2** (`payment_reminder_day2`):

```
この度はご購入いただきありがとうございます。
商品の在庫を確保しておりますので、お早めにお支払いをお願いいたします。

なお、コンビニ・ATM払いの場合、購入日を含めて3日目の23:59までにお支払いいただけないと、
4日目の0:00に自動キャンセルとなりますのでご注意ください。

ご不明な点がございましたら、お気軽にメッセージにてお問い合わせください。
```

**Day 3** (`payment_reminder_day3`):

```
お支払い期限が本日23:59までとなっております。
商品の在庫は本日終了時点まで確保しておりますので、お早めにお支払いください。

期限内にお支払いいただけない場合、注文は明日0:00に自動的にキャンセルされますので、
ご注意ください。

ご不明な点がございましたら、お気軽にメッセージにてお問い合わせください。
```

Templates support variable substitution:
- `{{product_name}}` — first product name on the order
- `{{purchase_date}}` — purchase date in JST format
- `{{deadline_date}}` — payment deadline date (purchase_date + 2 calendar days in JST; purchase day is day 1, deadline is end of day 3)

### Execution flow

```
sendPaymentReminders(env, { limit = 50, dryRun = false })
  1. Query Supabase sales_orders with server-side filters:
       WHERE sales_channel = 'mercari'
         AND order_status = 'WAITING_FOR_PAYMENT'
         AND purchase_date >= (2 days ago at 00:00 JST)
         AND purchase_date < today at 00:00 JST
       ORDER BY order_id, source_store_id, id
       PAGE until {limit} complete transaction groups are collected

  2. Deduplicate by (order_id, source_store_id) → apply client-side limit

  3. For each order:
     a. Calculate reminderDay from purchase_date
     b. If not day2 or day3 → skip
     c. Resolve shopLabel from source_store_id via channel-config
     d. Check product stock (R5) for ALL line items:
        - Collect unique B2B item codes across all line items
        - Resolve each via findProductByItemCode()
        - If any product is out of stock or unresolvable → skip (fail closed)
     e. Fetch live transaction state via relay (R6 + R8 combined):
        - /admin/order-messages returns status + messages
        - If status is not WAITING_FOR_PAYMENT, including missing → skip
        - If latest message role is BUYER → skip (R6)
        - If relay fails → skip (fail closed)
     f. Atomically reserve reminder slot (R7):
        - INSERT into payment_reminders with status='reserved'
        - If unique constraint violation → skip (already sent)
        - If insert fails for other reasons → skip (fail closed)
     g. Load template for reminderDay
     h. Send via relay /admin/order-reply
        - If send fails or the outcome is ambiguous → retain reservation, skip
     i. Confirm reservation: UPDATE row with message_text, mercari_message_id
     j. Increment counters

  4. Return summary
```

### Safety & fail-closed behavior

| Scenario | Behavior |
|----------|----------|
| Relay unreachable | Skip all orders, return error summary |
| Message fetch fails for one order | Skip that order, continue |
| Send fails | Skip that order, log error, continue |
| Template not found | Skip that order, log error |
| purchase_date is null | Skip (can't determine reminder day) |
| Order no longer WAITING_FOR_PAYMENT | Skip (status changed since query) |
| Latest message is from BUYER | Skip (don't double-remind) |
| Product is out of stock (R5) | Skip (no point reminding for unshippable order) |
| Reminder already sent for this day | Skip (atomic reservation — INSERT before send; unique violation = already sent) |
| Send fails after reservation | Retain reservation to prevent duplicate sends after ambiguous delivery |

All guardrails fail closed: if we can't verify it's safe to send, we don't send.

### Scope & non-goals

**In scope:**
- Mercari channel only (single channel for now; config-driven to add others later)
- Day 2 and day 3 reminders only
- 8:00 AM JST timing only
- Product stock filter (resolve via B2BItemCode, check inventory `owned_qty` / `qty_available`)
- Buyer-contact guard (live message check)

**Out of scope (future):**
- Rakuten / Amazon / Yahoo payment reminders
- Custom reminder timing per order
- Multi-language templates
- A/B testing reminder wording
- Portal UI for managing reminders
- Resending failed reminders

## Implementation plan

### Phase 1: Schema + module (backend only)

1. **Migration**: Create `payment_reminders` table
2. **Module**: `src/lib/payment-reminders.mjs` — orchestration and relay integration
3. **Pure functions**: `src/lib/payment-reminders-pure.mjs` — zero-dependency logic module
   (reminder day calculation, stock check, template rendering, deadline calculation)
   importable by tests without the full dependency chain
4. **Relay integration**: Reuse existing `runMercariOrderMessagesViaRelay` +
   `runMercariOrderReplyViaRelay`; relay updated to return transaction `status` alongside
   messages for R8 live status check
4. **Template defaults**: Seed `message_templates` with day2/day3 defaults
5. **Unit tests**: 31 tests importing directly from `payment-reminders-pure.mjs` —
   reminder day calculation (13), stock check (8), template rendering (6), deadline calculation (4)

### Phase 2: Worker integration

1. **Phase registration**: Add to `PHASE_ALIASES`, `SCHEDULED_CRON_MODES`,
   `RELAY_DEPENDENT_PHASES`
2. **runPhase handler**: Add `send_payment_reminders` case
3. **Cron**: `0 23 * * *` in `wrangler.toml`
4. **Dry-run support**: `--dry-run` flag for manual testing

### Phase 3: Deployment & smoke test

1. Deploy with dry-run first, observe logs for 24h
2. Verify candidate selection (correct orders, correct day)
3. Enable live sending
4. Monitor for 3 days, verify no duplicate sends

## Verification

- Unit tests for `getReminderDay()`, `isProductInStock()`, `renderTemplate()`, `getDeadlineDate()` (imported from `payment-reminders-pure.mjs` — same code as production)
- Dry-run mode shows which orders would receive reminders without sending
- Manual test: `node src/index.mjs --mode send_payment_reminders --dry-run --limit 5`
- After deploy: check `payment_reminders` table for sent records
- Monitor Mercari transaction messages to confirm delivery

## References

- Mercari auto-cancellation policy: コンビニ/ATM払い 支払期限 購入日含む3日目 23:59:59
- Relay messaging: `relay/server.mjs` — `/admin/order-messages`, `/admin/order-reply`
- Message sync: `src/lib/buyer-messages.mjs` — `syncMercariMessages`, `extractBuyerMessageFacts`
- Auto-approval messaging: `src/lib/auto-approval.mjs` — `sendAutoApprovalMessage` (pattern reference)
- Cron infrastructure: `worker/index.js` — `SCHEDULED_CRON_MODES`, `runPhase`
- Pure functions: `src/lib/payment-reminders-pure.mjs` — `getReminderDay`, `isProductInStock`, `renderTemplate`, `getDeadlineDate`
- Channel config: `src/lib/channel-config.mjs` — `MERCARI_CHANNEL.shopIds`
- Order states: `src/lib/order-state.mjs` — `ORDER_STATUS.WAITING_FOR_PAYMENT`
- Template system: `src/lib/portal/handlers.mjs` — `handlePortalTemplates*`
