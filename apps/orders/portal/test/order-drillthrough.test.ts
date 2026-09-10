import assert from "node:assert/strict";
import test from "node:test";
import { orderFiltersFromSearch } from "../src/lib/order-drillthrough.ts";

test("On Hold drill-through opens the active On Hold queue", () => {
  assert.deepEqual(orderFiltersFromSearch("?lifecycle=active&review=on_hold"), {
    channel: "all",
    lifecycle: "active",
    review: "on_hold",
    attention: "any",
    shop: "",
    search: "",
  });
});

test("Waiting for Payment drill-through opens its lifecycle queue", () => {
  assert.equal(orderFiltersFromSearch("?lifecycle=waiting_for_payment").lifecycle, "waiting_for_payment");
});

test("unknown URL filters do not change the default operator queue", () => {
  assert.deepEqual(orderFiltersFromSearch("?lifecycle=invalid&review=unknown"), {
    channel: "all",
    lifecycle: "active",
    review: "any",
    attention: "any",
    shop: "",
    search: "",
  });
});
