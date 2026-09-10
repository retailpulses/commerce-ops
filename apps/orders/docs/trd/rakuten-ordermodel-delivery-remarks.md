# TRD: Rakuten OrderModel Delivery Preferences and Customer Remarks

## Status

Implemented as a correction to the active `ordermgmt_rakuten_order_pull` workload. No schema, schedule, writer, or kill-switch changes are introduced.

## Problem

Rakuten ingest previously read predicted `DeliveryModel.hopeDeliveryDate` and `DeliveryModel.hopeDeliveryTimeZone` fields. A live RMS `getOrder` v3 response proved that the operational values are top-level `OrderModel` fields, so the Portal and Giga projection silently lost delivery preferences and customer instructions.

## Verified source mapping

| RMS `OrderModel` source | `sales_orders` target | Downstream |
|---|---|---|
| `deliveryDate` | `requested_delivery_date` | Projection `RequestedDeliveryDate` → Giga `shippedDate` |
| `shippingTerm` | `requested_delivery_time` | Projection `RequestedDeliveryDate` → Giga `shippedDate` |
| `remarks` | tagged block in `order_comments` | Projection `OrderComments` → Giga `customerComments` |

`DeliveryModel.deliveryName` is intentionally not mapped. `shipping_method` exists in the schema but has no operational action in this workflow.

## Delivery-time mapping

`shippingTerm` is normalized as text so numeric and string responses behave identically.

| RMS code | Internal slot | Evidence |
|---:|---|---|
| `1` | `08:00-12:00` | Live order had `remarks` containing `午前中` |
| `1416` | `14:00-16:00` | Live RMS response |
| `1618` | `16:00-18:00` | Live RMS response |
| `1820` | `18:00-20:00` | Supported Portal/Giga slot encoding |
| `1921` | `19:00-21:00` | Live RMS response |

Unknown non-empty codes are never guessed. Ingest leaves the structured time empty, emits `rakuten_unknown_shipping_term` without customer data, and adds an idempotent operator warning to `order_comments`.

`812` and `0812` are explicit monitored edge cases: they could represent an
08–12 range after numeric/string normalization, but neither has been observed
or documented. They remain unmapped and visible to the operator until verified.

## Remarks ownership and idempotency

RMS customer remarks use a source-owned block:

```text
[ingest] RMSお客様備考:
<verbatim customer remarks>
[ingest] RMSお客様備考ここまで
```

On re-ingest, only this block and the managed delivery-code warning may change. Portal audit entries and operator memos remain untouched. Changed upstream remarks replace the existing block; repeated content is not duplicated. An empty upstream value retains the last captured block to prevent a partial RMS response from deleting customer instructions.

The Rakuten projector extracts only the block body for `OrderComments`. Internal warnings, operator notes, and Portal audit records are never sent to Giga.

## Replay and operational behavior

Normal idempotent re-ingest can backfill existing `sales_orders` rows. Existing non-empty operator-managed delivery date/time values retain precedence. Already-synced historical Giga orders are not replayed or recovered by this change.

## Validation

Regression coverage uses the observed `OrderModel` response shape and proves:

- date and supported time-code mappings, including verified morning code `1`;
- unverified `812` and `0812` edge cases remain unmapped rather than guessed;
- unknown-code diagnostics and idempotent warnings;
- multiline Japanese remarks preservation and replacement;
- operator memo/audit preservation on backfill;
- customer-only projection into `OrderComments`;
- outbound `customerComments` and `shippedDate` payloads.
