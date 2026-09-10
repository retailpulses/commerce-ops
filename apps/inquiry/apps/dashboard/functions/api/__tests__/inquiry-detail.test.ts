import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInquiryDetail: vi.fn(),
  lookupProduct: vi.fn(),
  rpc: vi.fn(),
  refresh: vi.fn(),
  getOutboundContext: vi.fn(),
  relay: {},
}));

vi.mock("../../_lib/supabase", () => ({
  createSupabaseClient: () => ({
    getInquiryDetail: mocks.getInquiryDetail,
    lookupProduct: mocks.lookupProduct,
    rpc: mocks.rpc,
  }),
}));
vi.mock("../../_lib/mercari-relay", () => ({
  createMercariRelayClient: () => mocks.relay,
}));
vi.mock("../../_lib/follow-ups", () => ({
  createFollowUpClient: () => ({ getOutboundContext: mocks.getOutboundContext }),
}));
vi.mock("../../_lib/inquiry-fresh-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../_lib/inquiry-fresh-read")>();
  return { ...actual, refreshMercariInquiry: mocks.refresh };
});

import { onRequestGet } from "../inquiries/[id]";

const env = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  MERCARI_RELAY_URL: "https://relay.example.test",
  SHOP1_API_TOKEN: "shop-token",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1010,
    source: "mercari_shops",
    external_inquiry_id: "inq-1",
    shop_key: "shop1",
    status: "answered",
    linked_products: [],
    linked_knowledge: [],
    extra: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookupProduct.mockResolvedValue(null);
  mocks.refresh.mockResolvedValue({ route: "inquiry", inquiryId: 1010, rowsWritten: 0 });
  mocks.getOutboundContext.mockResolvedValue(null);
});

describe("GET /api/inquiries/:id", () => {
  it("fresh-reads a Mercari thread and returns the re-read projection", async () => {
    mocks.getInquiryDetail
      .mockResolvedValueOnce(row({ last_custom_message: "stale" }))
      .mockResolvedValueOnce(row({ last_custom_message: "fresh" }));

    const response = await onRequestGet({
      request: new Request("https://ops.homesbliss.net/api/inquiries/1010"),
      env,
      params: { id: "1010" },
    });

    expect(response.status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ supabase: expect.any(Object) }),
      "shop1",
      "inq-1",
    );
    expect(mocks.getInquiryDetail).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({
      lastCustomMessage: "fresh",
      url: "https://mercari-shops.com/seller/shops/WMyisFmhbGWyVAPEwsfirn/inquiries/inq-1",
    });
  });

  it("returns persisted follow-up state from the detail projection", async () => {
    mocks.getInquiryDetail
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row());
    mocks.getOutboundContext.mockResolvedValue({
      follow_up_state: "scheduled",
      follow_up_due_date: "2026-09-07",
      follow_up_date_source: "auto_after_reply",
    });

    const response = await onRequestGet({
      request: new Request("https://ops.homesbliss.net/api/inquiries/1010"),
      env,
      params: { id: "1010" },
    });

    await expect(response.json()).resolves.toMatchObject({
      followUpState: "scheduled",
      followUpDueDate: "2026-09-07",
      followUpDateSource: "auto_after_reply",
    });
  });

  it("does not serve the stale projection when fresh read fails", async () => {
    mocks.getInquiryDetail.mockResolvedValue(row());
    const { InquiryFreshReadError } = await import("../../_lib/inquiry-fresh-read");
    mocks.refresh.mockRejectedValue(new InquiryFreshReadError("readback_failed", "Mercari fresh read failed", 502));

    const response = await onRequestGet({
      request: new Request("https://ops.homesbliss.net/api/inquiries/1010"),
      env,
      params: { id: "1010" },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Mercari fresh read failed",
      code: "readback_failed",
    });
    expect(mocks.getInquiryDetail).toHaveBeenCalledTimes(1);
  });

  it("keeps non-API legacy rows on the database read path", async () => {
    mocks.getInquiryDetail.mockResolvedValue(row({ source: "email", external_inquiry_id: null }));

    const response = await onRequestGet({
      request: new Request("https://ops.homesbliss.net/api/inquiries/1010"),
      env,
      params: { id: "1010" },
    });

    expect(response.status).toBe(200);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.getInquiryDetail).toHaveBeenCalledTimes(1);
  });
});
