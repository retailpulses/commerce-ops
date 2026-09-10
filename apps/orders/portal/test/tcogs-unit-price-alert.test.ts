import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const table = readFileSync(new URL("../src/components/orders/OrderTable.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../src/components/detail/MarginBreakdown.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../src/components/detail/OrderDetailDrawer.tsx", import.meta.url), "utf8");
const filters = readFileSync(new URL("../src/components/layout/FilterBar.tsx", import.meta.url), "utf8");

test("Effective COGS equality warning stays highly visible across the operator workflow", () => {
  assert.match(table, /shadow-\[inset_5px_0_0_#f97316\]/);
  assert.match(table, /⚠ Effective COGS = Giga Unit Price/);
  assert.match(detail, /role="alert"/);
  assert.match(detail, /Supplier price needs confirmation/);
  assert.match(drawer, /Confirm or negotiate the supplier price before approval or purchase/);
});

test("operator can filter orders needing supplier price confirmation", () => {
  assert.match(filters, /value: "price_confirmation_needed"/);
  assert.match(filters, /label: "Price confirmation needed"/);
});
