/**
 * New Ticketing MVP Handlers — Supabase-backed ticket management.
 * Route prefix: /ticketing (UI) and /api/ticketing (API).
 * Gated behind ENABLE_NEW_TICKETING feature flag in index.ts.
 */

import { getSupabaseClient } from "../repositories/supabase";
import { SupabaseTicketRepository } from "../repositories/supabaseTicketRepository";
import { SupabaseInboundMessageRepository } from "../repositories/inboundMessageRepository";
import { TicketService } from "../services/ticketService";
import { InboundMessageService } from "../services/inboundMessageService";
import { TicketInboundQueueService } from "../services/ticketInboundQueueService";
import { validateSession } from "../middleware/auth";
import type { Env } from "../types";

// ── Helpers ──

function getService(env: Env): TicketService {
  const supabase = getSupabaseClient(env);
  const repo = new SupabaseTicketRepository(supabase);
  return new TicketService(repo);
}

function getQueueService(env: Env): InboundMessageService {
  const supabase = getSupabaseClient(env);
  const queueRepo = new SupabaseInboundMessageRepository(supabase);
  const ticketRepo = new SupabaseTicketRepository(supabase);
  return new InboundMessageService(queueRepo, ticketRepo, supabase);
}

function getUnifiedQueueService(env: Env): TicketInboundQueueService {
  const supabase = getSupabaseClient(env);
  return new TicketInboundQueueService(supabase, getQueueService(env));
}

function queueError(err: unknown): Response {
  const detail = err instanceof Error ? err.message : "";
  if (detail === "INVALID_QUEUE_REF" || detail === "INVALID_QUEUE_FILTER") return json({ error: detail }, 400);
  if (detail === "QUEUE_ITEM_NOT_FOUND" || detail.includes("_not_found") || detail.startsWith("Ticket not found")) {
    return json({ error: detail.includes("ticket") ? "TICKET_NOT_FOUND" : "QUEUE_ITEM_NOT_FOUND" }, 404);
  }
  if (detail === "ACTION_UNSUPPORTED") return json({ error: "ACTION_UNSUPPORTED" }, 422);
  if (detail === "QUEUE_STATE_CONFLICT" || /(_mismatch|_already_linked|_state_conflict|_account_unresolved|_not_allowed)/.test(detail)) {
    return json({ error: "QUEUE_STATE_CONFLICT" }, 409);
  }
  return json({ error: "SOURCE_UNAVAILABLE" }, 503);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function error(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

async function parseBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

// ── API Handlers ──

export async function handleListTickets(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const url = new URL(request.url);
  const service = getService(env);

  const { rows, total } = await service.listTickets({
    platform: url.searchParams.get("platform") ?? undefined,
    account_id: url.searchParams.get("account_id") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    status_group: url.searchParams.get("status_group") === "non_terminal" ? "non_terminal" : undefined,
    priority: url.searchParams.get("priority") ?? undefined,
    issue_type: url.searchParams.get("issue_type") ?? undefined,
    needs_reply:
      url.searchParams.get("needs_reply") === "true"
        ? true
        : url.searchParams.get("needs_reply") === "false"
          ? false
          : undefined,
    q: url.searchParams.get("q") ?? undefined,
    sort: url.searchParams.get("sort") ?? "created_at.desc",
    limit: parseInt(url.searchParams.get("limit") ?? "20", 10),
    offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
  });

  return json({ tickets: rows, total });
}

export async function handleCreateTicket(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getService(env);

  const { ticket, errors } = await service.createTicket({
    platform: (body.platform as string) ?? "mercari",
    account_id: (body.account_id as string) ?? null,
    external_order_id: (body.external_order_id as string) ?? null,
    customer_display_name: (body.customer_display_name as string) ?? null,
    subject: (body.subject as string) ?? null,
    description: (body.description as string) ?? null,
    status: (body.status as string) ?? "open",
    priority: (body.priority as string) ?? "normal",
    issue_types: (body.issue_types as string[]) ?? [],
    external_url: (body.external_url as string) ?? null,
  }, {
    source: "manual_operator_creation",
    actor_id: "portal_operator",
  });

  if (errors.length > 0) return json({ errors }, 422);
  return json({ ticket }, 201);
}

export async function handleGetTicket(
  request: Request,
  env: Env,
  ticketId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getService(env);
  const { ticket, events } = await service.getTicket(ticketId);
  if (!ticket) return error("Ticket not found", 404);
  return json({ ticket, events });
}

export async function handleGetOrderContext(request: Request, env: Env, ticketId: string): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) return error("Unauthorized", 401);
  const { ticket } = await getService(env).getTicket(ticketId);
  if (!ticket) return error("Ticket not found", 404);
  if (!ticket.external_order_id) return error("Ticket has no linked order", 404);
  const baseUrl = String(env.ORDERMGMT_ORDER_CONTEXT_URL || "").replace(/\/$/, "");
  const secret = String(env.ORDERMGMT_ORDER_CONTEXT_SECRET || "").trim();
  if (!baseUrl || !secret) return error("Order context unavailable", 503);
  const params = new URLSearchParams({ platform: ticket.platform });
  if (ticket.account_id) params.set("account_id", ticket.account_id);
  try {
    const response = await fetch(`${baseUrl}/internal/ticket-order/${encodeURIComponent(ticket.external_order_id)}?${params}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    });
    if (response.status === 404) return error("Order not found", 404);
    if (!response.ok) return error("Order context unavailable", 502);
    const payload = await response.json() as { ok?: boolean; order?: unknown };
    if (!payload.ok || !payload.order) return error("Order context unavailable", 502);
    return json({ order: payload.order });
  } catch {
    return error("Order context unavailable", 502);
  }
}

export async function handleUpdateTicket(
  request: Request,
  env: Env,
  ticketId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getService(env);
  const { ticket, error: err } = await service.updateTicket(ticketId, body as import("../repositories/ticketRepository").UpdateTicketInput);
  if (err) return error(err, 422);
  return json({ ticket });
}

export async function handleLinkProduct(
  request: Request,
  env: Env,
  ticketId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getService(env);
  const { product, error: err } = await service.linkProduct({
    ticket_id: ticketId,
    product_id: (body.product_id as string) || null,
    variant_id: (body.variant_id as string) || null,
    listing_id: (body.listing_id as string) || null,
    listing_sku_id: (body.listing_sku_id as string) || null,
    sku: (body.sku as string) || "",
    role: (body.role as string) || "related",
  });
  if (err) return error(err, 422);
  return json({ product }, 201);
}

export async function handleUnlinkProduct(
  request: Request,
  env: Env,
  ticketId: string,
  productId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getService(env);
  const { error: err } = await service.unlinkProduct(ticketId, productId);
  if (err) return error(err, 422);
  return json({ success: true });
}

export async function handleAddMessage(
  request: Request,
  env: Env,
  ticketId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getService(env);
  const { message, error: err } = await service.addMessage({
    ticket_id: ticketId,
    platform: (body.platform as string) ?? "mercari",
    sender_type: (body.sender_type as string) ?? "operator",
    sender_display_name: (body.sender_display_name as string) ?? null,
    body: (body.body as string) ?? "",
    sent_at: (body.sent_at as string) ?? new Date().toISOString(),
  });
  if (err) return error(err, 422);
  return json({ message }, 201);
}

export async function handleAddNote(
  request: Request,
  env: Env,
  ticketId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getService(env);
  const { note, error: err } = await service.addNote({
    ticket_id: ticketId,
    body: (body.body as string) ?? "",
    created_by: (body.created_by as string) ?? null,
  });
  if (err) return error(err, 422);
  return json({ note }, 201);
}

export async function handleUpdateNote(
  request: Request,
  env: Env,
  ticketId: string,
  noteId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) return error("Unauthorized", 401);
  const body = await parseBody<Record<string, unknown>>(request);
  const { note, error: err } = await getService(env).updateNote({
    ticket_id: ticketId,
    note_id: noteId,
    body: typeof body.body === "string" ? body.body : "",
  });
  if (err) return error(err, err === "Note not found" || err === "Ticket not found" ? 404 : 422);
  return json({ note });
}

export async function handleListAttachments(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getService(env);
  const { attachments, error: err } = await service.listAttachments(ticketId);
  if (err) return error(err, 404);

  const origin = new URL(request.url).origin;
  const enriched = await Promise.all(attachments.map(async (attachment) => {
    if (!attachment.storage_bucket.startsWith("r2:")) return attachment;
    if (!env.LEGACY_EVIDENCE) return attachment;
    const accessToken = crypto.randomUUID();
    await env.MERCARI_REPORTS.put(
      `evidence:${accessToken}`,
      JSON.stringify({ attachment_id: attachment.id, path: attachment.storage_path }),
      { expirationTtl: 600 },
    );
    return {
      ...attachment,
      signed_url: `${origin}/api/ticketing/attachments/${encodeURIComponent(attachment.id)}/content?token=${encodeURIComponent(accessToken)}`,
    };
  }));
  return json({ attachments: enriched });
}

export async function handleUploadAttachment(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  let body: { filename?: string; size_bytes?: number; mime_type?: string };
  try {
    body = await request.json() as { filename?: string; size_bytes?: number; mime_type?: string };
  } catch {
    return error("Invalid upload request", 400);
  }
  const { upload, error: err } = await getService(env).prepareAttachmentUpload(ticketId, {
    name: body.filename ?? "",
    size: Number(body.size_bytes ?? 0),
    type: body.mime_type ?? "",
  });
  if (err) return error(err, err.includes("100 MB") ? 413 : 422);
  const uploadId = crypto.randomUUID();
  await env.MERCARI_REPORTS.put(`attachment-upload:${uploadId}`, JSON.stringify({
    ticket_id: ticketId,
    path: upload!.path,
    name: body.filename,
    size: Number(body.size_bytes),
    type: body.mime_type,
  }), { expirationTtl: 3600 });
  return json({
    upload_id: uploadId,
    signed_upload_url: upload!.signed_url,
    expires_in: 3600,
  }, 201);
}

export async function handleFinalizeAttachmentUpload(
  request: Request,
  env: Env,
  ticketId: string,
  uploadId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const raw = await env.MERCARI_REPORTS.get(`attachment-upload:${uploadId}`);
  if (!raw) return error("Upload authorization expired", 410);
  const grant = JSON.parse(raw) as {
    ticket_id: string; path: string; name: string; size: number; type: string;
  };
  if (grant.ticket_id !== ticketId) return error("Upload authorization does not match ticket", 403);
  const { attachment, error: err } = await getService(env).finalizeAttachmentUpload(ticketId, grant);
  if (err) return error(err, 422);
  await env.MERCARI_REPORTS.delete(`attachment-upload:${uploadId}`);
  return json({ attachment }, 201);
}

export async function handleDeleteAttachment(
  request: Request,
  env: Env,
  ticketId: string,
  attachmentId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getService(env);
  const listed = await service.listAttachments(ticketId);
  if (listed.error) return error(listed.error, 404);
  const target = listed.attachments.find((attachment) => attachment.id === attachmentId);
  if (!target) return error("Attachment not found", 404);
  if (target.storage_bucket.startsWith("r2:")) {
    if (!env.LEGACY_EVIDENCE) return error("Legacy evidence storage is unavailable", 503);
    await env.LEGACY_EVIDENCE.delete(target.storage_path);
  }
  const { error: err } = await service.deleteAttachment(ticketId, attachmentId);
  if (err) return error(err, 404);
  return json({ success: true });
}

export async function handleEvidenceContent(
  request: Request,
  env: Env,
  attachmentId: string,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || !env.LEGACY_EVIDENCE) return error("Not found", 404);
  const raw = await env.MERCARI_REPORTS.get(`evidence:${token}`);
  if (!raw) return error("Evidence link expired", 410);
  let grant: { attachment_id: string; path: string };
  try {
    grant = JSON.parse(raw) as { attachment_id: string; path: string };
  } catch {
    return error("Invalid evidence grant", 403);
  }
  if (grant.attachment_id !== attachmentId) return error("Invalid evidence grant", 403);
  const object = await env.LEGACY_EVIDENCE.get(grant.path);
  if (!object) return error("Evidence not found", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Content-Disposition", "inline");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

export async function handleListResolutions(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getService(env);
  const ticket = await service.getTicket(ticketId);
  if (!ticket.ticket) return error("Ticket not found", 404);
  return json({ resolution_actions: ticket.ticket.resolution_actions });
}

export async function handleRecordResolution(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const operationId = String(body.operation_id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    return error("A valid operation_id is required", 422);
  }
  const { action, error: err } = await getService(env).recordResolution({
    ticket_id: ticketId,
    operation_id: operationId,
    action_type: (body.action_type as string) ?? "",
    amount: body.amount === null || body.amount === undefined ? null : Number(body.amount),
    currency: (body.currency as string) ?? "JPY",
    replacement_sku: (body.replacement_sku as string) || null,
    quantity: body.quantity === null || body.quantity === undefined ? null : Number(body.quantity),
    reason: (body.reason as string) || null,
    external_reference: (body.external_reference as string) || null,
    actor: "portal_operator",
    close_ticket: body.close_ticket !== false,
  });
  if (err) return error(err, 422);
  return json({ action }, 201);
}

export async function handleSearchProducts(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  if (!q) return json({ products: [] });
  const service = getService(env);
  const repo = new SupabaseTicketRepository(getSupabaseClient(env));
  const products = await repo.searchProducts(
    q,
    url.searchParams.get("platform") ?? undefined
  );
  return json({ products });
}

export async function handleListAccounts(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const supabase = getSupabaseClient(env);
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") ?? undefined;

  let query = supabase
    .from("platform_accounts")
    .select("id, display_name, platform, shop_code")
    .eq("status", "active")
    .order("display_name", { ascending: true });

  if (platform) {
    query = query.eq("platform", platform);
  }

  const { data, error: dbErr } = await query;

  if (dbErr) {
    return error(`Failed to list accounts: ${dbErr.message}`, 500);
  }

  return json({ accounts: data ?? [] });
}

export async function handleGetIssueTypes(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const repo = new SupabaseTicketRepository(getSupabaseClient(env));
  const issueTypes = await repo.getIssueTypes();
  return json({ issue_types: issueTypes });
}

export async function handleGetStatuses(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const repo = new SupabaseTicketRepository(getSupabaseClient(env));
  const statuses = await repo.getStatuses();
  return json({ statuses });
}

// ── Queue API Handlers (Issue #109) ──

export async function handleListQueue(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const url = new URL(request.url);
  const service = getUnifiedQueueService(env);

  try {
    const result = await service.list({
      shop_name: url.searchParams.get("shop_name") ?? undefined,
      queue_status: url.searchParams.get("queue_status") ?? undefined,
      review_status: url.searchParams.get("review_status") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      sort: url.searchParams.get("sort") ?? "received_at.desc",
      limit: parseInt(url.searchParams.get("limit") ?? "20", 10),
      offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
    });
    return json(result);
  } catch (e: unknown) {
    return queueError(e);
  }
}

export async function handleGetQueueItem(
  request: Request,
  env: Env,
  queueId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getUnifiedQueueService(env);
  try {
    const item = await service.get(queueId);
    if (!item) return error("Queue item not found", 404);
    return json(item);
  } catch (e: unknown) {
    return queueError(e);
  }
}

export async function handleUpdateQueueItem(
  request: Request,
  env: Env,
  queueId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getUnifiedQueueService(env);
  try {
    const item = await service.update(queueId, {
      queue_status: body.queue_status as string | undefined,
      review_status: body.review_status as string | undefined,
      linked_ticket_id: body.linked_ticket_id as string | undefined | null,
    });
    return json(item);
  } catch (e: unknown) {
    return queueError(e);
  }
}

export async function handleIgnoreQueueItem(
  request: Request,
  env: Env,
  queueId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getUnifiedQueueService(env);
  try {
    return json(await service.ignore(queueId));
  } catch (e: unknown) {
    return queueError(e);
  }
}

export async function handleLinkQueueItem(
  request: Request,
  env: Env,
  queueId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<{ ticket_id: string }>(request);
  if (!body.ticket_id) return error("ticket_id is required", 422);
  if (!isUuid(body.ticket_id)) return error("INVALID_TICKET_ID", 400);
  const service = getUnifiedQueueService(env);
  try {
    const item = await service.link(queueId, body.ticket_id);
    return json(item);
  } catch (e: unknown) {
    return queueError(e);
  }
}

export async function handleConvertQueueItem(
  request: Request,
  env: Env,
  queueId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const body = await parseBody<Record<string, unknown>>(request);
  const service = getUnifiedQueueService(env);
  try {
    const result = await service.convert(queueId, body);
    return json(result, 201);
  } catch (e: unknown) {
    return queueError(e);
  }
}

export async function handleQueueUnreadCount(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const url = new URL(request.url);
  const service = getUnifiedQueueService(env);
  const counts = await service.unreadCount(
    url.searchParams.get("shop_name") ?? undefined
  );
  return json(counts);
}

export async function handleQueueByTicket(
  request: Request,
  env: Env,
  ticketId: string
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return error("Unauthorized", 401);
  }
  const service = getUnifiedQueueService(env);
  return json(await service.byTicket(ticketId));
}

// ── SPA UI ──

export function serveTicketingIndex(): Response {
  return new Response(TICKETING_INDEX_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const TICKETING_INDEX_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ticket Workspace — Homebliss</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f0f2f5;--surface:#fff;--accent:#0f3460;--accent-light:#1a4a8a;--accent-bg:#eef2ff;--danger:#dc2626;--danger-bg:#fef2f2;--success:#16a34a;--success-bg:#f0fdf4;--warning:#d97706;--warning-bg:#fffbeb;--border:#e5e7eb;--text:#1f2937;--text-muted:#6b7280;--text-xs:#9ca3af;--radius:8px;--radius-sm:6px;--shadow-sm:0 1px 2px rgba(0,0,0,.05);--shadow-md:0 4px 12px rgba(0,0,0,.08)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;background:var(--bg);color:var(--text);height:100dvh;overflow:hidden}
.hidden{display:none!important}
#gate{display:flex;align-items:center;justify-content:center;min-height:100dvh;background:linear-gradient(135deg,#1a1a2e,#16213e 60%,#0f3460)}
.gate-box{background:#fff;border-radius:16px;padding:48px 40px;width:360px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.gate-box h1{font-size:1.6rem;margin-bottom:4px}
.gate-subtitle{color:#666;font-size:.85rem;margin-bottom:24px}
.gate-box input[type="password"]{width:100%;padding:12px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:.95rem;margin-bottom:10px;outline:none}
.gate-box input:focus{border-color:var(--accent)}
.gate-box button{width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer}
.gate-box button:hover{background:var(--accent-light)}
.gate-error{color:#e53e3e;font-size:.8rem;margin-top:10px;display:none}
#header{height:52px;background:var(--accent);color:#fff;display:flex;align-items:center;padding:0 20px;gap:16px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:10}
#header .logo{font-weight:700;font-size:13px}
#header .header-right{margin-left:auto;display:flex;align-items:center;gap:12px}
.btn-sm{font-size:11px;padding:5px 14px;border-radius:var(--radius-sm);border:1px solid transparent;cursor:pointer;font-weight:600;font-family:inherit;line-height:1.4;transition:all .15s}
.btn-sm:disabled{opacity:.5;cursor:not-allowed}
.btn-sm.outline{background:transparent;color:#fff;border-color:rgba(255,255,255,.35)}
.btn-sm.outline:hover{background:rgba(255,255,255,.12)}
.btn-sm.primary{background:var(--accent);color:#fff;border:none}
.btn-sm.primary:hover{background:var(--accent-light)}
.btn-sm.danger{background:var(--danger);color:#fff;border:none}
.btn-sm.secondary{background:#fff;border:1px solid var(--border);color:var(--text-muted)}
.btn-sm.secondary:hover{background:#f9fafb}
#app{display:flex;flex-direction:column;height:calc(100dvh - 52px)}
#topbar{padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-shrink:0;flex-wrap:wrap}
#topbar input,#topbar select{padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;outline:none;font-family:inherit}
#topbar input:focus,#topbar select:focus{border-color:var(--accent)}
#topbar input{min-width:160px}
#content{flex:1;overflow-y:auto;padding:16px 20px 32px}
.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.toolbar h2{font-size:15px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)}
th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);background:#f9fafb;position:sticky;top:0;z-index:1}
tr:hover td{background:#f9fafb}
tr{cursor:pointer}
.platform-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.platform-badge.mercari{background:#e0e7ff;color:#3730a3}
.platform-badge.amazon{background:#fef3c7;color:#92400e}
.platform-badge.rakuten{background:#fee2e2;color:#991b1b}
.platform-badge.other{background:#f3f4f6;color:#4b5563}
.status-tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.status-tag.open{background:#dbeafe;color:#1e40af}
.status-tag.in_progress{background:#e0e7ff;color:#3730a3}
.status-tag.pending_customer,.status-tag.pending_third_party{background:#fef3c7;color:#92400e}
.status-tag.resolved{background:#d1fae5;color:#065f46}
.status-tag.closed,.status-tag.canceled{background:#e5e7eb;color:#4b5563}
.priority-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
.priority-dot.urgent{background:var(--danger)}
.priority-dot.high{background:var(--warning)}
.priority-dot.normal{background:var(--text-muted)}
.priority-dot.low{background:var(--text-xs)}
.tt-number{font-family:"SF Mono","Fira Code",monospace;font-size:11px;font-weight:600;color:var(--accent)}
.empty-state{text-align:center;padding:40px;color:var(--text-xs);font-size:13px}

/* Detail */
#detail-bar{padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;flex-wrap:wrap}
#detail-bar .back-btn{background:none;border:none;font-size:18px;cursor:pointer;color:var(--accent);padding:0 4px}
#detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px;padding:16px 20px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
.detail-field label{display:block;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.detail-field select,.detail-field input{width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;font-family:inherit}
.detail-field select:focus,.detail-field input:focus{border-color:var(--accent);outline:none}
.detail-tabs{display:flex;gap:0;border-bottom:2px solid var(--border);padding:0 20px;background:var(--surface);flex-shrink:0}
.tab-btn{padding:8px 16px;border:none;background:none;font-size:11px;font-weight:600;cursor:pointer;color:var(--text-muted);border-bottom:2px solid transparent;margin-bottom:-2px;font-family:inherit}
.tab-btn.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab-btn:hover{color:var(--text)}
#tab-content{flex:1;overflow-y:auto;padding:16px 20px 32px}
.event-item,.note-item,.msg-item{padding:10px 12px;border-radius:var(--radius-sm);margin-bottom:6px;font-size:12px;line-height:1.6}
.event-item{background:#f9fafb;border:1px solid var(--border);display:flex;gap:10px;align-items:flex-start}
.event-type{font-weight:600;color:var(--accent);white-space:nowrap;font-size:10px}
.event-time{font-size:10px;color:var(--text-xs);white-space:nowrap}
.msg-item{background:#f3f4f6;max-width:80%}
.msg-item.operator{background:var(--accent-bg);margin-left:auto}
.note-item{background:var(--warning-bg);border:1px solid #fcd34d}

/* Create form */
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:11px;font-weight:600;margin-bottom:4px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:inherit}
.form-group textarea{min-height:80px;resize:vertical}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--accent);outline:none}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}

/* Product search */
.product-search-result{border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;margin-bottom:6px;cursor:pointer;transition:all .15s;display:flex;justify-content:space-between;align-items:center}
.product-search-result:hover{background:var(--accent-bg);border-color:var(--accent)}
.linked-product{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#f9fafb;border-radius:var(--radius-sm);margin-bottom:4px;font-size:12px}

#toast{position:fixed;bottom:24px;right:24px;z-index:200;padding:8px 18px;border-radius:var(--radius-sm);font-size:11px;font-weight:600;box-shadow:var(--shadow-md);opacity:0;transform:translateY(10px);transition:all .3s;pointer-events:none}
#toast.show{opacity:1;transform:translateY(0)}
#toast.info{background:#dbeafe;color:#1e40af}
#toast.success{background:#d1fae5;color:#065f46}
#toast.error{background:#fee2e2;color:#991b1b}
.issue-type-chips{display:flex;flex-wrap:wrap;gap:4px}
.issue-type-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;background:var(--accent-bg);color:var(--accent)}
.issue-type-chip button{background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;line-height:1;padding:0}
.issue-type-checkboxes{display:flex;flex-wrap:wrap;gap:6px;padding:4px 0}
.issue-type-checkboxes label{display:inline-flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;padding:3px 8px;border:1px solid var(--border);border-radius:12px;transition:all .15s;user-select:none}
.issue-type-checkboxes label.checked{background:var(--accent);color:#fff;border-color:var(--accent)}
.issue-type-checkboxes input[type=checkbox]{display:none}
.editable-desc{cursor:pointer;padding:4px;border-radius:var(--radius-sm);transition:background .15s;min-height:24px}
.editable-desc:hover{background:#f0f2f5}
.editable-desc.editing{padding:0;background:none;cursor:default}
.editable-desc textarea{width:100%;min-height:70px;padding:6px 8px;border:1px solid var(--accent);border-radius:var(--radius-sm);font-size:12px;font-family:inherit;outline:none;resize:vertical;margin-bottom:4px}
.editable-desc .edit-actions{display:flex;gap:4px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:300;display:flex;align-items:center;justify-content:center}
.modal-box{background:#fff;border-radius:12px;padding:20px 24px;width:400px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.2)}
.modal-box h3{margin:0 0 12px;font-size:14px}
.modal-box .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}

/* Phase 1: Response Composer */
#composer{border-top:2px solid var(--accent);padding:12px 20px 16px;background:var(--surface);flex-shrink:0}
.composer-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.composer-header h3{margin:0;font-size:12px;color:var(--text)}
#resolution-guide{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;font-family:inherit;min-height:36px;resize:vertical;box-sizing:border-box}
#resolution-guide:focus{border-color:var(--accent);outline:none}
.btn-ai{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;border:none;border-radius:var(--radius-sm);margin:6px 0}
.btn-ai:hover{background:linear-gradient(135deg,#8b5cf6,#6d28d9)}
.btn-ai:disabled{opacity:.6;cursor:not-allowed}
.btn-ai .spinner{display:none;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
.btn-ai.loading .spinner{display:inline-block}
.btn-ai.loading .btn-label{display:none}
#draft-editor{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:inherit;min-height:100px;resize:vertical;box-sizing:border-box;line-height:1.6}
#draft-editor:focus{border-color:var(--accent);outline:none}
#char-count{font-size:10px;color:var(--text-xs)}
#char-count.warn{color:#d97706;font-weight:600}
#char-count.over{color:var(--danger);font-weight:600}
.composer-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:2px}
.send-status{font-size:10px;color:var(--text-muted);margin-right:8px}
.thread-badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600}
.thread-badge.platform{background:#d1fae5;color:#065f46}
.thread-badge.manual{background:#fef3c7;color:#92400e}
.thread-error{background:#fee2e2;color:#991b1b;padding:6px 10px;border-radius:var(--radius-sm);font-size:10px;margin-bottom:8px}

/* Confirmation modal */
#confirm-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:300;align-items:center;justify-content:center}
#confirm-overlay.show{display:flex}
#confirm-modal{background:var(--surface);border-radius:var(--radius);padding:20px 24px;max-width:480px;width:90%;box-shadow:var(--shadow-lg)}
#confirm-modal h3{margin:0 0 12px;font-size:14px}
#confirm-modal .preview-body{background:#f9fafb;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:13px;line-height:1.6;max-height:200px;overflow-y:auto;white-space:pre-wrap;margin-bottom:12px}
#confirm-modal label{display:block;margin-bottom:8px;font-size:12px;cursor:pointer}
#confirm-modal input[type=radio]{margin-right:6px}
.confirm-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}

@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div id="gate">
  <div class="gate-box">
    <h1>&#x1F3E0; Homebliss</h1>
    <p class="gate-subtitle">Ticket Workspace</p>
    <input id="password-input" type="password" placeholder="Password" autocomplete="new-password" autocapitalize="off" spellcheck="false" autofocus />
    <button id="login-btn">Login</button>
    <p id="gate-error" class="gate-error">Invalid password</p>
  </div>
</div>

<div id="app" class="hidden">
  <div id="header">
    <span class="logo">&#x1F3E0; Homebliss Ticketing</span>
    <div class="header-right">
      <button class="btn-sm outline" onclick="doLogout()">Logout</button>
    </div>
  </div>

  <!-- List view -->
  <div id="view-list">
    <div id="topbar">
      <input type="text" id="filter-q" placeholder="Search tickets..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" oninput="debouncedLoad()" />
      <select id="filter-platform" onchange="loadTickets()"><option value="">All Platforms</option><option value="mercari">Mercari</option><option value="amazon">Amazon</option><option value="rakuten">Rakuten</option><option value="other">Other</option></select>
      <select id="filter-status" onchange="loadTickets()"><option value="">All Statuses</option><option value="open">Open</option><option value="in_progress">In Progress</option><option value="pending_customer">Pending Customer</option><option value="pending_third_party">Pending 3rd Party</option><option value="resolved">Resolved</option><option value="closed">Closed</option><option value="canceled">Canceled</option></select>
      <select id="filter-priority" onchange="loadTickets()"><option value="">All Priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
      <select id="filter-account" onchange="loadTickets()"><option value="">All Accounts</option></select>
      <select id="filter-issue-type" onchange="loadTickets()"><option value="">All Issue Types</option></select>
      <select id="filter-sort" onchange="loadTickets()"><option value="created_at.desc">Newest</option><option value="created_at.asc">Oldest</option><option value="latest_message_at.desc">Last Msg (newest)</option><option value="priority.asc">Priority</option></select>
      <button class="btn-sm primary" onclick="showCreate()">+ New Ticket</button>
    </div>
    <div id="content">
      <div class="toolbar"><h2>Tickets</h2><span id="ticket-count" style="font-size:11px;color:var(--text-muted)"></span></div>
      <table><thead><tr><th>#</th><th>Account</th><th>Platform</th><th>Order</th><th>Product</th><th>Subject</th><th>Customer</th><th>Status</th><th>Priority</th><th>Last Msg</th></tr></thead><tbody id="ticket-tbody"></tbody></table>
      <div id="empty-tickets" class="empty-state hidden">No tickets found. <button class="btn-sm primary" onclick="showCreate()" style="margin-top:8px">Create your first ticket</button></div>
    </div>
  </div>

  <!-- Detail view -->
  <div id="view-detail" class="hidden" style="display:flex;flex-direction:column;height:100%">
    <div id="detail-bar">
      <button class="back-btn" onclick="showList()">&larr;</button>
      <span class="tt-number" id="detail-number"></span>
      <span class="platform-badge mercari" id="detail-platform"></span>
      <span id="detail-order" style="font-size:12px;font-weight:600"></span>
      <span id="detail-subject" style="font-size:12px;color:var(--text-muted);margin-left:auto"></span>
    </div>
    <div id="detail-grid">
      <div class="detail-field"><label>Status</label><select id="detail-status" onchange="updateField('status',this.value)"><option value="open">Open</option><option value="in_progress">In Progress</option><option value="pending_customer">Pending Customer</option><option value="pending_third_party">Pending 3rd Party</option><option value="resolved">Resolved</option><option value="closed">Closed</option><option value="canceled">Canceled</option></select></div>
      <div class="detail-field"><label>Priority</label><select id="detail-priority" onchange="updateField('priority',this.value)"><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></div>
      <div class="detail-field"><label>Subject</label><input id="detail-subject-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" onchange="updateField('subject',this.value)" /></div>
      <div class="detail-field"><label>Issue Types</label><span id="detail-issue-types"></span> <button class="btn btn-sm btn-secondary" onclick="editIssueTypes(state._detailId)" style="font-size:10px;padding:1px 6px">Edit</button></div>
      <div class="detail-field"><label>Started</label><input type="datetime-local" id="detail-started-at" onchange="updateField('started_at',this.value?new Date(this.value).toISOString():null)" style="padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:11px" /></div>
      <div class="detail-field"><label>Customer</label><input id="detail-customer" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" onchange="updateField('customer_display_name',this.value)" /></div>
      <div class="detail-field"><label>Account</label><select id="detail-account" onchange="updateField('account_id',this.value||null)"><option value="">None</option></select></div>
      <div class="detail-field"><label>External URL</label><input id="detail-url" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" onchange="updateField('external_url',this.value)" /></div>
    </div>
    <div class="detail-tabs">
      <button class="tab-btn active" onclick="switchDetailTab('events')">Events</button>
      <button class="tab-btn" onclick="switchDetailTab('messages')">Messages</button>
      <button class="tab-btn" onclick="switchDetailTab('notes')">Notes</button>
      <button class="tab-btn" onclick="switchDetailTab('products')">Products</button>
      <button class="tab-btn" onclick="switchDetailTab('description')">Description</button>
    </div>
    <div id="tab-content"></div>

    <!-- Phase 1: Response Composer -->
    <div id="composer" style="display:none">
      <div class="composer-header"><h3>&#x270F; Response Composer</h3><span id="thread-status" style="font-size:10px;color:var(--text-muted)"></span></div>
      <div id="thread-error" class="thread-error" style="display:none"></div>
      <textarea id="resolution-guide" placeholder="Resolution guide (e.g. refund 300 yen, send replacement) — used as AI copywriting context"></textarea>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn-ai" id="btn-copywrite" onclick="generateAIReply()">
          <span class="spinner"></span>
          <span class="btn-label">&#x2728; Copywrite (OpenAI)</span>
        </button>
      </div>
      <textarea id="draft-editor" placeholder="Draft reply message — edit before sending..." oninput="updateCharCount()"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
        <span id="char-count">0 / 500</span>
      </div>
      <div class="composer-actions">
        <label style="font-size:10px;display:flex;align-items:center;gap:4px;margin-right:auto;cursor:pointer;user-select:none">
          <input type="checkbox" id="terminal-reply" />
          Final reply (clear Needs Reply)
        </label>
        <span id="send-status" class="send-status"></span>
        <button class="btn-sm secondary" id="btn-save-draft" onclick="saveDraft()">&#x1F4BE; Save Draft</button>
        <button class="btn-send" id="btn-send" onclick="openSendModal()">&#x27A4; Send to Mercari</button>
      </div>
    </div>
  </div>

  <!-- Confirmation modal -->
  <div id="confirm-overlay">
    <div id="confirm-modal">
      <h3>Confirm Send to Mercari</h3>
      <div>Message preview:</div>
      <div class="preview-body" id="confirm-preview"></div>
      <div>Reply intent:</div>
      <label><input type="radio" name="confirm-intent" value="terminal" /> Final reply (clear Needs Reply)</label>
      <label><input type="radio" name="confirm-intent" value="holding" checked /> Holding reply (keep Needs Reply active)</label>
      <div class="confirm-actions">
        <button class="btn-sm secondary" onclick="closeSendModal()">Cancel</button>
        <button class="btn-sm primary" id="btn-confirm-send" onclick="executeSend()">Confirm Send</button>
      </div>
    </div>
  </div>

  <!-- Create view -->
  <div id="view-create" class="hidden">
    <div id="content">
      <div class="toolbar"><h2>New Ticket</h2><button class="btn-sm secondary" onclick="showList()">Cancel</button></div>
      <div style="max-width:640px" autocomplete="off">
        <div class="form-row">
          <div class="form-group"><label>Platform *</label><select id="create-platform" onchange="onCreatePlatformChange()"><option value="mercari" selected>Mercari</option><option value="amazon">Amazon</option><option value="rakuten">Rakuten</option><option value="other">Other</option></select></div>
          <div class="form-group"><label>Priority</label><select id="create-priority"><option value="normal" selected>Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
        </div>
        <div class="form-group"><label>Account (Shop)</label><select id="create-account"><option value="">Select account...</option></select></div>
        <div class="form-group"><label>External Order ID</label><input id="create-order-id" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Platform order/transaction ID" /></div>
        <div class="form-group"><label>External URL</label><input id="create-url" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Link to platform order page" /></div>
        <div class="form-row">
          <div class="form-group"><label>Customer Name</label><input id="create-customer" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Customer display name" /></div>
          <div class="form-group"><label>Customer Contact</label><input id="create-contact" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Email or phone" /></div>
        </div>
        <div class="form-group"><label>Subject</label><input id="create-subject" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Brief summary" /></div>
        <div class="form-group"><label>Issue Types</label><div class="issue-type-checkboxes" id="cf-issue-types">Loading issue types...</div></div>
        <div class="form-group"><label>Description</label><textarea id="create-description" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Issue details..."></textarea></div>
        <div id="create-errors" style="color:var(--danger);font-size:12px;margin-bottom:12px"></div>
        <div class="form-actions">
          <button class="btn-sm secondary" onclick="showList()">Cancel</button>
          <button class="btn-sm primary" onclick="doCreate()">Create Ticket</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const SESSION_KEY = "hb_ticketing_token";
var _accountsCache = [];
var state = { tickets: [], ticket: null, events: [], products: [], tab: "events", threadMessages: [], threadLastSeenAt: null, latestBuyerMessageAt: null, _createIssueTypes: [], _detailId: null };

// Account helpers
async function fetchAccounts(platform){
  try{
    var url="/api/ticketing/accounts";
    if(platform)url+="?platform="+encodeURIComponent(platform);
    var r=await api(url);
    var d=await json(r);
    _accountsCache=d.accounts||[];
  }catch(e){ _accountsCache=[] }
}

function populateAccountSelect(selectId, selectedId, includeEmpty){
  var sel=document.getElementById(selectId);
  if(!sel)return;
  var h=includeEmpty?'<option value="">'+(includeEmpty===true?"Select account...":includeEmpty)+'</option>':'';
  for(var i=0;i<_accountsCache.length;i++){
    var a=_accountsCache[i];
    h+='<option value="'+eAttr(a.id)+'"'+(a.id===selectedId?" selected":"")+'>'+e(a.display_name)+' ('+e(a.platform)+')</option>';
  }
  sel.innerHTML=h;
}

function onCreatePlatformChange(){
  var pf=document.getElementById("create-platform").value;
  fetchAccounts(pf).then(function(){ populateAccountSelect("create-account",null,true) });
}

// Auth
function getToken(){ return sessionStorage.getItem(SESSION_KEY) }
function setToken(t){ sessionStorage.setItem(SESSION_KEY,t) }
function clearToken(){ sessionStorage.removeItem(SESSION_KEY) }

async function api(path, opts){
  opts=opts||{};
  var h=opts.headers||{};
  var t=getToken();
  if(t)h["Authorization"]="Bearer "+t;
  if(!opts.skipCT)h["Content-Type"]="application/json";
  var r=await fetch(path,{method:opts.method||"GET",headers:h,body:opts.body||undefined});
  if(r.status===401){clearToken();showGate();throw new Error("Unauthorized")}
  return r;
}

function json(r){ return r.json() }

async function login(pw){
  if(!pw)return false;
  var r=await fetch("/api/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});
  if(!r.ok)return false;
  var d=await r.json();
  if(!d.token)return false;
  setToken(d.token);
  return true;
}

function showGate(){
  document.getElementById("gate").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("gate-error").style.display="none";
}

function showApp(){
  document.getElementById("gate").classList.remove("hidden"); // gate hidden separately
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  fetchIssueTypes(); // preload for badge display names everywhere
  fetchStatuses(); // load status options into dropdowns
}

function initializeListFiltersFromQuery(){
  var params=new URLSearchParams(window.location.search);
  var status=params.get("status");
  var priority=params.get("priority");
  var allowedStatuses=["open","in_progress","pending_customer","pending_third_party","resolved","closed","canceled"];
  var allowedPriorities=["urgent","high","normal","low"];
  if(allowedStatuses.indexOf(status)>=0)document.getElementById("filter-status").value=status;
  if(allowedPriorities.indexOf(priority)>=0)document.getElementById("filter-priority").value=priority;
}

async function boot(){
  initializeListFiltersFromQuery();
  if(getToken()){
    try{ var r=await fetch("/api/health"); if(r.ok){ showApp(); fetchAccounts().then(function(){ populateAccountSelect("filter-account",null,"All Accounts"); populateAccountSelect("detail-account",null,"None") }); loadTickets(); return } }catch(e){}
    clearToken();
  }
  showGate();
}

document.getElementById("login-btn").addEventListener("click",async function(){
  var pw=document.getElementById("password-input").value;
  var err=document.getElementById("gate-error");
  err.style.display="none";
  if(!pw)return;
  var ok=await login(pw);
  if(ok){ showApp(); loadTickets() }else{ err.style.display="block" }
});
document.getElementById("password-input").addEventListener("keydown",function(e){ if(e.key==="Enter")document.getElementById("login-btn").click() });

function doLogout(){ clearToken(); showGate(); state.tickets=[]; state.ticket=null; state._detailId=null }

// Navigation
function showView(name){
  ["view-list","view-detail","view-create"].forEach(function(v){
    document.getElementById(v).classList.toggle("hidden",v!==name);
  });
}

function showList(){ showView("view-list"); state.ticket=null; state._detailId=null; var c=document.getElementById("composer"); if(c)c.style.display="none" }
function showCreate(){ showView("view-create"); state._createIssueTypes=[]; fetchIssueTypes(); fetchAccounts().then(function(){ populateAccountSelect("create-account",null,true) }) }

// List
var _debounceTimer=null;
function debouncedLoad(){ clearTimeout(_debounceTimer); _debounceTimer=setTimeout(loadTickets,250) }

async function loadTickets(){
  var p=new URLSearchParams();
  var q=document.getElementById("filter-q").value.trim();
  if(q)p.set("q",q);
  var pf=document.getElementById("filter-platform").value;
  if(pf)p.set("platform",pf);
  var st=document.getElementById("filter-status").value;
  if(st)p.set("status",st);
  var pr=document.getElementById("filter-priority").value;
  if(pr)p.set("priority",pr);
  var ac=document.getElementById("filter-account").value;
  if(ac)p.set("account_id",ac);
  var it=document.getElementById("filter-issue-type").value;
  if(it)p.set("issue_type",it);
  p.set("sort",document.getElementById("filter-sort").value);
  p.set("limit","50");
  try{
    var r=await api("/api/ticketing/tickets?"+p.toString());
    var d=await json(r);
    state.tickets=d.tickets||[];
    renderList();
  }catch(e){ toast("Failed to load tickets","error") }
}

function renderList(){
  var tbody=document.getElementById("ticket-tbody");
  var empty=document.getElementById("empty-tickets");
  var count=document.getElementById("ticket-count");
  count.textContent=(state.tickets.length)+" tickets";
  if(!state.tickets.length){
    tbody.innerHTML="";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML=state.tickets.map(function(t){
    var pc=t.platform||"other";
    var prodCell=t.product_name?e(t.product_name):"-";
    if(t.primary_sku)prodCell+=' <span style="font-size:10px;color:var(--text-xs)">('+e(t.primary_sku)+')</span>';
    return '<tr onclick="openDetail(\\''+eAttr(t.id)+'\\')">'+
      '<td><span class="tt-number">'+e(t.ticket_number)+'</span></td>'+
      '<td style="font-size:11px">'+e(t.account_display_name||"-")+'</td>'+
      '<td><span class="platform-badge '+pc+'">'+e(t.platform)+'</span></td>'+
      '<td>'+e(t.external_order_id||"-")+'</td>'+
      '<td style="font-size:11px">'+prodCell+'</td>'+
      '<td>'+e(t.subject||"-")+'</td>'+
      '<td>'+e(t.customer_display_name||"-")+'</td>'+
      '<td><span class="status-tag '+e(t.status)+'">'+e(t.status)+'</span></td>'+
      '<td><span class="priority-dot '+e(t.priority)+'"></span>'+e(t.priority)+'</td>'+
      '<td style="font-size:10px">'+fmtDate(t.latest_message_at)+'</td>'+
      '</tr>';
  }).join("");
}

// Detail
async function openDetail(id){
  state._detailId=id; // set immediately so Edit button works before API responds
  showView("view-detail");
  try{
    var r=await api("/api/ticketing/tickets/"+id);
    var d=await json(r);
    state.ticket=d.ticket;
    state.events=d.events||[];
    state.products=(d.ticket&&d.ticket.products)?d.ticket.products:[];
    renderDetail();
    // Show composer for tickets with platform order
    var composer=document.getElementById("composer");
    if(composer&&state.ticket){
      composer.style.display=state.ticket.platform==="mercari"?"block":"none";
    }
    // Load draft and thread (async, non-blocking)
    loadDraft();
    loadThread();
  }catch(e){ toast("Failed to load ticket","error"); showList() }
}

function renderDetail(){
  var t=state.ticket;
  if(!t)return;
  document.getElementById("detail-number").textContent=t.ticket_number;
  var plat=document.getElementById("detail-platform");
  plat.textContent=t.platform; plat.className="platform-badge "+(t.platform||"other");
  document.getElementById("detail-order").textContent=t.external_order_id||"No order ID";
  document.getElementById("detail-subject").textContent=t.subject||"";
  document.getElementById("detail-status").value=t.status;
  document.getElementById("detail-priority").value=t.priority;
  document.getElementById("detail-subject-input").value=t.subject||"";
  document.getElementById("detail-issue-types").innerHTML=renderIssueBadges(t.issue_types||[]);
  document.getElementById("detail-started-at").value=t.started_at?t.started_at.slice(0,16):"";
  document.getElementById("detail-customer").value=t.customer_display_name||"";
  document.getElementById("detail-url").value=t.external_url||"";
  populateAccountSelect("detail-account",t.account_id,"None");
  renderDetailTab();
}

function renderDetailTab(){
  var el=document.getElementById("tab-content");
  if(state.tab==="events")el.innerHTML=renderEvents();
  else if(state.tab==="messages")el.innerHTML=renderMessages();
  else if(state.tab==="notes")el.innerHTML=renderNotes();
  else if(state.tab==="products")el.innerHTML=renderProducts();
  else if(state.tab==="description")el.innerHTML=renderDescription();
}

function switchDetailTab(tab){
  state.tab=tab;
  document.querySelectorAll(".tab-btn").forEach(function(b){b.classList.remove("active")});
  document.querySelector('.tab-btn[onclick*="'+tab+'"]').classList.add("active");
  renderDetailTab();
}

function renderEvents(){
  if(!state.events.length)return '<p class="empty-state">No events yet</p>';
  return state.events.slice().reverse().map(function(ev){
    return '<div class="event-item"><span class="event-type">'+e(ev.event_type)+'</span><span class="event-time">'+fmtDate(ev.created_at)+'</span><span style="font-size:10px;color:var(--text-muted)">'+e(ev.actor_type)+'</span></div>';
  }).join("");
}

function renderMessages(){
  // Use thread messages if available, otherwise fall back to ticket messages
  var threadMsgs=state.threadMessages||[];
  var ticketMsgs=state.ticket&&state.ticket.messages?state.ticket.messages:[];

  var isMercari=state.ticket&&state.ticket.platform==="mercari";
  if(!threadMsgs.length&&!ticketMsgs.length)return '<p class="empty-state">No messages yet.'+(isMercari?' Use the composer below to send a reply.':'')+'</p>';

  // Build from thread messages
  var seenIds={};
  var h="";
  for(var i=0;i<threadMsgs.length;i++){
    var m=threadMsgs[i];
    seenIds[m.id]=true;
    var role=m.role==="BUYER"?"buyer":(m.role==="SELLER"?"seller":m.role);
    var cls=role==="seller"||role==="operator"?"operator":"";
    var label=m.source==="platform"?(m.role==="BUYER"?"Customer":"Us"):(m.displayName||m.role);
    var badge=m.source==="platform"?'<span class="thread-badge platform" style="margin-left:4px">mercari</span>':'';
    h+='<div class="msg-item '+cls+'"><div style="font-size:10px;color:var(--text-muted);margin-bottom:2px">'+e(label)+badge+' &middot; '+fmtDate(m.sentAt)+'</div><div>'+e(m.body)+'</div></div>';
  }
  // Add any Supabase messages not in thread
  for(var j=0;j<ticketMsgs.length;j++){
    var sm=ticketMsgs[j];
    if(sm.external_message_id&&seenIds[sm.external_message_id])continue;
    if(seenIds[sm.id])continue;
    seenIds[sm.id]=true;
    var scls=sm.sender_type==="operator"?"operator":"";
    h+='<div class="msg-item '+scls+'"><div style="font-size:10px;color:var(--text-muted);margin-bottom:2px">'+e(sm.sender_type)+(sm.sender_display_name?' ('+e(sm.sender_display_name)+')':'')+' &middot; '+fmtDate(sm.sent_at)+'</div><div>'+e(sm.body)+'</div></div>';
  }
  return h;
}

function renderNotes(){
  var notes=state.ticket&&state.ticket.notes?state.ticket.notes:[];
  if(!notes.length)return '<p class="empty-state">No notes yet. <button class="btn-sm secondary" onclick="showAddNote()" style="margin-top:8px">Add Note</button></p>';
  var h=notes.map(function(n){
    return '<div class="note-item"><div style="font-size:10px;color:var(--text-muted);margin-bottom:2px">'+fmtDate(n.created_at)+(n.created_by?' by '+e(n.created_by):'')+'</div><div>'+e(n.body)+'</div></div>';
  }).join("");
  h+='<div style="margin-top:12px"><button class="btn-sm secondary" onclick="showAddNote()">+ Add Note</button></div>';
  return h;
}

function renderProducts(){
  if(!state.products.length)return '<p class="empty-state">No products linked. <button class="btn-sm primary" onclick="showProductSearch()" style="margin-top:8px">Link Product</button></p>';
  var h=state.products.map(function(p){
    var name=p.product_name||p.variant_name||"Missing product detail";
    var platformSku=p.platform_sku||p.sku||"-";
    var seller=p.seller_name?e(p.seller_name):'<span style="color:var(--danger)">Missing seller</span>';
    var unitPrice=p.unit_price?("¥"+e(p.unit_price)):'<span style="color:var(--danger)">Missing unit price</span>';
    var fulfillment=p.unit_fulfillment_price?("¥"+e(p.unit_fulfillment_price)):'<span style="color:var(--danger)">Missing fulfillment</span>';
    return '<div class="linked-product" style="display:block">'+
      '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">'+
        '<div><strong>'+e(p.item_code||p.sku)+'</strong> - '+e(name)+' <span style="font-size:10px;color:var(--text-muted)">('+e(p.role)+')</span></div>'+
        '<button class="btn-sm danger" onclick="unlinkProduct(\\''+eAttr(p.id||"")+'\\')">Remove</button>'+
      '</div>'+
      '<div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:8px;font-size:11px;color:var(--text-muted)">'+
        '<div><strong>Seller</strong><br>'+seller+'</div>'+
        '<div><strong>Unit Price</strong><br>'+unitPrice+'</div>'+
        '<div><strong>Fulfillment</strong><br>'+fulfillment+'</div>'+
        '<div><strong>Platform SKU</strong><br>'+e(platformSku)+'</div>'+
        '<div><strong>Platform</strong><br>'+e(p.platform||state.ticket.platform||"-")+'</div>'+
      '</div>'+
    '</div>';
  }).join("");
  h+='<div style="margin-top:12px"><button class="btn-sm primary" onclick="showProductSearch()">+ Link Product</button></div>';
  return h;
}

function renderDescription(){
  var t=state.ticket;
  if(!t)return"";
  return '<div class="form-group"><label>Description</label><div class="editable-desc" onclick="editDescription(\\''+t.id+'\\',this)"><span>'+e(t.description||"—")+'</span></div></div>'+
    '<div class="form-group"><label>Issue Types</label><div>'+renderIssueBadges(t.issue_types||[])+' <button class="btn btn-sm btn-secondary" onclick="editIssueTypes(state._detailId)" style="font-size:10px;padding:1px 6px">Edit</button></div></div>';
}

// Actions
async function updateField(field,value){
  if(!state.ticket)return;
  try{
    var body={};body[field]=value;
    var r=await api("/api/ticketing/tickets/"+state.ticket.id,{method:"PATCH",body:JSON.stringify(body)});
    var d=await json(r);
    if(!r.ok){throw new Error(d.error||"Update failed")}
    state.ticket=d.ticket;
    toast("Updated","success");
  }catch(e){ toast("Update failed","error") }
}

function renderIssueBadges(types){
  if(!types||!types.length)return '<span style="color:var(--text-xs)">None set</span>';
  return '<span class="issue-type-chips">'+types.map(function(it){
    var label=it;
    for(var i=0;i<_allIssueTypes.length;i++){
      if(_allIssueTypes[i].key===it){label=_allIssueTypes[i].display_name||it;break}
    }
    return '<span class="issue-type-chip">'+e(label)+'</span>';
  }).join("")+'</span>';
}

var _allIssueTypes=[];

async function fetchIssueTypes(){
  try{
    var r=await api("/api/ticketing/issue-types");
    var d=await json(r);
    _allIssueTypes=d.issue_types||[];
    renderIssueTypeCheckboxes();
    populateIssueTypeFilter();
  }catch(e){}
}

function populateIssueTypeFilter(){
  var sel=document.getElementById("filter-issue-type");
  if(!sel)return;
  var saved=sel.value;
  var h='<option value="">All Issue Types</option>';
  for(var i=0;i<_allIssueTypes.length;i++){
    var it=_allIssueTypes[i];
    h+='<option value="'+eAttr(it.key)+'"'+(saved===it.key?" selected":"")+'>'+e(it.display_name)+'</option>';
  }
  sel.innerHTML=h;
  if(saved)sel.value=saved;
}

var _allStatuses=[];

async function fetchStatuses(){
  try{
    var r=await api("/api/ticketing/statuses");
    var d=await json(r);
    _allStatuses=d.statuses||[];
    populateStatusDropdowns();
  }catch(e){}
}

function populateStatusDropdowns(){
  // Filter dropdown
  var filterSel=document.getElementById("filter-status");
  if(filterSel&&_allStatuses.length){
    var fv=filterSel.value;
    var fh='<option value="">All Statuses</option>';
    for(var i=0;i<_allStatuses.length;i++){
      var st=_allStatuses[i];
      fh+='<option value="'+eAttr(st.key)+'"'+(fv===st.key?" selected":"")+'>'+e(st.display_name)+'</option>';
    }
    filterSel.innerHTML=fh;
  }
  // Detail dropdown
  var detailSel=document.getElementById("detail-status");
  if(detailSel&&_allStatuses.length){
    var dv=detailSel.value;
    var dh='';
    for(var j=0;j<_allStatuses.length;j++){
      var dt=_allStatuses[j];
      dh+='<option value="'+eAttr(dt.key)+'"'+(dv===dt.key?" selected":"")+'>'+e(dt.display_name)+'</option>';
    }
    detailSel.innerHTML=dh;
  }
}

function renderIssueTypeCheckboxes(){
  var el=document.getElementById("cf-issue-types");
  if(!el||!_allIssueTypes.length){if(el)el.textContent="No issue types configured";return}
  el.innerHTML=_allIssueTypes.map(function(it){
    var checked=state._createIssueTypes&&state._createIssueTypes.indexOf(it.key)>=0;
    return '<label class="'+(checked?"checked":"")+'" onclick="toggleCreateIssueType(this,\\''+it.key+'\\')"><input type="checkbox" '+(checked?"checked":"")+' />'+e(it.display_name||it.key)+'</label>';
  }).join("");
}

function toggleCreateIssueType(label, key){
  state._createIssueTypes=state._createIssueTypes||[];
  var idx=state._createIssueTypes.indexOf(key);
  if(idx>=0){state._createIssueTypes.splice(idx,1);label.classList.remove("checked");label.querySelector("input").checked=false}
  else{state._createIssueTypes.push(key);label.classList.add("checked");label.querySelector("input").checked=true}
}

async function editIssueTypes(ticketId){
  if(!ticketId)return;
  if(!_allIssueTypes.length){
    try{await fetchIssueTypes()}catch(e){}
  }
  var html='<div class="modal-overlay" onclick="if(event.target===this)this.remove()"><div class="modal-box"><h3>Edit Issue Types</h3>';
  html+='<div class="issue-type-checkboxes">';
  var current=state.ticket?state.ticket.issue_types||[]:[];
  _allIssueTypes.forEach(function(it){
    var checked=current.indexOf(it.key)>=0;
    html+='<label class="'+(checked?"checked":"")+'" onclick="this.classList.toggle(\\'checked\\');var cb=this.querySelector(\\'input\\');cb.checked=!cb.checked"><input type="checkbox" '+(checked?"checked":"")+' value="'+e(it.key)+'" />'+e(it.display_name||it.key)+'</label>';
  });
  html+='</div>';
  html+='<div class="modal-actions"><button class="btn-sm secondary" onclick="this.closest(\\'.modal-overlay\\').remove()">Cancel</button> ';
  html+='<button class="btn-sm btn-primary" onclick="saveIssueTypes(\\''+ticketId+'\\')">Save</button></div>';
  html+='</div></div>';
  var modal=document.createElement("div");
  modal.innerHTML=html;
  document.body.appendChild(modal.firstElementChild);
}

async function saveIssueTypes(ticketId){
  var modal=document.querySelector(".modal-overlay");
  var cbs=modal.querySelectorAll("input[type=checkbox]:checked");
  var types=Array.from(cbs).map(function(cb){return cb.value});
  try{
    var r=await api("/api/ticketing/tickets/"+ticketId,{method:"PATCH",body:JSON.stringify({issue_types:types})});
    var d=await json(r);
    state.ticket=d.ticket;
    renderDetail();
    modal.remove();
    toast("Issue types updated","success");
  }catch(e){ toast("Failed to update issue types","error") }
}

function editDescription(id, el){
  if(el.classList.contains("editing"))return;
  var span=el.querySelector("span");
  var currentText=span?span.textContent:"";
  if(currentText==="—")currentText="";
  el.classList.add("editing");
  el.innerHTML='<textarea>'+e(currentText)+'</textarea><div class="edit-actions"><button class="btn-sm btn-primary" onclick="saveDescription(\\''+id+'\\',this)">Save</button><button class="btn-sm secondary" onclick="cancelEditDescription(\\''+id+'\\',this,\\''+e(currentText)+'\\')">Cancel</button></div>';
  el.querySelector("textarea").focus();
}

async function saveDescription(id, btn){
  var el=btn.closest(".editable-desc");
  var ta=el.querySelector("textarea");
  var text=ta.value;
  try{
    var r=await api("/api/ticketing/tickets/"+id,{method:"PATCH",body:JSON.stringify({description:text})});
    var d=await json(r);
    state.ticket=d.ticket;
    el.classList.remove("editing");
    el.innerHTML='<span>'+e(text||"—")+'</span>';
    toast("Description updated","success");
  }catch(e){ toast("Failed to update description","error") }
}

function cancelEditDescription(id, btn, original){
  var el=btn.closest(".editable-desc");
  el.classList.remove("editing");
  el.innerHTML='<span>'+e(original||"—")+'</span>';
}

function updateIssueTypes(value){
  var types=value.split(",").map(function(v){return v.trim()}).filter(Boolean);
  updateField("issue_types",types);
}

function showAddMessage(){
  // Show the composer inline instead of using prompt()
  var composer=document.getElementById("composer");
  if(composer)composer.style.display="block";
  document.getElementById("draft-editor").focus();
}

async function addMessage(body){
  if(!state.ticket)return;
  try{
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/messages",{method:"POST",body:JSON.stringify({body:body,platform:state.ticket.platform,sender_type:"operator"})});
    var d=await json(r);
    if(!r.ok){throw new Error(d.error||"Add message failed")}
    if(!state.ticket.messages)state.ticket.messages=[];
    state.ticket.messages.push(d.message);
    state.tab="messages";
    renderDetail();
    toast("Message added","success");
  }catch(e){ toast("Failed to add message","error") }
}

// ── Phase 1: Composer Functions ──

async function generateAIReply(){
  var btn=document.getElementById("btn-copywrite");
  var ticket=state.ticket;
  if(!ticket)return toast("Select a ticket","error");
  btn.classList.add("loading");btn.disabled=true;
  try{
    var guide=document.getElementById("resolution-guide").value.trim();
    var r=await api("/api/ticketing/tickets/"+ticket.id+"/copywrite",{method:"POST",body:JSON.stringify({resolution_guide:guide||undefined})});
    var d=await json(r);
    if(!r.ok||!d.reply){toast(d.error?d.error.message:"Copywrite failed","error");btn.classList.remove("loading");btn.disabled=false;return}
    document.getElementById("draft-editor").value=d.reply;
    updateCharCount();
    toast("AI reply generated via "+d.model,"success");
  }catch(e){toast("Copywrite failed","error")}
  btn.classList.remove("loading");btn.disabled=false;
}

function updateCharCount(){
  var text=document.getElementById("draft-editor").value;
  var len=text.length;
  var el=document.getElementById("char-count");
  el.textContent=len+" / 500";
  el.className=len>500?"over":(len>400?"warn":"");
  el.style.cssText="font-size:10px;color:"+(len>500?"var(--danger)":(len>400?"#d97706":"var(--text-xs)"));
}

async function saveDraft(){
  if(!state.ticket)return;
  try{
    var body=document.getElementById("draft-editor").value;
    var guide=document.getElementById("resolution-guide").value;
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/draft",{method:"POST",body:JSON.stringify({body:body,resolution_guide:guide})});
    var d=await json(r);
    if(!r.ok){throw new Error(d.error||"Save draft failed")}
    toast("Draft saved","success");
  }catch(e){ toast("Failed to save draft","error") }
}

async function loadDraft(){
  if(!state.ticket)return;
  try{
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/draft");
    var d=await json(r);
    if(d.draft){
      document.getElementById("draft-editor").value=d.draft.body||"";
      document.getElementById("resolution-guide").value=d.draft.resolution_guide||"";
      updateCharCount();
    }
  }catch(e){ /* draft load is best-effort */ }
}

async function loadThread(){
  if(!state.ticket)return;
  var statusEl=document.getElementById("thread-status");
  statusEl.textContent="Loading thread...";
  try{
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/thread");
    var d=await json(r);
    if(d.fetch_error){
      var errEl=document.getElementById("thread-error");
      errEl.textContent=d.fetch_error;errEl.style.display="block";
      statusEl.innerHTML='<span class="thread-badge manual">manual only</span>';
    }else{
      document.getElementById("thread-error").style.display="none";
      statusEl.innerHTML='<span class="thread-badge platform">'+d.messages.length+' msgs</span>';
    }
    // Store thread messages on state for rendering
    state.threadMessages=d.messages||[];
    state.latestBuyerMessageAt=d.latest_buyer_message_at||null;
    // Re-render messages tab if showing
    if(state.tab==="messages") renderDetailTab();
    // Reset freshness timestamp
    state.threadLastSeenAt=new Date().toISOString();
  }catch(e){
    statusEl.innerHTML='<span class="thread-badge manual">offline</span>';
  }
}

function openSendModal(){
  if(!state.ticket)return;
  var msg=document.getElementById("draft-editor").value.trim();
  if(!msg)return toast("Draft is empty","error");
  document.getElementById("confirm-preview").textContent=msg;
  document.getElementById("confirm-overlay").classList.add("show");
}

function closeSendModal(){
  document.getElementById("confirm-overlay").classList.remove("show");
}

async function executeSend(){
  if(!state.ticket)return;
  var btn=document.getElementById("btn-confirm-send");
  var status=document.getElementById("send-status");
  btn.disabled=true;btn.textContent="Sending...";
  var msg=document.getElementById("draft-editor").value.trim();
  var intentEl=document.querySelector('input[name="confirm-intent"]:checked');
  var intent=intentEl?intentEl.value:"holding";
  var operationStorageKey="ticket-send-operation:"+state.ticket.id;
  var operationSignature=JSON.stringify([state.ticket.id,msg,intent]);
  var operationRecord=null;
  try{operationRecord=JSON.parse(sessionStorage.getItem(operationStorageKey)||"null")}catch(e){}
  if(!operationRecord||operationRecord.signature!==operationSignature||!operationRecord.id){
    operationRecord={signature:operationSignature,id:crypto.randomUUID()};
    try{sessionStorage.setItem(operationStorageKey,JSON.stringify(operationRecord))}catch(e){}
  }
  try{
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/send",{method:"POST",body:JSON.stringify({
      message:msg,
      reply_intent:intent,
      client_operation_id:operationRecord.id,
      last_seen_message_at:state.threadLastSeenAt||undefined
    })});
    var d=await json(r);
    if(!r.ok){throw new Error(d.error?d.error.message:"Send failed")}
    // Double-write: the handler already added to ticket_messages, so reload thread
    if(d.ticket_message){
      if(!state.ticket.messages)state.ticket.messages=[];
      state.ticket.messages.push(d.ticket_message);
    }
    if(intent==="terminal"){state.ticket.needs_reply=false}
    document.getElementById("draft-editor").value="";
    try{sessionStorage.removeItem(operationStorageKey)}catch(e){}
    updateCharCount();
    closeSendModal();
    state.tab="messages";
    renderDetail();
    if(d.warning)toast("Sent, but: "+d.warning,"info");
    else toast("Reply sent to Mercari!","success");
  }catch(e){
    toast("Send failed: "+(e.message||"Unknown error"),"error");
  }
  btn.disabled=false;btn.textContent="Confirm Send";
  status.textContent="";
}

// Keyboard shortcut: Ctrl+Enter in draft editor → open send modal
document.addEventListener("keydown",function(ev){
  if((ev.ctrlKey||ev.metaKey)&&ev.key==="Enter"&&document.activeElement===document.getElementById("draft-editor")){
    ev.preventDefault();
    openSendModal();
  }
});

// Close modal on overlay click
document.getElementById("confirm-overlay").addEventListener("click",function(ev){
  if(ev.target===this)closeSendModal();
});

function showAddNote(){
  var body=prompt("Enter note:");
  if(!body||!body.trim())return;
  addNote(body.trim());
}

async function addNote(body){
  if(!state.ticket)return;
  try{
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/notes",{method:"POST",body:JSON.stringify({body:body})});
    var d=await json(r);
    if(!state.ticket.notes)state.ticket.notes=[];
    state.ticket.notes.push(d.note);
    state.tab="notes";
    renderDetail();
    toast("Note added","success");
  }catch(e){ toast("Failed to add note","error") }
}

function showProductSearch(){
  var sku=prompt("Enter SKU or product name to search:");
  if(!sku||!sku.trim())return;
  searchAndLink(sku.trim());
}

async function searchAndLink(q){
  try{
    var url="/api/ticketing/products/search?q="+encodeURIComponent(q);
    if(state.ticket&&state.ticket.platform)url+="&platform="+encodeURIComponent(state.ticket.platform);
    var r=await api(url);
    var d=await json(r);
    var prods=d.products||[];
    if(!prods.length){toast("No products found","info");return}
    if(prods.length===1){
      linkProduct(prods[0]);
      return;
    }
    // Show a simple picker
    var msg=prods.map(function(p,i){return (i+1)+": "+p.sku+" - "+p.product_name+(p.variant_name?" ("+p.variant_name+")":"")}).join("\\n");
    var idx=prompt("Multiple results found:\\n"+msg+"\\n\\nEnter number to link:");
    if(!idx)return;
    var n=parseInt(idx,10)-1;
    if(n>=0&&n<prods.length)linkProduct(prods[n]);
  }catch(e){ toast("Search failed","error") }
}

async function linkProduct(p){
  if(!state.ticket)return;
  try{
    var r=await api("/api/ticketing/tickets/"+state.ticket.id+"/products",{method:"POST",body:JSON.stringify({product_id:p.product_id||null,variant_id:p.variant_id||null,listing_id:p.listing_id||null,listing_sku_id:p.listing_sku_id||null,sku:p.sku,role:"related"})});
    var d=await json(r);
    if(!r.ok){throw new Error(d.error||"Link failed")}
    state.products.push(d.product);
    state.tab="products";
    renderDetail();
    toast("Product linked","success");
  }catch(e){ toast("Link failed","error") }
}

async function unlinkProduct(productId){
  if(!state.ticket||!confirm("Remove this product?"))return;
  try{
    await api("/api/ticketing/tickets/"+state.ticket.id+"/products/"+productId,{method:"DELETE"});
    state.products=state.products.filter(function(p){return p.id!==productId});
    renderDetail();
    toast("Product removed","success");
  }catch(e){ toast("Remove failed","error") }
}

async function doCreate(){
  var errors=[];
  var platform=document.getElementById("create-platform").value;
  if(!platform)errors.push("Platform is required");
  var body={
    platform:platform,
    account_id:document.getElementById("create-account").value||null,
    priority:document.getElementById("create-priority").value,
    external_order_id:document.getElementById("create-order-id").value.trim()||null,
    external_url:document.getElementById("create-url").value.trim()||null,
    customer_display_name:document.getElementById("create-customer").value.trim()||null,
    customer_contact:document.getElementById("create-contact").value.trim()||null,
    subject:document.getElementById("create-subject").value.trim()||null,
    description:document.getElementById("create-description").value.trim()||null,
    issue_types:state._createIssueTypes||[],
    status:"open"
  };
  if(errors.length){document.getElementById("create-errors").textContent=errors.join("; ");return}
  try{
    var r=await api("/api/ticketing/tickets",{method:"POST",body:JSON.stringify(body)});
    var d=await json(r);
    if(d.errors&&d.errors.length){document.getElementById("create-errors").textContent=d.errors.join("; ");return}
    toast("Ticket "+d.ticket.ticket_number+" created!","success");
    showList();
    loadTickets();
    // Clear form
    ["create-order-id","create-url","create-customer","create-contact","create-subject","create-description"].forEach(function(id){document.getElementById(id).value=""});
    document.getElementById("create-errors").textContent="";
  }catch(e){ toast("Create failed","error") }
}

// Utils
function e(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function eAttr(s){if(!s||typeof s!=="string")return"";return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function fmtDate(iso){if(!iso)return"-";try{var d=new Date(iso);return d.toLocaleString("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}catch(e){return iso}}

var _toastTimer;
function toast(msg,type){
  type=type||"info";
  var el=document.getElementById("toast");
  el.textContent=msg;el.className=type+" show";
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(function(){el.classList.remove("show")},2500);
}

boot();
</script>
</body>
</html>`;
