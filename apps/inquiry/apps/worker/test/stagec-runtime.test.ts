import { describe, expect, it, vi } from "vitest";

import { runMasterHandler } from "../src/jobs/master-handler";

declare const __STAGE_C_REST_URL__: string;
declare const __STAGE_C_SERVICE_ROLE_KEY__: string;
const restUrl = __STAGE_C_REST_URL__;
const serviceRoleKey = __STAGE_C_SERVICE_ROLE_KEY__;
const stageC = restUrl && serviceRoleKey ? it : it.skip;

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${restUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

describe("Stage C local PostgREST runtime", () => {
  stageC("classifies without automatically linking or drafting", async () => {
    const suffix = String(Date.now());
    const productVariantId = crypto.randomUUID();
    const itemCode = `STAGEC${suffix}`;
    let inquiryId: number | null = null;
    const originalFetch = globalThis.fetch;

    try {
      await api("/product_variants", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id: productVariantId,
          sku: itemCode,
          item_code: itemCode,
          variant_name: "Stage C 日本語テスト商品",
          stock_qty: 3,
          status: "active",
        }),
      });
      const created = await api("/inquiries", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          source: "mercari_shops",
          external_inquiry_id: `stage-c-${suffix}`,
          shop_key: "shop1",
          status: "received",
          automation_status: "new",
          inquiry_type: null,
          inquiry_date: "2026-07-21T01:00:00Z",
          inquiry_body: "送料について教えてください",
          last_custom_message: "送料について教えてください",
          last_inbound_time: "2026-07-21T01:00:00Z",
          customer_nickname: "ステージC顧客",
          product_name_snapshot: `${itemCode} 日本語商品`,
        }),
      }) as { id: number }[];
      inquiryId = created[0].id;

      const state = {
        acquireLock: vi.fn(async () => true),
        releaseLock: vi.fn(async () => undefined),
        updateRunMetadata: vi.fn(async () => undefined),
        getCursor: vi.fn(async () => null),
        setCursor: vi.fn(async () => undefined),
        getCompoundCursor: vi.fn(async () => null as { inquiryDate: string; id: number } | null),
        setCompoundCursor: vi.fn(async () => undefined),
        appendRunHistory: vi.fn(async () => undefined),
        getRecentRunHistory: vi.fn(async () => []),
        recordLockBlocked: vi.fn(async () => false),
        trySendAlert: vi.fn(async () => false),
        renewLock: vi.fn(async () => undefined),
      };
      const env = {
        SUPABASE_URL: restUrl,
        SUPABASE_REST_URL: restUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        OPENAI_API_KEY: "stage-c-not-used",
        DEEPSEEK_API_KEY: "stage-c-not-used",
        WECOM_WEBHOOK_URL: "",
        ADMIN_TOKEN: "stage-c-local",
        SHOP_CACHE_TTL_SECONDS: "0",
        MASTER_HANDLER_DEFAULT_CURSOR: "2026-07-01T00:00:00Z",
        DRY_RUN: "false",
        FORCE_REGENERATE: "false",
        MAX_ROWS_PER_RUN: "5",
        LLM_MAX_CALLS_PER_RUN: "0",
        INQUIRY_AUTOMATION_WRITES_ENABLED: "true",
        INQUIRY_EXTERNAL_NOTIFICATIONS_ENABLED: "false",
        JOB_STATE: {
          idFromName: vi.fn(() => "stage-c-state"),
          get: vi.fn(() => state),
        },
      } as never;

      const requests: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        requests.push(typeof input === "string" ? input : input.url);
        return originalFetch(input, init);
      });
      await runMasterHandler(env, { inquiryIds: [inquiryId], limit: 1 });

      const afterMaster = await api(`/inquiries?id=eq.${inquiryId}&select=status,automation_status,inquiry_type`);
      expect(afterMaster[0]).toEqual({
        status: "received",
        automation_status: "classified",
        inquiry_type: "shipping_related",
      });
      const links = await api(`/inquiry_product_links?inquiry_id=eq.${inquiryId}&select=product_variant_id,link_source,is_primary`);
      expect(links).toEqual([]);
      expect(requests.filter((url) => url.includes("/product_variants")).length).toBe(0);

      const afterClassification = await api(`/inquiries?id=eq.${inquiryId}&select=inquiry_skill_reply`);
      expect(afterClassification[0].inquiry_skill_reply).toBeNull();
    } finally {
      vi.restoreAllMocks();
      if (inquiryId !== null) {
        await api(`/inquiries?id=eq.${inquiryId}`, { method: "DELETE" });
      }
      await api(`/product_variants?id=eq.${productVariantId}`, { method: "DELETE" });
    }
  });
});
