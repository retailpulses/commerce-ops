# Canonical gateway runbook

The Git-managed ConoHa gateway owns only `ops.homesbliss.net` routing. Cloudflare
Access remains the authentication boundary. Application authorization remains in
the owning repository.

## Routes

- `/inquiry/` -> Inquiry Pages owner origin (prefix stripped at origin boundary)
- `/tickets/` -> fixed Tickets Workers owner origin (native prefix retained;
  avoids nested custom-domain Access while gateway-only app auth remains required)
- `/order/` -> local Order Nginx (native prefix retained)
- `/` -> Ops Portal operational metrics
- `/registry` -> Agent Capability Registry
- `/_gateway/health` -> local read-only gateway health

No request parameter can select an upstream. Inbound service-token headers are
discarded. Access, Tickets origin, and Order origin credentials live only in `/etc/ops-portal-gateway.env`
with mode `0600`; never commit them.

## Deploy and rollback

Install a reviewed exact SHA with `deploy/install-gateway.sh <sha> <checkout>`.
Releases are immutable under `/opt/ops-portal-gateway/releases/<sha>` and
`current` is switched atomically. To roll back, repoint `current` atomically to
the prior release and restart `ops-portal-gateway`; target RTO is under 5 minutes.

Before tunnel cutover, test `http://127.0.0.1:8090/_gateway/health` and each path
using `Host: ops.homesbliss.net`. Merge `deploy/cloudflared-ingress.yml` before
the terminal tunnel rule, validate, restart `cloudflared-rp`, then run canonical
exact-SHA acceptance. Never remove standalone rollback origins during the
7-14-day observation window.

## Product tools (Issue #81)

`/tools` and `/tools/product-update` are served by Ops Pages. GET/PATCH
`/api/tools/products/:itemCode/manual-fields` runs in this gateway and calls
fixed RPagentOS SKU/manual-fields endpoints; it never traverses OrderMgmt.

Configure in `/etc/ops-portal-gateway.env` (0600):

- `OPS_ACCESS_ISSUER`: existing Access team HTTPS issuer, no trailing slash.
- `OPS_ACCESS_AUD`: existing Ops Access application audience.
- `OPS_PRODUCT_OPERATOR_SUBJECTS`: comma-separated allowed verified subjects;
  explicit `*` maps the existing Access application's human population to the
  bounded read/write capabilities. No new user/password store.
- `OPS_PRODUCT_WRITES_ENABLED=true`: independent write kill switch, default off.
- `OPS_CATALOG_API_TOKEN`: independent Ops-only secret matching owner Pages.

JWT signature/issuer/audience/time/sub validation applies even to direct origin
requests. Missing/invalid user session is 401; owner service auth errors are 503.
Cross-origin/non-JSON writes fail before owner calls. Never copy browser actor
headers: use verified `sub` and generated request ID. Owner structured events
retain this attribution. No token or customer data belongs in logs.

Deployment ships all gateway `.mjs` modules together. Activate owner first, then
gateway and UI. Disable only Ops write switch/token for rollback; preserve the
OrderMgmt token. Validate Access coverage of both UI and API and deployed JS
through the canonical URL. No business record is changed by deployment itself.
