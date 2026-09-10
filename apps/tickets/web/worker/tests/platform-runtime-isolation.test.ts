import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runMercariIngestion } from "../src/runtimes/mercariIngestionWorker";
import { runRakutenIngestion } from "../src/runtimes/rakutenIngestionWorker";
import { runAmazonIngestion } from "../src/runtimes/amazonIngestionWorker";

test("platform ingestion runtimes use independent artifacts and cron ownership", () => {
  const root = new URL("../", import.meta.url);
  const mercari = readFileSync(new URL("wrangler.mercari-ingestion.toml", root), "utf8");
  const rakuten = readFileSync(new URL("wrangler.rakuten-ingestion.toml", root), "utf8");
  const amazon = readFileSync(new URL("wrangler.amazon-ingestion.toml", root), "utf8");
  assert.match(mercari, /main = "src\/runtimes\/mercariIngestionWorker\.ts"/);
  assert.match(rakuten, /main = "src\/runtimes\/rakutenIngestionWorker\.ts"/);
  assert.match(amazon, /main = "src\/runtimes\/amazonIngestionWorker\.ts"/);
  assert.doesNotMatch(mercari, /RAKUTEN|AMAZON/);
  assert.doesNotMatch(rakuten, /MERCARI|AMAZON/);
  assert.doesNotMatch(amazon, /MERCARI|RAKUTEN/);
});

test("one platform crash cannot invoke another platform runtime", async () => {
  const calls: string[] = [];
  const env = {} as never;
  await assert.rejects(runAmazonIngestion(env, (async () => { calls.push("amazon"); throw new Error("fault"); }) as never), /fault/);
  assert.deepEqual(calls, ["amazon"]);
  await runRakutenIngestion(env, (async () => { calls.push("rakuten"); return {} as never; }) as never);
  await runMercariIngestion(env, {
    reconcile: (async () => { calls.push("mercari-reconcile"); return {} as never; }) as never,
    retry: (async () => { calls.push("mercari-retry"); return {} as never; }) as never,
    forward: (async () => { calls.push("mercari-forward"); return {} as never; }) as never,
    ensureWebhooks: (async () => { calls.push("mercari-webhooks"); }) as never,
  });
  assert.deepEqual(calls, ["amazon", "rakuten", "mercari-reconcile", "mercari-retry", "mercari-forward", "mercari-webhooks"]);
});

test("Mercari recovery stages continue in order after an earlier stage fails", async () => {
  const calls: string[] = [];
  await assert.rejects(runMercariIngestion({ MERCARI_STAGE_TIMEOUT_MS: "1000" } as Env, {
    reconcile: (async () => { calls.push("reconcile"); throw new Error("fault"); }) as never,
    retry: (async () => { calls.push("retry"); return {} as never; }) as never,
    forward: (async () => { calls.push("forward"); return {} as never; }) as never,
    ensureWebhooks: (async () => { calls.push("webhooks"); }) as never,
  }), /mercari_ingestion_failed:reconcile/);
  assert.deepEqual(calls, ["reconcile", "retry", "forward", "webhooks"]);
});
