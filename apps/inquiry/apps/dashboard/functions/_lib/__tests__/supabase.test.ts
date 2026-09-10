/**
 * Supabase client tests.
 *
 * All Supabase calls are mocked (fetch is replaced) so no real
 * network requests are made.
 *
 * Tests cover:
 * - listInquiries with various filters
 * - getInquiryDetail with linked_products
 * - updateInquiry
 * - ownership-preserving product link mutations
 * - searchProducts
 * - lookupProduct
 * - Error handling (timeout, non-2xx, malformed response)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DashboardConfig } from "../config";
import type { SupabaseClient } from "../supabase";

// Keep track of the original fetch
const originalFetch = globalThis.fetch;

function createMinimalConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return {
    supabase: {
      url: "https://test-project.supabase.co",
      restUrl: "",
      serviceRoleKey: "test-service-role-key",
    },
    openai: {
      apiKey: "sk-test",
      model: "gpt-4o",
    },
    auth: {
      teamDomain: "",
      audience: "",
      allowedEmails: "",
    },
    mutationsEnabled: true,
    productCatalog: {
      table: "product_variants",
      schema: "public",
    },
    ...overrides,
  };
}

describe("SupabaseClient", () => {
  let client: SupabaseClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset fetch mock before each test
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    // Dynamic import to get fresh instance
    const { createSupabaseClient } = await import("../supabase");
    client = createSupabaseClient(createMinimalConfig());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("listInquiries", () => {
    it("returns data with no filters", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, status: "received", customer_nickname: "John", shop_key: "shop1", inquiry_date: "2026-08-28T01:00:00Z", expected_value: 100 },
          { id: 2, status: "answered", customer_nickname: "Jane", shop_key: "shop2", inquiry_date: "2026-08-27T01:00:00Z", expected_value: 200 },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Range": "0-2/2" },
        }),
      );

      const result = await client.listInquiries({});

      expect(result.data).toHaveLength(2);
      expect(result.data[0].status).toBe("received");
      expect(result.data[1].customer_nickname).toBe("Jane");
      expect(result.totalCount).toBe(2);
    });

    it("filters by status", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 3, status: "followed_up", customer_nickname: "Bob", shop_key: "shop1" },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await client.listInquiries({ status: "followed_up" });

      // Verify the request URL includes the status filter
      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain("status=eq.followed_up");
    });

    it("filters by inquiry type", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 }),
      );

      await client.listInquiries({ inquiryType: "shipping_related" });

      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain("inquiry_type=eq.shipping_related");
    });

    it("filters by shop", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await client.listInquiries({ shop: "shop3" });

      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain("shop_key=eq.shop3");
    });

    it("performs search ILIKE", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, status: "received", customer_nickname: "Taro", product_name_snapshot: "Table" },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await client.listInquiries({ search: "Taro" });

      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain("customer_nickname.ilike.");
      expect(requestUrl).toContain("product_name_snapshot.ilike.");
      expect(requestUrl).toContain("or");
    });

    it("respects pageSize", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(Array.from({ length: 21 }, (_, i) => ({
          id: i + 1, status: "received", customer_nickname: `User${i}`,
        }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.listInquiries({ pageSize: 20 });

      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(20);
    });

    it("returns hasMore=false when page is smaller than pageSize", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, status: "received", customer_nickname: "John" },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.listInquiries({ pageSize: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("requests chronological batches from PostgREST for date-level ranking", async () => {
      fetchMock.mockResolvedValueOnce(new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      await client.listInquiries({ pageSize: 20, cursor: 500 });
      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain(
        "order=inquiry_date.desc.nullslast%2Cid.desc",
      );
      expect(requestUrl).not.toContain("offset=");
      expect(requestUrl).toContain("limit=100");
    });

    it("ranks recent JST dates first and higher expected value first within a date", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: 100 },
          { id: 2, inquiry_date: "2026-08-28T01:00:00Z", expected_value: 900 },
          { id: 3, inquiry_date: "2026-08-27T10:00:00Z", expected_value: 9999 },
          { id: 4, inquiry_date: "2026-08-27T09:00:00Z", expected_value: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({ pageSize: 10 });

      expect(result.data.map((row) => row.id)).toEqual([2, 1, 3, 4]);
    });

    it("fetches through a JST date boundary before ranking a page", async () => {
      const firstBatch = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        inquiry_date: new Date(
          Date.parse("2026-08-28T14:00:00Z") - index * 60_000,
        ).toISOString(),
        expected_value: index + 1,
      }));
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify(firstBatch), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([
            { id: 101, inquiry_date: "2026-08-28T00:01:00Z", expected_value: 10000 },
            { id: 102, inquiry_date: "2026-08-26T23:59:00Z", expected_value: 20000 },
          ]), { status: 200, headers: { "Content-Type": "application/json" } }),
        );

      const result = await client.listInquiries({ pageSize: 2 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.data.map((row) => row.id)).toEqual([101, 100]);
      expect(fetchMock.mock.calls[1][0]).toContain("offset=100");
    });

    it("handles Supabase error response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "relation not found", details: "inquiry_list_vw does not exist" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(client.listInquiries({})).rejects.toThrow(
        "Supabase request failed (404)",
      );
    });
  });

  describe("listInquiries fallback hydration and expected value filtering", () => {
    it("hydrates catalog fallback pricing with bulk link and product fetches (no N+1)", async () => {
      const rows = [
        { id: 1, inquiry_date: "2026-08-28T08:00:00Z", units: 2, expected_value: null, effective_price_excl_shipping: null, effective_price_incl_shipping: null, effective_tcogs: null, has_product: true },
        { id: 2, inquiry_date: "2026-08-28T07:00:00Z", units: null, expected_value: null, effective_price_excl_shipping: null, effective_price_incl_shipping: null, effective_tcogs: null, has_product: true },
        { id: 3, inquiry_date: "2026-08-28T06:00:00Z", units: 3, expected_value: null, effective_price_excl_shipping: null, effective_price_incl_shipping: null, effective_tcogs: null, has_product: true },
      ];
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify(rows), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([
            { id: 10, inquiry_id: 1, product_variant_id: "uuid-1", is_primary: true, linked_at: "2026-08-01T00:00:00Z" },
            { id: 20, inquiry_id: 2, product_variant_id: "uuid-2", is_primary: true, linked_at: "2026-08-01T00:00:00Z" },
            { id: 30, inquiry_id: 3, product_variant_id: "uuid-3", is_primary: true, linked_at: "2026-08-01T00:00:00Z" },
          ]), { status: 200, headers: { "Content-Type": "application/json" } }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([
            { id: "uuid-1", item_code: "SKU1", variant_name: "A", stock_qty: 1, raw_payload: { "mercari_effective_pricing_incl._shipping": "500" } },
            { id: "uuid-2", item_code: "SKU2", variant_name: "B", stock_qty: 1, raw_payload: { "mercari_effective_pricing_incl._shipping": "1000" } },
            { id: "uuid-3", item_code: "SKU3", variant_name: "C", stock_qty: 1, raw_payload: { "mercari_effective_pricing_incl._shipping": "2000" } },
          ]), { status: 200, headers: { "Content-Type": "application/json" } }),
        );

      const result = await client.listInquiries({ pageSize: 10 });

      // id3 (3 x 2000), then id1 (2 x 500) vs id2 (1 x 1000) tie broken by timestamp
      expect(result.data.map((row) => row.id)).toEqual([3, 1, 2]);
      expect(result.data.map((row) => row.expected_value)).toEqual([6000, 1000, 1000]);
      expect(result.data.find((row) => row.id === 3)!.effective_price_incl_shipping).toBe(2000);

      // 1 list fetch + 1 bulk link fetch + 1 bulk product fetch — never per-inquiry/per-product
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const linksUrl = fetchMock.mock.calls[1][0] as string;
      const productsUrl = fetchMock.mock.calls[2][0] as string;
      expect(linksUrl).toContain("inquiry_product_links");
      expect(linksUrl).toContain("inquiry_id=in.");
      expect(productsUrl).toContain("product_variants");
      expect(productsUrl).toContain("id=in.");
    });

    it("does not fetch catalog when persisted expected value is present", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: 250, has_product: true, effective_price_incl_shipping: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({ pageSize: 10 });

      expect(result.data[0].expected_value).toBe(250);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("filters by minimum expected value only and excludes null", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: 100 },
          { id: 2, inquiry_date: "2026-08-28T07:00:00Z", expected_value: 900 },
          { id: 3, inquiry_date: "2026-08-28T06:00:00Z", expected_value: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({ pageSize: 10, minExpectedValue: 500 });

      expect(result.data.map((row) => row.id)).toEqual([2]);
    });

    it("filters by maximum expected value only and excludes null", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: 100 },
          { id: 2, inquiry_date: "2026-08-28T07:00:00Z", expected_value: 900 },
          { id: 3, inquiry_date: "2026-08-28T06:00:00Z", expected_value: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({ pageSize: 10, maxExpectedValue: 500 });

      expect(result.data.map((row) => row.id)).toEqual([1]);
    });

    it("filters within a bounded expected value range", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: 100 },
          { id: 2, inquiry_date: "2026-08-28T07:00:00Z", expected_value: 500 },
          { id: 3, inquiry_date: "2026-08-28T06:00:00Z", expected_value: 900 },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({
        pageSize: 10,
        minExpectedValue: 100,
        maxExpectedValue: 600,
      });

      expect(result.data.map((row) => row.id)).toEqual([2, 1]);
    });

    it("keeps null expected values visible (ranked last) when no range is active", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: null },
          { id: 2, inquiry_date: "2026-08-28T07:00:00Z", expected_value: 100 },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({ pageSize: 10 });

      expect(result.data.map((row) => row.id)).toEqual([2, 1]);
    });

    it("ranks by JST date first then filters by expected value across a date boundary", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: 1, inquiry_date: "2026-08-28T08:00:00Z", expected_value: 10 },
          { id: 2, inquiry_date: "2026-08-27T08:00:00Z", expected_value: 9999 },
          { id: 3, inquiry_date: "2026-08-27T07:00:00Z", expected_value: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await client.listInquiries({ pageSize: 10, minExpectedValue: 1 });

      // date desc is level 1: id1 (08-28) before id2 (08-27); id3 null excluded
      expect(result.data.map((row) => row.id)).toEqual([1, 2]);
    });

    it("continues fetching across a JST date boundary while filtering by expected value", async () => {
      const firstBatch = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        inquiry_date: new Date(
          Date.parse("2026-08-28T14:00:00Z") - index * 60_000,
        ).toISOString(),
        expected_value: (index + 1) * 10,
      }));
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify(firstBatch), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([
            { id: 101, inquiry_date: "2026-08-28T00:01:00Z", expected_value: 5000 },
            { id: 102, inquiry_date: "2026-08-26T23:59:00Z", expected_value: 99999 },
          ]), { status: 200, headers: { "Content-Type": "application/json" } }),
        );

      const result = await client.listInquiries({ pageSize: 2, minExpectedValue: 500 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.data.map((row) => row.id)).toEqual([101, 100]);
      expect(fetchMock.mock.calls[1][0]).toContain("offset=100");
    });
  });

  describe("getInquiryDetail", () => {
    it("returns inquiry with linked_products", async () => {
      const mockRow = {
        id: 1,
        status: "answered",
        customer_nickname: "Yuki",
        inquiry_body: "Is this available?",
        linked_products: [
          { id: 101, itemCode: "SKU-001", productName: "Sofa", isPrimary: true, linkSource: "operator", confidence: 1.0 },
        ],
        linked_knowledge: [],
        extra: {},
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([mockRow]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.getInquiryDetail(1);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.customer_nickname).toBe("Yuki");
      expect(result!.linked_products).toHaveLength(1);
      expect(result!.linked_products[0].itemCode).toBe("SKU-001");
      expect(result!.linked_products[0].isPrimary).toBe(true);
    });

    it("returns null for non-existent inquiry", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.getInquiryDetail(999);
      expect(result).toBeNull();
    });

    it("throws on error response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(client.getInquiryDetail(1)).rejects.toThrow();
    });
  });

  describe("updateInquiry", () => {
    it("sends PATCH with correct data", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.updateInquiry(1, { status: "answered" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain("/rest/v1/inquiries");
      expect((opts as RequestInit).method).toBe("PATCH");
      expect((opts as RequestInit).body).toContain('"status"');
      expect((opts as RequestInit).body).toContain('"answered"');
    });
  });

  describe("product link ownership", () => {
    const productUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    it("sets the operator-selected primary via RPC", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.operatorSetPrimaryLink({
        inquiryId: 42,
        productVariantId: productUuid,
        itemCodeSnapshot: "SKU-001",
        productNameSnapshot: "Sofa",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain("/rest/v1/rpc/operator_set_primary_link");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.p_inquiry_id).toBe(42);
      expect(body.p_product_variant_id).toBe(productUuid);
      expect(body.p_item_code_snapshot).toBe("SKU-001");
      expect(body.p_product_name_snapshot).toBe("Sofa");
    });

    it("unlinks a product by link row ID via RPC", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.operatorUnlinkProduct(42, 101);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain("/rest/v1/rpc/operator_unlink_product");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.p_inquiry_id).toBe(42);
      expect(body.p_link_id).toBe(101);
    });

    it("deletes a specific product link by variant UUID", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.deleteProductLink(42, productUuid);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("inquiry_id=eq.42");
      expect(url).toContain(`product_variant_id=eq.${productUuid}`);
    });
  });

  describe("searchProducts", () => {
    it("searches canonical product variants by item_code and variant_name", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", item_code: "SKU-001", variant_name: "Sofa", stock_qty: 2 },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.searchProducts("sofa", 20, "shop1");

      expect(result.data).toHaveLength(1);
      expect(result.data[0].item_code).toBe("SKU-001");

      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain("item_code.ilike.");
      expect(requestUrl).toContain("variant_name.ilike.");
      expect(requestUrl).toContain("product_commercials");
      expect(requestUrl).toContain("product_platform_links.platform=eq.mercari");
      expect(requestUrl).toContain("product_platform_links.shop_code=eq.shop1");
    });

    it("returns empty for blank query", async () => {
      const result = await client.searchProducts("");

      expect(result.data).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("handles product catalog table not found", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "relation \"public.product_variants\" does not exist" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(client.searchProducts("sofa")).rejects.toThrow(
        "Supabase request failed (404)",
      );
    });
  });

  describe("lookupProduct", () => {
    it("returns product by ID", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", item_code: "SKU-001", variant_name: "Sofa", stock_qty: 2 },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.lookupProduct(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "shop1",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(result!.item_code).toBe("SKU-001");
      expect(result!.variant_name).toBe("Sofa");
      const requestUrl = fetchMock.mock.calls[0][0] as string;
      expect(requestUrl).toContain("product_commercials");
      expect(requestUrl).toContain("product_platform_links.shop_code=eq.shop1");
    });

    it("returns null for non-existent product", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.lookupProduct("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(result).toBeNull();
    });
  });

  describe("error handling", () => {
    it("handles fetch timeout", async () => {
      fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      await expect(client.listInquiries({})).rejects.toThrow();
    });

    it("handles network error", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await expect(client.listInquiries({})).rejects.toThrow();
    });

    it("handles malformed JSON response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("not-json-at-all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      await expect(client.listInquiries({})).rejects.toThrow();
    });
  });
});
