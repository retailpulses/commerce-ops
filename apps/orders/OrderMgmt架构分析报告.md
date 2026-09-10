# Historical architecture analysis — superseded

> **Status: HISTORICAL / NON-CANONICAL**  
> This report captured an earlier OrderMgmt architecture and is retained only as historical evidence. Its Worker-centric Portal model and Baserow-primary data model have been superseded.
>
> For current architecture use [`docs/01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md). For current operational state use [`docs/00_CURRENT_STATE.md`](docs/00_CURRENT_STATE.md). For declared production workloads use [`docs/SYNC_JOB_INVENTORY.md`](docs/SYNC_JOB_INVENTORY.md).
>
> Git history preserves the full original report if historical detail is required.

## Why this file is no longer current

The system evolved materially after the original analysis:

- Supabase became the canonical OrderMgmt business datastore; Baserow is legacy/compatibility.
- The primary Portal moved from the Cloudflare Worker to a React SPA + Hono API on the VPS.
- OrderMgmt expanded into a broader multi-platform order-operations system with Mercari and Rakuten workloads, customer messaging, review flows, reporting, webhook/compatibility paths, and multiple scheduling layers.
- The repository now distinguishes declared/deployed architecture from live-runtime verification.

Keeping the original long report in the working tree without a strong status marker caused architecture drift because agents could reasonably treat its detailed but stale description as current truth. The canonical architecture is now intentionally centralized in `docs/01_ARCHITECTURE.md`.