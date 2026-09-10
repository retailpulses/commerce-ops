# Open Source Refactor Research for Ticket Handling

## Document Control

- Version: 0.1
- Date: 2026-06-14
- Author: Codex
- Status: Initial research memo

### Change Log

- 2026-06-14 v0.1: First pass covering current architecture diagnosis, open-source candidate review, license fit, and recommended refactor path.

## 1. Job-Specific Definition of Done

This research is done when:

1. The current codebase shape is summarized from the live repository.
2. Relevant open-source projects are evaluated against this product direction:
   - internal operations tool for e-commerce代运营
   - client-facing SaaS
   - custom deployments for third-party merchants
3. Commercialization and license risk are called out clearly.
4. A practical recommendation is given:
   - what to borrow
   - what not to rewrite around
   - what phased refactor path is realistic for this repository

## 2. Current Codebase Snapshot

### 2.1 What this repository is today

The current system is not a generic commerce or customer support platform. It is a focused Mercari ticket operations system with:

- Cloudflare Worker runtime
- inline HTML/CSS/JS frontend inside the Worker
- Baserow as the operational data system
- Mercari GraphQL integration through a proxy
- AI-assisted classification / reply generation
- scheduled cron processing and a manual workspace UI

Key files:

- `web/worker/index.ts`
- `web/worker/src/handler.ts`
- `web/worker/src/handlers/tickets.ts`
- `web/worker/src/clients/baserow.ts`
- `docs/canonical_message_first_architecture.md`

### 2.2 Strengths

- Fast to ship
- Close to the business workflow
- Low infrastructure overhead
- Strong operational specificity for Mercari ticket handling

### 2.3 Structural limits if this becomes a product

If this grows into a multi-client platform or an external SaaS, the current structure will become a bottleneck:

- frontend, API routing, auth, and business orchestration are tightly packed together
- Baserow is acting as both business database and workflow state engine
- platform logic is Mercari-specific rather than connector-based
- tenant isolation is not a first-class concept
- role/permission boundaries are minimal
- auditability, billing boundaries, and plugin boundaries are not yet productized

## 3. What Kind of Open Source You Should Borrow

There are two very different reuse targets:

### 3.1 Customer support / ticketing platforms

Use these when you want:

- mature inbox / ticket UI
- agent collaboration
- assignment, notes, macros, SLAs, reporting
- omnichannel support patterns

Do **not** use them as your core commerce operations brain unless they can cleanly host your Mercari-specific workflow and data model.

### 3.2 Commerce / operations platforms

Use these when you want:

- customers, orders, products, channels, inventory, payments
- admin framework
- extensibility and plugin model
- future B2B / SaaS product foundation

Do **not** expect these to replace specialized marketplace ticket workflow out of the box.

## 4. Open-Source Candidates

### 4.1 Best ticketing candidates

#### Chatwoot

Why it is interesting:

- large and active project
- self-hosted support platform
- strong inbox / agent workflow base
- MIT license is commercially friendly

Fit for this repo:

- good if you want to rebuild the **agent workspace** on a proven support UI foundation
- not a direct fit for Mercari-native ops logic; you would still need a custom connector and custom business workflow layer

Best use:

- borrow product ideas and data model patterns now
- consider integration or partial adoption if the future product becomes a broader support desk, not just a Mercari workflow tool

#### Zammad

Why it is interesting:

- mature helpdesk product
- strong ticketing / admin patterns

Fit for this repo:

- technically capable, but less attractive for a commercial SaaS pivot because of AGPL obligations

Best use:

- study architecture and workflow concepts
- avoid making it the center of a closed or differentiated SaaS offering unless you intentionally want AGPL exposure

#### FreeScout

Why it is interesting:

- simpler helpdesk baseline
- lightweight shared mailbox style

Fit for this repo:

- useful inspiration if you want something lean
- weak match for a marketplace-operations-heavy product

Best use:

- UI / workflow reference only

#### Frappe Helpdesk

Why it is interesting:

- modern helpdesk with a broader operational ecosystem behind it

Fit for this repo:

- stronger “operations suite” feel than lightweight helpdesks
- still AGPL, so commercialization posture needs care

Best use:

- reference for ticket lifecycle, knowledge workflows, and structured ops screens

### 4.2 Best commerce / platform candidates

#### Medusa

Why it is interesting:

- MIT license
- TypeScript / Node ecosystem
- positioned as extensible commerce building blocks rather than a rigid store product
- strongest fit with a custom-logic-heavy future

Fit for this repo:

- very strong candidate if you want to evolve from a single workflow app into a broader e-commerce operations platform
- especially suitable if future scope may include merchant admin, order workflows, product ops, channel extensions, and customer-specific deployments

Best use:

- use as a medium-term platform foundation
- keep your ticket automation as a domain module or adjacent service

#### Saleor

Why it is interesting:

- mature headless commerce core
- strong GraphQL-first architecture
- permissive BSD-3-Clause license for the core

Fit for this repo:

- attractive if you want an API-first enterprise commerce layer
- less natural than Medusa for a Worker-native incremental migration, but very credible for a larger composable commerce architecture

Best use:

- strong option for a serious multi-channel commerce platform
- not the best first refactor target for this repository specifically

#### Vendure

Why it is interesting:

- TypeScript / NestJS / GraphQL stack
- solid plugin-oriented commerce architecture

Fit for this repo:

- technically attractive
- license is GPLv3 for core, which makes it much less comfortable for commercialization than MIT/BSD options

Best use:

- architecture study only unless licensing is deliberately accepted

#### Bagisto

Why it is interesting:

- MIT license
- mature open-source e-commerce ecosystem

Fit for this repo:

- better fit if you want a Laravel-centered commerce suite
- weaker fit with your current TypeScript / Worker direction

Best use:

- only if you are willing to shift stack direction significantly

## 5. Commercialization / License Reality

### 5.1 Low-friction licenses for your goal

Best for future SaaS or custom merchant deployments:

- MIT
- BSD-3-Clause

These are the safest default direction if you want to:

- sell hosted SaaS
- customize for merchants
- keep proprietary extensions closed
- avoid future source-release pressure on your differentiated layer

### 5.2 High-caution licenses for your goal

Need careful legal/product choice:

- AGPL-3.0
- GPLv3

Why:

- AGPL is specifically designed so that if you modify the program and let users interact with it over a network, they must be able to get the corresponding source code of the modified version.
- GPLv3 is also copyleft, though the network-trigger issue is especially central to AGPL.

Practical product implication for your case:

- If your future SaaS differentiator sits inside an AGPL core that you modify, you may be forced into source-sharing obligations you do not want.
- For a services business this may be acceptable.
- For a product company building a differentiated SaaS moat, this is usually a strategic constraint.

This is a product-strategy warning, not legal advice. A lawyer should review any final commercialization plan.

## 6. Recommendation

## 6.1 Short answer

Yes, you absolutely should borrow from open source, but **not** by replacing this codebase wholesale with a helpdesk product.

The best path is:

1. **Borrow architecture and product patterns from Chatwoot**
2. **Borrow platform thinking from Medusa**
3. **Avoid centering the future product on AGPL/GPL helpdesk or commerce cores**
4. **Refactor this repo into domain modules first before any platform migration**

## 6.2 What I would not do

I would not:

- rewrite this whole system on top of Zammad / FreeScout / Frappe Helpdesk
- force this into a generic CRM/helpdesk shape too early
- make Baserow the long-term product database for a commercial SaaS
- keep the inline frontend and business orchestration bundled in one Worker forever

## 6.3 What I would do

### Phase 1: productize the current codebase without changing the product core

Refactor the current Worker into explicit modules:

- `connectors/mercari`
- `domains/tickets`
- `domains/replies`
- `domains/prompts`
- `domains/reports`
- `infra/auth`
- `infra/storage`

Also separate:

- API layer
- frontend layer
- scheduled job layer

Goal:

- make the current product logic portable before adopting any external platform

### Phase 2: replace Baserow as the product source of truth

Move toward a proper application database for:

- tenants
- users
- roles
- tickets
- message history
- prompts
- automation rules
- audit logs

Baserow can remain:

- an operator-facing back office
- a migration bridge
- an internal admin tool

But it should not remain the permanent core for a SaaS-grade multi-tenant product.

### Phase 3: decide product direction

#### If the future is mainly support/ticket SaaS

Best path:

- evaluate Chatwoot integration or selective adoption
- keep your marketplace-specific automation as a separate domain service

#### If the future is a broader e-commerce operations platform

Best path:

- use Medusa as the longer-term platform anchor
- keep this repository’s ticketing brain as a custom operational module

#### If the future is mainly custom deployments for clients

Best path:

- keep your own codebase as the core IP
- borrow open-source patterns and specific components
- avoid deep dependence on strong copyleft platforms unless the client contract model makes that acceptable

## 7. Best-Fit Decision Matrix

| Candidate | Type | License | Commercial SaaS Fit | Fit for Current Repo | Recommendation |
|---|---|---|---|---|---|
| Chatwoot | Support platform | MIT | High | Medium | Best ticketing reference; possible future integration |
| Zammad | Support platform | AGPLv3 | Medium-Low | Medium | Study only unless AGPL is acceptable |
| FreeScout | Support platform | AGPL-3.0 | Medium-Low | Low-Medium | Lightweight reference only |
| Frappe Helpdesk | Support platform | AGPL-3.0 | Medium-Low | Medium | Good ops reference, license caution |
| Medusa | Commerce platform | MIT | High | High | Strongest strategic platform candidate |
| Saleor | Commerce platform | BSD-3-Clause | High | Medium | Strong platform, but bigger migration leap |
| Vendure | Commerce platform | GPLv3 | Medium-Low | Medium-High | Architecture reference; license caution |
| Bagisto | Commerce platform | MIT | High | Low-Medium | Only if shifting to Laravel/PHP |

## 8. Final Position

My recommendation is:

- **Do not replace this codebase with a generic open-source helpdesk**
- **Do refactor this codebase so its domain logic can survive platform changes**
- **If you want a commercializable future base, prioritize MIT/BSD ecosystems**
- **The two most relevant projects to study seriously are Chatwoot and Medusa**

If we continue from here, the next best step is to turn this research into a concrete refactor blueprint for this repository:

1. current-to-target architecture
2. module split
3. database migration direction
4. multi-tenant readiness checklist
5. open-source adoption boundaries

## 9. Source Links

- Chatwoot: https://github.com/chatwoot/chatwoot
- Chatwoot self-hosted docs: https://developers.chatwoot.com/self-hosted
- Zammad: https://github.com/zammad/zammad
- FreeScout: https://github.com/freescout-help-desk/freescout
- Frappe Helpdesk: https://github.com/frappe/helpdesk
- Medusa: https://github.com/medusajs/medusa
- Saleor: https://github.com/saleor/saleor
- Vendure: https://github.com/vendurehq/vendure
- Bagisto: https://github.com/bagisto/bagisto
- GNU AGPL FAQ: https://www.gnu.org/licenses/gpl-faq.html
- Why the GNU Affero GPL: https://www.gnu.org/licenses/why-affero-gpl.html
