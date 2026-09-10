import assert from "node:assert/strict";
import test from "node:test";
import { GigaClient } from "../src/lib/giga-client.mjs";

test("Giga createOrder does not retry an ambiguous 5xx", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ success: false, msg: "upstream timeout", code: "E500" }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new GigaClient("id", "secret", "https://giga.test");
    await assert.rejects(() => client.createOrder({ orderNo: "one" }), (error) => error.outcomeUncertain === true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Giga createOrder classifies transport loss as unknown and does not retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("socket reset"); };
  try {
    const client = new GigaClient("id", "secret", "https://giga.test");
    await assert.rejects(() => client.createOrder({ orderNo: "one" }), (error) => error.outcomeUncertain === true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
