# Frontend Standards

## Default Frontend Stack

For Retailpulses internal admin applications, the default frontend stack is:

**React + Vite + TypeScript**

This is the standard stack for modern internal admin UI, including:

- RP AgentOS modules
- Ticketing
- Listing intelligence
- Operations portals
- Marketplace operation tools
- Internal admin dashboards

Do not introduce a different frontend framework or build stack unless the Issue clearly justifies the exception and the PR documents the tradeoff.

## Frontend Direction

- Internal admin frontend should converge toward a shared modern frontend where practical.
- Avoid isolated mini frontends unless justified.
- New frontend work should converge toward React + Vite + TypeScript.
- Legacy Worker-rendered pages or plain HTML admin UIs may remain temporarily, but should not be expanded unless explicitly justified.
- Cloudflare Pages / Workers may be used for hosting or API/runtime infrastructure, but frontend application architecture should not be designed as Cloudflare-specific UI logic.
- Frontend changes should consider operator workflow, speed, clarity, and error prevention.
- Frontend should support internal operations first, not visual decoration first.

## Supabase and Frontend Safety

- Frontend must not use privileged Supabase service credentials.
- Frontend may only use public-safe / anon keys with RLS-aware access.
- Service-role operations must go through backend/service boundaries.

## Autofill Standard

- Browser autofill must be disabled for non-login forms.
- Login forms may use normal autocomplete.
- Search boxes, SKU inputs, filters, customer lookup, order lookup, ticket fields, marketplace operation forms, and admin forms should set `autoComplete="off"` or an appropriate non-autofill value.
- Do not allow browser autofill to pollute operational search/filter inputs.
- Exceptions must be documented in the Issue or PR.
