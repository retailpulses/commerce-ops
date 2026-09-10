import test from "node:test";
import assert from "node:assert/strict";
import { buildManualOrderLinePayload, findMissingB2bRowIds, selectOrderLineTarget } from "../portal/handlers.mjs";

test("single-line order remains backward compatible without row_id", () => {
  const row = { id: 11 };
  assert.deepEqual(selectOrderLineTarget([row], undefined), { ok: true, row });
});

test("multi-line order requires row_id", () => {
  assert.deepEqual(selectOrderLineTarget([{ id: 11 }, { id: 12 }], undefined), {
    ok: false,
    error: "row_id_required_for_multi_line_order",
    statusCode: 400,
  });
});

test("row_id selects only the requested order line", () => {
  const target = { id: 12, B2BItemCode: "B" };
  assert.deepEqual(selectOrderLineTarget([{ id: 11 }, target, { id: 13 }], 12), { ok: true, row: target });
});

test("row_id outside the order is rejected", () => {
  assert.deepEqual(selectOrderLineTarget([{ id: 11 }], 99), {
    ok: false,
    error: "order_line_not_found",
    statusCode: 404,
  });
});

test("approval guard identifies every line missing a B2B code", () => {
  assert.deepEqual(findMissingB2bRowIds([
    { id: 11, B2BItemCode: "B2B-A" },
    { id: 12, B2BItemCode: "" },
    { id: 13, B2BItemCode: null },
  ]), [12, 13]);
});

test("manual order line copies order scope but does not duplicate revenue", () => {
  const result = buildManualOrderLinePayload({
    order_id: "order-1",
    sales_channel: "mercari",
    shop_id: "shop-2",
    order_status: "WAITING_FOR_SHIPPING",
    review_status: "On Hold",
    product_price: 30000,
    shipping_name: "Buyer",
    shipping_postal_code: "1000001",
  }, { b2b_item_code: " N511P203524A ", quantity: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.payload.B2BItemCode, "N511P203524A");
  assert.equal(result.payload.quantity, 2);
  assert.equal(result.payload.product_price, 0);
  assert.equal(result.payload.shipping_name, "Buyer");
  assert.equal(result.payload.product_name, "Manual order line: N511P203524A");
});

test("manual order line rejects invalid values and locked orders", () => {
  const anchor = { order_id: "order-1", order_status: "WAITING_FOR_SHIPPING", review_status: "Pending Review" };
  assert.equal(buildManualOrderLinePayload(anchor, { b2b_item_code: "", quantity: 1 }).error, "b2b_item_code_required");
  assert.equal(buildManualOrderLinePayload(anchor, { b2b_item_code: "A", quantity: 0 }).error, "invalid_quantity");
  assert.equal(buildManualOrderLinePayload({ ...anchor, review_status: "Approved" }, { b2b_item_code: "A", quantity: 1 }).error, "order_lines_locked_after_approval");
  assert.equal(buildManualOrderLinePayload({ ...anchor, order_status: "COMPLETED" }, { b2b_item_code: "A", quantity: 1 }).error, "order_lines_locked_for_terminal_order");
});
