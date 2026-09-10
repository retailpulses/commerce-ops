// Portal API route registration — imports handler functions from shared
// src/lib/portal/ modules and wraps them as Hono route handlers.
//
// All handlers receive an env object with DATABASE_BACKEND=supabase so
// database access goes through the Supabase adapter via db.mjs.

import { buildEnv } from "./env.mjs";

// Shared portal handler imports (extracted from worker/index.js)
import { handlePortalOrderDetail, handlePortalSummary } from "../../src/lib/portal/handlers.mjs";
import { handlePortalOrderList } from "../../src/lib/portal/order-list.mjs";
import { handlePortalFeeOrderList } from "../../src/lib/portal/fee-orders.mjs";
import { handlePortalPresale, handlePresaleMemo } from "../../src/lib/portal/presale.mjs";
import {
  handlePortalReview,
  handlePortalMemo,
  handlePortalBulkApprove,
  handlePortalB2bCode,
  handlePortalDeliveryPreferences,
  handlePortalDeliveryDate,
  handlePortalDeliveryTime,
  handlePortalAddress,
  handlePortalQuantity,
  handlePortalOrderLineCreate,
  handlePortalOrderMessages,
  handlePortalOrderMarkRead,
  handlePortalOrderReply,
  handlePortalGenerateReply,
  handlePortalTemplatesList,
  handlePortalTemplatesCreate,
  handlePortalTemplatesUpdate,
  handlePortalTemplatesDelete,
  handlePortalTemplatesReorder,
  handlePortalConfirm,
  handlePortalCancel,
} from "../../src/lib/portal/handlers.mjs";
import { handlePortalProductManualFields } from "../../src/lib/portal/product-update.mjs";
import { handlePortalMetrics } from "../../src/lib/portal/metrics.mjs";
import { handlePortalControlPlane } from "../../src/lib/portal/control-plane.mjs";

import { validateAdminToken } from "../../src/lib/admin-auth.mjs";

// ── Helpers ──────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function text(val) {
  return String(val ?? "").trim();
}

function normalizeError(error) {
  if (!error) return "unknown_error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

// ── Env factory ──────────────────────────────────────────────────

let _env = null;
function getEnv() {
  if (!_env) _env = buildEnv();
  return _env;
}

// ── Route Registration ───────────────────────────────────────────

export function registerRoutes(app, envProvided) {
  const env = envProvided || getEnv();

  app.get("/api/portal/control-plane", async () => {
    try {
      return json(await handlePortalControlPlane(env));
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  app.get("/api/portal/metrics", async (c) => {
    try {
      return json(await handlePortalMetrics(env, new URL(c.req.url).searchParams));
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, normalizeError(error) === "invalid_metrics_window" ? 400 : 500);
    }
  });

  // GET /api/portal/summary
  app.get("/api/portal/summary", async (c) => {
    try {
      const result = await handlePortalSummary(env, new URL(c.req.url).searchParams);
      return json(result, result.statusCode || 200);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // GET /api/portal/orders
  app.get("/api/portal/orders", async (c) => {
    try {
      const result = await handlePortalOrderList(env, new URL(c.req.url).searchParams);
      return json(result, result.statusCode || 200);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // GET /api/portal/orders/:id
  app.get("/api/portal/orders/:id", async (c) => {
    try {
      const result = await handlePortalOrderDetail(env, c.req.param("id"));
      return json(result, result.ok ? 200 : result.statusCode || 404);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/:id/lines — add a manual component line
  app.post("/api/portal/orders/:id/lines", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalOrderLineCreate(env, c.req.param("id"), body);
      return json(result, result.ok ? 201 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/bulk-approve
  app.post("/api/portal/orders/bulk-approve", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalBulkApprove(env, body);
      return json(result, result.ok ? 200 : 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/:id/confirm — Rakuten operator confirmation
  app.post("/api/portal/orders/:id/confirm", async (c) => {
    try {
      const result = await handlePortalConfirm(env, c.req.param("id"));
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/:id/cancel — mark order cancelled (local guard)
  app.post("/api/portal/orders/:id/cancel", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalCancel(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/review
  app.patch("/api/portal/orders/:id/review", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalReview(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/memo
  app.patch("/api/portal/orders/:id/memo", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalMemo(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/b2b-code
  app.patch("/api/portal/orders/:id/b2b-code", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalB2bCode(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/delivery-date
  app.patch("/api/portal/orders/:id/delivery-date", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalDeliveryDate(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/delivery-time
  app.patch("/api/portal/orders/:id/delivery-time", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalDeliveryTime(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/delivery-preferences
  app.patch("/api/portal/orders/:id/delivery-preferences", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalDeliveryPreferences(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/address
  app.patch("/api/portal/orders/:id/address", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalAddress(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/orders/:id/quantity
  app.patch("/api/portal/orders/:id/quantity", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalQuantity(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // GET /api/portal/orders/:id/messages
  app.get("/api/portal/orders/:id/messages", async (c) => {
    try {
      const refresh = new URL(c.req.url).searchParams.get("refresh") === "1";
      const result = await handlePortalOrderMessages(env, c.req.param("id"), { refresh });
      return json(result, result.ok ? 200 : result.statusCode || 500);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/:id/messages — send reply
  app.post("/api/portal/orders/:id/messages", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalOrderReply(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/:id/messages/read
  app.post("/api/portal/orders/:id/messages/read", async (c) => {
    try {
      const result = await handlePortalOrderMarkRead(env, c.req.param("id"));
      return json(result, result.ok ? 200 : result.statusCode || 500);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/orders/:id/generate-reply
  app.post("/api/portal/orders/:id/generate-reply", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalGenerateReply(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 500);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // GET /api/portal/templates
  app.get("/api/portal/templates", async (c) => {
    try {
      const result = await handlePortalTemplatesList(env);
      return json(result);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/templates
  app.post("/api/portal/templates", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalTemplatesCreate(env, body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PUT /api/portal/templates/:id
  app.put("/api/portal/templates/:id", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalTemplatesUpdate(env, c.req.param("id"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // DELETE /api/portal/templates/:id
  app.delete("/api/portal/templates/:id", async (c) => {
    try {
      const result = await handlePortalTemplatesDelete(env, c.req.param("id"));
      return json(result, result.ok ? 200 : result.statusCode || 404);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // POST /api/portal/templates/reorder
  app.post("/api/portal/templates/reorder", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalTemplatesReorder(env, body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // GET /api/portal/fee-orders
  app.get("/api/portal/fee-orders", async (c) => {
    try {
      const result = await handlePortalFeeOrderList(env, new URL(c.req.url).searchParams);
      return json(result, result.statusCode || 200);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // GET /api/portal/presale
  app.get("/api/portal/presale", async (c) => {
    try {
      const result = await handlePortalPresale(env, new URL(c.req.url).searchParams);
      return json(result);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/presale/:itemCode/memo
  app.patch("/api/portal/presale/:itemCode/memo", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePresaleMemo(env, c.req.param("itemCode"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  // PATCH /api/portal/products/:itemCode/manual-fields
  app.patch("/api/portal/products/:itemCode/manual-fields", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const result = await handlePortalProductManualFields(env, c.req.param("itemCode"), body);
      return json(result, result.ok ? 200 : result.statusCode || 400);
    } catch (error) {
      return json({ ok: false, error: normalizeError(error) }, 500);
    }
  });

  console.log("[portal-api] Routes registered: 27 endpoints");
}
