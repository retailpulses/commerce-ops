import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractRakutenMerchantDefinedSkuId,
  preserveOrResolveB2BItemCode,
} from "../rakuten-ingest.mjs";
import {
  buildRakutenShipmentPayload,
  validateRakutenProjectionSource,
} from "../rakuten-projector.mjs";

describe("Rakuten ingest B2B item code", () => {
  it("reads the exact merchant-defined SKU from getOrder v7", () => {
    assert.equal(extractRakutenMerchantDefinedSkuId({
      itemName: "Title says Beige",
      SkuModelList: [{
        variantId: "w1082p453883",
        merchantDefinedSkuId: "w1082p453883",
        skuInfo: "カラー:ブラック",
      }],
    }), "w1082p453883");
  });

  it("fails closed when one order item contains distinct SKU values", () => {
    assert.equal(extractRakutenMerchantDefinedSkuId({
      SkuModelList: [
        { merchantDefinedSkuId: "SKU-A" },
        { merchantDefinedSkuId: "SKU-B" },
      ],
    }), "");
  });

  it("prefers the authoritative RMS SKU over a stale stored mapping", async () => {
    const payload = { manage_number: "manage-1", b2b_item_code: "RMS-SKU" };
    const result = await preserveOrResolveB2BItemCode(
      payload,
      { b2b_item_code: "STALE-AUTO-MAPPING" },
      async () => { throw new Error("resolver must not run"); },
    );

    assert.equal(payload.b2b_item_code, "RMS-SKU");
    assert.deepEqual(result, { source: "rms_sku", code: "RMS-SKU" });
  });

  it("preserves a non-empty operator override without invoking the resolver", async () => {
    const payload = { manage_number: "manage-1" };
    let calls = 0;
    const result = await preserveOrResolveB2BItemCode(
      payload,
      { b2b_item_code: "OPERATOR-CODE" },
      async () => {
        calls += 1;
        return { resolved: true, code: "AUTO-CODE", reason: null };
      },
    );

    assert.equal(calls, 0);
    assert.equal(payload.b2b_item_code, "OPERATOR-CODE");
    assert.deepEqual(result, { source: "existing", code: "OPERATOR-CODE" });
  });

  it("leaves a missing RMS SKU empty for operator maintenance", async () => {
    const payload = { manage_number: "manage-1" };
    let calls = 0;
    const result = await preserveOrResolveB2BItemCode(
      payload,
      { b2b_item_code: "" },
      async () => {
        calls += 1;
        return { resolved: true, code: "CATALOG-GUESS", reason: null };
      },
    );

    assert.equal(calls, 0);
    assert.equal(payload.b2b_item_code, undefined);
    assert.deepEqual(result, { source: "unresolved", code: "" });
  });

  it("leaves the B2B code empty when resolution is ambiguous", async () => {
    const payload = { manage_number: "manage-1" };
    const result = await preserveOrResolveB2BItemCode(
      payload,
      null,
      async () => ({ resolved: false, code: null, reason: "ambiguous_mapping" }),
    );

    assert.equal(payload.b2b_item_code, undefined);
    assert.deepEqual(result, { source: "unresolved", code: "" });
  });
});

describe("Rakuten shipment projection", () => {
  const sourceRow = {
    order_id: "440058-20260714-0379940609",
    manage_number: "sofabd-n511p407695",
    b2b_item_code: "N511P407695W",
    quantity: 1,
    product_name: "Test product",
    product_price: 5000,
    shipping_name: "Buyer",
    shipping_postal_code: "100-0001",
    shipping_state: "Tokyo",
    shipping_city: "Chiyoda",
    shipping_address_1: "1-1",
    shipping_phone_number: "090-0000-0000",
    purchase_date: "2026-07-14",
  };

  it("uses resolved item code for Giga and manage_number for buyer SKU", () => {
    const payload = buildRakutenShipmentPayload(sourceRow);
    assert.equal(payload.B2BItemCode, "N511P407695W");
    assert.equal(payload.BuyerPlatformSku, "SOFABD-N511P407695");
  });

  it("rejects projection while B2B item code is unresolved", () => {
    assert.deepEqual(validateRakutenProjectionSource({ ...sourceRow, b2b_item_code: "" }), {
      valid: false,
      reason: "skipped_missing_b2b_item_code",
    });
  });
});
