import { describe, expect, it } from "vitest";

import {
  contentHash,
  eventIdentity,
  outboundIdempotencyKey,
  timingSafeEqual,
  INITIAL_REPLY_CYCLE,
} from "../src/mercari/identity";

describe("eventIdentity", () => {
  it("prefers the external event id over the deterministic fallback", async () => {
    const id = await eventIdentity({
      shopKey: "shop1",
      topic: "INQUIRY_MESSAGE_CREATED",
      externalEventId: "evt-123",
      externalInquiryId: "inq-1",
      externalMessageId: "msg-1",
      occurredAt: "2026-09-03T00:00:00Z",
    });
    expect(id).toBe("evt:shop1:INQUIRY_MESSAGE_CREATED:evt-123");
  });

  it("produces a deterministic fallback when no event id exists", async () => {
    const input = {
      shopKey: "shop2",
      topic: "INQUIRY_RESOLVED",
      externalInquiryId: "inq-9",
      externalMessageId: null,
      occurredAt: "2026-09-03T01:00:00Z",
    };
    const a = await eventIdentity(input);
    const b = await eventIdentity(input);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("fallback differs when any identity component differs", async () => {
    const base = {
      shopKey: "shop3",
      topic: "INQUIRY_MESSAGE_ADMIN_DELETED",
      externalMessageId: null,
      occurredAt: "2026-09-03T01:00:00Z",
    };
    const a = await eventIdentity({ ...base, externalInquiryId: "inq-1" });
    const b = await eventIdentity({ ...base, externalInquiryId: "inq-2" });
    expect(a).not.toBe(b);
  });
});

describe("outboundIdempotencyKey", () => {
  it("is deterministic and stable for the same logical send", async () => {
    const key = () =>
      outboundIdempotencyKey({
        shopKey: "shop1",
        externalInquiryId: "inq-1",
        cycleId: "11111111-1111-1111-1111-111111111111",
        operationVersion: 1,
      });
    expect(await key()).toBe(await key());
  });

  it("uses the reply sentinel for the initial reply cycle", async () => {
    const withCycle = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: null,
      operationVersion: 1,
    });
    const explicit = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: INITIAL_REPLY_CYCLE,
      operationVersion: 1,
    });
    expect(withCycle).toBe(explicit);
  });

  it("differs across operation versions", async () => {
    const v1 = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: null,
      operationVersion: 1,
    });
    const v2 = await outboundIdempotencyKey({
      shopKey: "shop1",
      externalInquiryId: "inq-1",
      cycleId: null,
      operationVersion: 2,
    });
    expect(v1).not.toBe(v2);
  });
});

describe("contentHash", () => {
  it("is a stable sha256 hex", async () => {
    const h = await contentHash("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await contentHash("hello"));
  });
});

describe("timingSafeEqual", () => {
  it("compares equal and unequal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});
