# Issue: Baserow Artifacts Mislead Supabase-Only Operations

## Impact

During investigation of order `2JTuQtwSr5TLUcZxZdcXK7` (paid in Shop4 but showing wait-for-payment), I defaulted to querying Baserow because the codebase still has pervasive Baserow references. The Worker is fully on Supabase (`DATABASE_BACKEND = "supabase"`), but a new agent or developer will naturally fall into the same trap.

## What misled the investigation

### 1. `wrangler.toml` still has Baserow table IDs as vars

```toml
BASEROW_API_BASE = "https://api.baserow.io/api"
BASEROW_MERCARI_SALES_ORDER_TABLE_ID = "903318"
BASEROW_RAKUTEN_SALES_ORDER_TABLE_ID = "1015675"
BASEROW_GIGA_SHIPMENT_ORDER_TABLE_ID = "903319"
```

These are actively consumed by `portal/shared.mjs` (`PORTAL_PRODUCTS_TABLE_ID = 886994`), `cache.mjs`, and other modules. Seeing `BASEROW_*` vars in the active config makes it look like Baserow is still a live dependency.

**Fix:** Audit every `BASEROW_*` var consumer. Either delete the var or rename to a backend-agnostic name (e.g., `SALES_ORDER_TABLE_ID`).

### 2. `BASEROW_DATABASE_TOKEN` is still a wrangler secret

The secret exists in the deployed Worker. It's dead config now — should be removed.

**Fix:** `npx wrangler secret delete BASEROW_DATABASE_TOKEN`

### 3. `master_credentials.md` still lists Baserow as the primary DB

Lines 17-20, 85-86, 114-115, 134 all document Baserow credentials. We looked up the token from here and used it to query Baserow directly, finding "correct" data — which was actually irrelevant because the Worker reads from Supabase.

**Fix:** Mark Baserow credentials as **deprecated / read-only fallback** with a clear note that production reads from Supabase. Or move them to a separate deprecated-credentials section.

### 4. `src/lib/baserow.mjs` still exists and is imported

`db.mjs` imports both `baserow` and `supabase` modules and switches between them. The facade pattern itself is fine (keeps fallback path), but the `baserow.mjs` adapter is ~14KB of dead production code that still exports `BASEROW_FIELD`, `BASEROW_OPTION` (re-exported by `db-fields.mjs`).

**Fix:** Either delete `baserow.mjs` and the fallback branch in `db.mjs`, or add a loud deprecation comment at the top of `baserow.mjs` stating it is NOT the active backend.

### 5. `db-fields.mjs` re-exports `BASEROW_FIELD`/`BASEROW_OPTION`

```js
export { BASEROW_FIELD, BASEROW_OPTION } from "./baserow.mjs";
```

This is explicitly "for backward compatibility during migration" (per the comment), but the migration is done. 31 files still import from here and see `BASEROW_FIELD` / `BASEROW_OPTION` as first-class exports.

**Fix:** Remove the re-export. Consumers should use `FIELD` / `OPTION` which are backend-agnostic.

### 6. `portal/cache.mjs` defaults backend to `"baserow"`

```js
const backend = String(env?.DATABASE_BACKEND || "").trim().toLowerCase() || "baserow";
```

The fallback string is `"baserow"`. When `DATABASE_BACKEND` is unset or empty, the system silently falls back to Baserow. This is dangerous — it should either fail closed or default to `"supabase"`.

**Fix:** Change fallback to `"supabase"` or throw if unset.

### 7. Baserow numeric table IDs scattered across source files

`903318`, `903319`, `1015675`, `886994` appear in 10+ production files. These are Baserow table IDs used as magic numbers — meaningless in a Supabase world.

**Fix:** Replace with named constants or Supabase table names.

### 8. `createBaserowClient()` function name

The DB client factory is still named `createBaserowClient`. Every caller reads as if it's creating a Baserow connection.

**Fix:** Rename to `createDbClient()` or `createClient()`.

## Files to change (priority order)

| Priority | File | Action |
|----------|------|--------|
| P0 | `wrangler.toml` | Remove `BASEROW_API_BASE`, `BASEROW_*_TABLE_ID` vars or rename to agnostic names |
| P0 | Cloudflare secrets | Delete `BASEROW_DATABASE_TOKEN` |
| P1 | `src/lib/db.mjs` | Rename `createBaserowClient` → `createDbClient`; update all callers |
| P1 | `src/lib/portal/cache.mjs` | Change `"baserow"` default to `"supabase"`; remove `env.BASEROW_API_BASE` references |
| P1 | `src/lib/db-fields.mjs` | Remove `BASEROW_FIELD`/`BASEROW_OPTION` re-export |
| P2 | `src/lib/baserow.mjs` | Delete or add loud `// DEPRECATED — Supabase is the active backend` header |
| P2 | `master_credentials.md` | Mark Baserow section as deprecated |
| P3 | All `903318`/`903319`/etc. consumers | Replace Baserow table IDs with Supabase table names |

## How to prevent recurrence

After cleanup, a new agent should see:
- `DATABASE_BACKEND = "supabase"` and nothing else
- No `BASEROW_*` env vars in active config
- A client factory named `createDbClient`, not `createBaserowClient`
- Credential docs that clearly label Baserow as read-only legacy
