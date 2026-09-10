# Secrets Checklist — rp-order-mgmt-reporting

The following secrets must be set via `wrangler secret put` for production.

| Secret Name | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL (`https://gqeyfhshxdiyhugvmbuk.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (bypasses RLS) |
| `WECOM_WEBHOOK_URL` | WeCom bot webhook URL |
| `RUN_SECRET` | Shared secret for manual POST /run/* endpoints |

## Commands

```bash
for secret in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY WECOM_WEBHOOK_URL RUN_SECRET; do
  echo "Enter $secret:" && read -s value && echo "$value" | wrangler secret put "$secret" --env production
done
```

## Verify

```bash
# Dry run — no WeCom push
curl -X POST https://rp-order-mgmt-reporting.retailpulses.workers.dev/run/sales-brief \
  -H "x-run-secret: $RUN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true}'

# Live run — pushes to WeCom
curl -X POST https://rp-order-mgmt-reporting.retailpulses.workers.dev/run/sales-brief \
  -H "x-run-secret: $RUN_SECRET"
```
