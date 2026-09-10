# Architecture Guidelines

## Cloudflare dependency reduction

Core ticket logic should remain portable. Worker-specific code stays thin.

- `src/logic/` — platform-agnostic business logic (classifier, templates, report builder). No KV, no `env.*`, no `Request`/`Response`.
- `src/clients/` — external API clients (Mercari, Baserow, WeCom, OpenAI). These use `fetch()` which is cross-platform.
- `src/utils/state.ts` — cursor persistence via KV. Isolate behind an interface if migrating runtime.
- `index.ts` — Worker entry point. Route dispatch, session management, static assets. This is the only file that should touch Workers runtime APIs (`KVNamespace`, `ScheduledEvent`).

## Avoid introducing more runtime lock-in

- No new KV bindings for core logic — KV is only for report/session/cursor storage.
- No D1, R2, Queues, or Durable Objects unless required by a feature with a clear portability path.
- If a new runtime API is needed, wrap it behind an interface in `src/utils/` first.
