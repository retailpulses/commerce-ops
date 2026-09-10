# Issue #174 — Manual Product Overrides

## Goal

Allow an authenticated Portal operator to set or clear three product-level
manual overrides from an order detail drawer:

- `manual_cost_price`
- `manual_presale_arrival_date`
- `presale_info_protect_until`

Effective-value calculation remains owned by the product-catalog domain.

## Governed Architecture

`product_catalog` is owned by RPagentOS. OrderMgmt therefore does not mutate
`product_variants` or `product_commercials` directly.

```text
Portal SPA
  -> authenticated OrderMgmt Portal API
  -> dedicated server-side owner-API bearer token
  -> RPagentOS PATCH /api/internal/catalog/sku/:itemCode/manual-fields
  -> validated product_catalog mutation + owner-side audit evidence
```

Product override values displayed by the drawer are also read from the owner
API. If the owner endpoint or its dedicated token is unavailable, the editor is
hidden and writes fail closed. Existing stock/margin enrichment is unchanged.

## Validation Contract

- At least one recognized field is required; unknown fields are rejected.
- `manual_cost_price` is `null` or a finite number greater than zero and no
  greater than 99,999,999. Empty UI input sends `null`; zero is not an alias for
  clearing.
- Dates are `null` or real calendar dates formatted `YYYY-MM-DD`.
- Item-code lookup is case-insensitive and must resolve exactly one variant.
- Exactly one commercial row must exist.
- The owner endpoint uses a dedicated `ORDERMGMT_CATALOG_API_TOKEN`; broader
  internal-catalog and CatalogSync tokens are not accepted.

## Deployment Gates

1. Merge and deploy the RPagentOS owner endpoint.
2. Register OrderMgmt capability, access path, and workload in
   `rp-governance-kit`.
3. Provision the same dedicated secret in RPagentOS Pages and OrderMgmt's
   server-side deployment store; never expose it to the SPA.
4. Merge this feature to OrderMgmt `main`.
5. Deploy only a commit reachable from `origin/main`.
6. Verify unauthenticated Portal rejection, owner-endpoint authentication, live
   bundle presence, and a read-only product-detail response. Do not mutate an
   arbitrary product as a smoke test.

## Rollback

Roll back the OrderMgmt Portal deployment to remove the editor and adapter. For
an immediate write kill switch, remove `ORDERMGMT_CATALOG_API_TOKEN` from the
owner API; requests then fail closed without changing catalog data.
