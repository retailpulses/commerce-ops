# Inquiry Repo Deduplication Plan

Date: 2026-06-15
Canonical repo: `inquiry-automation`
Source repo to absorb: `../inquiry-handler`

## Goal

Deduplicate `inquiry-automation` and `inquiry-handler` by making
`inquiry-automation` the single inquiry product repo.

`inquiry-handler` is treated as an unfinished Cloudflare Worker port and source
material. It should not remain a separate first-class repo after the migration
is complete.

## Current Evaluation

### `inquiry-automation`

Role: canonical inquiry automation repo.

Why it survives:
- It contains the production-validated Python pipeline.
- It has the strongest documentation and operational history.
- Local verification passes: `190 passed`.
- It already has `REFACTOR-WORKER.md`, which defines the intended Worker
  migration contract.

Important existing state:
- Pipeline has not been deployed to cron or VPS.
- Worker vs VPS runtime decision was previously marked open.
- `rp-mail-integration` handles Zoho to Baserow ingestion, so this dedupe does
  not need to port Zoho fetching.

### `inquiry-handler`

Role: unfinished Worker port/prototype.

Why it should be absorbed:
- It duplicates classification, product matching, drafting, Baserow access, and
  scheduling concerns.
- Most implementation files are currently untracked locally, so preservation
  must happen before cleanup.
- It partially implements the Worker refactor plan, but it does not yet match
  the non-negotiable runtime contract.

Key risks found:
- Admin routes are currently unauthenticated.
- Master handler uses date cursor selection instead of status-filter-primary
  selection.
- Master handler writes `Status: Received` rather than transitioning to
  `Followed-up`.
- Draft job filters `Received` rows despite representing the draft phase.
- Draft job writes draft fields but does not transition rows to `Answered`.
- Worker test command exits nonzero locally before useful failure details.

## Definition Of Done

This dedupe is complete when:
- all useful Worker source from `inquiry-handler` is preserved under
  `inquiry-automation`,
- the Worker port has a clear location such as `apps/worker/`,
- `inquiry-automation` docs identify it as the single inquiry repo,
- `inquiry-handler` has a clear deprecation/archive marker,
- Python tests still pass,
- Worker tests either pass or have documented blockers,
- no production deploy or production Baserow mutation has occurred.

## Non-Goals

- Do not deploy the Worker.
- Do not enable cron.
- Do not run live production mutations.
- Do not create or update Baserow job-log rows for this dedupe task.
- Do not retrieve, print, move, or commit secrets from `.env` or `.dev.vars`.
- Do not delete `inquiry-handler` until the absorbed Worker copy is verified.

## Target Repo Shape

Preferred structure:

```text
inquiry-automation/
  src/                     # existing Python pipeline
  scripts/                 # existing Python scripts
  tests/                   # existing Python tests
  apps/
    worker/                # absorbed Cloudflare Worker runtime
      src/
      test/
      package.json
      package-lock.json
      tsconfig.json
      vitest.config.ts
      wrangler.toml
      README.md
  docs/
    consolidation/
      inquiry-dedupe-plan-2026-06-15.md
    worker/
      migration-status.md
```

## Execution Plan

### Phase 0: Preserve local work

1. Inspect dirty state in both repos.
2. Do not overwrite modified `inquiry-automation/AGENTS.md`.
3. Copy untracked Worker implementation from `inquiry-handler` into
   `inquiry-automation/apps/worker/`.
4. Preserve `inquiry-handler/issues/004-product-not-assigned.md` as migration
   evidence, either in Worker docs or as a linked copied note.

### Phase 1: Establish canonical ownership

1. Update `inquiry-automation/README.md` to state that it is the canonical
   inquiry automation repo.
2. Add a Worker status doc under `inquiry-automation/docs/worker/`.
3. Update `inquiry-handler/README.md` to mark it as deprecated and point to
   `../inquiry-automation/apps/worker/`.

### Phase 2: Make the Worker port safe-by-default

Worker code must be brought closer to `REFACTOR-WORKER.md` before it can be
considered a successor runtime.

Required changes:
- Add admin bearer auth guard.
- Add explicit dry-run behavior.
- Add explicit row-id execution path for controlled tests.
- Use Baserow status field ID filtering as the primary selector.
- Use the correct state flow:
  - `Received` to `Followed-up` after classify/link.
  - `Followed-up` to `Answered` after draft.
- Do not overwrite existing classification or draft fields unless force is
  explicitly enabled.
- Keep ShopIndex disabled unless a VPS relay is intentionally added later.

### Phase 3: Align tests

1. Run Python tests from `inquiry-automation`.
2. Run Worker tests from `inquiry-automation/apps/worker`.
3. Add or port tests for issue #4:
   - no product link means no false stock-out draft,
   - long product names can match the intended product,
   - common terms such as `ナチュラル テーブル` do not blindly match the wrong
     item.
4. If Worker tests fail due to Cloudflare/Vitest environment setup, document the
   blocker in `docs/worker/migration-status.md`.

### Phase 4: Archive path

After the copied Worker port is verified:
- leave `inquiry-handler` as a deprecated stub for one short transition window,
- then move it to `_archived/` or delete the GitHub repo after confirmation.

## Instructions For Heavy-Lifting Agent

Work inside:
- `/Users/user/Documents/Retailpulses/20_REPOS/inquiry-automation`
- `/Users/user/Documents/Retailpulses/20_REPOS/inquiry-handler`

Boundaries:
- You may copy files from `inquiry-handler` into
  `inquiry-automation/apps/worker/`.
- You may update README/docs in both repos.
- You may patch Worker code and tests under the copied Worker app.
- You must not deploy, run live Baserow mutations, touch secrets, or delete the
  source repo.
- You must not revert unrelated user changes.

Validation:
- Run `python3 -m pytest tests -q` in `inquiry-automation`.
- Run `npm test` in `inquiry-automation/apps/worker` if dependencies are
  available after the copy.
- Report all test results and any blockers.
