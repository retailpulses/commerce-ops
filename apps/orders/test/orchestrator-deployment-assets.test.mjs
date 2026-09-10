import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shadowWorkflowPath = ".github/workflows/install-orchestrator-shadow.yml";

test("orchestrator service runs only from the isolated immutable pointer", async () => {
  const unit = await readFile("deploy/systemd/order-mgmt-orchestrator.service", "utf8");
  assert.match(unit, /^WorkingDirectory=\/opt\/order-mgmt-orchestrator\/current$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/order-mgmt-orchestrator\/current\/src\/orchestrator\.mjs$/m);
  assert.doesNotMatch(unit, /\/opt\/OrderMgmt\/src\/orchestrator\.mjs/);
});

test("shadow installer is immutable, main-reachable and cannot activate work", {
  skip: existsSync(shadowWorkflowPath)
    ? false
    : "legacy deploy workflows are intentionally omitted from the Phase 1 monorepo snapshot",
}, async () => {
  const workflow = await readFile(shadowWorkflowPath, "utf8");
  for (const required of [
    "git merge-base --is-ancestor",
    "ORCHESTRATOR_MODE=shadow",
    "ORCHESTRATOR_LIVE_ENABLED=false",
    "RELEASE_VERSION must equal the installed SHA",
    "systemctl disable",
    "systemctl stop",
    "systemctl is-enabled",
    "systemctl is-active",
    "chown -R root:rp-ordermgmt",
    "chmod -R u=rwX,g=rX,o=",
    "Release is not traversable by rp-ordermgmt",
  ]) assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(workflow, /systemctl enable(?:\s|\")/);
  assert.doesNotMatch(workflow, /systemctl start(?:\s|\")/);
});

test("pipeline template includes direct marketplace credentials and default-off Rakuten close", async () => {
  const env = await readFile("deploy/systemd/pipeline.env", "utf8");
  assert.match(env, /^DATABASE_BACKEND=supabase$/m);
  assert.match(env, /^MERCARI_TOKENS_PATH=\/etc\/ordermgmt\/mercari_tokens\.md$/m);
  assert.match(env, /^RAKUTEN_SERVICE_SECRET=<set-via-env-file>$/m);
  assert.match(env, /^RAKUTEN_LICENSE_KEY=<set-via-env-file>$/m);
  assert.match(env, /^ORCHESTRATOR_ENABLE_RAKUTEN_CLOSE=false$/m);
  assert.match(env, /^ORCHESTRATOR_REQUIRE_IMMUTABLE_RELEASE=true$/m);
});
