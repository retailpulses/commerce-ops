import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { runMercariIngestion } from "../src/runtimes/mercariIngestionWorker";
import type { Env } from "../src/types";

test("Mercari ingestion preserves reconcile then retry then forward ordering", async () => {
  const calls: string[] = [];
  await runMercariIngestion({} as Env, {
    reconcile: (async () => { calls.push("reconcile"); return {} as never; }) as never,
    retry: (async () => { calls.push("retry"); return {} as never; }) as never,
    forward: (async () => { calls.push("forward"); return {} as never; }) as never,
    ensureWebhooks: (async () => { calls.push("webhooks"); }) as never,
  });
  assert.deepEqual(calls, ["reconcile", "retry", "forward", "webhooks"]);
});

test("Portal scheduled runtime contains no platform ingestion", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const scheduled = source.slice(source.lastIndexOf("async scheduled"));
  assert.doesNotMatch(scheduled, /Mercari|Rakuten|Amazon|handleCron|syncRakuten|syncAmazon/);
  assert.match(scheduled, /runTicketFormStagingCleanup/);
});
