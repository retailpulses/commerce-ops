import test from "node:test";
import assert from "node:assert/strict";

import { diagnosticOrderScope } from "../worker/index.js";

test("worker diagnostic scope normalizes order IDs and preserves store identity", () => {
  assert.equal(diagnosticOrderScope(" Shop-A ", "order_SAME"), "shop-a\u0000same");
  assert.notEqual(
    diagnosticOrderScope("shop-a", "same"),
    diagnosticOrderScope("shop-b", "same"),
  );
  assert.equal(diagnosticOrderScope("", "same"), "");
});
