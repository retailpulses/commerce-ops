import { describe, expect, it } from "vitest";
import type { InquiryDetail } from "../../types/inquiry";
import { buildSummary } from "./InquirySummaryCard";

function inquiry(overrides: Partial<InquiryDetail>): InquiryDetail {
  return { id: 1, linkedProducts: [], productName: "", ...overrides } as InquiryDetail;
}

describe("Inquiry summary product name", () => {
  it("prefers the explicitly primary linked product", () => {
    const summary = buildSummary(inquiry({
      productName: "Snapshot",
      linkedProducts: [
        { productName: "First", isPrimary: false },
        { productName: "Primary", isPrimary: true },
      ] as InquiryDetail["linkedProducts"],
    }));
    expect(summary.productName).toBe("Primary");
  });

  it("falls back through first linked product, snapshot, and null", () => {
    expect(buildSummary(inquiry({ linkedProducts: [{ productName: "First", isPrimary: false }] as InquiryDetail["linkedProducts"] })).productName).toBe("First");
    expect(buildSummary(inquiry({ productName: "Snapshot" })).productName).toBe("Snapshot");
    expect(buildSummary(inquiry({})).productName).toBeNull();
  });
});
