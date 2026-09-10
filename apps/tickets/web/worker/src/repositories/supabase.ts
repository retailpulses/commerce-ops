/** Supabase client initialization for the ticketing module.
 *  Uses service-role key for server-side operations.
 *  No browser/client-side exports — this is Worker-only.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/** Returns a cached Supabase client instance. Call once per request. */
export function getSupabaseClient(env: {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_RUNTIME_KEY?: string;
}): SupabaseClient {
  if (_client) return _client;

  if (!env.SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL environment variable");
  }
  const { apiKey, options } = resolveSupabaseClientConfig(env);

  _client = createClient(env.SUPABASE_URL, apiKey, options);

  return _client;
}

export function resolveSupabaseClientConfig(env: {
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_RUNTIME_KEY?: string;
}) {
  if (env.SUPABASE_RUNTIME_KEY) {
    if (!env.SUPABASE_ANON_KEY) {
      throw new Error("Missing SUPABASE_ANON_KEY for scoped runtime credential");
    }
    return {
      apiKey: env.SUPABASE_ANON_KEY,
      options: {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${env.SUPABASE_RUNTIME_KEY}` } },
      },
    };
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing Supabase runtime credential");
  }
  return {
    apiKey: env.SUPABASE_SERVICE_ROLE_KEY,
    options: { auth: { persistSession: false } },
  };
}

/** Reset cached client — useful for testing. */
export function resetSupabaseClient(): void {
  _client = null;
}
