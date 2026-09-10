# Ops Portal — Retailpulses Operations Dashboard

Internal operations metrics dashboard with a separate browsable registry of active repos, agent skills, and capability domains.

## Quick Start

```bash
npm install
npm run dev      # local dev at http://localhost:5173
npm run build    # static build to build/
npm run preview  # preview the built output locally
```

## Deploy

### Cloudflare Pages (auto)

Push to `main` branch. Cloudflare Pages auto-deploys from the GitHub repo.

Build config:

- Build command: `npm run build`
- Output directory: `build`

### Manual deploy

```bash
npx wrangler pages deploy build/ --project-name ops-portal
```

## Project Structure

```
ops-portal/
├── src/
│   ├── data/          # Static JSON data files (edit these to update content)
│   │   ├── repos.json
│   │   ├── skills.json
│   │   ├── domains.json
│   │   └── meta.json
│   ├── lib/
│   │   ├── components/ # Reusable Svelte components
│   │   └── utils/      # filter.js, search.js, data.js
│   └── routes/         # SvelteKit file-based routes
│       ├── +page.svelte           # Operational metrics
│       ├── registry/              # Capability Registry dashboard
│       ├── repos/                 # Repo list + detail
│       ├── skills/                # Skill list + detail
│       ├── domains/               # Domain list + detail
│       └── about/                 # About / data provenance
├── static/
│   ├── _redirects     # SPA fallback for Cloudflare Pages
│   └── favicon.svg
└── package.json
```

## How to Update Data

1. Edit the relevant JSON file in `src/data/`.
2. Run `npm run build` to verify changes compile.
3. Commit and push to `main`.

For bulk updates, regenerate the seed at `Deliverables/2026-06-12_ops_portal_inventory_plan/repo-skill-seed.json` and port changes to `src/data/`.

## Routes

| Route                 | Page                                                            |
| --------------------- | --------------------------------------------------------------- |
| `/`                   | Operational metrics dashboard                                   |
| `/registry`           | Capability Registry summary and top domains                     |
| `/urls`               | Manual URL collection for operator-facing frontend entry points |
| `/repos`              | Filterable repo list                                            |
| `/repos/[repoId]`     | Repo detail with linked skills                                  |
| `/skills`             | Filterable skill list                                           |
| `/skills/[skillId]`   | Skill detail with source trace and invoke command               |
| `/domains`            | Domain overview with counts                                     |
| `/domains/[domainId]` | Domain detail with linked repos and skills                      |
| `/about`              | Data provenance and maintenance guide                           |
| `/order/`             | Canonical Order application routed by the ConoHa gateway        |

Inquiry, Tickets, and Order are owned and released by their application
repositories. The ConoHa gateway routes their canonical paths without copying
application builds or rewriting HTML. This Pages project serves metrics at `/`
and the capability registry at `/registry`. Application rollback is performed
independently by each path owner without redeploying the Portal frontend.

## Production Acceptance Entrypoints

Operator-facing acceptance uses the routed Ops Portal URL:

| Workspace | Acceptance URL                        |
| --------- | ------------------------------------- |
| Inquiry   | `https://ops.homesbliss.net/inquiry/` |
| Tickets   | `https://ops.homesbliss.net/tickets/` |
| Order     | `https://ops.homesbliss.net/order/`   |

Browser-specific checks, including Chrome page translation, must use these
routed URLs rather than standalone Pages domains or source application URLs.

## Tech Stack

- **Framework:** SvelteKit 2 with adapter-static
- **Styling:** Vanilla CSS with custom properties
- **Data:** Static JSON files in `src/data/`
- **Hosting:** Cloudflare Pages
- **Language:** JavaScript (ES2022)

## Non-Goals (MVP)

- No API endpoints — everything is build-time static
- No CMS — data changes are git-based
- No analytics or telemetry
- No fuzzy search — uses simple substring matching
- No unit tests — visual smoke-test on deploy
