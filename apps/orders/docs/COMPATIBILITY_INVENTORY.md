# Compatibility Inventory — OrderMgmt

Status: **current repository inventory**  
Last reconciled: 2026-09-03  
Related: #262

This inventory identifies transitional/legacy paths that must not be mistaken for canonical architecture. Removal is intentionally separate from inventorying: each item has a retirement condition so cleanup does not break an active fallback or diagnostic path.

## Disposition vocabulary

- **Retain** — currently serves a required architectural/integration purpose.
- **Verify before retire** — canonical replacement exists, but runtime/data parity or consumers must be verified first.
- **Retire candidate** — repository evidence shows the path is no longer primary and no continuing architectural role is known; remove only through a scoped change with tests/rollback.
- **Historical only** — retain as history/documentation, not executable current architecture.

## Inventory

| Compatibility layer | Current evidence | Canonical replacement | Disposition | Retirement condition |
|---|---|---|---|---|
| Baserow datastore/backend paths | `db.mjs` facade and multiple modules still support non-Supabase/Baserow behavior; `wrangler.toml` still carries Baserow API/table vars | Supabase `order_management` | **Verify before retire** | Confirm no production process runs with non-Supabase backend; remove remaining Baserow reads/writes/vars only after migration/audit tooling is isolated |
| Baserow migration/parity tooling | Historical cutover/audit scripts require comparison with legacy data | Supabase | **Retain (bounded tooling)** | Keep only explicitly named migration/audit tooling; prevent it from being imported by production runtime |
| Cloudflare KV message state | `buyer-messages.mjs` reads Supabase first, falls back to `PORTAL_KV`; writes KV and Supabase during cutover | Supabase `sales_order_message_state` | **Verify before retire** | Demonstrate message-state parity/completeness and successful read/write behavior with KV unavailable; then remove fallback/dual-write and KV binding |
| Cloudflare KV template path | VPS Portal uses Supabase-backed `order_message_templates`; source comments state Worker can still use KV directly | Supabase `order_message_templates` | **Verify before retire** | Confirm no active Worker Portal/template consumer requires KV and Worker compatibility API can use Supabase-only path |
| `PORTAL_KV` Worker binding | Still declared in `wrangler.toml` | Supabase | **Verify before retire** | All KV consumers removed or proven non-production; deploy Worker without binding and smoke-test compatibility endpoints/message state |
| Worker browser Portal UI | `/` and `/portal` redirect to `https://order.homesbliss.net/`; inline UI retired | VPS React/Vite SPA | **Retire complete / redirect retain** | Keep redirect while Worker domain remains exposed; no inline UI should be restored |
| Worker `/api/portal/*` routes | Full compatibility API remains implemented in `worker/index.js` | VPS Hono Portal API | **Verify before retire** | Identify every caller/diagnostic/rollback dependency; prove VPS API covers required endpoints; decide whether emergency diagnostics justify a reduced subset |
| Worker internal ticket-order endpoint | `/internal/ticket-order/:id` remains an inter-service API with explicit auth | Governed OrderMgmt service boundary (runtime may later move) | **Retain** | This is a current integration contract, not legacy merely because it runs on Worker; retirement requires consumer migration |
| Worker Mercari message webhook intake | `/webhooks/mercari-message` remains implemented | No confirmed replacement in current audit | **Retain** | Move only as an explicit ingress/runtime architecture change with external webhook cutover |
| Worker scheduled pipeline | Full cron schedule declared in `wrangler.toml` | Possible future VPS durable execution plane, not yet established | **Retain pending scheduler decision** | Live scheduler verification + workload-by-workload cutover; never remove because timer files merely exist |
| Legacy 3-timer VPS scheduler (`pipeline-hourly/sync/close`) | `deploy/README.md` describes enabling these as Worker replacement | Fine-grained timer generation / future target scheduler TBD | **Retire candidate / historical** | Live VPS check proves these timers are disabled/not used; then archive/remove obsolete units/docs |
| Fine-grained 16 VPS pipeline timers | Install workflow exists but explicitly disables all units on installation | Potential future VPS execution plane | **Retain as inactive capability** | Either promote through explicit cutover or remove if execution-plane decision rejects them |
| `createBaserowClient` naming | Function now acts as DB facade and can return Supabase client, causing semantic confusion | Backend-neutral DB client/factory | **Retire candidate (naming debt)** | Rename in a scoped refactor after legacy Baserow runtime removal; avoid doing this during functional migration |
| `BASEROW_*` vars in `wrangler.toml` | Still configured despite `DATABASE_BACKEND="supabase"` | Supabase configuration / explicit legacy audit config | **Verify before retire** | Trace runtime references; remove vars not needed in Supabase production, leaving legacy tooling config outside canonical runtime |
| Historical architecture/cutover documents | Kept for rationale/evidence | `docs/01_ARCHITECTURE.md` | **Historical only** | Keep status labels; never use as current architecture authority |

## Highest-priority cleanup candidates

### 1. KV message-state fallback / dual-write

This is the clearest transitional state. Current logic is intentionally resilient: Supabase read first, KV fallback on missing/error, plus KV+Supabase write-through. Removing KV prematurely could lose unread/read cursor continuity if Supabase rows are incomplete. The correct next step is parity verification under a simulated/real KV-unavailable path, not immediate deletion.

### 2. Worker Portal compatibility API

The browser UI is already retired, but the Worker still exposes the Portal API surface. That creates duplicate API implementations/runtime surfaces. Before retirement, callers must be identified because these routes may still serve emergency diagnostics or old clients. A likely target is either full retirement or a deliberately small diagnostic/internal subset.

### 3. Baserow runtime support

Supabase is canonical, yet backend-neutral code still carries Baserow compatibility and Baserow-specific environment variables. Removal should separate two concerns:

- production runtime support — should be retired once proven unused;
- historical parity/migration tools — may remain in an explicitly isolated legacy/audit area.

Do not delete migration evidence just to make the production tree look clean.

### 4. Duplicate scheduler generations

The old three-timer design and newer sixteen-timer design both exist. Neither should be treated as active until live VPS evidence exists. Once verified, obsolete timer generation(s) and contradictory deployment documentation should be removed or archived.

## Guardrails for future PRs

- New code must not add Baserow dependencies without explicit architecture approval.
- New state must not be added to Cloudflare KV when Supabase can own it canonically.
- New Portal features should target the VPS Portal API, not expand Worker compatibility routes.
- New durable scheduled business workflows should not be duplicated across Worker and VPS without an explicit ownership/cutover decision.
- A compatibility path must state its retirement condition when introduced.

## Follow-on work

Recommended removal order after evidence is available:

1. Live scheduler verification and scheduler-generation disposition.
2. Message-state KV parity test, then remove KV fallback/dual-write/binding if safe.
3. Portal compatibility caller audit, then reduce/retire Worker `/api/portal/*`.
4. Production Baserow reference tracing, then remove unused runtime support and relocate bounded legacy audit tooling.
5. Reconcile `docs/01_ARCHITECTURE.md` after each architecture-affecting retirement Phase.