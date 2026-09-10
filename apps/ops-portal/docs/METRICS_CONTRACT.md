# Ops Portal Metrics Contract

**Version:** 1.1
**Status:** Proposed for Issue #65 implementation  
**Timezone:** `Asia/Tokyo`  
**Owners:** Ops Portal, Ticket Handling, Inquiry Automation, Order Management

## 1. Purpose

This document is the authoritative semantic contract for the operational metrics shown in the Ops Portal. It defines what each number means independently of database table names or UI labels.

Each owner application calculates its own metrics and exposes a fixed, authenticated, read-only endpoint. `ops-portal` aggregates those responses; it must not query owner databases or recreate owner formulas.

## 2. Common rules

### 2.1 Time windows

All calculations use `Asia/Tokyo` and half-open intervals:

```text
window_start <= event_time < window_end
```

`window_end` is the request evaluation time unless an explicit, authorized historical evaluation time is supplied.

| Key             | Formula                                                           |
| --------------- | ----------------------------------------------------------------- |
| `last_7_days`   | `window_start = window_end - 7 calendar days`                     |
| `last_30_days`  | `window_start = window_end - 30 calendar days`                    |
| `current_month` | `window_start = start of the first day of window_end's JST month` |

The API returns RFC 3339 timestamps with offsets. Database timestamps may be stored in UTC, but conversion to JST boundaries happens before comparison. Daylight-saving adjustment is not applicable to current JST rules; the named timezone remains mandatory.

### 2.2 Stock and flow

- **Window stock:** records created or received during the selected window that currently satisfy a state predicate.
- **Current stock:** all non-deleted records that currently satisfy a state predicate, regardless of creation time.
- **Window flow:** distinct records that experienced an authoritative state-transition event during the selected window.

Cards and APIs must label these separately. A flow value must never be derived from generic `updated_at`.

### 2.3 Record eligibility

Unless a metric states otherwise:

- exclude soft-deleted, test, fixture, and explicitly ignored records;
- count each canonical business record once per metric and window;
- use the canonical record ID as the deduplication key;
- return `unavailable`, not zero, when required source data or transition history is missing;
- fail closed on an unknown status: exclude it from both known status sets and emit a data-quality warning;
- do not infer historical state from the current row;
- use authoritative persisted events, never logs scraped at request time.

### 2.4 Owner status mapping

Each owner repository must maintain a version-controlled mapping from its physical status values to the logical sets below:

| Logical set                 | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `ticket_non_terminal`       | Ticket still requires or may require operational work    |
| `ticket_terminal`           | Ticket resolved/closed according to the owner workflow   |
| `inquiry_needs_reply`       | Customer inquiry currently requires an operator response |
| `inquiry_closed_won`        | Inquiry achieved the owner-defined successful outcome    |
| `inquiry_followed_up`       | An operator follow-up was recorded                       |
| `order_on_hold`             | Order is blocked by an explicit hold                     |
| `order_waiting_for_payment` | Order is awaiting confirmed payment                      |

An owner may change physical values without changing this contract only when the logical meaning remains identical. Mapping changes require owner tests and a metrics contract changelog entry or linked owner decision record.

## 3. Metric formulas

The SQL below is normative pseudocode. Owners adapt physical table and column names but must preserve the predicates.

### 3.1 Tickets

#### `tickets.open.window_count`

Tickets created during the selected window that are currently non-terminal.

```sql
COUNT(DISTINCT ticket.id)
WHERE ticket.created_at >= window_start
  AND ticket.created_at < window_end
  AND ticket.current_status IN ticket_non_terminal
  AND ticket.is_eligible = TRUE
```

#### `tickets.urgent_open.current_count`

Current non-terminal tickets whose priority is `urgent`. This is a current total,
not a selected-window flow, and its drill-through opens the urgent ticket queue.

#### `tickets.open.current_count`

```sql
COUNT(DISTINCT ticket.id)
WHERE ticket.current_status IN ticket_non_terminal
  AND ticket.is_eligible = TRUE
```

#### `tickets.closed.window_count`

Distinct tickets that entered a terminal state during the window.

```sql
COUNT(DISTINCT event.ticket_id)
WHERE event.occurred_at >= window_start
  AND event.occurred_at < window_end
  AND event.to_status IN ticket_terminal
  AND event.ticket_is_eligible = TRUE
```

Rules:

- repeated terminal transitions for one ticket count once in a window;
- a ticket closed and later reopened still counts in `closed.window_count` for the closure window;
- `closed_at` may replace the event query only if the owner proves it represents the authoritative terminal transition and preserves reopening history.

### 3.2 Inquiries

#### `inquiries.not_answered.window_count`

Inquiries received during the selected window that currently require a reply.

```sql
COUNT(DISTINCT inquiry.id)
WHERE inquiry.received_at >= window_start
  AND inquiry.received_at < window_end
  AND inquiry.current_status IN inquiry_needs_reply
  AND inquiry.is_eligible = TRUE
```

#### `inquiries.not_answered.current_count`

```sql
COUNT(DISTINCT inquiry.id)
WHERE inquiry.current_status IN inquiry_needs_reply
  AND inquiry.is_eligible = TRUE
```

`received_at` is the authoritative first inbound customer-message time. `created_at` may be used only when the owner verifies it is written from that same event and cannot represent a delayed import.

#### `inquiries.closed_won.window_count`

```sql
COUNT(DISTINCT event.inquiry_id)
WHERE event.occurred_at >= window_start
  AND event.occurred_at < window_end
  AND event.to_status IN inquiry_closed_won
  AND event.inquiry_is_eligible = TRUE
```

Repeated transitions into Closed Won count once per inquiry per window.

#### `inquiries.followed_up.window_count`

Distinct inquiries whose **first** transition into Followed-up occurred during the window.

```sql
COUNT(*)
FROM (
  SELECT event.inquiry_id, MIN(event.occurred_at) AS first_followed_up_at
  FROM inquiry_status_events event
  WHERE event.to_status IN inquiry_followed_up
    AND event.inquiry_is_eligible = TRUE
  GROUP BY event.inquiry_id
) first_event
WHERE first_event.first_followed_up_at >= window_start
  AND first_event.first_followed_up_at < window_end
```

Later follow-ups do not increment this metric. A separate follow-up-action metric would be required to count every attempt.

### 3.3 Orders

#### `orders.on_hold.window_count`

Distinct orders that entered On Hold during the window.

```sql
COUNT(DISTINCT event.order_id)
WHERE event.occurred_at >= window_start
  AND event.occurred_at < window_end
  AND event.to_status IN order_on_hold
  AND event.order_is_eligible = TRUE
```

Repeated On Hold transitions for one order count once per window.

#### `orders.on_hold.current_count`

```sql
COUNT(DISTINCT order.id)
WHERE order.current_status IN order_on_hold
  AND order.is_eligible = TRUE
```

#### `orders.waiting_for_payment.window_count`

Orders created during the selected window that are currently waiting for payment.

```sql
COUNT(DISTINCT order.id)
WHERE order.created_at >= window_start
  AND order.created_at < window_end
  AND order.current_status IN order_waiting_for_payment
  AND order.is_eligible = TRUE
```

#### `orders.waiting_for_payment.current_count`

```sql
COUNT(DISTINCT order.id)
WHERE order.current_status IN order_waiting_for_payment
  AND order.is_eligible = TRUE
```

Marketplace payment-pending and operational review-pending are different states and must not be merged unless the Order owner explicitly maps both to the same logical meaning.

## 4. Owner API contract

Each owner exposes a versioned endpoint under its canonical namespace. The physical path is owner-defined and registered in Portal acceptance governance.

Required request parameters:

```text
window=last_7_days|last_30_days|current_month
```

Required response:

```json
{
  "contract_version": "1.0",
  "domain": "inquiries",
  "window": {
    "key": "last_30_days",
    "start": "2026-07-31T12:00:00+09:00",
    "end": "2026-08-30T12:00:00+09:00",
    "timezone": "Asia/Tokyo"
  },
  "metrics": {
    "not_answered": {
      "kind": "window_stock",
      "window_count": 42,
      "current_count": 57,
      "status": "available",
      "warnings": []
    },
    "closed_won": {
      "kind": "window_flow",
      "window_count": null,
      "current_count": null,
      "status": "unavailable",
      "warnings": ["durable_transition_history_missing"]
    }
  },
  "generated_at": "2026-08-30T12:00:00+09:00",
  "release_sha": "0123456789abcdef0123456789abcdef01234567"
}
```

Contract rules:

- `release_sha` is the exact 40-character owner commit deployed;
- counts are non-negative integers or `null` when unavailable;
- `status` is `available`, `stale`, or `unavailable`;
- warnings use stable machine-readable codes and contain no identifiers or personal data;
- stale responses include the last successful `generated_at`;
- authentication is independent, read-only, least-privilege, and never browser-exposed;
- cache lifetime is at most five minutes;
- owners enforce bounded queries, rate limiting, timeouts, and redacted logs.

## 5. Portal aggregation and UI

- Default window: `last_30_days`.
- Render Tickets, Inquiries, and Orders independently so one owner failure does not hide the others.
- Display the selected-window number as the primary value, except for an explicitly
  current-total card such as `orders.on_hold`, which must label itself as current
  and state that it is not time-windowed.
- Display `current_count` only when supplied and label it **Current stock**.
- Display generated time and stale/unavailable state.
- Never turn missing or failed data into zero.
- Card drill-through uses `/tickets/`, `/inquiry/`, or `/order/` with an equivalent filter and time window where the owner UI supports it.
- The shared selector and cards are keyboard accessible and compatible with browser translation.
- Previous-period percentages are outside version 1.1. If added, compare an immediately preceding interval of identical duration and return `not_applicable` when the denominator is zero.

## 6. Commercial breakdown MVP

Issue #65 also requires views by supplier, product, and shop account. These are
one commercial-analysis slice, not 21 additional operational cards. The MVP
uses one validated order-line fact set and exposes three rankings from it.

### 6.1 MVP questions

The first release answers only:

1. Which shop accounts produced the most paid sales in the selected window?
2. Which products were the top sellers in that window?
3. Which GigaB2B suppliers are represented by those paid order lines?

"Supplier" means the upstream GigaB2B seller from whom Retailpulses purchases
the product. It never means a Retailpulses marketplace shop account.

### 6.2 Shared fact set and formulas

Order Management owns this endpoint and the order-side facts. Product and
supplier identifiers are resolved through a governed Supabase business-master
view or API; the Portal must not join owner databases.

An eligible fact is one canonical order line whose order reached the owner's
logical `paid` state during `[window_start, window_end)`. Exclude test orders,
soft-deleted lines, cancelled lines, and quantities refunded before
`window_end`. Deduplicate by canonical order-line ID.

The authoritative time is the first persisted transition into `paid`, not
`created_at` or generic `updated_at`. Reopening or later status changes do not
count the same order twice. If paid-transition history is unavailable, the
commercial breakdown is unavailable rather than reconstructed from current
status.

For every group:

```text
order_count = count(distinct canonical_order_id)
units_sold = sum(eligible_quantity - quantity_refunded_before_window_end)
gross_sales_jpy = sum(line_unit_sale_price_jpy * net_units)
```

`gross_sales_jpy` is before marketplace fees, shipping expense, procurement
cost, discounts not allocated to a line, and tax adjustments. It must be
labelled **Gross sales**, never profit or net revenue. Orders not denominated
in JPY are unavailable in MVP; currency conversion is out of scope.

### 6.3 Dimensions

| View          | Stable key                     | Display label                      | Ranking                                   | MVP rows                                     |
| ------------- | ------------------------------ | ---------------------------------- | ----------------------------------------- | -------------------------------------------- |
| Shop accounts | marketplace + owner account ID | Marketplace and shop name          | `gross_sales_jpy` descending              | all active accounts plus accounts with facts |
| Top products  | canonical item code            | current product name and item code | `units_sold` descending, then gross sales | top 20                                       |
| Suppliers     | GigaB2B supplier/seller ID     | current GigaB2B seller name        | `gross_sales_jpy` descending              | top 20                                       |

The response includes `dimension_as_of`. Renames may update display labels but
must not change stable grouping keys. Missing product or supplier mappings are
retained in explicit `unmapped_product` or `unmapped_supplier` buckets and emit
a data-quality warning; they must not disappear from totals.

For MVP, a product maps to at most one current primary GigaB2B supplier. If the
business master contains multiple suppliers or no deterministic primary
supplier, place the line in `unmapped_supplier`. Historical supplier
attribution and split sourcing require a future purchase-order fact model.

### 6.4 API extension

Order Management exposes a separate versioned read-only commercial metrics
endpoint. It accepts the same `window` keys as the seven operational metrics
and returns:

```json
{
  "contract_version": "1.1",
  "domain": "orders_commercial",
  "window": {
    "key": "last_30_days",
    "start": "2026-07-31T12:00:00+09:00",
    "end": "2026-08-30T12:00:00+09:00",
    "timezone": "Asia/Tokyo"
  },
  "dimension_as_of": "2026-08-30T12:00:00+09:00",
  "totals": {
    "order_count": 120,
    "units_sold": 168,
    "gross_sales_jpy": 840000
  },
  "by_shop_account": [],
  "top_products": [],
  "by_supplier": [],
  "status": "available",
  "warnings": [],
  "generated_at": "2026-08-30T12:00:00+09:00",
  "release_sha": "0123456789abcdef0123456789abcdef01234567"
}
```

Each row contains its stable key, display label, `order_count`, `units_sold`,
`gross_sales_jpy`, and `rank`. The sum of all shop-account rows and supplier
rows, including unmapped buckets, must reconcile to `totals`. `top_products`
is intentionally truncated and therefore is not expected to reconcile.

### 6.5 Portal presentation

- Keep the seven operational cards as the page summary.
- Add one **Sales breakdown** section below them using the shared window.
- Show three compact tabs or tables: **Shop accounts**, **Top products**, and
  **GigaB2B suppliers**.
- Show Gross sales, Units sold, and Orders columns; default sorting follows the
  dimension table above.
- Show the unmapped share and generated time. A partial commercial-endpoint
  failure must not affect the seven operational cards.
- Drill-through is optional in MVP and enabled only where the owner application
  has an equivalent stable filter.

### 6.6 MVP acceptance

- Fixed fixtures prove paid-boundary, cancellation, refund, duplicate-event,
  test-order, and missing-history behavior.
- Shop-account, top-product, and supplier results reconcile against one fixed
  owner-side reference query for each window.
- Shop-account and supplier rows plus unmapped buckets reconcile exactly to
  commercial totals.
- Supplier labels explicitly say GigaB2B supplier and cannot be confused with
  marketplace shop accounts.
- Product/supplier mapping coverage is reported; unmapped lines remain in
  totals.
- The endpoint stays within the existing timeout and five-minute cache policy
  with representative production volume.
- Portal acceptance verifies response schema, partial failure, responsive
  tables, keyboard tab navigation, and the exact owner release SHA.

### 6.7 Explicit non-goals for MVP

- profit, contribution margin, procurement cost, fees, or shipping-cost metrics;
- seller scorecards, supplier quality, lead time, or purchase-order performance;
- daily charts, period-over-period percentages, forecasts, goals, or alerts;
- arbitrary cross-filtering such as supplier by shop by product;
- product variants, categories, brands, cohorts, and customer segmentation;
- historical supplier reassignment or allocation across multiple suppliers;
- CSV export, saved views, custom date ranges, and Portal-side database joins.

These can be considered after metric reconciliation, mapping coverage, query
cost, and operator usage have been measured in production.

## 7. Validation requirements

Each owner must provide:

1. fixed fixtures covering every included status, excluded status, unknown status, boundary timestamp, duplicate event, reopened record, and soft-deleted record;
2. a reference query checked into the owner repository;
3. tests proving `[start, end)` behavior in JST;
4. reconciliation output containing counts only, without customer or order identifiers;
5. exact-SHA production acceptance through the governed ConoHa path.

Portal acceptance must verify:

- schema and contract version for all three owners;
- the requested window is preserved end to end;
- exact owner release SHAs;
- partial-failure rendering;
- stock/flow labels and canonical drill-through paths.

## 8. Definition change process

Formula, logical status meaning, timestamp source, eligibility, or deduplication changes require:

1. a contract version and changelog update;
2. owner fixture/reference-query updates;
3. review by the affected owner and Ops Portal maintainers;
4. reconciliation before production release.

Physical schema or status-name changes that preserve the documented semantics may remain within version 1.x but must retain traceability in the owner repository.

## 9. Changelog

### 1.1 — 2026-08-31

- Scoped supplier, top-product, and shop-account analysis as one commercial
  breakdown MVP.
- Defined the paid order-line fact set, grouping keys, formulas, mapping gaps,
  API boundary, presentation, acceptance criteria, and explicit non-goals.
- Clarified that supplier means the upstream GigaB2B seller.

### 1.0 — 2026-08-30

- Defined JST rolling and current-month windows.
- Defined seven Portal metrics and their stock/flow semantics.
- Added unknown-status, missing-history, deduplication, reopening, and deletion rules.
- Defined the owner API, aggregation, validation, and definition-change contracts.
