# ConoHa Ticket Share Viewer

Standalone Node.js TypeScript service that renders public ticket share pages.
Deployed under `/opt/ticket-share-viewer` behind Nginx; source lives at
`web/share-viewer`.

## Routes

| Method | Path | Response |
|--------|------|----------|
| GET | `/tickets/share/:token` | HTML page (Japanese, mobile-first) |
| GET | `/tickets/share/:token/evidence/:attachmentId` | Inline evidence stream |
| GET | `/tickets/share/:token/evidence/:attachmentId/download` | Attachment download stream |
| GET | `/healthz` | `{ "status": "ok" }` |

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `TICKET_SHARE_BRIDGE_HMAC_SECRET` | HMAC-SHA256 secret shared with the Cloudflare Worker bridge |
| `TICKET_SHARE_WORKER_BASE_URL` | HTTPS origin of the Cloudflare Worker, normally `https://tickets.homesbliss.net` |
| `TICKET_SHARE_STORAGE_HOSTS` | Comma-separated hostname-only allowlist for Supabase Storage plus `tickets.homesbliss.net` for legacy R2 grants |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (loopback by default) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `30` | Max requests per window per IP |
| `MAX_CONCURRENT_STREAMS` | `5` | Max simultaneous evidence streams |
| `MAX_FILE_SIZE` | `104857600` | Max upstream file size in bytes (100 MiB) |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Timeout for upstream evidence fetch (ms) |
| `BRIDGE_TIMEOUT_MS` | `10000` | Timeout for bridge API calls (ms) |
| `EVIDENCE_URL_TTL_SECONDS` | `60` | Max age of signed evidence URLs |

## Local Commands

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Run tests
npm test

# Build (outputs to dist/)
npm run build

# Prove the compiled production entrypoint listens and serves /healthz
npm run test:entrypoint

# Run in development mode
npm run dev

# Run in production
npm start
```

## Bridge Protocol

The service communicates with a Cloudflare Worker over an HMAC-signed internal API.
Every bridge request carries `X-Timestamp`, `X-Nonce`, and `X-Signature` headers.
The canonical string for signing is:

```
METHOD
PATH
TIMESTAMP
NONCE
SHA256(BODY)
```

Where `METHOD` is uppercase, `PATH` is the URL path, and `SHA256(BODY)` is the
hex-encoded SHA-256 digest of the JSON request body.

Tokens are sent only in the signed JSON body — never in query strings or logs.

### Endpoints

- `POST /api/internal/ticket-shares/resolve` — resolves a share token to a ticket DTO
- `POST /api/internal/ticket-shares/evidence` — returns a time-limited signed upstream URL for an evidence attachment

## Security

- Token validated as exactly 64 lowercase hex characters before any bridge call
- Attachment IDs validated as UUIDs before bridge calls
- Evidence URLs must use HTTPS and match the configured host allowlist
- Private/link-local IP destinations are rejected (DNS pre-resolution)
- Upstream redirects are rejected
- All HTML output is escaped; only explicit DTO fields are rendered
- Security headers applied to all responses (CSP, X-Frame-Options, etc.)
- Request URLs, tokens, bridge bodies, headers, and upstream URLs are never logged

## Deployment

See `deploy/` for example:

- `ticket-share-viewer.service` — systemd unit (128 MiB memory limit, loopback listen)
- `nginx-vhost.conf` — Nginx vhost with token-redacted access logging, HTTPS, and connection limits

Deploy from a reviewed Git commit; do not edit source directly under `/opt`:

1. Create the low-privilege `ticket-share-viewer` system user.
2. Install a pinned Node 22 runtime under `/opt/ticket-share-viewer/runtime` plus the built `dist/`, production `node_modules/`, and `package.json`. Keep them root-owned and readable by the service user. Do not replace the host's Node 18 runtime.
3. Create `/etc/ticket-share-viewer.env` as root with mode `0600`. Include `HOST=127.0.0.1`, `PORT=3000`, the two required origins/host lists, limits, and the bridge secret.
4. Install the systemd unit and Nginx file, then run `systemd-analyze verify` and `nginx -t` before restart/reload.
5. Verify `/healthz` locally, HTTPS externally, token-redacted logs, and fail-closed behavior before enabling `ENABLE_TICKET_SHARES` in the Worker.

The current ConoHa host has two mandatory infrastructure gates before this
sample can be activated: `seller-share.homesbliss.net` needs a DNS record and
certificate, and the existing `rp-timesale` listener owns public port 80.
Prefer DNS-01 certificate issuance and a reviewed listener cutover; never patch
or stop `rp-timesale` ad hoc. Keep `ENABLE_TICKET_SHARES=false` until the
governance migration, Worker bridge, viewer health check, TLS, and synthetic
seller flow have all passed.

## Architecture Notes

- Single-instance v1 — rate and stream limits are in-process, not distributed
- Graceful shutdown on SIGTERM/SIGINT with 30-second drain timeout
- Environment validation at startup; exits on missing required variables
- Sensible upstream timeouts; generic error responses to clients
