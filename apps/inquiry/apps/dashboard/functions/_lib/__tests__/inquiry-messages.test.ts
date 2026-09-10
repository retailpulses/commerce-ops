import { describe, expect, it } from "vitest";
import { firstCustomerMessage, resolveInquiryBody } from "../inquiry-messages";

describe("inquiry message resolution", () => {
  it("keeps persisted operator content first", () => {
    expect(
      resolveInquiryBody(
        "Operator text",
        '[{"role":"customer","text":"First"}]',
        "Latest",
      ),
    ).toBe("Operator text");
  });

  it("uses the first explicitly customer-authored history message", () => {
    const raw = JSON.stringify([
      { role: "seller", text: "Welcome" },
      { role: "customer", text: "First question" },
      { role: "customer", text: "Follow-up" },
    ]);
    expect(firstCustomerMessage(raw)).toBe("First question");
    expect(resolveInquiryBody(null, raw, "Follow-up")).toBe("First question");
  });

  it("falls back to the known customer message for an unstructured history", () => {
    expect(
      resolveInquiryBody(null, "legacy raw log", "Only known customer message"),
    ).toBe("Only known customer message");
  });
});
