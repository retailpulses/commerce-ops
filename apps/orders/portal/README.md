# OrderMgmt React Portal

## Production deployment

The production SPA is served by nginx on the VPS. `/api/` is proxied to the
Portal API on port `8790`.

For the template-store cutover, use this order:

1. Deploy the Portal API commit that includes the Supabase template fallback.
2. Preview the legacy Worker KV to Supabase migration:

   ```bash
   PORTAL_ACCESS_TOKEN=... npm run migrate:portal-templates -- --verbose
   ```

3. Apply only after the dry-run has no conflicts:

   ```bash
   PORTAL_ACCESS_TOKEN=... npm run migrate:portal-templates -- --dry-run=false --confirm
   ```

4. Build and publish `portal/dist/`, then verify the template selector and
   create/edit/delete operations in production.

The migration reads templates through authenticated Portal API endpoints. It
does not expose the Supabase service-role key to the browser or migration
operator. Exact title/body matches are skipped; same-title body differences
stop the apply and require manual resolution.

## Local development

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
