/** Template engine — classification-to-category mapping, behavior-driven
 *  Needs Reply, variable substitution, fallback resolution.
 *
 *  This module is platform-agnostic (no KV, no env, no Request/Response).
 *  Template loading is done by the caller (handler) and passed in as data.
 */

import type { ReplyTemplate, RenderedTemplate, TemplateCategory, TemplateBehavior } from "../types";

// ── Allowed template variables ──
export const ALLOWED_VARIABLES = new Set([
  "form_url",
  "shop_name",
  "cancel_fee_link",
  "customer_name",
  "fee_amount",
]);

// ── Category mapping ──

/**
 * Map classifier output to a stable template category.
 * Normalizes "information-only" (classifier convention) to "information_only" (template category).
 */
export function clsToTemplateCategory(
  cls: string,
  subcls: string,
  meta: Record<string, unknown>
): string {
  if (cls === "greeting_only") return "greeting_only";
  if (cls === "information-only") return "information_only";
  if (cls === "suspicious") {
    const hasQualitySignal =
      subcls === "quality_issue" ||
      meta.has_defect_or_damage === true ||
      meta.has_refund_exchange_request === true;
    return hasQualitySignal ? "fuguai_lite" : "holding";
  }
  if (subcls === "quality_issue") {
    const conf = typeof meta.confidence === "number" ? meta.confidence : null;
    // Use the same threshold logic as the handler's FUGUAI vs HOLDING decision
    if (conf === null || conf >= 0.85) return "fuguai";
    return "holding";
  }
  if (cls === "delivery_request") return "none";
  // cancel request + WAITING_FOR_SHIPMENT is handled in the handler loop,
  // not via this function, because it depends on Mercari status + message content.
  // Callers should check that condition BEFORE calling this function.
  return "holding";
}

// ── Behavior mapping ──

const CATEGORY_BEHAVIOR_MAP: Record<string, TemplateBehavior> = {
  greeting_only: "informational_ack",
  information_only: "informational_ack",
  holding: "holding_ack",
  fuguai: "form_request",
  fuguai_lite: "form_request",
  followup_form_helper: "holding_ack",
  cancel_fee: "cancel_fee",
  form_received_ack: "informational_ack",
  custom: "custom",
};

/** Map a template category to its stable behavior. Returns "custom" for unknown categories. */
export function getBehaviorForCategory(category: string): TemplateBehavior {
  return CATEGORY_BEHAVIOR_MAP[category] || "custom";
}

// ── Needs Reply from behavior ──

/**
 * Compute Needs Reply from template behavior + send/skip state.
 * This replaces the old body-text equality checks.
 */
export function needsReplyFromBehavior(
  behavior: TemplateBehavior,
  wasSent: boolean,
  wasSkipped: boolean
): boolean {
  switch (behavior) {
    case "informational_ack":
      return false;
    case "holding_ack":
      return true;
    case "form_request":
      // false when the form was actually sent, true when skipped
      return wasSkipped || !wasSent;
    case "cancel_fee":
      return true;
    case "custom":
      return true;
    default:
      return true;
  }
}

// ── Variable handling ──

const VARIABLE_RE = /\{\{(\w+)\}\}/g;

/** Extract all {{variable_name}} placeholders from a template body. */
export function extractVariables(body: string): string[] {
  const vars = new Set<string>();
  let match;
  while ((match = VARIABLE_RE.exec(body)) !== null) {
    vars.add(match[1]);
  }
  return [...vars];
}

/** Validate that all requested variables are in the allowed set. */
export function validateVariables(vars: string[]): { valid: boolean; unknown: string[] } {
  const unknown = vars.filter((v) => !ALLOWED_VARIABLES.has(v));
  return { valid: unknown.length === 0, unknown };
}

/**
 * Substitute {{variable}} placeholders with provided values.
 * Returns the rendered body and a list of variables that were not provided.
 * Unresolved placeholders are left as-is in the output — callers must check
 * unresolved.length > 0 before sending customer-facing text.
 */
export function applyTemplateVariables(
  body: string,
  vars: Record<string, string>
): { rendered: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const rendered = body.replace(VARIABLE_RE, (match, name) => {
    if (vars[name] !== undefined) return vars[name];
    unresolved.push(name);
    return match; // leave unresolved placeholder as-is
  });
  return { rendered, unresolved };
}

// ── Rendering ──

/** Full render pipeline: extract → validate → substitute → RenderedTemplate. */
export function renderTemplate(
  template: ReplyTemplate | null,
  context: Record<string, string>
): RenderedTemplate {
  if (!template) {
    return {
      body: "",
      category: "custom",
      behavior: "custom",
      templateId: null,
      version: 0,
      hasUnresolvedVariables: true,
      unresolvedVariables: ["__no_template__"],
      isFallback: true,
    };
  }

  const body = template.body;
  const { rendered, unresolved } = applyTemplateVariables(body, context);

  return {
    body: rendered,
    category: template.category as TemplateCategory,
    behavior: template.behavior as TemplateBehavior,
    templateId: template.id,
    version: template.version,
    hasUnresolvedVariables: unresolved.length > 0,
    unresolvedVariables: unresolved,
    isFallback: false,
  };
}

// ── Template loading ──

/**
 * Build a category→template map from a list of templates.
 * Pure function — the caller fetches managed templates from KV.
 * If multiple active templates exist for a category, the most recently
 * updated one wins.
 */
export function buildTemplatesMap(templates: ReplyTemplate[]): Map<string, ReplyTemplate> {
  // Sort by updated_at descending so the first one per category wins
  const sorted = [...templates].sort(
    (a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")
  );
  const map = new Map<string, ReplyTemplate>();
  for (const t of sorted) {
    if (!t.is_active) continue;
    if (!map.has(t.category)) {
      map.set(t.category, t);
    }
  }
  return map;
}

// ── Fallback system ──

export interface TemplateFallback {
  body: string;
  behavior: TemplateBehavior;
}

/**
 * Per-category hardcoded fallback map.
 * Sourced from the current templates.ts constants.
 * Used when no active managed template exists for a category.
 */
export const CATEGORY_FALLBACKS: Map<string, TemplateFallback> = new Map();

// Populated at module load — these are the current hardcoded templates
// imported from templates.ts. We import at the bottom to avoid circular deps,
// but since we can't import dynamically in a Worker module scope, we expose
// a setter so the handler can seed the fallbacks after importing templates.ts.
export function seedFallbacks(fallbacks: Map<string, TemplateFallback>): void {
  for (const [cat, fb] of fallbacks) {
    CATEGORY_FALLBACKS.set(cat, fb);
  }
}

/** Resolve a template for a given category.
 *  Lookup chain: managed template (KV) → per-category hardcoded fallback.
 *  Returns body + behavior regardless of source. */
export function resolveTemplate(
  category: string,
  templatesMap: Map<string, ReplyTemplate>,
  fallbacks: Map<string, TemplateFallback>
): { template: ReplyTemplate | null; body: string; behavior: TemplateBehavior; isFallback: boolean } {
  // Try managed template first
  const managed = templatesMap.get(category);
  if (managed && managed.is_active) {
    return {
      template: managed,
      body: managed.body,
      behavior: managed.behavior as TemplateBehavior,
      isFallback: false,
    };
  }

  // Fall back to hardcoded per-category template
  const fallback = fallbacks.get(category);
  if (fallback) {
    return {
      template: null,
      body: fallback.body,
      behavior: fallback.behavior,
      isFallback: true,
    };
  }

  // Last resort: generic holding ack
  const genericFallback = fallbacks.get("holding");
  if (genericFallback) {
    return {
      template: null,
      body: genericFallback.body,
      behavior: genericFallback.behavior,
      isFallback: true,
    };
  }

  // Absolute last resort (should never happen if seedFallbacks was called)
  return {
    template: null,
    body: "ご連絡ありがとうございます。内容を確認のうえ対応しております。",
    behavior: "holding_ack",
    isFallback: true,
  };
}
