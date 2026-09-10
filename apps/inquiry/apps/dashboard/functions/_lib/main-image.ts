/**
 * Main-image BFF: server-side exact-listing resolution + RPagentOS owner proxy.
 *
 * The image workflow is deliberately independent from title/description
 * payloads. The browser never supplies a listing ID, shop, or listing — the
 * exact listing is always re-resolved from the inquiry's primary linked
 * product, platform, and shop, so a stale or forged client value cannot
 * redirect a mutation to a different listing.
 */

import type { DashboardConfig } from "./config";
import type { InquiryDetailRow } from "./supabase";
import { resolveExactListing, type ListingOptimization } from "./listing-optimization";

export type MainImageAction = "schema" | "candidate" | "save" | "publish";

export const MAIN_IMAGE_ACTIONS: readonly MainImageAction[] = [
  "schema",
  "candidate",
  "save",
  "publish",
];

export function isMainImageAction(value: unknown): value is MainImageAction {
  return typeof value === "string" && (MAIN_IMAGE_ACTIONS as readonly string[]).includes(value);
}

/** Owner route segment per action (relative to /api/internal/catalog/listings/:id/). */
const ACTION_ROUTES: Record<MainImageAction, string> = {
  schema: "main-image-schema",
  candidate: "main-image-candidate",
  save: "main-image-assets",
  publish: "operator-main-image-publishes",
};

/** BFF action-specific keys allowed alongside `action` and `expectedContentRevision`. */
const ACTION_FIELDS: Record<MainImageAction, string[]> = {
  schema: [],
  candidate: ["factPackHash", "confirmedContextEvidenceIds", "schema"],
  save: [
    "candidateBase64", "candidateToken", "factPackHash",
    "confirmedContextEvidenceIds", "operatorExclusions", "operatorOverrides",
    "schema", "operatorConfirmed",
  ],
  publish: ["assetId", "operatorConfirmed"],
};

export class MainImageError extends Error {
  status: number;
  details?: unknown;
  body?: Record<string, unknown>;
  constructor(
    message: string,
    status: number,
    opts: { details?: unknown; body?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "MainImageError";
    this.status = status;
    this.details = opts.details;
    this.body = opts.body;
  }
}

/** Slim listing identity returned to the browser (no title/description payload). */
export interface MainImageListingIdentity {
  id: string;
  platform: string;
  shopCode: string;
  externalListingId: string;
  contentRevision: number;
}

export interface OwnerResponse {
  status: number;
  body: Record<string, unknown>;
}

export type MainImageContextResult =
  | { status: "ready"; listing: MainImageListingIdentity; context: Record<string, unknown> }
  | { status: "waiting_for_customer_confirmation" | "mapping_error" | "mapping_conflict"; message?: string };

function ownerUrl(config: DashboardConfig, listingId: string, route: string): string {
  if (!config.catalogOwner.apiUrl || !config.catalogOwner.token) {
    throw new MainImageError("Image service is not configured", 502);
  }
  return `${config.catalogOwner.apiUrl.replace(/\/$/, "")}/api/internal/catalog/listings/${encodeURIComponent(listingId)}/${route}`;
}

function ownerErrorMessage(body: Record<string, unknown>, status: number): string {
  const raw = body.error ?? body.message ?? body.detail;
  return typeof raw === "string" && raw ? raw : `Image service request failed (${status})`;
}

/** Proxy one owner call. Preserves owner status; never leaks tokens or URLs. */
async function callOwner(
  config: DashboardConfig,
  listingId: string,
  route: string,
  init?: RequestInit,
): Promise<OwnerResponse> {
  let response: Response;
  try {
    response = await fetch(ownerUrl(config, listingId, route), {
      ...init,
      headers: {
        Authorization: `Bearer ${config.catalogOwner.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    console.warn("main_image_owner_fetch_failed", {
      route,
      errorName: error instanceof Error ? error.name : "unknown",
      apiUrlConfigured: Boolean(config.catalogOwner.apiUrl),
      tokenConfigured: Boolean(config.catalogOwner.token),
    });
    throw new MainImageError("Image service is unavailable", 502);
  }
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* non-JSON body */ }
  if (!response.ok) {
    console.warn("main_image_owner_response_failed", {
      route,
      status: response.status,
      contentType: response.headers.get("content-type") || "unknown",
    });
    throw new MainImageError(ownerErrorMessage(body, response.status), response.status, {
      details: body.details,
    });
  }
  return { status: response.status, body };
}

/**
 * Validate + translate the camelCase BFF body into the exact snake_case owner
 * body. Unknown action-specific keys are rejected; operator confirmation is
 * only ever written server-side as the literal `true` after the browser
 * supplies `operatorConfirmed === true`.
 */
export function buildOwnerBody(action: MainImageAction, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(["action", "expectedContentRevision", ...ACTION_FIELDS[action]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new MainImageError(`Unknown field for ${action}: ${key}`, 400);
  }

  const ownerBody: Record<string, unknown> = {
    expected_content_revision: raw.expectedContentRevision,
  };

  if (action === "candidate") {
    requireString(raw.factPackHash, "factPackHash");
    requireStringArray(raw.confirmedContextEvidenceIds, "confirmedContextEvidenceIds");
    requireObject(raw.schema, "schema");
    ownerBody.fact_pack_hash = raw.factPackHash;
    ownerBody.confirmed_context_evidence_ids = raw.confirmedContextEvidenceIds;
    ownerBody.schema = raw.schema;
  }

  if (action === "save") {
    requireString(raw.candidateBase64, "candidateBase64");
    requireString(raw.candidateToken, "candidateToken");
    requireString(raw.factPackHash, "factPackHash");
    requireStringArray(raw.confirmedContextEvidenceIds, "confirmedContextEvidenceIds");
    requireStringArray(raw.operatorExclusions, "operatorExclusions");
    if (!Array.isArray(raw.operatorOverrides)) throw new MainImageError("operatorOverrides must be an array", 400);
    requireObject(raw.schema, "schema");
    if (raw.operatorConfirmed !== true) throw new MainImageError("Operator confirmation is required", 400);
    ownerBody.candidate_base64 = raw.candidateBase64;
    ownerBody.candidate_token = raw.candidateToken;
    ownerBody.fact_pack_hash = raw.factPackHash;
    ownerBody.confirmed_context_evidence_ids = raw.confirmedContextEvidenceIds;
    ownerBody.operator_exclusions = raw.operatorExclusions;
    ownerBody.operator_overrides = raw.operatorOverrides;
    ownerBody.schema = raw.schema;
    ownerBody.operator_confirmed = true;
  }

  if (action === "publish") {
    if (typeof raw.assetId !== "string" || !raw.assetId) throw new MainImageError("assetId is required", 400);
    if (raw.operatorConfirmed !== true) throw new MainImageError("Operator confirmation is required", 400);
    ownerBody.asset_id = raw.assetId;
    ownerBody.operator_confirmed = true;
  }

  return ownerBody;
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value) throw new MainImageError(`${field} is required`, 400);
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new MainImageError(`${field} must be a string array`, 400);
  }
}

function requireObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MainImageError(`${field} must be an object`, 400);
  }
}

/** Publish idempotency derived server-side; a browser key is never accepted. */
function publishIdempotencyKey(inquiryId: number, listingId: string, revision: number, assetId: string): string {
  return `inquiry-${inquiryId}-listing-${listingId}-r${revision}-asset-${assetId}`;
}

function identityFromResolved(resolved: ListingOptimization): MainImageListingIdentity | undefined {
  const listing = resolved.listing;
  if (!listing) return undefined;
  return {
    id: listing.id,
    platform: listing.platform,
    shopCode: listing.shopCode,
    externalListingId: listing.externalListingId,
    contentRevision: listing.contentRevision,
  };
}

/** GET: resolve the exact listing, then proxy the owner's main-image context. */
export async function getMainImageContext(config: DashboardConfig, inquiry: InquiryDetailRow): Promise<MainImageContextResult> {
  const resolved = await resolveExactListing(config, inquiry);
  if (resolved.status !== "ready") return { status: resolved.status, message: resolved.message };
  const listing = identityFromResolved(resolved);
  if (!listing) return { status: "mapping_error", message: "Exact listing is missing" };
  const { body } = await callOwner(config, listing.id, "main-image-context");
  return { status: "ready", listing, context: body };
}

/** POST: re-resolve the exact listing, then proxy a single action to the owner. */
export async function proxyMainImageAction(
  config: DashboardConfig,
  inquiry: InquiryDetailRow,
  inquiryId: number,
  raw: Record<string, unknown>,
): Promise<OwnerResponse> {
  const action = raw.action;
  if (!isMainImageAction(action)) throw new MainImageError("Invalid action", 400);

  const resolved = await resolveExactListing(config, inquiry);
  if (resolved.status !== "ready") {
    throw new MainImageError(resolved.message || "Listing mapping is not ready", 409, {
      body: { status: resolved.status, message: resolved.message },
    });
  }
  const listing = identityFromResolved(resolved);
  if (!listing) throw new MainImageError("Exact listing is missing", 409);

  if (typeof raw.expectedContentRevision !== "number" || !Number.isInteger(raw.expectedContentRevision)) {
    throw new MainImageError("expectedContentRevision must be an integer", 400);
  }
  if (raw.expectedContentRevision !== listing.contentRevision) {
    throw new MainImageError("Listing changed; reload before continuing", 409);
  }

  const ownerBody = buildOwnerBody(action, raw);
  if (action === "publish") {
    ownerBody.idempotency_key = publishIdempotencyKey(inquiryId, listing.id, listing.contentRevision, String(ownerBody.asset_id));
  }
  return callOwner(config, listing.id, ACTION_ROUTES[action], { method: "POST", body: JSON.stringify(ownerBody) });
}
