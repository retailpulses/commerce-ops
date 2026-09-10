/** Cryptographic Cloudflare Access JWT validation for every dashboard API. */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthResult {
  valid: boolean;
  email?: string;
  identity?: string;
}

interface AccessEnv {
  [key: string]: unknown;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;
}

interface JWTHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

type AccessJWK = JsonWebKey & { kid?: string; alg?: string; use?: string };

interface JWKSResponse {
  keys?: AccessJWK[];
}

interface ValidationDeps {
  fetcher?: typeof fetch;
  nowMs?: () => number;
}

const JWKS_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, { expiresAt: number; keys: AccessJWK[] }>();

/** Test-only cache reset. It does not alter authentication behavior. */
export function resetAccessJWKSCacheForTests(): void {
  jwksCache.clear();
}

/** Extract the Access assertion injected by Cloudflare, with cookie fallback. */
function extractJWT(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function base64urlBytes(value: string): Uint8Array {
  let padded = value.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function decodeJSON<T>(value: string): T {
  const bytes = base64urlBytes(value);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function normalizeTeamDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain || !/^[a-z0-9.-]+\.cloudflareaccess\.com$/.test(domain)) return null;
  return domain;
}

async function getJWKS(
  domain: string,
  fetcher: typeof fetch,
  nowMs: number,
): Promise<AccessJWK[]> {
  const url = `https://${domain}/cdn-cgi/access/certs`;
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > nowMs) return cached.keys;

  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  if (!response.ok) throw new AuthError("Cloudflare Access JWKS is unavailable");

  const body = (await response.json()) as JWKSResponse;
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new AuthError("Cloudflare Access JWKS is invalid");
  }
  jwksCache.set(url, { expiresAt: nowMs + JWKS_TTL_MS, keys: body.keys });
  return body.keys;
}

async function verifyRS256(
  signingInput: string,
  signature: Uint8Array,
  jwk: AccessJWK,
): Promise<boolean> {
  if (jwk.kty !== "RSA") return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBuffer = new Uint8Array(signature).buffer;
  const inputBuffer = new TextEncoder().encode(signingInput).buffer;
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signatureBuffer,
    inputBuffer,
  );
}

function allowedEmail(email: string, configured: string | undefined): boolean {
  if (!configured?.trim()) return true;
  const allowed = new Set(
    configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  return allowed.has(email.toLowerCase());
}

/**
 * Validate signature and required Cloudflare Access claims. Configuration is
 * fail-closed: issuer and audience must both be present in the environment.
 */
export async function validateAccessJWT(
  request: Request,
  env: AccessEnv,
  deps: ValidationDeps = {},
): Promise<AuthResult> {
  const domain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN || "");
  const expectedAudience = env.CF_ACCESS_AUD?.trim();
  if (!domain || !expectedAudience) return { valid: false };

  const token = extractJWT(request);
  if (!token) return { valid: false };

  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) return { valid: false };

    const header = decodeJSON<JWTHeader>(parts[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
      return { valid: false };
    }

    const payload = decodeJSON<Record<string, unknown>>(parts[1]);
    const nowMs = (deps.nowMs || Date.now)();
    const keys = await getJWKS(domain, deps.fetcher || fetch, nowMs);
    const jwk = keys.find((candidate) =>
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      (candidate.alg === undefined || candidate.alg === "RS256") &&
      (candidate.use === undefined || candidate.use === "sig")
    );
    if (!jwk) return { valid: false };

    const signatureValid = await verifyRS256(
      `${parts[0]}.${parts[1]}`,
      base64urlBytes(parts[2]),
      jwk,
    );
    if (!signatureValid) return { valid: false };

    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { valid: false };
    if (payload.exp * 1000 <= nowMs) return { valid: false };

    const expectedIssuer = `https://${domain}`;
    if (typeof payload.iss !== "string" || payload.iss.replace(/\/$/, "") !== expectedIssuer) {
      return { valid: false };
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.some((audience) => audience === expectedAudience)) return { valid: false };

    if (typeof payload.sub !== "string" || !payload.sub.trim()) return { valid: false };
    if (typeof payload.email !== "string" || !payload.email.trim()) return { valid: false };
    const email = payload.email.trim();
    if (!allowedEmail(email, env.CF_ACCESS_ALLOWED_EMAILS)) return { valid: false };

    return { valid: true, email, identity: payload.sub.trim() };
  } catch {
    return { valid: false };
  }
}

export async function requireAuth(
  request: Request,
  env: AccessEnv,
): Promise<{ email: string; identity: string }> {
  const result = await validateAccessJWT(request, env);
  if (!result.valid || !result.email || !result.identity) {
    throw new AuthError(
      "Unauthorized: a valid Cloudflare Access session is required for this operation.",
    );
  }
  return { email: result.email, identity: result.identity };
}
