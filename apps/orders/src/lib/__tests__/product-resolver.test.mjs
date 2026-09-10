// ── Unit tests for product-resolver.mjs pure functions ──────────────
import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import {
  computeMargin,
  computeStockStatus,
  assessRiskBadges,
  findFieldId,
  normalizeBaserowNextUrl,
  readSelectValue,
} from "../product-resolver.mjs";
import {
  createRakutenItemCodeBatchResolver,
  createRakutenItemCodeResolver,
  mercariResolveItemCode,
} from "../item-code-resolver.mjs";

describe("normalizeBaserowNextUrl", () => {
  it("upgrades Baserow HTTP pagination links so authorization survives", () => {
    assert.equal(
      normalizeBaserowNextUrl("http://api.baserow.io/api/database/rows/table/1/?page=2"),
      "https://api.baserow.io/api/database/rows/table/1/?page=2",
    );
  });

  it("preserves HTTPS and expands relative pagination links", () => {
    assert.equal(normalizeBaserowNextUrl("https://api.baserow.io/api/test"), "https://api.baserow.io/api/test");
    assert.equal(normalizeBaserowNextUrl("/api/test"), "https://api.baserow.io/api/test");
  });
});

// ── computeMargin ────────────────────────────────────────────────────

describe("computeMargin", () => {
  const fieldIds = { effectiveTcogsFieldId: 100, effectiveCostPriceFieldId: 101, sourceUnitPriceFieldId: 102 };
  const rate = 0.10;

  it("happy path: quantity-aware margin", () => {
    const salesRow = { product_price: 5000, shipping_price: 800, quantity: 2 };
    // field_100 = 2000 (effective TCOGS per unit)
    const productData = { field_100: 2000 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    // revenue = 5000 * 2 = 10000
    // shipping = 800
    // base = 10800
    // commission = 10800 * 0.10 = 1080
    // tcogs = 2000 * 2 = 4000
    // profit = 10000 + 800 - 1080 - 4000 = 5720
    // marginPercent = (5720 / 10800) * 100 = 52.96...
    assert.equal(result.revenue, 10000);
    assert.equal(result.shipping, 800);
    assert.equal(result.commission, 1080);
    assert.equal(result.tcogs, 4000);
    assert.equal(result.profit, 5720);
    assert.ok(result.marginPercent > 52 && result.marginPercent < 53);
    assert.equal(result.hasTcogs, true);
    assert.equal(result.tcogsSource, "product_table");
  });

  it("single unit (qty=1)", () => {
    const salesRow = { product_price: 3000, shipping_price: 0, quantity: 1 };
    const productData = { field_100: 1500 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    assert.equal(result.revenue, 3000);
    assert.equal(result.commission, 300); // 3000 * 0.10
    assert.equal(result.tcogs, 1500);
    assert.equal(result.profit, 1200); // 3000 - 300 - 1500
    assert.equal(result.marginPercent, 40);
  });

  it("flags Effective COGS equal to Giga Unit Price while margin still uses TCOGS", () => {
    const salesRow = { product_price: "3,000", shipping_price: 5000, quantity: 2 };
    const productData = { field_100: "4,000", field_101: "3,000", field_102: "3,000" };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    assert.equal(result.marginPercent, 17.27);
    assert.equal(result.effectiveTcogsPerUnit, 4000);
    assert.equal(result.effectiveCogsPerUnit, 3000);
    assert.equal(result.sourceUnitPrice, 3000);
    assert.equal(result.unitPrice, 3000);
    assert.equal(result.cogsEqualsUnitPrice, true);

    const badges = assessRiskBadges(salesRow, productData, result, { status: "supplier_ok" });
    assert.equal(badges.some((badge) => badge.type === "cogs_unit_price_equal"), true);
  });

  it("does not flag unequal or missing supplier prices", () => {
    const unequal = computeMargin(
      { product_price: 3001, shipping_price: 0, quantity: 3 },
      { field_100: 4000, field_101: 3000, field_102: 3001 },
      rate,
      fieldIds,
    );
    const missing = computeMargin(
      { shipping_price: 0, quantity: 1 },
      { field_100: 4000, field_101: 3000 },
      rate,
      fieldIds,
    );

    assert.equal(unequal.cogsEqualsUnitPrice, false);
    assert.equal(missing.cogsEqualsUnitPrice, false);
  });

  it("zero quantity → profit is null", () => {
    const salesRow = { product_price: 5000, shipping_price: 0, quantity: 0 };
    const productData = { field_100: 2000 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    assert.equal(result.revenue, 0);
    assert.equal(result.profit, null);
    assert.equal(result.marginPercent, null);
  });

  it("missing productData → no tcogs, profit null", () => {
    const salesRow = { product_price: 5000, shipping_price: 0, quantity: 1 };
    const result = computeMargin(salesRow, null, rate, fieldIds);

    assert.equal(result.hasTcogs, false);
    assert.equal(result.tcogsSource, "missing");
    assert.equal(result.profit, null);
    assert.equal(result.marginPercent, null);
    assert.equal(result.tcogs, null);
  });

  it("productData with no tcogs field → null tcogs", () => {
    const salesRow = { product_price: 5000, shipping_price: 0, quantity: 1 };
    const productData = { field_999: 3000 }; // wrong field
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    assert.equal(result.hasTcogs, false);
    assert.equal(result.profit, null);
  });

  it("zero tcogs → profit still calculated (free goods)", () => {
    const salesRow = { product_price: 5000, shipping_price: 0, quantity: 1 };
    const productData = { field_100: 0 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    assert.equal(result.hasTcogs, true);
    assert.equal(result.tcogs, 0);
    // profit = 5000 - 500 - 0 = 4500
    assert.equal(result.profit, 4500);
  });

  it("negative margin", () => {
    const salesRow = { product_price: 1000, shipping_price: 0, quantity: 1 };
    const productData = { field_100: 2000 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    // commission = 100
    // profit = 1000 - 100 - 2000 = -1100
    assert.ok(result.profit < 0);
    assert.ok(result.marginPercent < 0);
  });

  it("shipping price only affects revenue base, not multiplied by qty", () => {
    const salesRow = { product_price: 1000, shipping_price: 500, quantity: 3 };
    const productData = { field_100: 800 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);

    // revenue = 1000 * 3 = 3000
    // base = 3000 + 500 = 3500
    // commission = 3500 * 0.10 = 350
    // tcogs = 800 * 3 = 2400
    // profit = 3500 - 350 - 2400 = 750
    assert.equal(result.revenue, 3000);
    assert.equal(result.shipping, 500);
    assert.equal(result.commission, 350);
    assert.equal(result.tcogs, 2400);
    assert.equal(result.profit, 750);
  });

  it("missing product_price → null revenue", () => {
    const salesRow = { shipping_price: 800, quantity: 1 };
    const productData = { field_100: 2000 };
    const result = computeMargin(salesRow, productData, rate, fieldIds);
    assert.equal(result.revenue, null);
    assert.equal(result.profit, null);
  });
});

// ── computeStockStatus ───────────────────────────────────────────────

describe("computeStockStatus", () => {
  it("owned stock covers order → owned_ok", () => {
    const result = computeStockStatus(10, 0, 2);
    assert.equal(result.status, "owned_ok");
    assert.equal(result.label, "Own Stock OK");
    assert.equal(result.ownedQty, 10);
    assert.equal(result.qtyAvailable, 0);
  });

  it("owned low, but supplier can fulfill → supplier_ok", () => {
    const result = computeStockStatus(1, 15, 3);
    assert.equal(result.status, "supplier_ok");
    assert.equal(result.label, "Supplier OK");
  });

  it("some owned stock but not enough → partial", () => {
    const result = computeStockStatus(1, 0, 5);
    assert.equal(result.status, "partial");
    assert.equal(result.label, "Partial Stock");
  });

  it("some available stock but not enough → partial", () => {
    const result = computeStockStatus(0, 2, 5);
    assert.equal(result.status, "partial");
  });

  it("no stock at all → needs_procurement", () => {
    const result = computeStockStatus(0, 0, 3);
    assert.equal(result.status, "needs_procurement");
    assert.equal(result.label, "Needs Procurement");
  });

  it("both null → unknown", () => {
    const result = computeStockStatus(null, null, 3);
    assert.equal(result.status, "unknown");
    assert.equal(result.label, "Stock Unknown");
    assert.equal(result.ownedQty, null);
    assert.equal(result.qtyAvailable, null);
  });

  it("owned exactly equal to qty → owned_ok", () => {
    const result = computeStockStatus(5, 0, 5);
    assert.equal(result.status, "owned_ok");
  });

  it("qtyAvailable exactly equal → supplier_ok (owned < qty)", () => {
    const result = computeStockStatus(2, 5, 5);
    assert.equal(result.status, "supplier_ok");
  });

  it("order qty = 0 → owned_ok if any stock", () => {
    const result = computeStockStatus(5, null, 0);
    assert.equal(result.status, "owned_ok");
  });
});

// ── assessRiskBadges ─────────────────────────────────────────────────

describe("assessRiskBadges", () => {
  it("no risks → empty array", () => {
    const salesRow = { review_status: { value: "Approved" } };
    const productData = { field_100: 2000 };
    const marginResult = { marginPercent: 25, hasTcogs: true };
    const stockResult = { status: "owned_ok" };
    const badges = assessRiskBadges(salesRow, productData, marginResult, stockResult);
    assert.equal(badges.length, 0);
  });

  it("locally cancelled → single locally_cancelled badge, no other risks", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Canceled" } },
      null,
      { marginPercent: -10, hasTcogs: false },
      { status: "needs_procurement" }
    );
    assert.equal(badges.length, 1);
    assert.equal(badges[0].type, "locally_cancelled");
    assert.equal(badges[0].severity, "critical");
  });

  it("negative margin → critical badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: 2000 },
      { marginPercent: -5, hasTcogs: true },
      { status: "owned_ok" }
    );
    const found = badges.find((b) => b.type === "negative_margin");
    assert.ok(found);
    assert.equal(found.severity, "critical");
  });

  it("low margin (5%) → warning badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: 2000 },
      { marginPercent: 5, hasTcogs: true },
      { status: "owned_ok" }
    );
    const found = badges.find((b) => b.type === "low_margin");
    assert.ok(found);
    assert.equal(found.severity, "warning");
  });

  it("stock shortage → critical badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: 2000 },
      { marginPercent: 20, hasTcogs: true },
      { status: "needs_procurement" }
    );
    const found = badges.find((b) => b.type === "stock_shortage");
    assert.ok(found);
    assert.equal(found.severity, "critical");
  });

  it("stock unknown → warning badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: 2000 },
      { marginPercent: 20, hasTcogs: true },
      { status: "unknown" }
    );
    const found = badges.find((b) => b.type === "stock_unknown");
    assert.ok(found);
    assert.equal(found.severity, "warning");
  });

  it("no product → warning badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      null,
      { marginPercent: null, hasTcogs: false },
      { status: "unknown" }
    );
    const found = badges.find((b) => b.type === "no_product");
    assert.ok(found);
  });

  it("product but no tcogs → no_tcogs badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: null },
      { marginPercent: null, hasTcogs: false },
      { status: "owned_ok" }
    );
    const found = badges.find((b) => b.type === "no_tcogs");
    assert.ok(found);
  });

  it("pending review → info badge", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Pending Review" } },
      { field_100: 2000 },
      { marginPercent: 25, hasTcogs: true },
      { status: "owned_ok" }
    );
    const found = badges.find((b) => b.type === "pending_review");
    assert.ok(found);
    assert.equal(found.severity, "info");
  });

  it("waiting for payment → waiting_payment badge (payment severity)", () => {
    const badges = assessRiskBadges(
      { order_status: { value: "WAITING_FOR_PAYMENT" }, review_status: { value: "Pending Review" } },
      { field_100: 2000 },
      { marginPercent: 25, hasTcogs: true },
      { status: "owned_ok" }
    );
    const found = badges.find((b) => b.type === "waiting_payment");
    assert.ok(found);
    assert.equal(found.severity, "payment");
    assert.equal(found.label, "Waiting for Payment");
    // Should NOT have pending_review badge
    const pendingFound = badges.find((b) => b.type === "pending_review");
    assert.ok(!pendingFound);
  });

  it("waiting for payment with other order_status → still shows pending_review", () => {
    const badges = assessRiskBadges(
      { order_status: { value: "WAITING_FOR_SHIPPING" }, review_status: { value: "Pending Review" } },
      { field_100: 2000 },
      { marginPercent: 25, hasTcogs: true },
      { status: "owned_ok" }
    );
    assert.ok(badges.find((b) => b.type === "pending_review"));
    assert.ok(!badges.find((b) => b.type === "waiting_payment"));
  });

  it("combined risks → sorted critical first", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Pending Review" } },
      null,
      { marginPercent: -5, hasTcogs: false },
      { status: "needs_procurement" }
    );
    // Should have: negative_margin (critical), stock_shortage (critical),
    // no_product (warning), pending_review (info) — in that order
    assert.equal(badges.length, 4);
    // First two must be critical
    assert.equal(badges[0].severity, "critical");
    assert.equal(badges[1].severity, "critical");
    // Third is warning
    assert.equal(badges[2].severity, "warning");
    // Fourth is info
    assert.equal(badges[3].severity, "info");
    // Verify specific badge types
    const types = badges.map((b) => b.type);
    assert.ok(types.includes("negative_margin"));
    assert.ok(types.includes("stock_shortage"));
    assert.ok(types.includes("no_product"));
    assert.ok(types.includes("pending_review"));
  });

  it("combined risks with waiting payment → payment sort last", () => {
    const badges = assessRiskBadges(
      { order_status: { value: "WAITING_FOR_PAYMENT" }, review_status: { value: "Pending Review" } },
      null,
      { marginPercent: -5, hasTcogs: false },
      { status: "needs_procurement" }
    );
    // Should have: negative_margin (critical), stock_shortage (critical),
    // no_product (warning), waiting_payment (payment) — no pending_review
    assert.equal(badges.length, 4);
    assert.equal(badges[0].severity, "critical");
    assert.equal(badges[1].severity, "critical");
    assert.equal(badges[2].severity, "warning");
    assert.equal(badges[3].severity, "payment");
    const types = badges.map((b) => b.type);
    assert.ok(types.includes("waiting_payment"));
    assert.ok(!types.includes("pending_review"));
  });

  it("marginPercent 0 → low_margin (edge case)", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: 2000 },
      { marginPercent: 0, hasTcogs: true },
      { status: "owned_ok" }
    );
    // 0 >= 0 and 0 < 10 → low_margin
    const found = badges.find((b) => b.type === "low_margin");
    assert.ok(found);
  });

  it("marginPercent exactly 10 → not flagged", () => {
    const badges = assessRiskBadges(
      { review_status: { value: "Approved" } },
      { field_100: 2000 },
      { marginPercent: 10, hasTcogs: true },
      { status: "owned_ok" }
    );
    const found = badges.find((b) => b.type === "low_margin");
    assert.equal(found, undefined);
  });
});

// ── findFieldId ──────────────────────────────────────────────────────

describe("findFieldId", () => {
  const map = new Map([
    ["Gigab2b Item Code", 101],
    ["Unit Price", 102],
    ["Owned Qty", 103],
  ]);

  it("exact match → returns ID", () => {
    assert.equal(findFieldId(map, ["Gigab2b Item Code"]), 101);
  });

  it("no match → returns 0", () => {
    assert.equal(findFieldId(map, ["Nonexistent Field"]), 0);
  });

  it("matches first candidate in order", () => {
    assert.equal(findFieldId(map, ["Owned Qty", "Unit Price"]), 103);
  });

  it("empty map → returns 0", () => {
    assert.equal(findFieldId(new Map(), ["Anything"]), 0);
  });
});

// ── readSelectValue ──────────────────────────────────────────────────

describe("readSelectValue", () => {
  it("object with .value → extracts value", () => {
    assert.equal(readSelectValue({ id: 1, value: "Approved", color: "green" }), "Approved");
  });

  it("plain string → pass-through", () => {
    assert.equal(readSelectValue("Pending Review"), "Pending Review");
  });

  it("null → empty string", () => {
    assert.equal(readSelectValue(null), "");
  });

  it("undefined → empty string", () => {
    assert.equal(readSelectValue(undefined), "");
  });

  it("empty object → empty string", () => {
    assert.equal(readSelectValue({}), "");
  });

  it("object with .name but no .value → returns .name", () => {
    assert.equal(readSelectValue({ id: 1, name: "foo" }), "foo");
  });
});

// ── createRakutenItemCodeResolver ─────────────────────────────────────

/**
 * Build a minimal mock Supabase client for createRakutenItemCodeResolver.
 *
 * @param {Array|null} listings - first query result (platform_listings)
 * @param {Array|null} links - second query result (product_platform_links)
 * @param {boolean} throwError - if true, throw on first query
 */
function mockRakutenResolverClient({ listings = null, links = null, throwError = false } = {}) {
  let step = 0;
  const calls = [];
  const createQueryChain = (result) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      range: () => chain,
      then: undefined,
    };
    // When awaited, the chain resolves to the result
    // We use a thenable so `await query` works
    return Object.assign(chain, {
      then(resolve, reject) {
        if (throwError && step === 0) {
          step++;
          return reject ? reject(new Error("connection refused")) : undefined;
        }
        step++;
        // Real Supabase returns { data, error } — match that contract
        const wrapped = { data: result, error: null };
        return resolve ? resolve(wrapped) : undefined;
      },
    });
  };

  const results = [listings, links];
  return {
    calls,
    supabase: {
      from: (table) => {
        calls.push(table);
        const idx = table === "platform_listings" ? 0 : 1;
        return createQueryChain(results[idx]);
      },
    },
  };
}

describe("createRakutenItemCodeResolver", () => {
  it("returns a function", () => {
    const resolver = createRakutenItemCodeResolver(mockRakutenResolverClient());
    assert.equal(typeof resolver, "function");
  });

  it("rejects empty manage_number", async () => {
    const resolver = createRakutenItemCodeResolver(mockRakutenResolverClient());
    const result = await resolver("");
    assert.equal(result.resolved, false);
    assert.equal(result.reason, "empty_manage_number");
  });

  it("resolves manage_number to item_code via mapping", async () => {
    const client = mockRakutenResolverClient({
      listings: [{ id: "ce9e3524-6905-40f4-ae32-340b8adfdd60", manage_number: "sofabd-n511p407695" }],
      links: [{
        listing_id: "ce9e3524-6905-40f4-ae32-340b8adfdd60",
        product_variants: { item_code: "N511P407695W" },
      }],
    });
    const resolver = createRakutenItemCodeResolver(client);
    const result = await resolver("sofabd-n511p407695");
    assert.equal(result.resolved, true);
    assert.equal(result.code, "N511P407695W");
  });

  it("returns no_mapping_found when listing not found", async () => {
    const client = mockRakutenResolverClient({ listings: [] });
    const resolver = createRakutenItemCodeResolver(client);
    const result = await resolver("nonexistent-manage-number");
    assert.equal(result.resolved, false);
    assert.equal(result.reason, "no_mapping_found");
  });

  it("handles query errors gracefully", async () => {
    const client = mockRakutenResolverClient({ throwError: true });
    const resolver = createRakutenItemCodeResolver(client);
    const result = await resolver("sofabd-n511p407695");
    assert.equal(result.resolved, false);
    assert.equal(result.reason, "query_error");
  });

  it("fails closed when a manage_number maps to multiple item codes", async () => {
    const listingId = "listing-1";
    const resolver = createRakutenItemCodeResolver(mockRakutenResolverClient({
      listings: [{ id: listingId, manage_number: "sofabd-n511p407695" }],
      links: [
        { listing_id: listingId, product_variants: { item_code: "N511P407695W" } },
        { listing_id: listingId, product_variants: { item_code: "N511P407695B" } },
      ],
    }));

    assert.deepEqual(await resolver("sofabd-n511p407695"), {
      resolved: false,
      code: null,
      reason: "ambiguous_mapping",
    });
  });

  it("does not guess a variant from a color word in product_name", async () => {
    const listingId = "listing-color";
    const resolver = createRakutenItemCodeResolver(mockRakutenResolverClient({
      listings: [{ id: listingId, manage_number: "sofabd-n511p407695" }],
      links: [
        {
          listing_id: listingId,
          product_variants: {
            item_code: "N511P407695B",
            raw_payload: { representative_color_ja: "ブラック" },
          },
        },
        {
          listing_id: listingId,
          product_variants: {
            item_code: "N511P407695W",
            raw_payload: { representative_color_ja: "ホワイト" },
          },
        },
      ],
    }));

    assert.deepEqual(await resolver("sofabd-n511p407695", "コンパクトソファ ホワイト"), {
      resolved: false,
      code: null,
      reason: "ambiguous_mapping",
    });
  });

  it("keeps color mappings ambiguous when no candidate color matches", async () => {
    const listingId = "listing-no-color-match";
    const resolver = createRakutenItemCodeResolver(mockRakutenResolverClient({
      listings: [{ id: listingId, manage_number: "manage-color" }],
      links: [
        { listing_id: listingId, product_variants: { item_code: "ITEM-B", raw_payload: { representative_color_ja: "ブラック" } } },
        { listing_id: listingId, product_variants: { item_code: "ITEM-W", raw_payload: { representative_color_ja: "ホワイト" } } },
      ],
    }));

    assert.equal((await resolver("manage-color", "コンパクトソファ グレー")).reason, "ambiguous_mapping");
  });

  it("keeps color mappings ambiguous when multiple candidate colors match", async () => {
    const listingId = "listing-multi-color-match";
    const resolver = createRakutenItemCodeResolver(mockRakutenResolverClient({
      listings: [{ id: listingId, manage_number: "manage-color" }],
      links: [
        { listing_id: listingId, product_variants: { item_code: "ITEM-B", raw_payload: { representative_color_ja: "ブラック" } } },
        { listing_id: listingId, product_variants: { item_code: "ITEM-W", raw_payload: { representative_color_ja: "ホワイト" } } },
      ],
    }));

    assert.equal((await resolver("manage-color", "ホワイト / ブラック")).reason, "ambiguous_mapping");
  });

  it("batch-resolves deduplicated manage_numbers with two queries", async () => {
    const client = mockRakutenResolverClient({
      listings: [
        { id: "listing-1", manage_number: "manage-1" },
        { id: "listing-2", manage_number: "manage-2" },
      ],
      links: [
        { listing_id: "listing-1", product_variants: { item_code: "ITEM-1" } },
        { listing_id: "listing-2", product_variants: { item_code: "ITEM-2" } },
      ],
    });

    const results = await createRakutenItemCodeBatchResolver(client)(["manage-1", "manage-1", "manage-2"]);
    assert.equal(results.get("manage-1").code, "ITEM-1");
    assert.equal(results.get("manage-2").code, "ITEM-2");
    assert.deepEqual(client.calls, ["platform_listings", "product_platform_links"]);
  });

  it("paginates beyond 1,000 links before deciding whether a mapping is unique", async () => {
    const listingId = "listing-many";
    const links = Array.from({ length: 1001 }, (_, index) => ({
      id: `link-${String(index).padStart(4, "0")}`,
      listing_id: listingId,
      product_variants: { item_code: index === 1000 ? "ITEM-B" : "ITEM-W" },
    }));
    const ranges = [];
    const supabase = {
      from(table) {
        let from = 0;
        let to = 999;
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          range(start, end) {
            from = start;
            to = end;
            if (table === "product_platform_links") ranges.push([start, end]);
            return chain;
          },
          then(resolve) {
            const rows = table === "platform_listings"
              ? [{ id: listingId, manage_number: "manage-many" }]
              : links.slice(from, to + 1);
            return resolve({ data: rows, error: null });
          },
        };
        return chain;
      },
    };

    const results = await createRakutenItemCodeBatchResolver({ supabase })(["manage-many"]);
    assert.deepEqual(results.get("manage-many"), {
      resolved: false,
      code: null,
      reason: "ambiguous_mapping",
    });
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
  });
});

// ── mercariResolveItemCode ────────────────────────────────────────────

describe("mercariResolveItemCode", () => {
  it("passes through a normal SKU", () => {
    assert.deepStrictEqual(mercariResolveItemCode("N511P407695W"), {
      resolved: true, code: "N511P407695W", reason: null,
    });
  });

  it("rejects RP-prefixed fee-adjustment SKUs", () => {
    assert.deepStrictEqual(mercariResolveItemCode("RP123"), {
      resolved: false, code: null, reason: "rp_fee_adjustment",
    });
    assert.deepStrictEqual(mercariResolveItemCode("rp456"), {
      resolved: false, code: null, reason: "rp_fee_adjustment",
    });
  });

  it("rejects SKUs containing hyphens as ambiguous", () => {
    assert.deepStrictEqual(mercariResolveItemCode("ABC-123"), {
      resolved: false, code: null, reason: "ambiguous_hyphen",
    });
  });

  it("returns empty_sku for blank input", () => {
    assert.deepStrictEqual(mercariResolveItemCode(""), {
      resolved: false, code: null, reason: "empty_sku",
    });
    assert.deepStrictEqual(mercariResolveItemCode("  "), {
      resolved: false, code: null, reason: "empty_sku",
    });
  });
});
