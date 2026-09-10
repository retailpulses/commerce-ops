export interface Env {
  SHOP_CACHE: KVNamespace;
  JOB_STATE: DurableObjectNamespace<import("./state/JobStateDO").JobStateDO>;

  // ---- Supabase (active) ----
  SUPABASE_URL: string;
  /** Optional explicit PostgREST root for local Stage C; hosted runtime derives /rest/v1. */
  SUPABASE_REST_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  OPENAI_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  WECOM_WEBHOOK_URL: string;
  ADMIN_TOKEN: string;

  SHOP_CACHE_TTL_SECONDS: string;
  MASTER_HANDLER_DEFAULT_CURSOR: string;
  DRY_RUN: string;
  FORCE_REGENERATE: string;
  MAX_ROWS_PER_RUN: string;
  LLM_MAX_CALLS_PER_RUN: string;

  /** Fail-closed kill switch: writes run only when this is exactly "true". */
  INQUIRY_AUTOMATION_WRITES_ENABLED?: string;
  /** Fail-closed switch for outbound operator notifications. */
  INQUIRY_EXTERNAL_NOTIFICATIONS_ENABLED?: string;

  // ---- Mercari inquiry API-first (webhook ingest / daily audit / relay) ----
  MERCARI_RELAY_URL?: string;
  SHOP1_API_TOKEN?: string;
  SHOP2_API_TOKEN?: string;
  SHOP3_API_TOKEN?: string;
  SHOP4_API_TOKEN?: string;
  /** JSON map of shop_key -> webhook HMAC secret. */
  MERCARI_WEBHOOK_SECRETS?: string;
  MERCARI_WEBHOOK_SHARED_SECRET?: string;
  MERCARI_SHOP_ID_MAP?: string;
  MERCARI_WEBHOOK_SHOP_KEY_HEADER?: string;
  MERCARI_WEBHOOK_SIGNATURE_HEADER?: string;
  MERCARI_WEBHOOK_REPLAY_WINDOW_SECONDS?: string;
  /** Canonical ingest write kill switch. */
  INQUIRY_MERCARI_INGEST_WRITES_ENABLED?: string;
  /** Daily-audit repair write kill switch. */
  INQUIRY_COMPLETENESS_AUDIT_WRITES_ENABLED?: string;
  /** Least-privilege bearer used only by the bounded single-shop audit endpoint. */
  INQUIRY_AUDIT_ADMIN_TOKEN?: string;
  /** Outbound send kill switch. */
  INQUIRY_OUTBOUND_SEND_ENABLED?: string;
}
