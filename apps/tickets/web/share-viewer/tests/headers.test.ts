import { describe, it } from "node:test";
import assert from "node:assert";
import express from "express";
import {
  securityHeadersMiddleware,
} from "../src/middleware/securityHeaders.js";
import { createRequestIdMiddleware } from "../src/middleware/requestId.js";
import http from "node:http";

describe("security headers", () => {
  function makeApp() {
    const app = express();
    app.disable("x-powered-by");
    app.use(createRequestIdMiddleware());
    app.use(securityHeadersMiddleware);
    app.get("/test", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/error", (_req, _res) => {
      throw new Error("test error");
    });
    return app;
  }

  async function fetchApp(
    app: express.Express,
    path: string,
  ): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
  }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const req = http.get(
          `http://127.0.0.1:${addr.port}${path}`,
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              server.close();
              resolve({
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string | string[] | undefined>,
              });
            });
          },
        );
        req.on("error", reject);
      });
    });
  }

  it("applies Cache-Control on success", async () => {
    const app = makeApp();
    const res = await fetchApp(app, "/test");
    assert.strictEqual(
      res.headers["cache-control"],
      "private, no-store, max-age=0",
    );
  });

  it("applies X-Frame-Options", async () => {
    const app = makeApp();
    const res = await fetchApp(app, "/test");
    assert.strictEqual(res.headers["x-frame-options"], "DENY");
  });

  it("applies X-Content-Type-Options", async () => {
    const app = makeApp();
    const res = await fetchApp(app, "/test");
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
  });

  it("applies Referrer-Policy", async () => {
    const app = makeApp();
    const res = await fetchApp(app, "/test");
    assert.strictEqual(res.headers["referrer-policy"], "no-referrer");
  });

  it("applies X-Robots-Tag", async () => {
    const app = makeApp();
    const res = await fetchApp(app, "/test");
    assert.strictEqual(
      res.headers["x-robots-tag"],
      "noindex, nofollow, noarchive",
    );
  });

  it("applies CSP with frame-ancestors none", async () => {
    const app = makeApp();
    const res = await fetchApp(app, "/test");
    const csp = res.headers["content-security-policy"] as string;
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes("default-src 'none'"));
  });
});
