# inquiry-automation-worker

Canonical Cloudflare Worker for the Supabase-backed inquiry automation
pipeline. It classifies canonical inquiries on a 30-minute schedule. Draft
generation and product linking are operator-driven and are not run by this
Worker.

## Production status

- Database: shared Supabase through server-side PostgREST
- Writes: guarded by `INQUIRY_AUTOMATION_WRITES_ENABLED`
- Notifications: independently guarded by
  `INQUIRY_EXTERNAL_NOTIFICATIONS_ENABLED`
- State: Durable Object cursor and lock
- Historical Baserow adapters and secrets: retired

## Commands

```bash
npm ci
npm test
npm run typecheck
npm run build
npx wrangler dev --test-scheduled
npx wrangler deploy
```

Required Worker secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `ADMIN_TOKEN`

Optional provider/notification secrets are documented in `wrangler.toml`.
