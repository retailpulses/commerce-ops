# Multi-Platform Sales Brief — VPS Migration Plan

Issue: [#178](https://github.com/retailpulses/OrderMgmt/issues/178)

> **Historical migration plan — do not execute the commands below.** The
> canonical deployment and ownership procedure is now `deploy/README.md` plus
> `docs/plans/order-pipeline-first-tranche-rollout.md`. In particular, do not
> deploy from a mutable checkout, store secrets under `/opt/OrderMgmt`, run the
> service as root, or enable a timer without governed ownership/readback.

## Summary

Replace the `mercari-reporting` CF Worker with a VPS systemd timer + Node script.
The new report covers all 3 platforms (Mercari, Rakuten, Amazon) with a 3-section format.

## Why VPS?

| Factor | CF Worker | VPS systemd timer |
|--------|-----------|-------------------|
| CPU limit | 30s/15m CPU time | None |
| Deploy | `wrangler deploy` (needs API token) | `git pull` + `systemctl restart` |
| Debugging | `wrangler tail` | `journalctl -u` |
| Secrets | `wrangler secret put` | `.env` file (already on VPS) |
| Fit | Edge compute for simple cron job | ✅ Natural fit |
| Direction | CF→VPS migration target | ✅ VPS-first |

This workload is: `cron → query Supabase → aggregate → format markdown → POST WeCom`. Zero edge compute benefit.

## Files

| File | Purpose |
|------|---------|
| `scripts/sales-brief-report.mjs` | Main script: query, classify, format, push |
| `scripts/sales-brief.env.example` | Env var template |
| `deploy/systemd/order-mgmt-sales-brief.service` | systemd service unit |
| `deploy/systemd/order-mgmt-sales-brief.timer` | systemd timer unit |
| `docs/design/new-sales-brief-design.md` | Design doc (cherry-picked from branch) |

## Report Format

3 sections, each with Today + Month To Date:

### Total
Sum across all platforms — orders, revenue, AOV, waiting payment.

### By Platform
Mercari / Rakuten / Amazon — orders + revenue each.

### By Sales Group
Mercari Shop 4 / Other Mercari (Shops 1-3) / Rakuten / Amazon — orders + revenue each.

### Platform Classification

| Platform | Paid/Completed | Waiting Payment | Excluded |
|----------|---------------|-----------------|----------|
| Mercari | Not CANCELED, not WAITING_FOR_PAYMENT | WAITING_FOR_PAYMENT | CANCELED |
| Rakuten | CONFIRMED, RMS_CONFIRMED | PENDING_CONFIRMATION | CANCELED |
| Amazon | Not CANCELED, not PENDING | PENDING | CANCELED |

## Script Design

```
runSalesBrief({ dryRun }) → exit code
  ├─ fetchOrders(monthStart, nextMonthStart) → rows[]
  │   └─ GET Supabase REST API, sales_channel in (mercari,rakuten,amazon)
  ├─ classifyOrder(row) → { platform, group, isPaid, isWaiting, revenue }
  ├─ buildSummary(rows) → { total, byPlatform, byGroup }
  ├─ formatBrief(summary) → markdown string
  └─ sendWeCom(webhookUrl, markdown) → { ok }
```

### CLI flags

```
node scripts/sales-brief-report.mjs --dry-run     # format + print, no WeCom push
node scripts/sales-brief-report.mjs               # full run: query + format + push
```

## Schedule

| Cron (UTC) | JST |
|------------|-----|
| `0 23,2,5,8,11,13 * * *` | 08:00, 11:00, 14:00, 17:00, 20:00, 22:00 |

Same schedule as the old Worker.

## Deployment Steps

### 1. Commit and push to main
```
git checkout feat/issue-178-multi-platform-sales-brief
git push origin feat/issue-178-multi-platform-sales-brief
# Create PR, merge to main
```

### 2. Deploy to VPS

```bash
# On VPS
cd /opt/OrderMgmt
git pull origin main

# Create env file
cp scripts/sales-brief.env.example scripts/sales-brief.env
# Edit with real SUPABASE_SERVICE_ROLE_KEY and WECOM_WEBHOOK_URL

# Install systemd units
sudo cp deploy/systemd/order-mgmt-sales-brief.service /etc/systemd/system/
sudo cp deploy/systemd/order-mgmt-sales-brief.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now order-mgmt-sales-brief.timer
```

### 3. Test manually
```bash
# Dry run (no WeCom push)
node scripts/sales-brief-report.mjs --dry-run

# Live test (pushes to WeCom)
node scripts/sales-brief-report.mjs
```

### 4. Retire old CF Worker
```bash
cd workers/packages/rp-mercari-reporting
npx wrangler delete mercari-reporting
# Remove secrets from Cloudflare dashboard
# Delete branch feat/mercari-reporting-supabase
```

## Rollback

If the VPS script fails:
1. `sudo systemctl stop order-mgmt-sales-brief.timer`
2. Re-deploy old Worker with cron triggers restored
3. Investigate, fix, retry

## Reference

- Issue: [#178](https://github.com/retailpulses/OrderMgmt/issues/178)
- Old Worker: `workers/packages/rp-mercari-reporting/` (to be deprecated)
- Branch with CF Worker version: `feat/mercari-reporting-supabase` (to be deleted)
- Supabase schema: `sales_orders` table
- WeCom webhook: `WECOM_WEBHOOK_URL` in VPS `.env`
