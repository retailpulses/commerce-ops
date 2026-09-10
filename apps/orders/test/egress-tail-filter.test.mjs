import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("tail filter emits only sanitized supabase egress objects", () => {
  const metric = { workload_id: "build_giga_shipments", release_version: "abc123", requests: 2 };
  const input = [
    JSON.stringify({ logs: [{ message: ["unrelated order log", "order_123"] }] }),
    JSON.stringify({ logs: [{ message: [JSON.stringify({ supabase_egress: metric })] }] }),
    "not-json",
  ].join("\n");
  const result = spawnSync(process.execPath, ["scripts/filter-worker-egress-tail.mjs"], {
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), metric);
  assert.doesNotMatch(result.stdout, /order_123/);
});
