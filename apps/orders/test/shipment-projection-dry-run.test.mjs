import assert from "node:assert/strict";
import test from "node:test";
import { projectMercariSalesOrdersToShipment } from "../src/lib/shipment-projector.mjs";
import { projectRakutenSalesOrdersToShipment } from "../src/lib/rakuten-projector.mjs";

function mutationSpies() {
  const calls = { create: 0, patch: 0, delete: 0 };
  return {
    calls,
    createRow: async () => { calls.create += 1; return { ok: true, body: { id: 99 } }; },
    patchRow: async () => { calls.patch += 1; return { ok: true }; },
    deleteRow: async () => { calls.delete += 1; return { ok: true }; },
  };
}

test("Mercari shipment projection dry-run plans a create without mutating rows", async () => {
  const spies = mutationSpies();
  const client = { salesOrderTableId: "sales", shipmentOrderTableId: "shipments" };
  let salesReads = 0;
  const source = {
    id: "sale-1",
    order_id: "order_1",
    order_status: "WAITING_FOR_SHIPPING",
    review_status: "Approved",
    B2BItemCode: "SKU-1",
    original_product_id: "SKU-1",
    product_name: "Product",
    quantity: 1,
    product_price: 1000,
    shop_id: "WMyisFmhbGWyVAPEwsfirn",
  };
  const result = await projectMercariSalesOrdersToShipment({}, { dryRun: true, limit: 1 }, {
    client,
    listAllRows: async (_client, tableId) => {
      if (tableId === "shipments") return [];
      salesReads += 1;
      return salesReads === 1 ? [source] : [];
    },
    allocateOrderCommercialValues: async () => new Map([["sale-1", { unitPrice: 1000 }]]),
    ...spies,
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.side_effects, 0);
  assert.equal(result.planned_created, 1);
  assert.equal(result.results.at(-1).action, "would_create");
  assert.deepEqual(spies.calls, { create: 0, patch: 0, delete: 0 });
});

test("Mercari shipment projection dry-run plans update and dedup without patching or deleting", async () => {
  const spies = mutationSpies();
  const client = { salesOrderTableId: "sales", shipmentOrderTableId: "shipments" };
  let salesReads = 0;
  const source = {
    id: "sale-1", order_id: "order_1", order_status: "WAITING_FOR_SHIPPING",
    review_status: "Approved", B2BItemCode: "SKU-1", original_product_id: "SKU-1",
    product_name: "Product", quantity: 1, product_price: 1000,
    shop_id: "WMyisFmhbGWyVAPEwsfirn",
  };
  const existingRows = [1, 2].map((id) => ({
    id, OrderId: "1", BuyerPlatformSku: "SKU-1",
    SourceStoreID: "WMyisFmhbGWyVAPEwsfirn", SalesChannel: "Mercari",
  }));
  const result = await projectMercariSalesOrdersToShipment({}, { dryRun: true, limit: 1 }, {
    client,
    listAllRows: async (_client, tableId) => {
      if (tableId === "shipments") return existingRows;
      salesReads += 1;
      return salesReads === 1 ? [source] : [];
    },
    allocateOrderCommercialValues: async () => new Map([["sale-1", { unitPrice: 1000 }]]),
    ...spies,
  });

  assert.equal(result.planned_updated, 1);
  assert.equal(result.planned_deduplicated, 1);
  assert.equal(result.side_effects, 0);
  assert.deepEqual(spies.calls, { create: 0, patch: 0, delete: 0 });
});

test("Mercari projection keeps same-number orders in different stores separate", async () => {
  const spies = mutationSpies();
  const client = { salesOrderTableId: "sales", shipmentOrderTableId: "shipments" };
  let salesReads = 0;
  const sources = [
    { id: "sale-1", order_id: "order_same", order_status: "WAITING_FOR_SHIPPING", review_status: "Approved", B2BItemCode: "SKU-1", original_product_id: "SKU-1", product_name: "One", quantity: 1, product_price: 1000, shop_id: "WMyisFmhbGWyVAPEwsfirn" },
    { id: "sale-2", order_id: "same", order_status: "WAITING_FOR_SHIPPING", review_status: "Approved", B2BItemCode: "SKU-2", original_product_id: "SKU-2", product_name: "Two", quantity: 1, product_price: 2000, shop_id: "ZaMyGWzp6hUdgDh5E9ADob" },
  ];
  const result = await projectMercariSalesOrdersToShipment({}, { dryRun: true, limit: 10 }, {
    client,
    listAllRows: async (_client, tableId) => {
      if (tableId === "shipments") return [];
      salesReads += 1;
      return salesReads === 1 ? sources : [];
    },
    allocateOrderCommercialValues: async () => new Map(),
    ...spies,
  });

  assert.equal(result.grouped_orders, 2);
  assert.equal(result.planned_created, 2);
  assert.deepEqual(spies.calls, { create: 0, patch: 0, delete: 0 });
});

test("Rakuten shipment projection dry-run plans a create without mutating rows", async () => {
  const spies = mutationSpies();
  const client = { rakutenSalesOrderTableId: "rakuten-sales", shipmentOrderTableId: "shipments" };
  const source = {
    id: "sale-r1",
    order_id: "rakuten-1",
    order_status: "RMS_CONFIRMED",
    rakuten_status_mapping_state: "MAPPED",
    rakuten_order_progress: "300",
    manage_number: "SKU-R1",
    b2b_item_code: "GIGA-R1",
    product_name: "Rakuten Product",
    quantity: 1,
    product_price: 2000,
  };
  const result = await projectRakutenSalesOrdersToShipment({}, { dryRun: true, limit: 1 }, {
    client,
    listAllRows: async (_client, tableId) => tableId === "rakuten-sales" ? [source] : [],
    ...spies,
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.side_effects, 0);
  assert.equal(result.planned_created, 1);
  assert.equal(result.results.at(-1).action, "would_create");
  assert.deepEqual(spies.calls, { create: 0, patch: 0, delete: 0 });
});

test("Rakuten shipment projection dry-run plans an update without patching", async () => {
  const spies = mutationSpies();
  const client = { rakutenSalesOrderTableId: "rakuten-sales", shipmentOrderTableId: "shipments" };
  const source = {
    id: "sale-r1", order_id: "rakuten-1", order_status: "RMS_CONFIRMED",
    rakuten_status_mapping_state: "MAPPED", rakuten_order_progress: "300",
    manage_number: "SKU-R1", b2b_item_code: "GIGA-R1",
    product_name: "Rakuten Product", quantity: 1, product_price: 2000,
  };
  const existing = [{ id: 7, OrderId: "rakuten-1", BuyerPlatformSku: "SKU-R1", SalesChannel: "Rakuten" }];
  const result = await projectRakutenSalesOrdersToShipment({}, { dryRun: true, limit: 1 }, {
    client,
    listAllRows: async (_client, tableId) => tableId === "rakuten-sales" ? [source] : existing,
    ...spies,
  });

  assert.equal(result.planned_updated, 1);
  assert.equal(result.side_effects, 0);
  assert.deepEqual(spies.calls, { create: 0, patch: 0, delete: 0 });
});

test("Rakuten shipment projection exact-order scope excludes queue-head neighbors", async () => {
  const spies = mutationSpies();
  const client = { rakutenSalesOrderTableId: "rakuten-sales", shipmentOrderTableId: "shipments" };
  const source = (id) => ({
    id: `sale-${id}`, order_id: id, order_status: "RMS_CONFIRMED",
    rakuten_status_mapping_state: "MAPPED", rakuten_order_progress: "300",
    manage_number: `SKU-${id}`, b2b_item_code: `GIGA-${id}`,
    product_name: "Rakuten Product", quantity: 1, product_price: 2000,
  });
  const result = await projectRakutenSalesOrdersToShipment({}, { dryRun: true, limit: 1, orderId: "order_target" }, {
    client,
    listAllRows: async (_client, tableId) => tableId === "rakuten-sales" ? [source("neighbor"), source("target")] : [],
    ...spies,
  });
  assert.equal(result.order_filter, "target");
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].order_id, "target");
  assert.deepEqual(spies.calls, { create: 0, patch: 0, delete: 0 });
});
