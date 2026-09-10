import { createBaserowClient, listAllRows, listRowsWithLimit, patchRow, createRow, FIELD, OPTION } from "../src/lib/db.mjs";
import { GigaClient } from "../src/lib/giga-client.mjs";
import { runMercariIngestViaRelay, runMercariShippingCloseViaRelay, checkRelayHealth, runMercariOrderMessagesViaRelay, runMercariOrderReplyViaRelay } from "../src/lib/mercari-relay.mjs";
import { runRakutenIngestViaRelay, runRakutenConfirmViaRelay } from "../src/lib/rakuten-relay.mjs";
import { runEndToEndReconcile } from "../src/lib/end-to-end-reconcile.mjs";
import { runOutboundSync } from "../src/lib/outbound-sync.mjs";
import { collectPipelineHealthSnapshot } from "../src/lib/pipeline-health.mjs";
import { projectMercariSalesOrdersToShipment } from "../src/lib/shipment-projector.mjs";
import { autoApproveMercariOrders } from "../src/lib/auto-approval.mjs";
import { projectRakutenSalesOrdersToShipment } from "../src/lib/rakuten-projector.mjs";
import { formatTrackingArtifact } from "../src/lib/tracking-format.mjs";
import { reconcileShippingInfo, DEFAULT_SHOP_IDS } from "../src/lib/tracking-reconciler.mjs";
import { reconcileMercariCancellations } from "../src/lib/cancellation-reconciler.mjs";
import { ingestRakutenOrders } from "../src/lib/rakuten-ingest.mjs";
import { findConfirmedRakutenOrders, markRakutenOrdersConfirmed, resetConfirmInProgress } from "../src/lib/rakuten-confirmer.mjs";
import { mercariResolveItemCode } from "../src/lib/item-code-resolver.mjs";

import { MERCARI_CHANNEL } from "../src/lib/channel-config.mjs";
import { getMercariShopName } from "../src/lib/mercari-shops.mjs";
import {
  findProductByItemCode,
  computeMargin,
  computeStockStatus,
  assessRiskBadges,
  readProductField,
  readProductNumber,
} from "../src/lib/product-resolver.mjs";
import { getPortalProductFields, invalidatePortalListCache } from "../src/lib/portal/cache.mjs";
import { classifyUnreadStatus, markAsRead, readDurableState, buildDurableStateKey, writeThroughMessageFacts, syncMercariMessages } from "../src/lib/buyer-messages.mjs";
import { handleMercariMessageWebhook } from "../src/lib/webhook-handler.mjs";
import { buildServerFilters, handlePortalOrderList, listPortalSalesRows } from "../src/lib/portal/order-list.mjs";
import { handlePortalFeeOrderList } from "../src/lib/portal/fee-orders.mjs";
import { handlePortalMetrics } from "../src/lib/portal/metrics.mjs";
import { handlePortalPresale, handlePresaleMemo } from "../src/lib/portal/presale.mjs";
import {
  getJstEarliestDeliveryDate,
  toJstIso,
  formatJstDateTime,
} from "../src/lib/timezone.mjs";
import {
  GIGA_SYNC_STATUS,
  ORDER_STATUS,
  PIPELINE_STATE,
  REVIEW_STATUS,
  getPipelineState,
  readSelectValue,
  statusEquals,
  isValidReviewMutation,
} from "../src/lib/order-state.mjs";
import {
  LIFECYCLE,
  REVIEW_FILTER,
  applyPortalOrderSearch,
  isActivePipelineState,
  validatePortalParams,
  text as sharedText,
} from "../src/lib/portal/shared.mjs";
import { requireAdminAuth, adminAuthErrorResponse } from "../src/lib/admin-auth.mjs";
import {
  text,
  parseInteger,
  normalizeOrderIdCandidate,
  normalizeErrorMessage,
  safeJson,
  json,
  matchPath,
} from "../src/lib/worker-helpers.mjs";
import {
  runPipeline,
  resolveShops,
  DEFAULT_SHOPS,
} from "../src/lib/pipeline-runner.mjs";
import { phasesForCron, shouldHandleCron } from "../src/lib/pipeline-schedule.mjs";
import { fenceCloudflareScheduledPhases } from "../src/lib/scheduler-runtime-fence.mjs";
import {
  handlePortalOrderDetail,
  handlePortalSummary,
  handlePortalReview,
  handlePortalMemo,
  handlePortalBulkApprove,
  handlePortalConfirm,
  handlePortalB2bCode,
  handlePortalDeliveryPreferences,
  handlePortalDeliveryDate,
  handlePortalDeliveryTime,
  handlePortalAddress,
  handlePortalQuantity,
  handlePortalOrderMessages,
  handlePortalOrderMarkRead,
  handlePortalOrderReply,
  handlePortalGenerateReply,
  handlePortalTemplatesList,
  handlePortalTemplatesCreate,
  handlePortalTemplatesUpdate,
  handlePortalTemplatesDelete,
  handlePortalTemplatesReorder,
  handlePortalCancel,
  requirePortalAuth,
  requireTicketOrderContextAuth,
  handleTicketOrderContext,
  getShipmentSyncStatusForOrder,
} from "../src/lib/portal/handlers.mjs";

export async function runScheduledPipelineWithOwnership(env, cron, injected = {}) {
  const phases = phasesForCron(cron);
  if (phases.length === 0) return { ok: true, completion_state: "unknown_cron_noop", scheduler_ownership_blocked: [] };
  const createClient = injected.createClient || createBaserowClient;
  const executePipeline = injected.runPipeline || runPipeline;
  const fenceClient = createClient({
    ...env, DATABASE_BACKEND: "supabase", ORDERMGMT_WORKLOAD_ID: "ordermgmt_scheduler_fence",
  });
  const fence = fenceClient.type === "supabase"
    ? await fenceCloudflareScheduledPhases(fenceClient.supabase, phases, {
      release: text(env.RELEASE_VERSION) || "unknown", now: injected.now || new Date(),
    })
    : { allowed: [], blocked: phases.map((phase) => ({ phase, workload_id: null, reason: "scheduler_ownership_requires_supabase" })) };
  if (fence.allowed.length === 0) {
    return { ok: false, completion_state: "blocked_by_scheduler_ownership", scheduler_ownership_blocked: fence.blocked };
  }
  const result = await executePipeline(env, {
    mode: fence.allowed.length === 1 ? fence.allowed[0] : "scheduled",
    phases: fence.allowed, triggerType: "cron", cron,
  });
  return { ...result, scheduler_ownership_blocked: fence.blocked };
}

export function resolveAdminRunRequest(body = {}) {
  if (body && body.confirm_write === true) {
    return { ok: false, statusCode: 409, error: "manual_write_requires_governed_orchestrator" };
  }
  return {
    ok: true,
    body: { ...(body || {}), dryRun: true, triggerType: "admin_dry_run" },
  };
}



export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "rp-order-mgmt",
        release_version: text(env.RELEASE_VERSION) || "unknown",
        ts: new Date().toISOString(),
      });
    }

    const ticketOrderMatch = matchPath(url.pathname, "/internal/ticket-order/:id");
    if (ticketOrderMatch && request.method === "GET") {
      if (!requireTicketOrderContextAuth(request, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      try {
        const result = await handleTicketOrderContext(env, ticketOrderMatch.id, {
          platform: url.searchParams.get("platform"),
          accountId: url.searchParams.get("account_id"),
        });
        return json(result, result.ok ? 200 : (result.statusCode || 404));
      } catch (error) {
        return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
      }
    }

    // ── Webhook intake ──────────────────────────────────────────────
    if (url.pathname === "/webhooks/mercari-message" && request.method === "POST") {
      return handleMercariMessageWebhook(request, env, ctx);
    }

    // ── Portal SPA redirect ─────────────────────────────────────────
    // The legacy inline Worker portal is retired. Browser traffic uses the
    // React portal hosted on the VPS; Worker API routes remain available.
    if (url.pathname === "/" || url.pathname === "/portal") {
      const accept = request.headers.get("Accept") || "";
      if (url.pathname === "/portal" || accept.includes("text/html")) {
        return Response.redirect("https://order.homesbliss.net/", 308);
      }
    }

    // ── Portal API ──────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/portal/")) {
      if (!requirePortalAuth(request, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }

      const method = request.method;

      if (url.pathname === "/api/portal/metrics" && method === "GET") {
        try {
          return json(await handlePortalMetrics(env, url.searchParams));
        } catch (error) {
          const status = normalizeErrorMessage(error) === "invalid_metrics_window" ? 400 : 500;
          return json({ ok: false, error: normalizeErrorMessage(error) }, status);
        }
      }

      // GET /api/portal/summary
      if (url.pathname === "/api/portal/summary" && method === "GET") {
        try {
          const result = await handlePortalSummary(env, url.searchParams);
          return json(result, result.statusCode || 200);
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // GET /api/portal/fee-orders (must precede :id route so fee-orders isn't captured as an order ID)
      if (url.pathname === "/api/portal/fee-orders" && method === "GET") {
        try {
          const result = await handlePortalFeeOrderList(env, url.searchParams);
          return json(result, result.statusCode || 200);
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // GET /api/portal/orders/:id
      const detailMatch = matchPath(url.pathname, "/api/portal/orders/:id");
      if (detailMatch && method === "GET") {
        try {
          const result = await handlePortalOrderDetail(env, detailMatch.id);
          return json(result, result.ok ? 200 : (result.statusCode || 404));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // GET /api/portal/orders
      if (url.pathname === "/api/portal/orders" && method === "GET") {
        try {
          const result = await handlePortalOrderList(env, url.searchParams);
          return json(result, result.statusCode || 200);
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // ── Portal write endpoints ───────────────────────────────────

      // POST /api/portal/orders/bulk-approve
      if (url.pathname === "/api/portal/orders/bulk-approve" && method === "POST") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalBulkApprove(env, body);
          return json(result, result.ok ? 200 : 400);
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/review
      const reviewMatch = matchPath(url.pathname, "/api/portal/orders/:id/review");
      if (reviewMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalReview(env, reviewMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // POST /api/portal/orders/:id/confirm — Rakuten order confirmation
      const confirmMatch = matchPath(url.pathname, "/api/portal/orders/:id/confirm");
      if (confirmMatch && method === "POST") {
        try {
          const result = await handlePortalConfirm(env, confirmMatch.id);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // POST /api/portal/orders/:id/cancel — mark order cancelled (local guard)
      const cancelMatch = matchPath(url.pathname, "/api/portal/orders/:id/cancel");
      if (cancelMatch && method === "POST") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalCancel(env, cancelMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/memo
      const memoMatch = matchPath(url.pathname, "/api/portal/orders/:id/memo");
      if (memoMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalMemo(env, memoMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/b2b-code
      const b2bMatch = matchPath(url.pathname, "/api/portal/orders/:id/b2b-code");
      if (b2bMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalB2bCode(env, b2bMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/delivery-date
      const deliveryDateMatch = matchPath(url.pathname, "/api/portal/orders/:id/delivery-date");
      if (deliveryDateMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalDeliveryDate(env, deliveryDateMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/delivery-time
      const deliveryTimeMatch = matchPath(url.pathname, "/api/portal/orders/:id/delivery-time");
      if (deliveryTimeMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalDeliveryTime(env, deliveryTimeMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/delivery-preferences
      const deliveryPreferencesMatch = matchPath(url.pathname, "/api/portal/orders/:id/delivery-preferences");
      if (deliveryPreferencesMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalDeliveryPreferences(env, deliveryPreferencesMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/address
      const addressMatch = matchPath(url.pathname, "/api/portal/orders/:id/address");
      if (addressMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalAddress(env, addressMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/orders/:id/quantity
      const qtyMatch = matchPath(url.pathname, "/api/portal/orders/:id/quantity");
      if (qtyMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalQuantity(env, qtyMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // POST /api/portal/orders/:id/messages/read — explicit mark-as-read
      const messagesReadMatch = matchPath(url.pathname, "/api/portal/orders/:id/messages/read");
      if (messagesReadMatch && method === "POST") {
        try {
          const result = await handlePortalOrderMarkRead(env, messagesReadMatch.id);
          return json(result, result.ok ? 200 : (result.statusCode || 500));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // GET /api/portal/orders/:id/messages — fetch customer messages
      // POST /api/portal/orders/:id/messages — send reply
      const messagesMatch = matchPath(url.pathname, "/api/portal/orders/:id/messages");
      if (messagesMatch && (method === "GET" || method === "POST")) {
        try {
          if (method === "GET") {
            const refresh = url.searchParams.get("refresh") === "1";
            const result = await handlePortalOrderMessages(env, messagesMatch.id, { refresh });
            return json(result, result.ok ? 200 : (result.statusCode || 500));
          }
          // POST — send reply
          const body = await safeJson(request);
          const result = await handlePortalOrderReply(env, messagesMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // POST /api/portal/orders/:id/generate-reply — AI draft polish / generate
      const generateMatch = matchPath(url.pathname, "/api/portal/orders/:id/generate-reply");
      if (generateMatch && method === "POST") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalGenerateReply(env, generateMatch.id, body);
          return json(result, result.ok ? 200 : (result.statusCode || 500));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // /api/portal/templates — CRUD
      if (url.pathname === "/api/portal/templates") {
        try {
          if (method === "GET") {
            const result = await handlePortalTemplatesList(env);
            return json(result);
          }
          if (method === "POST") {
            const body = await safeJson(request);
            const result = await handlePortalTemplatesCreate(env, body);
            return json(result, result.ok ? 200 : (result.statusCode || 400));
          }
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
        return json({ ok: false, error: "method_not_allowed" }, 405);
      }

      // /api/portal/templates/reorder — move template up/down
      if (url.pathname === "/api/portal/templates/reorder" && method === "POST") {
        try {
          const body = await safeJson(request);
          const result = await handlePortalTemplatesReorder(env, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // /api/portal/templates/:id — single template CRUD
      const templateMatch = matchPath(url.pathname, "/api/portal/templates/:id");
      if (templateMatch) {
        try {
          if (method === "PUT") {
            const body = await safeJson(request);
            const result = await handlePortalTemplatesUpdate(env, templateMatch.id, body);
            return json(result, result.ok ? 200 : (result.statusCode || 400));
          }
          if (method === "DELETE") {
            const result = await handlePortalTemplatesDelete(env, templateMatch.id);
            return json(result, result.ok ? 200 : (result.statusCode || 404));
          }
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
        return json({ ok: false, error: "method_not_allowed" }, 405);
      }

      // GET /api/portal/presale — presale dashboard grouped by B2BItemCode
      if (url.pathname === "/api/portal/presale" && method === "GET") {
        try {
          const result = await handlePortalPresale(env, url.searchParams);
          return json(result);
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      // PATCH /api/portal/presale/:itemCode/memo — append restock memo
      const presaleMemoMatch = matchPath(url.pathname, "/api/portal/presale/:itemCode/memo");
      if (presaleMemoMatch && method === "PATCH") {
        try {
          const body = await safeJson(request);
          const result = await handlePresaleMemo(env, presaleMemoMatch.itemCode, body);
          return json(result, result.ok ? 200 : (result.statusCode || 400));
        } catch (error) {
          return json({ ok: false, error: normalizeErrorMessage(error) }, 500);
        }
      }

      return json({ ok: false, error: "not_found" }, 404);
    }

    // ── Admin endpoints ────────────────────────────────────────────
    if (url.pathname.startsWith("/admin/") && !requireAdminAuth(request, env)) {
      return adminAuthErrorResponse();
    }

    if (url.pathname === "/admin/run-once" && request.method === "POST") {
      const body = await safeJson(request);
      const requestPlan = resolveAdminRunRequest(body || {});
      if (!requestPlan.ok) return json(requestPlan, requestPlan.statusCode);
      const result = await runPipeline(env, requestPlan.body);
      return json(result, result.ok ? 200 : (result.statusCode || 400));
    }

    if (url.pathname === "/admin/dry-run" && request.method === "POST") {
      const body = await safeJson(request);
      const result = await runPipeline(env, { ...body, dryRun: true });
      return json(result, result.ok ? 200 : (result.statusCode || 400));
    }

    if (url.pathname === "/admin/stuck-orders" && request.method === "GET") {
      const result = await inspectStuckOrders(env, {
        shops: url.searchParams.get("shops") || env.MERCARI_SHOPS || DEFAULT_SHOPS.join(","),
        thresholdMinutes: parseInteger(url.searchParams.get("threshold_minutes") || env.OUTBOUND_STUCK_THRESHOLD_MINUTES, 20),
      });
      return json(result, result.ok ? 200 : (result.statusCode || 400));
    }

    if (url.pathname === "/admin/stuck-tracking" && request.method === "GET") {
      const result = await inspectTrackingBacklog(env, {
        shops: url.searchParams.get("shops") || env.MERCARI_SHOPS || DEFAULT_SHOPS.join(","),
        thresholdMinutes: parseInteger(url.searchParams.get("threshold_minutes") || env.TRACKING_STUCK_THRESHOLD_MINUTES, 60),
      });
      return json(result, result.ok ? 200 : (result.statusCode || 400));
    }

    if (url.pathname === "/admin/stuck-close" && request.method === "GET") {
      const result = await inspectShopCloseBacklog(env, {
        shops: url.searchParams.get("shops") || env.MERCARI_SHOPS || DEFAULT_SHOPS.join(","),
        thresholdMinutes: parseInteger(url.searchParams.get("threshold_minutes") || env.SHOP_CLOSE_STUCK_THRESHOLD_MINUTES, 30),
      });
      return json(result, result.ok ? 200 : (result.statusCode || 400));
    }

    if (url.pathname === "/admin/verify-already-exists" && request.method === "GET") {
      const result = await verifyAlreadyExistsOrders(env, {
        shops: url.searchParams.get("shops") || env.MERCARI_SHOPS || DEFAULT_SHOPS.join(","),
        orderIds: url.searchParams.get("order_ids") || "",
      });
      return json(result, result.ok ? 200 : (result.statusCode || 400));
    }

    return json({
      ok: true,
      service: "rp-order-mgmt",
      endpoints: ["/health", "/admin/run-once", "/admin/dry-run", "/admin/stuck-orders", "/admin/stuck-tracking", "/admin/stuck-close", "/admin/verify-already-exists", "/webhooks/mercari-message"],
      note: "Use scheduled cron or admin endpoints to run order management.",
    });
  },

  async scheduled(controller, env, ctx) {
    const cron = controller && controller.cron ? controller.cron : "unknown";
    if (!shouldHandleCron(cron)) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        cron,
        service: "rp-order-mgmt",
        ok: true,
        summary: { note: "unknown_cron_noop" },
      }));
      return;
    }
    ctx.waitUntil((async () => {
      const result = await runScheduledPipelineWithOwnership(env, cron);
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        cron,
        service: "rp-order-mgmt",
        ok: !!result.ok,
        summary: result,
      }));
    })());
  },
};

// ── Admin diagnostic functions ────────────────────────────────────

async function inspectStuckOrders(env, { shops, thresholdMinutes }) {
  const baserow = createBaserowClient(env);
  const stuckFilter = {
    [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
  };
  const selectedShopIds = new Set(resolveShops(shops).map((shop) => DEFAULT_SHOP_IDS[shop]).filter(Boolean));
  if (selectedShopIds.size === 1) {
    stuckFilter[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = Array.from(selectedShopIds)[0];
  }
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId, stuckFilter);
  // Shipments: need cross-reference with sales, can't easily filter server-side
  const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId);
  const shipmentByScope = new Map();
  for (const row of shipmentRows) {
    const scope = diagnosticOrderScope(row.SourceStoreID, row.OrderId);
    if (!scope) continue;
    shipmentByScope.set(scope, row);
  }
  const thresholdMs = Date.now() - (Math.max(1, thresholdMinutes) * 60 * 1000);
  const stuck = [];
  for (const row of salesRows) {
    const orderId = normalizeOrderIdCandidate(row.order_id);
    const shopId = text(row.source_store_id || row.shop_id);
    if (!orderId || !selectedShopIds.has(shopId)) continue;
    if (text(row.order_status) !== "WAITING_FOR_SHIPPING") continue;
    const shipment = shipmentByScope.get(diagnosticOrderScope(shopId, orderId));
    if (!shipment) continue;
    if (text(shipment.giga_sync_attempted_at)) continue;
    const createdAtMs = Date.parse(text(shipment.OrderDate) || text(row.purchase_date));
    if (!Number.isFinite(createdAtMs) || createdAtMs > thresholdMs) continue;
    stuck.push({
      order_id: orderId,
      shop_id: shopId,
      sales_row_id: row.id,
      shipment_row_id: shipment.id,
      order_status: text(row.order_status),
      giga_sync_status: text(shipment.giga_sync_status) || null,
      giga_sync_attempted_at: text(shipment.giga_sync_attempted_at) || null,
      order_date: text(shipment.OrderDate) || null,
    });
  }
  return {
    ok: true,
    threshold_minutes: thresholdMinutes,
    shops: Array.from(selectedShopIds),
    count: stuck.length,
    results: stuck,
  };
}

async function inspectTrackingBacklog(env, { shops, thresholdMinutes }) {
  const baserow = createBaserowClient(env);
  // Only need Synced shipments that are still waiting for tracking
  const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId, {
    [`filter__field_${FIELD.SHIPMENT.GIGA_SYNC_STATUS}__single_select_equal`]: OPTION.GIGA_SYNC_STATUS.SYNCED,
  });
  const selectedShopIds = new Set(resolveShops(shops).map((shop) => DEFAULT_SHOP_IDS[shop]).filter(Boolean));
  const thresholdMs = Date.now() - (Math.max(1, thresholdMinutes) * 60 * 1000);
  const results = [];

  for (const row of shipmentRows) {
    const orderId = normalizeOrderIdCandidate(row.OrderId);
    const storeId = text(row.SourceStoreID);
    const gigaSyncStatus = readSelectValue(row.giga_sync_status);
    const shippingCompletedAt = text(row.shipping_completed_at);
    const orderDate = text(row.OrderDate);
    const orderDateMs = Date.parse(orderDate);
    if (!orderId || !selectedShopIds.has(storeId)) continue;
    if (!statusEquals(gigaSyncStatus, GIGA_SYNC_STATUS.SYNCED) && !statusEquals(gigaSyncStatus, GIGA_SYNC_STATUS.ALREADY_EXISTS)) {
      continue;
    }
    if (shippingCompletedAt) continue;
    if (!Number.isFinite(orderDateMs) || orderDateMs > thresholdMs) continue;
    results.push({
      order_id: orderId,
      shipment_row_id: row.id,
      store_id: storeId,
      order_date: orderDate || null,
      age_minutes: Math.floor((Date.now() - orderDateMs) / 60000),
      giga_sync_status: gigaSyncStatus,
      giga_sync_processed_at: text(row.giga_sync_processed_at) || null,
      giga_sync_request_id: text(row.giga_sync_request_id) || null,
      shipping_completed_at: shippingCompletedAt || null,
    });
  }

  results.sort((left, right) => (right.age_minutes || 0) - (left.age_minutes || 0));
  return {
    ok: true,
    threshold_minutes: thresholdMinutes,
    shops: Array.from(selectedShopIds),
    count: results.length,
    results,
  };
}

async function inspectShopCloseBacklog(env, { shops, thresholdMinutes }) {
  const baserow = createBaserowClient(env);
  // Need both WAITING_FOR_SHIPPING and COMPLETED — tracking reconciliation promoted
  // WAITING_FOR_SHIPPING rows to COMPLETED once tracking arrived.
  const [salesWfs, salesCompleted] = await Promise.all([
    listAllRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
    }),
    listAllRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: OPTION.ORDER_STATUS.COMPLETED,
    }),
  ]);
  const salesRows = [...salesWfs, ...salesCompleted];
  const selectedShopIds = new Set(resolveShops(shops).map((shop) => DEFAULT_SHOP_IDS[shop]).filter(Boolean));
  const thresholdMs = Date.now() - (Math.max(1, thresholdMinutes) * 60 * 1000);
  const results = [];

  for (const row of salesRows) {
    const orderId = normalizeOrderIdCandidate(row.order_id);
    const shopId = text(row.shop_id);
    const shippingCompletedAt = text(row.shipping_completed_at);
    const shopCloseStatus = text(row.shop_close_status);
    const shopCloseAttemptedAt = text(row.shop_close_attempted_at);
    const shopCloseCompletedAt = text(row.shop_close_completed_at);
    const shopCloseError = text(row.shop_close_error);
    const shippingCompletedMs = Date.parse(shippingCompletedAt);
    const attemptedMs = Date.parse(shopCloseAttemptedAt);
    if (!orderId || !selectedShopIds.has(shopId)) continue;
    if (!shippingCompletedAt || !Number.isFinite(shippingCompletedMs)) continue;
    if (shopCloseCompletedAt) continue;
    const staleWithoutAttempt = !shopCloseAttemptedAt && shippingCompletedMs <= thresholdMs;
    const staleAttempt = shopCloseAttemptedAt && Number.isFinite(attemptedMs) && attemptedMs <= thresholdMs;
    if (!staleWithoutAttempt && !staleAttempt) continue;
    results.push({
      order_id: orderId,
      sales_row_id: row.id,
      shop_id: shopId,
      order_status: text(row.order_status) || null,
      shipping_completed_at: shippingCompletedAt,
      age_minutes_since_shipping: Math.floor((Date.now() - shippingCompletedMs) / 60000),
      shop_close_status: shopCloseStatus || null,
      shop_close_attempted_at: shopCloseAttemptedAt || null,
      shop_close_completed_at: shopCloseCompletedAt || null,
      shop_close_error: shopCloseError || null,
    });
  }

  results.sort((left, right) => (right.age_minutes_since_shipping || 0) - (left.age_minutes_since_shipping || 0));
  return {
    ok: true,
    threshold_minutes: thresholdMinutes,
    shops: Array.from(selectedShopIds),
    count: results.length,
    results,
  };
}

async function verifyAlreadyExistsOrders(env, { shops, orderIds }) {
  const baserow = createBaserowClient(env);
  const giga = new GigaClient(env.GIGA_CLIENT_ID, env.GIGA_CLIENT_SECRET, env.GIGA_API_BASE_URL);
  const selectedShopIds = new Set(resolveShops(shops).map((shop) => DEFAULT_SHOP_IDS[shop]).filter(Boolean));
  const selectedOrderIds = new Set(parseOrderIds(orderIds));
  // Only need "Already Exists" rows — the ones flagged for verification
  const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId, {
    [`filter__field_${FIELD.SHIPMENT.GIGA_SYNC_STATUS}__single_select_equal`]: OPTION.GIGA_SYNC_STATUS.ALREADY_EXISTS,
  });
  const candidates = shipmentRows
    .map((row) => {
      const status = readSelectValue(row.giga_sync_status);
      return {
        order_id: normalizeOrderIdCandidate(row.OrderId),
        shipment_row_id: row.id,
        store_id: text(row.SourceStoreID),
        giga_sync_status: status,
        giga_sync_request_id: text(row.giga_sync_request_id) || null,
        giga_sync_processed_at: text(row.giga_sync_processed_at) || null,
      };
    })
    .filter((row) => row.order_id && statusEquals(row.giga_sync_status, GIGA_SYNC_STATUS.ALREADY_EXISTS) && selectedShopIds.has(row.store_id))
    .filter((row) => !selectedOrderIds.size || selectedOrderIds.has(row.order_id));
  const results = [];
  for (const candidate of candidates) {
    try {
      const response = await giga.getTrackingInfo([candidate.order_id]);
      const data = Array.isArray(response && response.data) ? response.data : [];
      const matched = data.find((item) => normalizeOrderIdCandidate(item && item.orderNo) === candidate.order_id);
      results.push({
        ...candidate,
        verification_status: matched ? "confirmed_by_tracking_api" : "not_returned_by_tracking_api",
        tracking_lines: matched && Array.isArray(matched.shipTrackInfo) ? matched.shipTrackInfo.length : 0,
        verification_request_id: text(response && response.requestId) || null,
      });
    } catch (error) {
      results.push({
        ...candidate,
        verification_status: error && error.gigaCode === "B40004" ? "not_found_by_tracking_api" : "verification_error",
        verification_error_code: text(error && error.gigaCode) || null,
        verification_error_message: text(error && error.gigaMessage) || text(error && error.message) || null,
      });
    }
  }
  return {
    ok: true,
    shops: Array.from(selectedShopIds),
    count: results.length,
    suspicious_count: results.filter((item) => item.verification_status === "not_found_by_tracking_api" || item.verification_status === "verification_error").length,
    results,
  };
}

export function diagnosticOrderScope(storeId, orderId) {
  const store = text(storeId).toLowerCase();
  const order = normalizeOrderIdCandidate(orderId).toLowerCase();
  return store && order ? `${store}\u0000${order}` : "";
}

function parseOrderIds(raw) {
  return String(raw || "")
    .split(/[,\s;]+/g)
    .map((item) => normalizeOrderIdCandidate(item))
    .filter(Boolean);
}

function makeRowKey(orderId, sku) {
  const left = normalizeOrderIdCandidate(orderId);
  const right = normalizeSkuCandidate(sku);
  if (!left || !right) return "";
  return `${left}::${right}`;
}

function rowsEquivalent(existingRow, targetRow) {
  for (const key of Object.keys(targetRow)) {
    const left = normalizeComparable(existingRow ? existingRow[key] : "");
    const right = normalizeComparable(targetRow[key]);
    if (left !== right) return false;
  }
  return true;
}

function normalizeComparable(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r\n/g, "\n").trim();
}

function mapShippingMethod(value) {
  const s = normalizeText(value);
  if (!s) return "";
  if (s === "UNDECIDED") return "未定(出品者が手配)";
  return s;
}

function normalizeCountryCode(value) {
  const s = normalizeText(value);
  if (!s) return "";
  return s.toUpperCase();
}

function normalizePostalCode(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function normalizePhone(value) {
  return normalizeText(value).replace(/[^\d+]/g, "");
}

function buildFullName(shippingAddress) {
  if (!shippingAddress || typeof shippingAddress !== "object") return "";
  const lastName = normalizeText(shippingAddress.lastName);
  const firstName = normalizeText(shippingAddress.firstName);
  return `${lastName}${firstName}`.trim();
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\r\n/g, "\n").trim();
}

function normalizeSkuCandidate(value) {
  return normalizeText(value);
}

function formatBaserowDateTime(value) {
  return toJstIso(value);
}
