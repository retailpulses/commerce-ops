import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { BridgeClient, BridgeError } from "../src/services/bridge.js";
import { Config } from "../src/config.js";

function testConfig(): Config {
  return {
    port: 3000,
    host: "127.0.0.1",
    bridgeHmacSecret: "test-secret",
    workerBaseUrl: "https://worker.example.com",
    storageHosts: ["storage.example.com"],
    rateLimitWindowMs: 60000,
    rateLimitMax: 30,
    maxConcurrentStreams: 5,
    maxFileSize: 52428800,
    upstreamTimeoutMs: 30000,
    bridgeTimeoutMs: 10000,
    evidenceUrlTtlSeconds: 60,
  };
}

describe("BridgeClient", () => {
  describe("resolveToken", () => {
    it("calls bridge with signed headers", async () => {
      const config = testConfig();
      const ticketDTO = {
        ticketNumber: "TKT-001",
        platform: "Mercari",
        shopName: "Test Shop",
        externalOrderId: "ORD-123",
        status: "Open",
        priority: "High",
        issueTypes: ["Damage"],
        startedDate: "2024-01-15",
        products: [],
        sellerDescription: "Test description",
        expiry: "2024-02-15",
        evidence: [],
      };

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";

      const fetchFn = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers || {}) as Record<string, string>;
        capturedBody = (init?.body || "") as string;
        return new Response(JSON.stringify(ticketDTO), { status: 200 });
      };

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      const result = await client.resolveToken(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );

      assert.strictEqual(result.ticketNumber, "TKT-001");
      assert.ok(
        capturedUrl.includes("/api/internal/ticket-shares/resolve"),
      );
      assert.ok(capturedHeaders["X-Timestamp"]);
      assert.ok(capturedHeaders["X-Nonce"]);
      assert.ok(capturedHeaders["X-Signature"]);
      assert.ok(capturedHeaders["Content-Type"] === "application/json");

      const parsedBody = JSON.parse(capturedBody);
      assert.ok(parsedBody.token);
      assert.strictEqual(parsedBody.token.length, 64);
    });

    it("throws BridgeError on 404", async () => {
      const config = testConfig();
      const fetchFn = async () =>
        new Response("not found", { status: 404 });

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      await assert.rejects(
        () =>
          client.resolveToken(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        (err: unknown) => {
          return (
            err instanceof BridgeError &&
            err.statusCode === 404
          );
        },
      );
    });

    it("throws BridgeError on 500", async () => {
      const config = testConfig();
      const fetchFn = async () =>
        new Response("server error", { status: 500 });

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      await assert.rejects(
        () =>
          client.resolveToken(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        (err: unknown) => {
          return (
            err instanceof BridgeError &&
            err.statusCode === 502
          );
        },
      );
    });

    it("throws BridgeError on network failure", async () => {
      const config = testConfig();
      const fetchFn = async () => {
        throw new Error("Network error");
      };

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      await assert.rejects(
        () =>
          client.resolveToken(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        (err: unknown) => {
          return (
            err instanceof BridgeError &&
            err.statusCode === 502
          );
        },
      );
    });

    it("throws BridgeError on invalid JSON response", async () => {
      const config = testConfig();
      const fetchFn = async () =>
        new Response("not json", { status: 200 });

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      await assert.rejects(
        () =>
          client.resolveToken(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        (err: unknown) => {
          return (
            err instanceof BridgeError &&
            err.statusCode === 502
          );
        },
      );
    });

    it("rejects a partial DTO instead of rendering unchecked fields", async () => {
      const config = testConfig();
      const fetchFn = async () =>
        new Response(JSON.stringify({ ticketNumber: "TKT-001" }), { status: 200 });
      const client = new BridgeClient(config, fetchFn as unknown as typeof fetch);
      await assert.rejects(
        () => client.resolveToken("a".repeat(64)),
        (err: unknown) => err instanceof BridgeError && err.statusCode === 502,
      );
    });
  });

  describe("getEvidenceUrl", () => {
    it("returns evidence URL data", async () => {
      const config = testConfig();
      const evidenceData = {
        url: "https://storage.example.com/evidence/123",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        size: 102400,
        upstreamExpiresIn: 60,
      };
      const fetchFn = async () =>
        new Response(JSON.stringify(evidenceData), { status: 200 });

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      const result = await client.getEvidenceUrl(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "550e8400-e29b-41d4-a716-446655440000",
      );

      assert.strictEqual(
        result.url,
        "https://storage.example.com/evidence/123",
      );
      assert.strictEqual(result.fileName, "photo.jpg");
      assert.strictEqual(result.mimeType, "image/jpeg");
      assert.strictEqual(result.size, 102400);
    });

    it("throws BridgeError on 404 for missing evidence", async () => {
      const config = testConfig();
      const fetchFn = async () =>
        new Response("not found", { status: 404 });

      const client = new BridgeClient(
        config,
        fetchFn as unknown as typeof fetch,
      );
      await assert.rejects(
        () =>
          client.getEvidenceUrl(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "550e8400-e29b-41d4-a716-446655440000",
          ),
        (err: unknown) => {
          return (
            err instanceof BridgeError &&
            err.statusCode === 404
          );
        },
      );
    });

    it("rejects malformed evidence metadata", async () => {
      const config = testConfig();
      const fetchFn = async () => new Response(JSON.stringify({
        url: "https://storage.example.com/file",
        fileName: "file",
        mimeType: "image/jpeg",
        size: -1,
        upstreamExpiresIn: 60,
      }));
      const client = new BridgeClient(config, fetchFn as unknown as typeof fetch);
      await assert.rejects(
        () => client.getEvidenceUrl("a".repeat(64), "550e8400-e29b-41d4-a716-446655440000"),
        (err: unknown) => err instanceof BridgeError && err.statusCode === 502,
      );
    });
  });
});
