# Changelog
Business versions use CalVer tags: `vYYYY.M.D.N` (e.g. `v2026.4.10.3`).

## Unreleased
- Schedule `close_rakuten_orders` immediately after Rakuten tracking sync so persisted Giga tracking is submitted to RMS with strict progress-500 acknowledgement (Issue #208).
- Standardize Relay code, CORS, scripts, and operations documentation on the canonical `worker-order.homesbliss.net` hostname.

## v2026.4.10.4
- `@price-seeking helper` output groups items by seller (merged), with seller-key normalization and per-seller totals.

## v2026.4.10.3
- Expose `RELEASE_VERSION` in Worker `/health`.
- Worker `wrangler.toml` includes scheduled `reconcile_end_to_end` cron.
- Health snapshot counts actionable Giga sync gaps and separates invalid payload exceptions.
- Support targeting a single `order_id` for `push_orders_to_giga` via CLI/Worker admin run.
- Giga `orderFrom` mapping uses `Shop1..Shop4` short names.

## v2026.4.10.2
- Use `Shop1..Shop4` in Giga `orderFrom` mapping.
- Improve Giga sync health visibility.

## v2026.4.10.1
- Harden Mercari pull via relay and end-to-end reconcile.
- Fix production ingest pagination auth loss on Baserow `http -> https` next URL.
