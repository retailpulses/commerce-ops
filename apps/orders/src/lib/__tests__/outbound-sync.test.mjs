import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeOrderLines, shouldProcessRow, resolveOutboundOrderFrom } from "../outbound-sync.mjs";

// Minimal row factory for dedupeOrderLines tests.
// The function only reads: sourceStoreId, b2bItemCode, lineItemNumber, shipToQty,
// buyerSkuCommercialValue, buyerSkuDescription, and id.
function row(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    SourceStoreID: overrides.SourceStoreID ?? "store1",
    B2BItemCode: overrides.B2BItemCode ?? "SKU-A",
    LineItemNumber: overrides.LineItemNumber ?? "1",
    ShipToQty: overrides.ShipToQty ?? 1,
    buyerSkuCommercialValue: overrides.buyerSkuCommercialValue ?? 1000,
    buyerSkuDescription: overrides.buyerSkuDescription ?? "Test Product",
    ...overrides,
  };
}

describe("dedupeOrderLines", () => {
  it("no duplicates — single row produces single line", () => {
    const result = dedupeOrderLines([row()], "order-1");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].sku, "SKU-A");
    assert.equal(result.lines[0].qty, 1);
    assert.equal(result.duplicateRowIds.length, 0);
    assert.deepStrictEqual(result.sourceRowIds, [1]);
  });

  it("preserves Supabase UUID row IDs for progress updates", () => {
    const uuid = "6fc157e5-7ae6-4f29-b171-593042fab4a8";
    const result = dedupeOrderLines([row({ id: uuid })], "order-1");

    assert.deepStrictEqual(result.sourceRowIds, [uuid]);
  });

  it("preserves duplicate Supabase UUID row IDs", () => {
    const first = "6fc157e5-7ae6-4f29-b171-593042fab4a8";
    const duplicate = "3a7a7286-aa2d-4c4f-b98a-d6f6a2e48dc2";
    const result = dedupeOrderLines([
      row({ id: first }),
      row({ id: duplicate }),
    ], "order-1");

    assert.deepStrictEqual(result.sourceRowIds, [first]);
    assert.deepStrictEqual(result.duplicateRowIds, [duplicate]);
  });

  it("duplicate qty=1 rows, same lineItemNumber → max(qty)=1, NOT sum=2", () => {
    const result = dedupeOrderLines([
      row({ id: 1, ShipToQty: 1 }),
      row({ id: 2, ShipToQty: 1 }),
    ], "order-1");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 1, "duplicate logical line must use max(qty), not sum");
    assert.deepStrictEqual(result.duplicateRowIds, [2]);
    assert.deepStrictEqual(result.sourceRowIds, [1]);
  });

  it("duplicate rows with different qty → max(qty)=2", () => {
    const result = dedupeOrderLines([
      row({ id: 1, ShipToQty: 2 }),
      row({ id: 2, ShipToQty: 1 }),
    ], "order-1");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 2);
    assert.deepStrictEqual(result.duplicateRowIds, [2]);
  });

  it("distinct lineItemNumbers (same SKU) → sum qty", () => {
    const result = dedupeOrderLines([
      row({ id: 1, LineItemNumber: "1", ShipToQty: 1 }),
      row({ id: 2, LineItemNumber: "2", ShipToQty: 1 }),
    ], "order-1");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 2, "distinct lines with same SKU must sum");
    assert.deepStrictEqual(result.duplicateRowIds, []);
    assert.deepStrictEqual(result.sourceRowIds.sort(), [1, 2]);
  });

  it("different SKUs → separate lines", () => {
    const result = dedupeOrderLines([
      row({ id: 1, B2BItemCode: "SKU-A", ShipToQty: 1 }),
      row({ id: 2, B2BItemCode: "SKU-B", ShipToQty: 1 }),
    ], "order-1");
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].sku, "SKU-A");
    assert.equal(result.lines[1].sku, "SKU-B");
    assert.equal(result.duplicateRowIds.length, 0);
  });

  it("different sourceStoreId → separate lines (not merged across shops)", () => {
    const result = dedupeOrderLines([
      row({ id: 1, SourceStoreID: "shop1", ShipToQty: 1 }),
      row({ id: 2, SourceStoreID: "shop2", ShipToQty: 1 }),
    ], "order-1");
    assert.equal(result.lines.length, 2);
    assert.equal(result.duplicateRowIds.length, 0);
  });

  it("missing lineItemNumber → conservative max(qty), NOT sum", () => {
    const result = dedupeOrderLines([
      row({ id: 1, LineItemNumber: "", ShipToQty: 1 }),
      row({ id: 2, LineItemNumber: "", ShipToQty: 1 }),
    ], "order-1");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 1, "missing lineItemNumber must use max, not sum");
    assert.deepStrictEqual(result.duplicateRowIds, [2]);
  });

  it("mix of known and missing lineItemNumber — known lines summed, missing ignored", () => {
    // One row with known lineItemNumber=1, two with missing. Known line gets max(qty),
    // missing rows are grouped separately with max(qty). They appear as separate scope entries.
    const result = dedupeOrderLines([
      row({ id: 1, LineItemNumber: "1", ShipToQty: 2 }),
      row({ id: 2, LineItemNumber: "", ShipToQty: 1 }),
    ], "order-1");
    // Known line "1" → 1 line, Missing → 1 line in the same scopeKey
    // Actually these end up in different lineItemNumber groups within the same scopeKey
    // But known line and missing line within same scopeKey — the dedup function first groups
    // by (storeId, SKU, lineNo), so "1" and "__missing__" are separate groups.
    // Then at the scope level, knownLines=["1"], hasMissing=true, totalKnownLines=1
    // This hits the "totalKnownLines === 1 && !hasMissing" branch? No, hasMissing=true
    // So it falls through to the multi-line branch — which sums knownLines
    // This is correct: known line qty=2 + missing ignored (not summed)
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 2, "only known lines summed, missing line conservative");
  });

  it("empty rows → empty lines", () => {
    const result = dedupeOrderLines([], "order-1");
    assert.equal(result.lines.length, 0);
    assert.equal(result.duplicateRowIds.length, 0);
    assert.equal(result.sourceRowIds.length, 0);
  });

  it("three rows for same SKU, two same lineItemNumber + one different → max for dupes + sum distinct", () => {
    const result = dedupeOrderLines([
      row({ id: 1, LineItemNumber: "1", ShipToQty: 3 }),
      row({ id: 2, LineItemNumber: "1", ShipToQty: 1 }), // duplicate of line 1, should be max(3,1)=3 not count extra
      row({ id: 3, LineItemNumber: "2", ShipToQty: 2 }), // distinct line
    ], "order-1");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 5, "max(3,1) for line 1 + 2 for line 2 = 5");
    assert.deepStrictEqual(result.duplicateRowIds, [2]);
    // sourceRowIds includes all rows (canonical + duplicates tracked separately)
    assert.deepStrictEqual(result.sourceRowIds.sort(), [1, 2, 3]);
  });
});

describe("shouldProcessRow", () => {
  const now = Date.parse("2026-07-15T03:00:00Z");

  it("processes explicit PENDING projections on normal cron runs", () => {
    assert.equal(shouldProcessRow({ giga_sync_status: "PENDING" }, now, 30), true);
  });

  it("does not reprocess terminal projections", () => {
    assert.equal(shouldProcessRow({ giga_sync_status: "SYNCED" }, now, 30), false);
    assert.equal(shouldProcessRow({ giga_sync_status: "ALREADY_EXISTS" }, now, 30), false);
  });

  it("retries ATTEMPTED projections only after the retry window", () => {
    assert.equal(shouldProcessRow({
      giga_sync_status: "ATTEMPTED",
      giga_sync_attempted_at: "2026-07-15T02:45:00Z",
    }, now, 30), false);
    assert.equal(shouldProcessRow({
      giga_sync_status: "ATTEMPTED",
      giga_sync_attempted_at: "2026-07-15T02:29:59Z",
    }, now, 30), true);
  });
});

describe("resolveOutboundOrderFrom", () => {
  // Use storeId "Rakuten" which is not a known Mercari shop ID,
  // so getMercariShopOrderFromName throws and falls through to the shipFrom catch path.

  it('"HomesBliss Rakuten" (18 chars) truncated to 16', () => {
    assert.equal(resolveOutboundOrderFrom("HomesBliss Rakuten", "Rakuten"), "HomesBliss Rakut");
  });

  it("short value is unchanged", () => {
    assert.equal(resolveOutboundOrderFrom("Shop1", "Rakuten"), "Shop1");
  });

  it("exactly 16 chars is unchanged", () => {
    assert.equal(resolveOutboundOrderFrom("Exactly16Chars!", "Rakuten"), "Exactly16Chars!");
  });
});
