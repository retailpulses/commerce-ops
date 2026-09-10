// Portal API — thin backend for Portal SPA write operations.
//
// Architecture:
//   Portal SPA (browser) → Portal API (this server) → Supabase (service_role)
//
// Reuses the same handler functions as the Cloudflare Worker (src/lib/portal/*)
// but with DATABASE_BACKEND=supabase so all DB access goes through the Supabase
// adapter instead of Baserow.
//
// Deployed as a systemd service on VPS. nginx proxies /order/api/ and the
// legacy /api/ to this server. Issue 60: the canonical ops-portal path
// /order/api/portal/* is normalized here to the unchanged /api/portal/* so
// auth and write-safety are identical for both prefixes.

// Node 18 compat: supabase-js requires WebSocket (realtime), but Node 18
// lacks native WebSocket. Polyfill before any supabase imports execute.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
if (!globalThis.WebSocket) {
  try {
    globalThis.WebSocket = require("ws");
  } catch {
    // If ws is not installed (e.g. in Cloudflare Workers or Node 22+),
    // supabase-js will use the native WebSocket — or throw if unavailable.
  }
}

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { buildEnv } from "./env.mjs";
import { requirePortalAuth, authErrorResponse } from "./auth.mjs";
import { registerRoutes } from "./routes.mjs";
import { normalizeOpsApiPath, releasePayload } from "./ops-path.mjs";

/**
 * Build the Portal API Hono app. `overrides` lets tests inject env values
 * without relying on real secrets in process.env.
 */
export function createApp(overrides = {}) {
  const env = buildEnv(overrides);
  const app = new Hono();

  // ── Canonical path normalization (Issue 60) ────────────────────
  // Registered first so downstream middleware (cors, logger, rate limit,
  // auth) and route handlers observe the normalized path exactly once.
  // /order/api/portal/* → /api/portal/* (and /order/api/release → /api/release).
  // Legacy /api/* paths pass through untouched, preserving the existing API.
  app.use("*", async (c, next) => {
    // Guard against re-dispatch loops: the rewritten request carries a marker.
    if (c.req.header("x-ops-path-normalized") === "1") return next();

    const normalized = normalizeOpsApiPath(new URL(c.req.url).pathname);
    if (!normalized) return next();

    const url = new URL(c.req.url);
    url.pathname = normalized;
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-ops-path-normalized", "1");
    return app.fetch(
      new Request(url.toString(), {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        ...(["GET", "HEAD"].includes(c.req.method) ? {} : { duplex: "half" }),
      }),
    );
  });

  // Middleware
  app.use("*", cors({
    origin: [
      process.env.CORS_ORIGIN || "https://worker-order.homesbliss.net",
      "http://localhost:5173",
    ].flatMap((s) => s.split(",").map((o) => o.trim())).filter(Boolean),
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }));
  app.use("*", logger());

  // Security headers on all responses
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("x-frame-options", "DENY");
    c.res.headers.set("referrer-policy", "no-referrer");
    c.res.headers.set("x-xss-protection", "0");  // deprecated but signals intentional disable
    c.res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    // API responses should not be cached by browsers
    if (!c.res.headers.has("cache-control")) {
      c.res.headers.set("cache-control", "no-store");
    }
  });

  // Health check
  app.get("/health", (c) => c.json({
    ok: true,
    service: "portal-api",
    backend: "supabase",
    uptime: Math.floor(process.uptime()),
  }));

  // Deep health check — validates Supabase connectivity with configured service role key.
  // Uses a direct REST API call (fetch) rather than the Supabase client to avoid
  // the WebSocket dependency (Node 18 has no native WebSocket, and we only need to
  // verify that the service_role key works for queries).
  app.get("/health/deep", async (c) => {
    let supabaseOk = false;
    let errorMessage = null;

    try {
      // Ping the Supabase REST API directly — just need to verify the key works
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/pipeline_run_log?select=id&limit=1`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "content-type": "application/json",
          },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 5000); return c.signal; })(),
        },
      );
      if (res.ok) {
        supabaseOk = true;
      } else if (res.status === 404 || res.status === 406) {
        // 404/406: table may not exist yet, but auth succeeded (key is valid)
        supabaseOk = true;
      } else {
        const body = await res.text().catch(() => "");
        errorMessage = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      }
    } catch (err) {
      errorMessage = err?.message ?? String(err);
    }

    const status = supabaseOk ? 200 : 503;
    return c.json({
      ok: supabaseOk,
      service: "portal-api",
      backend: "supabase",
      uptime: Math.floor(process.uptime()),
      supabase: {
        connected: supabaseOk,
        ...(errorMessage ? { error: errorMessage } : {}),
      },
    }, status);
  });

  // Public read-only release metadata (Issue 60).
  // Exposed at /order/api/release (via normalization) and /api/release (legacy).
  // No auth, no secrets — the deployment gate reads this to verify the exact SHA.
  app.get("/api/release", (c) => c.json(releasePayload(env)));

  // Simple in-memory rate limiter (per IP, per minute windows).
  // For production, nginx rate limiting should be the primary enforcement layer.
  const rateLimitStore = new Map();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX_REQUESTS = 300; // per window per IP
  const RATE_LIMIT_WRITE_MAX = 30;     // stricter for mutations

  app.use("/api/portal/*", async (c, next) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const now = Date.now();
    const method = c.req.method.toUpperCase();
    const isWrite = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    const maxRequests = isWrite ? RATE_LIMIT_WRITE_MAX : RATE_LIMIT_MAX_REQUESTS;

    let entry = rateLimitStore.get(ip);
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry = { windowStart: now, count: 0 };
      rateLimitStore.set(ip, entry);
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return new Response(JSON.stringify({
        ok: false, error: "rate_limited",
        retry_after_ms: RATE_LIMIT_WINDOW_MS - (now - entry.windowStart),
      }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000)),
        },
      });
    }

    await next();
  });

  // Periodic cleanup of expired rate limit entries (every 5 minutes)
  setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
    for (const [ip, entry] of rateLimitStore) {
      if (entry.windowStart < cutoff) rateLimitStore.delete(ip);
    }
  }, 300_000).unref();

  // Request body size limit (100 KB) for write endpoints
  const MAX_BODY_SIZE = 100 * 1024; // 100 KB
  app.use("/api/portal/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      const contentLength = parseInt(c.req.header("content-length") || "0", 10);
      if (contentLength > MAX_BODY_SIZE) {
        return new Response(JSON.stringify({ ok: false, error: "request_body_too_large", max_bytes: MAX_BODY_SIZE }), {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    await next();
  });

  // Portal API routes — auth gate applied
  app.use("/api/portal/*", async (c, next) => {
    if (!requirePortalAuth(c.req.raw)) {
      return authErrorResponse();
    }
    await next();
  });

  // Register all portal routes (imports handlers from src/lib/portal/)
  registerRoutes(app, env);

  return { app, env };
}

// ── Startup (only when run directly, not when imported by tests) ──
// Compare real paths so immutable releases still start when ExecStart uses the
// atomic /opt/order-mgmt/current symlink.
const isMain = Boolean(
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]),
);

let app = null;
let env = null;
let port = 3000;

if (isMain) {
  ({ app, env } = createApp());
  port = parseInt(env.PORT, 10) || 3000;
  console.log(`[portal-api] Starting on port ${port} (backend: supabase)`);
  console.log(`[portal-api] Supabase URL: ${env.SUPABASE_URL}`);

  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[portal-api] Listening on http://0.0.0.0:${info.port}`);
  });
}

export default {
  createApp,
  get port() { return port; },
  get fetch() { return app ? app.fetch : undefined; },
};
