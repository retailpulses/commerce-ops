import { describe, expect, it } from "vitest";
import { resolveWindow } from "../metrics";

describe("metrics window", () => {
  it("uses JST current-month boundary", () => {
    expect(resolveWindow("current_month", new Date("2026-08-31T06:00:00Z")).start).toBe("2026-07-31T15:00:00.000Z");
  });
  it("rejects unknown windows", () => expect(() => resolveWindow("year")).toThrow("invalid_metrics_window"));
});
