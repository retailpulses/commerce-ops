# VPS Relay Setup

## Current state (pre-migration)

- Relay runs from `/opt/workers/packages/order-mgmt/relay/` (monorepo path)
- Systemd unit: `rp-order-mgmt-relay.service`
- WorkingDirectory: `/opt/workers/packages/order-mgmt/relay`
- ExecStart: `/usr/bin/node /opt/workers/packages/order-mgmt/relay/server.mjs`

## One-time migration setup

When ready to switch to the standalone repo:

### Step 1: Clone standalone repo
```bash
sudo mkdir -p /opt/OrderMgmt
sudo chown -R <deploy-user>:<deploy-user> /opt/OrderMgmt
cd /opt
git clone git@github.com:retailpulses/OrderMgmt.git OrderMgmt
cd /opt/OrderMgmt
npm ci --omit=dev
```

### Step 2: Ensure env files are in place

The systemd unit should have environment variables set via `Environment=` or `EnvironmentFile=`. These do NOT need to change — they're attached to the service, not the working directory.

However, if the relay scripts reference paths relative to the old monorepo structure (e.g., `../scripts/`), verify they resolve correctly in the new path. The `relay/server.mjs` references:
- `../scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs`
- `../scripts/close_all_shipped_orders.mjs`
- `../scripts/mercari_shop_product_query.mjs`
- `../scripts/mercari_shop_product_update.mjs`
- `../scripts/list_shop4_products.mjs`

These exist in the new repo under `scripts/` at the same relative path from `relay/`.

### Step 3: Update systemd unit
```bash
sudo systemctl stop rp-order-mgmt-relay.service

# Update WorkingDirectory
sudo sed -i 's|WorkingDirectory=.*|WorkingDirectory=/opt/OrderMgmt|' \
  /etc/systemd/system/rp-order-mgmt-relay.service

# Update ExecStart
sudo sed -i 's|ExecStart=.*|ExecStart=/usr/bin/node relay/server.mjs|' \
  /etc/systemd/system/rp-order-mgmt-relay.service

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl start rp-order-mgmt-relay.service

# Verify
systemctl status rp-order-mgmt-relay.service
curl -f http://127.0.0.1:8787/health
```

### Step 4: Validate
```bash
# Check service is active
systemctl is-active rp-order-mgmt-relay.service

# Check health
curl http://127.0.0.1:8787/health | jq

# Check endpoints
curl http://127.0.0.1:8787/ | jq '.endpoints'
```

## Expected systemd unit after migration

```ini
[Unit]
Description=Order Management VPS Relay
After=network.target

[Service]
Type=simple
User=<deploy-user>
WorkingDirectory=/opt/OrderMgmt
ExecStart=/usr/bin/node relay/server.mjs
Restart=always
RestartSec=5

# Environment (keep existing — do not change these)
Environment=PORT=8787
Environment=HOST=0.0.0.0
Environment=MERCARI_RELAY_SECRET=...
Environment=MERCARI_TOKENS_PATH=...
Environment=BASEROW_DATABASE_TOKEN=...
Environment=MERCARI_BASEROW_ENV_PATH=...
Environment=GIGA_CLIENT_ID=...
Environment=GIGA_CLIENT_SECRET=...
Environment=GIGA_API_BASE_URL=https://openapi.gigab2b.com

[Install]
WantedBy=multi-user.target
```

## Required User-Agent header (enforced 2026-06-22)

Mercari now requires a `User-Agent` header on all API requests. The relay reads these from env vars with fallback defaults:

| Env Var | Default | Notes |
|---|---|---|
| `MERCARI_API_CLIENT_NAME` | `Inhouse_ERP` | Assigned by Mercari at contract time |
| `MERCARI_API_CLIENT_VERSION` | `0.0.1` | Your application version string |

If your Mercari contract assigned a specific client name, set `MERCARI_API_CLIENT_NAME` in the systemd unit. Otherwise the defaults work.

## Port

- Relay listens on port **8787**
- Cloudflare Zero Trust tunnel `rp-order-mgmt-relay` routes traffic to `localhost:8787`

## Rollback

If the new path doesn't work, restore the old systemd unit:

```bash
sudo systemctl stop rp-order-mgmt-relay.service
sudo sed -i 's|WorkingDirectory=.*|WorkingDirectory=/opt/workers/packages/order-mgmt/relay|' \
  /etc/systemd/system/rp-order-mgmt-relay.service
sudo sed -i 's|ExecStart=.*|ExecStart=/usr/bin/node /opt/workers/packages/order-mgmt/relay/server.mjs|' \
  /etc/systemd/system/rp-order-mgmt-relay.service
sudo systemctl daemon-reload
sudo systemctl start rp-order-mgmt-relay.service
curl -f http://127.0.0.1:8787/health
```
