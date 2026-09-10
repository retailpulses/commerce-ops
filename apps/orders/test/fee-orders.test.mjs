// ── Fee Orders — Unit Tests ─────────────────────────────────────────
// Tests for isFeeRow, getCustomerKey, pickBestMainOrder, and main_shipped.
// Pure functions extracted from worker/index.js for testability.
// ────────────────────────────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Test data ───────────────────────────────────────────────

const FEE_PATTERNS = ["各種手数料", "追加支払い・追加送料専用"];

function text(v) {
  return v == null ? "" : String(v).trim();
}

function isFeeRow(productName) {
  const normalized = text(productName);
  for (const pattern of FEE_PATTERNS) {
    if (normalized.includes(pattern)) return true;
    if (normalized === pattern) return true;
  }
  return false;
}

function getCustomerKey(row) {
  const phone = String(row?.shipping_phone_number || "").trim();
  const shop = String(row?.shop_id || "").trim();
  if (phone && shop) return `phone:${phone}:${shop}`;
  const name = String(row?.shipping_name || "").trim();
  const postal = String(row?.shipping_postal_code || "").trim();
  if (name && postal && shop) return `name:${name}:${postal}:${shop}`;
  return null;
}

function readSelectValue(v) {
  if (v == null) return "";
  if (typeof v === "object" && v !== null) return String(v.value || "");
  return String(v);
}

function pickBestMainOrder(candidates, targetKey, keyFn) {
  const matching = candidates.filter((r) => keyFn(r) === targetKey);
  if (matching.length === 0) return null;
  if (matching.length === 1) {
    const r = matching[0];
    return {
      order_id: text(r.order_id),
      product_name: text(r.product_name),
      order_status: text(r.order_status),
      review_status: readSelectValue(r.review_status),
      shipping_completed_at: text(r.shipping_completed_at),
      purchase_date: text(r.purchase_date),
      purchase_date_jst: text(r.purchase_date),
    };
  }
  matching.sort((a, b) => {
    const aDate = text(a.purchase_date) || "";
    const bDate = text(b.purchase_date) || "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0);
  });
  const r = matching[0];
  return {
    order_id: text(r.order_id),
    product_name: text(r.product_name),
    order_status: text(r.order_status),
    review_status: readSelectValue(r.review_status),
    shipping_completed_at: text(r.shipping_completed_at),
    purchase_date: text(r.purchase_date),
    purchase_date_jst: text(r.purchase_date),
  };
}

function isMainShipped(main) {
  return !!(main && main.shipping_completed_at);
}

// ── 1. isFeeRow ─────────────────────────────────────────────

describe("isFeeRow", () => {
  it("matches 各種手数料", () => {
    assert.equal(isFeeRow("各種手数料"), true);
  });
  it("matches 追加支払い・追加送料専用", () => {
    assert.equal(isFeeRow("追加支払い・追加送料専用"), true);
  });
  it("matches fee pattern within longer name", () => {
    assert.equal(isFeeRow("【送料】各種手数料（追加分）"), true);
  });
  it("matches pattern at start of name", () => {
    assert.equal(isFeeRow("各種手数料 - 追加"), true);
  });
  it("does not match normal product", () => {
    assert.equal(isFeeRow("冷凍庫 198L 2ドア"), false);
  });
  it("returns false for empty string", () => {
    assert.equal(isFeeRow(""), false);
  });
  it("returns false for whitespace-only", () => {
    assert.equal(isFeeRow("   "), false);
  });
  it("returns false for null-ish input", () => {
    assert.equal(isFeeRow(null), false);
    assert.equal(isFeeRow(undefined), false);
  });
  it("is case-sensitive (Japanese has no case, but safety)", () => {
    // ひらがな vs カタカナ — should not match
    assert.equal(isFeeRow("かくしゅてすうりょう"), false);
  });
});

// ── 2. getCustomerKey ───────────────────────────────────────

describe("getCustomerKey", () => {
  it("builds phone-based key when phone + shop present", () => {
    const key = getCustomerKey({
      shipping_phone_number: "090-1234-5678",
      shop_id: "Shop4",
    });
    assert.equal(key, "phone:090-1234-5678:Shop4");
  });
  it("builds name+postal key when phone missing", () => {
    const key = getCustomerKey({
      shipping_phone_number: "",
      shipping_name: "山田太郎",
      shipping_postal_code: "123-4567",
      shop_id: "Shop1",
    });
    assert.equal(key, "name:山田太郎:123-4567:Shop1");
  });
  it("falls back to name+postal when phone is whitespace", () => {
    const key = getCustomerKey({
      shipping_phone_number: "  ",
      shipping_name: "鈴木",
      shipping_postal_code: "987-6543",
      shop_id: "Shop2",
    });
    assert.equal(key, "name:鈴木:987-6543:Shop2");
  });
  it("returns null when all fields empty", () => {
    assert.equal(getCustomerKey({
      shipping_phone_number: "",
      shipping_name: "",
      shipping_postal_code: "",
    }), null);
  });
  it("returns null when shop_id missing", () => {
    assert.equal(getCustomerKey({
      shipping_phone_number: "090-1111-2222",
    }), null);
  });
  it("returns null when name present but postal missing (no fallback)", () => {
    assert.equal(getCustomerKey({
      shipping_name: "田中",
      shop_id: "Shop3",
    }), null);
  });
  it("returns null when postal present but name missing (no fallback)", () => {
    assert.equal(getCustomerKey({
      shipping_postal_code: "111-2222",
      shop_id: "Shop3",
    }), null);
  });
  it("handles null/undefined row", () => {
    assert.equal(getCustomerKey(null), null);
    assert.equal(getCustomerKey(undefined), null);
  });
  it("trims whitespace from phone number", () => {
    const key = getCustomerKey({
      shipping_phone_number: "  090-1234-5678  ",
      shop_id: "Shop1",
    });
    assert.equal(key, "phone:090-1234-5678:Shop1");
  });
});

// ── 3. pickBestMainOrder ────────────────────────────────────

describe("pickBestMainOrder", () => {
  const keyFn = (r) => r._key;

  it("returns null for empty candidates", () => {
    assert.equal(pickBestMainOrder([], "phone:090:Shop4", keyFn), null);
  });
  it("returns single matching candidate", () => {
    const candidates = [
      { id: 1, order_id: "order-A", product_name: "冷凍庫", order_status: "COMPLETED", review_status: { value: "Approved" }, shipping_completed_at: "2026-06-01T10:00:00+09:00", purchase_date: "2026-05-15", _key: "phone:090:Shop4" },
    ];
    const result = pickBestMainOrder(candidates, "phone:090:Shop4", keyFn);
    assert.notEqual(result, null);
    assert.equal(result.order_id, "order-A");
  });
  it("picks newest purchase_date from multiple candidates", () => {
    const candidates = [
      { id: 1, order_id: "order-old", product_name: "冷凍庫", order_status: "COMPLETED", review_status: { value: "Approved" }, shipping_completed_at: null, purchase_date: "2026-05-10", _key: "phone:090:Shop4" },
      { id: 2, order_id: "order-new", product_name: "冷凍庫", order_status: "COMPLETED", review_status: { value: "Approved" }, shipping_completed_at: "2026-06-01T10:00:00+09:00", purchase_date: "2026-05-20", _key: "phone:090:Shop4" },
      { id: 3, order_id: "order-older", product_name: "冷凍庫", order_status: "COMPLETED", review_status: { value: "Approved" }, shipping_completed_at: null, purchase_date: "2026-05-05", _key: "phone:090:Shop4" },
    ];
    const result = pickBestMainOrder(candidates, "phone:090:Shop4", keyFn);
    assert.equal(result.order_id, "order-new");
  });
  it("tie-breaks by lowest row ID on same purchase_date", () => {
    const candidates = [
      { id: 10, order_id: "order-B", product_name: "テーブル", order_status: "WAITING_FOR_SHIPPING", review_status: { value: "Pending Review" }, shipping_completed_at: null, purchase_date: "2026-06-01", _key: "phone:090:Shop4" },
      { id: 5, order_id: "order-A", product_name: "冷凍庫", order_status: "WAITING_FOR_SHIPPING", review_status: { value: "Approved" }, shipping_completed_at: null, purchase_date: "2026-06-01", _key: "phone:090:Shop4" },
    ];
    const result = pickBestMainOrder(candidates, "phone:090:Shop4", keyFn);
    assert.equal(result.order_id, "order-A"); // lower ID
  });
  it("returns null when no candidate matches target key", () => {
    const candidates = [
      { id: 1, order_id: "order-A", product_name: "冷凍庫", order_status: "COMPLETED", review_status: null, shipping_completed_at: null, purchase_date: "2026-05-15", _key: "phone:080:Shop4" },
    ];
    assert.equal(pickBestMainOrder(candidates, "phone:090:Shop4", keyFn), null);
  });
  it("filters out non-matching candidates before picking", () => {
    const candidates = [
      { id: 1, order_id: "order-wrong", product_name: "冷凍庫", order_status: "COMPLETED", review_status: null, shipping_completed_at: null, purchase_date: "2026-06-01", _key: "phone:080:Shop4" },
      { id: 2, order_id: "order-right", product_name: "テーブル", order_status: "WAITING_FOR_SHIPPING", review_status: { value: "Approved" }, shipping_completed_at: null, purchase_date: "2026-05-01", _key: "phone:090:Shop4" },
    ];
    const result = pickBestMainOrder(candidates, "phone:090:Shop4", keyFn);
    assert.equal(result.order_id, "order-right");
  });
});

// ── 4. mainShipped ──────────────────────────────────────────

describe("isMainShipped", () => {
  it("returns true when shipping_completed_at is set", () => {
    assert.equal(isMainShipped({ shipping_completed_at: "2026-06-01T10:00:00+09:00" }), true);
  });
  it("returns false when shipping_completed_at is empty string", () => {
    assert.equal(isMainShipped({ shipping_completed_at: "" }), false);
  });
  it("returns false when shipping_completed_at is null", () => {
    assert.equal(isMainShipped({ shipping_completed_at: null }), false);
  });
  it("returns false when main is null", () => {
    assert.equal(isMainShipped(null), false);
  });
  it("does NOT depend on order_status string", () => {
    // order_status "COMPLETED" is NOT how we determine shipped status
    const main = { order_status: "COMPLETED", shipping_completed_at: "" };
    assert.equal(isMainShipped(main), false);
  });
});
