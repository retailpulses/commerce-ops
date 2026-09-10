// ── OpenAI API Client ─────────────────────────────────────────────
//
// Zero npm dependencies — uses raw fetch() to OpenAI chat completions.
// Pattern adapted from inquiry-automation/apps/worker/src/clients/openai.ts
// and inquiry-automation/src/drafting/llm_draft.py.
//
// Exports:
//   callOpenAI(apiKey, messages, options) → { choices, usage, model }
//   buildSystemPrompt() → string (Japanese drafting rules)
// ──────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const API_BASE_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Call OpenAI chat completions with retry + exponential backoff + jitter.
 *
 * @param {string} apiKey - OpenAI API key
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options]
 * @param {string} [options.model] - default "gpt-4o"
 * @param {number} [options.temperature] - default 0.3
 * @param {number} [options.maxTokens] - default 500
 * @param {number} [options.timeoutMs] - default 30000
 * @param {number} [options.maxRetries] - default 3
 * @returns {Promise<Object>} { ok, choices, usage, model, finish_reason } on success,
 *                            { ok: false, error, status } on failure
 */
export async function callOpenAI(apiKey, messages, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  if (!apiKey) {
    return { ok: false, error: { message: "API key not configured" }, status: 401 };
  }

  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res;
      try {
        res = await fetch(API_BASE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // 429 Rate Limit — always retry
      if (res.status === 429) {
        lastStatus = 429;
        lastError = { message: "OpenAI rate limit exceeded" };
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return { ok: false, error: lastError, status: 429 };
      }

      // 5xx Server Error — retryable
      if (res.status >= 500) {
        lastStatus = res.status;
        lastError = { message: `OpenAI server error (${res.status})` };
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return { ok: false, error: lastError, status: res.status };
      }

      // Parse response
      let data;
      try {
        data = await res.json();
      } catch (_) {
        lastStatus = res.status;
        lastError = { message: "Failed to parse OpenAI response" };
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return { ok: false, error: lastError, status: res.status };
      }

      // Non-ok response that isn't 429/5xx (e.g. 401, 403)
      if (!res.ok) {
        return {
          ok: false,
          error: data?.error || { message: `OpenAI API error (${res.status})` },
          status: res.status,
        };
      }

      // Success — extract relevant fields
      const content = data?.choices?.[0]?.message?.content || "";
      const finishReason = data?.choices?.[0]?.finish_reason || null;
      return {
        ok: true,
        choices: [{ message: { role: "assistant", content: content.trim() }, finish_reason: finishReason }],
        usage: data?.usage || null,
        model: data?.model || model,
        finish_reason: finishReason,
      };
    } catch (err) {
      // Network error or AbortError (timeout)
      lastStatus = err.name === "AbortError" ? 408 : 0;
      lastError = { message: err.name === "AbortError" ? "Request timed out" : (err.message || "Unknown error") };

      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, error: lastError, status: lastStatus };
    }
  }

  return { ok: false, error: lastError || { message: "Max retries exhausted" }, status: lastStatus || 0 };
}

/**
 * Build the system prompt for Japanese reply polishing / proofreading.
 * The prompt instructs the model to polish and proofread the operator's
 * draft as a Japanese customer support specialist, not to generate from scratch.
 *
 * @returns {string}
 */
export function buildSystemPrompt() {
  return [
    "You are a Japanese customer support specialist for a Mercari furniture shop.",
    "Your job is to polish and proofread the operator's draft reply.",
    "",
    "Rules:",
    "1. Fix any grammar, phrasing, or keigo (敬語) issues while preserving the original intent and key information.",
    "2. Make the message natural and professional for Japanese e-commerce customer support.",
    "3. Keep the same factual content — do not add new information, promises, or commitments.",
    "4. Use double newlines (\\n\\n) between EVERY paragraph.",
    "5. The signature line 'ホムブリスカスタマーサポート' must be on its own paragraph.",
    "6. Do NOT use markdown code blocks, backticks, or JSON wrappers.",
    "7. Do NOT include any extra labels like 'Draft:' or 'Reply:' or 'Polished:'.",
    "8. If the draft is already well-written, make only minimal improvements.",
  ].join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Exponential backoff with jitter.
 * base * 2^(attempt-1) + random(0, 1000), capped at 15s.
 */
function backoffMs(attempt) {
  const base = 1000;
  const exp = Math.pow(2, attempt - 1);
  const jitter = Math.random() * 1000;
  return Math.min(base * exp + jitter, 15000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
