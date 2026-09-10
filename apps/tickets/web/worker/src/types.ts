/** Shared TypeScript interfaces for the Mercari ticket handling system. */

export interface MercariMessage {
  id: string;
  createdAt: string;
  message: string;
  role: "BUYER" | "SELLER";
}

export interface MercariProduct {
  productId?: string;
  variant?: {
    skuCode: string;
  };
  purchasedQuantity?: number;
}

export interface MercariTransaction {
  id: string;
  status: string;
  createdAt: string;
  shop: string;
  messages: MercariMessage[];
  products: MercariProduct[];
}

export interface MercariGraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

export interface Classification {
  cls: string;
  subcls: string;
  meta: Record<string, unknown>;
}

// ── Reply Template Types ──

export type TemplateCategory =
  | "greeting_only"
  | "information_only"
  | "holding"
  | "fuguai"
  | "fuguai_lite"
  | "followup_form_helper"
  | "cancel_fee"
  | "form_received_ack"
  | "custom";

export type TemplateBehavior =
  | "informational_ack"
  | "holding_ack"
  | "form_request"
  | "cancel_fee"
  | "custom";

export interface ReplyTemplate {
  id: number;
  title: string;
  category: TemplateCategory;
  behavior: TemplateBehavior;
  body: string;
  variables: string;
  is_active: boolean;
  notes: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RenderedTemplate {
  body: string;
  category: TemplateCategory;
  behavior: TemplateBehavior;
  templateId: number | null;
  version: number;
  hasUnresolvedVariables: boolean;
  unresolvedVariables: string[];
  isFallback: boolean;
}
export interface Env {
  MERCARI_REPORTS: KVNamespace;
  TICKET_ARCHIVE?: R2Bucket;
  LEGACY_EVIDENCE?: R2Bucket;
  DB?: D1Database;
  TICKET_SHARE_REPLAY_GUARD: DurableObjectNamespace;
  // Secrets (set via wrangler secret or env vars)
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY: string;
  SHOP1_API_TOKEN: string;
  SHOP2_API_TOKEN: string;
  SHOP3_API_TOKEN: string;
  SHOP4_API_TOKEN: string;
  WECOM_WEBHOOK_URL?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_KV_NAMESPACE_ID: string;
  CLOUDFLARE_KV_API_TOKEN: string;
  PASSWORD_HASH: string;
  WEBHOOK_SHARED_SECRET?: string;
  // ── New Ticketing MVP (Supabase) ──
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Platform-scoped JWT for isolated runtimes; never the Supabase service_role key. */
  SUPABASE_RUNTIME_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  ENABLE_NEW_TICKETING?: string;
  ENABLE_REACT_FRONTEND?: string;
  /** Message-to-TicketForm rollout: shadow (default), limited, or active. */
  TICKETFORM_AUTOMATION_MODE?: string;
  /** Comma-separated canonical shop names used only in limited mode. */
  TICKETFORM_AUTOMATION_SHOPS?: string;
  /** Public Worker origin used to construct tokenized TicketForm links. */
  TICKETFORM_PUBLIC_BASE_URL?: string;
  /** HMAC secret for deterministic, retry-safe, unguessable pre-ticket tokens. */
  TICKETFORM_TOKEN_SIGNING_SECRET?: string;
  /** Enables operator and internal seller-share routes after schema deployment. */
  ENABLE_TICKET_SHARES?: string;
  /** Public HTTPS origin of the isolated ConoHa seller viewer. */
  TICKET_SHARE_PUBLIC_BASE_URL?: string;
  /** Dedicated HMAC secret used only to derive reconstructable seller URLs. */
  TICKET_SHARE_TOKEN_SIGNING_SECRET?: string;
  /** Dedicated HMAC secret authenticating ConoHa-to-Worker bridge requests. */
  TICKET_SHARE_BRIDGE_HMAC_SECRET?: string;
  /** Comma-separated fixed ConoHa egress IPs accepted by the bridge. */
  TICKET_SHARE_BRIDGE_ALLOWED_IPS?: string;
  /** OrderMgmt webhook endpoint to receive forwarded events (Issue #131). */
  ORDERMGMT_WEBHOOK_ENDPOINT?: string;
  /** Dedicated secret paired with OrderMgmt's WEBHOOK_FORWARD_SECRET. */
  ORDERMGMT_WEBHOOK_FORWARD_SECRET?: string;
  /** Optional cap on forwarding retry attempts (default 5). */
  ORDERMGMT_WEBHOOK_FORWARD_MAX_ATTEMPTS?: string;
  /** Read-only OrderMgmt capability used for operator order context. */
  ORDERMGMT_ORDER_CONTEXT_URL?: string;
  ORDERMGMT_ORDER_CONTEXT_SECRET?: string;
  /** Independent emergency stop for Mercari operator replies. */
  MERCARI_OUTBOUND_ENABLED?: string;
  MERCARI_INGESTION_ENABLED?: string;
  /** Official RMS R-Messe fixed-egress relay. */
  RAKUTEN_RMESSE_RELAY_URL?: string;
  RAKUTEN_RMESSE_RELAY_SECRET?: string;
  /** off | shadow | active */
  RAKUTEN_RMESSE_INGESTION_MODE?: string;
  RAKUTEN_RMESSE_OUTBOUND_ENABLED?: string;
  RAKUTEN_RMESSE_OVERLAP_MINUTES?: string;
  /** Bounded direct-detail reconciliation for already-known inquiries. */
  RAKUTEN_RMESSE_RECONCILIATION_LIMIT?: string;
  RAKUTEN_RMESSE_RECONCILIATION_INTERVAL_MINUTES?: string;
  RAKUTEN_RMESSE_CANARY_ORDER_NUMBER?: string;
  RAKUTEN_RMESSE_CANARY_FROM_DATE?: string;
  /** Amazon buyer messages use Zoho Mail for inbound evidence only. */
  ZOHO_ACCOUNTS_BASE?: string;
  ZOHO_MAIL_API_BASE?: string;
  ZOHO_MAIL_ACCOUNT_ID?: string;
  ZOHO_MAIL_INBOX_FOLDER_ID?: string;
  ZOHO_MAIL_SENT_FOLDER_ID?: string;
  AMAZON_MAIL_FROM_ADDRESS?: string;
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  /** off | shadow | active */
  AMAZON_MAIL_INGESTION_MODE?: string;
  AMAZON_MAIL_OUTBOUND_ENABLED?: string;
  AMAZON_MAIL_ATTACHMENTS_ENABLED?: string;
  AMAZON_MAIL_OVERLAP_MINUTES?: string;
  AMAZON_MAIL_RECONCILIATION_LIMIT?: string;
  AMAZON_MAIL_CANARY_ORDER_NUMBER?: string;
  AMAZON_PLATFORM_ACCOUNT_ID?: string;
  AMAZON_MAIL_INITIAL_LOOKBACK_HOURS?: string;
  /** Deploy-injected release SHA (github.sha) exposed via /tickets/api/release. */
  RELEASE_SHA?: string;
  ROUTING_GENERATION?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  RUNTIME_CONTRACT_VERSION?: string;
  PLATFORM_SCHEMA_READY?: string;
  RUNTIME_LAST_SUCCESS_AT?: string;
  RUNTIME_CHECKPOINT?: string;
  MERCARI_SEND_PROVIDER?: Fetcher;
  RAKUTEN_SEND_PROVIDER?: Fetcher;
  AMAZON_SEND_PROVIDER?: Fetcher;
  MERCARI_INGESTION_PROVIDER?: Fetcher;
  RAKUTEN_INGESTION_PROVIDER?: Fetcher;
  AMAZON_INGESTION_PROVIDER?: Fetcher;
  MERCARI_SEND_EXPECTED_SHA?: string;
  RAKUTEN_SEND_EXPECTED_SHA?: string;
  AMAZON_SEND_EXPECTED_SHA?: string;
  /** Static frontend assets binding (Vite build output). */
  ASSETS?: Fetcher;
}

/** RecoverableError — thrown by processMercariTransaction when a non-fatal
 *  failure occurs that should skip the current transaction but NOT crash the
 *  entire run. Currently only used for sendReply failures.
 *
 *  Callers (handler.ts loop) should catch this and continue to the next tx.
 *  All other errors are fatal and should propagate. */
export class RecoverableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecoverableError";
  }
}
