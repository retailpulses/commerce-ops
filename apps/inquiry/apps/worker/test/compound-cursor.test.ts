import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapter: {
    fetchInquiries: vi.fn(),
    fetchInquiryByIds: vi.fn(),
    patchInquiry: vi.fn(),
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

import { runMasterHandler } from "../src/jobs/master-handler";

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    baserow_row_id: null,
    status: "received",
    automation_status: "new",
    follow_up_status: "open",
    inquiry_type: null,
    source: "mercari_shops",
    external_inquiry_id: null,
    url: null,
    shop_key: "shop1",
    inquiry_date: "2026-07-21T01:00:00Z",
    inquiry_body: "商品について質問です",
    customer_nickname: "お客様",
    product_name_snapshot: null,
    last_inbound_time: "2026-07-21T01:00:00Z",
    last_custom_message: "商品について質問です",
    message_log_raw: null,
    order_id: null,
    reply_strategy: null,
    draft_reply: null,
    inquiry_skill_reply: null,
    reply_drafted_at: null,
    ai_copywritten_reply: null,
    ai_copywritten_at: null,
    product_links_reviewed_at: null,
    created_at: "2026-07-21T01:00:00Z",
    updated_at: "2026-07-21T01:00:00Z",
    ...overrides,
  };
}

function env() {
  const state = {
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
    updateRunMetadata: vi.fn(async () => undefined),
    getCursor: vi.fn(async () => null as string | null),
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
    INQUIRY_AUTOMATION_WRITES_ENABLED: "true",
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
  mocks.adapter.patchInquiry.mockResolvedValue(undefined);
});

describe("compound cursor pagination", () => {
  it("passes a compound cursor to fetchInquiries when one is stored", async () => {
    const testEnv = env();
    testEnv.state.getCompoundCursor.mockResolvedValue({
      inquiryDate: "2026-08-01T03:00:00Z",
      id: 42,
    });

    const inquiries = [
      inquiry({ id: 43, inquiry_date: "2026-08-01T03:00:00Z" }),
      inquiry({ id: 44, inquiry_date: "2026-08-01T03:00:01Z" }),
    ];
    mocks.adapter.fetchInquiries.mockResolvedValue(inquiries);

    await runMasterHandler(testEnv.value, { dryRun: false, limit: 10 });

    expect(mocks.adapter.fetchInquiries).toHaveBeenCalledOnce();
    const callArgs = mocks.adapter.fetchInquiries.mock.calls[0];
    // 4th argument is compoundCursor
    const passedCursor: Record<string, unknown> | undefined = callArgs[3];
    expect(passedCursor).toBeDefined();
    expect(passedCursor!.inquiryDate).toBe("2026-08-01T03:00:00Z");
    expect(passedCursor!.id).toBe(42);
  });

  it("passes undefined compound cursor when none is stored (first run)", async () => {
    const testEnv = env();
    testEnv.state.getCompoundCursor.mockResolvedValue(null);

    await runMasterHandler(testEnv.value, { dryRun: false, limit: 10 });

    expect(mocks.adapter.fetchInquiries).toHaveBeenCalledOnce();
    const callArgs = mocks.adapter.fetchInquiries.mock.calls[0];
    expect(callArgs[3]).toBeUndefined(); // compoundCursor is undefined
  });

  it("advances compound cursor with inquiry_date and id after successful write", async () => {
    const testEnv = env();
    testEnv.state.getCompoundCursor.mockResolvedValue(null);

    const row = inquiry({
      id: 99,
      inquiry_date: "2026-08-02T05:00:00Z",
      automation_status: "new",
    });
    mocks.adapter.fetchInquiries.mockResolvedValue([row]);

    await runMasterHandler(testEnv.value, { dryRun: false, limit: 10 });

    expect(testEnv.state.setCompoundCursor).toHaveBeenCalledOnce();
    const cursorArg = testEnv.state.setCompoundCursor.mock.calls[0][0];
    expect(cursorArg.id).toBe(99);
    expect(cursorArg.inquiryDate).toBeTruthy();
    // inquiry_date should be in UTC ISO format
    expect(cursorArg.inquiryDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("does not advance cursor on dry-run", async () => {
    const testEnv = env();
    testEnv.state.getCompoundCursor.mockResolvedValue(null);

    await runMasterHandler(testEnv.value, { dryRun: true, limit: 10 });

    expect(testEnv.state.setCompoundCursor).not.toHaveBeenCalled();
  });

  it("does not advance cursor when writes are disabled", async () => {
    const testEnv = env();
    // Override writes to disabled
    const value = { ...testEnv.value, INQUIRY_AUTOMATION_WRITES_ENABLED: "false" };
    testEnv.state.getCompoundCursor.mockResolvedValue(null);

    await runMasterHandler(value, { dryRun: false, limit: 10 });

    expect(testEnv.state.setCompoundCursor).not.toHaveBeenCalled();
  });
});

describe("compound cursor — equal-timestamp boundary safety", () => {
  it("processes all same-timestamp rows without omission across a batch boundary", async () => {
    const testEnv = env();

    // Simulate 5 rows all with the same inquiry_date
    const sameTimestamp = "2026-08-03T00:00:00Z";
    const allRows = Array.from({ length: 5 }, (_, i) =>
      inquiry({
        id: 101 + i,
        inquiry_date: sameTimestamp,
        automation_status: "new",
      }),
    );

    // First run with batch limit 2: returns rows 101, 102
    const firstBatch = allRows.slice(0, 2);
    testEnv.state.getCompoundCursor.mockResolvedValue(null);
    mocks.adapter.fetchInquiries.mockResolvedValueOnce(firstBatch);

    await runMasterHandler(testEnv.value, { dryRun: false, limit: 2 });

    // Cursor should have advanced to (sameTimestamp, id=102)
    expect(testEnv.state.setCompoundCursor).toHaveBeenCalledTimes(2);
    const lastCall = testEnv.state.setCompoundCursor.mock.calls[1][0];
    expect(lastCall.id).toBe(102);

    // Second run: cursor picks up from (sameTimestamp, id=102)
    testEnv.state.getCompoundCursor.mockResolvedValue({
      inquiryDate: lastCall.inquiryDate,
      id: 102,
    });

    const secondBatch = allRows.slice(2, 4); // rows 103, 104
    mocks.adapter.fetchInquiries.mockResolvedValueOnce(secondBatch);

    vi.clearAllMocks();
    testEnv.state.setCompoundCursor.mockClear();
    mocks.adapter.patchInquiry.mockClear();

    await runMasterHandler(testEnv.value, { dryRun: false, limit: 2 });

    // Should have fetched rows 103, 104 — no gap at boundary
    const fetchArgs = mocks.adapter.fetchInquiries.mock.calls[0];
    const passedCursor = fetchArgs[3];
    expect(passedCursor!.id).toBe(102);
    expect(passedCursor!.inquiryDate).toBe(lastCall.inquiryDate);
    expect(testEnv.state.setCompoundCursor).toHaveBeenCalledTimes(2);
  });
});

describe("compound cursor — legacy fallback", () => {
  it("returns { inquiryDate, id: 0 } when only legacy cursor exists", async () => {
    const testEnv = env();
    testEnv.state.getCompoundCursor.mockResolvedValue({
      inquiryDate: "2026-07-15T00:00:00Z",
      id: 0,
    });

    await runMasterHandler(testEnv.value, { dryRun: false, limit: 10 });

    const callArgs = mocks.adapter.fetchInquiries.mock.calls[0];
    const passedCursor = callArgs[3];
    expect(passedCursor!.inquiryDate).toBe("2026-07-15T00:00:00Z");
    expect(passedCursor!.id).toBe(0);
  });
});

describe("compound cursor — partial failure safety", () => {
  it("does not advance cursor past rows that failed to write", async () => {
    const testEnv = env();
    testEnv.state.getCompoundCursor.mockResolvedValue(null);

    const rows = [
      inquiry({ id: 201, inquiry_date: "2026-08-04T01:00:00Z", automation_status: "new" }),
      inquiry({ id: 202, inquiry_date: "2026-08-04T01:00:00Z", automation_status: "new" }),
    ];
    mocks.adapter.fetchInquiries.mockResolvedValue(rows);

    // First write succeeds, second fails (error caught inside handler loop)
    mocks.adapter.patchInquiry
      .mockResolvedValueOnce(undefined) // row 201 succeeds
      .mockRejectedValueOnce(new Error("write timeout")); // row 202 fails

    const result = await runMasterHandler(testEnv.value, { dryRun: false, limit: 10 });

    // Handler completes without throwing; partial failure reported in result
    expect(result.status).toBe("partial_failure");
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.errorSamples).toContain("write timeout");

    // Cursor should have been set for row 201 but NOT for row 202
    const cursorCalls = testEnv.state.setCompoundCursor.mock.calls;
    expect(cursorCalls.length).toBe(1);
    expect(cursorCalls[0][0].id).toBe(201);
  });
});
