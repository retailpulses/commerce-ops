import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMocks = vi.hoisted(() => ({ listInquiries: vi.fn() }));

vi.mock("../../_lib/supabase", () => ({
  createSupabaseClient: () => ({ listInquiries: supabaseMocks.listInquiries }),
}));

import { onRequestGet } from "../inquiries/index";

const env: Record<string, string> = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "secret",
};

function getRequest(query: string): Request {
  return new Request(`https://ops.example.com/inquiry/api/inquiries?${query}`);
}

beforeEach(() => {
  supabaseMocks.listInquiries.mockReset();
  supabaseMocks.listInquiries.mockResolvedValue({
    data: [],
    hasMore: false,
    nextCursor: null,
  });
});

describe("GET /api/inquiries expected value range parsing", () => {
  it("passes min and max bounds through to listInquiries", async () => {
    const response = await onRequestGet({
      request: getRequest("minExpectedValue=100&maxExpectedValue=500"),
      env,
    });

    expect(response.status).toBe(200);
    const params = supabaseMocks.listInquiries.mock.calls[0][0];
    expect(params.minExpectedValue).toBe(100);
    expect(params.maxExpectedValue).toBe(500);
  });

  it("treats blank and absent bounds as unset", async () => {
    const response = await onRequestGet({
      request: getRequest("minExpectedValue=%20&maxExpectedValue="),
      env,
    });

    expect(response.status).toBe(200);
    const params = supabaseMocks.listInquiries.mock.calls[0][0];
    expect(params.minExpectedValue).toBeUndefined();
    expect(params.maxExpectedValue).toBeUndefined();
  });

  it("rejects non-finite bounds with 400", async () => {
    const response = await onRequestGet({
      request: getRequest("minExpectedValue=abc"),
      env,
    });

    expect(response.status).toBe(400);
    expect(supabaseMocks.listInquiries).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid expected value bound"),
    });
  });

  it("rejects negative bounds with 400", async () => {
    const response = await onRequestGet({
      request: getRequest("maxExpectedValue=-1"),
      env,
    });

    expect(response.status).toBe(400);
    expect(supabaseMocks.listInquiries).not.toHaveBeenCalled();
  });

  it("rejects min > max with 400", async () => {
    const response = await onRequestGet({
      request: getRequest("minExpectedValue=500&maxExpectedValue=100"),
      env,
    });

    expect(response.status).toBe(400);
    expect(supabaseMocks.listInquiries).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "minExpectedValue must be less than or equal to maxExpectedValue",
    });
  });
});
