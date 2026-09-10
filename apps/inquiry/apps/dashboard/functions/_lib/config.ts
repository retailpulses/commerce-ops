/**
 * Dashboard configuration.
 *
 * Phase 1 Supabase migration: all inquiry reads/writes go through Supabase
 * PostgREST. The service_role key is only used server-side in Pages
 * Functions — never exposed to the browser.
 */

interface Env {
  [key: string]: unknown;
  SUPABASE_URL?: string;
  SUPABASE_REST_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENAI_API_KEY?: string;
  LLM_MODEL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;
  INQUIRY_DASHBOARD_MUTATIONS_ENABLED?: string;
  CATALOG_OWNER_API_URL?: string;
  CATALOG_OWNER_API_TOKEN?: string;
  MERCARI_RELAY_URL?: string;
  SHOP1_API_TOKEN?: string;
  SHOP2_API_TOKEN?: string;
  SHOP3_API_TOKEN?: string;
  SHOP4_API_TOKEN?: string;
  INQUIRY_OUTBOUND_SEND_ENABLED?: string;
}

export function getConfig(env: Env) {
  return {
    supabase: {
      url: env.SUPABASE_URL || "",
      restUrl: env.SUPABASE_REST_URL || "",
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    },
    openai: {
      apiKey: env.OPENAI_API_KEY || "",
      model: env.LLM_MODEL || "gpt-4o",
    },
    auth: {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN || "",
      audience: env.CF_ACCESS_AUD || "",
      allowedEmails: env.CF_ACCESS_ALLOWED_EMAILS || "",
    },
    productCatalog: {
      table: "product_variants",
      schema: "public",
    },
    /** Fail-closed: mutations run only when the binding is exactly "true". */
    mutationsEnabled: env.INQUIRY_DASHBOARD_MUTATIONS_ENABLED === "true",
    catalogOwner: {
      apiUrl: env.CATALOG_OWNER_API_URL || "",
      token: env.CATALOG_OWNER_API_TOKEN || "",
    },
    mercariRelay: {
      url: env.MERCARI_RELAY_URL || "",
      shopTokens: {
        shop1: env.SHOP1_API_TOKEN || "",
        shop2: env.SHOP2_API_TOKEN || "",
        shop3: env.SHOP3_API_TOKEN || "",
        shop4: env.SHOP4_API_TOKEN || "",
      },
    },
    /** Fail-closed: operator Send runs only when exactly "true". */
    outboundSendEnabled: env.INQUIRY_OUTBOUND_SEND_ENABLED === "true",
  };
}

export type DashboardConfig = ReturnType<typeof getConfig>;

// =========================================================================
// Canonical status text keys
// =========================================================================

export const STATUS_RECEIVED = "received";
export const STATUS_FOLLOWED_UP = "followed_up";
export const STATUS_ANSWERED = "answered";
export const STATUS_CLOSED_WON = "closed_won";
export const STATUS_CLOSED_LOSE = "closed_lose";

export const STATUS_LABELS: Record<string, string> = {
  received: "Received",
  followed_up: "Followed up",
  answered: "Answered",
  closed_won: "Closed Won",
  closed_lose: "Closed Lose",
};

export const VALID_STATUS_KEYS = Object.keys(STATUS_LABELS);

// =========================================================================
// Canonical shop key labels
// =========================================================================

export const SHOP_LABELS: Record<string, string> = {
  shop1: "Shop1",
  shop2: "Shop2",
  shop3: "Shop3",
  shop4: "Shop4",
};

export const SHOP_KEYS = Object.keys(SHOP_LABELS);

// =========================================================================
// Canonical inquiry type keys
// =========================================================================

export const INQUIRY_TYPE_KEYS: Record<string, string> = {
  "Okinawa inquiry": "okinawa_inquiry",
  "Bulk purchase": "bulk_purchase",
  "Price negotiation": "price_negotiation",
  "Scheduled delivery": "scheduled_delivery",
  "Product availability": "product_availability",
  "Shipping related": "shipping_related",
  "Assembly": "assembly",
  "Product Spec": "product_spec",
  "Find a product": "find_a_product",
  "Others": "others",
};

export const INQUIRY_TYPE_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(INQUIRY_TYPE_KEYS).map(([k, v]) => [v, k]),
);
