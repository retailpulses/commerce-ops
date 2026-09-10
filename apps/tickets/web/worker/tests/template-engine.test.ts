/**
 * Template engine unit tests.
 *
 * Covers:
 *   1. clsToTemplateCategory — classification → category mapping
 *   2. getBehaviorForCategory — category → behavior mapping
 *   3. needsReplyFromBehavior — behavior → Needs Reply boolean
 *   4. extractVariables / validateVariables — variable handling
 *   5. applyTemplateVariables — placeholder substitution
 *   6. renderTemplate — full render pipeline
 *   7. resolveTemplate — fallback resolution
 *
 * Run: node --import tsx --test tests/template-engine.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  clsToTemplateCategory,
  getBehaviorForCategory,
  needsReplyFromBehavior,
  extractVariables,
  validateVariables,
  applyTemplateVariables,
  renderTemplate,
  resolveTemplate,
  seedFallbacks,
  CATEGORY_FALLBACKS,
} from "../src/logic/template-engine";
import type { ReplyTemplate, TemplateBehavior } from "../src/types";

// ── Seed fallbacks before tests ──
const TEST_FALLBACKS = new Map<string, { body: string; behavior: TemplateBehavior }>();
TEST_FALLBACKS.set("greeting_only", { body: "ご連絡ありがとうございます。", behavior: "informational_ack" });
TEST_FALLBACKS.set("information_only", { body: "ご連絡ありがとうございます。内容承知いたしました。", behavior: "informational_ack" });
TEST_FALLBACKS.set("holding", { body: "ご連絡ありがとうございます。内容を確認のうえ対応しております。", behavior: "holding_ack" });
TEST_FALLBACKS.set("fuguai", { body: "お世話になっております。...FUGUAI...", behavior: "form_request" });
TEST_FALLBACKS.set("fuguai_lite", { body: "お世話になっております。...FUGUAI_LITE...", behavior: "form_request" });
TEST_FALLBACKS.set("followup_form_helper", { body: "お世話になっております。...FOLLOWUP...", behavior: "holding_ack" });
TEST_FALLBACKS.set("cancel_fee", { body: "お客様へ...{{cancel_fee_link}}...", behavior: "cancel_fee" });
TEST_FALLBACKS.set("form_received_ack", { body: "お問い合わせフォームよりご連絡いただき、ありがとうございます。", behavior: "informational_ack" });
seedFallbacks(TEST_FALLBACKS);

// ── Helper: create a mock ReplyTemplate ──
function mockTemplate(overrides: Partial<ReplyTemplate> = {}): ReplyTemplate {
  return {
    id: 1,
    title: "Test Template",
    category: "holding",
    behavior: "holding_ack",
    body: "ご連絡ありがとうございます。{{shop_name}}です。",
    variables: "shop_name",
    is_active: true,
    notes: "",
    version: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as ReplyTemplate;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Category mapping
// ═══════════════════════════════════════════════════════════════════════

describe("clsToTemplateCategory — classification → category", () => {
  it("greeting_only → greeting_only", () => {
    assert.strictEqual(clsToTemplateCategory("greeting_only", "", {}), "greeting_only");
  });

  it("information-only → information_only (normalizes hyphen to underscore)", () => {
    assert.strictEqual(clsToTemplateCategory("information-only", "", {}), "information_only");
  });

  it("quality_issue with high confidence → fuguai", () => {
    assert.strictEqual(clsToTemplateCategory("real_ticket", "quality_issue", { confidence: 0.95 }), "fuguai");
  });

  it("quality_issue with null confidence → fuguai (null treated as >= threshold)", () => {
    assert.strictEqual(clsToTemplateCategory("real_ticket", "quality_issue", { confidence: null }), "fuguai");
  });

  it("quality_issue with low confidence → holding", () => {
    assert.strictEqual(clsToTemplateCategory("real_ticket", "quality_issue", { confidence: 0.5 }), "holding");
  });

  it("suspicious with quality signal → fuguai_lite", () => {
    assert.strictEqual(clsToTemplateCategory("suspicious", "quality_issue", {}), "fuguai_lite");
  });

  it("suspicious with has_defect_or_damage → fuguai_lite", () => {
    assert.strictEqual(clsToTemplateCategory("suspicious", "inquiry", { has_defect_or_damage: true }), "fuguai_lite");
  });

  it("suspicious with has_refund_exchange_request → fuguai_lite", () => {
    assert.strictEqual(clsToTemplateCategory("suspicious", "inquiry", { has_refund_exchange_request: true }), "fuguai_lite");
  });

  it("generic suspicious (no quality signal) → holding", () => {
    assert.strictEqual(clsToTemplateCategory("suspicious", "inquiry", {}), "holding");
  });

  it("delivery_request → none", () => {
    assert.strictEqual(clsToTemplateCategory("delivery_request", "", {}), "none");
  });

  it("unknown cls → holding (fallback)", () => {
    assert.strictEqual(clsToTemplateCategory("unknown_type", "", {}), "holding");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Behavior mapping
// ═══════════════════════════════════════════════════════════════════════

describe("getBehaviorForCategory — category → behavior", () => {
  it("greeting_only → informational_ack", () => {
    assert.strictEqual(getBehaviorForCategory("greeting_only"), "informational_ack");
  });

  it("information_only → informational_ack", () => {
    assert.strictEqual(getBehaviorForCategory("information_only"), "informational_ack");
  });

  it("holding → holding_ack", () => {
    assert.strictEqual(getBehaviorForCategory("holding"), "holding_ack");
  });

  it("fuguai → form_request", () => {
    assert.strictEqual(getBehaviorForCategory("fuguai"), "form_request");
  });

  it("fuguai_lite → form_request", () => {
    assert.strictEqual(getBehaviorForCategory("fuguai_lite"), "form_request");
  });

  it("followup_form_helper → holding_ack", () => {
    assert.strictEqual(getBehaviorForCategory("followup_form_helper"), "holding_ack");
  });

  it("cancel_fee → cancel_fee", () => {
    assert.strictEqual(getBehaviorForCategory("cancel_fee"), "cancel_fee");
  });

  it("form_received_ack → informational_ack", () => {
    assert.strictEqual(getBehaviorForCategory("form_received_ack"), "informational_ack");
  });

  it("custom → custom", () => {
    assert.strictEqual(getBehaviorForCategory("custom"), "custom");
  });

  it("unknown category → custom", () => {
    assert.strictEqual(getBehaviorForCategory("nonexistent"), "custom");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Needs Reply from behavior
// ═══════════════════════════════════════════════════════════════════════

describe("needsReplyFromBehavior — behavior → Needs Reply", () => {
  it("informational_ack → false (regardless of send/skip)", () => {
    assert.strictEqual(needsReplyFromBehavior("informational_ack", true, false), false);
    assert.strictEqual(needsReplyFromBehavior("informational_ack", false, true), false);
  });

  it("holding_ack → true (regardless of send/skip)", () => {
    assert.strictEqual(needsReplyFromBehavior("holding_ack", true, false), true);
    assert.strictEqual(needsReplyFromBehavior("holding_ack", false, true), true);
  });

  it("form_request sent → false", () => {
    assert.strictEqual(needsReplyFromBehavior("form_request", true, false), false);
  });

  it("form_request skipped → true", () => {
    assert.strictEqual(needsReplyFromBehavior("form_request", false, true), true);
  });

  it("form_request not sent (both false) → true", () => {
    assert.strictEqual(needsReplyFromBehavior("form_request", false, false), true);
  });

  it("cancel_fee → true", () => {
    assert.strictEqual(needsReplyFromBehavior("cancel_fee", true, false), true);
  });

  it("custom → true", () => {
    assert.strictEqual(needsReplyFromBehavior("custom", true, false), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Variable extraction
// ═══════════════════════════════════════════════════════════════════════

describe("extractVariables — find {{placeholders}} in body", () => {
  it("finds single variable", () => {
    const vars = extractVariables("Hello {{shop_name}}, thank you.");
    assert.deepStrictEqual(vars, ["shop_name"]);
  });

  it("finds multiple variables", () => {
    const vars = extractVariables("{{shop_name}} charges {{fee_amount}} via {{cancel_fee_link}}");
    assert.deepStrictEqual(vars.sort(), ["cancel_fee_link", "fee_amount", "shop_name"]);
  });

  it("deduplicates repeated variables", () => {
    const vars = extractVariables("{{shop_name}} and {{shop_name}} again");
    assert.deepStrictEqual(vars, ["shop_name"]);
  });

  it("returns empty array when no variables", () => {
    const vars = extractVariables("Plain text with no placeholders.");
    assert.deepStrictEqual(vars, []);
  });

  it("handles empty string", () => {
    const vars = extractVariables("");
    assert.deepStrictEqual(vars, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Variable validation
// ═══════════════════════════════════════════════════════════════════════

describe("validateVariables — check against allowed set", () => {
  it("known variables pass", () => {
    const result = validateVariables(["form_url", "shop_name"]);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.unknown, []);
  });

  it("unknown variables rejected", () => {
    const result = validateVariables(["unknown_var", "shop_name"]);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.unknown, ["unknown_var"]);
  });

  it("all unknown returns valid=false", () => {
    const result = validateVariables(["bad1", "bad2"]);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.unknown, ["bad1", "bad2"]);
  });

  it("empty array is valid", () => {
    const result = validateVariables([]);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.unknown, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Variable rendering
// ═══════════════════════════════════════════════════════════════════════

describe("applyTemplateVariables — substitute placeholders", () => {
  it("known variables substituted", () => {
    const { rendered, unresolved } = applyTemplateVariables(
      "Hello {{shop_name}}, fee is {{fee_amount}} yen.",
      { shop_name: "Shop1", fee_amount: "600" }
    );
    assert.strictEqual(rendered, "Hello Shop1, fee is 600 yen.");
    assert.deepStrictEqual(unresolved, []);
  });

  it("unresolved variables tracked (left as-is, no :UNSET markers)", () => {
    const { rendered, unresolved } = applyTemplateVariables(
      "Hello {{shop_name}}, visit {{form_url}}.",
      { shop_name: "Shop1" }
    );
    assert.strictEqual(rendered, "Hello Shop1, visit {{form_url}}.");
    assert.deepStrictEqual(unresolved, ["form_url"]);
  });

  it("all variables unresolved", () => {
    const { rendered, unresolved } = applyTemplateVariables(
      "{{shop_name}} {{fee_amount}}",
      {}
    );
    assert.strictEqual(rendered, "{{shop_name}} {{fee_amount}}");
    assert.deepStrictEqual(unresolved, ["shop_name", "fee_amount"]);
  });

  it("no variables in body returns empty unresolved", () => {
    const { rendered, unresolved } = applyTemplateVariables(
      "Plain text.",
      { shop_name: "Shop1" }
    );
    assert.strictEqual(rendered, "Plain text.");
    assert.deepStrictEqual(unresolved, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. renderTemplate — full pipeline
// ═══════════════════════════════════════════════════════════════════════

describe("renderTemplate — full render pipeline", () => {
  it("renders with all variables resolved", () => {
    const tmpl = mockTemplate({
      body: "{{shop_name}}よりご連絡です。",
      category: "custom",
      behavior: "custom",
      version: 3,
    });
    const result = renderTemplate(tmpl, { shop_name: "Shop1" });
    assert.strictEqual(result.body, "Shop1よりご連絡です。");
    assert.strictEqual(result.category, "custom");
    assert.strictEqual(result.behavior, "custom");
    assert.strictEqual(result.templateId, 1);
    assert.strictEqual(result.version, 3);
    assert.strictEqual(result.hasUnresolvedVariables, false);
    assert.strictEqual(result.isFallback, false);
  });

  it("flags unresolved variables", () => {
    const tmpl = mockTemplate({
      body: "{{shop_name}} {{unknown_var}}",
    });
    const result = renderTemplate(tmpl, { shop_name: "Shop1" });
    assert.strictEqual(result.hasUnresolvedVariables, true);
    assert.deepStrictEqual(result.unresolvedVariables, ["unknown_var"]);
  });

  it("handles null template", () => {
    const result = renderTemplate(null, {});
    assert.strictEqual(result.body, "");
    assert.strictEqual(result.category, "custom");
    assert.strictEqual(result.templateId, null);
    assert.strictEqual(result.version, 0);
    assert.strictEqual(result.hasUnresolvedVariables, true);
    assert.strictEqual(result.isFallback, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Fallback resolution
// ═══════════════════════════════════════════════════════════════════════

describe("resolveTemplate — managed → fallback chain", () => {
  it("returns managed template when available", () => {
    const tmpl = mockTemplate({ category: "holding", behavior: "holding_ack", body: "Managed holding" });
    const templatesMap = new Map([["holding", tmpl]]);
    const result = resolveTemplate("holding", templatesMap, CATEGORY_FALLBACKS);
    assert.strictEqual(result.body, "Managed holding");
    assert.strictEqual(result.behavior, "holding_ack");
    assert.strictEqual(result.isFallback, false);
    assert.notStrictEqual(result.template, null);
  });

  it("falls back when managed template is inactive", () => {
    const tmpl = mockTemplate({ is_active: false, body: "Inactive" });
    const templatesMap = new Map([["holding", tmpl]]);
    const result = resolveTemplate("holding", templatesMap, CATEGORY_FALLBACKS);
    assert.strictEqual(result.behavior, "holding_ack");
    assert.strictEqual(result.isFallback, true);
    // Should get the TEST_FALLBACK body, not the inactive one
    assert.ok(result.body !== "Inactive");
  });

  it("falls back when no managed template for category", () => {
    const templatesMap = new Map();
    const result = resolveTemplate("greeting_only", templatesMap, CATEGORY_FALLBACKS);
    assert.strictEqual(result.behavior, "informational_ack");
    assert.strictEqual(result.isFallback, true);
    assert.strictEqual(result.template, null);
    assert.ok(result.body.includes("ご連絡ありがとうございます"));
  });

  it("fallback per category — cancel_fee uses cancel_fee behavior, not holding_ack", () => {
    const templatesMap = new Map();
    const result = resolveTemplate("cancel_fee", templatesMap, CATEGORY_FALLBACKS);
    assert.strictEqual(result.behavior, "cancel_fee");
    assert.strictEqual(result.isFallback, true);
    assert.ok(result.body.includes("cancel_fee_link"));
  });

  it("last resort: falls back to holding when category has no fallback", () => {
    // Create a new empty fallback map (no "unknown_category" entry)
    const emptyFallbacks = new Map<string, { body: string; behavior: TemplateBehavior }>();
    emptyFallbacks.set("holding", { body: "Generic holding", behavior: "holding_ack" });
    const templatesMap = new Map();
    const result = resolveTemplate("unknown_category", templatesMap, emptyFallbacks);
    assert.strictEqual(result.behavior, "holding_ack");
    assert.strictEqual(result.body, "Generic holding");
    assert.strictEqual(result.isFallback, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. Integration: Needs Reply matches expected categories
// ═══════════════════════════════════════════════════════════════════════

describe("Needs Reply — category → behavior → bool integration", () => {
  const testCases: Array<{ category: string; wasSent: boolean; wasSkipped: boolean; expected: boolean }> = [
    // informational_ack — always false
    { category: "greeting_only", wasSent: true, wasSkipped: false, expected: false },
    { category: "information_only", wasSent: true, wasSkipped: false, expected: false },
    { category: "form_received_ack", wasSent: true, wasSkipped: false, expected: false },
    // holding_ack — always true
    { category: "holding", wasSent: true, wasSkipped: false, expected: true },
    { category: "followup_form_helper", wasSent: true, wasSkipped: false, expected: true },
    // form_request — false when sent, true when skipped
    { category: "fuguai", wasSent: true, wasSkipped: false, expected: false },
    { category: "fuguai", wasSent: false, wasSkipped: true, expected: true },
    { category: "fuguai_lite", wasSent: true, wasSkipped: false, expected: false },
    { category: "fuguai_lite", wasSent: false, wasSkipped: true, expected: true },
    // cancel_fee — always true
    { category: "cancel_fee", wasSent: true, wasSkipped: false, expected: true },
    // custom — always true
    { category: "custom", wasSent: true, wasSkipped: false, expected: true },
  ];

  for (const tc of testCases) {
    it(`${tc.category} (sent=${tc.wasSent}, skipped=${tc.wasSkipped}) → ${tc.expected}`, () => {
      const behavior = getBehaviorForCategory(tc.category);
      const result = needsReplyFromBehavior(behavior, tc.wasSent, tc.wasSkipped);
      assert.strictEqual(result, tc.expected,
        `Expected ${tc.category} (behavior=${behavior}) → ${tc.expected}, got ${result}`);
    });
  }
});
