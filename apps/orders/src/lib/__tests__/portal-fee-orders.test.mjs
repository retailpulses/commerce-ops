import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { pickBestMainOrder } from "../portal/fee-orders.mjs";
import { getCustomerKey, isFeeRow } from "../portal/shared.mjs";

describe("portal fee-order helpers", () => {
  it("isFeeRow still matches known fee patterns", () => {
    assert.equal(isFeeRow("各種手数料"), true);
    assert.equal(isFeeRow("追加支払い・追加送料専用"), true);
    assert.equal(isFeeRow("regular product"), false);
  });

  it("getCustomerKey prefers phone+shop", () => {
    assert.equal(getCustomerKey({ shipping_phone_number: "090", shop_id: "Shop1" }), "phone:090:Shop1");
  });

  it("pickBestMainOrder chooses newest purchase_date match", () => {
    const rows = [
      { id: 10, order_id: "older", product_name: "Desk", order_status: "WAITING", review_status: { value: "Approved" }, shipping_completed_at: "", purchase_date: "2026-06-01", _key: "phone:090:Shop1" },
      { id: 9, order_id: "newer", product_name: "Chair", order_status: "WAITING", review_status: { value: "Approved" }, shipping_completed_at: "", purchase_date: "2026-06-10", _key: "phone:090:Shop1" },
    ];
    const best = pickBestMainOrder(rows, "phone:090:Shop1", (row) => row._key);
    assert.equal(best.order_id, "newer");
  });
});
