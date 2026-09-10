# Secrets and environment cutover

Status: Phase 1 gate. No production deployment workflow may be enabled from `commerce-ops` until this inventory is complete.

## Principle

Move repository-scoped configuration only. Keep runtime-scoped secrets attached to the existing runtime when runtime identity is unchanged.

| Location | Phase 1 treatment |
|---|---|
| GitHub repository Actions secrets | Re-seed required names in `commerce-ops`; never copy values into Git |
| GitHub Environments and environment secrets | Recreate deliberately, preserving production approval/gating semantics |
| GitHub repository variables | Recreate required values |
| GitHub organization secrets | Verify `commerce-ops` is allowed; do not duplicate unless necessary |
| Cloudflare Worker secrets | Leave on existing Worker identities |
| Cloudflare Pages secrets / bindings | Leave on existing Pages projects initially |
| VPS `.env` / systemd environment | Leave on existing hosts and protected paths |
| Supabase runtime principals | Preserve per-runtime/per-platform least-privilege principals |
| Marketplace/API credentials | Leave on their current governed runtime secret store |
| Webhook shared secrets | Leave unchanged while endpoint/runtime identity is unchanged |

## Known repository-scoped credential families

The exact secret values are intentionally not recorded here. Existing workflows show at least these families must be mapped before cutover:

- Cloudflare deployment credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
- VPS SSH credentials (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, and where used `VPS_PORT` / known-host material)
- Ops Portal proxy/integration credentials
- Catalog-owner integration tokens used by Orders/Inquiry
- platform-specific Supabase runtime credentials for Mercari, Rakuten and Amazon ticket runtimes
- rollback/deployer credentials used by governed runtime activation

## Cutover checklist

- [ ] Inventory every `${{ secrets.* }}` and `${{ vars.* }}` reference in the source workflows.
- [ ] Classify each item as repo-scoped, environment-scoped, org-scoped or runtime-scoped.
- [ ] Recreate GitHub Environments and approval rules before copying deployment workflows.
- [ ] Re-seed only required GitHub secret names using the authoritative existing value source.
- [ ] Verify org-level secret allow-lists include `commerce-ops` where applicable.
- [ ] Verify Cloudflare/VPS runtime secrets remain unchanged.
- [ ] Preserve separate Supabase runtime principals; do not introduce a broad monorepo service key.
- [ ] Perform a no-production-write workflow validation.
- [ ] Enable production deploy workflows only during Phase 2 parity cutover.

## Public repository constraint

Repository visibility does not make GitHub Actions secrets public, but workflow design must assume untrusted public source/PR input. Production-secret-bearing jobs must not run on untrusted fork PR code and must retain explicit environment/branch/manual gates.
