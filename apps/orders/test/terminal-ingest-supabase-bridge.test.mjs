import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { propagateTerminalSalesStatuses } from "../scripts/migrate-to-supabase.mjs";

function createExistingRowClient(existingRow, precedingRows = []) {
  const state = { ...existingRow };
  const storedRows = [...precedingRows.map((row) => ({ ...row })), state];
  const calls = [];
  return {
    state,
    calls,
    from(table) {
      assert.equal(table, "sales_orders");
      return {
        select() {
          return {
            order(column, options) {
              assert.equal(column, "id");
              assert.deepEqual(options, { ascending: true });
              return {
                async range(from, to) {
                  calls.push({ operation: "read", from, to });
                  return { data: storedRows.slice(from, to + 1).map((row) => ({ ...row })), error: null };
                },
              };
            },
          };
        },
        update(payload) {
          calls.push({ operation: "update", payload });
          return {
            in(column, ids) {
              assert.equal(column, "id");
              assert.deepEqual(ids, [state.id]);
              return {
                async select() {
                  Object.assign(state, payload);
                  return { data: [{ ...state }], error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

test("terminal ingest bridge updates an existing Supabase row without overwriting canonical fields", async () => {
  const client = createExistingRowClient({
    id: "existing-row-uuid",
    sales_channel: "mercari",
    order_id: "existing-order",
    source_store_id: "shop-id",
    product_name: "Product",
    order_status: "WAITING_FOR_SHIPPING",
    review_status: "APPROVED",
    order_comments: "canonical Supabase memo",
  });

  const result = await propagateTerminalSalesStatuses(client, [{
    sales_channel: "mercari",
    order_id: "existing-order",
    source_store_id: "shop-id",
    product_name: "Product",
    order_status: "COMPLETED",
    review_status: null,
    order_comments: "stale Baserow memo",
  }]);

  assert.equal(result.errors, 0);
  assert.equal(result.updated, 1);
  assert.equal(client.state.order_status, "COMPLETED");
  assert.equal(client.state.review_status, null);
  assert.equal(client.state.order_comments, "canonical Supabase memo");
  assert.deepEqual(client.calls, [
    { operation: "read", from: 0, to: 999 },
    { operation: "update", payload: {
      order_status: "COMPLETED",
      review_status: null,
    } },
  ]);
});

test("terminal propagation skips rows that already satisfy the invariant", async () => {
  const client = createExistingRowClient({
    id: "existing-row-uuid",
    sales_channel: "mercari",
    order_id: "existing-order",
    source_store_id: "shop-id",
    product_name: null,
    order_status: "CANCELED",
    review_status: null,
  });

  const result = await propagateTerminalSalesStatuses(client, [{
    sales_channel: "mercari",
    order_id: "existing-order",
    source_store_id: "shop-id",
    product_name: null,
    order_status: "CANCELED",
    review_status: null,
  }]);

  assert.equal(result.updated, 0);
  assert.equal(result.errors, 0);
  assert.deepEqual(client.calls, [{ operation: "read", from: 0, to: 999 }]);
});

test("terminal propagation ignores active source rows", async () => {
  const client = createExistingRowClient({
    id: "existing-row-uuid",
    sales_channel: "mercari",
    order_id: "existing-order",
    source_store_id: "shop-id",
    product_name: "Product",
    order_status: "WAITING_FOR_SHIPPING",
    review_status: "APPROVED",
  });

  const result = await propagateTerminalSalesStatuses(client, [{
    sales_channel: "mercari",
    order_id: "existing-order",
    source_store_id: "shop-id",
    product_name: "Product",
    order_status: "WAITING_FOR_SHIPPING",
  }]);

  assert.equal(result.updated, 0);
  assert.equal(result.errors, 0);
  assert.deepEqual(client.calls, []);
});

test("terminal propagation finds an existing candidate beyond the first PostgREST page", async () => {
  const precedingRows = Array.from({ length: 1000 }, (_, index) => ({
    id: `filler-${String(index).padStart(4, "0")}`,
    sales_channel: "mercari",
    order_id: `filler-order-${index}`,
    source_store_id: "shop-id",
    product_name: null,
    order_status: "COMPLETED",
    review_status: null,
  }));
  const client = createExistingRowClient({
    id: "target-row-uuid",
    sales_channel: "mercari",
    order_id: "later-page-order",
    source_store_id: "shop-id",
    product_name: null,
    order_status: "WAITING_FOR_SHIPPING",
    review_status: "APPROVED",
  }, precedingRows);

  const result = await propagateTerminalSalesStatuses(client, [{
    sales_channel: "mercari",
    order_id: "later-page-order",
    source_store_id: "shop-id",
    product_name: null,
    order_status: "COMPLETED",
  }]);

  assert.equal(result.updated, 1);
  assert.equal(client.state.order_status, "COMPLETED");
  assert.equal(client.state.review_status, null);
  assert.deepEqual(client.calls.slice(0, 2), [
    { operation: "read", from: 0, to: 999 },
    { operation: "read", from: 1000, to: 1999 },
  ]);
  assert.equal(client.calls[2].operation, "update");
});

test("relay enables terminal propagation for synchronous ingest", async () => {
  const relaySource = await readFile(new URL("../relay/server.mjs", import.meta.url), "utf8");
  assert.equal(relaySource.match(/"--propagate-terminal-statuses"/g)?.length, 1);
});
