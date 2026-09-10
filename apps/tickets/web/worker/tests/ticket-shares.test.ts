import assert from "node:assert/strict";
import test from "node:test";
import type { Ticket, TicketProduct } from "../src/repositories/ticketRepository";
import {
  BRIDGE_NONCE_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_HEADER,
  bridgeCanonicalString,
  buildTicketShareSnapshot,
  constantTimeHexEqual,
  deriveTicketShareToken,
  hmacSha256Hex,
  isTicketShareSnapshot,
  readBodyTextBounded,
  sha256Hex,
  verifyBridgeRequest,
} from "../src/services/ticketShareService";

const ticket: Ticket = {
  id: "11111111-1111-4111-8111-111111111111",
  ticket_number: "T-20260716-0001",
  platform: "mercari",
  account_id: "22222222-2222-4222-8222-222222222222",
  external_order_id: "ORDER-1",
  external_thread_id: "private-thread",
  origin: "manual",
  customer_display_name: "Buyer Name",
  customer_contact: "buyer@example.test",
  subject: "Internal subject",
  description: "Raw description with private data",
  status: "open",
  priority: "normal",
  issue_types: ["wrong_item"],
  assigned_user_id: "private-user",
  assigned_display_name: "Private operator",
  latest_message_at: null,
  latest_customer_message: "Private message",
  needs_reply: true,
  external_url: "https://admin.example.test/private",
  raw_source_payload: { secret: "raw" },
  started_at: "2026-07-16T00:00:00.000Z",
  created_at: "2026-07-16T00:00:00.000Z",
  updated_at: "2026-07-16T00:00:00.000Z",
  closed_at: null,
};

const product: TicketProduct = {
  id: "33333333-3333-4333-8333-333333333333",
  ticket_id: ticket.id,
  product_id: null,
  variant_id: null,
  listing_id: null,
  listing_sku_id: null,
  sku: "SKU-1",
  quantity: 1,
  role: "primary",
  created_at: ticket.created_at,
  product_name: "Product",
  variant_name: "Blue",
  seller_name: "Seller",
  unit_price: "3980",
  unit_fulfillment_price: "private-cost",
};

test("ticket share token is deterministic and scoped to token + ticket ids", async () => {
  const first = await deriveTicketShareToken("share-secret", ticket.id, product.id);
  const second = await deriveTicketShareToken("share-secret", ticket.id, product.id);
  const other = await deriveTicketShareToken("share-secret", product.id, ticket.id);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("snapshot is an explicit allowlist without structured or free-form source PII", () => {
  const snapshot = buildTicketShareSnapshot(ticket, [product], "Homebliss Shop", "Seller-safe summary");
  assert.deepEqual(snapshot, {
    version: 1,
    seller_description: "Seller-safe summary",
    ticket: {
      ticket_number: ticket.ticket_number,
      platform: "mercari",
      account_name: "Homebliss Shop",
      external_order_id: "ORDER-1",
      status: "open",
      priority: "normal",
      issue_types: ["wrong_item"],
      started_at: ticket.started_at,
    },
    products: [{
      sku: "SKU-1",
      product_name: "Product",
      variant: "Blue",
      role: "primary",
      seller: "Seller",
      unit_price: "3980",
    }],
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "Buyer Name",
    "buyer@example.test",
    "Raw description",
    "Private message",
    "private-cost",
    "admin.example.test",
    "private-thread",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("bridge canonicalization and verification accept one valid signed request", async () => {
  const secret = "bridge-secret";
  const timestamp = "1784163600";
  const nonce = "nonce_1234567890abcdef";
  const body = JSON.stringify({ token: "a".repeat(64) });
  const path = "/api/internal/ticket-shares/resolve";
  const signature = await hmacSha256Hex(
    secret,
    bridgeCanonicalString("POST", path, timestamp, nonce, await sha256Hex(body)),
  );
  const seen = new Set<string>();
  const request = () => new Request(`https://tickets.example.test${path}`, {
    method: "POST",
    body,
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      [BRIDGE_TIMESTAMP_HEADER]: timestamp,
      [BRIDGE_NONCE_HEADER]: nonce,
      [BRIDGE_SIGNATURE_HEADER]: signature,
    },
  });
  const options = {
    secret,
    allowedIps: "203.0.113.10",
    nowMs: Number(timestamp) * 1000,
    claimNonce: async (value: string) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    },
  };

  const first = await verifyBridgeRequest(request(), options);
  assert.equal(first.ok, true);
  assert.equal(first.bodyText, body);
  const replay = await verifyBridgeRequest(request(), options);
  assert.deepEqual({ ok: replay.ok, error: replay.error }, { ok: false, error: "replay" });
});

test("bridge verification rejects wrong source, stale timestamp, and forged signature", async () => {
  const base = {
    method: "POST",
    body: "{}",
    headers: {
      "CF-Connecting-IP": "198.51.100.9",
      [BRIDGE_TIMESTAMP_HEADER]: "1784163600",
      [BRIDGE_NONCE_HEADER]: "nonce_1234567890abcdef",
      [BRIDGE_SIGNATURE_HEADER]: "0".repeat(64),
    },
  };
  const options = {
    secret: "bridge-secret",
    allowedIps: "203.0.113.10",
    nowMs: 1784163600 * 1000,
    claimNonce: async () => true,
  };
  const wrongSource = await verifyBridgeRequest(new Request("https://example.test/internal", base), options);
  assert.equal(wrongSource.error, "source");

  const staleHeaders = new Headers(base.headers);
  staleHeaders.set("CF-Connecting-IP", "203.0.113.10");
  const stale = await verifyBridgeRequest(new Request("https://example.test/internal", {
    ...base,
    headers: staleHeaders,
  }), { ...options, nowMs: options.nowMs + 61_000 });
  assert.equal(stale.error, "timestamp");

  const forgedHeaders = new Headers(staleHeaders);
  const forged = await verifyBridgeRequest(new Request("https://example.test/internal", {
    ...base,
    headers: forgedHeaders,
  }), options);
  assert.equal(forged.error, "signature");
});

test("constant-time comparison fails closed on malformed values", () => {
  assert.equal(constantTimeHexEqual("aa", "aa"), true);
  assert.equal(constantTimeHexEqual("aa", "ab"), false);
  assert.equal(constantTimeHexEqual("aa", "aaa"), false);
  assert.equal(constantTimeHexEqual("zz", "zz"), false);
});

test("bridge verification relies on one atomic nonce claim under concurrency", async () => {
  const secret = "bridge-secret";
  const timestamp = "1784163600";
  const nonce = "nonce_concurrent_123456";
  const body = JSON.stringify({ token: "a".repeat(64) });
  const path = "/api/internal/ticket-shares/resolve";
  const signature = await hmacSha256Hex(
    secret,
    bridgeCanonicalString("POST", path, timestamp, nonce, await sha256Hex(body)),
  );
  let claimed = false;
  const claimNonce = async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };
  const makeRequest = () => new Request(`https://tickets.example.test${path}`, {
    method: "POST",
    body,
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      [BRIDGE_TIMESTAMP_HEADER]: timestamp,
      [BRIDGE_NONCE_HEADER]: nonce,
      [BRIDGE_SIGNATURE_HEADER]: signature,
    },
  });
  const results = await Promise.all([makeRequest(), makeRequest()].map((request) => verifyBridgeRequest(request, {
    secret,
    allowedIps: "203.0.113.10",
    nowMs: Number(timestamp) * 1000,
    claimNonce,
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.error === "replay").length, 1);
});

test("bounded body reader rejects chunked bodies before buffering past the limit", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a".repeat(10)));
      controller.enqueue(new TextEncoder().encode("b".repeat(10)));
      controller.close();
    },
  });
  const request = new Request("https://example.test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.equal(await readBodyTextBounded(request, 15), null);
});

test("snapshot validator rejects nested corrupt DTO fields", () => {
  const snapshot = buildTicketShareSnapshot(ticket, [product], "Homebliss Shop", "Seller-safe summary");
  assert.equal(isTicketShareSnapshot(snapshot), true);
  assert.equal(isTicketShareSnapshot({
    ...snapshot,
    ticket: { ...snapshot.ticket, issue_types: ["wrong_item", { raw: "private" }] },
  }), false);
  assert.equal(isTicketShareSnapshot({
    ...snapshot,
    products: [{ ...snapshot.products[0], unit_price: { internal_cost: "private" } }],
  }), false);
});
