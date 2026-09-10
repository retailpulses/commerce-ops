# TRD: Order Pipeline Integrity and Control-Plane Hardening

- **Author:** Codex
- **Date:** 2026-06-18
- **Status:** Implementing
- **Issue:** #6

## Version Change Log

| Version | Date | Change |
|---------|------|--------|
| v0.1 | 2026-06-18 | Initial canonical TRD for P0 pipeline integrity, control-plane auth, field ownership, and terminal-state handling. |
| v0.2 | 2026-06-18 | Incorporated review remarks: classifier trigger, shared executor, field ownership API, channel support, recovery mode, Baserow schema preflight, and explicit delivery date/time preservation. |
| v0.3 | 2026-06-18 | Made operator-owned address fields and B2B item-code fields explicit protected fields. |
| v0.4 | 2026-06-19 | Deployable Wave 1/2 patch on current `main`: `/admin/*` Worker routes require `ORDER_MGMT_ADMIN_SECRET` with existing `GIGA_SYNC_ADMIN_SECRET` accepted as a legacy fallback for safe rollout; Mercari existing-row ingest PATCHes use the phase ownership allow-list; protected delivery, address, B2B item-code, notes, and tracking fields are preserved. |

## Scope

This TRD defines the P0 hardening plan for OrderMgmt pipeline integrity and control-plane safety. The near-term production deploy covers Wave 1 and Wave 2 only.

## Wave 1: Admin Control-Plane Guard

All Worker `/admin/*` routes must require app-layer admin authentication before route-specific body parsing or pipeline execution. The active secret is `ORDER_MGMT_ADMIN_SECRET`; the existing production `GIGA_SYNC_ADMIN_SECRET` is accepted as a temporary legacy fallback so deployment does not lock out admin operations before the new secret is provisioned. `/health` remains public.

Acceptance criteria:

- Missing or invalid `Authorization: Bearer <token>` returns a generic no-store `401`.
- Valid bearer token matching `ORDER_MGMT_ADMIN_SECRET` allows admin route execution.
- Responses do not leak secret names, secret lengths, or partial token values.

## Wave 2: Field Ownership Allow-List

Existing-row automation must update only fields owned by the active pipeline phase. Re-ingest must not overwrite operator-owned fields.

Mercari sales row protected fields include:

- `review_status`
- `B2BItemCode`
- `requested_delivery_date`, `requested_delivery_time`
- `shipping_name`, `shipping_postal_code`, `shipping_state`, `shipping_city`, `shipping_address_1`, `shipping_address_2`, `shipping_phone_number`
- `billing_name`, `billing_postal_code`, `billing_state`, `billing_city`, `billing_address_1`, `billing_address_2`
- `order_comments`
- `shipping_carrier`, `shipping_tracking_info`, `shipping_completed_at`
- shop-close, cancellation, terminal-state, and operator memo fields

Shipment-row protected fields include:

- `B2BItemCode`, `BuyerPlatformSku`
- `RequestedDeliveryDate`, `RequestedDeliveryTime`
- `ShipToName`, `ShipToPhone`, `ShipToPostalCode`, `ShipToState`, `ShipToCity`, `ShipToAddressDetail`, `ShipToCountry`
- `OrderComments`
- tracking, Giga sync completion, and terminal-state fields

The initial deployed enforcement applies to Mercari sales re-ingest existing-row PATCHes. Projection, outbound sync, tracking reconciliation, and terminal-state quarantine remain follow-up waves.

## Implementation Files

| File | Role |
|------|------|
| `src/lib/admin-auth.mjs` | Shared admin auth and generic 401 response helpers. |
| `worker/index.js` | Applies admin auth guard to `/admin/*` routes. |
| `src/lib/field-ownership.mjs` | Phase/table/channel ownership registry and PATCH allow-list helpers. |
| `scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs` | Uses the ownership registry for existing-row Mercari ingest PATCHes. |
| `src/lib/__tests__/admin-auth.test.mjs` | Admin auth unit tests. |
| `src/lib/__tests__/field-ownership.test.mjs` | Field ownership and protected-field tests. |

## Remaining Follow-Up Waves

- Wave 3: relay-backed phases must report real completion rather than HTTP 202 acceptance as success.
- Wave 4: terminal-state quarantine and bounded backlog scanning.
- Wave 5: extend field-ownership enforcement to projector/outbound/tracking paths and add schema preflight for optional terminal fields.
