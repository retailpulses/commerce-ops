import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = ".github/workflows/deploy-worker.yml";

test("production Worker deploy injects the exact GitHub SHA as RELEASE_VERSION", {
  skip: existsSync(workflowPath)
    ? false
    : "legacy deploy workflows are intentionally omitted from the Phase 1 monorepo snapshot",
}, () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(
    workflow,
    /wrangler deploy --var "RELEASE_VERSION:\$\{GITHUB_SHA\}"/,
  );
});
