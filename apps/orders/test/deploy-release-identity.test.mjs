import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production Worker deploy injects the exact GitHub SHA as RELEASE_VERSION", () => {
  const workflow = readFileSync(".github/workflows/deploy-worker.yml", "utf8");
  assert.match(
    workflow,
    /wrangler deploy --var "RELEASE_VERSION:\$\{GITHUB_SHA\}"/,
  );
});
