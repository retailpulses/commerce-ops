import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeShopName, SHOP_TOKENS } from "../src/config/shops";

describe("shop configuration", () => {
  it("normalizes DB shop codes before token lookup", () => {
    assert.equal(normalizeShopName("shop4"), "Shop4");
    assert.equal(normalizeShopName(" SHOP4 "), "Shop4");
    assert.equal(SHOP_TOKENS[normalizeShopName("shop4")!], "SHOP4_API_TOKEN");
  });
});
