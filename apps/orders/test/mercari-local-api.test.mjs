import test from "node:test";
import assert from "node:assert/strict";

import { fetchMercariOrderMessages, fetchMercariOrderStatuses, sendMercariOrderReply } from "../src/lib/mercari-local-api.mjs";

test("local Mercari status reader preserves exact IDs and maps missing results", async () => {
  let captured;
  const result = await fetchMercariOrderStatuses({ MERCARI_TOKENS_PATH: "/not/read" }, {
    shopLabel: "Shop2", orderIds: ["one", "two", "one"],
  }, {
    loadToken: async () => "secret",
    graphql: async (_env, _token, query, variables) => {
      captured = { query, variables };
      return { o0: { id: "one", status: "COMPLETED" }, o1: null };
    },
  });
  assert.deepEqual(captured.variables, { id0: "one", id1: "two" });
  assert.match(captured.query, /o0: orderTransaction/);
  assert.deepEqual(result.orders, [
    { orderId: "one", status: "COMPLETED", found: true },
    { orderId: "two", status: null, found: false },
  ]);
});

test("local Mercari status reader enforces the bounded provider contract", async () => {
  const result = await fetchMercariOrderStatuses({ MERCARI_TOKENS_PATH: "/x" }, {
    shopLabel: "Shop1", orderIds: Array.from({ length: 51 }, (_, index) => String(index)),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds 50/);
});

test("local Mercari message reader preserves normalized message and status contract", async () => {
  const result = await fetchMercariOrderMessages({ MERCARI_TOKENS_PATH: "/not/read" }, {
    shopLabel: "Shop1", orderId: "order-1",
  }, {
    loadToken: async () => "secret",
    graphql: async () => ({ orderTransaction: {
      id: "order-1", status: "WAITING_FOR_PAYMENT",
      messages: [{ id: 7, role: "buyer", message: " hello ", createdAt: "2026-09-07T00:00:00Z" }],
    } }),
  });
  assert.deepEqual(result.body, {
    ok: true,
    status: "WAITING_FOR_PAYMENT",
    messages: [{ id: "7", role: "BUYER", message: "hello", createdAt: "2026-09-07T00:00:00Z" }],
  });
});

test("local Mercari reply writer preserves transaction scope and authoritative message id", async () => {
  let variables;
  const result = await sendMercariOrderReply({ MERCARI_TOKENS_PATH: "/not/read" }, {
    shopLabel: "Shop4", transactionId: "order-4", text: " reminder ",
  }, {
    loadToken: async () => "secret",
    graphql: async (_env, _token, _query, input) => {
      variables = input;
      return { addOrderTransactionMessage: { orderTransaction: { id: "order-4", messages: [
        { id: "message-9", role: "seller", message: "reminder", createdAt: "2026-09-07T01:00:00Z" },
      ] } } };
    },
  });
  assert.deepEqual(variables, { input: { orderTransactionId: "order-4", message: "reminder" } });
  assert.equal(result.body.message.id, "message-9");
  assert.equal(result.ok, true);
});
