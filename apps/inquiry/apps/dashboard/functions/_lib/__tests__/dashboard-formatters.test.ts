import { describe, expect, it } from "vitest";

import { formatDateTimeJst } from "../../../src/utils/formatters";

describe("formatDateTimeJst", () => {
  it("renders the inquiry timestamp in JST to the minute", () => {
    expect(formatDateTimeJst("2026-09-01T03:34:56Z")).toBe("2026/09/01 12:34");
  });

  it("renders a missing timestamp as a placeholder", () => {
    expect(formatDateTimeJst(null)).toBe("--");
  });
});
