import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapter: {
    fetchInquiries: vi.fn(),
    fetchInquiryByIds: vi.fn(),
    fetchProductLinks: vi.fn(),
    batchGetProducts: vi.fn(),
    searchProductsByTerms: vi.fn(),
    getProductByItemCode: vi.fn(),
    patchInquiry: vi.fn(),
    upsertProductLinks: vi.fn(),
  },
}));

vi.mock("../src/adapters/supabase", () => ({
  createSupabaseAdapter: () => mocks.adapter,
}));
vi.mock("../src/clients/openai", () => ({
  createOpenAIClient: () => ({ classifyInquiry: vi.fn() }),
}));
vi.mock("../src/clients/deepseek", () => ({
  createDeepSeekClient: () => ({ confirmBulkPurchase: vi.fn() }),
}));
vi.mock("../src/clients/wecom", () => ({
  createWeComClient: () => ({ sendInquiryAlert: vi.fn(), sendOperationalAlert: vi.fn() }),
}));

import { getConfig } from "../src/config";
import { runMasterHandler } from "../src/jobs/master-handler";

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    baserow_row_id: null,
    status: "received",
    automation_status: "new",
    follow_up_status: "open",
    inquiry_type: "price_negotiation",
    source: "mercari_shops",
    external_inquiry_id: "external-1",
    url: "https://mercari-shops.com/seller/shops/X/inquiries/1",
    shop_key: "shop1",
    inquiry_date: "2026-07-21T01:00:00Z",
    inquiry_body: "値下げできますか",
    customer_nickname: "お客様",
    product_name_snapshot: null,
    last_inbound_time: "2026-07-21T01:00:00Z",
    last_custom_message: "値下げできますか",
    message_log_raw: null,
    order_id: null,
    reply_strategy: null,
    draft_reply: null,
    inquiry_skill_reply: null,
    reply_drafted_at: null,
    ai_copywritten_reply: null,
    ai_copywritten_at: null,
    created_at: "2026-07-21T01:00:00Z",
    updated_at: "2026-07-21T01:00:00Z",
    ...overrides,
  };
}

function env(writesValue?: string) {
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
  const value = {
    SUPABASE_URL: "http://127.0.0.1:55431",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-key",
    OPENAI_API_KEY: "test",
    DEEPSEEK_API_KEY: "test",
    WECOM_WEBHOOK_URL: "",
    ADMIN_TOKEN: "test",
    SHOP_CACHE_TTL_SECONDS: "0",
    MASTER_HANDLER_DEFAULT_CURSOR: "2026-07-01T00:00:00Z",
    DRY_RUN: "false",
    FORCE_REGENERATE: "false",
    MAX_ROWS_PER_RUN: "20",
    LLM_MAX_CALLS_PER_RUN: "0",
    INQUIRY_AUTOMATION_WRITES_ENABLED: writesValue,
    JOB_STATE: {
      idFromName: vi.fn(() => "state-id"),
      get: vi.fn(() => state),
    },
  };
  return { value: value as never, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.fetchInquiries.mockResolvedValue([inquiry()]);
  mocks.adapter.fetchInquiryByIds.mockResolvedValue([inquiry()]);
  mocks.adapter.fetchProductLinks.mockResolvedValue([]);
  mocks.adapter.batchGetProducts.mockResolvedValue([]);
  mocks.adapter.searchProductsByTerms.mockResolvedValue([]);
  mocks.adapter.getProductByItemCode.mockResolvedValue(null);
  mocks.adapter.patchInquiry.mockResolvedValue(undefined);
  mocks.adapter.upsertProductLinks.mockResolvedValue(undefined);
});

describe("fail-closed runtime state", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "does not advance the cursor when writes switch is %s",
    async (writesValue) => {
      const testEnv = env(writesValue);
      expect(getConfig(testEnv.value).runtime.writesEnabled).toBe(false);
      await runMasterHandler(testEnv.value, { dryRun: false, limit: 1 });
      expect(testEnv.state.setCompoundCursor).not.toHaveBeenCalled();
      expect(mocks.adapter.patchInquiry).not.toHaveBeenCalled();
    },
  );

  it("does not advance the cursor in dry-run mode", async () => {
    const testEnv = env("true");
    await runMasterHandler(testEnv.value, { dryRun: true, limit: 1 });
    expect(testEnv.state.setCompoundCursor).not.toHaveBeenCalled();
  });

  it("advances the cursor only after a write-enabled non-dry run", async () => {
    const testEnv = env("true");
    await runMasterHandler(testEnv.value, { dryRun: false, limit: 1 });
    expect(testEnv.state.setCompoundCursor).toHaveBeenCalledOnce();
  });
});

describe("retired automatic product linkage", () => {
  it("classifies an inquiry without searching for or linking a product", async () => {
    const testEnv = env("true");
    mocks.adapter.fetchInquiries.mockResolvedValue([
      inquiry({ inquiry_type: null, product_name_snapshot: "ABC123 商品" }),
    ]);
    await runMasterHandler(testEnv.value, { dryRun: false, limit: 1 });

    expect(mocks.adapter.patchInquiry).toHaveBeenCalledOnce();
    const payload = mocks.adapter.patchInquiry.mock.calls[0][1];
    expect(payload.automation_status).toBe("classified");
    expect(mocks.adapter.fetchProductLinks).not.toHaveBeenCalled();
    expect(mocks.adapter.batchGetProducts).not.toHaveBeenCalled();
    expect(mocks.adapter.searchProductsByTerms).not.toHaveBeenCalled();
    expect(mocks.adapter.getProductByItemCode).not.toHaveBeenCalled();
    expect(mocks.adapter.upsertProductLinks).not.toHaveBeenCalled();
  });
});
