# rp-order-mgmt VPS Relay

This service runs on the ConoHa VPS and is the only allowed Mercari execution path.

It exposes:

- `GET /health`
  - prints the IPv4 egress address via `curl -4 https://ifconfig.me`
- `POST /admin/ingest`
  - runs the Mercari sales-order ingest script on the VPS
- `POST /admin/close-shipped-orders`
  - canonical Mercari close endpoint; runs the bounded, operation-ledger-aware shipping close batch on the VPS

## Run

```sh
cd /Users/user/Documents/Retailpulses/20_REPOS/order-mgmt/relay
node server.mjs
```

## Required env

- `MERCARI_TOKENS_PATH`
- `MERCARI_BASEROW_ENV_PATH`
- `MERCARI_INGEST_SCRIPT_PATH` if the default ingest script path changes
- `MERCARI_SHIPPING_CLOSE_BATCH_SCRIPT_PATH` if the default close-batch script path changes
- `MERCARI_RELAY_SECRET` accepted via `x-relay-secret` for existing OrderMgmt/Mercari routes
- `RAKUTEN_RMESSE_INGESTION_RELAY_SECRET` accepted only by Rakuten inquiry list/detail/attachment routes
- `RAKUTEN_RMESSE_SEND_RELAY_SECRET` accepted only by the Rakuten inquiry reply route
- `PORT`
- `HOST`

## Notes

- The relay itself must run on the VPS IPv4 path `160.251.141.110`.
- The relay is responsible for every Mercari API call; Cloudflare Workers only call this relay.
- Rakuten inquiry ingestion and reply credentials are separate trust boundaries. Neither scoped
  secret falls back to `MERCARI_RELAY_SECRET`; a missing scoped secret returns unavailable.
