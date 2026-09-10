import { describe, it, expect } from "vitest";
import { classifyByKeywords, isOkinawa } from "../src/domain/classify";
import { INQUIRY_TYPE_KEYS } from "../src/config";

describe("classifyByKeywords", () => {
  it("classifies availability inquiries", () => {
    expect(classifyByKeywords("在庫ありますか？")).toBe(
      INQUIRY_TYPE_KEYS["Product availability"],
    );
  });

  it("classifies bulk purchase with まとめ", () => {
    expect(classifyByKeywords("まとめて5点購入したいです")).toBe(
      INQUIRY_TYPE_KEYS["Bulk purchase"],
    );
  });

  it("classifies bulk purchase with quantity counter", () => {
    expect(classifyByKeywords("3脚セットで購入できますか？")).toBe(
      INQUIRY_TYPE_KEYS["Bulk purchase"],
    );
  });

  it("classifies price negotiation", () => {
    expect(classifyByKeywords("値下げしてもらえますか？")).toBe(
      INQUIRY_TYPE_KEYS["Price negotiation"],
    );
  });

  it("classifies scheduled delivery", () => {
    expect(classifyByKeywords("日時指定は可能ですか？")).toBe(
      INQUIRY_TYPE_KEYS["Scheduled delivery"],
    );
  });

  it("classifies shipping related", () => {
    expect(classifyByKeywords("送料はいくらですか？")).toBe(
      INQUIRY_TYPE_KEYS["Shipping related"],
    );
  });

  it("classifies assembly", () => {
    expect(classifyByKeywords("組み立て方はどうなっていますか？")).toBe(
      INQUIRY_TYPE_KEYS["Assembly"],
    );
  });

  it("classifies product spec by dimensions", () => {
    expect(classifyByKeywords("幅は何cmですか？")).toBe(
      INQUIRY_TYPE_KEYS["Product Spec"],
    );
  });

  it("classifies product spec by weight", () => {
    expect(classifyByKeywords("重さは何kgですか？")).toBe(
      INQUIRY_TYPE_KEYS["Product Spec"],
    );
  });

  it("classifies find a product by color question", () => {
    expect(classifyByKeywords("色違いはありますか？")).toBe(
      INQUIRY_TYPE_KEYS["Find a product"],
    );
  });

  it("classifies okinawa inquiry", () => {
    expect(classifyByKeywords("沖縄まで配送できますか？")).toBe(
      INQUIRY_TYPE_KEYS["Okinawa inquiry"],
    );
  });

  it("defaults to Others for unclassified messages", () => {
    expect(classifyByKeywords("こんにちは")).toBe(INQUIRY_TYPE_KEYS["Others"]);
  });

  it("handles empty message", () => {
    expect(classifyByKeywords("")).toBe(INQUIRY_TYPE_KEYS["Others"]);
  });

  it("matches first keyword group in priority order", () => {
    expect(classifyByKeywords("送料と在庫について教えてください")).toBe(
      INQUIRY_TYPE_KEYS["Product availability"],
    );
  });
});

describe("isOkinawa", () => {
  it("detects 沖縄", () => {
    expect(isOkinawa("沖縄まで配送可能ですか？")).toBe(true);
  });

  it("detects 離島", () => {
    expect(isOkinawa("離島への発送はできますか？")).toBe(true);
  });

  it("detects okinawa (case insensitive)", () => {
    expect(isOkinawa("Okinawa shipping?")).toBe(true);
  });

  it("returns false for non-Okinawa messages", () => {
    expect(isOkinawa("東京まで配送可能ですか？")).toBe(false);
  });
});
