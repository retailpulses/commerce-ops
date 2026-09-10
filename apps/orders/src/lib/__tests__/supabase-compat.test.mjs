import test from "node:test";
import assert from "node:assert/strict";

import { toApplicationRow, toDatabasePayload } from "../supabase.mjs";

test("shipment rows expose the legacy pipeline shape", () => {
  const row = toApplicationRow("giga_shipment_projections", {
    id: "uuid-1",
    order_id: "order-1",
    sales_channel: "mercari",
    source_store_id: "store-1",
    order_from: "Shop2",
    b2b_item_code: "SKU-1",
    ship_to_qty: 2,
    ship_to_address: "1-2-3",
    tracking_carrier: "Yamato",
    tracking_number: "123456",
    giga_sync_status: "ALREADY_EXISTS",
  });

  assert.equal(row.OrderId, "order-1");
  assert.equal(row.SalesChannel, "Mercari");
  assert.equal(row.SourceStoreID, "store-1");
  assert.equal(row.ShipFrom, "Shop2");
  assert.equal(row.B2BItemCode, "SKU-1");
  assert.equal(row.ShipToQty, 2);
  assert.equal(row.ShipToAddressDetail, "1-2-3");
  assert.equal(row.giga_carrier_name, "Yamato");
  assert.equal(row.giga_tracking_info, "123456");
  assert.equal(row.giga_sync_status, "Already Exists");
});

test("shipment payloads become Supabase columns and enum values", () => {
  const payload = toDatabasePayload("giga_shipment_projections", {
    OrderId: "order-1",
    SalesChannel: "Mercari",
    SourceStoreID: "store-1",
    ShipFrom: "Shop2",
    B2BItemCode: "SKU-1",
    ShipToQty: 1,
    ShipToEmail: "unsupported@example.com",
    giga_sync_status: "Already Exists",
  });

  assert.deepEqual(payload, {
    order_id: "order-1",
    sales_channel: "mercari",
    source_store_id: "store-1",
    order_from: "Shop2",
    b2b_item_code: "SKU-1",
    ship_to_qty: 1,
    giga_sync_status: "ALREADY_EXISTS",
  });
});

test("explicit canonical shipment tracking wins over legacy aliases", () => {
  const payload = toDatabasePayload("giga_shipment_projections", {
    tracking_carrier: "Yamato",
    tracking_number: "123456",
    giga_carrier_name: "Yamato",
    giga_tracking_info: "Yamato: 123456",
  });

  assert.equal(payload.tracking_carrier, "Yamato");
  assert.equal(payload.tracking_number, "123456");
});

test("legacy tracking aliases still populate canonical columns when needed", () => {
  const payload = toDatabasePayload("giga_shipment_projections", {
    giga_carrier_name: "Yamato",
    giga_tracking_info: "Yamato: 123456",
  });

  assert.equal(payload.tracking_carrier, "Yamato");
  assert.equal(payload.tracking_number, "Yamato: 123456");
});

test("sales rows preserve legacy aliases while retaining canonical fields", () => {
  const row = toApplicationRow("sales_orders", {
    id: "uuid-2",
    order_id: "order-2",
    source_store_id: "store-2",
    b2b_item_code: "SKU-2",
    tracking_number: "ABC",
    has_unread_messages: true,
  });

  assert.equal(row.shop_id, "store-2");
  assert.equal(row.B2BItemCode, "SKU-2");
  assert.equal(row.shipping_tracking_info, "ABC");
  assert.equal(row.has_buyer_messages, true);
});

test("Rakuten writes receive canonical channel scope", () => {
  const payload = toDatabasePayload("sales_orders", {
    order_id: "rakuten-1",
    order_status: "PENDING_CONFIRMATION",
    product_name: "商品",
    unsupported_legacy_field: "should_be_dropped",
  }, { salesChannelScope: "rakuten" });

  assert.equal(payload.sales_channel, "rakuten");
  assert.equal(payload.source_store_id, "Rakuten");
  assert.equal(payload.unsupported_legacy_field, undefined);
});

test("non-order Supabase tables preserve their native payload", () => {
  const payload = toDatabasePayload("pipeline_run_log", {
    run_id: "run_test",
    step: "push_orders_to_giga",
    ok: true,
    result_counts: { attempted: 3 },
  });

  assert.deepEqual(payload, {
    run_id: "run_test",
    step: "push_orders_to_giga",
    ok: true,
    result_counts: { attempted: 3 },
  });
});

test("sales review_status canonical CANCELED → legacy 'Canceled'", () => {
  const row = toApplicationRow("sales_orders", {
    id: "uuid-cancel",
    order_id: "order-cancel",
    review_status: "CANCELED",
  });
  assert.equal(row.review_status, "Canceled");
});

test("sales review_status legacy 'Canceled' → canonical CANCELED", () => {
  const payload = toDatabasePayload("sales_orders", {
    review_status: "Canceled",
  });
  assert.equal(payload.review_status, "CANCELED");
});
