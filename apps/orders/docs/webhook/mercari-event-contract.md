# Mercari Webhook Event Contract

Issue: [#131](https://github.com/retailpulses/OrderMgmt/issues/131)
Date: 2026-08-04
Evidence: [`retailpulses/ticket-handling`](https://github.com/retailpulses/ticket-handling) — production-proven implementation

## Supported event

- **Topic:** `order_transaction_message_created` (Mercari sends `ORDER_TRANSACTION_MESSAGE_CREATED`)
- **Meaning:** A new message (any role) was added to an order transaction conversation
- **Scope:** All Mercari Shops order transactions
- **Notification-only:** The webhook payload signals that the conversation changed; it does NOT contain the message content. The receiver must fetch the full conversation via the Mercari Shops GraphQL API through the fixed-IP VPS relay.

## Registration

Registered via Mercari Shops GraphQL API (authenticated by shop token):

```graphql
mutation createWebhook($input: CreateWebhookInput!) {
  createWebhook(input: $input) {
    webhook { id endPoint topic createdAt }
  }
}
```

Input: `{ endPoint: "<webhook-url>", topic: "ORDER_TRANSACTION_MESSAGE_CREATED" }`

List existing webhooks:
```graphql
query { webhooks { id endPoint topic createdAt } }
```

## Ownership decision

Ticket Handling owns the single registered `order_transaction_message_created` webhook for all four Mercari shops. The webhook endpoint is `https://tickets.homesbliss.net/api/webhooks/mercari-message`.

OrderMgmt does NOT register a competing webhook. It reuses Ticket Handling's registered event path and durable receipt (`inbound_ticket_messages`). Ticket Handling is expected to forward raw events to OrderMgmt's endpoint after durable insert (cross-repo follow-up). The forwarding contract is defined in `webhook-architecture-adr.md`.

## Payload

```json
{
  "topic": "ORDER_TRANSACTION_MESSAGE_CREATED",
  "shop_id": "WMyisFmhbGWyVAPEwsfirn",
  "order_transaction_id": "order_tx_abc123",
  "created_at": "2026-08-04T10:30:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `topic` | string | Event topic. Mercari sends `ORDER_TRANSACTION_MESSAGE_CREATED` (SCREAMING_SNAKE_CASE). Normalize to `order_transaction_message_created` for internal use. |
| `shop_id` | string | Mercari seller shop ID. Stable identifier, maps to OrderMgmt internal shop names (Shop1-4). |
| `order_transaction_id` | string | Mercari order transaction ID. Maps to `sales_orders.order_id` after stripping the `order_` prefix. |
| `created_at` | string (ISO 8601) | Mercari-side timestamp when the event fired. Used as part of the idempotency key. |

## Authentication

Bearer token in `Authorization` header:
```
Authorization: Bearer <WEBHOOK_FORWARD_SECRET>
```

OrderMgmt validates with constant-time comparison (no timing side-channel).
No query-string secret in the OrderMgmt design.

## Idempotency

**Key:** `webhook:{shop_id}:{order_transaction_id}:{created_at}`

Backed by a Postgres UNIQUE constraint on `order_management_message_webhook_event.idempotency_key`.

Duplicate deliveries (at-least-once semantics) return 200 with `{"status": "duplicate"}` and do NOT re-trigger processing.

## Shop ID mapping

| shop_id | Internal name | Shop label |
|---------|--------------|------------|
| `WMyisFmhbGWyVAPEwsfirn` | Shop1 | ホムブリス・アウトレット |
| `ZaMyGWzp6hUdgDh5E9ADob` | Shop2 | ホムブリズ・２号店 |
| `2JGrmZqojnBMfdWrtP2xk3` | Shop3 | ホムブリス・リビング家具特化 |
| `2JMLHBxjiFHDr55jMwA7fs` | Shop4 | ホムブリス本店・まとめ買い特化 |

## Delivery and retry

- **Delivery guarantee:** At-least-once. Mercari retries on non-2xx responses.
- **Timeout:** ~10 seconds (OrderMgmt returns 2xx immediately after durable insert).
- **Ordering:** Not guaranteed. Out-of-order events are safe — message state is determined by the fetched conversation, not the event arrival order.
- **Notification-only:** Yes. Event signals change; full conversation fetched via VPS relay.

## Processing flow

```
Mercari → Ticket Handling webhook endpoint → durable inbound_ticket_messages
                                                    │
                                    (forwarding contract, cross-repo follow-up)
                                                    │
                                                    ▼
OrderMgmt /webhooks/mercari-message
  ├── Auth: Bearer token, constant-time compare
  ├── Validate: topic, shop_id, order_transaction_id, created_at
  ├── Durable insert: order_management_message_webhook_event (idempotency key UNIQUE)
  ├── 2xx immediately (acknowledge = durable receipt confirmed)
  └── ctx.waitUntil(processWebhookEvent)
        ├── Feature flag: WEBHOOK_INTAKE_ENABLED
        ├── Check order scope: WAITING_FOR_PAYMENT or WAITING_FOR_SHIPPING
        ├── Fetch full conversation via VPS relay (runMercariOrderMessagesViaRelay)
        ├── writeThroughMessageFacts (never modifies read cursor)
        └── Update event row: status, latency, buyer_message_id
```

## Validation rules

| Check | Failure response |
|-------|-----------------|
| `WEBHOOK_FORWARD_SECRET` not configured | 503 `{"code": "DISABLED"}` |
| Missing/invalid `Authorization: Bearer` header | 401 `{"code": "UNAUTHORIZED"}` |
| Invalid JSON body | 400 `{"code": "VALIDATION_ERROR"}` |
| Missing required fields | 400 `{"code": "VALIDATION_ERROR"}` |
| `created_at` not a valid ISO-8601 timestamp | 400 `{"code": "VALIDATION_ERROR"}` |
| Request body > 64 KiB | 413 `{"code": "PAYLOAD_TOO_LARGE"}` |
| Unknown `topic` (not `order_transaction_message_created`) | 400 `{"code": "VALIDATION_ERROR"}` |
| Unknown `shop_id` | 400 `{"code": "VALIDATION_ERROR"}` |
| Duplicate event (idempotency key collision) | 200 `{"status": "duplicate"}` |

## Scope guardrails

OrderMgmt processes webhook events **only** for orders in:
- `WAITING_FOR_PAYMENT`
- `WAITING_FOR_SHIPPING`

Events for `COMPLETED`, `CANCELED`, or orders not found in `sales_orders` are recorded as `out_of_scope` and skipped. This matches the current polling scope.
