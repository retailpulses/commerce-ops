import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeOrderEconomics, lineTcogs } from "../product-resolver.mjs";
import { buildPortalTargetId, parsePortalTargetId, resolveBulkOrderTargets, selectMarketplaceAnchor } from "../portal/handlers.mjs";
import { allocateLineCommercialValues } from "../line-allocation.mjs";
import { isComponentRow } from "../portal/shared.mjs";
import { groupPortalOrderRows } from "../portal/order-list.mjs";
import { isOperatorComponentRow } from "../../../scripts/sync_mercari_sales_orders_multi_shop_2026_04_01.mjs";

// Product cache uses field_${id} pseudo keys (mirrors resolveProductsByItemCodes).
const F = { effectiveTcogsFieldId: 2 };
function product(tcogs) {
  return tcogs == null ? null : { field_2: String(tcogs) };
}

describe("computeOrderEconomics", () => {
  const commissionRate = 0.10;

  it("matches the spec example: 37375 revenue, TCOGS 7201x1 + 7201x1 + 7001x2", () => {
    const anchor = { id: "anchor", product_price: 37375, shipping_price: 0, quantity: 1, B2BItemCode: "" };
    const lines = [
      { id: "anchor", B2BItemCode: "", quantity: 1, product_price: 37375, shipping_price: 0 },
      { id: "c1", B2BItemCode: "A", quantity: 1 },
      { id: "c2", B2BItemCode: "B", quantity: 1 },
      { id: "c3", B2BItemCode: "C", quantity: 2 },
    ];
    const cache = new Map([["A", product(7201)], ["B", product(7201)], ["C", product(7001)]]);
    const econ = computeOrderEconomics(anchor, lines, cache, F, commissionRate);

    assert.equal(econ.revenue, 37375);
    assert.equal(econ.shipping, 0);
    assert.equal(econ.commission, 3737.5);
    assert.equal(econ.tcogs, 28404);
    assert.equal(econ.profit, 5233.5);
    assert.equal(econ.marginPercent, 14.0);
    assert.equal(econ.hasTcogs, true);
  });

  it("treats lines without product/TCOGS data as zero contribution", () => {
    const anchor = { id: "a", product_price: 1000, shipping_price: 0, quantity: 1, B2BItemCode: "" };
    const lines = [
      { id: "a", B2BItemCode: "", quantity: 1 },
      { id: "c1", B2BItemCode: "A", quantity: 1 },
    ];
    const cache = new Map([["A", product(500)]]);
    const econ = computeOrderEconomics(anchor, lines, cache, F, 0.1);
    assert.equal(econ.tcogs, 500);
    assert.equal(econ.commission, 100);
    assert.equal(econ.profit, 400);
  });

  it("returns null profit/margin when no line has TCOGS data", () => {
    const anchor = { id: "a", product_price: 1000, shipping_price: 0, quantity: 1, B2BItemCode: "" };
    const econ = computeOrderEconomics(anchor, [anchor], new Map(), F, 0.1);
    assert.equal(econ.hasTcogs, false);
    assert.equal(econ.profit, null);
    assert.equal(econ.marginPercent, null);
  });
});

describe("lineTcogs", () => {
  it("is quantity-aware", () => {
    assert.equal(lineTcogs({ B2BItemCode: "A", quantity: 3 }, new Map([["A", product(7001)]]), F), 21003);
  });
  it("returns null when product missing", () => {
    assert.equal(lineTcogs({ B2BItemCode: "A", quantity: 3 }, new Map(), F), null);
  });
});

describe("allocateLineCommercialValues", () => {
  it("allocates the example exactly and preserves the total", () => {
    const result = allocateLineCommercialValues(37375, [
      { qty: 1, tcogs: 7201 },
      { qty: 1, tcogs: 7201 },
      { qty: 2, tcogs: 7001 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.total, 37375);
    assert.deepEqual(result.lines.map((l) => l.lineTotal), [9475.35, 9475.33, 18424.32]);
    assert.equal(result.lines.reduce((s, l) => s + l.lineTotal, 0), 37375);
    assert.deepEqual(result.lines.map((l) => l.unitPrice), [9475.35, 9475.33, 9212.16]);
    // unit price × qty also sums to the total for this example
    assert.equal(result.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0), 37375);
  });

  it("preserves the total with a non-integer (cents) price", () => {
    const result = allocateLineCommercialValues(1000.5, [
      { qty: 1, tcogs: 100 },
      { qty: 1, tcogs: 100 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.total, 1000.5);
    assert.equal(result.lines[0].lineTotal + result.lines[1].lineTotal, 1000.5);
  });

  it("never emits a zero unit price for a component line", () => {
    const result = allocateLineCommercialValues(100, [
      { qty: 1, tcogs: 1 },
      { qty: 1, tcogs: 999 },
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.lines.every((l) => l.unitPrice > 0));
  });

  it("fails closed when cost data is missing", () => {
    const result = allocateLineCommercialValues(37375, [
      { qty: 1, tcogs: 7201 },
      { qty: 1, tcogs: null },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "allocation_cost_data_missing");
  });

  it("fails closed when there are no lines", () => {
    assert.equal(allocateLineCommercialValues(100, []).ok, false);
  });
});

describe("isComponentRow", () => {
  it("detects operator_component rows", () => {
    assert.equal(isComponentRow({ line_origin: "operator_component" }), true);
    assert.equal(isComponentRow({ line_origin: "marketplace" }), false);
    assert.equal(isComponentRow({}), false);
  });
});

describe("order ownership and grouping", () => {
  it("always selects the marketplace row as the order anchor", () => {
    assert.equal(selectMarketplaceAnchor([
      { id: "component", line_origin: "operator_component" },
      { id: "anchor", line_origin: "marketplace" },
    ]).id, "anchor");
  });
  it("fails closed when one order id resolves to multiple marketplace scopes", () => {
    assert.throws(() => selectMarketplaceAnchor([
      { id: "shop-1", sales_channel: "mercari", source_store_id: "one", line_origin: "marketplace" },
      { id: "shop-2", sales_channel: "mercari", source_store_id: "two", line_origin: "marketplace" },
    ]), /ambiguous_order_scope/);
  });
  it("round-trips a scoped Portal target without changing the business order id", () => {
    const targetId = buildPortalTargetId({ sales_channel: "Mercari", source_store_id: "Shop:A", order_id: "order:A|B" });
    assert.deepEqual(parsePortalTargetId(targetId), {
      channel: "mercari",
      storeId: "shop:a",
      orderId: "order:A|B",
    });
  });
  it("requires scoped values in the new bulk order_targets contract", () => {
    const scoped = buildPortalTargetId({ sales_channel: "mercari", source_store_id: "shop-1", order_id: "same" });
    assert.deepEqual(resolveBulkOrderTargets({ order_targets: [scoped] }), { ok: true, targets: [scoped] });
    assert.deepEqual(resolveBulkOrderTargets({ order_targets: ["same"] }), { ok: false, targets: [] });
    assert.deepEqual(resolveBulkOrderTargets({ order_ids: ["legacy"] }), { ok: true, targets: ["legacy"] });
  });
  it("protects operator components from marketplace stale cleanup", () => {
    assert.equal(isOperatorComponentRow({ line_origin: "operator_component" }), true);
    assert.equal(isOperatorComponentRow({ line_origin: "marketplace" }), false);
  });

  it("groups rows by channel, store and normalized order id", () => {
    const rows = [
      { id: "a", sales_channel: "Mercari", source_store_id: "shop", order_id: " X ", line_origin: "marketplace" },
      { id: "b", sales_channel: "mercari", source_store_id: "SHOP", order_id: "x", line_origin: "operator_component" },
      { id: "c", sales_channel: "mercari", source_store_id: "other", order_id: "x", line_origin: "marketplace" },
    ];
    const grouped = groupPortalOrderRows(rows);
    assert.equal(grouped.length, 2);
    assert.equal(grouped.find((row) => row.id === "a").__order_lines.length, 2);
  });
});
