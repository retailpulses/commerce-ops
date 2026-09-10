/**
 * Shared helper utilities used by both portal handlers (in handlers.mjs)
 * and non-portal code (pipeline, admin inspectors, fetch dispatch in worker/index.js).
 */

export function text(value) {
  return String(value == null ? "" : value).trim();
}

export function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeOrderIdCandidate(value) {
  return text(value).replace(/^order_/, "");
}

export function normalizeErrorMessage(error) {
  if (!error) return "unknown_error";
  if (error && typeof error === "object" && error.stack) return String(error.stack);
  return String(error);
}

export async function safeJson(request) {
  const raw = await request.text().catch(() => null);
  if (raw == null || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _parse_error: "malformed_json" };
  }
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

/**
 * Match a URL pathname against a named-parameter pattern.
 * Example: matchPath("/api/portal/orders/abc123", "/api/portal/orders/:id")
 *   → { id: "abc123" }
 * Returns null if no match.
 */
export function matchPath(pathname, pattern) {
  const patParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
