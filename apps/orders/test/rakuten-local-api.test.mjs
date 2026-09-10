import assert from "node:assert/strict";
import test from "node:test";
import {
  mapCarrierToRmsCode,
  runRakutenCloseLocal,
  runRakutenConfirmLocal,
  runRakutenIngestLocal,
  runRakutenOrderStatusesLocal,
  toRmsDatetime,
} from "../src/lib/rakuten-local-api.mjs";

test("formats RMS dates in JST without an offset colon", () => {
  assert.equal(toRmsDatetime(new Date("2026-09-07T00:01:02Z")), "2026-09-07T09:01:02+0900");
});

test("discovery searches then reads full version-7 orders", async () => {
  const calls = [];
  const result = await runRakutenIngestLocal({}, { limit: 2 }, {
    now: "2026-09-07T00:00:00Z",
    async postJson(_env, path, body) {
      calls.push({ path, body });
      if (path === "/order/searchOrder") return { orderNumberList: ["A", "B"] };
      return { OrderModelList: [{ orderNumber: "A" }, { orderNumber: "B" }] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.count, 2);
  assert.equal(calls[0].body.limit, 2);
  assert.deepEqual(calls[1], { path: "/order/getOrder", body: { version: 7, orderNumberList: ["A", "B"] } });
});

test("exact status reads skip discovery and enforce the batch bound", async () => {
  const calls = [];
  const result = await runRakutenOrderStatusesLocal({}, { orderNumbers: ["A"] }, {
    async postJson(_env, path, body) { calls.push({ path, body }); return { OrderModelList: [{ orderNumber: "A" }] }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ path: "/order/getOrder", body: { version: 7, orderNumberList: ["A"] } }]);
  const tooMany = await runRakutenOrderStatusesLocal({}, { orderNumbers: Array.from({ length: 51 }, (_, index) => String(index)) });
  assert.equal(tooMany.error, "rakuten_order_ids_exceed_50");
});

test("confirmation preserves the relay-compatible response contract", async () => {
  const result = await runRakutenConfirmLocal({}, { orderNumberList: ["A"] }, {
    async postJson(_env, path, body) {
      assert.equal(path, "/order/confirmOrder");
      assert.deepEqual(body, { orderNumberList: ["A"] });
      return { MessageModelList: [] };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.body.confirmed, ["A"]);
});

test("close reads baskets before a bounded shipping update", async () => {
  const calls = [];
  const result = await runRakutenCloseLocal({}, {
    orderNumber: "A", trackingNo: "TRACK", carrier: "Yamato", shippingDate: "2026-09-07",
  }, {
    async postJson(_env, path, body) {
      calls.push({ path, body });
      if (path === "/order/getOrder") return { OrderModelList: [{ orderNumber: "A", PackageModelList: [{ basketId: 7, ShippingModelList: [] }] }] };
      return { MessageModelList: [{ messageType: "INFO" }] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[1].path, "/order/updateOrderShipping/");
  assert.equal(calls[1].body.BasketidModelList[0].ShippingModelList[0].deliveryCompany, "1001");
  assert.equal(mapCarrierToRmsCode("日本郵便"), "1003");
});

test("provider failures expose only stable error codes", async () => {
  const result = await runRakutenConfirmLocal({}, { orderNumberList: ["A"] }, {
    async postJson() { throw new Error("rakuten_rms_http_401"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "rakuten_rms_http_401");
  assert.deepEqual(result.body.failed, ["A"]);
});
