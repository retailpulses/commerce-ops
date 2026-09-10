import type { Ticket, TicketProduct } from "../repositories/ticketRepository";

export const TICKET_SHARE_VERSION = 1 as const;
export const TICKET_SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const BRIDGE_TIMESTAMP_HEADER = "X-Timestamp";
export const BRIDGE_NONCE_HEADER = "X-Nonce";
export const BRIDGE_SIGNATURE_HEADER = "X-Signature";

const encoder = new TextEncoder();

export interface TicketShareProductSnapshot {
  sku: string;
  product_name: string | null;
  variant: string | null;
  role: string;
  seller: string | null;
  unit_price: string | null;
}

export interface TicketShareSnapshotV1 {
  version: 1;
  seller_description: string;
  ticket: {
    ticket_number: string;
    platform: string;
    account_name: string | null;
    external_order_id: string | null;
    status: string;
    priority: string;
    issue_types: string[];
    started_at: string;
  };
  products: TicketShareProductSnapshot[];
}

export type TicketShareSourceTicket = Pick<
  Ticket,
  | "ticket_number"
  | "platform"
  | "external_order_id"
  | "status"
  | "priority"
  | "issue_types"
  | "started_at"
  | "created_at"
>;

export interface BridgeVerificationResult {
  ok: boolean;
  bodyText: string;
  nonce?: string;
  error?: "configuration" | "source" | "request" | "timestamp" | "signature" | "replay";
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function deriveTicketShareToken(
  secret: string,
  tokenId: string,
  ticketId: string,
): Promise<string> {
  return hmacSha256Hex(secret, `ticket-share:v1:${tokenId}:${ticketId}`);
}

export function bridgeCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right) || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function buildTicketShareSnapshot(
  ticket: TicketShareSourceTicket,
  products: TicketProduct[],
  accountName: string | null,
  sellerDescription: string,
): TicketShareSnapshotV1 {
  return {
    version: TICKET_SHARE_VERSION,
    seller_description: sellerDescription.trim(),
    ticket: {
      ticket_number: ticket.ticket_number,
      platform: ticket.platform,
      account_name: accountName,
      external_order_id: ticket.external_order_id,
      status: ticket.status,
      priority: ticket.priority,
      issue_types: [...ticket.issue_types],
      started_at: ticket.started_at ?? ticket.created_at,
    },
    products: products.map((product) => ({
      sku: product.sku,
      product_name: product.product_name ?? null,
      variant: product.variant_name ?? null,
      role: product.role,
      seller: product.seller_name ?? null,
      unit_price: product.unit_price ?? null,
    })),
  };
}

export function getClientIp(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP")?.trim() || null;
}

export async function verifyBridgeRequest(
  request: Request,
  options: {
    secret?: string;
    allowedIps?: string;
    nowMs?: number;
    claimNonce: (nonce: string) => Promise<boolean>;
    maxBodyBytes?: number;
  },
): Promise<BridgeVerificationResult> {
  const secret = options.secret ?? "";
  const allowedIps = new Set(
    (options.allowedIps ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
  );
  if (!secret || allowedIps.size === 0) {
    return { ok: false, bodyText: "", error: "configuration" };
  }

  const clientIp = getClientIp(request);
  if (!clientIp || !allowedIps.has(clientIp)) {
    return { ok: false, bodyText: "", error: "source" };
  }

  const timestamp = request.headers.get(BRIDGE_TIMESTAMP_HEADER) ?? "";
  const nonce = request.headers.get(BRIDGE_NONCE_HEADER) ?? "";
  const signature = (request.headers.get(BRIDGE_SIGNATURE_HEADER) ?? "").toLowerCase();
  if (!/^\d{10,13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !TICKET_SHARE_TOKEN_PATTERN.test(signature)) {
    return { ok: false, bodyText: "", error: "request" };
  }

  const timestampNumber = Number(timestamp);
  const requestTimeMs = timestamp.length === 13 ? timestampNumber : timestampNumber * 1000;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(requestTimeMs) || Math.abs(nowMs - requestTimeMs) > 60_000) {
    return { ok: false, bodyText: "", error: "timestamp" };
  }

  const bodyText = await readBodyTextBounded(request, options.maxBodyBytes ?? 16 * 1024);
  if (bodyText === null) {
    return { ok: false, bodyText: "", error: "request" };
  }

  const bodyHash = await sha256Hex(bodyText);
  const expected = await hmacSha256Hex(
    secret,
    bridgeCanonicalString(request.method, new URL(request.url).pathname, timestamp, nonce, bodyHash),
  );
  if (!constantTimeHexEqual(expected, signature)) {
    return { ok: false, bodyText: "", error: "signature" };
  }

  if (!(await options.claimNonce(nonce))) {
    return { ok: false, bodyText: "", error: "replay" };
  }
  return { ok: true, bodyText, nonce };
}

export async function readBodyTextBounded(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) return null;
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function isTicketShareSnapshot(value: unknown): value is TicketShareSnapshotV1 {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== 1 || typeof snapshot.seller_description !== "string") return false;
  if (!snapshot.ticket || typeof snapshot.ticket !== "object" || !Array.isArray(snapshot.products)) return false;
  const ticket = snapshot.ticket as Record<string, unknown>;
  const nullableString = (entry: unknown) => entry === null || typeof entry === "string";
  const validProduct = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const product = entry as Record<string, unknown>;
    return typeof product.sku === "string"
      && nullableString(product.product_name)
      && nullableString(product.variant)
      && typeof product.role === "string"
      && nullableString(product.seller)
      && nullableString(product.unit_price);
  };
  return typeof ticket.ticket_number === "string"
    && typeof ticket.platform === "string"
    && nullableString(ticket.account_name)
    && nullableString(ticket.external_order_id)
    && typeof ticket.status === "string"
    && typeof ticket.priority === "string"
    && Array.isArray(ticket.issue_types)
    && ticket.issue_types.every((issueType) => typeof issueType === "string")
    && typeof ticket.started_at === "string"
    && snapshot.products.every(validProduct);
}
