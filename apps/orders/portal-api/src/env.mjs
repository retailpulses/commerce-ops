// Portal API environment — constructs a Worker-like env object so the
// shared handler functions (src/lib/portal/*) work unmodified.
// Sets DATABASE_BACKEND=supabase to route through the Supabase adapter.

import process from "node:process";

function trimStr(value, fallback = "") {
  return String(value ?? fallback).trim();
}

/**
 * Detect literal placeholder values that indicate a secret has not been set.
 * Catches common patterns: angle-bracket instructions, "changeme", "TODO", etc.
 */
function isPlaceholder(value) {
  if (!value) return true; // empty is also a placeholder
  const lower = value.toLowerCase().trim();
  // Angle-bracket patterns: <set-via-env-file>, <your-secret-here>, etc.
  if (lower.startsWith("<") && lower.includes(">")) return true;
  // Common literal placeholders
  const literalPlaceholders = [
    "changeme", "change_me", "changethis", "change_this",
    "todo", "placeholder", "xxx", "your_secret", "your-secret",
    "set-via-env-file",
  ];
  if (literalPlaceholders.includes(lower)) return true;
  return false;
}

function requireEnv(name) {
  const value = trimStr(process.env[name]);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  if (isPlaceholder(value)) {
    throw new Error(
      `Env var ${name} is set to a placeholder value ("${value.slice(0, 30)}"). ` +
      `Replace it with a real secret via EnvironmentFile or systemd drop-in.`
    );
  }
  return value;
}

export function buildEnv(overrides = {}) {
  const env = {
    // Database backend selection — tells db.mjs to use Supabase adapter
    DATABASE_BACKEND: "supabase",

    // Supabase connection
    SUPABASE_URL:           trimStr(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL, "https://gqeyfhshxdiyhugvmbuk.supabase.co"),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_ANON_KEY:       trimStr(process.env.SUPABASE_ANON_KEY, ""),

    // Product enrichment migrated to Supabase (product_variants + product_commercials).
    // BASEROW_DATABASE_TOKEN is still required for Restock Info writes (presale.mjs)
    // which use a separate Baserow client.
    BASEROW_API_BASE:         trimStr(process.env.BASEROW_API_BASE, "https://api.baserow.io/api"),
    BASEROW_DATABASE_TOKEN:   requireEnv("BASEROW_DATABASE_TOKEN"),
    PORTAL_PRODUCTS_TABLE_ID: trimStr(process.env.PORTAL_PRODUCTS_TABLE_ID, "886994"),
    PORTAL_COMMISSION_RATE_MERCARI: trimStr(process.env.PORTAL_COMMISSION_RATE_MERCARI, "0.10"),

    // Shared portal handlers use the fixed-IP marketplace relay for messages.
    MERCARI_RUNNER_BASE_URL: trimStr(process.env.MERCARI_RUNNER_BASE_URL, "https://worker-order.homesbliss.net"),
    MERCARI_RELAY_SECRET:    requireEnv("MERCARI_RELAY_SECRET"),

    // Optional reply-generation configuration.
    OPENAI_API_KEY:      trimStr(process.env.OPENAI_API_KEY, ""),
    LLM_MODEL:           trimStr(process.env.LLM_MODEL, "gpt-4o"),
    LLM_MAX_TOKENS:      trimStr(process.env.LLM_MAX_TOKENS, "500"),
    PORTAL_ACCESS_TOKEN: trimStr(process.env.PORTAL_ACCESS_TOKEN, ""),

    // Admin auth — same secret as the Worker uses
    ORDER_MGMT_ADMIN_SECRET: trimStr(process.env.ORDER_MGMT_ADMIN_SECRET, ""),
    GIGA_SYNC_ADMIN_SECRET:  trimStr(process.env.GIGA_SYNC_ADMIN_SECRET, ""),
    OPS_PORTAL_PROXY_SECRET: trimStr(process.env.OPS_PORTAL_PROXY_SECRET, ""),

    // RPagentOS product_catalog owner API. This dedicated credential is
    // server-side only and authorizes the three manual override fields.
    CATALOG_OWNER_API_BASE_URL: trimStr(process.env.CATALOG_OWNER_API_BASE_URL, "https://rpagentos.pages.dev"),
    ORDERMGMT_CATALOG_API_TOKEN: requireEnv("ORDERMGMT_CATALOG_API_TOKEN"),

    // Port
    PORT: trimStr(process.env.PORT, "3000"),

    // Release metadata (non-secret). Injected by deploy-api.yml at deploy time;
    // exposed by the public read-only GET /order/api/release endpoint
    // (contract_version=1). Empty locally / outside a release deploy.
    RELEASE_SHA:      trimStr(process.env.RELEASE_SHA, ""),
    RELEASE_BUILT_AT: trimStr(process.env.RELEASE_BUILT_AT, ""),

    // Read-only control-plane projection. This reports local configuration;
    // runtime ownership is proven separately by the database lease/readback.
    ORCHESTRATOR_LIVE_ENABLED: trimStr(process.env.ORCHESTRATOR_LIVE_ENABLED, "false"),
    ORDER_LIFECYCLE_FRESHNESS_MINUTES: trimStr(process.env.ORDER_LIFECYCLE_FRESHNESS_MINUTES, "180"),

    // Overrides (for testing)
    ...overrides,
  };

  // Validate minimum config
  const errors = [];
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY is required");
  }
  if (!env.BASEROW_DATABASE_TOKEN) {
    errors.push("BASEROW_DATABASE_TOKEN is required for Products-table enrichment");
  }
  if (!env.ORDER_MGMT_ADMIN_SECRET && !env.GIGA_SYNC_ADMIN_SECRET) {
    errors.push("At least one admin secret is required (ORDER_MGMT_ADMIN_SECRET or GIGA_SYNC_ADMIN_SECRET)");
  }
  if (errors.length > 0) {
    throw new Error(`Portal API misconfigured:\n  - ${errors.join("\n  - ")}`);
  }

  return env;
}
