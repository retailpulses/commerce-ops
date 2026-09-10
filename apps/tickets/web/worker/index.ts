/**
 * Mercari Ticket Mgmt + Supabase Ticketing — Cloudflare Worker
 * Domain: tickets.homesbliss.net
 *
 * Routes:
 *   GET  /                        — Supabase ticketing frontend (HTML)
 *   GET  /ticketing               — Supabase ticketing frontend alias (HTML)
 *   POST /api/session             — verify password, issue session token
 *   GET  /api/health              — health check (public)
 *   /api/ticketing/*              — Supabase ticketing API
 *   POST /api/webhooks/mercari-message — stable facade to Mercari ingestion Worker
 */

import { runTicketFormStagingCleanup } from "./src/services/ticketFormStagingCleanupService";
import { SupabaseInboundMessageRepository } from "./src/repositories/inboundMessageRepository";
import { getSupabaseClient } from "./src/repositories/supabase";
import {
  handleListTickets as handleNewListTickets,
  handleCreateTicket as handleNewCreateTicket,
  handleGetTicket as handleNewGetTicket,
  handleGetOrderContext as handleNewGetOrderContext,
  handleUpdateTicket as handleNewUpdateTicket,
  handleLinkProduct as handleNewLinkProduct,
  handleUnlinkProduct as handleNewUnlinkProduct,
  handleAddMessage as handleNewAddMessage,
  handleAddNote as handleNewAddNote,
  handleUpdateNote as handleNewUpdateNote,
  handleListAttachments as handleNewListAttachments,
  handleUploadAttachment as handleNewUploadAttachment,
  handleFinalizeAttachmentUpload as handleNewFinalizeAttachmentUpload,
  handleDeleteAttachment as handleNewDeleteAttachment,
  handleEvidenceContent as handleNewEvidenceContent,
  handleListResolutions as handleNewListResolutions,
  handleRecordResolution as handleNewRecordResolution,
  handleSearchProducts as handleNewSearchProducts,
  handleGetIssueTypes as handleNewGetIssueTypes,
  handleGetStatuses as handleNewGetStatuses,
  handleListAccounts as handleNewListAccounts,
  handleListQueue as handleNewListQueue,
  handleGetQueueItem as handleNewGetQueueItem,
  handleUpdateQueueItem as handleNewUpdateQueueItem,
  handleIgnoreQueueItem as handleNewIgnoreQueueItem,
  handleLinkQueueItem as handleNewLinkQueueItem,
  handleConvertQueueItem as handleNewConvertQueueItem,
  handleQueueUnreadCount as handleNewQueueUnreadCount,
  handleQueueByTicket as handleNewQueueByTicket,
  serveTicketingIndex,
} from "./src/handlers/ticketing";
import {
  handleCopywrite as handleNewCopywrite,
  handleSendReply as handleNewSendReply,
  handleSaveDraft as handleNewSaveDraft,
  handleGetDraft as handleNewGetDraft,
  handleGetThread as handleNewGetThread,
  handleGenerateAfterSalesLink,
} from "./src/handlers/copywriting";
import {
  serveCustomerForm,
  handleFormSubmit,
  prepareCustomerFormUploads,
  finalizeCustomerFormSubmission,
} from "./src/handlers/customer-form";
import {
  handleAuthorizeTicketShareEvidence,
  handleCreateTicketShare,
  handleListTicketShares,
  handleResolveTicketShare,
  handleRevokeTicketShare,
  handleTicketShareEvidenceGrant,
} from "./src/handlers/ticket-shares";
import type { Env } from "./src/types";
import { handleTicketMetrics } from "./src/handlers/metrics";
import { validateSession } from "./src/middleware/auth";
export { TicketShareReplayGuard } from "./src/services/ticketShareReplayGuard";

// React frontend — auto-generated from ../frontend/dist/index.html
// Run: cd ../frontend && npm run build && cd ../worker && node -e "..."
import reactIndexHtml from "./src/react-index-html";

const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const SESSION_PREFIX = "session:";

// React frontend HTML response — fresh Response per call (clone() unreliable on CF)
function serveReactApp(): Response {
  return new Response(reactIndexHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── Helpers ──

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function messagingHealth(env: Env) {
  const targets = {
    "mercari.send": env.MERCARI_SEND_PROVIDER,
    "mercari.ingestion": env.MERCARI_INGESTION_PROVIDER,
    "rakuten.send": env.RAKUTEN_SEND_PROVIDER,
    "rakuten.ingestion": env.RAKUTEN_INGESTION_PROVIDER,
    "amazon.send": env.AMAZON_SEND_PROVIDER,
    "amazon.ingestion": env.AMAZON_INGESTION_PROVIDER,
  } as const;
  const entries = await Promise.all(Object.entries(targets).map(async ([key, binding]) => {
    if (!binding) return [key, { status: "unavailable", error_code: "BINDING_MISSING" }] as const;
    try {
      const response = await binding.fetch("https://runtime.internal/health", { signal: AbortSignal.timeout(2000) });
      const body = await response.json() as Record<string, unknown>;
      return [key, body] as const;
    } catch {
      return [key, { status: "unavailable", error_code: "PROBE_FAILED" }] as const;
    }
  }));
  const states = Object.fromEntries(entries) as Record<string, Record<string, unknown>>;
  return {
    mercari: { send: states["mercari.send"], ingestion: states["mercari.ingestion"] },
    rakuten: { send: states["rakuten.send"], ingestion: states["rakuten.ingestion"] },
    amazon: {
      spapi_send: states["amazon.send"],
      mail_ingestion: states["amazon.ingestion"],
      mail_attachments: { status: "disabled" },
      legacy_zoho_outbound: { status: "disabled" },
    },
  };
}

function errorResponse(msg: string, status = 400): Response {
  return jsonResponse({ error: msg }, status);
}

// ── Issue #60: canonical /tickets path ownership ──

// Deploy-injected release identity. When RELEASE_SHA is missing or malformed
// (e.g. local `wrangler dev`), fall back to a fixed 40-char sentinel so the
// portal release contract always returns an exact-length release_sha.
const LOCAL_RELEASE_SHA = "0000000000000000000000000000000000000000";

function releaseResponse(env: Env): Response {
  const injected = String(env.RELEASE_SHA || "").trim();
  const releaseSha = /^[0-9a-f]{40}$/.test(injected) ? injected : LOCAL_RELEASE_SHA;
  return jsonResponse({
    application: "tickets",
    release_sha: releaseSha,
    built_at: new Date().toISOString(),
    contract_version: 1,
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

// Legacy frontend entry points and their canonical /tickets equivalents.
const LEGACY_TO_CANONICAL: Record<string, string> = {
  "/": "/tickets/",
  "/ticketing": "/tickets/",
  "/ticketing/new": "/tickets/new",
  "/ticketing/queue": "/tickets/queue",
  "/queue": "/tickets/queue",
};

// Vite emits assets under /assets/*; the /tickets base rewrites browser URLs
// to /tickets/assets/*. Both namespaces are served from the same asset binding.
function isStaticAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/tickets/assets/") ||
    pathname === "/favicon.svg" ||
    pathname === "/tickets/favicon.svg"
  );
}

async function serveStaticAsset(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const assets = env.ASSETS;
  if (!assets) return errorResponse("Not found", 404);
  const assetPath = url.pathname.replace(/^\/tickets(?=\/)/, "");
  return assets.fetch(new Request(new URL(assetPath, url.origin).toString(), request));
}

// ── Route handlers ──

async function handleSession(request: Request, KV: KVNamespace, expectedHash: string): Promise<Response> {
  let body: { password?: string };
  try {
    body = (await request.json()) as Record<string, string>;
  } catch {
    return errorResponse("Invalid JSON");
  }

  if (!body.password) return errorResponse("Missing password");
  const passwordHash = await sha256Hex(body.password);
  if (passwordHash !== expectedHash) return errorResponse("Unauthorized", 401);

  const token = crypto.randomUUID();
  await KV.put(`${SESSION_PREFIX}${token}`, "valid", { expirationTtl: SESSION_TTL_SECONDS });
  return jsonResponse({ token, expires_in: SESSION_TTL_SECONDS });
}

// ── Main dispatcher ──

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
    const KV = env.MERCARI_REPORTS;
    const url = new URL(request.url);
    const method = request.method;

    // ── Issue #60: canonical /tickets path ownership ──
    // /tickets/api/release is a first-class portal contract endpoint; every
    // other /tickets/api/* request is normalized onto the existing /api/*
    // handlers so the portal-owned namespace and the legacy namespace stay
    // backed by a single implementation.
    if (url.pathname.startsWith("/tickets/api/")) {
      if (method === "GET" && url.pathname === "/tickets/api/release") {
        return releaseResponse(env);
      }
      url.pathname = url.pathname.replace(/^\/tickets\/api\//, "/api/");
      request = new Request(url.toString(), request);
    }

    const { pathname } = url;
    const isReadRequest = method === "GET" || method === "HEAD";

    // Serve static frontend assets (Vite build) under both /assets/* (legacy)
    // and /tickets/assets/* (canonical base).
    if (isReadRequest && isStaticAssetPath(pathname)) {
      return serveStaticAsset(request, env, url);
    }

    // CORS preflight — allow ticketing API methods.
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    // GET /api/health (public origin health) or /api/ticketing/health
    // (Portal-safe capability discovery routed through the ticket API namespace).
    //   ?detail=1 returns per-shop processing stats (Issue #126)
    if (
      method === "GET" &&
      (pathname === "/api/health" || pathname === "/api/ticketing/health")
    ) {
      const detail = url.searchParams.get("detail");
      if (detail === "1" && env.SUPABASE_URL) {
        try {
          const supabase = getSupabaseClient(env);
          const repo = new SupabaseInboundMessageRepository(supabase);
          const stats = await repo.getProcessingStats();
          const shopStats = await repo.getShopProcessingStats();
          return jsonResponse({
            status: "ok",
            version: "3.1.0-ticketing",
            ticket_pipeline: "supabase-only",
            ticketform_automation_mode: env.TICKETFORM_AUTOMATION_MODE || "shadow",
            ticket_shares_enabled: env.ENABLE_TICKET_SHARES === "true",
            rakuten_rmesse_outbound_enabled:
              env.RAKUTEN_RMESSE_OUTBOUND_ENABLED === "true",
            amazon_mail_ingestion_mode: env.AMAZON_MAIL_INGESTION_MODE || "off",
            amazon_mail_outbound_enabled: false,
            amazon_mail_attachments_enabled: env.AMAZON_MAIL_ATTACHMENTS_ENABLED === "true",
            messaging: await messagingHealth(env),
            webhook_processing: {
              aggregate: stats,
              by_shop: shopStats,
            },
          });
        } catch {
          // Fall through to basic health check
        }
      }
      return jsonResponse({
        status: "ok",
        version: "3.1.0-ticketing",
        ticket_pipeline: "supabase-only",
        ticketform_automation_mode: env.TICKETFORM_AUTOMATION_MODE || "shadow",
        ticket_shares_enabled: env.ENABLE_TICKET_SHARES === "true",
        rakuten_rmesse_outbound_enabled:
          env.RAKUTEN_RMESSE_OUTBOUND_ENABLED === "true",
        amazon_mail_ingestion_mode: env.AMAZON_MAIL_INGESTION_MODE || "off",
        amazon_mail_outbound_enabled: false,
        amazon_mail_attachments_enabled: env.AMAZON_MAIL_ATTACHMENTS_ENABLED === "true",
        messaging: await messagingHealth(env),
      });
    }

    if (method === "GET" && pathname === "/api/ticketing/metrics") {
      return handleTicketMetrics(request, env);
    }

    // POST /api/session
    if (method === "POST" && pathname === "/api/session") {
      return handleSession(request, KV, env.PASSWORD_HASH);
    }

    // Dedicated ConoHa seller-viewer bridge. Every POST is independently
    // authenticated with timestamped HMAC + fixed source IP inside the handler.
    if (env.ENABLE_TICKET_SHARES === "true") {
      if (method === "POST" && pathname === "/api/internal/ticket-shares/resolve") {
        return handleResolveTicketShare(request, env);
      }
      if (method === "POST" && pathname === "/api/internal/ticket-shares/evidence") {
        return handleAuthorizeTicketShareEvidence(request, env);
      }
      const shareEvidenceGrantMatch = pathname.match(/^\/api\/internal\/ticket-shares\/evidence\/content\/([^/]+)$/);
      if (method === "GET" && shareEvidenceGrantMatch) {
        return handleTicketShareEvidenceGrant(request, env, shareEvidenceGrantMatch[1]);
      }
    }

    // ── Customer Form (public, token-gated) ──

    // GET /forms/after-sales/:token — serve public form HTML
    const formPageMatch = pathname.match(/^\/forms\/after-sales\/([^/]+)$/);
    if (method === "GET" && formPageMatch) {
      return serveCustomerForm(request, env, formPageMatch[1]);
    }

    // POST /api/forms/submit/:token — handle form submission (multipart)
    const formSubmitMatch = pathname.match(/^\/api\/forms\/submit\/([^/]+)$/);
    if (method === "POST" && formSubmitMatch) {
      return handleFormSubmit(request, env, formSubmitMatch[1]);
    }

    // Direct-to-private-Storage flow for reliable files up to 100 MB.
    const formUploadMatch = pathname.match(/^\/api\/forms\/uploads\/([^/]+)$/);
    if (method === "POST" && formUploadMatch) {
      return prepareCustomerFormUploads(request, env, formUploadMatch[1]);
    }

    const formFinalizeMatch = pathname.match(/^\/api\/forms\/finalize\/([^/]+)$/);
    if (method === "POST" && formFinalizeMatch) {
      return finalizeCustomerFormSubmission(request, env, formFinalizeMatch[1]);
    }

    // Stable public ingress; provider credentials and processing remain isolated
    // behind the Mercari ingestion service binding.
    if (method === "POST" && pathname === "/api/webhooks/mercari-message") {
      if (!env.MERCARI_INGESTION_PROVIDER) return errorResponse("Mercari ingestion is unavailable", 503);
      return env.MERCARI_INGESTION_PROVIDER.fetch(request);
    }

    // POST /api/admin/mercari-webhooks — narrow setup endpoint for Shop4 webhook registration
    if (method === "POST" && pathname === "/api/admin/mercari-webhooks") {
      if (!env.MERCARI_INGESTION_PROVIDER) return errorResponse("Mercari ingestion is unavailable", 503);
      return env.MERCARI_INGESTION_PROVIDER.fetch(request);
    }

    // POST /api/admin/reconciliation-backfill — one-time deep backfill (Issue #126)
    if (method === "POST" && pathname === "/api/admin/reconciliation-backfill") {
      // Require shared secret (same as webhook auth) or session token
      const adminAuth = request.headers.get("Authorization") || "";
      const adminBearer = adminAuth.match(/^Bearer\s+(.+)$/i);
      const adminQuerySecret = url.searchParams.get("secret") || "";
      const adminSessionToken = adminAuth.match(/^Session\s+(.+)$/i);
      const expectedSecret = env.WEBHOOK_SHARED_SECRET;
      let authorized = false;
      if (expectedSecret) {
        if ((adminQuerySecret && adminQuerySecret === expectedSecret) ||
            (adminBearer?.[1] && adminBearer[1] === expectedSecret)) {
          authorized = true;
        }
      }
      // Also accept portal session token
      if (!authorized && adminSessionToken?.[1]) {
        const valid = await KV.get(`session:${adminSessionToken[1]}`);
        if (valid) authorized = true;
      }
      if (!authorized) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      try {
        if (!env.MERCARI_INGESTION_PROVIDER) return errorResponse("Mercari ingestion is unavailable", 503);
        return env.MERCARI_INGESTION_PROVIDER.fetch("https://ingestion.internal/v1/reconcile/backfill", { method: "POST" });
      } catch (e) {
        return jsonResponse({ error: `Backfill failed: ${e}` }, 500);
      }
    }

    // ── New Ticketing MVP (Supabase) Routes ──
    // Gated behind ENABLE_NEW_TICKETING env var

    if (env.ENABLE_NEW_TICKETING === "true") {
      // Use React frontend when feature flag is enabled
      const useReact = env.ENABLE_REACT_FRONTEND === "true";

      // GET short-lived private R2 evidence URL (grant itself is the auth).
      const evidenceContentMatch = pathname.match(/^\/api\/ticketing\/attachments\/([^/]+)\/content$/);
      if (method === "GET" && evidenceContentMatch) {
        return handleNewEvidenceContent(request, env, evidenceContentMatch[1]);
      }

      // ── Issue #60: canonical /tickets frontend ownership ──
      // Legacy entry points redirect to the canonical /tickets path so old
      // bookmarks and smoke probes keep working.
      const legacyRedirect = LEGACY_TO_CANONICAL[pathname];
      if (isReadRequest && legacyRedirect) {
        return redirectResponse(legacyRedirect);
      }

      // GET /tickets and any /tickets/* deep link — canonical SPA entry.
      if (isReadRequest && (pathname === "/tickets" || pathname.startsWith("/tickets/"))) {
        return useReact ? serveReactApp() : serveTicketingIndex();
      }

      // GET /api/ticketing/tickets
      if (method === "GET" && pathname === "/api/ticketing/tickets") {
        return handleNewListTickets(request, env);
      }

      // GET /api/ticketing/products/search
      if (method === "GET" && pathname === "/api/ticketing/products/search") {
        return handleNewSearchProducts(request, env);
      }

      // GET /api/ticketing/issue-types
      if (method === "GET" && pathname === "/api/ticketing/issue-types") {
        return handleNewGetIssueTypes(request, env);
      }

      // GET /api/ticketing/statuses
      if (method === "GET" && pathname === "/api/ticketing/statuses") {
        return handleNewGetStatuses(request, env);
      }

      // GET /api/ticketing/accounts
      if (method === "GET" && pathname === "/api/ticketing/accounts") {
        return handleNewListAccounts(request, env);
      }

      // POST /api/ticketing/tickets
      if (method === "POST" && pathname === "/api/ticketing/tickets") {
        return handleNewCreateTicket(request, env);
      }

      if (env.ENABLE_TICKET_SHARES === "true") {
        // GET/POST /api/ticketing/tickets/:id/shares
        const ticketSharesMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/shares$/);
        if (method === "GET" && ticketSharesMatch) {
          return handleListTicketShares(request, env, ticketSharesMatch[1]);
        }
        if (method === "POST" && ticketSharesMatch) {
          return handleCreateTicketShare(request, env, ticketSharesMatch[1], false);
        }

        // POST /api/ticketing/tickets/:id/shares/rotate
        const rotateTicketShareMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/shares\/rotate$/);
        if (method === "POST" && rotateTicketShareMatch) {
          return handleCreateTicketShare(request, env, rotateTicketShareMatch[1], true);
        }

        // DELETE /api/ticketing/tickets/:id/shares/:shareId
        const revokeTicketShareMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/shares\/([^/]+)$/);
        if (method === "DELETE" && revokeTicketShareMatch) {
          return handleRevokeTicketShare(request, env, revokeTicketShareMatch[1], revokeTicketShareMatch[2]);
        }
      }

      // POST /api/ticketing/tickets/:id/products
      const newProductMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/products$/);
      if (method === "POST" && newProductMatch) {
        return handleNewLinkProduct(request, env, newProductMatch[1]);
      }

      // DELETE /api/ticketing/tickets/:id/products/:productId
      const newProductDelMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/products\/([^/]+)$/);
      if (method === "DELETE" && newProductDelMatch) {
        return handleNewUnlinkProduct(request, env, newProductDelMatch[1], newProductDelMatch[2]);
      }

      // POST /api/ticketing/tickets/:id/messages
      const newMsgMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/messages$/);
      if (method === "POST" && newMsgMatch) {
        return handleNewAddMessage(request, env, newMsgMatch[1]);
      }

      // POST /api/ticketing/tickets/:id/notes
      const newNoteMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/notes$/);
      if (method === "POST" && newNoteMatch) {
        return handleNewAddNote(request, env, newNoteMatch[1]);
      }

      // PATCH /api/ticketing/tickets/:id/notes/:noteId
      const updateNoteMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/notes\/([^/]+)$/);
      if (method === "PATCH" && updateNoteMatch) {
        return handleNewUpdateNote(request, env, updateNoteMatch[1], updateNoteMatch[2]);
      }

      // GET/POST /api/ticketing/tickets/:id/attachments
      const attachmentMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/attachments$/);
      if (method === "GET" && attachmentMatch) {
        return handleNewListAttachments(request, env, attachmentMatch[1]);
      }
      if (method === "POST" && attachmentMatch) {
        return handleNewUploadAttachment(request, env, attachmentMatch[1]);
      }

      // POST /api/ticketing/tickets/:id/attachments/uploads/:uploadId/finalize
      const attachmentFinalizeMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/attachments\/uploads\/([^/]+)\/finalize$/);
      if (method === "POST" && attachmentFinalizeMatch) {
        return handleNewFinalizeAttachmentUpload(request, env, attachmentFinalizeMatch[1], attachmentFinalizeMatch[2]);
      }

      // DELETE /api/ticketing/tickets/:id/attachments/:attachmentId
      const attachmentDeleteMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/attachments\/([^/]+)$/);
      if (method === "DELETE" && attachmentDeleteMatch) {
        return handleNewDeleteAttachment(request, env, attachmentDeleteMatch[1], attachmentDeleteMatch[2]);
      }

      // GET/POST /api/ticketing/tickets/:id/resolutions
      const resolutionMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/resolutions$/);
      if (method === "GET" && resolutionMatch) {
        return handleNewListResolutions(request, env, resolutionMatch[1]);
      }
      if (method === "POST" && resolutionMatch) {
        return handleNewRecordResolution(request, env, resolutionMatch[1]);
      }

      // ── Phase 1: Copywriting & Send Routes ──

      if (method === "POST" && pathname === "/api/ticketing/rakuten-rmesse/sync") {
        if (!(await validateSession(request, env.MERCARI_REPORTS))) return errorResponse("Unauthorized", 401);
        if (!env.RAKUTEN_INGESTION_PROVIDER) return errorResponse("Rakuten ingestion is unavailable", 503);
        return env.RAKUTEN_INGESTION_PROVIDER.fetch("https://ingestion.internal/v1/sync", { method: "POST" });
      }
      if (method === "POST" && pathname === "/api/ticketing/amazon-mail/sync") {
        if (!(await validateSession(request, env.MERCARI_REPORTS))) return errorResponse("Unauthorized", 401);
        if (!env.AMAZON_INGESTION_PROVIDER) return errorResponse("Amazon ingestion is unavailable", 503);
        return env.AMAZON_INGESTION_PROVIDER.fetch("https://ingestion.internal/v1/sync", { method: "POST" });
      }

      // POST /api/ticketing/tickets/:id/copywrite
      const newCopywriteMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/copywrite$/);
      if (method === "POST" && newCopywriteMatch) {
        return handleNewCopywrite(request, env, newCopywriteMatch[1]);
      }

      // POST /api/ticketing/tickets/:id/send
      const newSendMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/send$/);
      if (method === "POST" && newSendMatch) {
        return handleNewSendReply(request, env, newSendMatch[1]);
      }


      // POST /api/ticketing/tickets/:id/after-sales-link
      const afterSalesLinkMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/after-sales-link$/);
      if (method === "POST" && afterSalesLinkMatch) {
        return handleGenerateAfterSalesLink(request, env, afterSalesLinkMatch[1]);
      }

      // POST /api/ticketing/tickets/:id/draft
      const newDraftMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/draft$/);
      if (method === "POST" && newDraftMatch) {
        return handleNewSaveDraft(request, env, newDraftMatch[1]);
      }

      // GET /api/ticketing/tickets/:id/draft
      if (method === "GET" && newDraftMatch) {
        return handleNewGetDraft(request, env, newDraftMatch[1]);
      }

      // GET /api/ticketing/tickets/:id/thread
      const newThreadMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/thread$/);
      if (method === "GET" && newThreadMatch) {
        return handleNewGetThread(request, env, newThreadMatch[1]);
      }

      // GET /api/ticketing/tickets/:id
      const orderContextMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)\/order-context$/);
      if (method === "GET" && orderContextMatch) {
        return handleNewGetOrderContext(request, env, orderContextMatch[1]);
      }

      // GET /api/ticketing/tickets/:id
      const newTicketDetailMatch = pathname.match(/^\/api\/ticketing\/tickets\/([^/]+)$/);
      if (method === "GET" && newTicketDetailMatch) {
        return handleNewGetTicket(request, env, newTicketDetailMatch[1]);
      }

      // PATCH /api/ticketing/tickets/:id
      if (method === "PATCH" && newTicketDetailMatch) {
        return handleNewUpdateTicket(request, env, newTicketDetailMatch[1]);
      }

      // ── Issue #109: Message Queue Routes ──

      // GET /api/ticketing/queue/unread-count
      if (method === "GET" && pathname === "/api/ticketing/queue/unread-count") {
        return handleNewQueueUnreadCount(request, env);
      }

      // GET /api/ticketing/queue/by-ticket/:ticketId
      const queueByTicketMatch = pathname.match(/^\/api\/ticketing\/queue\/by-ticket\/([^/]+)$/);
      if (method === "GET" && queueByTicketMatch) {
        return handleNewQueueByTicket(request, env, queueByTicketMatch[1]);
      }

      // GET /api/ticketing/queue
      if (method === "GET" && pathname === "/api/ticketing/queue") {
        return handleNewListQueue(request, env);
      }

      // GET /api/ticketing/queue/:id
      // POST /api/ticketing/queue/:id/ignore
      // POST /api/ticketing/queue/:id/link
      // POST /api/ticketing/queue/:id/convert
      const queueDetailMatch = pathname.match(/^\/api\/ticketing\/queue\/([^/]+)$/);
      const queueIgnoreMatch = pathname.match(/^\/api\/ticketing\/queue\/([^/]+)\/ignore$/);
      const queueLinkMatch = pathname.match(/^\/api\/ticketing\/queue\/([^/]+)\/link$/);
      const queueConvertMatch = pathname.match(/^\/api\/ticketing\/queue\/([^/]+)\/convert$/);

      if (method === "GET" && queueDetailMatch) {
        return handleNewGetQueueItem(request, env, queueDetailMatch[1]);
      }
      if (method === "PATCH" && queueDetailMatch) {
        return handleNewUpdateQueueItem(request, env, queueDetailMatch[1]);
      }
      if (method === "POST" && queueIgnoreMatch) {
        return handleNewIgnoreQueueItem(request, env, queueIgnoreMatch[1]);
      }
      if (method === "POST" && queueLinkMatch) {
        return handleNewLinkQueueItem(request, env, queueLinkMatch[1]);
      }
      if (method === "POST" && queueConvertMatch) {
        return handleNewConvertQueueItem(request, env, queueConvertMatch[1]);
      }
    }

    return errorResponse("Not found", 404);
    } catch (e) {
      console.error(`[FetchError] ${new URL(request.url).pathname}: ${e}`);
      return errorResponse("Internal server error", 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runTicketFormStagingCleanup(env);
  },
};
