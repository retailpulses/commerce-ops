import { describe, expect, it } from "vitest";

import { mapInquiry, mapMessage, directionFor } from "../src/mercari/mappers";

describe("directionFor", () => {
  it("maps BUYER to inbound and SELLER/ADMIN to outbound", () => {
    expect(directionFor("BUYER")).toBe("inbound");
    expect(directionFor("SELLER")).toBe("outbound");
    expect(directionFor("ADMIN")).toBe("outbound");
    expect(directionFor(null)).toBe("outbound");
  });
});

describe("mapInquiry", () => {
  it("normalizes readback discovery fields onto canonical columns", async () => {
    const out = await mapInquiry(
      {
        id: "inq-1",
        status: "AWAITING_SELLER",
        salesChannel: "mercari",
        firstOpenedAt: "2026-09-01T00:00:00Z",
        lastActivityAt: "2026-09-02T00:00:00Z",
        target: {
          __typename: "InquiryProductTarget",
          productId: "p1",
          productVariantId: "v1",
        },
      },
      "shop1",
      "webhook",
      null,
    );
    expect(out.shop_key).toBe("shop1");
    expect(out.external_inquiry_id).toBe("inq-1");
    expect(out.external_status).toBe("AWAITING_SELLER");
    expect(out.external_target_type).toBe("InquiryProductTarget");
    expect(out.external_product_id).toBe("p1");
    expect(out.external_product_variant_id).toBe("v1");
    expect(out.source).toBe("mercari_shops");
  });
});

describe("mapMessage", () => {
  it("normalizes an active buyer message as inbound", async () => {
    const out = await mapMessage(
      {
        id: "msg-1",
        inquiryId: "inq-1",
        body: "在庫ありますか？",
        from: "BUYER",
        sentAt: "2026-09-02T03:00:00Z",
        status: "ACTIVE",
      },
      42,
      "shop1",
      "inq-1",
      "webhook",
    );
    expect(out).not.toBeNull();
    expect(out!.direction).toBe("inbound");
    expect(out!.external_status).toBe("ACTIVE");
    expect(out!.deleted_at).toBeNull();
    expect(out!.source_payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tombs a deleted message", async () => {
    const out = await mapMessage(
      {
        id: "msg-2",
        body: "spam",
        from: "BUYER",
        status: "DELETED",
      },
      42,
      "shop1",
      "inq-1",
      "webhook",
    );
    expect(out!.external_status).toBe("DELETED");
    expect(out!.deleted_at).not.toBeNull();
  });

  it("returns null when no stable external message id exists", async () => {
    const out = await mapMessage(
      { id: "", body: "x", from: "BUYER" },
      42,
      "shop1",
      "inq-1",
      "webhook",
    );
    expect(out).toBeNull();
  });
});
