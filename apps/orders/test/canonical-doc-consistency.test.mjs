import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CANONICAL_DOCS = [
  "CLAUDE.md",
  "README.md",
  "docs/00_CURRENT_STATE.md",
  "docs/05_DECISION_LOG.md",
  "docs/SYNC_JOB_INVENTORY.md",
  "docs/plans/order-pipeline-first-tranche-rollout.md",
  "docs/trd/order-pipeline-orchestration-strategy.md",
  "deploy/README.md",
];

async function readCanonicalDocs() {
  return Object.fromEntries(await Promise.all(CANONICAL_DOCS.map(async (file) => [
    file, await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
  ])));
}

test("canonical docs reject superseded orchestration claims", async () => {
  const docs = await readCanonicalDocs();
  const all = Object.values(docs).join("\n");
  for (const staleClaim of [
    "orchestrator does not yet expose a live canary CLI",
    "live canary orchestration remains unopened",
    "Mercari discovery remains rejected",
    "Unsupported discovery canaries fail closed",
    "Rakuten close remains outside the DAG",
  ]) {
    assert.equal(all.includes(staleClaim), false, `superseded canonical claim remains: ${staleClaim}`);
  }
  assert.match(docs["docs/00_CURRENT_STATE.md"], /all DAG capabilities are now representable as exact canaries/);
  assert.match(docs["deploy/README.md"], /--live --canary mercari_tracking/);
  assert.match(docs["docs/trd/order-pipeline-orchestration-strategy.md"], /Phase 5 不是首次更新点/);
  assert.match(docs["docs/SYNC_JOB_INVENTORY.md"], /Rakuten close is represented after Rakuten tracking in[\s\S]*dedicated live flag remains default-off/);
});

test("canonical entrypoints preserve deployed-versus-target distinction", async () => {
  const docs = await readCanonicalDocs();
  assert.match(docs["README.md"], /shadow 模式部署并通过首个 17-step run 验收/);
  assert.match(docs["docs/00_CURRENT_STATE.md"], /Current production remains unchanged/);
  assert.match(docs["deploy/README.md"], /immutable shadow installed and timer enabled; all live capabilities disabled/);
});
