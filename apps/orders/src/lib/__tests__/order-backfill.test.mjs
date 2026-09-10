import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { needsBackfill, buildBackfillPayload } from "../order-backfill.mjs";

function wfp(status) {
  return { value: status, id: 1 };
}

function txt(v) {
  return v ?? "";
}

const WFP = "WAITING_FOR_PAYMENT";
const WFS = "WAITING_FOR_SHIPPING";
const COMPLETED = "COMPLETED";

function existingRow(overrides = {}) {
  return {
    order_status: wfp(overrides.order_status ?? WFP),
    review_status: null,
    shipping_name: txt(overrides.shipping_name),
    shipping_postal_code: txt(overrides.shipping_postal_code),
    shipping_address_1: txt(overrides.shipping_address_1),
    billing_name: txt(overrides.billing_name),
    ...overrides,
  };
}

function targetRow(overrides = {}) {
  return {
    order_status: overrides.order_status ?? WFS,
    shipping_name: overrides.shipping_name ?? "山田太郎",
    shipping_postal_code: overrides.shipping_postal_code ?? "1234567",
    shipping_address_1: overrides.shipping_address_1 ?? "1-2-3 Shibuya",
    billing_name: overrides.billing_name ?? "山田太郎",
    ...overrides,
  };
}

// ============================================================================
// needsBackfill
// ============================================================================

describe("needsBackfill()", () => {
  it("returns true when order transitions WFP→WFS", () => {
    assert.equal(needsBackfill(existingRow(), targetRow()), true);
  });

  it("returns false when order stays in WFP", () => {
    assert.equal(
      needsBackfill(existingRow({ order_status: WFP }), targetRow({ order_status: WFP })),
      false,
    );
  });

  it("returns false when incoming is not WFS", () => {
    assert.equal(
      needsBackfill(existingRow({ order_status: WFP }), targetRow({ order_status: COMPLETED })),
      false,
    );
  });

  it("returns true on retry when address is still empty and incoming is WFS", () => {
    assert.equal(
      needsBackfill(
        existingRow({ order_status: WFS, shipping_name: "" }),
        targetRow({ order_status: WFS, shipping_name: "佐藤花子" }),
      ),
      true,
    );
  });

  it("returns false when address is already populated (no retry needed)", () => {
    assert.equal(
      needsBackfill(
        existingRow({ order_status: WFS, shipping_name: "山田太郎" }),
        targetRow({ order_status: WFS }),
      ),
      false,
    );
  });
});

// ============================================================================
// buildBackfillPayload
// ============================================================================

describe("buildBackfillPayload()", () => {
  it("includes review_status when existing is null", () => {
    const result = buildBackfillPayload(
      existingRow({ review_status: null }),
      targetRow(),
    );
    assert.equal(result.review_status, "Pending Review");
  });

  it("preserves operator-set On Hold during unpaid-to-paid backfill", () => {
    const result = buildBackfillPayload(
      existingRow({ review_status: wfp("On Hold") }),
      targetRow(),
    );
    assert.equal(result.review_status, undefined);
  });

  it("preserves On Hold when a hidden Mercari shipping address stays empty", () => {
    const result = buildBackfillPayload(
      existingRow({
        order_status: WFS,
        review_status: wfp("On Hold"),
        shipping_name: "",
        shipping_postal_code: "",
        shipping_address_1: "",
        billing_name: "",
      }),
      targetRow({
        order_status: WFS,
        shipping_name: "",
        shipping_postal_code: "",
        shipping_address_1: "",
        billing_name: "",
      }),
    );
    assert.deepEqual(result, {});
  });

  it("skips review_status when already set to Pending Review", () => {
    const result = buildBackfillPayload(
      existingRow({ review_status: wfp("Pending Review") }),
      targetRow(),
    );
    assert.equal(result.review_status, undefined);
  });

  it("backfills empty address fields from target", () => {
    const result = buildBackfillPayload(
      existingRow({ shipping_name: "", shipping_address_1: "" }),
      targetRow({ shipping_name: "山田太郎", shipping_address_1: "1-2-3 Shibuya" }),
    );
    assert.equal(result.shipping_name, "山田太郎");
    assert.equal(result.shipping_address_1, "1-2-3 Shibuya");
  });

  it("does not overwrite operator-set address fields", () => {
    const result = buildBackfillPayload(
      existingRow({ shipping_name: "手動修正", shipping_address_1: "" }),
      targetRow({ shipping_name: "山田太郎", shipping_address_1: "1-2-3 Shibuya" }),
    );
    assert.equal(result.shipping_name, undefined);
    assert.equal(result.shipping_address_1, "1-2-3 Shibuya");
  });

  it("returns empty object when nothing to backfill", () => {
    const result = buildBackfillPayload(
      existingRow({
        review_status: wfp("Pending Review"),
        shipping_name: "山田太郎",
        shipping_postal_code: "1234567",
        shipping_address_1: "1-2-3 Shibuya",
        billing_name: "山田太郎",
      }),
      targetRow(),
    );
    assert.equal(Object.keys(result).length, 0);
  });

  it("never resets CANCELED (operator-owned terminal) on unpaid→paid backfill", () => {
    const result = buildBackfillPayload(
      existingRow({ order_status: WFP, review_status: wfp("Canceled") }),
      targetRow(),
    );
    assert.equal(result.review_status, undefined);
  });

  it("never resets CANCELED on address-retry backfill, but still backfills the address", () => {
    const result = buildBackfillPayload(
      existingRow({ order_status: WFS, review_status: wfp("Canceled"), shipping_name: "" }),
      targetRow({ order_status: WFS, shipping_name: "山田太郎" }),
    );
    assert.equal(result.review_status, undefined);
    assert.equal(result.shipping_name, "山田太郎");
  });
});
