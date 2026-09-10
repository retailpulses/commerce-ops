import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getUnrepliedTransactions, hasActionableLatestMessage } from "../src/clients/mercari";
import { HOLDING_ACK } from "../src/logic/templates";
import type { MercariMessage, MercariTransaction } from "../src/types";

let originalFetch: typeof globalThis.fetch;

function tx(id: string, messages: MercariMessage[]): MercariTransaction {
  return {
    id,
    status: "COMPLETED",
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
    shop: "Shop1",
    products: [],
    messages,
  };
}

describe("Mercari scan candidate selection", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch!;
  });

  it("treats latest buyer messages and seller holding acks as actionable", () => {
    assert.equal(hasActionableLatestMessage([
      { id: "b1", createdAt: "2026-07-08T01:00:00Z", role: "BUYER", message: "破損しています" },
    ]), true);

    assert.equal(hasActionableLatestMessage([
      { id: "b1", createdAt: "2026-07-08T01:00:00Z", role: "BUYER", message: "破損しています" },
      { id: "s1", createdAt: "2026-07-08T01:05:00Z", role: "SELLER", message: HOLDING_ACK },
    ]), true);

    assert.equal(hasActionableLatestMessage([
      { id: "b1", createdAt: "2026-07-08T01:00:00Z", role: "BUYER", message: "破損しています" },
      { id: "s1", createdAt: "2026-07-08T01:05:00Z", role: "SELLER", message: "交換品を発送しました。" },
    ]), false);
  });

  it("includes seller-holding-latest transactions in deep scan", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        orderTransactions: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            { node: tx("buyer-latest", [
              { id: "b1", createdAt: "2026-07-08T01:00:00Z", role: "BUYER", message: "いつ届きますか" },
            ]) },
            { node: tx("seller-holding-latest", [
              { id: "b2", createdAt: "2026-07-08T01:00:00Z", role: "BUYER", message: "破損しています" },
              { id: "s2", createdAt: "2026-07-08T01:05:00Z", role: "SELLER", message: HOLDING_ACK },
            ]) },
            { node: tx("seller-substantive-latest", [
              { id: "b3", createdAt: "2026-07-08T01:00:00Z", role: "BUYER", message: "破損しています" },
              { id: "s3", createdAt: "2026-07-08T01:05:00Z", role: "SELLER", message: "交換品を発送しました。" },
            ]) },
          ],
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof globalThis.fetch;

    const result = await getUnrepliedTransactions("token", 1, 7);

    assert.deepEqual(result.transactions.map((t) => t.id), [
      "buyer-latest",
      "seller-holding-latest",
    ]);
  });
});
