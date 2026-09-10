import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bodyHash,
  createFollowUpClient,
  outboundIdempotencyKey,
} from "../follow-ups";
import type { DashboardConfig } from "../config";

function config(): DashboardConfig {
  return {
    supabase: {
      url: "https://test.supabase.co",
      restUrl: "",
      serviceRoleKey: "secret",
    },
    openai: { apiKey: "", model: "gpt-4o" },
    auth: { teamDomain: "", audience: "", allowedEmails: "" },
    productCatalog: { table: "product_variants", schema: "public" },
    mutationsEnabled: true,
    catalogOwner: { apiUrl: "", token: "" },
    mercariRelay: { url: "", token: "" },
    outboundSendEnabled: true,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("outboundIdempotencyKey", () => {
  it("is deterministic and stable", async () => {
    const k = () =>
      outboundIdempotencyKey({
        shopKey: "shop1",
        externalInquiryId: "inq-1",
        cycleId: "11111111-1111-1111-1111-111111111111",
        operationVersion: 1,
      });
    expect(await k()).toBe(await k());
  });

  it("uses the reply sentinel for the initial reply cycle", async () => {
    const a = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: null,
      operationVersion: 1,
    });
    const b = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: "reply",
      operationVersion: 1,
    });
    expect(a).toBe(b);
  });

  it("matches the worker contract (sha256 hex)", async () => {
    const key = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: null,
      operationVersion: 1,
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("bodyHash", () => {
  it("hashes content stably", async () => {
    expect(await bodyHash("abc")).toBe(await bodyHash("abc"));
    expect(await bodyHash("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createFollowUpClient.listFollowUps", () => {
  it("selects the correct view per bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createFollowUpClient(config());
    await client.listFollowUps("upcoming", null);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/follow_up_upcoming_vw?");
  });
});
