import { describe, expect, it } from "vitest";

import { routeInquiryTarget, isPresalesInquiry } from "../src/mercari/router";

describe("routeInquiryTarget", () => {
  it("routes product targets to the inquiry cohort", () => {
    const decision = routeInquiryTarget({
      __typename: "InquiryProductTarget",
      productId: "p1",
      productVariantId: null,
    });
    expect(decision.route).toBe("inquiry");
    expect(isPresalesInquiry(decision)).toBe(true);
  });

  it("routes shop targets to the inquiry cohort", () => {
    const decision = routeInquiryTarget({ __typename: "InquiryShopTarget" });
    expect(decision.route).toBe("inquiry");
  });

  it("routes order-transaction targets to ticketing (authority)", () => {
    const decision = routeInquiryTarget({
      __typename: "InquiryOrderTransactionTarget",
      orderTransaction: { id: "ot-1" },
    });
    expect(decision.route).toBe("ticketing");
  });

  it("treats a present orderTransaction as authority even without typename", () => {
    const decision = routeInquiryTarget({
      __typename: "InquiryShopTarget",
      orderTransaction: { id: "ot-2" },
    });
    expect(decision.route).toBe("ticketing");
  });

  it("quarantines a product/shop target with a conflicting order id hint", () => {
    const decision = routeInquiryTarget(
      { __typename: "InquiryProductTarget", productId: "p1" },
      "order-123",
    );
    expect(decision.route).toBe("quarantine");
    expect(decision.reason).toBe("order_id_hint_conflict");
  });

  it("quarantines unknown targets", () => {
    expect(routeInquiryTarget({ __typename: "WeirdTarget" }).route).toBe("quarantine");
    expect(routeInquiryTarget(null).route).toBe("quarantine");
  });
});
