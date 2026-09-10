# Data Access and Secrets Standards

## Database Ownership

- **Supabase** is the master business database.
- **Baserow** is legacy and should be gradually discontinued.
- Do not create duplicate canonical tables if existing Supabase tables should be reused.
- Schema changes require migrations and documentation updates.

## Access Control

- Frontend may only use public-safe / anon keys with RLS-aware access.
- Service role keys must never be exposed to frontend code.
- Supabase access should follow least privilege.
- Direct database access from scripts must be justified and documented.

## Secrets Management

- Secrets must not be committed.
- Secrets should be stored in GitHub Actions secrets, Cloudflare secrets, local ignored `.env` files, or approved secret storage.
- Agents must not invent secrets.
- Agents must check existing credential documentation or ask for the correct secret source.

## Database Changes

Database changes must explain:

- Data ownership
- Table reuse
- Migration impact
- Rollback risk

## Migration Standards

Migrations must be repeatable and auditable.
