import type { SupabaseClient } from "@supabase/supabase-js";
import { validateSession } from "../middleware/auth";
import { getSupabaseClient } from "../repositories/supabase";
import type { TicketProduct } from "../repositories/ticketRepository";
import type { Env } from "../types";
import {
  UUID_PATTERN,
  TICKET_SHARE_TOKEN_PATTERN,
  buildTicketShareSnapshot,
  deriveTicketShareToken,
  isTicketShareSnapshot,
  readBodyTextBounded,
  sha256Hex,
  verifyBridgeRequest,
} from "../services/ticketShareService";
import { claimTicketShareNonce } from "../services/ticketShareReplayGuard";

const R2_GRANT_TTL_SECONDS = 60;
const DATABASE_REQUEST_TIMEOUT_MS = 5_000;

function databaseSignal(): AbortSignal {
  return AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS);
}

interface ShareRow {
  id: string;
  ticket_id: string;
  status: "active" | "expired" | "revoked";
  expires_at: string;
  snapshot_version: number;
  snapshot: unknown;
  pii_reviewed_at: string;
  access_count: number | string;
  last_accessed_at: string | null;
  created_at: string;
}

interface SelectedAttachmentRow {
  share_token_id: string;
  attachment_id: string;
  display_order: number;
}

interface EvidenceAuthorizationRow {
  share_id: string;
  ticket_id: string;
  attachment_id: string;
  storage_bucket: string;
  storage_path: string;
  filename: string | null;
  mime_type: string | null;
  media_type: string;
  size_bytes: number | string | null;
  expires_at: string;
}

interface ShareMutationBody {
  client_operation_id?: unknown;
  seller_description?: unknown;
  attachment_ids?: unknown;
  pii_confirmed?: unknown;
}

interface ShareSourceTicket {
  ticket_number: string;
  platform: string;
  account_id: string | null;
  external_order_id: string | null;
  status: string;
  priority: string;
  issue_types: string[];
  started_at: string | null;
  created_at: string;
}

interface R2Grant {
  attachment_id: string;
  path: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function operatorError(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function operatorActor(request: Request): Promise<string> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return "portal_session:unknown";
  return `portal_session:${(await sha256Hex(token)).slice(0, 24)}`;
}

function unavailable(): Response {
  return json({ error: "Unavailable" }, 404);
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

function isActuallyActive(row: ShareRow): boolean {
  return row.status === "active" && new Date(row.expires_at).getTime() > Date.now();
}

function publicBaseUrl(env: Env): string | null {
  const value = env.TICKET_SHARE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

async function serializeShare(
  row: ShareRow,
  selected: SelectedAttachmentRow[],
  env: Env,
): Promise<Record<string, unknown>> {
  const snapshot = isTicketShareSnapshot(row.snapshot) ? row.snapshot : null;
  const active = isActuallyActive(row);
  const baseUrl = publicBaseUrl(env);
  let url = "";
  if (active && baseUrl && env.TICKET_SHARE_TOKEN_SIGNING_SECRET) {
    const token = await deriveTicketShareToken(env.TICKET_SHARE_TOKEN_SIGNING_SECRET, row.id, row.ticket_id);
    url = `${baseUrl}/tickets/share/${token}`;
  }
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    status: active ? "active" : row.status === "active" ? "expired" : row.status,
    url,
    expires_at: row.expires_at,
    created_at: row.created_at,
    access_count: Number(row.access_count),
    last_accessed_at: row.last_accessed_at,
    seller_description: snapshot?.seller_description ?? "",
    attachment_ids: selected
      .filter((entry) => entry.share_token_id === row.id)
      .sort((left, right) => left.display_order - right.display_order)
      .map((entry) => entry.attachment_id),
    pii_reviewed_at: row.pii_reviewed_at,
  };
}

async function selectedAttachments(
  supabase: SupabaseClient,
  shareIds: string[],
): Promise<SelectedAttachmentRow[]> {
  if (shareIds.length === 0) return [];
  const { data, error } = await supabase
    .from("ticket_share_attachments")
    .select("share_token_id,attachment_id,display_order")
    .in("share_token_id", shareIds)
    .order("display_order", { ascending: true })
    .abortSignal(databaseSignal());
  if (error) throw new Error(`share attachment lookup failed: ${error.message}`);
  return (data ?? []) as SelectedAttachmentRow[];
}

function firstRelation(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown> | undefined) ?? null;
  return (value as Record<string, unknown> | null) ?? null;
}

async function loadShareSource(
  supabase: SupabaseClient,
  ticketId: string,
): Promise<{ ticket: ShareSourceTicket; products: TicketProduct[]; accountName: string | null } | null> {
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("ticket_number,platform,account_id,external_order_id,status,priority,issue_types,started_at,created_at")
    .eq("id", ticketId)
    .abortSignal(databaseSignal())
    .maybeSingle();
  if (ticketError) throw new Error(`ticket share source lookup failed: ${ticketError.message}`);
  if (!ticket) return null;
  const sourceTicket = ticket as ShareSourceTicket;

  const productQuery = supabase
    .from("ticket_products")
    .select("id,ticket_id,sku,role,created_at,product:products(title),variant:product_variants(variant_name,raw_payload)")
    .eq("ticket_id", ticketId)
    .abortSignal(databaseSignal());
  const accountQuery = sourceTicket.account_id
    ? supabase
      .from("platform_accounts")
      .select("display_name")
      .eq("id", sourceTicket.account_id)
      .abortSignal(databaseSignal())
      .maybeSingle()
    : Promise.resolve({ data: null, error: null });
  const [{ data: productRows, error: productError }, { data: account, error: accountError }] = await Promise.all([
    productQuery,
    accountQuery,
  ]);
  if (productError) throw new Error(`ticket share product lookup failed: ${productError.message}`);
  if (accountError) throw new Error(`ticket share account lookup failed: ${accountError.message}`);

  const products = (productRows ?? []).map((row: Record<string, unknown>): TicketProduct => {
    const product = firstRelation(row.product);
    const variant = firstRelation(row.variant);
    const variantPayload = (variant?.raw_payload as Record<string, unknown> | null) ?? {};
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      product_id: null,
      variant_id: null,
      listing_id: null,
      listing_sku_id: null,
      sku: row.sku as string,
      quantity: null,
      role: row.role as string,
      created_at: row.created_at as string,
      product_name: (product?.title as string | undefined) ?? null,
      variant_name: (variant?.variant_name as string | undefined) ?? null,
      seller_name: (variantPayload.store_name as string | undefined) ?? null,
      unit_price: (variantPayload.unit_price as string | undefined) ?? null,
    };
  });
  return {
    ticket: sourceTicket,
    products,
    accountName: typeof account?.display_name === "string" ? account.display_name : null,
  };
}

function validateMutationBody(body: ShareMutationBody): {
  clientOperationId: string;
  sellerDescription: string;
  attachmentIds: string[];
} | null {
  const clientOperationId = typeof body.client_operation_id === "string" ? body.client_operation_id : "";
  const sellerDescription = typeof body.seller_description === "string" ? body.seller_description.trim() : "";
  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((value): value is string => typeof value === "string")
    : [];
  if (!UUID_PATTERN.test(clientOperationId)
      || !sellerDescription
      || sellerDescription.length > 5000
      || body.pii_confirmed !== true
      || attachmentIds.length > 50
      || attachmentIds.length !== (body.attachment_ids as unknown[] | undefined)?.length
      || attachmentIds.some((id) => !UUID_PATTERN.test(id))
      || new Set(attachmentIds).size !== attachmentIds.length) {
    return null;
  }
  return { clientOperationId, sellerDescription, attachmentIds };
}

async function readJsonBody(request: Request): Promise<ShareMutationBody | null> {
  try {
    const bodyText = await readBodyTextBounded(request, 32 * 1024);
    return bodyText === null ? null : JSON.parse(bodyText) as ShareMutationBody;
  } catch {
    return null;
  }
}

export async function handleListTicketShares(
  request: Request,
  env: Env,
  ticketId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) return operatorError("Unauthorized", 401);
  if (!UUID_PATTERN.test(ticketId)) return operatorError("Ticket not found", 404);
  if (!env.TICKET_SHARE_TOKEN_SIGNING_SECRET || !publicBaseUrl(env)) {
    return operatorError("Ticket sharing is not configured", 503);
  }

  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("ticket_share_tokens")
    .select("id,ticket_id,status,expires_at,snapshot_version,snapshot,pii_reviewed_at,access_count,last_accessed_at,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(50)
    .abortSignal(databaseSignal());
  if (error) {
    console.error(`[TicketShare] list failed: ${error.message}`);
    return operatorError("Could not load ticket shares", 500);
  }
  const rows = (data ?? []) as ShareRow[];
  const selected = await selectedAttachments(supabase, rows.map((row) => row.id));
  const shares = await Promise.all(rows.map((row) => serializeShare(row, selected, env)));
  return json({
    active_share: shares.find((share) => share.status === "active") ?? null,
    shares,
  });
}

export async function handleCreateTicketShare(
  request: Request,
  env: Env,
  ticketId: string,
  rotate: boolean,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) return operatorError("Unauthorized", 401);
  if (!UUID_PATTERN.test(ticketId)) return operatorError("Ticket not found", 404);
  if (!env.TICKET_SHARE_TOKEN_SIGNING_SECRET || !publicBaseUrl(env)) {
    return operatorError("Ticket sharing is not configured", 503);
  }

  const parsed = validateMutationBody((await readJsonBody(request)) ?? {});
  if (!parsed) {
    return operatorError("A valid operation ID, reviewed seller description, attachment selection, and PII confirmation are required", 422);
  }

  const supabase = getSupabaseClient(env);
  let source: Awaited<ReturnType<typeof loadShareSource>>;
  try {
    source = await loadShareSource(supabase, ticketId);
  } catch (error) {
    console.error(`[TicketShare] source lookup failed: ${String(error)}`);
    return operatorError("Could not load share content", 500);
  }
  if (!source) return operatorError("Ticket not found", 404);

  const snapshot = buildTicketShareSnapshot(
    source.ticket,
    source.products,
    source.accountName,
    parsed.sellerDescription,
  );
  const tokenId = crypto.randomUUID();
  const token = await deriveTicketShareToken(env.TICKET_SHARE_TOKEN_SIGNING_SECRET, tokenId, ticketId);
  const tokenHash = await sha256Hex(token);
  const actor = await operatorActor(request);

  const { data, error } = await supabase.rpc("create_ticket_share", {
    p_token_id: tokenId,
    p_ticket_id: ticketId,
    p_token_hash: tokenHash,
    p_client_operation_id: parsed.clientOperationId,
    p_created_by: actor,
    p_snapshot: snapshot,
    p_attachment_ids: parsed.attachmentIds,
    p_rotate: rotate,
  }).abortSignal(databaseSignal());
  if (error) {
    console.error(`[TicketShare] ${rotate ? "rotate" : "create"} failed: ${error.message}`);
    const clientError = /attachment|ticket not found|seller snapshot/i.test(error.message);
    return operatorError(clientError ? "Share content is invalid or no longer available" : "Could not create ticket share", clientError ? 422 : 500);
  }

  const row = firstRow<ShareRow>(data);
  if (!row) return operatorError("Could not create ticket share", 500);
  const selected = await selectedAttachments(supabase, [row.id]);
  return json({ share: await serializeShare(row, selected, env) }, rotate ? 200 : 201);
}

export async function handleRevokeTicketShare(
  request: Request,
  env: Env,
  ticketId: string,
  shareId: string,
): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) return operatorError("Unauthorized", 401);
  if (!UUID_PATTERN.test(ticketId) || !UUID_PATTERN.test(shareId)) return operatorError("Share not found", 404);
  const supabase = getSupabaseClient(env);
  const actor = await operatorActor(request);
  const { data, error } = await supabase.rpc("revoke_ticket_share", {
    p_ticket_id: ticketId,
    p_share_id: shareId,
    p_actor: actor,
  }).abortSignal(databaseSignal());
  if (error) {
    console.error(`[TicketShare] revoke failed: ${error.message}`);
    return operatorError(/not found/i.test(error.message) ? "Share not found" : "Could not revoke ticket share", /not found/i.test(error.message) ? 404 : 500);
  }
  const row = firstRow<ShareRow>(data);
  if (!row) return operatorError("Share not found", 404);
  const selected = await selectedAttachments(supabase, [row.id]);
  return json({ share: await serializeShare(row, selected, env) });
}

async function authenticateBridge(request: Request, env: Env): Promise<string | null> {
  let verified;
  try {
    verified = await verifyBridgeRequest(request, {
      secret: env.TICKET_SHARE_BRIDGE_HMAC_SECRET,
      allowedIps: env.TICKET_SHARE_BRIDGE_ALLOWED_IPS,
      claimNonce: (nonce) => claimTicketShareNonce(env.TICKET_SHARE_REPLAY_GUARD, nonce),
    });
  } catch (error) {
    console.error(`[TicketShareBridge] replay guard failed: ${String(error)}`);
    return null;
  }
  if (!verified.ok) {
    console.warn(`[TicketShareBridge] rejected request (${verified.error ?? "unknown"})`);
    return null;
  }
  return verified.bodyText;
}

async function evidenceMetadata(
  supabase: SupabaseClient,
  shareId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data: selected, error: selectedError } = await supabase
    .from("ticket_share_attachments")
    .select("attachment_id,display_order")
    .eq("share_token_id", shareId)
    .order("display_order", { ascending: true })
    .abortSignal(databaseSignal());
  if (selectedError) throw new Error(`selected evidence lookup failed: ${selectedError.message}`);
  const selectedRows = (selected ?? []) as Array<{ attachment_id: string; display_order: number }>;
  if (selectedRows.length === 0) return [];

  const { data: attachments, error: attachmentError } = await supabase
    .from("ticket_attachments")
    .select("id,filename,mime_type,media_type,size_bytes")
    .in("id", selectedRows.map((entry) => entry.attachment_id))
    .abortSignal(databaseSignal());
  if (attachmentError) throw new Error(`evidence metadata lookup failed: ${attachmentError.message}`);
  const byId = new Map((attachments ?? []).map((entry: Record<string, unknown>) => [entry.id as string, entry]));
  return selectedRows.flatMap((entry) => {
    const attachment = byId.get(entry.attachment_id);
    return attachment ? [{
      id: attachment.id,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      media_type: attachment.media_type,
      size_bytes: attachment.size_bytes === null ? null : Number(attachment.size_bytes),
    }] : [];
  });
}

export async function handleResolveTicketShare(request: Request, env: Env): Promise<Response> {
  const bodyText = await authenticateBridge(request, env);
  if (bodyText === null) return unavailable();
  let token = "";
  try {
    const body = JSON.parse(bodyText) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : "";
  } catch {
    return unavailable();
  }
  if (!TICKET_SHARE_TOKEN_PATTERN.test(token)) return unavailable();

  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase.rpc("resolve_ticket_share", {
    p_token_hash: await sha256Hex(token),
  }).abortSignal(databaseSignal());
  if (error) {
    console.error(`[TicketShareBridge] resolve database failure: ${error.message}`);
    return json({ error: "Temporary failure" }, 503);
  }
  const row = firstRow<ShareRow>(data);
  if (!row || !isTicketShareSnapshot(row.snapshot)) return unavailable();
  try {
    const snapshot = row.snapshot;
    const evidence = await evidenceMetadata(supabase, row.id);
    return json({
      ticketNumber: snapshot.ticket.ticket_number,
      platform: snapshot.ticket.platform,
      shopName: snapshot.ticket.account_name ?? "",
      externalOrderId: snapshot.ticket.external_order_id ?? "",
      status: snapshot.ticket.status,
      priority: snapshot.ticket.priority,
      issueTypes: snapshot.ticket.issue_types,
      startedDate: snapshot.ticket.started_at,
      products: snapshot.products.map((product) => ({
        sku: product.sku,
        name: product.product_name ?? "",
        variant: product.variant ?? "",
        role: product.role,
        seller: product.seller ?? "",
        unitPrice: product.unit_price ?? "",
      })),
      sellerDescription: snapshot.seller_description,
      expiry: row.expires_at,
      evidence: evidence.map((attachment) => ({
        attachmentId: attachment.id,
        fileName: attachment.filename ?? "evidence",
        mimeType: attachment.mime_type ?? "application/octet-stream",
        size: attachment.size_bytes ?? 0,
      })),
    });
  } catch (error) {
    console.error(`[TicketShareBridge] evidence metadata failure: ${String(error)}`);
    return json({ error: "Temporary failure" }, 503);
  }
}

export async function handleAuthorizeTicketShareEvidence(request: Request, env: Env): Promise<Response> {
  const bodyText = await authenticateBridge(request, env);
  if (bodyText === null) return unavailable();
  let token = "";
  let attachmentId = "";
  try {
    const body = JSON.parse(bodyText) as { token?: unknown; attachment_id?: unknown; attachmentId?: unknown };
    token = typeof body.token === "string" ? body.token : "";
    const rawAttachmentId = body.attachment_id ?? body.attachmentId;
    attachmentId = typeof rawAttachmentId === "string" ? rawAttachmentId : "";
  } catch {
    return unavailable();
  }
  if (!TICKET_SHARE_TOKEN_PATTERN.test(token) || !UUID_PATTERN.test(attachmentId)) return unavailable();

  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase.rpc("authorize_ticket_share_attachment", {
    p_token_hash: await sha256Hex(token),
    p_attachment_id: attachmentId,
  }).abortSignal(databaseSignal());
  if (error) {
    console.error(`[TicketShareBridge] evidence authorization database failure: ${error.message}`);
    return json({ error: "Temporary failure" }, 503);
  }
  const row = firstRow<EvidenceAuthorizationRow>(data);
  if (!row) return unavailable();

  let upstreamUrl: string;
  if (row.storage_bucket.startsWith("r2:")) {
    if (!env.LEGACY_EVIDENCE) return json({ error: "Temporary failure" }, 503);
    const grant = crypto.randomUUID();
    const grantPayload: R2Grant = {
      attachment_id: row.attachment_id,
      path: row.storage_path,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    };
    await env.MERCARI_REPORTS.put(`ticket-share-evidence-grant:${grant}`, JSON.stringify(grantPayload), {
      expirationTtl: R2_GRANT_TTL_SECONDS,
    });
    upstreamUrl = `${new URL(request.url).origin}/api/internal/ticket-shares/evidence/content/${grant}`;
  } else {
    const { data: signed, error: signedError } = await supabase.storage
      .from(row.storage_bucket)
      .createSignedUrl(row.storage_path, R2_GRANT_TTL_SECONDS);
    if (signedError || !signed?.signedUrl) {
      console.error(`[TicketShareBridge] signed evidence URL failure: ${signedError?.message ?? "missing URL"}`);
      return json({ error: "Temporary failure" }, 503);
    }
    upstreamUrl = signed.signedUrl;
  }

  return json({
    url: upstreamUrl,
    fileName: row.filename ?? "evidence",
    mimeType: row.mime_type ?? "application/octet-stream",
    size: row.size_bytes === null ? 0 : Number(row.size_bytes),
    upstreamExpiresIn: R2_GRANT_TTL_SECONDS,
  });
}

function sourceIpAllowed(request: Request, env: Env): boolean {
  const allowed = new Set((env.TICKET_SHARE_BRIDGE_ALLOWED_IPS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const ip = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return allowed.size > 0 && allowed.has(ip);
}

export async function handleTicketShareEvidenceGrant(
  request: Request,
  env: Env,
  grantId: string,
): Promise<Response> {
  if (!UUID_PATTERN.test(grantId) || !sourceIpAllowed(request, env) || !env.LEGACY_EVIDENCE) return unavailable();
  const raw = await env.MERCARI_REPORTS.get(`ticket-share-evidence-grant:${grantId}`);
  if (!raw) return unavailable();
  let grant: R2Grant;
  try {
    grant = JSON.parse(raw) as R2Grant;
  } catch {
    return unavailable();
  }
  const requestedRange = request.headers.get("Range");
  if (requestedRange && !/^bytes=\d*-\d*$/.test(requestedRange)) {
    return new Response(null, { status: 416, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  }
  const object = await env.LEGACY_EVIDENCE.get(grant.path, { range: request.headers });
  if (!object) return unavailable();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", grant.mime_type || headers.get("Content-Type") || "application/octet-stream");
  if (object.range) {
    let start = 0;
    let length = object.size;
    if ("suffix" in object.range) {
      length = Math.min(object.range.suffix, object.size);
      start = object.size - length;
    } else {
      start = object.range.offset ?? 0;
      length = object.range.length ?? Math.max(0, object.size - start);
    }
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
  } else {
    headers.set("Content-Length", String(object.size));
  }
  return new Response(object.body, { status: object.range ? 206 : 200, headers });
}
