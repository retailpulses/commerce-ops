import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("relay exposes only the canonical Mercari close batch endpoint", async () => {
  const source = await readFile(new URL("../relay/server.mjs", import.meta.url), "utf8");
  assert.match(source, /url\.pathname === "\/admin\/close-shipped-orders"/);
  assert.doesNotMatch(source, /url\.pathname === "\/admin\/close-shipped-order"/);
  assert.doesNotMatch(source, /MERCARI_SHIPPING_CLOSE_SCRIPT_PATH/);
  assert.doesNotMatch(source, /mercari_shop_shipping_close_loop\.mjs/);
});
