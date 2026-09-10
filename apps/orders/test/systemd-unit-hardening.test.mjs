import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const units = [
  "order-mgmt-orchestrator.service",
  "order-mgmt-sales-brief.service",
];

for (const unit of units) {
  test(`${unit} uses the protected non-root canonical runtime`, async () => {
    const content = await readFile(new URL(`../deploy/systemd/${unit}`, import.meta.url), "utf8");
    assert.match(content, /^User=rp-ordermgmt$/m);
    assert.match(content, /^Group=rp-ordermgmt$/m);
    assert.doesNotMatch(content, /^User=root$/m);
    assert.match(content, /^WorkingDirectory=\/opt\/order-mgmt-orchestrator\/current$/m);
    assert.match(content, /^NoNewPrivileges=(true|yes)$/m);
    assert.match(content, /^PrivateTmp=(true|yes)$/m);
    assert.match(content, /^ProtectSystem=strict$/m);
    assert.match(content, /^ProtectHome=(true|yes)$/m);
    assert.match(content, /^UMask=0077$/m);
  });
}

test("sales brief never auto-restarts an ambiguous external delivery", async () => {
  const content = await readFile(new URL("../deploy/systemd/order-mgmt-sales-brief.service", import.meta.url), "utf8");
  assert.match(content, /^Restart=no$/m);
  assert.doesNotMatch(content, /^Restart=(on-failure|always)$/m);
  assert.doesNotMatch(content, /^RestartSec=/m);
});
