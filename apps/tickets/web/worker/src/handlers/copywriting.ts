/**
 * New Ticketing Copywriting Handlers — AI reply generation, Mercari send, drafts, thread loading.
 * Route prefix: /api/ticketing.
 * Gated behind ENABLE_NEW_TICKETING feature flag in index.ts.
 */

import { getSupabaseClient } from "../repositories/supabase";
import { SupabaseTicketRepository } from "../repositories/supabaseTicketRepository";
import { SupabaseCopywritingRepository } from "../repositories/supabaseCopywritingRepository";
import { TicketService } from "../services/ticketService";
import { CopywritingService } from "../services/copywritingService";
import { SendError } from "../services/sendError";
import { PlatformSendRouter } from "../services/platformSendRouter";
import { ServiceBindingSendAdapter } from "../runtimes/providerContract";
import { validateSession } from "../middleware/auth";
import type { Env } from "../types";
import type { TicketDetail } from "../repositories/ticketRepository";
import { AFTERSALES_FORM_PLACEHOLDER } from "../logic/templates";
import { ticketFormExpiresAt } from "../logic/ticketform-validity";

// ── Helpers ──

function getServices(env: Env) {
  const supabase = getSupabaseClient(env);
  const ticketRepo = new SupabaseTicketRepository(supabase);
  const copyRepo = new SupabaseCopywritingRepository(supabase);
  const ticketService = new TicketService(ticketRepo);
  const copywritingService = new CopywritingService(
    copyRepo,
    ticketRepo,
    env.OPENAI_API_KEY || "",
  );
  return { supabase, copyRepo, ticketService, copywritingService };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function error(msg: string, code?: string, status = 400): Response {
  return json({ error: { message: msg, code } }, status);
}

async function hashToken(plain: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function operationToken(secret: string, ticketId: string, clientOperationId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`operator-ticketform:${ticketId}:${clientOperationId}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createAfterSalesFormLink(
  request: Request,
  supabase: ReturnType<typeof getSupabaseClient>,
  ticket: TicketDetail,
  clientOperationId: string,
  signingSecret: string,
  createdBy?: string | null,
): Promise<string> {
  const plainToken = await operationToken(signingSecret, ticket.id, clientOperationId);
  const tokenHash = await hashToken(plainToken);
  const expiresAt = ticketFormExpiresAt();
  const { error: insertError } = await supabase.from("submission_tokens").upsert({
    token_hash: tokenHash,
    ticket_id: ticket.id,
    platform: ticket.platform,
    account_id: ticket.account_id,
    external_order_id: ticket.external_order_id,
    allowed_submission_type: "damage_evidence",
    status: "active",
    expires_at: expiresAt,
    max_upload_count: 5,
    created_by: createdBy || "ticketing_operator",
  }, { onConflict: "token_hash", ignoreDuplicates: true });
  if (insertError) {
    console.error("After-sales form token persistence failed", { error_type: "database_write" });
    throw new SendError("Unable to create the after-sales form link", "FORM_LINK_FAILED", 500);
  }
  return `${new URL(request.url).origin}/forms/after-sales/${plainToken}`;
}

// ── 1. Generate AI Reply ──

export async function handleCopywrite(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", "UNAUTHORIZED", 401);
  }

  if (!env.OPENAI_API_KEY) {
    return error("OpenAI API key not configured", "NO_API_KEY", 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return error("Invalid JSON", "VALIDATION_ERROR", 400);
  }

  const { ticketService, copywritingService } = getServices(env);
  const resolutionGuide = typeof body.resolution_guide === "string" ? body.resolution_guide.trim() : undefined;

  const { ticket } = await ticketService.getTicket(ticketId);
  if (!ticket) {
    return error("Ticket not found", "NOT_FOUND", 404);
  }

  try {
    const result = await copywritingService.generateReply(
      ticket,
      resolutionGuide || undefined,
      (body.operator_name as string) || undefined,
    );

    return json({
      reply: result.reply,
      model: result.model,
      prompt_version: result.prompt_version,
    });
  } catch (e) {
    console.error(`Copywrite error: ${e}`);
    return error(
      `Failed to generate AI reply: ${String(e).slice(0, 300)}`,
      "COPYWRITE_FAILED",
      500,
    );
  }
}

// ── 2. Send Reply to Mercari ──

export async function handleSendReply(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", "UNAUTHORIZED", 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return error("Invalid JSON", "VALIDATION_ERROR", 400);
  }

  let message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return error("Message is required", "VALIDATION_ERROR", 400);
  }

  const clientOperationId = typeof body.client_operation_id === "string"
    ? body.client_operation_id.trim()
    : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientOperationId)) {
    return error("client_operation_id must be a UUID generated once per send action", "VALIDATION_ERROR", 400);
  }

  const replyIntent = (body.reply_intent === "terminal" || body.reply_intent === "holding")
    ? body.reply_intent as "terminal" | "holding"
    : "holding"; // default to holding for safety

  const lastSeenMessageAt = typeof body.last_seen_message_at === "string"
    ? body.last_seen_message_at
    : undefined;

  const { supabase, ticketService } = getServices(env);

  const { ticket } = await ticketService.getTicket(ticketId);
  if (!ticket) {
    return error("Ticket not found", "NOT_FOUND", 404);
  }

  const router = new PlatformSendRouter([
    new ServiceBindingSendAdapter("mercari", env.MERCARI_SEND_PROVIDER, env.MERCARI_SEND_EXPECTED_SHA),
    new ServiceBindingSendAdapter("rakuten", env.RAKUTEN_SEND_PROVIDER, env.RAKUTEN_SEND_EXPECTED_SHA),
    new ServiceBindingSendAdapter("amazon", env.AMAZON_SEND_PROVIDER, env.AMAZON_SEND_EXPECTED_SHA),
  ]);

  try {
    // Capability must fail closed before form-token, outbox, or provider writes.
    await router.preflight(ticket);
    const containsLegacyFormLink = /https:\/\/baserow\.io\/form\/[A-Za-z0-9_-]+/.test(message);
    if (message.includes(AFTERSALES_FORM_PLACEHOLDER) || containsLegacyFormLink) {
      if (!env.TICKETFORM_TOKEN_SIGNING_SECRET) {
        throw new SendError("TicketForm signing secret is not configured", "FORM_LINK_FAILED", 500);
      }
      const formLink = await createAfterSalesFormLink(
        request, supabase, ticket, clientOperationId,
        env.TICKETFORM_TOKEN_SIGNING_SECRET, "portal_operator",
      );
      message = message
        .replaceAll(AFTERSALES_FORM_PLACEHOLDER, formLink)
        .replace(/https:\/\/baserow\.io\/form\/[A-Za-z0-9_-]+/g, formLink);
    }
    if (!ticket.external_order_id) {
      throw new SendError("Ticket has no external order ID", "NO_ORDER_ID", 400);
    }
    const result = await router.send({
      ticket,
      message,
      clientOperationId,
      replyIntent,
      reviewed: { lastSeenMessageAt },
      sentBy: "portal_operator",
    });
    return json({
      success: true,
      platform_message_id: result.platformMessageId,
      sent_at: result.sentAt,
      ticket_message: result.ticketMessage,
      replayed: result.replayed,
      ...(result.warning ? { warning: result.warning, warning_code: result.warningCode } : {}),
    });
  } catch (e) {
    if (e instanceof SendError) return error(e.message, e.code, e.status);
    console.error("Platform send failed", { platform: ticket.platform, error_type: e instanceof Error ? e.constructor.name : "unknown" });
    return error("Failed to send platform reply", "SEND_FAILED", 500);
  }
}

// ── 3. Save/Load Draft ──

export async function handleSaveDraft(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", "UNAUTHORIZED", 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return error("Invalid JSON", "VALIDATION_ERROR", 400);
  }

  const { supabase } = getServices(env);
  const copyRepo = new SupabaseCopywritingRepository(supabase);

  const draft = await copyRepo.saveDraft({
    ticket_id: ticketId,
    body: typeof body.body === "string" ? body.body : "",
    resolution_guide: typeof body.resolution_guide === "string" ? body.resolution_guide : undefined,
    created_by: (body.created_by as string) || null,
  });

  return json({ draft });
}

export async function handleGetDraft(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", "UNAUTHORIZED", 401);
  }

  const { supabase } = getServices(env);
  const copyRepo = new SupabaseCopywritingRepository(supabase);

  const draft = await copyRepo.getDraft(ticketId);
  return json({ draft });
}

// ── 4. Get Merged Thread ──

export async function handleGetThread(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", "UNAUTHORIZED", 401);
  }

  const { supabase, ticketService } = getServices(env);
  const { ticket } = await ticketService.getTicket(ticketId);
  if (!ticket) {
    return error("Ticket not found", "NOT_FOUND", 404);
  }

  const messages = [...(ticket.messages || [])].map((entry) => ({
    id: entry.id,
    source: "supabase" as const,
    role: entry.sender_type,
    body: entry.body,
    sentAt: entry.sent_at ?? entry.created_at,
    displayName: entry.sender_display_name ?? undefined,
    externalMessageId: entry.external_message_id ?? undefined,
  })).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const latestBuyer = messages.find((entry) => entry.role === "customer" || entry.role === "buyer" || entry.role === "BUYER");
  let latestThreadRevision: string | null = null;
  let latestCustomerRevision: string | null = null;
  if (ticket.platform === "amazon") {
    const { data: revisionRow } = await supabase.from("tickets")
      .select("message_revision,customer_message_revision")
      .eq("id", ticket.id)
      .maybeSingle();
    latestThreadRevision = typeof revisionRow?.message_revision === "number" ||
      typeof revisionRow?.message_revision === "string"
      ? String(revisionRow.message_revision)
      : null;
    latestCustomerRevision = typeof revisionRow?.customer_message_revision === "number" ||
      typeof revisionRow?.customer_message_revision === "string"
      ? String(revisionRow.customer_message_revision)
      : null;
  }
  return json({
    messages,
    latest_buyer_message_at: latestBuyer?.sentAt ?? null,
    latest_buyer_message_id: latestBuyer?.externalMessageId ?? latestBuyer?.id ?? null,
    latest_thread_revision: latestThreadRevision,
    latest_customer_revision: latestCustomerRevision,
    reply_context: null,
    fetch_error: null,
  });
}

// ── 5. Generate After-Sales Form Link (standalone, no send) ──

export async function handleGenerateAfterSalesLink(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", "UNAUTHORIZED", 401);
  }

  if (!env.TICKETFORM_TOKEN_SIGNING_SECRET) {
    return error("TicketForm signing secret is not configured", "FORM_LINK_FAILED", 503);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return error("Invalid JSON", "VALIDATION_ERROR", 400);
  }

  const clientOperationId = typeof body.client_operation_id === "string"
    ? body.client_operation_id.trim()
    : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientOperationId)) {
    return error("client_operation_id must be a UUID", "VALIDATION_ERROR", 400);
  }

  const { supabase, ticketService } = getServices(env);

  const { ticket } = await ticketService.getTicket(ticketId);
  if (!ticket) {
    return error("Ticket not found", "NOT_FOUND", 404);
  }

  const url = await createAfterSalesFormLink(
    request,
    supabase,
    ticket,
    clientOperationId,
    env.TICKETFORM_TOKEN_SIGNING_SECRET,
  );

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  return json({
    url,
    expires_at: expiresAt,
    ticket_id: ticket.id,
    external_order_id: ticket.external_order_id,
    platform: ticket.platform,
  }, 201);
}
