import { getSupabaseClient } from "../repositories/supabase";
import { syncAmazonMail } from "../services/amazonMailSyncService";
import type { Env } from "../types";
import { healthOnlyFetch, withRuntimeLease } from "./runtimeHealth";

export async function runAmazonIngestion(env: Env, sync: typeof syncAmazonMail = syncAmazonMail): Promise<void> {
  if (sync === syncAmazonMail) {
    await withRuntimeLease("amazon", "ingestion", env, () => sync(env, getSupabaseClient(env)));
    return;
  }
  await sync(env, {} as ReturnType<typeof getSupabaseClient>);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/v1/sync" && request.method === "POST") {
      await runAmazonIngestion(env);
      return new Response(JSON.stringify({ ok: true, platform: "amazon" }), { headers: { "content-type": "application/json" } });
    }
    return healthOnlyFetch("amazon", request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> { await runAmazonIngestion(env); },
};
