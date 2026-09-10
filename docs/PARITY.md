# Build and test parity gates

These gates are derived from the current source manifests and are the minimum source-level checks required before production ownership can move to `commerce-ops`.

They intentionally do **not** deploy production.

## Ops Portal

Source: `retailpulses/ops-portal`

```bash
cd apps/ops-portal
npm ci
npm test
npm run lint
npm run build
```

Current source scripts:
- `test`: Node tests for `gateway/*.test.mjs`
- `lint`: Prettier check + ESLint
- `build`: Vite build

## Inquiry

Source: `retailpulses/inquiry-automation`

### Dashboard

```bash
cd apps/inquiry/apps/dashboard
npm ci
npm run typecheck
npm test
npm run build
```

### Worker

```bash
cd apps/inquiry/apps/worker
npm ci
npm test
```

The Worker deploy command is deliberately excluded from parity validation.

### Python enrichment/runtime helpers

```bash
cd apps/inquiry
python3 -m pytest
```

The repository `pyproject.toml` declares `tests/` as the pytest test path.

## Orders

Source: `retailpulses/OrderMgmt`

### Root Worker/orchestration code

```bash
cd apps/orders
npm ci
npm test
npm run build
npm run check
```

`npm run build` is currently a syntax check for `worker/index.js`; it is not a deployment.

### Order Portal

```bash
cd apps/orders/portal
npm ci
npm test
npm run lint
npm run build
```

### Portal API

```bash
cd apps/orders/portal-api
npm ci
npm test
npm run check
```

## Tickets

Source: `retailpulses/ticket-handling`

### Frontend

```bash
cd apps/tickets/web/frontend
npm ci
npm run typecheck
npm run lint
npm run build
```

### Worker

The Worker prebuild consumes the built frontend HTML, so frontend build must run first.

```bash
cd apps/tickets/web/worker
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` uses Wrangler dry-run output and must remain non-production.

### Ticket share viewer

```bash
cd apps/tickets/web/share-viewer
npm ci
npm run typecheck
npm test
npm run build
npm run test:entrypoint
```

## Phase 1 acceptance

After source snapshots are imported:

- [x] all commands above succeed from the new monorepo paths;
- [x] failures caused by relocation or intentional workflow omission are handled without changing runtime behavior;
- [x] no production deployment command runs as part of parity checks;
- [x] every documented subcomponent passes rather than relying on one command per domain;
- [x] each app retains an independent failure/rollback boundary.

Source-level parity was completed on 2026-09-10 and is enforced by four
independent path-scoped workflows. Deployment-only contract tests remain
explicitly skipped while the legacy deploy workflows are intentionally omitted
from this public Phase 1 snapshot.

## Phase 2 promotion gate

Source-level parity is necessary but not sufficient for production cutover. Phase 2 additionally requires secret/environment mapping, exact runtime target verification, a deployment from `commerce-ops`, smoke checks, and rollback verification for each independently releasable runtime.
