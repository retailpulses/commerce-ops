import { describe, it } from "node:test";
import assert from "node:assert";
import { isValidToken, isValidAttachmentId } from "../src/utils/validation.js";

describe("isValidToken", () => {
  const validToken =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("accepts 64 lowercase hex chars", () => {
    assert.strictEqual(isValidToken(validToken), true);
  });

  it("accepts 64 hex chars with digits", () => {
    assert.strictEqual(
      isValidToken(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
      true,
    );
  });

  it("accepts 64 mixed-case hex chars", () => {
    assert.strictEqual(
      isValidToken(
        "AABBCCDDEEFF0011223344556677889900112233445566778899001122334455",
      ),
      false,
    );
  });

  it("rejects 63 chars", () => {
    assert.strictEqual(isValidToken(validToken.slice(0, 63)), false);
  });

  it("rejects 65 chars", () => {
    assert.strictEqual(isValidToken(validToken + "a"), false);
  });

  it("rejects non-hex chars", () => {
    assert.strictEqual(
      isValidToken(
        "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
      ),
      false,
    );
  });

  it("rejects empty string", () => {
    assert.strictEqual(isValidToken(""), false);
  });

  it("rejects non-string", () => {
    assert.strictEqual(isValidToken(null), false);
    assert.strictEqual(isValidToken(undefined), false);
    assert.strictEqual(isValidToken(123), false);
  });

  it("rejects uppercase hex", () => {
    assert.strictEqual(
      isValidToken(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      false,
    );
  });

  it("rejects token with special chars", () => {
    assert.strictEqual(
      isValidToken(
        "abc123!@#$%^&*()_+-=[]{}|;:',.<>?/`~abcdefghijklmnopqrstuvwxyz00",
      ),
      false,
    );
  });
});

describe("isValidAttachmentId", () => {
  const validId = "550e8400-e29b-41d4-a716-446655440000";

  it("accepts valid UUID", () => {
    assert.strictEqual(isValidAttachmentId(validId), true);
  });

  it("accepts uppercase UUID", () => {
    assert.strictEqual(
      isValidAttachmentId("550E8400-E29B-41D4-A716-446655440000"),
      true,
    );
  });

  it("rejects non-UUID string", () => {
    assert.strictEqual(isValidAttachmentId("not-a-uuid"), false);
  });

  it("rejects empty string", () => {
    assert.strictEqual(isValidAttachmentId(""), false);
  });

  it("rejects non-string", () => {
    assert.strictEqual(isValidAttachmentId(null), false);
    assert.strictEqual(isValidAttachmentId(undefined), false);
    assert.strictEqual(isValidAttachmentId(123), false);
  });

  it("rejects UUID without dashes", () => {
    assert.strictEqual(
      isValidAttachmentId("550e8400e29b41d4a716446655440000"),
      false,
    );
  });
});
