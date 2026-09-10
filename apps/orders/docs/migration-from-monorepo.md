# Migration from Monorepo

## Source

| Field | Value |
|-------|-------|
| Source repo | `https://github.com/retailpulses/workers` |
| Source path | `packages/order-mgmt` |
| Source commit SHA | `9404852327a280c6c4b979fe001aaea39d7d1da5` |
| Target repo | `https://github.com/retailpulses/OrderMgmt` |
| Migration date | 2026-06-07 |
| Reason | Dedicated repo for operational isolation and independent deploy |

## Statement

**OrderMgmt is now the source of truth.** The old monorepo package at `packages/order-mgmt` is deprecated and will be removed after production validation.

## Changes from monorepo

1. **Path restructuring**:
   - `worker/src/index.js` → `worker/index.js` (removed one nesting level)
   - `worker/wrangler.toml` → `wrangler.toml` (moved to root)
   - Worker imports changed from `../../src/lib/` → `../src/lib/`

2. **New root commands**: `npm run dev`, `build`, `test`, `deploy:*`, `tail:*`, `relay:*` all work from repo root.

3. **New workflows**: `deploy-worker.yml` and `deploy-relay.yml` in this repo (replacing monorepo's `deploy-workers.yml` and `deploy-relay.yml` for order-mgmt).

## Copied shared dependencies

None. The package was fully self-contained — all imports were internal to `packages/order-mgmt/`.

## Known differences

- Worker uses `main = "worker/index.js"` in wrangler.toml (was `src/index.js` relative to `worker/`)
- CI commands run from repo root, not from `packages/order-mgmt/`
- No changes to business logic, only import paths

## Old package removal plan

1. Push OrderMgmt repo and validate Worker dev deploy ✓
2. Run relay preflight ✓
3. Disable old monorepo deploy path (remove order-mgmt from workflow options)
4. Deploy Worker to production from OrderMgmt
5. Switch VPS relay to `/opt/OrderMgmt` and validate
6. **Only then**: delete `packages/order-mgmt/` from monorepo
