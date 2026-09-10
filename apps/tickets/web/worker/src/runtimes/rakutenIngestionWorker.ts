import { getSupabaseClient } from "../repositories/supabase";
import { syncRakutenRmesse } from "../services/rakutenRmesseSyncService";
import type { Env } from "../types";
import { healthOnlyFetch, withRuntimeLease } from "./runtimeHealth";

export async function runRakutenIngestion(env: Env, sync: typeof syncRakutenRmesse = syncRakutenRmesse): Promise<void> {
  if (sync === syncRakutenRmesse) {
    await withRuntimeLease("rakuten", "ingestion", env, () => sync(env, getSupabaseClient(env)));
    return;
  }
  await sync(env, {} as ReturnType<typeof getSupabaseClient>);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/v1/sync" && request.method === "POST") {
      await runRakutenIngestion(env);
      return new Response(JSON.stringify({ ok: true, platform: "rakuten" }), { headers: { "content-type": "application/json" } });
    }
    return healthOnlyFetch("rakuten", request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> { await runRakutenIngestion(env); },
};
