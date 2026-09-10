import { describe, expect, it, vi } from "vitest";
import {
  InquiryFreshReadError,
  readFullThread,
  refreshMercariInquiry,
} from "../inquiry-fresh-read";
import type { MercariRelayClient } from "../mercari-relay";

function relay(overrides: Partial<MercariRelayClient> = {}): MercariRelayClient {
  return {
    inquiry: vi.fn().mockResolvedValue({
      id: "inq-1",
      status: "AWAITING_BUYER",
      salesChannel: "MERCARI_SHOPS",
      firstOpenedAt: "2026-09-01T00:00:00Z",
      lastActivityAt: "2026-09-02T00:00:00Z",
      target: {
        __typename: "InquiryProductTarget",
        productId: "product-1",
        productVariantId: null,
        shopId: null,
        orderTransaction: null,
      },
    }),
    inquiryMessages: vi.fn(),
    inquiryMessagesPage: vi.fn()
      .mockResolvedValueOnce({
        messages: [{ messageId: "message-1", body: "question", sentAt: "2026-09-01T00:00:00Z", from: "BUYER", status: "ACTIVE" }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        messages: [{ messageId: "message-2", body: "answer", sentAt: "2026-09-02T00:00:00Z", from: "SELLER", status: "ACTIVE" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    addInquiryMessage: vi.fn(),
    ...overrides,
  };
}

describe("Mercari inquiry detail fresh read", () => {
  it("fully paginates, reconciles through the canonical RPC, and never sends", async () => {
    const mercari = relay();
    const rpc = vi.fn().mockResolvedValue({
      inquiryId: 41,
      inquiryCreated: false,
      inquiryChanged: true,
      messagesCreated: 2,
      messagesChanged: 0,
      rowsWritten: 3,
    });

    const result = await refreshMercariInquiry(
      { relay: mercari, supabase: { rpc } },
      "shop1",
      "inq-1",
    );

    expect(result).toEqual({ route: "inquiry", inquiryId: 41, rowsWritten: 3 });
    expect(mercari.inquiryMessagesPage).toHaveBeenNthCalledWith(1, "shop1", "inq-1", { first: 50, after: null });
    expect(mercari.inquiryMessagesPage).toHaveBeenNthCalledWith(2, "shop1", "inq-1", { first: 50, after: "cursor-1" });
    expect(rpc).toHaveBeenCalledWith("inquiry_reconcile_api_thread", expect.objectContaining({
      p_inquiry: expect.objectContaining({ external_inquiry_id: "inq-1", external_target_type: "InquiryProductTarget" }),
      p_messages: expect.arrayContaining([
        expect.objectContaining({ external_message_id: "message-1", direction: "inbound" }),
        expect.objectContaining({ external_message_id: "message-2", direction: "outbound" }),
      ]),
    }));
    expect(mercari.addInquiryMessage).not.toHaveBeenCalled();
  });

  it("fails closed when the relay read fails", async () => {
    const mercari = relay({ inquiry: vi.fn().mockRejectedValue(new Error("upstream detail")) });
    const rpc = vi.fn();

    await expect(refreshMercariInquiry(
      { relay: mercari, supabase: { rpc } },
      "shop1",
      "inq-1",
    )).rejects.toMatchObject({ code: "readback_failed", status: 502 });
    expect(rpc).not.toHaveBeenCalled();
    expect(mercari.addInquiryMessage).not.toHaveBeenCalled();
  });

  it("fails closed and does not reconcile an order target", async () => {
    const mercari = relay({
      inquiry: vi.fn().mockResolvedValue({
        id: "inq-order",
        status: "AWAITING_BUYER",
        salesChannel: "MERCARI_SHOPS",
        firstOpenedAt: null,
        lastActivityAt: null,
        target: {
          __typename: "InquiryOrderTransactionTarget",
          productId: null,
          productVariantId: null,
          shopId: null,
          orderTransaction: { id: "order-1" },
        },
      }),
      inquiryMessagesPage: vi.fn().mockResolvedValue({ messages: [], pageInfo: { hasNextPage: false, endCursor: null } }),
    });
    const rpc = vi.fn();

    await expect(refreshMercariInquiry(
      { relay: mercari, supabase: { rpc } },
      "shop1",
      "inq-order",
    )).rejects.toEqual(expect.objectContaining<Partial<InquiryFreshReadError>>({
      code: "order_target",
      status: 409,
    }));
    expect(rpc).not.toHaveBeenCalled();
    expect(mercari.addInquiryMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed or unbounded pagination", async () => {
    const mercari = relay({
      inquiryMessagesPage: vi.fn().mockResolvedValue({
        messages: [],
        pageInfo: { hasNextPage: true, endCursor: null },
      }),
    });

    await expect(readFullThread(mercari, "shop1", "inq-1", 2))
      .rejects.toMatchObject({ code: "pagination_exceeded", status: 502 });
  });
});
