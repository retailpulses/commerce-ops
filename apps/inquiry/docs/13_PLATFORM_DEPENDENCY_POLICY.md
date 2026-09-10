# Platform Dependency Policy

## Supabase

Supabase is the source of truth for business data.

## Cloudflare

Cloudflare is preferred infrastructure but should not become unavoidable business logic lock-in.

- Workers, Pages, R2, KV, Queues, and Cron are allowed when justified.
- Domain logic should not be buried inside Cloudflare-specific handlers.
- Infrastructure-specific code should be isolated behind adapters/services.
- New Cloudflare-specific dependency should document why it is needed and what the fallback/migration path would be.

## Baserow

Baserow is legacy and should not be expanded unless explicitly approved. New Baserow dependencies should be flagged as governance risk.

## Marketplace Integrations

Marketplace integrations should be adapters, not core domain logic.

## Local Models

Local model workflows should be portable where practical.

## AI Services

OpenAI usage should be reserved for advanced reasoning, architecture review, and high-value decision support.
