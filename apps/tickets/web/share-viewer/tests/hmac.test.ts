import { describe, it } from "node:test";
import assert from "node:assert";
import { computeHmacSignature } from "../src/services/hmac.js";

describe("HMAC canonicalization", () => {
  const secret = "test-secret-key-123";
  const method = "POST";
  const path = "/api/internal/ticket-shares/resolve";
  const timestamp = "1700000000";
  const nonce = "abc123-def456";
  const body = '{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';

  it("produces consistent signatures for same input", () => {
    const sig1 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      body,
    );
    const sig2 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      body,
    );
    assert.strictEqual(sig1, sig2);
  });

  it("produces hex string", () => {
    const sig = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      body,
    );
    assert.match(sig, /^[0-9a-f]+$/);
  });

  it("produces different signature for different method", () => {
    const sig1 = computeHmacSignature(
      secret,
      "POST",
      path,
      timestamp,
      nonce,
      body,
    );
    const sig2 = computeHmacSignature(
      secret,
      "GET",
      path,
      timestamp,
      nonce,
      body,
    );
    assert.notStrictEqual(sig1, sig2);
  });

  it("produces different signature for different path", () => {
    const sig1 = computeHmacSignature(
      secret,
      method,
      "/api/internal/ticket-shares/resolve",
      timestamp,
      nonce,
      body,
    );
    const sig2 = computeHmacSignature(
      secret,
      method,
      "/api/internal/ticket-shares/evidence",
      timestamp,
      nonce,
      body,
    );
    assert.notStrictEqual(sig1, sig2);
  });

  it("produces different signature for different timestamp", () => {
    const sig1 = computeHmacSignature(
      secret,
      method,
      path,
      "1700000000",
      nonce,
      body,
    );
    const sig2 = computeHmacSignature(
      secret,
      method,
      path,
      "1700000001",
      nonce,
      body,
    );
    assert.notStrictEqual(sig1, sig2);
  });

  it("produces different signature for different nonce", () => {
    const sig1 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      "abc123",
      body,
    );
    const sig2 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      "xyz789",
      body,
    );
    assert.notStrictEqual(sig1, sig2);
  });

  it("produces different signature for different body", () => {
    const sig1 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      '{"token":"aaa"}',
    );
    const sig2 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      '{"token":"bbb"}',
    );
    assert.notStrictEqual(sig1, sig2);
  });

  it("matches known canonical string expectation", () => {
    const expectedBodyHash =
      "5dd03bd7eb1cf6d1e2d69d4fcafb251e4d03838ea0d84d273216b4f00e98b196";
    const sig = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      body,
    );
    const sig2 = computeHmacSignature(
      secret,
      method,
      path,
      timestamp,
      nonce,
      body,
    );
    assert.strictEqual(sig, sig2);
    assert.match(sig, /^[0-9a-f]{64}$/);
  });
});
