import { ensureAllShopsWebhooks, handleMercariWebhookAdmin } from "../handlers/mercari-webhook-admin";
import { reconcileMercariMessages } from "../handlers/webhook-reconciliation";
import { processStuckInboundMessages, processStuckWebhookForwarding } from "../handlers/webhook-retry";
import type { Env } from "../types";
import { healthOnlyFetch, withRuntimeLease } from "./runtimeHealth";
import { handleMercariMessageWebhook } from "../handlers/webhooks";

export interface MercariIngestionDependencies {
  reconcile: typeof reconcileMercariMessages;
  retry: typeof processStuckInboundMessages;
  forward: typeof processStuckWebhookForwarding;
  ensureWebhooks: typeof ensureAllShopsWebhooks;
}

export async function runMercariIngestion(env: Env, overrides: Partial<MercariIngestionDependencies> = {}, includeMaintenance = true): Promise<void> {
  if (env.MERCARI_INGESTION_ENABLED !== "true" && Object.keys(overrides).length === 0) return;
  if (Object.keys(overrides).length === 0) {
    return withRuntimeLease("mercari", "ingestion", env, () => runMercariIngestion(env, {
      reconcile: reconcileMercariMessages,
      retry: processStuckInboundMessages,
      forward: processStuckWebhookForwarding,
      ensureWebhooks: ensureAllShopsWebhooks,
    }, includeMaintenance));
  }
  const dependencies: MercariIngestionDependencies = {
    reconcile: reconcileMercariMessages, retry: processStuckInboundMessages,
    forward: processStuckWebhookForwarding, ensureWebhooks: ensureAllShopsWebhooks,
    ...overrides,
  };
  const failures: string[] = [];
  const stage = async (name: string, operation: () => Promise<unknown>) => {
    try { await operation(); } catch { failures.push(name); }
  };
  await stage("reconcile", () => dependencies.reconcile(env, "rolling"));
  await stage("retry", () => dependencies.retry(env, 10));
  await stage("forward", () => dependencies.forward(env, 10));
  if (includeMaintenance) await stage("ensure_webhooks", () => dependencies.ensureWebhooks(env));
  if (failures.length > 0) throw new Error(`mercari_ingestion_failed:${failures.join(",")}`);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/webhooks/mercari-message" && request.method === "POST") return withRuntimeLease("mercari", "ingestion", env, () => handleMercariMessageWebhook(request, env, ctx), "intake");
    if (path === "/api/admin/mercari-webhooks" && request.method === "POST") return withRuntimeLease("mercari", "ingestion", env, () => handleMercariWebhookAdmin(request, env));
    if (path === "/v1/reconcile/backfill" && request.method === "POST") {
      return withRuntimeLease("mercari", "ingestion", env, () => reconcileMercariMessages(env, "backfill")).then((report) => new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } }));
    }
    return healthOnlyFetch("mercari", request, env);
  },
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === "15 0 * * *") {
      if (env.MERCARI_INGESTION_ENABLED === "true") {
        await withRuntimeLease("mercari", "ingestion", env, () => ensureAllShopsWebhooks(env));
      }
      return;
    }
    await runMercariIngestion(env, {}, false);
  },
};
