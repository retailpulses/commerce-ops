# Inquiry Listing Optimization: Main Image Agent Handoff

Status: text optimization MVP is implemented in PR branches; no deployment has been performed.

## Product boundary

Inquiry handling targets exactly one marketplace listing:

1. Select the inquiry's primary linked `product_variant_id`.
2. Match `product_platform_links` using that variant plus the inquiry platform and shop.
3. Require exactly one `platform_listings` row with an external marketplace listing ID.

Product-page inquiries are expected to resolve precisely. A missing or ambiguous mapping is an operator-visible error. Shop-page inquiries may have no product link until the customer confirms the product. Never fan out a change to the same product's listings in other shops. “Update to all shops” remains future roadmap.

## Text MVP being built

- Shows the exact platform, shop, marketplace listing ID, quality score, and score freshness.
- Generates a fact-preserving title and description proposal.
- Keeps both proposal fields editable by the operator.
- Supports `Publish Title`, `Publish Description`, and `Publish All` (all changed text fields only).
- Quality score warnings never hold an operator-confirmed publish.
- Technical controls remain blocking: authentication, exact listing identity, platform/shop match, content revision, idempotency, valid payload, and marketplace credentials.
- UI text is structured for Chrome auto-translation. Only stable identifiers use `translate="no"`.

## Current cross-repository interfaces

### Inquiry Portal BFF

Source repository: `retailpulses/inquiry-automation`; generated production copy: `retailpulses/ops-portal`.

- `GET /inquiry/api/inquiries/:id/listing-optimization`
  - Re-resolves the exact listing server-side.
  - Returns listing identity, current title/description, content revision, score/modules, and freshness.
- `POST /inquiry/api/inquiries/:id/listing-optimization-suggest`
  - Produces title/description JSON while forbidding invented product facts.
- `POST /inquiry/api/inquiries/:id/listing-optimization-publish`
  - Re-resolves the listing again and rejects stale revisions.
  - Browser cannot choose an arbitrary listing ID.

### Catalog owner

Repository: `retailpulses/RPAgentOS`.

- `POST /api/internal/catalog/listings/:id/operator-text-publishes`
- Operator confirmation bypasses score thresholds as a business gate.
- A transient claim is used only as a concurrency lock.
- Successful publication increments `content_revision`, records observed/published state, and marks the prior quality score stale.

### Marketplace writer

Repository: `retailpulses/CatalogSync`; the Mercari call runs through its fixed-IP relay.

- `POST /marketplace/mercari`
- Action: `listing-text-update`
- Accepts only exact `shopCode`, `listingId`, and selected `title`/`description` fields.
- Shop credentials are selected server-side (`SHOP1_API_TOKEN` through `SHOP4_API_TOKEN`).

## Main image feature constraints

The image feature should reuse the exact-listing resolution rule, operator authority model, revision check, and translation-safe UI conventions above. It should remain a separate generation and publishing flow because image creation, preview, asset storage, marketplace image ordering, and rollback are new concerns.

The main image agent should decide the image-specific design rather than extending the text payload implicitly. At minimum, preserve these invariants:

- Only the exact listing linked to the inquiry is eligible.
- Operator sees the current image and generated candidate before publishing.
- Operator confirmation is final; quality recommendations may warn but do not create a business hold.
- Authentication, exact identity, revision/concurrency, idempotency, supported image format/size, and marketplace response verification remain blocking.
- Do not update images in other shops.
- Do not couple image publishing to `Publish All`, which currently means text fields only.
- Keep all pages, dialogs, warnings, and comparison views safe for Chrome automatic translation.

## Coordination and likely touch points

To reduce merge conflicts, prefer new image-specific endpoints and components. Coordinate before changing these text-MVP files:

- `apps/dashboard/functions/_lib/listing-optimization.ts`
- `apps/dashboard/src/components/InquiryDetail/ListingOptimization.tsx`
- `src/api/internal-catalog-lifecycle.ts` in RPAgentOS
- `relay/server.mjs` in CatalogSync

The existing main-image tracking issue is `retailpulses/RPAgentOS#74`. This handoff intentionally does not prescribe generation model, prompt, storage, or marketplace image mutation details.
