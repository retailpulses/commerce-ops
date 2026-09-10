# Issue #158 -- Deployment Runbook

## Pre-deployment checklist

- [ ] All tests pass locally (`npm test`)
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] Migration `20260716120000_add_ingest_fields.sql` reviewed and approved
- [ ] PR reviewed and approved

## Deployment order

1. Apply Supabase migration (hosted DB) -- requires governance approval
2. Deploy Worker: `gh workflow run deploy-worker.yml -f environment=production`
3. Deploy Relay: `gh workflow run deploy-relay.yml -f environment=production`
4. Deploy Portal API: `gh workflow run deploy-api.yml -f environment=production`

## Canary verification — bridge-disabled direct ingest

The goal is to prove bridge-independent operation: the new ingest writes directly to
Supabase without the Baserow bridge, and the next scheduled ingest also succeeds.

### Step-by-step

1. **Disable the bridge** on the relay:
   ```bash
   # On the VPS: edit the relay systemd environment
   sudo systemctl edit rp-order-mgmt-relay
   # Set:
   #   Environment=SUPABASE_INGEST_BRIDGE_ENABLED=false
   sudo systemctl restart rp-order-mgmt-relay
   ```

2. **Verify bridge is disabled**:
   ```bash
   curl -H "x-relay-secret: $MERCARI_RELAY_SECRET" \
     https://worker-order.homesbliss.net/health
   # Confirm health response; bridge flag is not exposed — trust the env var
   ```

3. **Run one controlled direct ingest** (all shops, all matching active orders):
   The Mercari ingest does not implement a row-limit option. This canary intentionally
   processes the complete matching active-order set for the four selected shops.
   ```bash
   curl -X POST -H "x-relay-secret: $MERCARI_RELAY_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"shops":["Shop1","Shop2","Shop3","Shop4"],"dryRun":false}' \
     https://worker-order.homesbliss.net/admin/ingest
   ```

4. **Verify controlled ingest**:
   - Query Supabase for new/updated Mercari orders written in this run
   - Spot-check a known order from each shop
   - Confirm `payment_date`, `order_status`, and billing fields are populated
   - Confirm no bridge ran (check relay logs — no `migrate-to-supabase.mjs` PID logged)

5. **Verify the next scheduled :01 ingest**:
   - Wait for the hourly cron trigger
   - Confirm the Worker health endpoint still returns 200
   - Confirm orders written by the scheduled ingest appear in Supabase
   - Check portal for correct order statuses
   - Confirm bridge still did not run

6. **Keep rollback artifacts**:
   - Do NOT delete the previous relay revision
   - Do NOT delete Baserow credentials or secrets
   - The bridge script (`migrate-to-supabase.mjs`) remains on disk

### Success criteria

- [ ] Controlled direct ingest writes to Supabase without bridge
- [ ] Scheduled hourly ingest writes to Supabase without bridge
- [ ] Known order from each shop verified in Supabase
- [ ] Portal shows correct statuses for orders touched by direct ingest
- [ ] Previous revision and Baserow credentials available for rollback

## Rollback

The new ingest fails closed unless `DATABASE_BACKEND=supabase` — it cannot write to Baserow.
To roll back:

1. Deploy the previous relay revision (ingest writes to Baserow, bridge copies to Supabase)
2. Ensure `SUPABASE_INGEST_BRIDGE_ENABLED=true` on relay
3. The old pipeline (ingest → Baserow → bridge → Supabase) resumes on next hourly cycle
4. To bring Supabase current after rollback: run a bounded reconciliation from Baserow using
   a diff/snapshot/repair process (NOT a blind full-table `--overwrite-existing-sales`)

Do NOT run a blind `--overwrite-existing-sales` sync — it is a destructive full-table overwrite
that can mask data integrity issues.

## Cleanup (after 2+ successful cycles)

- Remove bridge from relay/server.mjs
- Delete `BASEROW_DATABASE_TOKEN` wrangler secret
- Remove Baserow vars from wrangler.toml
