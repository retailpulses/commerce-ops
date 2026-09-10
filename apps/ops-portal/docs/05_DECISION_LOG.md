# Decision Log

## YYYY-MM-DD — Decision title

### Context

### Decision

### Impact

### Follow-up

## 2026-08-05 — Serve Order Portal under the Ops Portal hostname

### Context

Redirecting `/order` to `order.homesbliss.net` moved operators outside the
host-wide Cloudflare Access boundary and changed the visible URL.

### Decision

Reverse-proxy the existing Order Portal UI under `/order/*` and its API under
`/api/portal/*` using Cloudflare Pages Functions. Keep the existing Order
Portal deployment as the origin and retain its direct hostname.

### Impact

Operators remain on `ops.homesbliss.net/order` after the shared Cloudflare
Access login. The Order Portal remains independently deployable and directly
accessible at its current hostname.

### Follow-up

Monitor proxy errors and asset-path compatibility after Order Portal releases.

## 2026-09-08 — Product tools owner boundary

Ops product tools use the existing Access login and a dedicated server-side Ops caller to RPagentOS. Only three manual commercial fields are writable. Owner service-auth failures are unavailable errors, never a second operator login. Cost derives through the existing database trigger and is displayed from readback. OrderMgmt remains an independent consumer. Last-write-wins and non-transactional logs are explicit MVP constraints. Related to ops-portal#81 and RPagentOS#121.
