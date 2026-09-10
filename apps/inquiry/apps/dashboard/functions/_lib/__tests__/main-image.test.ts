import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
const supabaseMocks = vi.hoisted(() => ({ getInquiryDetail: vi.fn() }));
const listingMocks = vi.hoisted(() => ({ resolveExactListing: vi.fn() }));

vi.mock("../auth", () => ({ requireAuth: authMocks.requireAuth }));
vi.mock("../supabase", () => ({
  createSupabaseClient: () => ({ getInquiryDetail: supabaseMocks.getInquiryDetail }),
}));
vi.mock("../listing-optimization", () => ({
  resolveExactListing: listingMocks.resolveExactListing,
}));

import { onRequestGet, onRequestPost } from "../../api/inquiries/[id]/main-image";

const env: Record<string, string> = {
  CATALOG_OWNER_API_URL: "https://owner.example.com",
  CATALOG_OWNER_API_TOKEN: "owner-token-123",
  INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "true",
  SUPABASE_URL: "https://catalog.test",
  SUPABASE_SERVICE_ROLE_KEY: "secret",
};

function readyListing(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    listing: {
      id: "listing-123",
      platform: "mercari",
      shopCode: "shop2",
      externalListingId: "ext-1",
      title: "Title",
      description: "Description",
      contentRevision: 5,
      scoreTotal: null,
      scoreModules: null,
      scoredAt: null,
      scoreIsStale: false,
      ...overrides,
    },
  };
}

function postRequest(body: unknown): Request {
  return new Request("https://ops.example.com/inquiry/api/inquiries/1/main-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMocks.requireAuth.mockReset();
  authMocks.requireAuth.mockResolvedValue({ email: "op@example.com", identity: "op-id" });
  supabaseMocks.getInquiryDetail.mockReset();
  supabaseMocks.getInquiryDetail.mockResolvedValue({ id: 1 });
  listingMocks.resolveExactListing.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("main-image GET", () => {
  it("returns JSON when the inquiry lookup fails", async () => {
    supabaseMocks.getInquiryDetail.mockRejectedValue(new Error("upstream failed"));

    const response = await onRequestGet({
      request: new Request("https://ops.example.com/inquiry/api/inquiries/1/main-image"),
      env,
      params: { id: "1" },
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Unable to load inquiry for image optimization" });
  });

  it("returns JSON when the owner cannot be reached", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const response = await onRequestGet({
      request: new Request("https://ops.example.com/inquiry/api/inquiries/1/main-image"),
      env,
      params: { id: "1" },
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Image service is unavailable" });
  });

  it("resolves the exact listing server-side and proxies its context", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ current_image_url: "https://cdn/img.png" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await onRequestGet({
      request: new Request("https://ops.example.com/inquiry/api/inquiries/1/main-image"),
      env,
      params: { id: "1" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(body.listing.id).toBe("listing-123");
    expect(body.context.current_image_url).toBe("https://cdn/img.png");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://owner.example.com/api/internal/catalog/listings/listing-123/main-image-context");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer owner-token-123" });
  });

  it("returns mapping/waiting errors as 409", async () => {
    listingMocks.resolveExactListing.mockResolvedValue({ status: "mapping_error", message: "No exact listing" });
    const response = await onRequestGet({
      request: new Request("https://ops.example.com/inquiry/api/inquiries/1/main-image"),
      env,
      params: { id: "1" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "mapping_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("main-image POST", () => {
  it("fails closed when mutations are disabled for every action (schema spends money too)", async () => {
    const disabledEnv = { ...env, INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "false" };
    for (const action of ["schema", "candidate", "save", "publish"]) {
      const response = await onRequestPost({
        request: postRequest({ action, expectedContentRevision: 5 }),
        env: disabledEnv,
        params: { id: "1" },
      });
      expect(response.status).toBe(503);
    }
    expect(listingMocks.resolveExactListing).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the resolved listing ID for the owner route, never a browser value", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await onRequestPost({
      request: postRequest({ action: "schema", expectedContentRevision: 5 }),
      env,
      params: { id: "1" },
    });

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/listings/listing-123/main-image-schema");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ expected_content_revision: 5 });
  });

  it("rejects an arbitrary browser-supplied listing ID", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    const response = await onRequestPost({
      request: postRequest({ action: "schema", expectedContentRevision: 5, listingId: "attacker-listing" }),
      env,
      params: { id: "1" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Unknown field for schema: listingId" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a stale expectedContentRevision before proxying", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing({ contentRevision: 5 }));
    const response = await onRequestPost({
      request: postRequest({ action: "schema", expectedContentRevision: 4 }),
      env,
      params: { id: "1" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Listing changed; reload before continuing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires operator confirmation to save", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    const saveBody = {
      action: "save", expectedContentRevision: 5,
      candidateBase64: "base64", candidateToken: "token", factPackHash: "fact-hash",
      confirmedContextEvidenceIds: ["evidence-1"], operatorExclusions: [],
      operatorOverrides: [], schema: { schema_version: "1.0" },
    };
    const unconfirmed = await onRequestPost({
      request: postRequest(saveBody),
      env,
      params: { id: "1" },
    });
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({ error: "Operator confirmation is required" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ asset_id: "a1" }), { status: 200 }));
    const confirmed = await onRequestPost({
      request: postRequest({ ...saveBody, operatorConfirmed: true }),
      env,
      params: { id: "1" },
    });
    expect(confirmed.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/listings/listing-123/main-image-assets");
    const ownerBody = JSON.parse((init as RequestInit).body as string);
    expect(ownerBody).toEqual({
      expected_content_revision: 5,
      candidate_base64: "base64",
      candidate_token: "token",
      fact_pack_hash: "fact-hash",
      confirmed_context_evidence_ids: ["evidence-1"],
      operator_exclusions: [],
      operator_overrides: [],
      schema: { schema_version: "1.0" },
      operator_confirmed: true,
    });
  });

  it("forwards an edited schema and explicit context evidence to candidate generation", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ candidate_token: "token" }), { status: 200 }));
    const response = await onRequestPost({
      request: postRequest({
        action: "candidate", expectedContentRevision: 5, factPackHash: "fact-hash",
        confirmedContextEvidenceIds: ["listing:title"], schema: { schema_version: "1.0" },
      }),
      env,
      params: { id: "1" },
    });
    expect(response.status).toBe(200);
    const ownerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(ownerBody).toEqual({
      expected_content_revision: 5,
      fact_pack_hash: "fact-hash",
      confirmed_context_evidence_ids: ["listing:title"],
      schema: { schema_version: "1.0" },
    });
  });

  it("generates publish idempotency server-side and ignores browser idempotency", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ outcome: "published", content_revision: 6 }), { status: 200 }));

    const response = await onRequestPost({
      request: postRequest({ action: "publish", expectedContentRevision: 5, assetId: "a1", operatorConfirmed: true, idempotencyKey: "browser-key" }),
      env,
      params: { id: "1" },
    });

    // Browser idempotency is an unknown field and must be rejected.
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const accepted = await onRequestPost({
      request: postRequest({ action: "publish", expectedContentRevision: 5, assetId: "a1", operatorConfirmed: true }),
      env,
      params: { id: "1" },
    });
    expect(accepted.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/listings/listing-123/operator-main-image-publishes");
    const ownerBody = JSON.parse((init as RequestInit).body as string);
    expect(ownerBody).toEqual({
      asset_id: "a1",
      operator_confirmed: true,
      expected_content_revision: 5,
      idempotency_key: "inquiry-1-listing-listing-123-r5-asset-a1",
    });
  });

  it("preserves owner HTTP status and error details without leaking tokens or URLs", async () => {
    listingMocks.resolveExactListing.mockResolvedValue(readyListing());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Unsupported image format", details: "must be PNG or JPEG" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await onRequestPost({
      request: postRequest({ action: "publish", expectedContentRevision: 5, assetId: "a1", operatorConfirmed: true }),
      env,
      params: { id: "1" },
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("Unsupported image format");
    expect(body.details).toBe("must be PNG or JPEG");
    const text = JSON.stringify(body);
    expect(text).not.toContain("owner-token-123");
    expect(text).not.toContain("owner.example.com");
  });
});
