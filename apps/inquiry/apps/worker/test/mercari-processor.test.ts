import { describe, expect, it, vi } from "vitest";

import { runDailyAudit } from "../src/mercari/audit";
import type { MercariPersistence } from "../src/mercari/persistence";
import { processNextEvent } from "../src/mercari/processor";
import type { MercariTransport } from "../src/mercari/relay";

function persistence(overrides: Partial<MercariPersistence> = {}): MercariPersistence {
  return {
    recordWebhookEvent: vi.fn(),
    claimWebhookEvent: vi.fn(async () => ({
      id: 1,
      event_identity: "evt-1",
      shop_key: "shop1",
      topic: "INQUIRY_MESSAGE_CREATED",
      external_event_id: "external-event-1",
      external_inquiry_id: "inq-1",
      external_message_id: "buyer-1",
      schema_version: null,
      occurred_at: null,
      received_at: new Date().toISOString(),
      delivery_source: "webhook",
      raw_payload: {},
      processing_status: "processing",
      attempts: 1,
      next_retry_at: null,
      last_error: null,
      processed_at: null,
    })),
    completeWebhookEvent: vi.fn(),
    upsertInquiry: vi.fn(async () => ({ id: 42, created: false, changed: false })),
    upsertMessage: vi.fn(async () => ({ created: false, changed: false })),
    reconcileApiThread: vi.fn(async () => ({
      inquiryId: 42,
      inquiryCreated: false,
      inquiryChanged: false,
      messagesCreated: 0,
      messagesChanged: 0,
      rowsWritten: 0,
    })),
    tombstoneMessage: vi.fn(),
    recordQuarantine: vi.fn(),
    recordIngestionRun: vi.fn(),
    applyPlatformTransition: vi.fn(),
    ...overrides,
  };
}

function transport(overrides: Partial<MercariTransport> = {}): MercariTransport {
  return {
    inquiries: vi.fn(async () => ({
      inquiries: [{
        id: "inq-1",
        status: "AWAITING_SELLER",
        lastActivityAt: new Date().toISOString(),
        target: { __typename: "InquiryProductTarget", productId: "p-1" },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
    inquiry: vi.fn(async () => ({
      id: "inq-1",
      status: "AWAITING_SELLER",
      target: { __typename: "InquiryProductTarget", productId: "p-1" },
    })),
    inquiryMessages: vi.fn(async () => ({
      messages: [{ id: "buyer-1", from: "BUYER", body: "question", status: "ACTIVE", sentAt: "2026-09-03T01:00:00Z" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
    addInquiryMessage: vi.fn(),
    ...overrides,
  };
}

describe("processNextEvent", () => {
  it("persists presales readback and supersedes a scheduled cycle on buyer inbound", async () => {
    const db = persistence();
    const result = await processNextEvent(
      { workerId: "test", ingestWritesEnabled: true },
      db,
      transport(),
    );
    expect(result.route).toBe("inquiry");
    expect(db.reconcileApiThread).toHaveBeenCalledOnce();
    expect(db.applyPlatformTransition).toHaveBeenCalledWith(42, "INQUIRY_MESSAGE_CREATED", "BUYER");
    expect(db.completeWebhookEvent).toHaveBeenCalledWith(1, "completed");
  });

  it("routes order targets out of the inquiry cohort", async () => {
    const db = persistence();
    const api = transport({
      inquiry: vi.fn(async () => ({
        id: "inq-1",
        target: { __typename: "InquiryOrderTransactionTarget", orderTransaction: { id: "order-1" } },
      })),
    });
    const result = await processNextEvent(
      { workerId: "test", ingestWritesEnabled: true },
      db,
      api,
    );
    expect(result.route).toBe("ticketing");
    expect(db.reconcileApiThread).not.toHaveBeenCalled();
    expect(db.recordQuarantine).toHaveBeenCalledWith(expect.objectContaining({ kind: "ticket_route" }));
  });

  it("fails closed instead of persisting a truncated message thread", async () => {
    const db = persistence();
    const api = transport({
      inquiryMessages: vi.fn(async () => ({
        messages: [{ id: "buyer-1", from: "BUYER" }],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      })),
    });
    const result = await processNextEvent(
      { workerId: "test", ingestWritesEnabled: true, maxThreadPages: 1 },
      db,
      api,
    );
    expect(result.error).toContain("pagination exceeded");
    expect(db.reconcileApiThread).not.toHaveBeenCalled();
    expect(db.completeWebhookEvent).toHaveBeenCalledWith(
      1,
      "failed",
      expect.objectContaining({ nextRetryAt: expect.any(String) }),
    );
  });
});

describe("runDailyAudit", () => {
  it("writes no business rows when every canonical fact is unchanged", async () => {
    const db = persistence();
    const result = await runDailyAudit(
      "shop1",
      { auditWritesEnabled: true },
      db,
      transport(),
    );
    expect(result.scanned).toBe(1);
    expect(result.compared).toBe(2);
    expect(result.recovered).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(db.recordIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ rows_written: 0, recovered: 0, status: "completed" }),
    );
  });
});
