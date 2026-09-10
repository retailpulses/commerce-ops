import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import { Config } from "../src/config.js";
import { createApp } from "../src/index.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    bridgeHmacSecret: "test-secret",
    workerBaseUrl: "https://worker.example.com",
    storageHosts: ["storage.example.com"],
    rateLimitWindowMs: 60000,
    rateLimitMax: 100,
    maxConcurrentStreams: 5,
    maxFileSize: 52428800,
    upstreamTimeoutMs: 30000,
    bridgeTimeoutMs: 10000,
    evidenceUrlTtlSeconds: 60,
    ...overrides,
  };
}

function makeRequest(
  app: express.Express,
  path: string,
  method = "GET",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode || 500,
              headers: res.headers,
              body,
            });
          });
        },
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

describe("routes", () => {
  describe("GET /healthz", () => {
    it("returns 200 with ok status", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(app, "/healthz");
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.status, "ok");
    });
  });

  describe("GET /tickets/share/:token", () => {
    it("returns the same generic 404 for invalid token format", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/invalid-token",
      );
      assert.strictEqual(res.status, 404);
      assert.ok(res.body.includes("404"));
    });

    it("returns 404 for short hex token", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/abc123",
      );
      assert.strictEqual(res.status, 404);
    });

    it("returns 404 for 64 non-hex token", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      );
      assert.strictEqual(res.status, 404);
    });
  });

  describe("GET /tickets/share/:token/evidence/:attachmentId", () => {
    it("returns 404 for invalid token", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/bad-token/evidence/550e8400-e29b-41d4-a716-446655440000",
      );
      assert.strictEqual(res.status, 404);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, "Not found");
    });

    it("returns 404 for invalid attachment ID", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/evidence/not-a-uuid",
      );
      assert.strictEqual(res.status, 404);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, "Not found");
    });
  });

  describe("GET /tickets/share/:token/evidence/:attachmentId/download", () => {
    it("returns 404 for invalid token", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/bad-token/evidence/550e8400-e29b-41d4-a716-446655440000/download",
      );
      assert.strictEqual(res.status, 404);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, "Not found");
    });

    it("returns 404 for invalid attachment ID", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/evidence/not-a-uuid/download",
      );
      assert.strictEqual(res.status, 404);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, "Not found");
    });
  });

  describe("security headers on error", () => {
    it("includes security headers on generic 404 response", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(
        app,
        "/tickets/share/bad-token",
      );
      assert.strictEqual(res.status, 404);
      assert.ok(res.headers["x-frame-options"]);
      assert.ok(res.headers["x-content-type-options"]);
      assert.ok(res.headers["cache-control"]);
    });

    it("includes security headers on healthz", async () => {
      const app = createApp(testConfig());
      const res = await makeRequest(app, "/healthz");
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers["x-frame-options"]);
      assert.ok(res.headers["x-content-type-options"]);
    });
  });
});
