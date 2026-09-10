/**
 * Admin authentication helpers for Worker /admin/* routes.
 */

export function validateAdminToken(token, expected) {
  if (!expected || !token) return false;
  if (token.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i += 1) {
    result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

export function requireAdminAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  const expectedSecrets = [
    env.ORDER_MGMT_ADMIN_SECRET,
    env.GIGA_SYNC_ADMIN_SECRET,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return expectedSecrets.some((expected) => validateAdminToken(token, expected));
}

export function adminAuthErrorResponse() {
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
