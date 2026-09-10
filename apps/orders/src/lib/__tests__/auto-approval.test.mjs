import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";

import { evaluateRule, evaluateOrderRules, filterAutoApprovalScope, getAutoApprovalRules, resolveShopLabel, sendAutoApprovalMessage, isExcludedShippingState, isWithinWorkingHours, autoApproveMercariOrders, groupOrderRowsByScope, selectAutoApprovalOrderScopes } from "../auto-approval.mjs";
import { getJstDateParts } from "../timezone.mjs";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSalesRow(overrides = {}) {
  return {
    id: 1,
    order_id: "test-order-001",
    product_name: "Test Product",
    original_product_id: "SKU001",
    B2BItemCode: "B2B001",
    product_price: "3000",
    quantity: "2",
    shipping_price: "500",
    review_status: { value: "Pending Review" },
    order_status: { value: "WAITING_FOR_SHIPPING" },
    order_comments: "",
    ...overrides,
  };
}

function makeProductData(overrides = {}) {
  return {
    id: 100,
    field_10: 0,    // ownedQty
    field_20: 3,    // qtyAvailable
    field_30: 1800, // effectiveTcogs
    ...overrides,
  };
}

it("groups identical order IDs separately by source store", () => {
  const groups = groupOrderRowsByScope([
    makeSalesRow({ id: 1, order_id: "same-order", source_store_id: "shop-a" }),
    makeSalesRow({ id: 2, order_id: "same-order", source_store_id: "shop-b" }),
    makeSalesRow({ id: 3, order_id: "same-order", source_store_id: "shop-a" }),
  ]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("shop-a::same-order").rows.length, 2);
  assert.equal(groups.get("shop-b::same-order").rows.length, 1);
});

it("filters an auto-approval canary by exact store and normalized order before limiting", () => {
  const rows = [
    makeSalesRow({ id: 1, order_id: "order_neighbor", source_store_id: "shop-a" }),
    makeSalesRow({ id: 2, order_id: "order_target", source_store_id: "shop-b" }),
    makeSalesRow({ id: 3, order_id: "target", source_store_id: "shop-a" }),
    makeSalesRow({ id: 4, order_id: "target", source_store_id: "shop-b" }),
  ];
  assert.deepEqual(filterAutoApprovalScope(rows, { orderId: "order_target", sourceStoreId: "shop-b" }).map((row) => row.id), [2, 4]);
  assert.deepEqual(filterAutoApprovalScope(rows, { orderId: "", sourceStoreId: "shop-b" }), []);
});

it("keeps every auto-approval candidate for the canonical null live limit", () => {
  const candidates = Array.from({ length: 61 }, (_, index) => ({ orderId: `order-${index + 1}` }));
  assert.equal(selectAutoApprovalOrderScopes(candidates, null).length, 61);
  assert.equal(selectAutoApprovalOrderScopes(candidates, 1).length, 1);
  assert.equal(selectAutoApprovalOrderScopes(candidates, undefined).length, 50);
});

const productFields = {
  ownedQtyFieldId: 10,
  qtyAvailableFieldId: 20,
  effectiveTcogsFieldId: 30,
  itemCodeFieldId: 40,
};

const commissionRate = 0.10;

const rule = {
  name: "low_stock_good_margin",
  enabled: true,
  paymentDateGate: false,
  thresholds: { maxOwnedQty: 0, maxQtyAvailable: 5, minMarginPercent: 8 },
};

const ruleStandard = {
  name: "standard_order_approval",
  enabled: true,
  thresholds: { minMarginPercent: 11 },
};

/**
 * Build an ISO date string representing midnight JST on (today + offsetDays).
 * Uses getJstDateParts for deterministic JST date computation.
 * offsetDays = -1 → yesterday JST, 0 → today JST, +1 → tomorrow JST.
 */
function jstPaymentDate(offsetDays) {
  const { year, month, day } = getJstDateParts(new Date());
  // Midnight JST = 15:00 UTC previous calendar day
  const utc = new Date(Date.UTC(year, month - 1, day + offsetDays - 1, 15, 0, 0));
  return utc.toISOString();
}

// ── evaluateRule ─────────────────────────────────────────────────────

describe("evaluateRule", () => {
  it("passes when all conditions are met", () => {
    const salesRow = makeSalesRow({ quantity: "2" });
    const productData = makeProductData();
    // ownedQty=0, qtyAvailable=3 >= qty=2, qtyAvailable=3 <= 5
    // margin: revenue=3000*2=6000, shipping=500, base=6500, comm=650,
    //   tcogs=1800*2=3600, profit=6500-650-3600=2250, margin=2250/6500*100=34.62%
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, true);
    assert.ok(result.reason.includes("margin="));
  });

  it("fails when ownedQty > 0", () => {
    const salesRow = makeSalesRow();
    const productData = makeProductData({ field_10: 1 }); // ownedQty=1
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("owned_qty=1"));
  });

  it("fails when qtyAvailable > threshold", () => {
    const salesRow = makeSalesRow({ quantity: "1" });
    const productData = makeProductData({ field_20: 10 }); // qtyAvailable=10
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("qty_available=10"));
  });

  it("fails when qtyAvailable < order quantity (cannot fulfill)", () => {
    const salesRow = makeSalesRow({ quantity: "5" });
    const productData = makeProductData({ field_20: 2 }); // only 2 available
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("need >= order_qty=5"));
  });

  it("fails when marginPercent < 8%", () => {
    const salesRow = makeSalesRow({ product_price: "2500", quantity: "1" });
    // TCOGS=2400, margin ≈ (2500+500-290-2400)/(3000) = 310/3000 ≈ 10.3% ... needs higher tcogs
    // Let's use a high TCOGS that results in low margin
    const productData = makeProductData({ field_30: 2700 }); // tcogs=2700
    // revenue=2500, shipping=500, base=3000, comm=300, tcogs=2700, profit=3000-300-2700=0, margin=0%
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("margin="));
  });

  it("fails when productData is null (no margin data)", () => {
    const salesRow = makeSalesRow();
    const result = evaluateRule(salesRow, null, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("missing_owned_qty"));
  });

  it("fails when ownedQty is null on product", () => {
    const salesRow = makeSalesRow();
    const productData = makeProductData({ field_10: undefined }); // no owned qty
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "missing_owned_qty");
  });

  it("fails when qtyAvailable is null on product", () => {
    const salesRow = makeSalesRow();
    const productData = makeProductData({ field_20: undefined }); // no qty available
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "missing_qty_available");
  });

  it("fails when TCOGS is missing (margin null)", () => {
    const salesRow = makeSalesRow();
    const productData = makeProductData({ field_30: undefined }); // no TCOGS
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "margin_unavailable (missing TCOGS or price)");
  });

  // ── Boundary cases ──

  it("passes at boundary: ownedQty=0, qtyAvailable=5, margin=8%", () => {
    const salesRow = makeSalesRow({ product_price: "2000", quantity: "1" });
    // Need margin ≈ 8%: revenue=2000, shipping=500, base=2500, comm=250
    // profit=2500-250-tcogs → margin=profit/2500*100=8% → profit=200 → tcogs=2500-250-200=2050
    const productData = makeProductData({ field_10: 0, field_20: 5, field_30: 2050 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, true);
  });

  it("fails at boundary: qtyAvailable=6, margin=8%", () => {
    const salesRow = makeSalesRow({ product_price: "2000", quantity: "1" });
    const productData = makeProductData({ field_10: 0, field_20: 6, field_30: 2050 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("qty_available=6"));
  });

  it("passes when ownedQty=0 (maxOwnedQty=0 boundary)", () => {
    const salesRow = makeSalesRow({ quantity: "1" });
    const productData = makeProductData({ field_10: 0, field_20: 3, field_30: 1800 });
    // margin: revenue=3000, shipping=500, base=3500, comm=350, tcogs=1800, profit=1350, margin≈38.6%
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, true);
  });

  // ── standard_order_approval rule (no stock constraints) ──

  it("standard_order_approval passes with margin >= 11%, WAITING_FOR_SHIPPING, purchase_date yesterday", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1), // yesterday or earlier
    });
    const productData = makeProductData({ field_30: 1800 });
    // margin: 3000+500-350-1800=1350, margin%=1350/3500*100=38.6%, >= 11
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval fails when margin < 11%", () => {
    const salesRow = makeSalesRow({
      product_price: "2000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_30: 2400 });
    // margin: 2000+500-250-2400=-150, margin%=-150/2500*100=-6%, < 11
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("margin="));
  });

  it("standard_order_approval fails when purchase_date is missing", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: "",
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "purchase_date_not_eligible");
  });

  it("standard_order_approval passes even when ownedQty > 0 (no stock constraints)", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_10: 99, field_30: 1800 }); // ownedQty=99
    // margin still 38.6%, owned qty should be ignored by this rule
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval passes even when qtyAvailable > any limit (no stock constraints)", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_20: 999, field_30: 1800 }); // qtyAvailable=999
    // margin still 38.6%, qtyAvailable should be ignored by this rule
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  // ── standard_order_approval date boundary tests (deterministic JST) ──

  it("standard_order_approval date: yesterday (before today JST) passes", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval date: today (JST) fails", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(0),
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "purchase_date_not_eligible");
  });

  it("standard_order_approval date: future date fails", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(1),
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "purchase_date_not_eligible");
  });

  it("standard_order_approval date: invalid date string fails", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: "not-a-valid-date",
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "purchase_date_not_eligible");
  });

  // ── standard_order_approval margin boundary tests ──

  it("standard_order_approval margin: exactly 11.00% passes boundary", () => {
    // base=2500, comm=250, profit=275 → tcogs=1975 → margin=11.00%
    const salesRow = makeSalesRow({
      product_price: "2000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_30: 1975 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval margin: 10.99% fails below threshold", () => {
    // base=2500, comm=250, profit=274.75 → tcogs=1975.25 → margin=10.99%
    const salesRow = makeSalesRow({
      product_price: "2000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_30: 1975.25 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.ok(result.reason.includes("margin="));
  });

  // ── Acceptance: standard_order_approval gate tests ──

  it("standard_order_approval: null payment_date, WAITING_FOR_SHIPPING, purchase_date yesterday, margin >= 11% passes", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      payment_date: null,
      purchase_date: jstPaymentDate(-1),
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval: non-WAITING_FOR_SHIPPING order_status fails", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: { value: "PENDING" },
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "order_status_not_waiting_for_shipping");
  });

  // ── Status comparison robustness tests ─────────────────────

  it("standard_order_approval: accepts plain string WAITING_FOR_SHIPPING", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: "WAITING_FOR_SHIPPING",
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval: accepts object value WAITING_FOR_SHIPPING", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: { value: "WAITING_FOR_SHIPPING" },
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, true);
  });

  it("standard_order_approval: fails for WAITING_FOR_PAYMENT status", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: { value: "WAITING_FOR_PAYMENT" },
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "order_status_not_waiting_for_shipping");
  });

  it("standard_order_approval: fails for COMPLETED status", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: { value: "COMPLETED" },
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "order_status_not_waiting_for_shipping");
  });

  it("standard_order_approval: fails for CANCELED status", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: { value: "CANCELED" },
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "order_status_not_waiting_for_shipping");
  });

  it("standard_order_approval: fails for null order_status", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      purchase_date: jstPaymentDate(-1),
      order_status: null,
    });
    const productData = makeProductData({ field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, ruleStandard);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "order_status_not_waiting_for_shipping");
  });

  it("low_stock_good_margin still passes independently of standard_order_approval gate", () => {
    const salesRow = makeSalesRow({
      product_price: "3000",
      quantity: "1",
      payment_date: null,
      purchase_date: "",
    });
    const productData = makeProductData({ field_10: 0, field_20: 3, field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, rule);
    assert.equal(result.passed, true);
  });

  it("low_stock_good_margin with paymentDateGate:true still checks payment_date as custom rule", () => {
    const paymentDateGateRule = {
      name: "my_custom_rule",
      enabled: true,
      paymentDateGate: true,
      thresholds: { maxOwnedQty: 0, maxQtyAvailable: 5, minMarginPercent: 8 },
    };
    const salesRow = makeSalesRow({
      quantity: "1",
      payment_date: null,
    });
    const productData = makeProductData({ field_10: 0, field_20: 3, field_30: 1800 });
    const result = evaluateRule(salesRow, productData, productFields, commissionRate, paymentDateGateRule);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "payment_date_not_eligible");
  });
});

// ── evaluateOrderRules ───────────────────────────────────────────────

describe("evaluateOrderRules", () => {
  const rules = [rule]; // enabled rule
  const bothRules = [rule, ruleStandard]; // both enabled rules

  it("passes for a single-line order that meets all conditions", () => {
    const rows = [makeSalesRow({ quantity: "1" })];
    const cache = new Map([["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it("passes for a multi-line order where all lines pass", () => {
    const rows = [
      makeSalesRow({ id: 1, order_id: "order-1", B2BItemCode: "B2B001", quantity: "1" }),
      makeSalesRow({ id: 2, order_id: "order-1", B2BItemCode: "B2B002", quantity: "1" }),
    ];
    const cache = new Map([
      ["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })],
      ["B2B002", makeProductData({ field_10: 0, field_20: 4, field_30: 1500 })],
    ]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it("fails for a multi-line order where one line fails (order-level gate)", () => {
    const rows = [
      makeSalesRow({ id: 1, order_id: "order-1", B2BItemCode: "B2B001", quantity: "1" }),
      makeSalesRow({ id: 2, order_id: "order-1", B2BItemCode: "B2B002", quantity: "10" }),
    ];
    const cache = new Map([
      ["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })],
      ["B2B002", makeProductData({ field_10: 0, field_20: 2, field_30: 1500 })], // only 2 available, need 10
    ]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
    assert.equal(
      result.failures[0].reason,
      "insufficient_stock: owned_qty=0, qty_available=2, need either >= order_qty=10",
    );
  });

  it("excludes fee rows from evaluation", () => {
    const rows = [
      makeSalesRow({ id: 1, B2BItemCode: "B2B001", quantity: "1" }),
      makeSalesRow({ id: 2, product_name: "各種手数料", B2BItemCode: "", quantity: "1" }),
    ];
    const cache = new Map([["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it("fails when B2BItemCode is empty (cannot resolve product)", () => {
    const rows = [makeSalesRow({ B2BItemCode: "" })];
    const cache = new Map();
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, false);
    assert.equal(result.failures[0].reason, "missing_b2b_item_code");
  });

  it("fails when product is not found in cache", () => {
    const rows = [makeSalesRow({ B2BItemCode: "NONEXISTENT" })];
    const cache = new Map();
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, false);
    assert.equal(result.failures[0].reason, "product_not_found");
  });

  it("returns passed=true when no enabled rules", () => {
    const rows = [makeSalesRow()];
    const cache = new Map();
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, []);
    assert.equal(result.passed, true);
  });

  it("passes when owned stock covers the order and supplier quantity is zero", () => {
    const rows = [makeSalesRow({
      quantity: "2",
      purchase_date: jstPaymentDate(-1),
    })];
    const cache = new Map([["B2B001", makeProductData({ field_10: 2, field_20: 0 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, [ruleStandard]);
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it("fails when only combined partial stock would cover the order", () => {
    const rows = [makeSalesRow({
      quantity: "3",
      purchase_date: jstPaymentDate(-1),
    })];
    const cache = new Map([["B2B001", makeProductData({ field_10: 1, field_20: 2 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, [ruleStandard]);
    assert.equal(result.passed, false);
    assert.equal(
      result.failures[0].reason,
      "insufficient_stock: owned_qty=1, qty_available=2, need either >= order_qty=3",
    );
  });

  it("fails before OR rule evaluation when neither stock source covers the order", () => {
    const rows = [makeSalesRow({
      quantity: "3",
      purchase_date: jstPaymentDate(-1),
    })];
    const cache = new Map([["B2B001", makeProductData({ field_10: 1, field_20: 1 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, bothRules);
    assert.equal(result.passed, false);
    assert.equal(
      result.failures[0].reason,
      "insufficient_stock: owned_qty=1, qty_available=1, need either >= order_qty=3",
    );
  });

  it("fails closed when stock data is missing", () => {
    const rows = [makeSalesRow({ purchase_date: jstPaymentDate(-1) })];
    const cache = new Map([["B2B001", makeProductData({ field_20: undefined })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, [ruleStandard]);
    assert.equal(result.passed, false);
    assert.equal(result.failures[0].reason, "missing_stock_data: qty_available");
  });

  it("passes when owned stock covers the order even if supplier stock data is missing", () => {
    const rows = [makeSalesRow({
      quantity: "2",
      purchase_date: jstPaymentDate(-1),
    })];
    const cache = new Map([["B2B001", makeProductData({ field_10: 2, field_20: undefined })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, [ruleStandard]);
    assert.equal(result.passed, true);
  });

  it("adds fee exclusion line and treats as additional payment", () => {
    const rows = [
      makeSalesRow({ id: 1, B2BItemCode: "B2B001", quantity: "1" }),
      makeSalesRow({ id: 2, product_name: "追加支払い・追加送料専用", B2BItemCode: "", quantity: "1" }),
    ];
    const cache = new Map([["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, rules);
    assert.equal(result.passed, true);
  });

  // ── OR semantics tests ──

  it("OR: passes when first rule fails but second rule passes (high ownedQty, good margin, prior purchase)", () => {
    const orRules = [rule, ruleStandard];
    const rows = [makeSalesRow({
      quantity: "1",
      product_price: "3000",
      purchase_date: jstPaymentDate(-1),
    })];
    // ownedQty=99 fails low_stock maxOwnedQty=0, but standard_order_approval has no stock constraint and margin >= 11
    const cache = new Map([["B2B001", makeProductData({ field_10: 99, field_20: 3, field_30: 1800 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, orRules);
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it("OR: fails when both rules fail (low margin, no purchase_date)", () => {
    const orRules = [rule, ruleStandard];
    const rows = [makeSalesRow({
      quantity: "1",
      product_price: "2000",
      purchase_date: "",
    })];
    // low_stock fails: margin too low. standard_order_approval fails: no purchase_date.
    const cache = new Map([["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 2400 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, orRules);
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
  });

  it("OR: first rule passes immediately, second rule ignored", () => {
    const orRules = [rule, ruleStandard];
    const rows = [makeSalesRow({
      quantity: "1",
      product_price: "3000",
    })];
    // low_stock passes: owned=0, avail=3, margin≈38.6%; no need to check standard_order_approval
    const cache = new Map([["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })]]);
    const result = evaluateOrderRules(rows, cache, productFields, commissionRate, orRules);
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it("skipped_by_rule captures purchase_date_not_eligible when standard_order_approval fails due to missing purchase_date", () => {
    const result = evaluateOrderRules(
      [makeSalesRow({
        product_price: "3000",
        quantity: "1",
        purchase_date: "",
      })],
      new Map([["B2B001", makeProductData({ field_10: 0, field_20: 3, field_30: 1800 })]]),
      productFields,
      commissionRate,
      [ruleStandard],
    );
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
    assert.ok(result.failures[0].reason.includes("purchase_date_not_eligible"));
  });
});

// ── getAutoApprovalRules ─────────────────────────────────────────────

describe("getAutoApprovalRules", () => {
  it("returns default rules when no env override", () => {
    const rules = getAutoApprovalRules({});
    assert.equal(rules.length, 2);
    assert.equal(rules[0].name, "low_stock_good_margin");
    assert.equal(rules[0].enabled, true);
    assert.equal(rules[0].paymentDateGate, false);
    assert.equal(rules[0].thresholds.maxOwnedQty, 0);
    assert.equal(rules[0].thresholds.maxQtyAvailable, 5);
    assert.equal(rules[0].thresholds.minMarginPercent, 8);
    assert.equal(rules[1].name, "standard_order_approval");
    assert.equal(rules[1].enabled, true);
    assert.equal(rules[1].paymentDateGate, undefined);
    assert.equal(rules[1].thresholds.minMarginPercent, 11);
    assert.equal(rules[1].thresholds.maxOwnedQty, undefined);
    assert.equal(rules[1].thresholds.maxQtyAvailable, undefined);
  });

  it("honors env var override with enabled=false", () => {
    const env = {
      AUTO_APPROVAL_RULES_CONFIG: JSON.stringify({
        rules: [
          { name: "low_stock_good_margin", enabled: false, thresholds: { maxOwnedQty: 0, maxQtyAvailable: 5, minMarginPercent: 8 } },
        ],
      }),
    };
    const rules = getAutoApprovalRules(env);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enabled, false);
  });

  it("honors env var override with adjusted thresholds", () => {
    const env = {
      AUTO_APPROVAL_RULES_CONFIG: JSON.stringify({
        rules: [
          { name: "custom_rule", enabled: true, paymentDateGate: true, thresholds: { minMarginPercent: 15 } },
        ],
      }),
    };
    const rules = getAutoApprovalRules(env);
    assert.equal(rules[0].name, "custom_rule");
    assert.equal(rules[0].paymentDateGate, true);
    assert.equal(rules[0].thresholds.maxOwnedQty, undefined);
    assert.equal(rules[0].thresholds.maxQtyAvailable, undefined);
    assert.equal(rules[0].thresholds.minMarginPercent, 15);
  });

  it("falls back to defaults on invalid JSON", () => {
    const env = { AUTO_APPROVAL_RULES_CONFIG: "not-valid-json" };
    const rules = getAutoApprovalRules(env);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].name, "low_stock_good_margin");
    assert.equal(rules[1].name, "standard_order_approval");
  });

  it("returns defaults when env var is empty", () => {
    const env = { AUTO_APPROVAL_RULES_CONFIG: "" };
    const rules = getAutoApprovalRules(env);
    assert.equal(rules[0].name, "low_stock_good_margin");
    assert.equal(rules[1].name, "standard_order_approval");
  });

  it("normalizes legacy paid_n_plus_1_good_margin to standard_order_approval and clears paymentDateGate", () => {
    const env = {
      AUTO_APPROVAL_RULES_CONFIG: JSON.stringify({
        rules: [
          { name: "paid_n_plus_1_good_margin", enabled: true, paymentDateGate: true, thresholds: { minMarginPercent: 11 } },
        ],
      }),
    };
    const rules = getAutoApprovalRules(env);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, "standard_order_approval", "legacy name must be normalized");
    assert.equal(rules[0].paymentDateGate, undefined, "paymentDateGate must be cleared for normalized standard rule");
    assert.equal(rules[0].thresholds.minMarginPercent, 11);
  });

  it("keeps custom non-standard rules with paymentDateGate unchanged for backward compatibility", () => {
    const env = {
      AUTO_APPROVAL_RULES_CONFIG: JSON.stringify({
        rules: [
          { name: "my_custom_rule", enabled: true, paymentDateGate: true, thresholds: { minMarginPercent: 15 } },
        ],
      }),
    };
    const rules = getAutoApprovalRules(env);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, "my_custom_rule");
    assert.equal(rules[0].paymentDateGate, true, "custom rule must preserve paymentDateGate");
    assert.equal(rules[0].thresholds.minMarginPercent, 15);
  });
});

// ── resolveShopLabel ──────────────────────────────────────────────────

describe("resolveShopLabel", () => {
  it("returns Shop1 for known Shop1 ID", () => {
    assert.equal(resolveShopLabel("WMyisFmhbGWyVAPEwsfirn"), "Shop1");
  });

  it("returns Shop2 for known Shop2 ID", () => {
    assert.equal(resolveShopLabel("ZaMyGWzp6hUdgDh5E9ADob"), "Shop2");
  });

  it("returns Shop3 for known Shop3 ID", () => {
    assert.equal(resolveShopLabel("2JGrmZqojnBMfdWrtP2xk3"), "Shop3");
  });

  it("returns Shop4 for known Shop4 ID", () => {
    assert.equal(resolveShopLabel("2JMLHBxjiFHDr55jMwA7fs"), "Shop4");
  });

  it("returns null for unknown ID", () => {
    assert.equal(resolveShopLabel("unknown-shop-id"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(resolveShopLabel(""), null);
  });

  it("returns null for null/undefined", () => {
    assert.equal(resolveShopLabel(null), null);
    assert.equal(resolveShopLabel(undefined), null);
  });
});

// ── isExcludedShippingState ──────────────────────────────────────────

describe("isExcludedShippingState", () => {
  it("returns true for Okinawa (沖縄県)", () => {
    assert.equal(isExcludedShippingState("沖縄県"), true);
  });

  it("returns true for Okinawa bare name (沖縄)", () => {
    assert.equal(isExcludedShippingState("沖縄"), true);
  });

  it("returns true for Hokkaido (北海道)", () => {
    assert.equal(isExcludedShippingState("北海道"), true);
  });

  it("returns true for Okinawa in English", () => {
    assert.equal(isExcludedShippingState("Okinawa"), true);
  });

  it("returns true for Hokkaido in English", () => {
    assert.equal(isExcludedShippingState("Hokkaido"), true);
  });

  it("is case-insensitive for English", () => {
    assert.equal(isExcludedShippingState("OKINAWA"), true);
    assert.equal(isExcludedShippingState("hokkaido"), true);
    assert.equal(isExcludedShippingState("oKiNaWa"), true);
  });

  it("returns false for a non-excluded prefecture (Tokyo)", () => {
    assert.equal(isExcludedShippingState("東京都"), false);
  });

  it("returns false for Osaka", () => {
    assert.equal(isExcludedShippingState("大阪府"), false);
  });

  it("returns false for Fukuoka", () => {
    assert.equal(isExcludedShippingState("福岡県"), false);
  });

  it("returns false for Aomori (Tohoku, not Hokkaido)", () => {
    assert.equal(isExcludedShippingState("青森県"), false);
  });

  it("returns true for empty string (fail closed)", () => {
    assert.equal(isExcludedShippingState(""), true);
  });

  it("returns true for null (fail closed)", () => {
    assert.equal(isExcludedShippingState(null), true);
  });

  it("returns true for undefined (fail closed)", () => {
    assert.equal(isExcludedShippingState(undefined), true);
  });

  it("returns true for whitespace-only (fail closed)", () => {
    assert.equal(isExcludedShippingState("   "), true);
  });

  it("matches substring — e.g. full Mercari state name with suffix", () => {
    // Mercari API returns "state.name" which is the full prefecture name
    assert.equal(isExcludedShippingState("北海道"), true);
    assert.equal(isExcludedShippingState("沖縄県"), true);
  });

  it("does not false-positive on partial match of unrelated state", () => {
    // "沖" alone shouldn't match (unlikely but guard against false positives)
    // This is already covered — "okinawa" contains check wouldn't hit "東京"
    assert.equal(isExcludedShippingState("東京"), false);
  });
});

// ── sendAutoApprovalMessage ───────────────────────────────────────────

describe("sendAutoApprovalMessage", () => {
  // Fake KV store for stubbing env.PORTAL_KV
  function makeFakeKV(initial = {}) {
    const store = { ...initial };
    return {
      store,
      async get(key) { return store[key] || null; },
      async put(key, value, _opts) { store[key] = value; },
      async delete(key) { delete store[key]; },
      async list(_opts) {
        return { keys: Object.keys(store).map((k) => ({ name: k })) };
      },
    };
  }

  const shopId = "2JMLHBxjiFHDr55jMwA7fs"; // Shop4
  const orderId = "test-order-message-001";
  const templateBody = "Your order has been processed. Thank you!";

  it("skips when shop_id cannot be resolved to label", async () => {
    const result = await sendAutoApprovalMessage({}, {
      orderId,
      shopId: "unknown-shop",
      templateBody,
    });
    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.error, "unresolvable_shop_id");
  });

  it("skips when template body is empty", async () => {
    const result = await sendAutoApprovalMessage({}, {
      orderId,
      shopId,
      templateBody: "",
    });
    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.error, "empty_template_body");
  });

  it("skips when template body is whitespace only", async () => {
    const result = await sendAutoApprovalMessage({}, {
      orderId,
      shopId,
      templateBody: "   ",
    });
    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.error, "empty_template_body");
  });

  it("sends message successfully via relay", async () => {
    const fakeKV = makeFakeKV();
    const originalFetch = global.fetch;

    try {
      global.fetch = async (_url, _init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, message: { role: "SELLER", message: "sent" } }),
      });

      const env = {
        PORTAL_KV: fakeKV,
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      };

      const result = await sendAutoApprovalMessage(env, {
        orderId,
        shopId,
        templateBody,
      });

      assert.equal(result.sent, true);
      assert.equal(result.skipped, false);
      // Verify guard key was set
      assert.ok(fakeKV.store["auto-msg:test-order-message-001"]);
      // Verify message KV cache was invalidated (deleted) so portal
      // fetches fresh from Mercari on next load
      assert.equal(
        fakeKV.store["messages:2JMLHBxjiFHDr55jMwA7fs:test-order-message-001"],
        undefined,
        "message KV cache should be deleted after successful send"
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("sets KV idempotency guard before sending", async () => {
    const fakeKV = makeFakeKV();
    const originalFetch = global.fetch;

    try {
      global.fetch = async (_url, _init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      const env = {
        PORTAL_KV: fakeKV,
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      };

      await sendAutoApprovalMessage(env, { orderId, shopId, templateBody });

      // Guard key must exist
      assert.equal(fakeKV.store["auto-msg:test-order-message-001"], "1");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("skips on duplicate guard hit", async () => {
    const fakeKV = makeFakeKV({
      "auto-msg:test-order-message-001": "1", // already exists
    });
    const originalFetch = global.fetch;

    try {
      let fetchCalled = false;
      global.fetch = async (_url, _init) => {
        fetchCalled = true;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };

      const env = {
        PORTAL_KV: fakeKV,
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      };

      const result = await sendAutoApprovalMessage(env, { orderId, shopId, templateBody });

      assert.equal(result.sent, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, "duplicate_guard");
      assert.equal(fetchCalled, false, "fetch should not be called on duplicate guard");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles relay returning non-ok", async () => {
    const fakeKV = makeFakeKV();
    const originalFetch = global.fetch;

    try {
      global.fetch = async (_url, _init) => ({
        ok: false,
        status: 502,
        json: async () => ({ ok: false, error: "bad_gateway" }),
      });

      const env = {
        PORTAL_KV: fakeKV,
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      };

      const result = await sendAutoApprovalMessage(env, { orderId, shopId, templateBody });

      assert.equal(result.sent, false);
      assert.equal(result.skipped, false);
      assert.ok(result.error.includes("relay_status_502") || result.error.includes("bad_gateway"));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles relay call throwing", async () => {
    const fakeKV = makeFakeKV();
    const originalFetch = global.fetch;

    try {
      global.fetch = async () => { throw new Error("network down"); };

      const env = {
        PORTAL_KV: fakeKV,
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      };

      const result = await sendAutoApprovalMessage(env, { orderId, shopId, templateBody });

      assert.equal(result.sent, false);
      assert.equal(result.skipped, false);
      assert.equal(result.error, "network down");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("fails closed without KV idempotency storage", async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;

    try {
      global.fetch = async () => {
        fetchCalled = true;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };

      // No PORTAL_KV in env
      const env = {
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      };

      const result = await sendAutoApprovalMessage(env, { orderId, shopId, templateBody });

      assert.equal(result.sent, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, "idempotency_store_unavailable");
      assert.equal(fetchCalled, false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ── isWithinWorkingHours (JST working hours gate) ─────────────────────

describe("isWithinWorkingHours", () => {
  // Boundary: 08:59 JST = 23:59 UTC previous day
  it("returns false for 08:59 JST (outside working hours)", () => {
    // JST 2026-07-03 08:59 = UTC 2026-07-02 23:59
    const dt = new Date("2026-07-02T23:59:00Z");
    assert.equal(isWithinWorkingHours(dt), false);
  });

  // Boundary: 09:00 JST = 00:00 UTC
  it("returns true for 09:00 JST (start of working hours, inclusive)", () => {
    const dt = new Date("2026-07-03T00:00:00Z");
    assert.equal(isWithinWorkingHours(dt), true);
  });

  // Boundary: 17:59 JST = 08:59 UTC
  it("returns true for 17:59 JST (end of working hours, inclusive)", () => {
    const dt = new Date("2026-07-03T08:59:00Z");
    assert.equal(isWithinWorkingHours(dt), true);
  });

  // Boundary: 18:00 JST = 09:00 UTC
  it("returns false for 18:00 JST (after working hours, exclusive)", () => {
    const dt = new Date("2026-07-03T09:00:00Z");
    assert.equal(isWithinWorkingHours(dt), false);
  });

  it("returns true for 12:00 JST (midday, within hours)", () => {
    const dt = new Date("2026-07-03T03:00:00Z");
    assert.equal(isWithinWorkingHours(dt), true);
  });

  it("returns false for 00:00 JST (midnight, outside hours)", () => {
    const dt = new Date("2026-07-02T15:00:00Z");
    assert.equal(isWithinWorkingHours(dt), false);
  });

  it("returns false for 06:00 JST (early morning, outside hours)", () => {
    // JST 06:00 = UTC previous day 21:00
    const dt = new Date("2026-07-02T21:00:00Z");
    assert.equal(isWithinWorkingHours(dt), false);
  });

  it("returns false for 23:59 JST (late night, outside hours)", () => {
    // JST 23:59 = UTC 14:59
    const dt = new Date("2026-07-03T14:59:00Z");
    assert.equal(isWithinWorkingHours(dt), false);
  });

  it("uses current time when no argument is given", () => {
    // Should always return a boolean without throwing
    const result = isWithinWorkingHours();
    assert.equal(typeof result, "boolean");
  });
});

// ── autoApproveMercariOrders (integration-light) ──────────────────────

describe("autoApproveMercariOrders", () => {
  const baseEnv = {
    BASEROW_DATABASE_TOKEN: "test-token",
    BASEROW_API_BASE: "https://api.baserow.io/api",
    BASEROW_MERCARI_SALES_ORDER_TABLE_ID: "903318",
    BASEROW_GIGA_SHIPMENT_ORDER_TABLE_ID: "903319",
    BASEROW_RAKUTEN_SALES_ORDER_TABLE_ID: "1015675",
  };

  function makeFakeKV(initial = {}) {
    const store = { ...initial };
    return {
      store,
      async get(key) { return store[key] || null; },
      async put(key, value, _opts) { store[key] = value; },
      async delete(key) { delete store[key]; },
      async list(_opts) {
        return { keys: Object.keys(store).map((k) => ({ name: k })) };
      },
    };
  }

  it("outside 08:59 JST returns outside_working_hours with 0 approvals and no template/baserow calls", async () => {
    // 08:59 JST = UTC 23:59 previous day
    const now = new Date("2026-07-02T23:59:00Z");
    let fetchCalls = 0;
    const origFetch = global.fetch;
    try {
      global.fetch = async () => { fetchCalls += 1; throw new Error("unexpected"); };
      const result = await autoApproveMercariOrders(baseEnv, { now });
      assert.equal(result.ok, true);
      assert.ok(result.note.includes("outside_working_hours"));
      assert.equal(result.orders_approved, 0);
      assert.equal(result.rows_approved, 0);
      assert.equal(result.candidates_loaded, 0);
      assert.equal(result.messages_sent, 0);
      assert.equal(result.messages_skipped, 0);
      assert.equal(result.message_failures, 0);
      assert.equal(fetchCalls, 0, "no network calls outside working hours");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("inside 09:00 JST passes working-hours gate and proceeds to Baserow list", async () => {
    // 09:00 JST = UTC 00:00
    const now = new Date("2026-07-03T00:00:00Z");
    const origFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        if (url.includes("database/rows/table/903318")) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ results: [] }),
            json: async () => ({ results: [] }),
          };
        }
        return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
      };
      const result = await autoApproveMercariOrders(baseEnv, { now });
      assert.equal(result.ok, true);
      assert.equal(result.note && result.note.includes("outside_working_hours"), false,
        "should not return outside_working_hours when inside working hours");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("successful approval sends the Order processed notice after all rows patch", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const fakeKV = makeFakeKV({
      "template:test-uuid": {
        title: "Order processed notice",
        body: "Your order has been processed. Thank you!",
      },
    });

    const fieldsDef = [
      { id: 10, name: "Gigab2b Item Code" },
      { id: 20, name: "Owned Qty" },
      { id: 21, name: "Qty Available" },
      { id: 22, name: "Effective TCOGS" },
      { id: 23, name: "Seller" },
    ];

    const productData = {
      id: 500,
      field_10: "B2B001",
      field_20: 0,
      field_21: 3,
      field_22: 1800,
    };

    const salesRow = {
      id: 100,
      order_id: "order_test_001",
      product_name: "Test Product",
      original_product_id: "SKU001",
      B2BItemCode: "B2B001",
      product_price: "3000",
      quantity: "2",
      shipping_price: "500",
      shipping_state: "東京都",
      review_status: { value: "Pending Review" },
      order_status: { value: "WAITING_FOR_SHIPPING" },
      order_comments: "",
      shop_id: "2JMLHBxjiFHDr55jMwA7fs",
    };

    const env = {
      ...baseEnv,
      PORTAL_KV: fakeKV,
      MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
      MERCARI_RELAY_SECRET: "test-secret",
    };

    const origFetch = global.fetch;
    try {
      global.fetch = async (url, init) => {
        const str = String(url);
        if (init?.method === "PATCH") {
          return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
        }
        if (str.includes("database/fields/table/886994")) {
          return { ok: true, status: 200, text: async () => JSON.stringify(fieldsDef), json: async () => fieldsDef };
        }
        if (str.includes("database/rows/table/886994")) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ results: [productData] }), json: async () => ({ results: [productData] }) };
        }
        if (str.includes("database/rows/table/903318")) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ results: [salesRow] }), json: async () => ({ results: [salesRow] }) };
        }
        if (str.includes("relay")) {
          if (str.includes("order-messages")) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, messages: [] }), json: async () => ({ ok: true, messages: [] }) };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, message: { role: "SELLER" } }), json: async () => ({ ok: true, message: { role: "SELLER" } }) };
        }
        throw new Error(`unexpected fetch: ${init?.method || "GET"} ${str}`);
      };
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.ok, true);
      assert.ok(result.orders_approved >= 1, `expected >=1 approved, got ${result.orders_approved}`);
      assert.ok(result.rows_approved >= 1, `expected >=1 rows_approved, got ${result.rows_approved}`);
      assert.equal(result.candidates_loaded, 1);
      assert.equal(result.messages_sent, 1);
      assert.equal(result.patch_failures, 0);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("outside working hours sends no message", async () => {
    const now = new Date("2026-07-02T23:59:00Z");
    const fakeKV = makeFakeKV({
      "template:test-uuid": {
        title: "Order processed notice",
        body: "Your order has been processed. Thank you!",
      },
    });
    const envWithKv = { ...baseEnv, PORTAL_KV: fakeKV };
    const origFetch = global.fetch;
    try {
      global.fetch = async () => { throw new Error("should not be called"); };
      const result = await autoApproveMercariOrders(envWithKv, { now });
      assert.equal(result.ok, true);
      assert.ok(result.note.includes("outside_working_hours"));
      assert.equal(result.messages_sent, 0);
      assert.equal(result.candidates_loaded, 0);
    } finally {
      global.fetch = origFetch;
    }
  });

  // ── Safety gate focused tests ───────────────────────────────────

  function makeSafetyEnv(extraEnv = {}) {
    return { ...baseEnv, ...extraEnv };
  }

  const safetyFieldsDef = [
    { id: 10, name: "Gigab2b Item Code" },
    { id: 20, name: "Owned Qty" },
    { id: 21, name: "Qty Available" },
    { id: 22, name: "Effective TCOGS" },
    { id: 23, name: "Seller" },
  ];

  function safetyProductData(overrides = {}) {
    return { id: 500, field_10: "B2B001", field_20: 0, field_21: 3, field_22: 1800, ...overrides };
  }

  function safetySalesRow(overrides = {}) {
    return {
      id: 100,
      order_id: "order_test_safety_001",
      product_name: "Test Product",
      original_product_id: "SKU001",
      B2BItemCode: "B2B001",
      product_price: "3000",
      quantity: "2",
      shipping_price: "500",
      shipping_state: "東京都",
      review_status: { value: "Pending Review" },
      order_status: { value: "WAITING_FOR_SHIPPING" },
      order_comments: "",
      shop_id: "2JMLHBxjiFHDr55jMwA7fs",
      ...overrides,
    };
  }

  function safetyMockFetch(salesRows, productData, extraHandlers = {}) {
    const handlers = {
      "database/fields/table/886994": () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify(safetyFieldsDef),
        json: async () => safetyFieldsDef,
      }),
      "database/rows/table/886994": () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ results: [productData] }),
        json: async () => ({ results: [productData] }),
      }),
      "database/rows/table/903318": () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ results: salesRows }),
        json: async () => ({ results: salesRows }),
      }),
      ...extraHandlers,
    };

    return async (url, init) => {
      const str = String(url);
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (str.includes(pattern)) return handler(url, init);
      }
      if (String(url).includes("relay")) {
        if (String(url).includes("order-messages")) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, messages: [] }), json: async () => ({ ok: true, messages: [] }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, message: { role: "SELLER" } }), json: async () => ({ ok: true, message: { role: "SELLER" } }) };
      }
      throw new Error(`unexpected fetch: ${init?.method || "GET"} ${str}`);
    };
  }

  it("skipped_fee_order blocks low_stock_good_margin eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const productRow = safetySalesRow({ id: 1, order_id: "order_safety_fee_001" });
    const feeRow = safetySalesRow({
      id: 2,
      order_id: "order_safety_fee_001",
      product_name: "各種手数料",
      B2BItemCode: "",
      original_product_id: "FEE001",
    });
    const salesRows = [productRow, feeRow];
    const env = makeSafetyEnv();
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData());
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_fee_order, 1);
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.fee_row_in_order.length, 1);
      assert.equal(result.skipped_by_safety.details.fee_row_in_order[0], "safety_fee_001", "oid is normalized (order_ prefix stripped)");
      assert.equal(result.skipped_buyer_message, 0);
      assert.equal(result.skipped_message_check_failed, 0);
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("skipped_fee_order blocks standard_order_approval eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const productRow = safetySalesRow({
      id: 1,
      order_id: "order_safety_fee_n1_001",
      purchase_date: jstPaymentDate(-1),
    });
    const feeRow = safetySalesRow({
      id: 2,
      order_id: "order_safety_fee_n1_001",
      product_name: "追加支払い・追加送料専用",
      B2BItemCode: "",
      original_product_id: "FEE001",
    });
    const salesRows = [productRow, feeRow];
    const env = makeSafetyEnv();
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData());
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_fee_order, 1);
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.fee_row_in_order.length, 1);
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("skipped_buyer_message blocks low_stock_good_margin eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const salesRow = safetySalesRow({ id: 1, order_id: "order_safety_msg_001" });
    const salesRows = [salesRow];
    const fakeKV = makeFakeKV({
      [`messages:2JMLHBxjiFHDr55jMwA7fs:order_safety_msg_001`]: {
        messages: [{ role: "BUYER", message: "When will you ship?", createdAt: "2026-07-02T10:00:00Z" }],
        latest_buyer_msg_at: "2026-07-02T10:00:00Z",
      },
    });
    const env = makeSafetyEnv({
      PORTAL_KV: fakeKV,
      MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
      MERCARI_RELAY_SECRET: "test-secret",
    });
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData());
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_buyer_message, 1);
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.buyer_message_exists.length, 1);
      assert.equal(result.skipped_by_safety.details.buyer_message_exists[0], "safety_msg_001", "oid is normalized (order_ prefix stripped)");
      assert.equal(result.skipped_fee_order, 0);
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("skipped_buyer_message blocks standard_order_approval eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const salesRow = safetySalesRow({
      id: 1,
      order_id: "order_safety_msg_n1_001",
      purchase_date: jstPaymentDate(-1),
    });
    const salesRows = [salesRow];
    const fakeKV = makeFakeKV({
      [`messages:2JMLHBxjiFHDr55jMwA7fs:order_safety_msg_n1_001`]: {
        messages: [{ role: "BUYER", message: "Can you combine shipping?", createdAt: "2026-07-02T10:00:00Z" }],
        latest_buyer_msg_at: "2026-07-02T10:00:00Z",
      },
    });
    const env = makeSafetyEnv({
      PORTAL_KV: fakeKV,
      MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
      MERCARI_RELAY_SECRET: "test-secret",
    });
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData());
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_buyer_message, 1);
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.buyer_message_exists.length, 1);
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("seller-only messages do not block eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const salesRow = safetySalesRow({ id: 1, order_id: "order_safety_selmsg_001" });
    const salesRows = [salesRow];
    const fakeKV = makeFakeKV({
      "template:test-uuid": {
        title: "Order processed notice",
        body: "Your order has been processed. Thank you!",
      },
      [`messages:2JMLHBxjiFHDr55jMwA7fs:order_safety_selmsg_001`]: {
        messages: [{ role: "SELLER", message: "Thank you for your order!", createdAt: "2026-07-02T10:00:00Z" }],
        latest_buyer_msg_at: null,
      },
    });
    const env = makeSafetyEnv({
      PORTAL_KV: fakeKV,
      MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
      MERCARI_RELAY_SECRET: "test-secret",
    });
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData());
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_buyer_message, 0);
      assert.equal(result.skipped_fee_order, 0);
      assert.equal(result.skipped_by_safety.total, 0);
      assert.equal(result.orders_approved, 1);
      assert.equal(result.messages_sent, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("message fetch failure blocks (fail-closed)", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const salesRow = safetySalesRow({ id: 1, order_id: "order_safety_failmsg_001" });
    const salesRows = [salesRow];
    const env = makeSafetyEnv({
      MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
      MERCARI_RELAY_SECRET: "test-secret",
    });
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData(), {
        "order-messages": () => ({
          ok: false,
          status: 502,
          text: async () => JSON.stringify({ ok: false, error: "bad_gateway" }),
          json: async () => ({ ok: false, error: "bad_gateway" }),
        }),
      });
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_message_check_failed, 1);
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.message_check_failed.length, 1);
      assert.equal(result.skipped_by_safety.details.message_check_failed[0], "safety_failmsg_001", "oid is normalized");
      assert.equal(result.skipped_by_safety.details.message_state_unknown.length, 1);
      assert.equal(result.skipped_by_safety.details.message_state_unknown[0], "safety_failmsg_001", "missing durable state is tracked explicitly");
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  // ── Linked fee order tests ──────────────────────────────────────

  it("linked fee order by phone+shop blocks eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const salesRow = safetySalesRow({
      id: 1,
      order_id: "order_safety_linkedfee_phone_001",
      shipping_phone_number: "090-1234-5678",
      shipping_name: "山田太郎",
      shipping_postal_code: "100-0001",
    });
    const salesRows = [salesRow];

    // The linked fee order query goes to the same table but with
    // phone+shop filters. Return a fee row for that sub-query.
    const linkedFeeRow = {
      id: 999,
      order_id: "order_fee_linked_001",
      product_name: "各種手数料",
      B2BItemCode: "",
      shipping_phone_number: "090-1234-5678",
      shop_id: "2JMLHBxjiFHDr55jMwA7fs",
      order_status: { value: "WAITING_FOR_SHIPPING" },
    };

    let linkedQueryCount = 0;

    const origFetch = global.fetch;
    try {
      global.fetch = async (url, init) => {
        const str = String(url);
        // Intercept the linked fee order query (has phone filter)
        if (str.includes("filter__field_7824241__equal") && str.includes("filter__field_7907194__equal")) {
          linkedQueryCount += 1;
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ results: [linkedFeeRow] }),
            json: async () => ({ results: [linkedFeeRow] }),
          };
        }
        // Delegate everything else to safetyMockFetch
        return safetyMockFetch(salesRows, safetyProductData())(url, init);
      };
      const env = makeSafetyEnv();
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_fee_order, 1, "linked fee order should increment skipped_fee_order");
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.linked_fee_order_exists.length, 1);
      assert.equal(result.skipped_by_safety.details.linked_fee_order_exists[0], "safety_linkedfee_phone_001", "oid is normalized");
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
      assert.ok(linkedQueryCount >= 1, "linked fee query should have been made");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("linked fee order by name+postal+shop blocks eligible order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    // No phone number, so findLinkedFeeOrder falls back to name+postal+shop
    const salesRow = safetySalesRow({
      id: 1,
      order_id: "order_safety_linkedfee_name_001",
      shipping_phone_number: "",
      shipping_name: "山田太郎",
      shipping_postal_code: "100-0001",
    });
    const salesRows = [salesRow];

    const linkedFeeRow = {
      id: 999,
      order_id: "order_fee_linked_name_001",
      product_name: "各種手数料",
      B2BItemCode: "",
      shipping_name: "山田太郎",
      shipping_postal_code: "100-0001",
      shop_id: "2JMLHBxjiFHDr55jMwA7fs",
      order_status: { value: "WAITING_FOR_SHIPPING" },
    };

    let linkedQueryCount = 0;

    const origFetch = global.fetch;
    try {
      global.fetch = async (url, init) => {
        const str = String(url);
        // Intercept the linked fee order query (has name+postal filters)
        if (str.includes("filter__field_7824233__equal") && str.includes("filter__field_7824228__equal")) {
          linkedQueryCount += 1;
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ results: [linkedFeeRow] }),
            json: async () => ({ results: [linkedFeeRow] }),
          };
        }
        return safetyMockFetch(salesRows, safetyProductData())(url, init);
      };
      const env = makeSafetyEnv();
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_fee_order, 1, "linked fee order should increment skipped_fee_order");
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.linked_fee_order_exists.length, 1);
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
      assert.ok(linkedQueryCount >= 1, "linked fee query should have been made");
    } finally {
      global.fetch = origFetch;
    }
  });

  // ── Stale KV + live relay tests ─────────────────────────────────

  it("stale seller-only KV does not bypass live relay with buyer message", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const salesRow = safetySalesRow({ id: 1, order_id: "order_safety_stale_kv_001" });
    const salesRows = [salesRow];
    // Stale KV has only seller messages (no buyer)
    const fakeKV = makeFakeKV({
      [`messages:2JMLHBxjiFHDr55jMwA7fs:order_safety_stale_kv_001`]: {
        messages: [{ role: "SELLER", message: "Thank you!", createdAt: "2026-07-01T10:00:00Z" }],
        latest_buyer_msg_at: null,
      },
    });
    const env = makeSafetyEnv({
      PORTAL_KV: fakeKV,
      MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
      MERCARI_RELAY_SECRET: "test-secret",
    });

    // Live relay returns a buyer message — must block despite stale seller-only KV
    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, safetyProductData(), {
        "order-messages": () => ({
          ok: true, status: 200,
          text: async () => JSON.stringify({
            ok: true,
            messages: [{ role: "BUYER", message: "Where is my order?", createdAt: "2026-07-02T10:00:00Z" }],
          }),
          json: async () => ({
            ok: true,
            messages: [{ role: "BUYER", message: "Where is my order?", createdAt: "2026-07-02T10:00:00Z" }],
          }),
        }),
      });
      const result = await autoApproveMercariOrders(env, { now });
      assert.equal(result.skipped_buyer_message, 1, "buyer message from live relay must block");
      assert.equal(result.skipped_by_safety.total, 1);
      assert.equal(result.skipped_by_safety.details.buyer_message_exists.length, 1);
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("no relay call for rule-failed order", async () => {
    const now = new Date("2026-07-03T00:00:00Z");
    // Low margin order that fails all rules
    const salesRow = safetySalesRow({
      id: 1,
      order_id: "order_safety_rulefail_001",
      product_price: "500",
      quantity: "1",
      shipping_price: "0",
    });
    const salesRows = [salesRow];

    // Use product with high TCOGS → very low margin
    const lowMarginProduct = safetyProductData({ field_22: 5000 });

    let relayCallCount = 0;

    const origFetch = global.fetch;
    try {
      global.fetch = safetyMockFetch(salesRows, lowMarginProduct, {
        "order-messages": () => {
          relayCallCount += 1;
          throw new Error("relay should not be called for rule-failed order");
        },
        "order-reply": () => {
          relayCallCount += 1;
          throw new Error("relay should not be called for rule-failed order");
        },
        "relay": () => {
          relayCallCount += 1;
          throw new Error("relay should not be called for rule-failed order");
        },
      });
      const ruleFailEnv = makeSafetyEnv({
        MERCARI_RUNNER_BASE_URL: "https://relay.example.com",
        MERCARI_RELAY_SECRET: "test-secret",
      });
      const result = await autoApproveMercariOrders(ruleFailEnv, { now });
      assert.equal(result.orders_approved, 0);
      assert.equal(result.orders_evaluated, 1);
      assert.equal(result.skipped_by_rule.length, 1, "should be skipped by rule, not safety");
      assert.equal(result.skipped_by_safety.total, 0, "no safety blocks");
      assert.equal(relayCallCount, 0, "relay must not be called for rule-failed order");
    } finally {
      global.fetch = origFetch;
    }
  });
});
