import { afterEach, describe, expect, it, vi } from "vitest";

import { ingestWebhook, parseWebhookBody } from "../src/mercari/webhook";
import type { MercariPersistence } from "../src/mercari/persistence";

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body).buffer as ArrayBuffer,
  );
  return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makePersistence(): MercariPersistence & { recordWebhookEvent: ReturnType<typeof vi.fn> } {
  return {
    recordWebhookEvent: vi.fn(async () => ({ duplicate: false })),
    claimWebhookEvent: vi.fn(),
    completeWebhookEvent: vi.fn(),
    upsertInquiry: vi.fn(),
    upsertMessage: vi.fn(),
    reconcileApiThread: vi.fn(),
    tombstoneMessage: vi.fn(),
    recordQuarantine: vi.fn(),
    recordIngestionRun: vi.fn(),
    applyPlatformTransition: vi.fn(),
  };
}

const config = {
  webhookSecrets: { shop1: "test-secret" },
  shopKeyHeader: "X-Mercari-Shop-Key",
  signatureHeader: "X-Mercari-Signature",
  replayWindowSeconds: 300,
};

afterEach(() => vi.unstubAllGlobals());

describe("parseWebhookBody", () => {
  it("rejects unsupported topics", () => {
    const res = parseWebhookBody({ topic: "ORDER_TRANSACTION_MESSAGE_CREATED" }, "shop1");
    expect("error" in res).toBe(true);
  });

  it("extracts inquiry/message ids from nested payload", () => {
    const res = parseWebhookBody(
      { topic: "INQUIRY_MESSAGE_CREATED", payload: { inquiryId: "inq-1", messageId: "msg-1" } },
      "shop1",
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.externalInquiryId).toBe("inq-1");
      expect(res.externalMessageId).toBe("msg-1");
    }
  });

  it("extracts snake_case identities from a production-style payload", () => {
    const res = parseWebhookBody(
      {
        topic: "INQUIRY_MESSAGE_CREATED",
        event_id: "evt-snake-1",
        shop_id: "shop-external-1",
        payload: {
          inquiry_id: "inq-snake-1",
          message_id: "msg-snake-1",
          created_at: "2026-09-03T12:00:00Z",
        },
      },
      "shop1",
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.externalEventId).toBe("evt-snake-1");
      expect(res.externalInquiryId).toBe("inq-snake-1");
      expect(res.externalMessageId).toBe("msg-snake-1");
      expect(res.occurredAt).toBe("2026-09-03T12:00:00Z");
    }
  });
});

describe("ingestWebhook", () => {
  it("rejects a request with no shop identity", async () => {
    const req = new Request("https://x/webhook", {
      method: "POST",
      body: "{}",
    });
    const { response } = await ingestWebhook(req, config, makePersistence());
    expect(response.status).toBe(400);
  });

  it("fails closed when the shop secret is unavailable", async () => {
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: { "X-Mercari-Shop-Key": "shop9" },
      body: "{}",
    });
    const { response } = await ingestWebhook(req, config, makePersistence());
    expect(response.status).toBe(401);
  });

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({ topic: "INQUIRY_MESSAGE_CREATED" });
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: {
        "X-Mercari-Shop-Key": "shop1",
        "X-Mercari-Signature": "sha256=deadbeef",
      },
      body,
    });
    const { response } = await ingestWebhook(req, config, makePersistence());
    expect(response.status).toBe(401);
  });

  it("durably persists a valid, signed event and returns 200", async () => {
    const body = JSON.stringify({
      topic: "INQUIRY_MESSAGE_CREATED",
      eventId: "evt-1",
      payload: { inquiryId: "inq-1", messageId: "msg-1", occurredAt: new Date().toISOString() },
    });
    const signature = await hmacSign("test-secret", body);
    const persistence = makePersistence();
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: {
        "X-Mercari-Shop-Key": "shop1",
        "X-Mercari-Signature": signature,
      },
      body,
    });
    const { response } = await ingestWebhook(req, config, persistence);
    expect(response.status).toBe(200);
    expect(persistence.recordWebhookEvent).toHaveBeenCalledOnce();
    const event = persistence.recordWebhookEvent.mock.calls[0][0];
    expect(event.event_identity).toBe("evt:shop1:INQUIRY_MESSAGE_CREATED:evt-1");
    expect(event.processing_status).toBe("pending");
  });

  it("returns 200 for a duplicate event", async () => {
    const body = JSON.stringify({ topic: "INQUIRY_RESOLVED", eventId: "evt-resolved-1", payload: { inquiryId: "inq-1" } });
    const signature = await hmacSign("test-secret", body);
    const persistence = makePersistence();
    persistence.recordWebhookEvent.mockResolvedValue({ duplicate: true });
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: {
        "X-Mercari-Shop-Key": "shop1",
        "X-Mercari-Signature": signature,
      },
      body,
    });
    const { response, duplicate } = await ingestWebhook(req, config, persistence);
    expect(response.status).toBe(200);
    expect(duplicate).toBe(true);
  });

  it("returns 503 when the durable insert fails", async () => {
    const body = JSON.stringify({ topic: "INQUIRY_MESSAGE_CREATED", eventId: "evt-db-fail", payload: { inquiryId: "inq-1" } });
    const signature = await hmacSign("test-secret", body);
    const persistence = makePersistence();
    persistence.recordWebhookEvent.mockRejectedValue(new Error("db down"));
    const req = new Request("https://x/webhook", {
      method: "POST",
      headers: {
        "X-Mercari-Shop-Key": "shop1",
        "X-Mercari-Signature": signature,
      },
      body,
    });
    const { response } = await ingestWebhook(req, config, persistence);
    expect(response.status).toBe(503);
  });

  it("accepts endpoint shared-secret auth and resolves shop_id mapping", async () => {
    const body = JSON.stringify({
      topic: "INQUIRY_MESSAGE_CREATED",
      event_id: "evt-endpoint-1",
      shop_id: "external-shop-1",
      payload: { inquiry_id: "inq-1", message_id: "msg-1" },
    });
    const persistence = makePersistence();
    const req = new Request("https://x/webhook?secret=endpoint-secret", {
      method: "POST",
      body,
    });
    const { response } = await ingestWebhook(
      req,
      {
        ...config,
        webhookSecrets: {},
        sharedSecret: "endpoint-secret",
        shopIdMap: { "external-shop-1": "shop1" },
      },
      persistence,
    );
    expect(response.status).toBe(200);
    expect(persistence.recordWebhookEvent).toHaveBeenCalledOnce();
    expect(persistence.recordWebhookEvent.mock.calls[0][0].shop_key).toBe("shop1");
  });

  it("rejects an incorrect endpoint shared secret", async () => {
    const body = JSON.stringify({
      topic: "INQUIRY_RESOLVED",
      event_id: "evt-endpoint-bad",
      shop_id: "external-shop-1",
      payload: { inquiry_id: "inq-1" },
    });
    const req = new Request("https://x/webhook?secret=wrong", { method: "POST", body });
    const { response } = await ingestWebhook(
      req,
      {
        ...config,
        webhookSecrets: {},
        sharedSecret: "endpoint-secret",
        shopIdMap: { "external-shop-1": "shop1" },
      },
      makePersistence(),
    );
    expect(response.status).toBe(401);
  });
});
