// Admin auth middleware for Portal API — mirrors the Worker's
// requirePortalAuth / requireAdminAuth pattern (src/lib/admin-auth.mjs).
// Uses timing-safe comparison to prevent timing attacks.

import { validateAdminToken } from "../../src/lib/admin-auth.mjs";
import { buildEnv } from "./env.mjs";

let _env = null;
function getEnv() {
  if (!_env) _env = buildEnv();
  return _env;
}

export function requirePortalAuth(request) {
  return validatePortalAuth(request, getEnv());
}

export function validatePortalAuth(request, env) {
  const proxySecret = request.headers.get("X-Ops-Portal-Proxy-Secret") || "";
  const accessAssertion = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (
    proxySecret &&
    accessAssertion &&
    env.OPS_PORTAL_PROXY_SECRET &&
    validateAdminToken(proxySecret, env.OPS_PORTAL_PROXY_SECRET)
  ) {
    return true;
  }

  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  const expectedSecrets = [
    env.ORDER_MGMT_ADMIN_SECRET,
    env.GIGA_SYNC_ADMIN_SECRET,
  ].filter(Boolean);
  return expectedSecrets.some((expected) => validateAdminToken(token, expected));
}

export function authErrorResponse() {
  return new Response(
    JSON.stringify({ ok: false, error: "unauthorized" }),
    {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "cache-control": "no-store",
      },
    },
  );
}
