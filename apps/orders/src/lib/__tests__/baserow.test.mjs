// ── Unit tests for baserow.mjs ────────────────────────────────
import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { listRowsWithLimit, BASEROW_FIELD, BASEROW_OPTION } from "../baserow.mjs";

describe("listRowsWithLimit", () => {
  it("is exported as a function", () => {
    assert.equal(typeof listRowsWithLimit, "function");
  });

  it("BASEROW_OPTION.REVIEW_STATUS has expected shape", () => {
    assert.ok(BASEROW_OPTION.REVIEW_STATUS.PENDING_REVIEW);
    assert.ok(BASEROW_OPTION.REVIEW_STATUS.APPROVED);
    assert.ok(BASEROW_OPTION.REVIEW_STATUS.ON_HOLD);
  });

  it("BASEROW_FIELD.SALES has expected keys", () => {
    assert.ok(BASEROW_FIELD.SALES.ORDER_ID);
    assert.ok(BASEROW_FIELD.SALES.SHOP_ID);
    assert.ok(BASEROW_FIELD.SALES.REVIEW_STATUS);
    assert.ok(BASEROW_FIELD.SALES.ORDER_STATUS);
  });
});
