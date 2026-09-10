import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditStrategyReadiness,
  CANONICAL_DOCS,
  EXTERNAL_EVIDENCE_GATES,
  REQUIRED_ASSETS,
  REQUIRED_MIGRATIONS,
} from "../scripts/audit-order-pipeline-strategy-readiness.mjs";

test("repository artifacts can prove local readiness but never strategy completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ordermgmt-readiness-"));
  const files = [
    ...REQUIRED_MIGRATIONS.map((name) => `supabase/migrations/${name}`),
    ...REQUIRED_ASSETS,
    ...CANONICAL_DOCS,
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "Target architecture; current production is not deployed.\n");
  }

  const result = await auditStrategyReadiness({ root });
  assert.equal(result.local_implementation_ready, true);
  assert.equal(result.strategy_complete, false);
  assert.equal(result.evidence.documents.length, CANONICAL_DOCS.length);
  assert.ok(result.evidence.documents.some((item) => item.name === "docs/operations.md"));
  assert.ok(result.evidence.documents.some((item) => item.name === "docs/16_DATABASE_GOVERNANCE.local.md"));
  assert.equal(Object.keys(result.external_evidence_gates).length, EXTERNAL_EVIDENCE_GATES.length);
  assert.ok(Object.values(result.external_evidence_gates).every((gate) => gate.satisfied === false));
});

test("missing repository evidence fails local readiness closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ordermgmt-readiness-missing-"));
  const result = await auditStrategyReadiness({ root });
  assert.equal(result.ok, false);
  assert.equal(result.local_implementation_ready, false);
  assert.equal(result.strategy_complete, false);
  assert.equal(result.checks.required_migrations_present, false);
  assert.equal(result.checks.canonical_docs_present, false);
});
