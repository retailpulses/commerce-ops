import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../index";

function makeKV(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchWorker(path: string, init?: RequestInit, env?: Record<string, unknown>): Promise<Response> {
  return worker.fetch(
    new Request(`https://tickets.example.test${path}`, init),
    {
      MERCARI_REPORTS: makeKV(),
      PASSWORD_HASH: await sha256Hex("secret"),
      ENABLE_NEW_TICKETING: "true",
      ...env,
    } as never,
    {} as never
  );
}

describe("worker routing", () => {
  it("forwards the stable Mercari webhook ingress only to its ingestion binding", async () => {
    const calls: Array<{ url: string; method: string; secret: string | null; body: string }> = [];
    let foreignCalls = 0;
    const binding = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          secret: request.headers.get("x-webhook-secret"),
          body: await request.text(),
        });
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      },
    } as unknown as Fetcher;
    const response = await fetchWorker("/api/webhooks/mercari-message?source=contract", {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "test-only" },
      body: '{"event":"fixture"}',
    }, {
      MERCARI_INGESTION_PROVIDER: binding,
      RAKUTEN_INGESTION_PROVIDER: { fetch: async () => { foreignCalls += 1; throw new Error("foreign binding called"); } } as unknown as Fetcher,
      AMAZON_INGESTION_PROVIDER: { fetch: async () => { foreignCalls += 1; throw new Error("foreign binding called"); } } as unknown as Fetcher,
    });

    assert.equal(response.status, 401);
    assert.deepEqual(calls, [{
      url: "https://tickets.example.test/api/webhooks/mercari-message?source=contract",
      method: "POST",
      secret: "test-only",
      body: '{"event":"fixture"}',
    }]);
    assert.equal(foreignCalls, 0);

    const unavailable = await fetchWorker("/api/webhooks/mercari-message", {
      method: "POST",
      body: "{}",
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "Mercari ingestion is unavailable" });
  });

  it("serves the Supabase ticketing frontend at the canonical /tickets path", async () => {
    const response = await fetchWorker("/tickets/");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(await response.text(), /Ticket Workspace/);

    const head = await fetchWorker("/tickets/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("Content-Type") ?? "", /text\/html/);
  });

  it("redirects legacy frontend entry points to /tickets", async () => {
    const cases: Array<[string, string]> = [
      ["/", "/tickets/"],
      ["/ticketing", "/tickets/"],
      ["/ticketing/new", "/tickets/new"],
      ["/ticketing/queue", "/tickets/queue"],
      ["/queue", "/tickets/queue"],
    ];

    for (const [path, location] of cases) {
      const response = await fetchWorker(path);
      assert.equal(response.status, 302, `${path} should redirect`);
      assert.equal(response.headers.get("Location"), location, `${path} Location`);
    }
  });

  it("returns 404 for retired Baserow workspace APIs", async () => {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/api/tickets", undefined],
      ["/api/tickets/1", undefined],
      ["/api/tickets/1", { method: "PATCH", body: "{}" }],
      ["/api/tickets/1/notes", { method: "POST", body: "{}" }],
      ["/api/reports", undefined],
      ["/api/reports/2026-07-09_01-00", undefined],
      ["/api/run", { method: "POST", body: "{}" }],
      ["/api/prompts", undefined],
      ["/api/prompts", { method: "POST", body: "{}" }],
      ["/api/prompts/history", undefined],
    ];

    for (const [path, init] of cases) {
      const response = await fetchWorker(path, init);
      assert.equal(response.status, 404, `${init?.method ?? "GET"} ${path}`);
    }
  });

  it("serves React frontend when ENABLE_REACT_FRONTEND is true", async () => {
    const response = await fetchWorker("/tickets/", undefined, {
      ENABLE_REACT_FRONTEND: "true",
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    const html = await response.text();
    // React app renders into #root div
    assert.match(html, /id="root"/);

    // SPA fallback routes also serve the React app
    const ticketRoute = await fetchWorker("/tickets/some-uuid", undefined, {
      ENABLE_REACT_FRONTEND: "true",
    });
    assert.equal(ticketRoute.status, 200);
    assert.match((await ticketRoute.text()), /id="root"/);

    const queueRoute = await fetchWorker("/tickets/queue", undefined, {
      ENABLE_REACT_FRONTEND: "true",
    });
    assert.equal(queueRoute.status, 200);
    assert.match((await queueRoute.text()), /id="root"/);

    // API routes still work alongside React frontend
    const health = await fetchWorker("/api/health", undefined, {
      ENABLE_REACT_FRONTEND: "true",
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      version: "3.1.0-ticketing",
      ticket_pipeline: "supabase-only",
      ticketform_automation_mode: "shadow",
      ticket_shares_enabled: false,
      rakuten_rmesse_outbound_enabled: false,
      amazon_mail_ingestion_mode: "off",
      amazon_mail_outbound_enabled: false,
      amazon_mail_attachments_enabled: false,
      messaging: {
        mercari: { send: { status: "unavailable", error_code: "BINDING_MISSING" }, ingestion: { status: "unavailable", error_code: "BINDING_MISSING" } },
        rakuten: { send: { status: "unavailable", error_code: "BINDING_MISSING" }, ingestion: { status: "unavailable", error_code: "BINDING_MISSING" } },
        amazon: { spapi_send: { status: "unavailable", error_code: "BINDING_MISSING" }, mail_ingestion: { status: "unavailable", error_code: "BINDING_MISSING" }, mail_attachments: { status: "disabled" }, legacy_zoho_outbound: { status: "disabled" } },
      },
    });
  });

  it("keeps shared health, session, and ticketing frontend routes", async () => {
    const health = await fetchWorker("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      version: "3.1.0-ticketing",
      ticket_pipeline: "supabase-only",
      ticketform_automation_mode: "shadow",
      ticket_shares_enabled: false,
      rakuten_rmesse_outbound_enabled: false,
      amazon_mail_ingestion_mode: "off",
      amazon_mail_outbound_enabled: false,
      amazon_mail_attachments_enabled: false,
      messaging: {
        mercari: { send: { status: "unavailable", error_code: "BINDING_MISSING" }, ingestion: { status: "unavailable", error_code: "BINDING_MISSING" } },
        rakuten: { send: { status: "unavailable", error_code: "BINDING_MISSING" }, ingestion: { status: "unavailable", error_code: "BINDING_MISSING" } },
        amazon: { spapi_send: { status: "unavailable", error_code: "BINDING_MISSING" }, mail_ingestion: { status: "unavailable", error_code: "BINDING_MISSING" }, mail_attachments: { status: "disabled" }, legacy_zoho_outbound: { status: "disabled" } },
      },
    });

    const shareEnabledHealth = await fetchWorker("/api/health", undefined, {
      ENABLE_TICKET_SHARES: "true",
    });
    assert.equal(shareEnabledHealth.status, 200);
    assert.equal(
      ((await shareEnabledHealth.json()) as { ticket_shares_enabled: boolean }).ticket_shares_enabled,
      true,
    );

    const amazonSendHealth = await fetchWorker("/api/ticketing/health", undefined, {
      AMAZON_MAIL_INGESTION_MODE: "shadow",
      AMAZON_MAIL_OUTBOUND_ENABLED: "true",
    });
    const amazonHealth = await amazonSendHealth.json() as {
      amazon_mail_ingestion_mode: string;
      amazon_mail_outbound_enabled: boolean;
    };
    assert.equal(amazonHealth.amazon_mail_ingestion_mode, "shadow");
    assert.equal(amazonHealth.amazon_mail_outbound_enabled, false);
    assert.equal(
      ((amazonHealth as unknown as { messaging: { amazon: { legacy_zoho_outbound: { status: string } } } }).messaging.amazon.legacy_zoho_outbound.status),
      "disabled",
    );

    const portalSafeHealth = await fetchWorker("/api/ticketing/health", undefined, {
      ENABLE_TICKET_SHARES: "true",
    });
    assert.equal(portalSafeHealth.status, 200);
    assert.equal(
      ((await portalSafeHealth.json()) as { ticket_shares_enabled: boolean }).ticket_shares_enabled,
      true,
    );

    const rakutenSendHealth = await fetchWorker("/api/ticketing/health", undefined, {
      RAKUTEN_RMESSE_OUTBOUND_ENABLED: "true",
      MERCARI_OUTBOUND_ENABLED: "true",
    });
    const platformHealth = await rakutenSendHealth.json() as {
      rakuten_rmesse_outbound_enabled: boolean;
      messaging: { mercari: { send: { status: string } }; rakuten: { send: { status: string } } };
    };
    assert.equal(platformHealth.rakuten_rmesse_outbound_enabled, true);
    assert.equal(platformHealth.messaging.mercari.send.status, "unavailable");
    assert.equal(platformHealth.messaging.rakuten.send.status, "unavailable");

    const session = await fetchWorker("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret" }),
    });
    assert.equal(session.status, 200);
    assert.equal(typeof ((await session.json()) as { token: unknown }).token, "string");

    const ticketing = await fetchWorker("/tickets/");
    assert.equal(ticketing.status, 200);
    assert.match(ticketing.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(await ticketing.text(), /Ticket Workspace/);
  });

  it("serves /tickets/api/release and normalizes /tickets/api/* to /api/*", async () => {
    // Without an injected RELEASE_SHA the endpoint falls back to a 40-char sentinel.
    const fallback = await fetchWorker("/tickets/api/release");
    assert.equal(fallback.status, 200);
    const fallbackBody = (await fallback.json()) as {
      application: string;
      release_sha: string;
      built_at: string;
      contract_version: number;
    };
    assert.equal(fallbackBody.application, "tickets");
    assert.equal(fallbackBody.contract_version, 1);
    assert.equal(fallbackBody.release_sha.length, 40);
    assert.ok(Date.parse(fallbackBody.built_at) > Date.parse("2026-01-01T00:00:00Z"));

    // An injected deploy SHA is echoed verbatim.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const injected = await fetchWorker("/tickets/api/release", undefined, { RELEASE_SHA: sha });
    const injectedBody = (await injected.json()) as { release_sha: string };
    assert.equal(injectedBody.release_sha, sha);

    // /tickets/api/ticketing/health normalizes onto the legacy handler.
    const health = await fetchWorker("/tickets/api/ticketing/health");
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");
  });
});
