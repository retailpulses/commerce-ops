// ── Unit tests for timezone.mjs ────────────────────────────────
import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import {
  getJstDateParts,
  formatJstDate,
  getJstEarliestDeliveryDate,
} from "../timezone.mjs";

describe("getJstDateParts", () => {
  it("UTC midnight → JST 09:00", () => {
    const parts = getJstDateParts(new Date("2026-06-12T00:00:00Z"));
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 6);
    assert.equal(parts.day, 12);
    assert.equal(parts.hour, 9);
    assert.equal(parts.minute, 0);
  });

  it("UTC 14:00 → JST 23:00", () => {
    const parts = getJstDateParts(new Date("2026-06-12T14:00:00Z"));
    assert.equal(parts.day, 12);
    assert.equal(parts.hour, 23);
  });

  it("ISO string with +09:00 offset", () => {
    const parts = getJstDateParts("2026-06-12T09:00:00+09:00");
    assert.equal(parts.hour, 9);
    assert.equal(parts.minute, 0);
  });

  it("date-only string", () => {
    const parts = getJstDateParts("2026-06-12");
    // Node.js parses date-only as UTC midnight → JST 09:00
    assert.equal(parts.hour, 9);
  });

  it("handles already-JST timestamp correctly", () => {
    // Noon JST = 03:00 UTC
    const parts = getJstDateParts(new Date("2026-06-12T03:00:00Z"));
    // JST = UTC+9 → 12:00
    assert.equal(parts.hour, 12);
  });
});

describe("formatJstDate", () => {
  it("formats JST date as YYYY-MM-DD", () => {
    assert.equal(formatJstDate("2026-06-12T09:00:00+09:00"), "2026-06-12");
  });

  it("handles UTC date correctly (adding 9h puts it in next day)", () => {
    // 2026-01-01 23:00 UTC = 2026-01-02 08:00 JST
    assert.equal(formatJstDate("2026-01-01T23:00:00Z"), "2026-01-02");
  });

  it("returns empty for invalid input", () => {
    assert.equal(formatJstDate("not-a-date"), "");
  });
});

describe("getJstEarliestDeliveryDate", () => {
  it("returns a valid YYYY-MM-DD string", () => {
    const result = getJstEarliestDeliveryDate();
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a future date (at least 3 days ahead)", () => {
    const result = getJstEarliestDeliveryDate();
    const [y, m, d] = result.split("-").map(Number);
    const resultDate = new Date(Date.UTC(y, m - 1, d));
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 86400000);
    // Result should be within ~4 days from now (allowing for JST shift)
    const diffDays = (resultDate.getTime() - now.getTime()) / 86400000;
    assert.ok(diffDays >= 2 && diffDays <= 5, `expected 2–5 days ahead, got ~${diffDays.toFixed(1)} days`);
  });

  it("is a valid calendar date", () => {
    const result = getJstEarliestDeliveryDate();
    const [y, m, d] = result.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    assert.equal(parsed.getUTCFullYear(), y);
    assert.equal(parsed.getUTCMonth(), m - 1);
    assert.equal(parsed.getUTCDate(), d);
  });
});
