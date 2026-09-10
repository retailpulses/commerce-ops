# RMS API Unknowns

**Date:** 2026-06-08  
**Status:** Blocked — requires RMS business portal access

The Rakuten RMS REST API (`es/2.0`) documentation is behind the Rakuten business
portal login (`https://manage.rms.rakuten.co.jp`).  The following items are
unverified and need confirmation once portal access is available.

---

## 1. Date format for searchOrder (BLOCKER)

**Endpoint:** `POST /es/2.0/order/searchOrder`

**Problem:** All datetime formats tried for `startDatetime` / `endDatetime` fields
fail with error code `ORDER_EXT_API_SEARCH_ORDER_ERROR_011` (format incorrect).

**Tested formats (all fail):**

| Format | Example | Result |
|--------|---------|--------|
| ISO with timezone | `2026-06-05T00:00:00+09:00` | Error 011 |
| ISO without timezone | `2026-06-05T00:00:00` | Error 011 |
| Space-separated | `2026-06-05 00:00:00` | Error 011 |
| Japanese slash | `2026/06/05 00:00:00` | Error 011 |
| Compact | `20260605000000` | Error 011 |
| With milliseconds | `2026-06-05T00:00:00.000` | Error 011 |
| With Z suffix | `2026-06-05T00:00:00.000Z` | Error 011 |
| Date-only | `2026-06-05` | Error 011 |

**Verified correct:**
- `Content-Type: application/json; charset=utf-8` (without charset → 415)
- Field names: `dateType`, `startDatetime`, `endDatetime` (not startDate/endDate)
- ESA auth: `base64(serviceSecret:licenseKey)`

**What to check in RMS docs:**
1. Exact datetime format specification
2. Whether the field requires a specific timezone (JST? UTC?)
3. Whether `dateType: 1` is correct for order-date filtering

---

## 2. Order shipping/close endpoint (UNVERIFIED)

**Repository implementation:** `POST /es/2.0/order/updateOrderShipping/`, after
an exact `getOrder` version 7 read resolves basket/shipping-detail identity.

The request is built per basket by `buildRakutenShippingUpdate()` and reuses an
existing matching `shippingDetailId` where present. Ambiguous or incomplete
multi-destination mapping fails before mutation.

**What to check in RMS docs:**
1. Correct endpoint path (may be `/order/shippingOrder`, `/order/updateOrderShipping`, etc.)
2. Required vs optional fields in the request body
3. How to pass carrier code (RMS may use numeric carrier codes)
4. Response structure on success vs error
5. Whether the endpoint supports batch (multiple orders) or single-order only

**Code locations governed by verification:**
- `relay/server.mjs` → `runRakutenClose()` — RMS API call
- `relay/server.mjs` → `runRakutenClose()` — request body field names
- `src/lib/rakuten-closer.mjs` — may need to pass additional fields

This records implemented repository behavior, not current external authority.
The phase remains unscheduled until the official/current RMS contract and one
controlled production canary are verified.

---

## 3. Order status values

**What to check:**
1. Full list of order status values returned by `searchOrder`
2. Whether there are intermediate statuses between "NEW" and "shipped"
3. Whether the status filter in searchOrder accepts the same values

---

## Resolution process

1. Log into `https://manage.rms.rakuten.co.jp` with Rakuten store credentials
2. Navigate to API documentation (通常は「RMS API」または「WEB API」メニュー)
3. Check `es/2.0/order/` endpoint reference
4. Update this document and the affected code
5. Run the smoke test again with the corrected format
