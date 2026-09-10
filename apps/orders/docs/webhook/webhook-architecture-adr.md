# ADR: Mercari Webhook Message Detection Architecture

Issue: [#131](https://github.com/retailpulses/OrderMgmt/issues/131)
Date: 2026-08-04
Status: Implemented (shadow mode)

## Decision

OrderMgmt reuses Ticket Handling's single registered `order_transaction_message_created` webhook and durable receipt (`inbound_ticket_messages`) rather than registering a competing webhook on the same Mercari event.

### Rationale

1. **Avoids uncoordinated duplicate webhooks.** Ticket Handling already owns the registered webhook endpoint (`https://tickets.homesbliss.net/api/webhooks/mercari-message`) for all four shops. Registering a second webhook for OrderMgmt pointing to `rp-order-mgmt.jim-yang-3c5.workers.dev` would deliver every event twice, create write contention on the shared Supabase, and require separate webhook lifecycle management.

2. **Reuses proven contracts.** Ticket Handling's event contract (topic, payload, idempotency, shop mapping, auth) is production-proven across all four shops since 2026-07-10. OrderMgmt adopts the same contract unmodified.

3. **Governance-compliant.** The shared event path avoids cross-domain DB consumer declarations on `inbound_ticket_messages` (owned by `ticketing` domain) while still consuming the coordinated durable receipt through a forwarding contract.

## Cross-repo dependency

A small follow-up in Ticket Handling is required: after durable insert of `inbound_ticket_messages`, forward the raw validated event to OrderMgmt's webhook endpoint with the dedicated `ORDERMGMT_WEBHOOK_FORWARD_SECRET` via Bearer header (OrderMgmt side: `WEBHOOK_FORWARD_SECRET`).

**Forwarding contract:**

```
POST https://rp-order-mgmt.jim-yang-3c5.workers.dev/webhooks/mercari-message
Authorization: Bearer <WEBHOOK_FORWARD_SECRET>
Content-Type: application/json

{
  "topic": "ORDER_TRANSACTION_MESSAGE_CREATED",
  "shop_id": "<mercari_shop_id>",
  "order_transaction_id": "<transaction_id>",
  "created_at": "<iso8601>"
}
```

Expected response: 200 `{"success":true,"status":"ok","event_id":"<uuid>"}`

Duplicate: 200 `{"status":"duplicate"}`

If the forwarding delivers events successfully in < 2 seconds, OrderMgmt achieves near-real-time message detection. If forwarding is delayed or never implemented, OrderMgmt falls back to polling reconciliation (existing 10-minute schedule) with webhook miss metrics visible in observability.

OrderMgmt's endpoint is fully implemented, tested, and ready to consume forwarded events. No changes to Ticket Handling are required for OrderMgmt to complete its repo-side work.

## Feature flags

| Flag | Default | Effect |
|------|---------|--------|
| `WEBHOOK_INTAKE_ENABLED` | `false` | When `false`: webhook events are accepted (durable receipt) but async processing is skipped, and the folded webhook retry does not run. Use for shadow mode observation. |

**Rollback to polling-only:** Set `WEBHOOK_INTAKE_ENABLED=false` in wrangler.toml or Worker secrets. No code rollback needed. Polling continues unchanged.

## Database

New table: `order_management_message_webhook_event` (OrderMgmt `order_management` domain)

New columns on `sales_order_message_state`:
- `last_webhook_received_at` (timestamptz, nullable)
- `last_webhook_processed_at` (timestamptz, nullable)
- `webhook_miss_count` (integer, default 0)

See migration: `supabase/migrations/20260804000000_order_mgmt_webhook_event.sql`

## Processing latency target

< 60 seconds from Mercari event fire to portal reflection, under normal webhook delivery + Ticket Handling forwarding latency.

Measured from `webhook_received_at` (Mercari `created_at` in event) to `processing_completed_at` (when `writeThroughMessageFacts` completes).

## Retry and reconciliation

1. **Webhook retry:** `retryStuckWebhookEvents` atomically claims pending/stale rows via `claim_order_mgmt_webhook_event` RPC (attempts < 3; stale `processing` rows older than 15 min are reclaimed). Folded into the `sync_mercari_messages` phase (Issue #131); gated on `WEBHOOK_INTAKE_ENABLED=true`.

2. **Polling reconciliation:** `syncMercariMessages` (existing 10-min poll) runs unchanged. After writing message facts, it performs bulk webhook coverage checks via `recordWebhookMissesBulk` (one coverage select, one bulk audit insert). Messages discovered by polling with no prior webhook event are recorded as webhook misses with complete audit trail.

3. **Miss repair:** `recordWebhookMissesBulk` inserts reconciliation-source webhook event rows (idempotency key `reconciliation:{shopId}:{orderId}:{messageId}`, source `polling_reconciliation`) and increments `webhook_miss_count` on `sales_order_message_state` via the `increment_order_msg_webhook_miss_counts` RPC. This provides a complete audit trail of all detected messages regardless of delivery path.

## Rejected alternatives

### Register a competing OrderMgmt-only webhook
- **Rejected:** Creates an uncoordinated duplicate. Every Mercari buyer event fires twice. Two systems independently fetch the full conversation and write to the shared Supabase. No coordination on idempotency keys or processing status.

### Poll-only with no webhook endpoint
- **Rejected:** The issue explicitly requires a webhook ingress endpoint and near-real-time detection. Polling alone does not achieve the 60-second latency target.

### Direct read of inbound_ticket_messages by OrderMgmt
- **Rejected:** Requires cross-domain consumer declaration (`ticketing` domain → `order_management` consumer). Governance complexity outweighs benefit. Forwarding contract is simpler and keeps domain boundaries clean.

## Rollout plan

1. **Shadow mode (current):** `WEBHOOK_INTAKE_ENABLED=false`. Webhook endpoint is deployed and accepting events (durable receipt), but async processing is disabled. Polling continues at 10-minute cadence. Webhook events accumulate in `order_management_message_webhook_event` for observation.

2. **Observation window:** Enable `WEBHOOK_INTAKE_ENABLED=true` (after Ticket Handling forwarding is deployed). Compare webhook detections with polling results for ≥ 1 week. Monitor webhook miss counts, latency, duplicate rates.

3. **Cutover:** After parity is proven across all four shops, consider webhook-primary operation (e.g., a `WEBHOOK_PRIMARY_MODE=true` flag in a future pass). Reduce polling frequency through configuration. Remove `Message Check Pending` portal filter. Update portal tests and operator documentation.

4. **Rollback:** Set `WEBHOOK_INTAKE_ENABLED=false`. Polling resumes as sole detection path instantly.

## Verification

After deployment with shadow mode:
- `curl -X POST https://rp-order-mgmt.<account>.workers.dev/webhooks/mercari-message -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" -d '{"topic":"ORDER_TRANSACTION_MESSAGE_CREATED","shop_id":"WMyisFmhbGWyVAPEwsfirn","order_transaction_id":"order_tx_test","created_at":"2026-08-04T00:00:00Z"}'`
  → Expect 200 with status ok, or 200 duplicate on re-send.

- Check `order_management_message_webhook_event` table for received events.
- Check `webhook_miss_count` on `sales_order_message_state` — should be 0 until cutover if forwarding is working.
