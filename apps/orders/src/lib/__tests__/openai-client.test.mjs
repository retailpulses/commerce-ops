// ── Unit tests for openai-client.mjs ──────────────────────────────
import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert/strict";
import { callOpenAI, buildSystemPrompt } from "../openai-client.mjs";

describe("buildSystemPrompt", () => {
  it("returns a non-empty Japanese polish rules string", () => {
    const prompt = buildSystemPrompt();
    assert.ok(typeof prompt === "string", "should return a string");
    assert.ok(prompt.length > 100, "should be substantial");
  });

  it("includes key polish rules", () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes("敬語"), "should mention keigo");
    assert.ok(prompt.includes("ホムブリスカスタマーサポート"), "should include signature brand");
    assert.ok(prompt.includes("polish"), "should mention polish");
    assert.ok(prompt.includes("proofread"), "should mention proofread");
    assert.ok(prompt.includes("markdown"), "should prohibit markdown");
  });
});

describe("callOpenAI", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = null; // will be overridden per test
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns error when API key is missing", async () => {
    const result = await callOpenAI("", [{ role: "user", content: "test" }]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.ok(result.error.message.includes("not configured"));
  });

  it("makes a POST request with correct headers and body", async () => {
    /** @type {Request|null} */
    let capturedRequest = null;

    globalThis.fetch = async (url, init) => {
      capturedRequest = new Request(url, init);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "こんにちは" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "gpt-4o",
      }), { status: 200 });
    };

    const messages = [{ role: "user", content: "hello" }];
    const result = await callOpenAI("sk-test-key", messages, {
      model: "gpt-4o",
      temperature: 0.3,
      maxTokens: 500,
    });

    assert.equal(result.ok, true);
    assert.ok(capturedRequest, "fetch should have been called");

    const body = JSON.parse(await capturedRequest.text());
    assert.equal(body.model, "gpt-4o");
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 500);
    assert.deepEqual(body.messages, messages);
    assert.equal(capturedRequest.headers.get("Authorization"), "Bearer sk-test-key");
    assert.equal(capturedRequest.headers.get("Content-Type"), "application/json");
  });

  it("returns parsed response on success", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: " こんにちは、田中様 " }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "gpt-4o-2024-05-13",
    }), { status: 200 });

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }]);
    assert.equal(result.ok, true);
    assert.equal(result.choices[0].message.role, "assistant");
    assert.equal(result.choices[0].message.content, "こんにちは、田中様"); // trimmed
    assert.equal(result.usage.total_tokens, 15);
    assert.equal(result.model, "gpt-4o-2024-05-13");
    assert.equal(result.finish_reason, "stop");
  });

  it("exposes finish_reason when length", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "途中で切れたテキスト" }, finish_reason: "length" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      model: "gpt-4o",
    }), { status: 200 });

    const result = await callOpenAI("sk-test", [{ role: "user", content: "long draft" }]);
    assert.equal(result.ok, true);
    assert.equal(result.finish_reason, "length");
  });

  it("retries on 429 rate limit and succeeds", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "finally works" }, finish_reason: "stop" }],
        usage: null,
        model: "gpt-4o",
      }), { status: 200 });
    };

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }], { maxRetries: 3 });
    assert.equal(result.ok, true);
    assert.ok(callCount >= 3, `should have retried, got ${callCount} calls`);
  });

  it("returns error after exhausting retries on 429", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 });

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }], { maxRetries: 2 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
  });

  it("does NOT retry on 401 (auth failure)", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 });
    };

    const result = await callOpenAI("sk-bad-key", [{ role: "user", content: "hi" }]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(callCount, 1, "should NOT retry on 401");
  });

  it("retries on 5xx server errors", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 2) {
        return new Response(JSON.stringify({ error: { message: "Internal error" } }), { status: 500 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: null,
        model: "gpt-4o",
      }), { status: 200 });
    };

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }], { maxRetries: 2 });
    assert.equal(result.ok, true);
    assert.ok(callCount >= 2, "should have retried on 5xx");
  });

  it("handles JSON parse failure gracefully", async () => {
    globalThis.fetch = async () => new Response("not json {{{", { status: 200 });

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }], { maxRetries: 1 });
    assert.equal(result.ok, false);
  });

  it("times out via AbortController", async () => {
    globalThis.fetch = async (_url, init) => {
      // Simulate timeout by never resolving and letting abort fire
      return new Promise((_, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }
        // Don't resolve — let the test's AbortController fire
      });
    };

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }], {
      timeoutMs: 50,
      maxRetries: 1,
    });
    assert.equal(result.ok, false);
  });

  it("uses default options when not provided", async () => {
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: null,
        model: "gpt-4o",
      }), { status: 200 });
    };

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }]);
    assert.equal(result.ok, true);
    assert.equal(capturedBody.model, "gpt-4o");
    assert.equal(capturedBody.temperature, 0.3);
    assert.equal(capturedBody.max_tokens, 500);
  });

  it("handles empty response content", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "" } }],
      usage: null,
      model: "gpt-4o",
    }), { status: 200 });

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }]);
    assert.equal(result.ok, true);
    assert.equal(result.choices[0].message.content, "");
  });

  it("handles missing choices array", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ usage: null }), { status: 200 });

    const result = await callOpenAI("sk-test", [{ role: "user", content: "hi" }]);
    assert.equal(result.ok, true);
    assert.equal(result.choices[0].message.content, "");
  });
});
