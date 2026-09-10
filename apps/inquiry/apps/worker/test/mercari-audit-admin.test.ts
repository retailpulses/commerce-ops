import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const mocks = vi.hoisted(() => ({
  runDailyAudit: vi.fn(),
  getWebhookStatus: vi.fn(),
  persistence: {
    getWebhookStatus: (...args: unknown[]) => mocks.getWebhookStatus(...args),
  },
  relay: {},
}));

vi.mock("../src/mercari/audit", () => ({ runDailyAudit: mocks.runDailyAudit }));
vi.mock("../src/mercari/persistence", () => ({
  createMercariPersistence: () => mocks.persistence,
}));
vi.mock("../src/mercari/relay", () => ({
  createMercariRelay: () => mocks.relay,
}));
vi.mock("../src/state/JobStateDO", () => ({ JobStateDO: class {} }));

import worker from "../src/index";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_TOKEN: "admin-secret",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    OPENAI_API_KEY: "openai",
    DEEPSEEK_API_KEY: "deepseek",
    WECOM_WEBHOOK_URL: "https://example.test/wecom",
    SHOP_CACHE_TTL_SECONDS: "0",
    MASTER_HANDLER_DEFAULT_CURSOR: "2026-01-01T00:00:00Z",
    DRY_RUN: "false",
    FORCE_REGENERATE: "false",
    MAX_ROWS_PER_RUN: "20",
    LLM_MAX_CALLS_PER_RUN: "10",
    MERCARI_RELAY_URL: "https://relay.example.test",
    SHOP1_API_TOKEN: "shop1-token",
    SHOP2_API_TOKEN: "shop2-token",
    SHOP3_API_TOKEN: "shop3-token",
    SHOP4_API_TOKEN: "shop4-token",
    SHOP_CACHE: {} as KVNamespace,
    JOB_STATE: {} as DurableObjectNamespace,
    ...overrides,
  };
}

function request(shop = "shop1", authorized = true): Request {
  return new Request(`https://worker.example.test/admin/mercari-audit?shop=${shop}`, {
    method: "POST",
    headers: authorized ? { Authorization: "Bearer admin-secret" } : {},
  });
}

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runDailyAudit.mockResolvedValue({
    runId: "audit-shop1-1",
    shopKey: "shop1",
    deliverySource: "daily_audit",
    scanned: 2,
    compared: 4,
    recovered: 1,
    rowsWritten: 1,
    errors: 0,
    errorSamples: [],
  });
  mocks.getWebhookStatus.mockResolvedValue({
    total: 2,
    recent: [
      {
        shop_key: "shop2",
        topic: "INQUIRY_MESSAGE_CREATED",
        received_at: "2026-09-04T00:00:00.000Z",
        processing_status: "completed",
        attempts: 1,
      },
    ],
  });
});

describe("POST /admin/mercari-audit", () => {
  it("requires the existing admin bearer token", async () => {
    const response = await worker.fetch(request("shop1", false), env(), executionContext);
    expect(response.status).toBe(401);
    expect(mocks.runDailyAudit).not.toHaveBeenCalled();
  });

  it("accepts the least-privilege audit token without granting another route", async () => {
    const auditEnv = env({ INQUIRY_AUDIT_ADMIN_TOKEN: "audit-only" });
    const auditRequest = new Request("https://worker.example.test/admin/mercari-audit?shop=shop1", {
      method: "POST",
      headers: { Authorization: "Bearer audit-only" },
    });
    const auditResponse = await worker.fetch(auditRequest, auditEnv, executionContext);
    expect(auditResponse.status).toBe(200);

    const stateRequest = new Request("https://worker.example.test/admin/state", {
      headers: { Authorization: "Bearer audit-only" },
    });
    const stateResponse = await worker.fetch(stateRequest, auditEnv, executionContext);
    expect(stateResponse.status).toBe(401);
  });

  it("rejects an invalid or missing shop", async () => {
    const response = await worker.fetch(request("shop5"), env(), executionContext);
    expect(response.status).toBe(400);
    expect(mocks.runDailyAudit).not.toHaveBeenCalled();
  });

  it("runs exactly one requested shop and preserves the disabled write flag", async () => {
    mocks.runDailyAudit.mockResolvedValueOnce({
      runId: "audit-shop2-1",
      shopKey: "shop2",
      deliverySource: "daily_audit",
      scanned: 0,
      compared: 0,
      recovered: 0,
      rowsWritten: 0,
      errors: 0,
      errorSamples: [],
      paused: true,
    });

    const response = await worker.fetch(
      request("shop2"),
      env({ INQUIRY_COMPLETENESS_AUDIT_WRITES_ENABLED: "false" }),
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.runDailyAudit).toHaveBeenCalledTimes(1);
    expect(mocks.runDailyAudit).toHaveBeenCalledWith(
      "shop2",
      { auditWritesEnabled: false },
      mocks.persistence,
      mocks.relay,
    );
    await expect(response.json()).resolves.toMatchObject({ paused: true, shopKey: "shop2" });
  });

  it("passes the enabled flag to a one-shop audit", async () => {
    const response = await worker.fetch(
      request("shop1"),
      env({ INQUIRY_COMPLETENESS_AUDIT_WRITES_ENABLED: "true" }),
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(mocks.runDailyAudit).toHaveBeenCalledTimes(1);
    expect(mocks.runDailyAudit).toHaveBeenCalledWith(
      "shop1",
      { auditWritesEnabled: true },
      mocks.persistence,
      mocks.relay,
    );
  });

  it("returns a generic error without leaking upstream details", async () => {
    mocks.runDailyAudit.mockRejectedValueOnce(new Error("secret upstream detail"));
    const response = await worker.fetch(request("shop1"), env(), executionContext);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Mercari audit failed");
    expect(body).not.toContain("secret upstream detail");
  });
});

describe("GET /admin/mercari-webhook-status", () => {
  it("accepts the audit-only token and returns only operational fields", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example.test/admin/mercari-webhook-status?limit=10", {
        headers: { Authorization: "Bearer audit-only" },
      }),
      env({ INQUIRY_AUDIT_ADMIN_TOKEN: "audit-only" }),
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(mocks.getWebhookStatus).toHaveBeenCalledWith(10);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ total: 2, sampleSize: 1 });
    expect(JSON.stringify(body)).not.toContain("raw_payload");
    expect(JSON.stringify(body)).not.toContain("external_inquiry_id");
    expect(JSON.stringify(body)).not.toContain("body");
  });

  it("rejects the audit-only token on unrelated admin routes", async () => {
    const auditEnv = env({ INQUIRY_AUDIT_ADMIN_TOKEN: "audit-only" });
    const response = await worker.fetch(
      new Request("https://worker.example.test/admin/status", {
        headers: { Authorization: "Bearer audit-only" },
      }),
      auditEnv,
      executionContext,
    );
    expect(response.status).toBe(401);
  });
});
