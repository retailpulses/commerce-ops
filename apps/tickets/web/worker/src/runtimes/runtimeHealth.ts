import type { Env } from "../types";
import { getSupabaseClient } from "../repositories/supabase";

type Platform = "mercari" | "rakuten" | "amazon";
type Role = "send" | "ingestion";

export async function assertRuntimeOwnership(platform: Platform, role: Role, env: Env): Promise<void> {
  const generation = String(env.ROUTING_GENERATION || "").trim();
  const versionId = String(env.CF_VERSION_METADATA?.id || "").trim();
  if (!generation || generation === "none" || !versionId || !env.SUPABASE_RUNTIME_KEY || !env.SUPABASE_ANON_KEY) {
    throw new Error("runtime_ownership_not_configured");
  }
  const { data, error } = await getSupabaseClient(env).rpc("assert_platform_runtime_owner_v1", {
    p_component: `${platform}-${role}`,
    p_generation: generation,
    p_version_id: versionId,
  });
  if (error || !(data as { active?: boolean } | null)?.active) {
    throw new Error("runtime_ownership_not_active");
  }
}

export async function withRuntimeLease<T>(
  platform: Platform,
  role: Role,
  env: Env,
  operation: () => Promise<T>,
  purpose: "work" | "intake" = "work",
): Promise<T> {
  const generation = String(env.ROUTING_GENERATION || "").trim();
  const versionId = String(env.CF_VERSION_METADATA?.id || "").trim();
  if (!generation || generation === "none" || !versionId || !env.SUPABASE_RUNTIME_KEY || !env.SUPABASE_ANON_KEY) {
    throw new Error("runtime_lease_not_configured");
  }
  const leaseId = crypto.randomUUID();
  const client = getSupabaseClient(env);
  const { data, error } = await client.rpc("acquire_platform_runtime_lease_v1", {
    p_component: `${platform}-${role}`,
    p_generation: generation,
    p_version_id: versionId,
    p_lease_id: leaseId,
    p_purpose: purpose,
  });
  if (error || data !== true) throw new Error("runtime_lease_not_acquired");
  try {
    return await operation();
  } finally {
    const { data: released, error: releaseError } = await client.rpc("release_platform_runtime_lease_v1", {
      p_lease_id: leaseId,
    });
    if (releaseError || released !== true) {
      console.error("Runtime lease release failed", { platform, role, error_code: "RUNTIME_LEASE_RELEASE_FAILED" });
    }
  }
}

function readiness(platform: Platform, role: Role, env: Env): { enabled: boolean; config_ready: boolean } {
  const databaseReady = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_RUNTIME_KEY);
  if (role === "send") {
    if (platform === "mercari") return { enabled: env.MERCARI_OUTBOUND_ENABLED === "true", config_ready: Boolean(databaseReady && env.SHOP1_API_TOKEN && env.SHOP2_API_TOKEN && env.SHOP3_API_TOKEN && env.SHOP4_API_TOKEN) };
    if (platform === "rakuten") return { enabled: env.RAKUTEN_RMESSE_OUTBOUND_ENABLED === "true", config_ready: Boolean(databaseReady && env.RAKUTEN_RMESSE_RELAY_URL && env.RAKUTEN_RMESSE_RELAY_SECRET) };
    return { enabled: false, config_ready: databaseReady };
  }
  if (platform === "mercari") return { enabled: env.MERCARI_INGESTION_ENABLED === "true", config_ready: Boolean(databaseReady && env.WEBHOOK_SHARED_SECRET && env.SHOP1_API_TOKEN && env.SHOP2_API_TOKEN && env.SHOP3_API_TOKEN && env.SHOP4_API_TOKEN) };
  if (platform === "rakuten") return { enabled: String(env.RAKUTEN_RMESSE_INGESTION_MODE || "off") !== "off", config_ready: Boolean(databaseReady && env.RAKUTEN_RMESSE_RELAY_URL && env.RAKUTEN_RMESSE_RELAY_SECRET) };
  return {
    enabled: String(env.AMAZON_MAIL_INGESTION_MODE || "off") !== "off",
    config_ready: Boolean(
      databaseReady && env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN &&
      env.ZOHO_MAIL_ACCOUNT_ID && env.ZOHO_MAIL_INBOX_FOLDER_ID && env.AMAZON_PLATFORM_ACCOUNT_ID
    ),
  };
}

async function capabilityProbe(platform: Platform, role: Role, env: Env): Promise<{ ready: boolean; last_success_at: string | null; checkpoint: string | null }> {
  const unavailable = { ready: false, last_success_at: null, checkpoint: null };
  if (env.PLATFORM_SCHEMA_READY !== "true" || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_RUNTIME_KEY) return unavailable;
  try {
    await assertRuntimeOwnership(platform, role, env);
    const { data, error } = await getSupabaseClient(env).rpc(`probe_${platform}_${role}_runtime_v1`);
    if (error || !data || typeof data !== "object") return unavailable;
    const result = data as Record<string, unknown>;
    return {
      ready: result.ready === true && result.capability_version === "2026-09-09.v1",
      last_success_at: typeof result.last_success_at === "string" ? result.last_success_at : null,
      checkpoint: typeof result.checkpoint === "string" ? result.checkpoint : null,
    };
  } catch { return unavailable; }
}

export async function runtimeHealthFetch(platform: Platform, role: Role, request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/version") return new Response(JSON.stringify({ platform, role, release_sha: env.RELEASE_SHA || "unknown", contract_version: env.RUNTIME_CONTRACT_VERSION || "unknown" }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (path === "/health") {
    const state = readiness(platform, role, env);
    const probe = await capabilityProbe(platform, role, env);
    const schema_ready = probe.ready;
    const ready = state.enabled && state.config_ready && schema_ready;
    return new Response(JSON.stringify({
      status: ready ? "ready" : "unavailable",
      platform,
      role,
      release_sha: env.RELEASE_SHA || "unknown",
      contract_version: env.RUNTIME_CONTRACT_VERSION || "unknown",
      ...state,
      schema_ready,
      last_success_at: probe.last_success_at,
      checkpoint: probe.checkpoint,
    }), { status: ready ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return new Response("Not found", { status: 404 });
}

export function healthOnlyFetch(platform: Platform, request: Request, env: Env): Promise<Response> {
  return runtimeHealthFetch(platform, "ingestion", request, env);
}
