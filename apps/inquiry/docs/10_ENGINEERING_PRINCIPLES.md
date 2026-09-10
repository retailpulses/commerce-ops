# Engineering Principles

Retailpulses engineering follows these principles to preserve system context while moving fast with agents.

## Issue-First Development

All mergeable engineering work must start from a compliant GitHub Issue. Exploration and local investigation can happen before an Issue, but mergeable coding cannot start without a compliant Issue.

MVP is allowed, but system context must be preserved. Every change should explain what it does, why it matters, and what impact it has.

## Change Proportionality

按架构影响而不是代码行数分类：

- Patch：不改变边界、ownership、interface、data semantics、runtime topology 或 workload architecture；
- Feature：改变行为但通常留在既有架构内；跨多个 PR、阶段上线或重大 workflow 时使用 bounded Phase；
- Architecture Change：改变系统边界、主数据、跨组件合同、运行拓扑、信任边界、major workflow 或 canonical component；必须有 Phase、ADR 和 reconciliation。

Canonical policy：`retailpulses/rp-governance-kit/docs/ARCHITECTURE_CHANGE_GOVERNANCE.md`。

## Canonical Architecture

本 repository 由 owner 指定 `docs/01_ARCHITECTURE.md` 为唯一 canonical to-be system architecture；`docs/00_CURRENT_STATE.md` 只记录 cutover 前的运行差异。To-be capability 必须标明 evidence state，不能在部署前称为 Implemented、Deployed 或 Runtime verified。Architecture-affecting Phase 只有在 implementation、deployment/runtime evidence、current state、ADR 和 workload/database inventories 全部 reconciliation 后才算完成。

## PR Requirements

Every PR must explain:

- **User impact** — who is affected and how
- **Data impact** — does the data model change
- **Architecture impact** — does the system structure change
- **Documentation impact** — what docs must be updated
- **Reconciliation impact** — which canonical current-state, architecture, ADR, workload and database declarations must change before Phase close

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
