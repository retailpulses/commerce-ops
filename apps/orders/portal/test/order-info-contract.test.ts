import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/detail/OrderInfo.tsx", import.meta.url), "utf8");

test("OrderInfo renders the channel-aware platform SKU", () => {
  assert.match(source, /label="SKU" value=\{order\.platform_sku \|\|/);
  assert.doesNotMatch(source, /label="SKU" value=\{order\.original_product_id \|\|/);
});

test("OrderInfo renders the marketplace payment method", () => {
  assert.match(source, /label="Payment Method" value=\{order\.payment_method \|\| "—"\}/);
});
