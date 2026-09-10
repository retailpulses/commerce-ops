# inquiry-automation

Canonical Retailpulses inquiry automation runtime, backed exclusively by the
shared Supabase `inquiry_management` domain.

## Production components

| Path | Runtime | Role |
|---|---|---|
| `apps/worker/` | Cloudflare Worker | Scheduled inquiry classification |
| `apps/dashboard/` | React + Pages Functions | Operator inquiry UI and authenticated mutations |
| `src/enrichment/` | Python + Playwright | Bounded Mercari browser enrichment on the VPS |
| `scripts/enrich_*.py` | Python | Supabase-backed enrichment entry points |

Mail ingestion is owned by `retailpulses/workers/packages/mail-integration`.
The production operator route is `https://ops.homesbliss.net/inquiry/`.

## Canonical documentation

- Current operational snapshot: `docs/00_CURRENT_STATE.md`
- Canonical to-be system architecture: `docs/01_ARCHITECTURE.md`
- Proposed Mercari API-first Phase: `docs/phases/mercari-inquiry-api-redesign/README.md`
- Architecture decision: `docs/adr/001-mercari-inquiry-api-first.md`
- Detailed design: `docs/proposals/mercari-inquiry-api-source-redesign.md`

## Database status

Supabase is the sole inquiry database. The historical Baserow pipeline,
adapters, migration tools, fallbacks, configuration, and deployment secrets
were retired after production reconciliation. Historical design and migration
reports may still mention Baserow; they are not operational instructions.

Rollback keeps Supabase authoritative: disable the affected workload kill
switch or roll back application code. Do not restore Baserow dual-write.

## Development

```bash
# Worker
cd apps/worker
npm ci
npm test
npm run typecheck

# Dashboard
cd ../dashboard
npm ci
npm test
npm run typecheck
npm run build

# VPS enrichment
cd ../..
python3 -m pytest \
  tests/test_enrichment.py \
  tests/test_enrichment_config.py \
  tests/test_runtime_log.py \
  tests/test_supabase_client.py
```

For VPS enrichment, copy `.env.example`, supply scoped Supabase credentials,
and keep `INQUIRY_ENRICHMENT_WRITES_ENABLED=false` until an approved run.

## Safety controls

- `INQUIRY_AUTOMATION_WRITES_ENABLED`
- `INQUIRY_DASHBOARD_MUTATIONS_ENABLED`
- `INQUIRY_ENRICHMENT_WRITES_ENABLED`
- `INQUIRY_EXTERNAL_NOTIFICATIONS_ENABLED`

See `docs/16_DATABASE_GOVERNANCE.md` and `docs/SYNC_JOB_INVENTORY.md` for the
current ownership and workload declarations.
