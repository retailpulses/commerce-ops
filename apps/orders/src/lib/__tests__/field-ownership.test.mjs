import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPatchOwnsOnlyAllowedFields,
  filterPatchToOwnedFields,
  findOperatorFieldsInPatch,
  getOperatorOwnedFields,
  getOwnedFields,
  getPreservedFields,
} from "../field-ownership.mjs";

describe("field ownership registry", () => {
  it("marks delivery, address, B2B item code, notes, and tracking fields as operator-owned", () => {
    const fields = getOperatorOwnedFields({ table: "sales", salesChannel: "Mercari" });
    for (const field of [
      "B2BItemCode",
      "requested_delivery_date",
      "requested_delivery_time",
      "shipping_name",
      "shipping_postal_code",
      "shipping_state",
      "shipping_city",
      "shipping_address_1",
      "shipping_address_2",
      "shipping_phone_number",
      "billing_name",
      "billing_postal_code",
      "billing_state",
      "billing_city",
      "billing_address_1",
      "billing_address_2",
      "order_comments",
      "shipping_carrier",
      "shipping_tracking_info",
      "shipping_completed_at",
    ]) {
      assert.ok(fields.includes(field), `${field} should be operator-owned`);
    }
  });

  it("allows Mercari ingest to update order_status, payment_date, and buyer-message fields on existing sales rows", () => {
    assert.deepEqual(getOwnedFields({ phase: "pull_shop_orders", table: "sales" }), [
      "order_status",
      "payment_date",
      "latest_buyer_message_id",
      "latest_buyer_message_at",
      "has_buyer_messages",
      "message_last_synced_at",
    ]);
  });

  it("filters existing-row ingest patches to owned fields only", () => {
    const patch = {
      order_status: "Waiting for Shipping",
      payment_date: "2026-06-19T01:00:00Z",
      B2BItemCode: "MANUAL-B2B",
      requested_delivery_date: "2026-06-25",
      requested_delivery_time: "AM",
      shipping_address_1: "manual address",
      order_comments: "manual note",
    };
    assert.deepEqual(filterPatchToOwnedFields({
      phase: "pull_shop_orders",
      table: "sales",
      salesChannel: "Mercari",
      patch,
    }), {
      order_status: "Waiting for Shipping",
      payment_date: "2026-06-19T01:00:00Z",
    });
  });

  it("throws when a phase patch contains disallowed fields", () => {
    assert.throws(
      () => assertPatchOwnsOnlyAllowedFields({
        phase: "pull_shop_orders",
        table: "sales",
        patch: { order_status: "Waiting for Shipping", B2BItemCode: "manual" },
      }),
      /B2BItemCode/,
    );
  });

  it("finds operator-owned fields inside candidate patches", () => {
    assert.deepEqual(findOperatorFieldsInPatch({
      table: "sales",
      patch: {
        order_status: "Waiting for Shipping",
        B2BItemCode: "manual",
        shipping_city: "Tokyo",
      },
    }), ["B2BItemCode", "shipping_city"]);
  });

  it("returns protected fields as preserved fields", () => {
    const preserved = getPreservedFields({
      phase: "pull_shop_orders",
      table: "sales",
      salesChannel: "Mercari",
    });
    assert.equal(preserved.has("requested_delivery_date"), true);
    assert.equal(preserved.has("B2BItemCode"), true);
  });
});
