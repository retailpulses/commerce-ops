import { getSupabaseClient } from "../repositories/supabase";
import { SupabaseCopywritingRepository } from "../repositories/supabaseCopywritingRepository";
import { RakutenRmesseSendAdapter } from "../services/rakutenRmesseSendAdapter";
import type { Env } from "../types";
import { createProviderWorker } from "./providerWorker";

export default createProviderWorker("rakuten", (env: Env) => new RakutenRmesseSendAdapter(
  new SupabaseCopywritingRepository(getSupabaseClient(env)),
  {
    enabled: env.RAKUTEN_RMESSE_OUTBOUND_ENABLED === "true",
    relayUrl: env.RAKUTEN_RMESSE_RELAY_URL,
    relaySecret: env.RAKUTEN_RMESSE_RELAY_SECRET,
  },
));
