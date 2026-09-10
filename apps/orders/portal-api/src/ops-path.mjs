// Canonical Ops Portal path handling (Issue 60).
//
// The OrderMgmt portal lives under the canonical path /order/ on the shared
// ops host. Its browser API base is /order/api/portal, but the portal-api's
// internal route handlers and auth gate are unchanged at /api/portal/*.
// This module centralizes the single rewrite rule that keeps the two in sync.

const OPS_API_PREFIX = "/order/api/";

/**
 * Rewrite a canonical ops-portal API path to the legacy internal path.
 *
 *   "/order/api/portal/summary"  → "/api/portal/summary"
 *   "/order/api/release"         → "/api/release"
 *
 * Returns null when the path is not under the canonical /order/api/ prefix
 * (legacy /api/... paths and all other routes pass through untouched).
 *
 * Pure and side-effect free so it can be unit-tested without env/secrets.
 */
export function normalizeOpsApiPath(pathname) {
  if (typeof pathname !== "string") return null;
  if (!pathname.startsWith(OPS_API_PREFIX)) return null;
  return `/api/${pathname.slice(OPS_API_PREFIX.length)}`;
}

/**
 * Public read-only release metadata payload for GET /order/api/release.
 * No auth, no secrets — only the deploy-injected release identity.
 * contract_version=1 is the shape verified by the portal-acceptance gate.
 */
export function releasePayload(env) {
  return {
    application: "order",
    release_sha: String(env?.RELEASE_SHA ?? ""),
    built_at: String(env?.RELEASE_BUILT_AT ?? ""),
    contract_version: 1,
  };
}
