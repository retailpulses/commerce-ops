import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return { ...actual, requireAuth: authMocks.requireAuth };
});

import { AuthError } from "../auth";
import { onRequest } from "../../api/_middleware";

const env = {
  CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
  CF_ACCESS_AUD: "audience",
  INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "true",
};

beforeEach(() => {
  authMocks.requireAuth.mockReset();
  authMocks.requireAuth.mockResolvedValue({
    email: "operator@example.com",
    identity: "operator-id",
  });
});

describe("dashboard API middleware", () => {
  it("allows only the read-only release identity without an application session", async () => {
    authMocks.requireAuth.mockRejectedValue(new AuthError("invalid"));
    const next = vi.fn(async () => new Response(JSON.stringify({ application: "inquiry" })));
    const response = await onRequest({
      request: new Request("https://inquiry-dashboard.pages.dev/api/release"),
      env,
      next,
    });

    expect(response.status).toBe(200);
    expect(authMocks.requireAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when Access authentication fails", async () => {
    authMocks.requireAuth.mockRejectedValue(new AuthError("invalid"));
    const next = vi.fn();
    const response = await onRequest({
      request: new Request("https://ops.homesbliss.net/inquiry/api/inquiries"),
      env,
      next,
    });
    expect(response.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("protects reads and forwards a verified GET", async () => {
    const next = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    }));
    const request = new Request("https://ops.homesbliss.net/inquiry/api/inquiries");
    const response = await onRequest({ request, env, next });
    expect(response.status).toBe(200);
    expect(authMocks.requireAuth).toHaveBeenCalledWith(request, env);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin mutations", async () => {
    const response = await onRequest({
      request: new Request("https://ops.homesbliss.net/inquiry/api/inquiries/1/status", {
        method: "PATCH",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
      next: vi.fn(),
    });
    expect(response.status).toBe(403);
  });

  it("fail-closed: blocks mutations when switch is absent or not 'true'", async () => {
    for (const switchValue of [undefined, "false", "TRUE", "1"]) {
      const mutationEnv = { ...env } as Record<string, string | undefined>;
      if (switchValue === undefined) delete mutationEnv.INQUIRY_DASHBOARD_MUTATIONS_ENABLED;
      else mutationEnv.INQUIRY_DASHBOARD_MUTATIONS_ENABLED = switchValue;
      const next = vi.fn(async () => new Response("{}"));
      const response = await onRequest({
        request: new Request("https://ops.homesbliss.net/inquiry/api/inquiries/1/status", {
          method: "PATCH",
          headers: {
            Origin: "https://ops.homesbliss.net",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        env: mutationEnv as Record<string, string>,
        next,
      });
      expect(response.status).toBe(503);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("allows mutations when switch is exactly 'true'", async () => {
    const next = vi.fn(async () => new Response("{}"));
    const response = await onRequest({
      request: new Request("https://ops.homesbliss.net/inquiry/api/inquiries/1/status", {
        method: "PATCH",
        headers: {
          Origin: "https://ops.homesbliss.net",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env: { ...env, INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "true" },
      next,
    });
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows canonical Portal mutations forwarded to the owner origin", async () => {
    const next = vi.fn(async () => new Response("{}"));
    const response = await onRequest({
      request: new Request("https://inquiry-dashboard.pages.dev/api/inquiries/1/product", {
        method: "POST",
        headers: {
          Origin: "https://ops.homesbliss.net",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productVariantId: "00000000-0000-4000-8000-000000000000" }),
      }),
      env,
      next,
    });
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects mutation bodies without JSON content type", async () => {
    const response = await onRequest({
      request: new Request("https://ops.homesbliss.net/inquiry/api/inquiries/1/status", {
        method: "PATCH",
        headers: { Origin: "https://ops.homesbliss.net" },
        body: "status=answered",
      }),
      env,
      next: vi.fn(),
    });
    expect(response.status).toBe(415);
  });

  it("allows a same-origin authenticated JSON mutation", async () => {
    const next = vi.fn(async () => new Response("{}"));
    const response = await onRequest({
      request: new Request("https://ops.homesbliss.net/inquiry/api/inquiries/1/status", {
        method: "PATCH",
        headers: {
          Origin: "https://ops.homesbliss.net",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: "{}",
      }),
      env,
      next,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
