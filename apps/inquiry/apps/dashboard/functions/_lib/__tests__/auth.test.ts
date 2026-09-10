import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  requireAuth,
  resetAccessJWKSCacheForTests,
  validateAccessJWT,
} from "../auth";

let signingKeys: CryptoKeyPair;
let publicJWK: JsonWebKey & { kid?: string; alg?: string; use?: string };
const kid = "stage-c-rsa-key";
const nowSeconds = 1_800_000_000;

const testEnv = {
  CF_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
  CF_ACCESS_AUD: "test-audience-tag",
};

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createJWT(
  payload: Record<string, unknown>,
  options: { key?: CryptoKey; alg?: string; tokenKid?: string } = {},
): Promise<string> {
  const header = base64url(JSON.stringify({
    alg: options.alg ?? "RS256",
    kid: options.tokenKid ?? kid,
    typ: "JWT",
  }));
  const body = base64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? signingKeys.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user-id-123",
    email: "operator@example.com",
    iss: "https://test-team.cloudflareaccess.com",
    aud: "test-audience-tag",
    exp: nowSeconds + 3600,
    ...overrides,
  };
}

function makeRequest(token?: string, useCookie = false): Request {
  const headers = new Headers();
  if (token) {
    if (useCookie) headers.set("Cookie", `CF_Authorization=${encodeURIComponent(token)}`);
    else headers.set("Cf-Access-Jwt-Assertion", token);
  }
  return new Request("https://ops.homesbliss.net/inquiry/api/inquiries", { headers });
}

beforeAll(async () => {
  signingKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  publicJWK = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
  publicJWK.kid = kid;
  publicJWK.alg = "RS256";
  publicJWK.use = "sig";
});

beforeEach(() => {
  resetAccessJWKSCacheForTests();
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ keys: [publicJWK] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )));
});

const deps = { nowMs: () => nowSeconds * 1000 };

describe("validateAccessJWT", () => {
  it("cryptographically validates a Cloudflare Access assertion", async () => {
    const result = await validateAccessJWT(
      makeRequest(await createJWT(validClaims())),
      testEnv,
      deps,
    );
    expect(result).toEqual({
      valid: true,
      email: "operator@example.com",
      identity: "user-id-123",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://test-team.cloudflareaccess.com/cdn-cgi/access/certs",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects a payload modified after signing", async () => {
    const token = await createJWT(validClaims());
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${base64url(JSON.stringify(validClaims({ email: "attacker@example.com" })))}.${signature}`;
    expect((await validateAccessJWT(makeRequest(tampered), testEnv, deps)).valid).toBe(false);
  });

  it("rejects a token signed by an untrusted RSA key", async () => {
    const attacker = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const token = await createJWT(validClaims(), { key: attacker.privateKey });
    expect((await validateAccessJWT(makeRequest(token), testEnv, deps)).valid).toBe(false);
  });

  it.each([
    ["expired", { exp: nowSeconds - 1 }],
    ["missing expiry", { exp: undefined }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["prefix-confusion issuer", { iss: "https://test-team.cloudflareaccess.com.evil.test" }],
    ["wrong audience", { aud: "wrong-audience" }],
    ["missing subject", { sub: undefined }],
    ["missing email", { email: undefined }],
  ])("rejects %s claims", async (_label, overrides) => {
    const token = await createJWT(validClaims(overrides));
    expect((await validateAccessJWT(makeRequest(token), testEnv, deps)).valid).toBe(false);
  });

  it("rejects non-RS256 algorithms before key verification", async () => {
    const token = await createJWT(validClaims(), { alg: "none" });
    expect((await validateAccessJWT(makeRequest(token), testEnv, deps)).valid).toBe(false);
  });

  it("rejects an unknown key ID", async () => {
    const token = await createJWT(validClaims(), { tokenKid: "unknown" });
    expect((await validateAccessJWT(makeRequest(token), testEnv, deps)).valid).toBe(false);
  });

  it("rejects missing JWT and fail-closed configuration", async () => {
    expect((await validateAccessJWT(makeRequest(), testEnv, deps)).valid).toBe(false);
    const token = await createJWT(validClaims());
    expect((await validateAccessJWT(makeRequest(token), {}, deps)).valid).toBe(false);
    expect((await validateAccessJWT(
      makeRequest(token),
      { CF_ACCESS_TEAM_DOMAIN: testEnv.CF_ACCESS_TEAM_DOMAIN },
      deps,
    )).valid).toBe(false);
  });

  it("supports the Cloudflare Access cookie fallback", async () => {
    const token = await createJWT(validClaims({ email: "cookie@example.com" }));
    const result = await validateAccessJWT(makeRequest(token, true), testEnv, deps);
    expect(result.valid).toBe(true);
    expect(result.email).toBe("cookie@example.com");
  });

  it("enforces an optional exact email allowlist", async () => {
    const token = await createJWT(validClaims());
    const denied = await validateAccessJWT(
      makeRequest(token),
      { ...testEnv, CF_ACCESS_ALLOWED_EMAILS: "another@example.com" },
      deps,
    );
    const allowed = await validateAccessJWT(
      makeRequest(token),
      { ...testEnv, CF_ACCESS_ALLOWED_EMAILS: "operator@example.com, another@example.com" },
      deps,
    );
    expect(denied.valid).toBe(false);
    expect(allowed.valid).toBe(true);
  });

  it("rejects JWKS fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const token = await createJWT(validClaims());
    expect((await validateAccessJWT(makeRequest(token), testEnv, deps)).valid).toBe(false);
  });

  it("rejects JWKS redirects while using workerd-compatible manual mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/jwks" },
    })));
    const token = await createJWT(validClaims());
    expect((await validateAccessJWT(makeRequest(token), testEnv, deps)).valid).toBe(false);
  });
});

describe("requireAuth", () => {
  it("returns the verified identity", async () => {
    const token = await createJWT(validClaims());
    await expect(requireAuth(makeRequest(token), testEnv)).resolves.toEqual({
      email: "operator@example.com",
      identity: "user-id-123",
    });
  });

  it("throws AuthError for a missing assertion", async () => {
    await expect(requireAuth(makeRequest(), testEnv)).rejects.toThrow(AuthError);
  });
});
