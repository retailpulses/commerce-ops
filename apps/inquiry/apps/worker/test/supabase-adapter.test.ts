import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseAdapter } from "../src/adapters/supabase";

function response(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adapter() {
  return createSupabaseAdapter({
    url: "https://stage-c.invalid",
    serviceRoleKey: "local-test-key",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Supabase adapter", () => {
  it("does not retry non-transient PostgREST failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message: "bad request" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter().fetchInquiryByIds([42])).rejects.toThrow("failed (400)");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

});
