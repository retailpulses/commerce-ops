# Engineering Principles

Retailpulses engineering follows these principles to preserve system context while moving fast with agents.

## Issue-First Development

All mergeable engineering work must start from a compliant GitHub Issue. Exploration and local investigation can happen before an Issue, but mergeable coding cannot start without a compliant Issue.

MVP is allowed, but system context must be preserved. Every change should explain what it does, why it matters, and what impact it has.

## PR Requirements

Every PR must explain:

- **User impact** — who is affected and how
- **Data impact** — does the data model change
- **Architecture impact** — does the system structure change
- **Documentation impact** — what docs must be updated

## Business Logic Separation

Core business logic should be reusable and not marketplace-specific. Marketplace-specific behavior belongs in adapters.

## Auditability

Agent-created changes must be auditable. Humans review:

- System impact
- Business logic
- Data naming
- Workflow assumptions

## Avoid Duplication

Avoid duplicated functionality and duplicate canonical entities. Prefer shared services, shared workflows, and shared data models over isolated agents.

## Automation Boundaries

AI should automate routine operational work, while humans supervise exceptions and strategic decisions.
