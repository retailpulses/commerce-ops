/** Message classification: LLM-only intent triage.
 *
 * Deterministic code is reserved for safety guardrails outside this module.
 * Intent labels come from the configured LLM provider. If the primary provider
 * fails, OpenAI can be used as a safety fallback. If all providers fail, return
 * a visible manual-review classification.
 */

import { openaiChatJson } from "../clients/openai";
import type { Classification } from "../types";

// ── Runtime config (injected at startup) ──
let LLM_MODEL = "deepseek-v4-flash";
let LLM_FALLBACK_MODEL = "gpt-4o";
let LLM_MAX_CALLS = 200;
let LLM_CLOSE_THRESHOLD = 0.85;
let LLM_ENABLED = false;

export function setLLMConfig(
  model: string,
  maxCalls: number,
  closeThreshold: number,
  enabled: boolean,
  fallbackModel = "gpt-4o"
) {
  LLM_MODEL = model;
  LLM_FALLBACK_MODEL = fallbackModel;
  LLM_MAX_CALLS = maxCalls;
  LLM_CLOSE_THRESHOLD = closeThreshold;
  LLM_ENABLED = enabled;
}

// Backward-compatible export for older tests/callers. Intent classification no
// longer uses rules; this detector is conservative and informational only.
export function detectOperatorAction(text: string): { required: boolean; reason: string | null } {
  const t = text.toLowerCase();

  if (["振込先", "口座", "口座番号", "普通", "当座", "銀行", "金庫", "信用金庫", "ゆうちょ", "支店"]
    .some((k) => t.includes(k))) {
    return { required: true, reason: "financial_details_provided" };
  }

  // Tracking / carrier inquiries — explicit keywords
  if (["問い合わせ番号", "追跡番号", "配送会社", "伝票番号"].some((k) => t.includes(k))) {
    return { required: true, reason: "tracking_inquiry" };
  }

  // Delivery timing / status inquiries
  if (["いつ届きますか", "いつ届く", "いつ発送", "発送されましたか", "発送状況"].some((k) => t.includes(k))) {
    return { required: true, reason: "delivery_inquiry" };
  }

  // Compound action-request patterns — each requires a specific prefix
  // so bare お願いします (which appears in nearly every message) is excluded.
  const actionPatterns: Array<{ sub: string; reason: string }> = [
    { sub: "ご確認お願い", reason: "payment_confirmation" },
    { sub: "確認お願い", reason: "payment_confirmation" },
    { sub: "ご対応お願い", reason: "manual_action" },
    { sub: "ご返信お願い", reason: "manual_action" },
    { sub: "教えてください", reason: "information_request" },
    { sub: "教えて頂けない", reason: "information_request" },
    { sub: "ご連絡ください", reason: "manual_action" },
    { sub: "ご連絡お願い", reason: "manual_action" },
  ];

  for (const { sub, reason } of actionPatterns) {
    if (t.includes(sub)) return { required: true, reason };
  }

  return { required: false, reason: null };
}

export function classifyMessage(messageText: string): { cls: string; subcls: string } {
  void messageText;
  return { cls: "suspicious", subcls: "unknown" };
}

// ── PII redaction ──

function redactPII(text: string): string {
  if (!text) return "";
  let t = text;
  t = t.replace(/\b\d{2,4}-\d{2,4}-\d{3,4}\b/g, "[PHONE]");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]");
  return t;
}

// ── LLM classification ──

export async function llmClassifyMessage(
  primaryApiKey: string,
  fallbackApiKey: string,
  conversationText: string,
  llmState: { calls: number; cache: Record<string, Record<string, unknown>> }
): Promise<Classification> {
  const manualReview = (source: string, reason: string): Classification => ({
    cls: "suspicious",
    subcls: "unknown",
    meta: {
      source,
      confidence: 0,
      reasons: reason,
      manual_review_required: true,
      operator_action_required: true,
      operator_action_reason: "llm_unavailable",
    },
  });

  if (!LLM_ENABLED) return manualReview("llm_disabled", "LLM classification disabled");

  if (llmState.calls >= LLM_MAX_CALLS) {
    return manualReview("llm_skipped_limit", "LLM max calls reached");
  }

  if (!primaryApiKey && !fallbackApiKey) {
    return manualReview("llm_skipped_no_key", "No primary or fallback LLM API key configured");
  }

  const clean = redactPII(conversationText);
  const cacheKey = String(hashCode(clean));

  if (cacheKey in llmState.cache) {
    const cached = llmState.cache[cacheKey] as unknown as Classification;
    return {
      cls: cached.cls,
      subcls: cached.subcls,
      meta: { ...cached.meta, source: "llm_cache" },
    };
  }

  const systemPrompt =
    "You are a strict customer support triage classifier for a Japanese e-commerce shop. " +
    "Classify the current unresolved buyer support case from the full conversation transcript, not only the latest message. " +
    "Do not rely on keyword shortcuts; reason from the full meaning and message order. " +
    "Defect/damage/missing parts, wrong color/item, abnormal operation, or replacement-part requests anywhere in the unresolved buyer history are quality issues. " +
    "Quality issues have priority over later refund, return, exchange, status, or follow-up messages when the defect context has not been handled yet. " +
    "Refund, return, exchange, cancellation, order-change, receipt/invoice, warranty, or address/contact requests are requests only when no unresolved quality issue is present. " +
    "Shipping status, tracking/carrier, product/how-to, evaluation timing, or other information asks are inquiries. " +
    "Delivery time-slot/date preferences only, with no other support issue, are delivery_request. " +
    "Greeting/info-only is allowed only when there is no explicit or implied action request. " +
    "Negated or hypothetical defect phrases such as 'no defect' or 'if I find a defect later' must not be quality issues unless another concrete defect is present. " +
    "Return ONLY JSON with keys: " +
    "has_defect_or_damage (bool), has_refund_exchange_request (bool), has_delivery_inquiry (bool), " +
    "has_product_question (bool), has_delivery_time_request_only (bool), is_greeting_or_info_only (bool), " +
    "closeable_type (greeting|information|none), has_operator_action_request (bool), " +
    "operator_action_reason (financial_details_provided|payment_confirmation|tracking_inquiry|delivery_status|product_order_check|invoice_or_receipt|warranty|manual_action|other|none), " +
    "confidence (0-1), reasons (short).";

  async function callProvider(apiKey: string, model: string, source: string): Promise<Classification> {
    const out = await openaiChatJson(apiKey, model, systemPrompt, `CONVERSATION transcript:\n${clean}\n\nReturn JSON.`);
    const conf = Number(out.confidence) || 0;
    const meta: Record<string, unknown> = {
      source,
      model,
      confidence: conf,
      reasons: out.reasons as string | undefined,
      has_defect_or_damage: !!out.has_defect_or_damage,
      has_refund_exchange_request: !!out.has_refund_exchange_request,
      has_delivery_inquiry: !!out.has_delivery_inquiry,
      has_product_question: !!out.has_product_question,
      has_delivery_time_request_only: !!out.has_delivery_time_request_only,
      is_greeting_or_info_only: !!out.is_greeting_or_info_only,
    };

    if (out.has_operator_action_request) {
      meta.operator_action_required = true;
      meta.operator_action_reason = out.operator_action_reason || "manual_action";
    }

    if (meta.has_defect_or_damage) return { cls: "real_ticket", subcls: "quality_issue", meta };
    if (meta.has_refund_exchange_request) return { cls: "real_ticket", subcls: "request", meta };
    if (meta.has_delivery_inquiry || meta.has_product_question || meta.operator_action_required) {
      return { cls: "real_ticket", subcls: "inquiry", meta };
    }
    if (meta.has_delivery_time_request_only) return { cls: "delivery_request", subcls: "", meta };

    if (meta.is_greeting_or_info_only && conf >= LLM_CLOSE_THRESHOLD) {
      return {
        cls: out.closeable_type === "information" ? "information-only" : "greeting_only",
        subcls: out.closeable_type === "information" ? "info" : "greeting",
        meta,
      };
    }

    meta.manual_review_required = true;
    meta.operator_action_required = true;
    meta.operator_action_reason = "low_confidence_or_unclear";
    return { cls: "suspicious", subcls: "unknown", meta };
  }

  try {
    if (!primaryApiKey) throw new Error("Primary LLM API key is not configured");
    llmState.calls++;
    const result = await callProvider(primaryApiKey, LLM_MODEL, "llm_deepseek");
    llmState.cache[cacheKey] = result as unknown as Record<string, unknown>;
    return result;
  } catch (e) {
    const primaryError = String(e).slice(0, 200);
    if (fallbackApiKey) {
      try {
        llmState.calls++;
        const fallback = await callProvider(fallbackApiKey, LLM_FALLBACK_MODEL, "llm_openai_fallback");
        fallback.meta.primary_error = primaryError;
        llmState.cache[cacheKey] = fallback as unknown as Record<string, unknown>;
        return fallback;
      } catch (fallbackError) {
        return manualReview(
          "llm_error",
          `primary=${primaryError}; fallback=${String(fallbackError).slice(0, 200)}`
        );
      }
    }
    return manualReview("llm_error", primaryError);
  }
}

function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}
